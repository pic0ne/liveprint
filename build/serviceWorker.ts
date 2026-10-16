import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { transformWithOxc, type Plugin } from 'vite';
import { FONT_FILES, type Precache } from '../src/typst/files.ts';

const PLACEHOLDER = '__PRECACHE';

/** Every built file except the worker itself and the fonts that are not needed at start-up, which are cached on first fetch. */
export function precacheFiles(paths: readonly string[]): string[] {
  const boot = new Set<string>(FONT_FILES);
  return paths.filter((path) => path !== 'sw.js' && (!path.startsWith('fonts/') || boot.has(path))).sort();
}

function listFiles(dir: string): string[] {
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => relative(dir, join(entry.parentPath, entry.name)).split(sep).join('/'));
}

function precache(outDir: string): Precache {
  const files = precacheFiles(listFiles(outDir));
  const hash = createHash('sha256');
  for (const file of files) hash.update(file).update('\0').update(readFileSync(join(outDir, file)));
  return { version: hash.digest('hex').slice(0, 12), files };
}

/** Writes `sw.js` into the build's output with the list of what it precaches. */
export function serviceWorker(): Plugin {
  let root = '';
  let outDir = '';
  return {
    name: 'liveprint:service-worker',
    apply: 'build',
    configResolved(config) {
      root = config.root;
      outDir = join(root, config.build.outDir);
    },
    async closeBundle() {
      const source = join(root, 'src/sw.ts');
      const { code } = await transformWithOxc(readFileSync(source, 'utf8'), source);
      // A classic worker script: the type-only import leaves only this marker of a module behind.
      const script = code.replace(/^export \{\};\n?/m, '');
      if (/^(import|export)\b/m.test(script) || !script.includes(PLACEHOLDER)) throw new Error('src/sw.ts must compile to a plain script that reads __PRECACHE');
      writeFileSync(join(outDir, 'sw.js'), script.replaceAll(PLACEHOLDER, JSON.stringify(precache(outDir))));
    },
  };
}
