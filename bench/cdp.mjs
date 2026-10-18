// Headless system Chrome driven over the DevTools protocol, against `vite preview` of dist/. Shared by the browser bench and checks.
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const freePort = () =>
  new Promise((resolve) => {
    const probe = createServer().listen(0, '127.0.0.1', () => probe.close(resolve.bind(null, probe.address().port)));
  });

export async function until(what, attempt, tries = 300) {
  for (let i = 0; i < tries; i++) {
    const result = await attempt().catch(() => null);
    if (result) return result;
    await sleep(100);
  }
  throw new Error(`gave up waiting for ${what}`);
}

/** Stops the script with `message`. A command Chrome never answers would otherwise leave it waiting until killed. */
function stuck(message) {
  console.error(`\n${message}`);
  process.exit(1);
}

/** Longer than any command takes, page scripts included, so going past it means Chrome or the page is stuck. */
const ANSWER_MS = 120_000;

async function connect(url) {
  const ws = new WebSocket(url);
  const waiting = new Map();
  const listeners = new Set();
  let id = 0;
  ws.onmessage = ({ data }) => {
    const m = JSON.parse(data);
    if (m.method === 'Inspector.targetCrashed') stuck('The page crashed.');
    if (waiting.has(m.id)) waiting.get(m.id)(m);
    else for (const listener of listeners) listener(m);
  };
  // Later than Chrome's exit event, which says why it went, when Chrome exited.
  ws.onclose = () => waiting.size > 0 && setTimeout(() => stuck('Chrome closed the DevTools connection with commands unanswered.'), 2000);
  /** `sessionId` addresses a target attached with `flatten: true`, such as a page's worker. */
  const send = (method, params = {}, sessionId) =>
    new Promise((resolve, reject) => {
      const n = ++id;
      const what = params.expression ? `${method} of ${params.expression.trim().slice(0, 200)}` : method;
      const timer = setTimeout(() => stuck(`Chrome did not answer ${what} in ${ANSWER_MS / 1000} s.`), ANSWER_MS);
      waiting.set(n, (m) => {
        clearTimeout(timer);
        waiting.delete(n);
        if (m.error) reject(new Error(`${method}: ${m.error.message}`));
        else resolve(m.result);
      });
      ws.send(JSON.stringify({ id: n, method, params, sessionId }));
    });
  await new Promise((r) => (ws.onopen = r));
  return { send, listeners };
}

/**
 * Starts `vite preview` of dist/ on a free port, at the path in LIVEPRINT_BASE (default `/`), as a host under a subpath
 * would. With LIVEPRINT_URL set, uses the app served there instead, such as the deployed site.
 */
export async function preview() {
  if (process.env.LIVEPRINT_URL) return { url: process.env.LIVEPRINT_URL, server: null };
  const port = await freePort();
  const base = process.env.LIVEPRINT_BASE ?? '/';
  const server = spawn('node_modules/.bin/vite', ['preview', '--host', '127.0.0.1', '--port', String(port), '--strictPort', '--base', base], { stdio: 'ignore' });
  process.on('exit', () => server.kill());
  const url = `http://127.0.0.1:${port}${base}`;
  await until('vite preview', () => fetch(url).then((r) => r.ok));
  return { url, server };
}

/** Starts `vite preview` (unless `serve` is false) and Chrome, and connects to Chrome's first tab. `close()` stops both. */
export async function launch({ width = 1400, height = 900, serve = true } = {}) {
  const web = serve ? await preview() : null;
  const server = web?.server ?? null;
  const profile = mkdtempSync(join(tmpdir(), 'liveprint-chrome-'));
  const chrome = spawn('google-chrome', ['--headless=new', '--remote-debugging-port=0', `--user-data-dir=${profile}`, '--no-first-run', `--window-size=${width},${height}`, 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });
  let chromeLog = '';
  chrome.stderr.on('data', (chunk) => (chromeLog = (chromeLog + chunk).slice(-8000)));
  let closing = false;
  chrome.on('exit', (code, signal) => closing || stuck(`Chrome exited (${signal ?? `code ${code}`}) before the script was done. The end of what it printed:\n${chromeLog}`));
  const chromeExited = once(chrome, 'exit');
  process.on('exit', () => [chrome, server].forEach((child) => child?.kill()));

  const debugPort = await until('Chrome', async () => readFileSync(join(profile, 'DevToolsActivePort'), 'utf8').split('\n')[0]);
  const json = (path) => until(path, () => fetch(`http://127.0.0.1:${debugPort}${path}`).then((r) => r.json()));

  const browser = await connect((await json('/json/version')).webSocketDebuggerUrl);
  const page = await connect((await json('/json')).find((t) => t.type === 'page').webSocketDebuggerUrl);
  await page.send('Inspector.enable');
  const evaluateIn = (target) => async (expression) => {
    const { result, exceptionDetails } = await target.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (exceptionDetails) throw new Error(exceptionDetails.exception?.description ?? exceptionDetails.text);
    return result.value;
  };
  return {
    url: web?.url,
    browser,
    page,
    evaluate: evaluateIn(page),
    /** Opens another tab on about:blank and connects to it. */
    async newTab() {
      const { targetId } = await browser.send('Target.createTarget', { url: 'about:blank' });
      const tab = await connect((await json('/json')).find((t) => t.id === targetId).webSocketDebuggerUrl);
      return { page: tab, evaluate: evaluateIn(tab), close: () => browser.send('Target.closeTarget', { targetId }) };
    },
    /** Stops `vite preview` and waits until nothing answers, so the page is left with no network for the app. */
    async stopServer() {
      server?.kill();
      await until('vite preview stopped', () => fetch(web.url).then(() => false, () => true));
    },
    async close() {
      closing = true;
      chrome.kill();
      server?.kill();
      await chromeExited;
      // Chrome's helper processes can still be writing to the profile just after it exits.
      await until('profile removed', async () => (rmSync(profile, { recursive: true, force: true }), true), 50);
    },
  };
}
