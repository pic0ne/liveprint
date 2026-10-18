import type { DiagnosticsData } from '@myriaddreamin/typst.ts/compiler';
import { type Converted, convert, type FrontMatter, type MathCall } from '../convert/toTypst';
import type { ImagePath } from '../images';
import { MAIN_PATH, mainSource } from './compiler';

export type Diagnostic = DiagnosticsData['full'];

export interface Compile<R> {
  result?: R;
  diagnostics?: Diagnostic[];
}

export interface CompiledMarkdown<R> extends Compile<R> {
  converted: Converted;
  convertMs: number;
  compileMs: number;
}

/**
 * The formula call a failed compile stopped at, and why. The error points inside mitex; a hint that follows points at
 * the call in our source, which is one line, since the converter escapes newlines in strings. Columns count code points.
 */
export function rejectedFormula(source: string, diagnostics: Diagnostic[]): { call: MathCall; message: string } | null {
  const error = diagnostics.find((d) => d.severity === 'error');
  for (const { path, range } of diagnostics) {
    const at = /^(\d+):(\d+)-(\d+):(\d+)$/.exec(range);
    if (path !== MAIN_PATH || !at || at[1] !== at[3]) continue;
    const line = source.split('\n')[Number(at[1])] ?? '';
    const call = [...line].slice(Number(at[2]), Number(at[4])).join('');
    if (/^mi(tex)?\(".*"\)$/.test(call)) {
      return { call: call as MathCall, message: (error?.message ?? 'not valid').replace(/^plugin errored with: (error: )?/, '') };
    }
  }
  return null;
}

/**
 * Converts and compiles the Markdown, showing every formula mitex rejects as typed. A failed compile names only the
 * first rejected formula, so each one found is added to `rejected` and the compile runs again. That ends, since every
 * retry adds a formula of this Markdown that the next conversion no longer calls. `rejected` keeps a message for each
 * formula and forgets the ones the Markdown no longer has. `prelude` is built for the front matter of each conversion.
 */
export async function compileMarkdown<R>(
  markdown: string,
  prelude: (front: FrontMatter | null) => string,
  available: ReadonlySet<ImagePath>,
  rejected: Map<MathCall, string>,
  compile: (source: string) => Promise<Compile<R>>,
): Promise<CompiledMarkdown<R>> {
  let convertMs = 0;
  let compileMs = 0;
  for (;;) {
    const t0 = performance.now();
    const converted = convert(markdown, available, rejected);
    const source = mainSource(prelude(converted.frontMatter), converted.typst);
    const t1 = performance.now();
    const { result, diagnostics = [] } = await compile(source);
    convertMs += t1 - t0;
    compileMs += performance.now() - t1;
    const found = result ? null : rejectedFormula(source, diagnostics);
    if (found && !rejected.has(found.call)) {
      rejected.set(found.call, found.message);
      continue;
    }
    const kept = new Set(converted.typedMath);
    for (const call of rejected.keys()) if (!kept.has(call)) rejected.delete(call);
    return { converted, result, diagnostics, convertMs, compileMs };
  }
}
