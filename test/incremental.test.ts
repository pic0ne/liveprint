import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import type { IncrementalServer, TypstCompiler } from '@myriaddreamin/typst.ts/compiler';
import { createTypstRenderer, type TypstRenderer } from '@myriaddreamin/typst.ts/renderer';
import { beforeAll, expect, test } from 'vitest';
import { nodeCompiler, prelude, repoText } from '../bench/typst-node';
import { convert } from '../src/convert/toTypst';
import { MAIN_PATH, mainSource } from '../src/typst/compiler';

let compiler: TypstCompiler;
let renderer: TypstRenderer;
beforeAll(async () => {
  compiler = await nodeCompiler();
  renderer = createTypstRenderer();
  const require = createRequire(import.meta.url);
  await renderer.init({ getModule: () => readFileSync(require.resolve('@myriaddreamin/typst-ts-renderer/wasm')) });
});

const sample = repoText('src/sample.md');

test('vector deltas, merged in order across a failed compile, hold the same pages as a full compile', async () => {
  await compiler.withIncrementalServer(async (server: IncrementalServer) => {
    const step = (markdown: string) => {
      compiler.addSource(MAIN_PATH, mainSource(prelude, convert(markdown).typst));
      return compiler.compile({ mainFilePath: MAIN_PATH, incrementalServer: server, diagnostics: 'unix' });
    };
    await renderer.runWithSession(async (session) => {
      const first = await step(sample);
      renderer.manipulateData({ renderSession: session, action: 'merge', data: first.result! });

      const broken = await step(`${sample}\n\n$\\frac{1$`);
      expect(broken.result).toBeUndefined();
      expect(broken.diagnostics?.[0]).toContain('error: missing argument: den');

      const edited = sample.replace('rewards care', 'rewards patience');
      const delta = await step(edited);
      expect(delta.result!.length).toBeLessThan(first.result!.length / 20);
      renderer.manipulateData({ renderSession: session, action: 'merge', data: delta.result! });
      const patched = await renderer.renderSvg({ renderSession: session });

      const full = await compiler.compile({ mainFilePath: MAIN_PATH, diagnostics: 'unix' });
      const fresh = await renderer.runWithSession(async (s) => {
        renderer.manipulateData({ renderSession: s, action: 'reset', data: full.result! });
        return renderer.renderSvg({ renderSession: s });
      });
      expect(patched).toContain('patience');
      expect(patched).toBe(fresh);
      expect(session.retrievePagesInfo()).toHaveLength(6);
    });
  });
});
