import { createTypstCompiler, type TypstCompiler } from '@myriaddreamin/typst.ts/compiler';
import { MemoryAccessModel } from '@myriaddreamin/typst.ts/fs/memory';
import { loadFonts, withAccessModel, withPackageRegistry } from '@myriaddreamin/typst.ts/options.init';
import type { WebAssemblyModuleRef } from '@myriaddreamin/typst.ts/wasm';

export const MAIN_PATH = '/main.typ';

export interface CompilerAssets {
  wasm: WebAssemblyModuleRef;
  fonts: Uint8Array[];
  /** Tarballs keyed `name:version`, fetched up front because package resolution is synchronous. */
  packages: ReadonlyMap<string, Uint8Array>;
}

export async function createCompiler(assets: CompilerAssets): Promise<TypstCompiler> {
  const fs = new MemoryAccessModel();
  const compiler = createTypstCompiler();
  await compiler.init({
    getModule: () => assets.wasm,
    beforeBuild: [
      loadFonts(assets.fonts, { assets: false }),
      withAccessModel(fs),
      withPackageRegistry({
        resolve(spec, ctx) {
          const tarball = assets.packages.get(`${spec.name}:${spec.version}`);
          if (spec.namespace !== 'preview' || !tarball) return undefined;
          const dir = `/@memory/packages/${spec.name}/${spec.version}`;
          ctx.untar(tarball, (path, data, mtime) => fs.insertFile(`${dir}/${path}`, data, new Date(mtime)));
          return dir;
        },
      }),
    ],
  });
  return compiler;
}

export function mainSource(prelude: string, body: string): string {
  return `${prelude}\n${body}`;
}
