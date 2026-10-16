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
  /** `sessionId` addresses a target attached with `flatten: true`, such as a page's worker. */
  const send = (method, params = {}, sessionId) =>
    new Promise((resolve, reject) => {
      waiting.set(++id, (m) => (m.error ? reject(new Error(`${method}: ${m.error.message}`)) : resolve(m.result)));
      ws.send(JSON.stringify({ id, method, params, sessionId }));
    });
  await new Promise((r) => (ws.onopen = r));
  return { send, listeners };
}

/** Starts `vite preview` and Chrome, and connects to Chrome's first tab. `close()` stops both. */
export async function launch({ width = 1400, height = 900 } = {}) {
  const webPort = await freePort();
  const server = spawn('node_modules/.bin/vite', ['preview', '--host', '127.0.0.1', '--port', String(webPort), '--strictPort'], { stdio: 'ignore' });
  const profile = mkdtempSync(join(tmpdir(), 'liveprint-chrome-'));
  const chrome = spawn('google-chrome', ['--headless=new', '--remote-debugging-port=0', `--user-data-dir=${profile}`, '--no-first-run', `--window-size=${width},${height}`, 'about:blank'], { stdio: 'ignore' });
  const chromeExited = once(chrome, 'exit');
  process.on('exit', () => [chrome, server].forEach((child) => child.kill()));

  const debugPort = await until('Chrome', async () => readFileSync(join(profile, 'DevToolsActivePort'), 'utf8').split('\n')[0]);
  const json = (path) => until(path, () => fetch(`http://127.0.0.1:${debugPort}${path}`).then((r) => r.json()));
  await until('vite preview', () => fetch(`http://127.0.0.1:${webPort}/`).then((r) => r.ok));

  const browser = await connect((await json('/json/version')).webSocketDebuggerUrl);
  const page = await connect((await json('/json')).find((t) => t.type === 'page').webSocketDebuggerUrl);
  const evaluate = async (expression) => {
    const { result, exceptionDetails } = await page.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (exceptionDetails) throw new Error(exceptionDetails.exception?.description ?? exceptionDetails.text);
    return result.value;
  };
  return {
    url: `http://127.0.0.1:${webPort}/`,
    browser,
    page,
    evaluate,
    /** Stops `vite preview` and waits until nothing answers, so the page is left with no network for the app. */
    async stopServer() {
      server.kill();
      await until('vite preview stopped', () => fetch(`http://127.0.0.1:${webPort}/`).then(() => false, () => true));
    },
    async close() {
      chrome.kill();
      server.kill();
      await chromeExited;
      // Chrome's helper processes can still be writing to the profile just after it exits.
      await until('profile removed', async () => (rmSync(profile, { recursive: true, force: true }), true), 50);
    },
  };
}
