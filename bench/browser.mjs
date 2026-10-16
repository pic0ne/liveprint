// Keystroke-to-preview latency in headless Chrome against `vite preview` of dist/ (`npm run bench:browser` builds it).
// node bench/browser.mjs [--keys 60] [--gap 150] [--check <dir>]
// --check also screenshots into <dir> and counts visible pages without a bitmap after every key, which perturbs timing.
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';

const { values: args } = parseArgs({ options: { keys: { type: 'string', default: '60' }, gap: { type: 'string', default: '150' }, check: { type: 'string' } } });
const [KEYS, GAP] = [Number(args.keys), Number(args.gap)];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const freePort = () =>
  new Promise((resolve) => {
    const probe = createServer().listen(0, '127.0.0.1', () => probe.close(resolve.bind(null, probe.address().port)));
  });

const SPOTS = {
  // End of the title: each key lengthens one short line on page 1, so later pages rarely change.
  title: { line: 1, keys: [...'the quick brown fox '] },
  // End of the first paragraph: every sixth key starts a paragraph; once page 1's slack is gone, each reflows every later page.
  reflow: { line: 3, keys: ['Enter', 'Enter', ...'new '] },
};

const webPort = await freePort();
const server = spawn('node_modules/.bin/vite', ['preview', '--host', '127.0.0.1', '--port', String(webPort), '--strictPort'], { stdio: 'ignore' });
const profile = mkdtempSync(join(tmpdir(), 'liveprint-bench-'));
const chrome = spawn('google-chrome', ['--headless=new', '--remote-debugging-port=0', `--user-data-dir=${profile}`, '--no-first-run', '--window-size=1400,900', 'about:blank'], { stdio: 'ignore' });
const chromeExited = once(chrome, 'exit');
process.on('exit', () => [chrome, server].forEach((child) => child.kill()));

async function until(what, attempt) {
  for (let i = 0; i < 300; i++) {
    const result = await attempt().catch(() => null);
    if (result) return result;
    await sleep(100);
  }
  throw new Error(`gave up waiting for ${what}`);
}
const debugPort = await until('Chrome', async () => readFileSync(join(profile, 'DevToolsActivePort'), 'utf8').split('\n')[0]);
const json = (path) => until(path, () => fetch(`http://127.0.0.1:${debugPort}${path}`).then((r) => r.json()));
await until('vite preview', () => fetch(`http://127.0.0.1:${webPort}/`).then((r) => r.ok));

async function connect(url) {
  const ws = new WebSocket(url);
  const waiting = new Map();
  const listeners = new Set();
  let id = 0;
  ws.onmessage = ({ data }) => {
    const m = JSON.parse(data);
    if (waiting.has(m.id)) waiting.get(m.id)(m);
    else for (const listener of listeners) listener(m);
  };
  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      waiting.set(++id, (m) => (m.error ? reject(new Error(`${method}: ${m.error.message}`)) : resolve(m.result)));
      ws.send(JSON.stringify({ id, method, params }));
    });
  await new Promise((r) => (ws.onopen = r));
  return { send, listeners };
}

const browser = await connect((await json('/json/version')).webSocketDebuggerUrl);
const { gpu } = await browser.send('SystemInfo.getInfo');
const status = gpu.featureStatus;
console.log(`chrome gpu: compositing ${status.gpu_compositing}, rasterization ${status.rasterization}, canvas ${status['2d_canvas']} (${gpu.devices[0]?.deviceString || 'no device'})`);
const page = await connect((await json('/json')).find((t) => t.type === 'page').webSocketDebuggerUrl);
const evaluate = async (expression) => (await page.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })).result.value;
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
  await page.send('Page.navigate', { url: `http://127.0.0.1:${webPort}/` });
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
  source: `window.__pages = { messages: 0, bitmaps: 0 };
    window.Worker = class extends Worker {
      constructor(...args) {
        super(...args);
        this.addEventListener('message', ({ data }) => data.kind === 'pages' && (__pages.messages++, (__pages.bitmaps += data.bitmaps.length)));
      }
    };`,
});
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
  console.log(`  worker posted ${after.messages - before.messages} pages messages, ${after.bitmaps - before.bitmaps} page bitmaps`);
  console.log(`  main-thread tasks  >16 ms: ${main.over16}  >50 ms: ${main.over50}  max ${main.max.toFixed(1)} ms`);
  console.log(`  top main-thread phases: ${main.top.map(([n, ms]) => `${n} ${ms.toFixed(0)}`).join(', ')} ms`);
  if (!args.check) continue;
  console.log(`  visible pages without a bitmap, summed over ${KEYS} samples: ${blanks}`);
  await evaluate(`document.getElementById('pages').scrollTop = 1e9`);
  await sleep(1500);
  await shot(`${label}-bottom`);
}
chrome.kill();
await chromeExited;
rmSync(profile, { recursive: true, force: true, maxRetries: 20 });
process.exit(0);
