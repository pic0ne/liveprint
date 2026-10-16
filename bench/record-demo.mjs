// Records docs/demo.gif: typing with the live preview and the latency overlay, then two-way linking in both directions.
// Headless Chrome screencast against `vite preview` of dist/ (`npm run record:demo` builds it), encoded with ffmpeg.
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { launch, sleep, until } from './cdp.mjs';

const WIDTH = 1280;
const HEIGHT = 720;
const OUT = 'docs/demo.gif';

const { url, page, evaluate, close } = await launch({ width: WIDTH, height: HEIGHT });
await page.send('Page.enable');
await page.send('Emulation.setDeviceMetricsOverride', { width: WIDTH, height: HEIGHT, deviceScaleFactor: 1, mobile: false });
await page.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'dark' }] });
await page.send('Page.addScriptToEvaluateOnNewDocument', {
  source: `window.Worker = class extends Worker { constructor(...a) { super(...a); window.__worker = this; } };`,
});
await page.send('Page.navigate', { url });
await until('every page drawn', () => evaluate(`(() => { const c = [...document.querySelectorAll('#pages canvas')]; return c.length > 1 && c.every((x) => x.width > 0); })()`), 600);
await sleep(800);
await evaluate(`window.dispatchEvent(new KeyboardEvent('keydown', { altKey: true, code: 'KeyD' }))`);

const view = `document.querySelector('.cm-content').cmTile.view`;
/** Viewport point just after the given text in the editor. */
const editorPoint = (after) =>
  evaluate(`(() => { const v = ${view}; const at = v.state.doc.toString().indexOf(${JSON.stringify(after)}) + ${after.length}; const c = v.coordsAtPos(at); return { x: c.left, y: (c.top + c.bottom) / 2 }; })()`);
/** Viewport point at the middle of a phrase as printed in the preview, from the worker's text runs. */
const previewPoint = (phrase) =>
  evaluate(`new Promise((resolve) => {
    const w = window.__worker;
    const on = ({ data }) => {
      if (data.kind !== 'runs') return;
      w.removeEventListener('message', on);
      for (const [p, { width, height, runs }] of data.pages.entries()) {
        for (const r of runs) {
          const at = r.text.indexOf(${JSON.stringify(phrase)});
          if (at < 0) continue;
          const box = document.querySelectorAll('#pages canvas')[p].getBoundingClientRect();
          const x = r.x + r.w * (at + ${phrase.length} / 2) / r.text.length;
          return resolve({ x: box.left + (x / width) * box.width, y: box.top + ((r.y + r.h / 2) / height) * box.height });
        }
      }
      resolve(null);
    };
    w.addEventListener('message', on);
    w.postMessage({ kind: 'runs', id: 1e9 });
  })`);

const mouse = async (type, { x, y }, extra = {}) =>
  page.send('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1, ...extra });
const click = async (point) => {
  await mouse('mouseMoved', point, { button: 'none' });
  await sleep(250);
  await mouse('mousePressed', point);
  await mouse('mouseReleased', point);
};
const type = async (text, gap = 55) => {
  for (const char of text) {
    await page.send('Input.dispatchKeyEvent', { type: 'keyDown', text: char, key: char, unmodifiedText: char });
    await page.send('Input.dispatchKeyEvent', { type: 'keyUp', key: char });
    await sleep(gap);
  }
};
const key = async (name, code, keyCode, times = 1, gap = 260) => {
  for (let i = 0; i < times; i++) {
    await page.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: name, code, windowsVirtualKeyCode: keyCode });
    await page.send('Input.dispatchKeyEvent', { type: 'keyUp', key: name, code, windowsVirtualKeyCode: keyCode });
    await sleep(gap);
  }
};

const frames = [];
page.listeners.add(({ method, params }) => {
  if (method !== 'Page.screencastFrame') return;
  frames.push({ data: params.data, at: params.metadata.timestamp });
  void page.send('Page.screencastFrameAck', { sessionId: params.sessionId });
});
await page.send('Page.startScreencast', { format: 'png', everyNthFrame: 1, maxWidth: WIDTH, maxHeight: HEIGHT });
await sleep(700);

await click(await editorPoint('it stays visible.'));
await sleep(400);
await type(' Every keystroke reflows these pages, math included: $a^2 + b^2 = c^2$.');
await sleep(1200);

await click(await previewPoint('The measure'));
await sleep(1400);
await key('ArrowDown', 'ArrowDown', 40, 6);
await sleep(900);

await click(await previewPoint('Comfortable leading'));
await sleep(1600);

await page.send('Page.stopScreencast');
await close();

const dir = mkdtempSync(join(tmpdir(), 'liveprint-demo-'));
let list = '';
frames.forEach(({ data, at }, i) => {
  const file = join(dir, `${String(i).padStart(5, '0')}.png`);
  writeFileSync(file, Buffer.from(data, 'base64'));
  const next = frames[i + 1]?.at ?? at + 1.5;
  list += `file '${file}'\nduration ${Math.max(0.01, next - at).toFixed(3)}\n`;
});
list += `file '${join(dir, `${String(frames.length - 1).padStart(5, '0')}.png`)}'\n`;
writeFileSync(join(dir, 'frames.txt'), list);
mkdirSync('docs', { recursive: true });
execFileSync('ffmpeg', [
  '-y', '-loglevel', 'error', '-f', 'concat', '-safe', '0', '-i', join(dir, 'frames.txt'),
  '-vf', 'fps=15,scale=960:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=128:stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=4:diff_mode=rectangle',
  OUT,
]);
rmSync(dir, { recursive: true, force: true });
console.log(`${OUT}: ${frames.length} frames over ${(frames.at(-1).at - frames[0].at).toFixed(1)} s`);
