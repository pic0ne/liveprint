// Keystroke-to-preview latency in headless Chrome against `vite preview` of dist/ (`npm run bench:browser` builds it).
// node bench/browser.mjs [--keys 60] [--gap 150] [--theme book] [--check <dir>] [--switch] [--images] [--runs 5]
// Pages are A4 with normal margins in --theme. --check also screenshots into <dir> and counts visible pages without
// a bitmap after every key, which perturbs timing. --switch instead times choosing a theme until its first pages paint.
// --images instead compares typing in the sample with and without three pasted images (a 1200x800 PNG screenshot,
// a 4000x3000 JPEG photo, an SVG chart), --runs times each, alternating, and measures pasting the photo and memory.
// --math instead empties each formula of the sample, keeping its closed `$` delimiters, and types its LaTeX back one key
// at a time, --runs times. It counts the keys whose compile failed and times keystroke to preview per key.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { launch, sleep, until } from './cdp.mjs';

const { values: args } = parseArgs({
  options: {
    keys: { type: 'string', default: '60' },
    gap: { type: 'string', default: '150' },
    theme: { type: 'string', default: 'book' },
    check: { type: 'string' },
    switch: { type: 'boolean', default: false },
    images: { type: 'boolean', default: false },
    math: { type: 'boolean', default: false },
    runs: { type: 'string', default: '5' },
  },
});
// The overlay's meter keeps the newest 100 latencies, so with --images more keys than that leave out the pastes.
const [KEYS, GAP] = [args.images ? Math.max(110, Number(args.keys)) : Number(args.keys), Number(args.gap)];

const SPOTS = {
  // End of the title: each key lengthens one short line on page 1, so later pages rarely change.
  title: { line: 1, keys: [...'the quick brown fox '] },
  // End of the first paragraph: every sixth key starts a paragraph; once page 1's slack is gone, each reflows every later page.
  reflow: { line: 3, keys: ['Enter', 'Enter', ...'new '] },
};

const { url, browser, page, evaluate, close } = await launch();
const { gpu } = await browser.send('SystemInfo.getInfo');
const status = gpu.featureStatus;
console.log(`chrome gpu: compositing ${status.gpu_compositing}, rasterization ${status.rasterization}, canvas ${status['2d_canvas']} (${gpu.devices[0]?.deviceString || 'no device'})`);
const shot = async (name) => {
  if (!args.check) return;
  mkdirSync(args.check, { recursive: true });
  writeFileSync(join(args.check, `${name}.png`), Buffer.from((await page.send('Page.captureScreenshot')).data, 'base64'));
};
const blankVisible = `(() => {
  const pages = document.getElementById('pages');
  const top = pages.scrollTop, bottom = top + pages.clientHeight;
  return [...pages.querySelectorAll('canvas')].filter((c) => !c.hasAttribute('width') && c.parentElement.offsetTop < bottom && c.parentElement.offsetTop + c.offsetHeight > top).length;
})()`;

// Each spot starts from the sample: leaving the typed page passes its beforeunload warning, and the document it
// kept for restoring is cleared once it is gone.
page.listeners.add(({ method }) => {
  if (method === 'Page.javascriptDialogOpening') page.send('Page.handleJavaScriptDialog', { accept: true }).catch(() => {});
});

async function load(spot) {
  await page.send('Page.navigate', { url: 'about:blank' });
  await until('typed page left', () => evaluate(`location.href === 'about:blank'`));
  await page.send('Storage.clearDataForOrigin', { origin: new URL(url).origin, storageTypes: 'indexeddb' });
  await page.send('Page.navigate', { url });
  await until('pages drawn', () => evaluate(`document.querySelectorAll('#pages canvas[width]').length > 1`));
  await sleep(1000);
  await evaluate(`(() => {
    const view = document.querySelector('.cm-content').cmTile.view;
    view.dispatch({ selection: { anchor: view.state.doc.line(${spot.line}).to } });
    view.focus();
    window.dispatchEvent(new KeyboardEvent('keydown', { altKey: true, code: 'KeyD' }));
  })()`);
}

async function type(spot, onKey = async () => {}) {
  for (let i = 0; i < KEYS; i++) {
    const key = spot.keys[i % spot.keys.length];
    const text = key === 'Enter' ? '\r' : key;
    await page.send('Input.dispatchKeyEvent', { type: 'keyDown', key, text, unmodifiedText: text, windowsVirtualKeyCode: key === 'Enter' ? 13 : 0 });
    await page.send('Input.dispatchKeyEvent', { type: 'keyUp', key });
    await onKey(i);
    await sleep(GAP);
  }
  await sleep(1500);
}

async function traced(work) {
  const events = [];
  let listener;
  const done = new Promise((resolve) => {
    listener = (m) => (m.method === 'Tracing.dataCollected' ? events.push(...m.params.value) : m.method === 'Tracing.tracingComplete' && resolve());
    page.listeners.add(listener);
  });
  await page.send('Tracing.start', { categories: 'devtools.timeline,disabled-by-default-devtools.timeline,blink,cc,toplevel,v8', transferMode: 'ReportEvents' });
  await work();
  await page.send('Tracing.end');
  await done;
  page.listeners.delete(listener);
  return events;
}

const PHASES = new Set(['FunctionCall', 'EventDispatch', 'TimerFire', 'UpdateLayoutTree', 'Layout', 'PrePaint', 'Paint', 'Layerize', 'Commit', 'MinorGC', 'MajorGC']);

function mainThread(events) {
  const name = new Map(events.filter((e) => e.name === 'thread_name').map((e) => [`${e.pid}:${e.tid}`, e.args.name]));
  const main = events.filter((e) => e.ph === 'X' && e.dur && name.get(`${e.pid}:${e.tid}`) === 'CrRendererMain');
  const tasks = main.filter((e) => e.name === 'RunTask').map((e) => e.dur / 1000);
  const phases = new Map();
  for (const e of main) if (PHASES.has(e.name)) phases.set(e.name, (phases.get(e.name) ?? 0) + e.dur / 1000);
  const top = [...phases].sort((a, b) => b[1] - a[1]).slice(0, 6);
  return { over16: tasks.filter((d) => d > 16).length, over50: tasks.filter((d) => d > 50).length, max: Math.max(...tasks), top };
}

await page.send('Page.enable');
await page.send('Page.addScriptToEvaluateOnNewDocument', {
  source: `localStorage.setItem('liveprint.page', ${JSON.stringify(JSON.stringify({ paper: 'a4', margins: 'normal', theme: args.theme }))});
    window.__pages = { messages: 0, bitmaps: 0, located: 0 };
    window.__shown = null;
    window.__keys = { at: NaN, edits: [], painted: [], failed: [], broken: [] };
    addEventListener('keydown', (e) => (__keys.at = e.timeStamp), true);
    window.Worker = class extends Worker {
      constructor(...args) {
        super(...args);
        window.__worker = this;
        const post = this.postMessage.bind(this);
        this.postMessage = (message, transfer) => {
          if (message.kind === 'edit') __keys.edits.push({ rev: message.rev, at: __keys.at });
          post(message, transfer);
        };
        this.addEventListener('message', ({ data }) => {
          if (data.kind === 'pages') (__pages.messages++, (__pages.bitmaps += data.bitmaps.length), (__shown = { ...data.settings, final: data.final }));
          if (data.kind === 'pages') (window.__log ??= []).push({ at: performance.now(), rev: data.rev, final: data.final, images: data.images, pages: data.bitmaps.map((b) => b.index), compileMs: data.compileMs, rasterMs: data.rasterMs });
          if (data.kind === 'failed') (window.__failed ??= []).push(data.diagnostics[0]);
          if (data.kind === 'failed') __keys.failed.push(data.rev);
          if (data.kind === 'pages' && data.mathErrors?.length) __keys.broken.push(data.rev);
          if (data.kind === 'pages' && __keys.painted.at(-1)?.rev !== data.rev) {
            const { rev, compileMs } = data;
            requestAnimationFrame(() => setTimeout(() => __keys.painted.push({ rev, compileMs, at: performance.now() })));
          }
          if (data.kind === 'located') __pages.located++;
        });
      }
    };`,
});
if (args.switch) {
  await timeSwitches();
  await close();
  process.exit(0);
}
if (args.math) {
  await timeMath(Number(args.runs));
  await close();
  process.exit(0);
}
if (args.images) {
  await timeImages(Number(args.runs));
  await close();
  process.exit(0);
}

for (const [label, spot] of Object.entries(SPOTS)) {
  await load(spot);
  await shot(`${label}-loaded`);
  const before = await evaluate('({ ...__pages })');
  let blanks = 0;
  const check = async (i) => {
    blanks += await evaluate(blankVisible);
    if (i % 20 === 19) await shot(`${label}-key${i + 1}`);
  };
  const events = await traced(() => type(spot, args.check ? check : undefined));
  const after = await evaluate('__pages');
  const meter = (await evaluate(`document.getElementById('overlay').innerText`)).match(/p50 ([\d.–]+)\s+p95 ([\d.–]+) ms\s+\((\d+)\)/);
  const main = mainThread(events);
  console.log(`\n${label}: ${KEYS} keys at ${GAP} ms`);
  console.log(`  keystroke → preview  p50 ${meter[1]}  p95 ${meter[2]} ms  (${meter[3]} keys painted)`);
  console.log(`  worker posted ${after.messages - before.messages} pages messages, ${after.bitmaps - before.bitmaps} page bitmaps, ${after.located - before.located} cursor spots`);
  console.log(`  main-thread tasks  >16 ms: ${main.over16}  >50 ms: ${main.over50}  max ${main.max.toFixed(1)} ms`);
  console.log(`  top main-thread phases: ${main.top.map(([n, ms]) => `${n} ${ms.toFixed(0)}`).join(', ')} ms`);
  if (!args.check) continue;
  console.log(`  visible pages without a bitmap, summed over ${KEYS} samples: ${blanks}`);
  await evaluate(`document.getElementById('pages').scrollTop = 1e9`);
  await sleep(1500);
  await shot(`${label}-bottom`);
}
await close();
process.exit(0);

/** From a click on a theme to the paint after the worker's first pages in it, which are the visible ones. */
function choose(theme) {
  return evaluate(`new Promise((resolve) => {
    const t0 = performance.now();
    const on = ({ data }) => {
      if (data.kind !== 'pages' || data.settings.theme !== '${theme}') return;
      __worker.removeEventListener('message', on);
      requestAnimationFrame(() => setTimeout(() => resolve({ ms: performance.now() - t0, compileMs: data.compileMs, rasterMs: data.rasterMs })));
    };
    __worker.addEventListener('message', on);
    document.querySelector('input[name=theme][value=${theme}]').click();
  })`);
}

/** Cold is the first choice after a load with an empty HTTP cache; warm chooses it again after going back to the start theme. */
async function timeSwitches(reps = 3) {
  await page.send('Network.enable');
  const settled = (theme) => until(`${theme} drawn`, () => evaluate(`__shown?.final && __shown.theme === '${theme}'`), 600);
  const rows = [];
  for (const theme of ['book', 'paper', 'modern'].filter((t) => t !== args.theme)) {
    const times = { cold: [], warm: [] };
    for (let i = 0; i < reps; i++) {
      await page.send('Network.clearBrowserCache');
      await page.send('Page.navigate', { url });
      await settled(args.theme);
      await sleep(500);
      times.cold.push(await choose(theme));
      await settled(theme);
      await choose(args.theme);
      await settled(args.theme);
      await sleep(300);
      times.warm.push(await choose(theme));
      await settled(theme);
    }
    for (const [label, runs] of Object.entries(times)) {
      const parts = runs.map((r) => `${r.ms.toFixed(0)} (compile ${r.compileMs.toFixed(0)}, raster ${r.rasterMs.toFixed(0)})`);
      rows.push(`  ${args.theme} → ${theme}, ${label}: ${parts.join(', ')} ms`);
    }
  }
  console.log(`\ntheme switch, click to first pages painted (${reps} runs each, fonts over loopback):`);
  for (const row of rows) console.log(row);
}

/** Draws the three test images in the page as Files: `window.__images`. Pixels are made here, nothing is downloaded. */
async function makeImages() {
  return evaluate(`(async () => {
    const shot = new OffscreenCanvas(1200, 800);
    let x = shot.getContext('2d');
    x.fillStyle = '#f4f4f2'; x.fillRect(0, 0, 1200, 800);
    x.fillStyle = '#2b2d33'; x.fillRect(0, 0, 1200, 48);
    x.fillStyle = '#e1e3e8'; x.fillRect(0, 48, 240, 752);
    x.font = '16px sans-serif';
    for (let i = 0; i < 24; i++) {
      x.fillStyle = i % 5 === 0 ? '#3366cc' : '#333';
      x.fillText('Row ' + i + ': the quick brown fox jumps over the lazy dog, 0123456789', 270, 90 + i * 28);
      x.fillStyle = '#555'; x.fillText('Item ' + i, 20, 90 + i * 28);
    }
    const photo = new OffscreenCanvas(4000, 3000);
    x = photo.getContext('2d');
    const sky = x.createLinearGradient(0, 0, 0, 3000);
    sky.addColorStop(0, '#6fa3d8'); sky.addColorStop(0.55, '#d9c9a3'); sky.addColorStop(1, '#4b5a2e');
    x.fillStyle = sky; x.fillRect(0, 0, 4000, 3000);
    let seed = 7;
    const rand = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
    for (let i = 0; i < 400; i++) {
      x.fillStyle = 'hsla(' + Math.floor(rand() * 360) + ', 40%, ' + Math.floor(30 + rand() * 40) + '%, 0.5)';
      x.beginPath(); x.arc(rand() * 4000, 1500 + rand() * 1500, 20 + rand() * 200, 0, 7); x.fill();
    }
    const grain = x.getImageData(0, 0, 4000, 3000);
    for (let i = 0; i < grain.data.length; i += 4) {
      const n = (rand() - 0.5) * 40;
      grain.data[i] += n; grain.data[i + 1] += n; grain.data[i + 2] += n;
    }
    x.putImageData(grain, 0, 0);
    const bars = Array.from({ length: 40 }, (_, i) => '<rect x="' + (40 + i * 14) + '" y="' + (300 - 40 - ((i * 37) % 200)) + '" width="10" height="' + ((i * 37) % 200) + '" fill="#4a7bd0"/>').join('');
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="640" height="320"><rect width="640" height="320" fill="#fff"/>' + bars +
      '<line x1="36" y1="260" x2="620" y2="260" stroke="#333"/><text x="40" y="290" font-family="sans-serif" font-size="14">Bars by week</text></svg>';
    window.__images = {
      'screenshot.png': new File([await shot.convertToBlob({ type: 'image/png' })], 'screenshot.png', { type: 'image/png' }),
      'photo.jpg': new File([await photo.convertToBlob({ type: 'image/jpeg', quality: 0.9 })], 'photo.jpg', { type: 'image/jpeg' }),
      'chart.svg': new File([svg], 'chart.svg', { type: 'image/svg+xml' }),
    };
    return Object.fromEntries(Object.entries(__images).map(([k, f]) => [k, f.size]));
  })()`);
}

/**
 * Pastes `name` through the app's own paste handler, as a new paragraph after the one that starts with its anchor.
 * Resolves on the paint after the first pages that show it. Without images, a paragraph of words goes there instead,
 * so both sides type into a document that compiled the same number of edits.
 */
function pasteImage(name, withImages) {
  const anchor = { 'screenshot.png': 'The classic advice is', 'photo.jpg': 'Strict rhythm is hard', 'chart.svg': 'A *point* in modern' }[name];
  return evaluate(`new Promise((resolve) => {
    const view = document.querySelector('.cm-content').cmTile.view;
    const text = view.state.doc.toString();
    const at = text.indexOf('\\n', text.indexOf(${JSON.stringify(anchor)}));
    if (!${withImages}) {
      view.dispatch({ changes: { from: at, insert: '\\n\\nA paragraph where an image would be.' } });
      resolve(null);
      return;
    }
    view.dispatch({ changes: { from: at, insert: '\\n\\n' }, selection: { anchor: at + 2 } });
    const t0 = performance.now();
    const seen = __log.length;
    const on = ({ data }) => {
      if (data.kind !== 'pages' || !data.images.includes(${JSON.stringify(name)})) return;
      __worker.removeEventListener('message', on);
      requestAnimationFrame(() => setTimeout(() => resolve({ ms: performance.now() - t0, compileMs: data.compileMs, rasterMs: data.rasterMs, pages: data.bitmaps.map((b) => b.index), final: data.final })));
    };
    __worker.addEventListener('message', on);
    const data = new DataTransfer();
    data.items.add(__images[${JSON.stringify(name)}]);
    document.querySelector('.cm-content').dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
  })`);
}

function settledFinal() {
  return until('final pages', () => evaluate(`__shown?.final && document.querySelectorAll('#pages canvas[width]').length > 1`), 600);
}

/** The page a Markdown offset renders on, asked of the worker like the editor's cursor does. */
function pageOf(offset) {
  return evaluate(`new Promise((resolve) => {
    const on = ({ data }) => data.kind === 'located' && data.id === 1e9 && (__worker.removeEventListener('message', on), resolve(data.spot?.page ?? null));
    __worker.addEventListener('message', on);
    __worker.postMessage({ kind: 'locate', id: 1e9, offset: ${offset} });
  })`);
}

/** The preview page that shows the most of the photo's sky blue. */
function photoShownOn() {
  return evaluate(`(() => {
    const counts = [...document.querySelectorAll('#pages canvas')].map((canvas) => {
      if (!canvas.width) return 0;
      const ctx = Object.assign(document.createElement('canvas'), { width: canvas.width, height: canvas.height }).getContext('2d', { willReadFrequently: true });
      ctx.drawImage(canvas, 0, 0);
      const d = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
      let n = 0;
      for (let i = 0; i < d.length; i += 4) if (Math.abs(d[i] - 111) + Math.abs(d[i + 1] - 163) + Math.abs(d[i + 2] - 216) < 60) n++;
      return n;
    });
    return counts.indexOf(Math.max(...counts));
  })()`);
}

/**
 * The worker's V8 heap after a GC, and the largest renderer process's RSS, which holds the page, its worker, both wasm
 * memories and decoded images. The heap's backing stores leave out wasm memory, so the RSS is the number for images.
 */
async function memory() {
  const attached = new Promise((resolve) => {
    const on = (m) => {
      if (m.method !== 'Target.attachedToTarget' || m.params.targetInfo.type !== 'worker') return;
      page.listeners.delete(on);
      resolve(m.params.sessionId);
    };
    page.listeners.add(on);
  });
  await page.send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true });
  const sessionId = await attached;
  const within = (promise) => Promise.race([promise, sleep(5000).then(() => null)]);
  await within(page.send('HeapProfiler.enable', {}, sessionId));
  const collected = (await within(page.send('HeapProfiler.collectGarbage', {}, sessionId))) !== null;
  const heap = await within(page.send('Runtime.getHeapUsage', {}, sessionId));
  await page.send('Target.detachFromTarget', { sessionId });
  await page.send('Target.setAutoAttach', { autoAttach: false, waitForDebuggerOnStart: false, flatten: true });
  const { processInfo } = await browser.send('SystemInfo.getProcessInfo');
  const rss = processInfo
    .filter((p) => p.type === 'renderer')
    .map((p) => {
      try {
        return Number(/VmRSS:\s+(\d+)/.exec(readFileSync(`/proc/${p.id}/status`, 'utf8'))[1]) / 1024;
      } catch {
        return 0;
      }
    });
  const mb = (bytes) => bytes / 1048576;
  return { collected, heapUsed: mb(heap?.usedSize ?? NaN), heapTotal: mb(heap?.totalSize ?? NaN), backing: mb(heap?.backingStorageSize ?? NaN), rendererRss: Math.max(...rss) };
}

async function timeImages(runs) {
  const spots = {
    title: { anchor: '# A field guide', keys: [...'the quick brown fox '] },
    'photo page': { anchor: 'A text face has one job', keys: [...' word'] },
  };
  const rows = [];
  const inserts = [];
  const memories = { without: [], with: [] };
  for (let run = 0; run < runs; run++) {
    for (const withImages of run % 2 === 0 ? [false, true] : [true, false]) {
      for (const [label, spot] of Object.entries(spots)) {
        await load({ line: 1 });
        await settledFinal();
        await evaluate(`__log = []; __failed = []`);
        if (withImages) {
          const sizes = await makeImages();
          if (run === 0 && label === 'title') console.log(`images: ${Object.entries(sizes).map(([n, b]) => `${n} ${(b / 1048576).toFixed(2)} MB`).join(', ')}`);
          if (label === 'title') memories.without.push(await memory());
        }
        for (const name of ['screenshot.png', 'chart.svg', 'photo.jpg']) {
          const pasted = await pasteImage(name, withImages);
          if (name === 'photo.jpg' && pasted) inserts.push(pasted);
          await sleep(300);
          await settledFinal();
        }
        await sleep(1000);
        if (withImages && label === 'title') memories.with.push(await memory());
        const where = await evaluate(`(() => {
          const view = document.querySelector('.cm-content').cmTile.view;
          const text = view.state.doc.toString();
          const at = text.indexOf('\\n', text.indexOf(${JSON.stringify(spot.anchor)}));
          view.dispatch({ selection: { anchor: at } });
          view.focus();
          return { at };
        })()`);
        const photoPage = withImages && label === 'photo page' ? [await pageOf(where.at), await photoShownOn()] : null;
        await sleep(500);
        const typedFrom = await evaluate('__log.length');
        await type(spot);
        const meter = (await evaluate(`document.getElementById('overlay').innerText`)).match(/p50 ([\d.–]+)\s+p95 ([\d.–]+) ms\s+\((\d+)\)/);
        const log = await evaluate(`(() => {
          const typed = __log.slice(${typedFrom});
          const firsts = typed.filter((m, i) => i === 0 || m.rev !== typed[i - 1].rev);
          const median = (xs) => [...xs].sort((a, b) => a - b)[xs.length >> 1] ?? NaN;
          return { failed: __failed.length, images: __log.at(-1)?.images ?? [], compile: median(firsts.map((m) => m.compileMs)), raster: median(firsts.map((m) => m.rasterMs)), redrawn: median(firsts.map((m) => m.pages.length)) };
        })()`);
        const runsOnPage = await evaluate(`new Promise((resolve) => {
          const on = ({ data }) => data.kind === 'runs' && data.id === 2e9 && (__worker.removeEventListener('message', on), resolve(data.pages.map((p) => p.runs.length)));
          __worker.addEventListener('message', on);
          __worker.postMessage({ kind: 'runs', id: 2e9 });
        })`);
        const typedPage = await pageOf(await evaluate(`document.querySelector('.cm-content').cmTile.view.state.selection.main.head`));
        log.runs = runsOnPage[typedPage];
        rows.push({ run, withImages, label, p50: Number(meter[1]), p95: Number(meter[2]), painted: Number(meter[3]), failed: log.failed, images: log.images.length, photoPage });
        console.log(`run ${run + 1} ${withImages ? 'with images   ' : 'without images'} ${label.padEnd(10)} p50 ${meter[1]}  p95 ${meter[2]} ms (${meter[3]} keys painted)  compile ${log.compile.toFixed(1)} raster ${log.raster.toFixed(1)} ms, ${log.redrawn} pages (medians of each rev's first message)  images ${log.images.length}  failed ${log.failed}, ${log.runs} text runs on page ${typedPage + 1}${photoPage ? `  typing on page ${photoPage[0] + 1}, the photo on page ${photoPage[1] + 1}` : ''}`);
      }
    }
  }
  const median = (xs) => [...xs].sort((a, b) => a - b)[xs.length >> 1];
  console.log(`\nmedian of ${runs} runs (range):`);
  for (const label of Object.keys(spots)) {
    for (const withImages of [false, true]) {
      const r = rows.filter((x) => x.label === label && x.withImages === withImages);
      const span = (k) => `${median(r.map((x) => x[k])).toFixed(1)} (${Math.min(...r.map((x) => x[k])).toFixed(1)}–${Math.max(...r.map((x) => x[k])).toFixed(1)})`;
      console.log(`  ${label.padEnd(10)} ${withImages ? 'with images   ' : 'without images'} p50 ${span('p50')}  p95 ${span('p95')} ms`);
    }
  }
  console.log(`\npasting the 4000x3000 photo, paste to the paint after its first pages (${inserts.length} runs):`);
  for (const i of inserts) console.log(`  ${i.ms.toFixed(0)} ms, compile ${i.compileMs.toFixed(0)} ms, raster ${i.rasterMs.toFixed(0)} ms of pages ${i.pages.map((p) => p + 1).join(', ')}${i.final ? '' : ' (more pages drawn after)'}`);
  console.log('\nmemory, MB: worker heap used / total / backing stores after a GC, largest renderer RSS');
  const fmt = (m) => `${m.heapUsed.toFixed(1)} / ${m.heapTotal.toFixed(1)} / ${m.backing.toFixed(1)}${m.collected ? '' : ' (GC did not answer)'}, RSS ${m.rendererRss.toFixed(0)}`;
  memories.without.forEach((m, i) => console.log(`  run ${i + 1}: before the images ${fmt(m)}  after ${fmt(memories.with[i])}`));
}

/**
 * Each key is timed from its keydown to the paint after the first pages of its rev or a newer one. A key is broken when
 * its rev failed to compile or compiled with a formula shown as LaTeX. Before the fix, a failed key waits for the
 * first key that makes its formula valid again.
 */
async function timeMath(runs) {
  const formulas = [...readFileSync(new URL('../src/sample.md', import.meta.url), 'utf8').matchAll(/(\$\$?)([^$]+)\1/g)].map((m) => ({ open: m[1], tex: m[2] }));
  const keys = [];
  for (let run = 0; run < runs; run++) {
    await load({ line: 1 });
    await settledFinal();
    for (const { open, tex } of formulas) {
      await evaluate(`(() => {
        const view = document.querySelector('.cm-content').cmTile.view;
        const whole = ${JSON.stringify(open + tex + open)};
        const from = view.state.doc.toString().indexOf(whole) + ${open.length};
        view.dispatch({ changes: { from, to: from + ${tex.length} }, selection: { anchor: from }, scrollIntoView: true });
        view.focus();
      })()`);
      await sleep(1000);
      const typedFrom = await evaluate('__keys.edits.length');
      for (const key of tex) {
        await page.send('Input.dispatchKeyEvent', { type: 'keyDown', key, text: key, unmodifiedText: key });
        await page.send('Input.dispatchKeyEvent', { type: 'keyUp', key });
        await sleep(GAP);
      }
      await sleep(1000);
      keys.push(
        ...(await evaluate(`__keys.edits.slice(${typedFrom}).map(({ rev, at }) => ({
          rev,
          ms: (__keys.painted.find((p) => p.rev >= rev)?.at ?? NaN) - at,
          compileMs: __keys.painted.find((p) => p.rev === rev)?.compileMs ?? NaN,
          failed: __keys.failed.includes(rev),
          broken: __keys.failed.includes(rev) || __keys.broken.includes(rev),
        }))`)),
      );
    }
    const failed = await evaluate('window.__failed?.length ?? 0');
    console.log(`run ${run + 1}: ${formulas.length} formulas, ${keys.length} keys so far, ${failed} failed compiles this run`);
  }
  const pct = (xs, p) => {
    const sorted = xs.filter(Number.isFinite).sort((a, b) => a - b);
    return sorted.length ? sorted[Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1)].toFixed(1) : '–';
  };
  const row = (label, xs) =>
    console.log(`  ${label.padEnd(28)} ${String(xs.length).padStart(4)} keys  p50 ${pct(xs.map((k) => k.ms), 0.5)}  p95 ${pct(xs.map((k) => k.ms), 0.95)} ms, compile p50 ${pct(xs.map((k) => k.compileMs), 0.5)} ms`);
  console.log(`\ntyping ${formulas.length} formulas of the sample, ${runs} runs, keystroke to preview:`);
  row('keys in a broken formula', keys.filter((k) => k.broken));
  row('keys in a valid formula', keys.filter((k) => !k.broken));
  row('all keys', keys);
  console.log(`  keys whose compile failed: ${keys.filter((k) => k.failed).length} of ${keys.length}`);
}
