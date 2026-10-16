import { cpus, loadavg } from 'node:os';
import { CompileFormatEnum, type TypstCompiler } from '@myriaddreamin/typst.ts/compiler';
import { convert } from '../src/convert/toTypst';
import { MAIN_PATH, mainSource } from '../src/typst/compiler';
import { nodeCompiler, prelude, repoText } from './typst-node';

const EDITS = 30;
const sample = repoText('src/sample.md');
const anchors = { start: 'rewards care', end: 'knowingly, one at a time' } as const;
type Where = keyof typeof anchors;

// Typst memoizes across compiles, so a document compiled once compiles again almost for free. Each row
// therefore inserts words no earlier row used, the way every keystroke yields a document never seen before.
let row = 0;
const edited = (where: Where, i: number) => sample.replace(anchors[where], `${anchors[where]} word${row}x${i}`);

interface Row {
  label: string;
  times: number[];
  bytes: number[];
  errors: number;
}

const rows: Row[] = [];

async function measure(label: string, run: (i: number) => Promise<Uint8Array | undefined>): Promise<void> {
  const result: Row = { label, times: [], bytes: [], errors: 0 };
  for (let i = 0; i < EDITS; i++) {
    const t0 = performance.now();
    const output = await run(i);
    result.times.push(performance.now() - t0);
    if (output && output.length > 0) result.bytes.push(output.length);
    else result.errors++;
  }
  rows.push(result);
  row++;
}

async function compileLogged(compiler: TypstCompiler, opts: Parameters<TypstCompiler['compile']>[0]) {
  const { result, diagnostics = [] } = await compiler.compile({ ...opts, diagnostics: 'unix' } as typeof opts);
  const errors = (diagnostics as string[]).filter((d) => /\berror\b/.test(d));
  if (errors.length > 0) console.error(errors[0]);
  return result;
}

const compiler = await nodeCompiler({ 'cmarker:0.1.8': 'bench/packages/cmarker-0.1.8.tar.gz' });

const CMARKER_MAIN = `${prelude}
#import "@preview/cmarker:0.1.8"
#cmarker.render(read("/doc.md"), math: mitex)
`;
const encoder = new TextEncoder();

for (const where of ['start', 'end'] as const) {
  compiler.addSource(MAIN_PATH, CMARKER_MAIN);
  await compiler.withIncrementalServer(async (server) => {
    compiler.mapShadow('/doc.md', encoder.encode(sample));
    await compileLogged(compiler, { mainFilePath: MAIN_PATH, incrementalServer: server });
    await measure(`A cmarker, incremental delta (${where})`, (i) => {
      compiler.mapShadow('/doc.md', encoder.encode(edited(where, i)));
      return compileLogged(compiler, { mainFilePath: MAIN_PATH, incrementalServer: server });
    });
  });
  compiler.unmapShadow('/doc.md');

  await compiler.withIncrementalServer(async (server) => {
    compiler.addSource(MAIN_PATH, mainSource(prelude, convert(sample).typst));
    await compileLogged(compiler, { mainFilePath: MAIN_PATH, incrementalServer: server });
    const bodies = Array.from({ length: EDITS }, (_, i) => convert(edited(where, i)).typst);
    await measure(`B convert, incremental delta (${where})`, (i) => {
      compiler.addSource(MAIN_PATH, mainSource(prelude, bodies[i]!));
      return compileLogged(compiler, { mainFilePath: MAIN_PATH, incrementalServer: server });
    });
  });

  const pdfBodies = Array.from({ length: EDITS }, (_, i) => convert(edited(where, i)).typst);
  await measure(`B convert, PDF (${where})`, (i) => {
    compiler.addSource(MAIN_PATH, mainSource(prelude, pdfBodies[i]!));
    return compileLogged(compiler, { mainFilePath: MAIN_PATH, format: CompileFormatEnum.pdf });
  });

  for (let i = 0; i < 5; i++) convert(edited(where, i)).typst;
  await measure(`convert alone (${where})`, async (i) => encoder.encode(convert(edited(where, i)).typst));
}

const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[xs.length >> 1] ?? NaN;
const f = (n: number) => n.toFixed(1).padStart(7);

console.log(`node ${process.version}, ${cpus()[0]?.model ?? 'unknown cpu'} x${cpus().length}, load ${loadavg().map((l) => l.toFixed(2)).join(' ')}`);
console.log(`src/sample.md: ${sample.length} chars, ${EDITS} one-word edits per row; ms per edit; compile rows exclude conversion, which the last rows time alone\n`);
console.log(`${'pipeline'.padEnd(40)} ${'median'.padStart(7)} ${'min'.padStart(7)} ${'max'.padStart(7)}  ${'output bytes'.padStart(12)}  errors`);
for (const r of rows) {
  console.log(`${r.label.padEnd(40)} ${f(median(r.times))} ${f(Math.min(...r.times))} ${f(Math.max(...r.times))}  ${String(median(r.bytes)).padStart(12)}  ${r.errors}`);
}
if (rows.some((r) => r.errors > 0)) process.exitCode = 1;
