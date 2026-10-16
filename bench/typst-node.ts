import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { createCompiler, FONT_FILES, PACKAGE_FILES } from '../src/typst/compiler';
import { THEMES } from '../src/typst/themes';

const root = new URL('../', import.meta.url);
export const repoFile = (path: string) => new Uint8Array(readFileSync(new URL(path, root)));
export const repoText = (path: string) => readFileSync(new URL(path, root), 'utf8');

/** The same compiler the worker builds, fed from the repo instead of fetch, with every theme's fonts loaded. */
export function nodeCompiler(extraPackages: Record<string, string> = {}) {
  const require = createRequire(import.meta.url);
  const files = { ...PACKAGE_FILES, ...extraPackages };
  const fonts = [...FONT_FILES, ...Object.values(THEMES).flatMap((theme) => theme.fonts)];
  return createCompiler({
    wasm: readFileSync(require.resolve('@myriaddreamin/typst-ts-web-compiler/wasm')),
    fonts: fonts.map((f) => repoFile(`public/${f}`)),
    packages: new Map(Object.entries(files).map(([spec, path]) => [spec, repoFile(path.startsWith('bench/') ? path : `public/${path}`)])),
  });
}
