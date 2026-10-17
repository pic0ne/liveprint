// Load time in headless Chrome against `vite preview` of dist/ (`npm run bench:load` builds it).
// node bench/load.mjs [--runs 3] [--warm 1] [--throttle <Mbit/s>] [--offline]
// Each run is a cold load, with the HTTP cache and all site data cleared, then --warm reloads. The time is from
// navigation start to the paint after the worker's first pages. --offline then stops the server and reloads once.
import { parseArgs } from 'node:util';
import { launch, sleep, until } from './cdp.mjs';

const { values: args } = parseArgs({
  options: {
    runs: { type: 'string', default: '3' },
    warm: { type: 'string', default: '1' },
    throttle: { type: 'string' },
    offline: { type: 'boolean', default: false },
  },
});

const { url, page, evaluate, stopServer, close } = await launch();
/** Network events and throttling for a target: the page itself, or a worker it starts (no session id for the page). */
function watchNetwork(sessionId) {
  const commands = [page.send('Network.enable', {}, sessionId)];
  const bytesPerSecond = (Number(args.throttle) * 1e6) / 8;
  if (args.throttle) {
    commands.push(page.send('Network.emulateNetworkConditions', { offline: false, latency: 40, downloadThroughput: bytesPerSecond, uploadThroughput: bytesPerSecond }, sessionId));
  }
  return Promise.all(commands);
}

await page.send('Page.enable');
await watchNetwork();
// The compile worker fetches the wasm, fonts and packages, so it and the service worker are held at start until their network is watched too.
await page.send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: true, flatten: true });
page.listeners.add(async ({ method, params }) => {
  if (method !== 'Target.attachedToTarget') return;
  const { sessionId } = params;
  // A paused service worker answers Network.enable only once it runs, so all three go out at once, in this order.
  await Promise.all([watchNetwork(sessionId), page.send('Runtime.runIfWaitingForDebugger', {}, sessionId)]).catch(() => {});
});
await page.send('Page.addScriptToEvaluateOnNewDocument', {
  source: `window.__load = { firstPage: null, bootMs: null };
    window.Worker = class extends Worker {
      constructor(...args) {
        super(...args);
        this.addEventListener('message', ({ data }) => {
          if (data.kind === 'ready') __load.bootMs = data.bootMs;
          if (data.kind === 'pages' && __load.firstPage === null) {
            __load.firstPage = 0;
            requestAnimationFrame(() => setTimeout(() => (__load.firstPage = performance.now())));
          }
        });
      }
    };`,
});

/** Responses of the current load by request id: whether the service worker answered, and the bytes on the wire. */
let responses = new Map();
page.listeners.add(({ method, params }) => {
  if (method === 'Network.responseReceived') {
    responses.set(params.requestId, { url: params.response.url, fromServiceWorker: params.response.fromServiceWorker, bytes: 0 });
  }
  if (method === 'Network.loadingFinished') {
    const response = responses.get(params.requestId);
    if (response) response.bytes = params.encodedDataLength;
  }
});

async function load() {
  responses = new Map();
  await page.send('Page.navigate', { url });
  const firstPage = await until('first page', () => evaluate('__load.firstPage'), 600);
  const bootMs = await evaluate('__load.bootMs');
  const all = [...responses.values()];
  const wire = all.reduce((sum, r) => sum + (r.fromServiceWorker ? 0 : r.bytes), 0);
  return { firstPage, bootMs, wire, requests: all.length, fromServiceWorker: all.filter((r) => r.fromServiceWorker).length };
}

/** Waits for a service worker to finish installing, if the page registers one within a few seconds. */
async function settleWorker() {
  for (let i = 0; i < 30; i++) {
    const state = await evaluate(`navigator.serviceWorker?.getRegistration().then((r) => r?.active?.state ?? r?.installing?.state ?? r?.waiting?.state ?? 'none')`);
    if (state === 'activated') return state;
    if (state === 'none' && i >= 20) return state;
    await sleep(200);
  }
  return 'timeout';
}

const MB = (bytes) => `${(bytes / 1e6).toFixed(2)} MB`;
const row = (label, r) =>
  `  ${label.padEnd(6)} first page ${r.firstPage.toFixed(0).padStart(5)} ms  compiler ready ${r.bootMs.toFixed(0).padStart(5)} ms (worker clock)  wire ${MB(r.wire).padStart(9)}  ${r.requests} requests, ${r.fromServiceWorker} from the service worker`;

console.log(`load, ${args.throttle ? `${args.throttle} Mbit/s, 40 ms latency` : 'loopback, no throttling'}`);
for (let i = 0; i < Number(args.runs); i++) {
  await page.send('Page.navigate', { url: 'about:blank' });
  await page.send('Network.clearBrowserCache');
  await page.send('Storage.clearDataForOrigin', { origin: new URL(url).origin, storageTypes: 'all' });
  const cold = await load();
  const worker = await settleWorker();
  console.log(`run ${i + 1} (service worker: ${worker})`);
  console.log(row('cold', cold));
  for (let w = 1; w <= Number(args.warm); w++) {
    await sleep(500);
    console.log(row(`warm${w}`, await load()));
  }
}
if (args.offline) {
  await settleWorker();
  await stopServer();
  const offline = await load().catch((error) => error);
  console.log(offline instanceof Error ? `  offline: ${offline.message}` : row('offln', offline));
}
await close();
process.exit(0);
