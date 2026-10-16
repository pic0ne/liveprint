import { expect, test } from 'vitest';
import { precacheFiles } from '../build/serviceWorker';

test('precaches every built file but the service worker and the fonts not needed at start-up', () => {
  const built = [
    'sw.js',
    'index.html',
    'manifest.webmanifest',
    'assets/index-abc.js',
    'assets/typst_ts_web_compiler_bg-def.wasm',
    'fonts/LibertinusSerif-Regular.otf',
    'fonts/NewCM10-Regular.otf',
    'fonts/IBMPlex-LICENSE.txt',
    'fonts/NewCMMath-Regular.otf',
    'packages/mitex-0.2.6.tar.gz',
  ];
  expect(precacheFiles(built)).toEqual([
    'assets/index-abc.js',
    'assets/typst_ts_web_compiler_bg-def.wasm',
    'fonts/LibertinusSerif-Regular.otf',
    'fonts/NewCMMath-Regular.otf',
    'index.html',
    'manifest.webmanifest',
    'packages/mitex-0.2.6.tar.gz',
  ]);
});
