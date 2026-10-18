// A theme whose fonts fail to download, end to end in headless Chrome against `vite preview` of dist/
// (`npm run check:themes` builds it). The Paper theme's fonts are failed through CDP's Fetch domain on the browser,
// which also catches the service worker's own fetches. Runs once with the service worker kept from registering, and
// once with it in control of the page, whose cache must not hold the fonts yet.
import { readFileSync, writeFileSync } from 'node:fs';
import { launch, sleep, until } from './cdp.mjs';

const J = JSON.stringify;
let failures = 0;
function check(label, ok, detail) {
  if (!ok) failures++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}${!ok && detail !== undefined ? `: ${J(detail)}` : ''}`);
}

const { url, browser, page, evaluate, close } = await launch();
await page.send('Page.enable');
page.listeners.add(({ method }) => {
  if (method === 'Page.javascriptDialogOpening') page.send('Page.handleJavaScriptDialog', { accept: true }).catch(() => {});
});

let blocked = false;
let failedFetches = 0;
browser.listeners.add(({ method, params, sessionId }) => {
  if (method !== 'Fetch.requestPaused') return;
  if (blocked) failedFetches++;
  const reply = blocked ? ['Fetch.failRequest', { requestId: params.requestId, errorReason: 'InternetDisconnected' }] : ['Fetch.continueRequest', { requestId: params.requestId }];
  browser.send(...reply, sessionId).catch(() => {});
});
await browser.send('Fetch.enable', { patterns: [{ urlPattern: '*/fonts/NewCM10-*' }] });

await page.send('Page.addScriptToEvaluateOnNewDocument', {
  source: `window.__sent = -1;
    window.__shown = null;
    window.__fontsFailed = [];
    window.Worker = class extends Worker {
      constructor(...args) {
        super(...args);
        window.__worker = this;
        this.addEventListener('message', ({ data }) => {
          if (data.kind === 'pages') __shown = { rev: data.rev, theme: data.settings.theme, final: data.final };
          if (data.kind === 'fontsFailed') __fontsFailed.push(data);
        });
        const post = this.postMessage.bind(this);
        this.postMessage = (message, transfer) => {
          if (message.kind === 'edit') __sent = message.rev;
          post(message, transfer);
        };
      }
    };`,
});
const NO_SW = (await page.send('Page.addScriptToEvaluateOnNewDocument', { source: `ServiceWorkerContainer.prototype.register = () => new Promise(() => {});` })).identifier;

const view = `document.querySelector('.cm-content').cmTile.view`;
const state = () =>
  evaluate(`({
    failure: [...document.querySelectorAll('#overlay .failure')].map((d) => d.textContent).join(' | '),
    pulsing: document.querySelectorAll('.segments label[data-loading]').length,
    checked: document.querySelector('input[name=theme]:checked')?.value,
    button: document.querySelector('#settings > button').textContent,
    stored: JSON.parse(localStorage.getItem('liveprint.page') ?? 'null')?.theme,
    shown: __shown?.theme,
    controlled: navigator.serviceWorker?.controller !== null,
  })`);

/** The final pages of the newest edit, in `theme`. */
const settledIn = (theme) =>
  until(`final pages in ${theme}`, () => evaluate(`__shown?.final === true && __shown.rev === __sent && __shown.theme === ${J(theme)}`), 600);

async function load(theme = 'book') {
  await page.send('Page.navigate', { url });
  await until('app booted', () => evaluate(`document.getElementById('file-name').textContent !== ''`));
  await settledIn(theme);
}

/** Opens the settings menu and clicks a theme, as a reader does. A click on the theme already checked changes nothing. */
async function choose(theme) {
  await evaluate(`(() => {
    const panel = document.querySelector('.settings-panel');
    if (panel.hidden) document.querySelector('#settings > button').click();
    document.querySelector('input[name=theme][value=${theme}]').click();
  })()`);
}

async function type(text) {
  await evaluate(`(() => { const v = ${view}; v.dispatch({ selection: { anchor: v.state.doc.line(1).to } }); v.focus(); })()`);
  const seen = [];
  for (const key of text) {
    await page.send('Input.dispatchKeyEvent', { type: 'keyDown', key, text: key, unmodifiedText: key });
    await page.send('Input.dispatchKeyEvent', { type: 'keyUp', key });
    await sleep(150);
    seen.push(await state());
  }
  return seen;
}

async function run(withServiceWorker) {
  console.log(withServiceWorker ? '\nWith the service worker in control' : 'Without a service worker');
  await page.send('Page.navigate', { url: 'about:blank' });
  await page.send('Storage.clearDataForOrigin', { origin: new URL(url).origin, storageTypes: 'all' });
  if (withServiceWorker) {
    await page.send('Page.removeScriptToEvaluateOnNewDocument', { identifier: NO_SW });
    await load();
    await until('service worker active', () => evaluate(`navigator.serviceWorker.ready.then((r) => r.active?.state === 'activated')`), 600);
  }
  await load();
  check(withServiceWorker ? 'the service worker controls the page' : 'no service worker controls the page', (await state()).controlled === withServiceWorker);

  blocked = true;
  const fetchesBefore = failedFetches;
  await choose('paper');
  await until('the font download failed', () => evaluate('__fontsFailed.length > 0'), 300).catch(() => null);
  await sleep(500);
  let s = await state();
  check('the Paper font requests were failed', failedFetches > fetchesBefore, { failedFetches });
  check('a failed download says so, naming Paper and how to retry', /Paper/.test(s.failure) && /again/.test(s.failure), s);
  check('the menu stops pulsing and shows the theme on screen, Book, as chosen', s.pulsing === 0 && s.checked === 'book' && s.button.endsWith('Book'), s);
  check('the browser keeps Book for the next visit', s.stored === 'book', s);

  const typed = await type('abcdefghij');
  check('the failure stays visible across 10 keystrokes', typed.every((t) => t.failure === s.failure), typed.map((t) => t.failure));
  await settledIn('book').catch(() => null);
  s = await state();
  check('the preview stays in Book and has the newest keystroke', s.shown === 'book' && (await evaluate('__shown.rev === __sent')), s);

  const retried = failedFetches;
  const loading = await evaluate(`(() => {
    document.querySelector('#settings > button').click();
    document.querySelector('input[name=theme][value=paper]').click();
    return { failure: document.querySelector('#overlay .failure')?.textContent ?? '', pulsing: document.querySelectorAll('.segments label[data-loading]').length };
  })()`);
  check('choosing Paper again clears the failure at once, and Paper pulses while it loads', loading.failure === '' && loading.pulsing === 1, loading);
  await until('the retry failed', () => evaluate('__fontsFailed.length > 1'), 300).catch(() => null);
  await sleep(300);
  s = await state();
  check('the retry fetched the fonts again, and its failure shows', failedFetches > retried && /Paper/.test(s.failure) && s.checked === 'book', { s, failedFetches, retried });

  await load();
  s = await state();
  check('a reload after the failure starts cleanly in Book', s.failure === '' && s.pulsing === 0 && s.checked === 'book' && s.shown === 'book', s);

  blocked = false;
  await choose('paper');
  await settledIn('paper');
  await sleep(300);
  s = await state();
  check('unblocked, choosing Paper shows Paper with no trace of the failure', s.shown === 'paper' && s.failure === '' && s.pulsing === 0 && s.checked === 'paper' && s.stored === 'paper', s);

  await choose('book');
  await settledIn('book');
}

await run(false);
await run(true);

/** A stored theme whose fonts fail while the page boots: the first pages fall back to Book and say why. */
console.log('\nA stored theme that fails at start-up');
await page.send('Page.navigate', { url: 'about:blank' });
await page.send('Storage.clearDataForOrigin', { origin: new URL(url).origin, storageTypes: 'all' });
const NO_SW_AGAIN = (await page.send('Page.addScriptToEvaluateOnNewDocument', { source: `ServiceWorkerContainer.prototype.register = () => new Promise(() => {});` })).identifier;
await load();
await evaluate(`localStorage.setItem('liveprint.page', ${J(J({ paper: 'a4', margins: 'normal', theme: 'paper' }))})`);
blocked = true;
await load();
await sleep(500);
let s = await state();
check('the preview starts in Book, says Paper failed, and the menu and storage say Book', s.shown === 'book' && /Paper/.test(s.failure) && s.checked === 'book' && s.stored === 'book', s);
await load();
s = await state();
check('the next visit starts cleanly in Book', s.failure === '' && s.checked === 'book' && s.shown === 'book', s);

/**
 * An update of the app keeps the theme fonts cached before it. The update is a copy of sw.js with another version,
 * which the browser installs on the next navigation, like any new build.
 */
console.log('\nAn update keeps the cached theme fonts');
await page.send('Page.navigate', { url: 'about:blank' });
await page.send('Storage.clearDataForOrigin', { origin: new URL(url).origin, storageTypes: 'all' });
await page.send('Page.removeScriptToEvaluateOnNewDocument', { identifier: NO_SW_AGAIN });
const swPath = new URL('../dist/sw.js', import.meta.url);
const original = readFileSync(swPath, 'utf8');
const version = /"version":"(\w+)"/.exec(original)[1];
blocked = false;
try {
  await load();
  await until('service worker active', () => evaluate(`navigator.serviceWorker.ready.then((r) => r.active?.state === 'activated')`), 600);
  await load();
  await choose('paper');
  await settledIn('paper');
  await choose('book');
  await settledIn('book');
  writeFileSync(swPath, original.replace(`"version":"${version}"`, `"version":"updated0000"`));
  await load();
  await until('the update activated', () => evaluate(`caches.keys().then((keys) => keys.includes('liveprint-updated0000') && !keys.includes('liveprint-${version}'))`), 600);
  blocked = true;
  const before = failedFetches;
  await choose('paper');
  await settledIn('paper').catch(() => null);
  s = await state();
  check('after the update, Paper shows with no font download', s.shown === 'paper' && failedFetches === before && s.failure === '', { s, failed: failedFetches - before });
  blocked = false;
} finally {
  writeFileSync(swPath, original);
}

await close();
console.log(failures ? `\n${failures} failed` : '\nall passed');
process.exit(failures ? 1 : 0);
