// Whether V8 compiles the compiler WebAssembly again on each visit, in headless Chrome against `vite preview` of
// dist/. The first visit is cold. Visits 2 and 3 each open a new tab after the last one closed, as a reader coming
// back does, so nothing compiled stays in memory, and each is traced: wasm.Deserialize means V8 used the code it
// stored, wasm.CompileLazy counts functions compiled while the first pages wait.
// node bench/wasm-cache.mjs (after npm run build)
import { launch, sleep, until } from './cdp.mjs';

const { url, browser, page, evaluate, newTab, close } = await launch();
const WATCH = `window.__first = null;
  window.Worker = class extends Worker {
    constructor(...args) {
      super(...args);
      this.addEventListener('message', ({ data }) => {
        if (data.kind === 'pages' && __first === null) {
          __first = 0;
          requestAnimationFrame(() => setTimeout(() => (__first = performance.now())));
        }
      });
    }
  };`;

async function visit(tab, label, trace) {
  await tab.page.send('Page.enable');
  await tab.page.send('Page.addScriptToEvaluateOnNewDocument', { source: WATCH });
  const events = [];
  const collect = ({ method, params }) => method === 'Tracing.dataCollected' && events.push(...params.value);
  if (trace) {
    browser.listeners.add(collect);
    await browser.send('Tracing.start', { traceConfig: { includedCategories: ['v8.wasm', 'disabled-by-default-v8.wasm.detailed'] }, transferMode: 'ReportEvents' });
  }
  await tab.page.send('Page.navigate', { url });
  const first = await until('first page', () => tab.evaluate('__first'), 600);
  await sleep(300);
  let detail = '';
  if (trace) {
    const done = new Promise((resolve) => browser.listeners.add(({ method }) => method === 'Tracing.tracingComplete' && resolve()));
    await browser.send('Tracing.end');
    await done;
    browser.listeners.delete(collect);
    const named = (name) => events.filter((e) => e.name === name);
    const ms = (name) => named(name).reduce((sum, e) => sum + (e.dur ?? 0) / 1000, 0).toFixed(1);
    detail = `  Deserialize ${named('wasm.Deserialize').length}  CompileLazy ${named('wasm.CompileLazy').length} (${ms('wasm.CompileLazy')} ms)  streaming validation ${ms('wasm.ValidateFunctionsStreaming')} ms  Serialize ${named('wasm.SerializeModule').length}`;
  }
  console.log(`${label}: first page ${first.toFixed(0)} ms${detail}`);
}

await page.send('Network.clearBrowserCache');
await visit({ page, evaluate }, 'visit 1', false);
await until('service worker active', () => evaluate(`navigator.serviceWorker.getRegistration().then((r) => r?.active?.state === 'activated')`), 600);
await sleep(1000);
let tab = await newTab();
const { targetInfos } = await browser.send('Target.getTargets');
await browser.send('Target.closeTarget', { targetId: targetInfos.find((t) => t.type === 'page' && t.url.startsWith(url)).targetId });
await sleep(2000);
for (const label of ['visit 2', 'visit 3']) {
  await visit(tab, label, true);
  const next = await newTab();
  await tab.close();
  await sleep(2000);
  tab = next;
}
await close();
