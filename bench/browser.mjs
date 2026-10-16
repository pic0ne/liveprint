// Keystroke-to-preview latency in headless Chrome against `vite preview` of dist/ (`npm run bench:browser` builds it).
// node bench/browser.mjs [--keys 60] [--gap 150] [--theme book] [--check <dir>] [--switch]
// Pages are A4 with normal margins in --theme. --check also screenshots into <dir> and counts visible pages without
// a bitmap after every key, which perturbs timing. --switch instead times choosing a theme until its first pages paint.
import { mkdirSync, writeFileSync } from 'node:fs';
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
  },
});
const [KEYS, GAP] = [Number(args.keys), Number(args.gap)];

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
  return [...pages.querySelectorAll('canvas')].filter((c) => !c.hasAttribute('width') && c.offsetTop < bottom && c.offsetTop + c.offsetHeight > top).length;
})()`;

async function load(spot) {
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
  const done = new Promise((resolve) =>
    page.listeners.add((m) => (m.method === 'Tracing.dataCollected' ? events.push(...m.params.value) : m.method === 'Tracing.tracingComplete' && resolve())),
  );
  await page.send('Tracing.start', { categories: 'devtools.timeline,disabled-by-default-devtools.timeline,blink,cc,toplevel,v8', transferMode: 'ReportEvents' });
  await work();
  await page.send('Tracing.end');
  await done;
  page.listeners.clear();
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
    window.Worker = class extends Worker {
      constructor(...args) {
        super(...args);
        window.__worker = this;
        this.addEventListener('message', ({ data }) => {
          if (data.kind === 'pages') (__pages.messages++, (__pages.bitmaps += data.bitmaps.length), (__shown = { ...data.settings, final: data.final }));
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
