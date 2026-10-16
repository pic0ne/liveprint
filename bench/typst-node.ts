import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { createCompiler, FONT_FILES, PACKAGE_FILES } from '../src/typst/compiler';

const root = new URL('../', import.meta.url);
export const repoFile = (path: string) => new Uint8Array(readFileSync(new URL(path, root)));
export const repoText = (path: string) => readFileSync(new URL(path, root), 'utf8');

export const prelude = repoText('src/typst/prelude.typ');

/** The same compiler the worker builds, fed from the repo instead of fetch. */
export function nodeCompiler(extraPackages: Record<string, string> = {}) {
  const require = createRequire(import.meta.url);
  const files = { ...PACKAGE_FILES, ...extraPackages };
  return createCompiler({
    wasm: readFileSync(require.resolve('@myriaddreamin/typst-ts-web-compiler/wasm')),
    fonts: FONT_FILES.map((f) => repoFile(`public/${f}`)),
    packages: new Map(Object.entries(files).map(([spec, path]) => [spec, repoFile(path.startsWith('bench/') ? path : `public/${path}`)])),
  });
}
