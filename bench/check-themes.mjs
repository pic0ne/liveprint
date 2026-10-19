// A theme whose fonts fail to download, end to end in headless Chrome against `vite preview` of dist/
// (`npm run check:themes` builds it). The Paper theme's fonts are failed through CDP's Fetch domain on the browser,
// which also catches the service worker's own fetches. Runs once with the service worker kept from registering, and
// once with it in control of the page, whose cache must not hold the fonts yet.
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { crc32, deflateSync } from 'node:zlib';
import { launch, sleep, until } from './cdp.mjs';

const J = JSON.stringify;
let failures = 0;
function check(label, ok, detail) {
  if (!ok) failures++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}${!ok && detail !== undefined ? `: ${J(detail)}` : ''}`);
}

const { url, browser, page, evaluate, close, stopServer } = await launch();
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
    window.__preludeFailed = [];
    window.Worker = class extends Worker {
      constructor(...args) {
        super(...args);
        window.__worker = this;
        this.addEventListener('message', ({ data }) => {
          if (data.kind === 'pages') __shown = { rev: data.rev, theme: data.settings.theme, final: data.final };
          if (data.kind === 'themeFailed') (data.reason.kind === 'fonts' ? __fontsFailed : __preludeFailed).push(data);
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

/**
 * A prelude and a logo the reader loads, chosen through the file input the way a reader's picker answers. The logo
 * is a solid crimson square, which no theme prints, so its colour in page 1's pixels shows the header has it.
 */
console.log('\nCustom theme');
const dir = mkdtempSync(join(tmpdir(), 'liveprint-theme-'));
const COMPANY = `// A letterhead
#set text(font: "IBM Plex Sans", size: 10.5pt)
#set page(header: if liveprint.logo != none { image(liveprint.logo, width: 2cm) })
#let title-block(title: none, authors: (), date: none) = if title != none { text(size: 2em, weight: "bold", title) }
`;
writeFileSync(join(dir, 'company.typ'), COMPANY);
writeFileSync(join(dir, 'broken.typ'), '// Broken on line 3\n#set text(size: 11pt)\n#let x = foo\n');
writeFileSync(join(dir, 'logo.png'), solidPng(16, [220, 20, 60]));

function solidPng(size, [r, g, b]) {
  const chunk = (type, data) => {
    const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
    const out = Buffer.alloc(body.length + 8);
    out.writeUInt32BE(data.length, 0);
    body.copy(out, 4);
    out.writeUInt32BE(crc32(body), body.length + 4);
    return out;
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header.set([8, 2], 8);
  const row = Buffer.from([0, ...Array(size).fill([r, g, b]).flat()]);
  const pixels = deflateSync(Buffer.concat(Array(size).fill(row)));
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('IDAT', pixels), chunk('IEND', Buffer.alloc(0))]);
}

/** The files the next file inputs are answered with, in order. */
const picks = [];
let choosers = 0;
await page.send('Page.setInterceptFileChooserDialog', { enabled: true });
page.listeners.add(({ method, params }) => {
  if (method !== 'Page.fileChooserOpened' || !params.backendNodeId) return;
  choosers++;
  const files = picks.shift().map((name) => join(dir, name));
  page.send('DOM.setFileInputFiles', { files, backendNodeId: params.backendNodeId }).catch(() => {});
});

/** A mouse click on the element `expression` finds, as a reader's, which a file input needs. */
async function clickOn(expression) {
  const at = await evaluate(`(() => { const r = (${expression}).getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
  for (const type of ['mousePressed', 'mouseReleased']) await page.send('Input.dispatchMouseEvent', { type, ...at, button: 'left', clickCount: 1 });
}
const panelShown = () => evaluate(`!document.querySelector('.settings-panel').hidden`);
async function inMenu(expression) {
  if (!(await panelShown())) await clickOn(`document.querySelector('#settings > button')`);
  await until('the settings panel open', panelShown);
  await clickOn(expression);
}
const CUSTOM = `document.querySelector('.segments label:has(input[value=custom])')`;
const rowButton = (text) => `[...document.querySelectorAll('.custom-row button')].find((b) => b.textContent === ${J(text)} && b.offsetParent)`;
async function custom() {
  const c = await evaluate(`(async () => {
    const canvas = document.querySelector('#pages canvas');
    const bitmap = await createImageBitmap(canvas);
    const context = new OffscreenCanvas(bitmap.width, bitmap.height).getContext('2d');
    context.drawImage(bitmap, 0, 0);
    const { data } = context.getImageData(0, 0, bitmap.width, bitmap.height);
    let logo = false;
    for (let i = 0; i < data.length && !logo; i += 4) logo = data[i] > 200 && data[i + 1] < 40 && data[i + 2] > 40 && data[i + 2] < 80;
    const row = document.querySelector('.custom-row');
    return {
      logo,
      row: row.hidden ? null : [...row.querySelectorAll('.custom-name')].filter((n) => !n.closest('.custom-row [hidden]')).map((n) => n.textContent),
      notice: document.getElementById('image-notice-text').textContent,
    };
  })()`);
  return { ...(await state()), ...c };
}

await page.send('Page.navigate', { url: 'about:blank' });
await page.send('Storage.clearDataForOrigin', { origin: new URL(url).origin, storageTypes: 'all' });
await load();
await until('service worker active', () => evaluate(`navigator.serviceWorker.ready.then((r) => r.active?.state === 'activated')`), 600);
await load();

// Headless Chrome cancels a file input it is not asked to intercept, as a reader closing the picker does.
await page.send('Page.setInterceptFileChooserDialog', { enabled: false });
await inMenu(CUSTOM);
await sleep(500);
await page.send('Page.setInterceptFileChooserDialog', { enabled: true });
s = await custom();
check('choosing Custom with nothing kept opens the file input, and cancelling it leaves Book chosen', s.checked === 'book' && s.stored !== 'custom' && s.row === null && s.failure === '', s);

picks.push(['broken.typ']);
await inMenu(CUSTOM);
await until('the broken prelude refused', () => evaluate('__preludeFailed.length > 0'));
await sleep(300);
s = await custom();
check('a prelude with an error keeps Book, and the line names the file and the line in it', s.failure === 'Could not use broken.typ: line 3: unknown variable: foo. Choose Custom again to retry.' && s.checked === 'book' && s.stored !== 'custom' && s.shown === 'book' && s.row === null, s);

picks.push(['company.typ']);
const before = choosers;
await inMenu(CUSTOM);
await settledIn('custom');
s = await custom();
check('choosing Custom again asks for a file again, and a good prelude applies', choosers === before + 1 && s.shown === 'custom' && s.checked === 'custom' && s.stored === 'custom' && s.failure === '' && J(s.row) === J(['company.typ']), s);
check('without a logo the header prints none', !s.logo, s);

picks.push(['logo.png']);
await inMenu(rowButton('Logo…'));
await until('the logo in the header', async () => (await custom()).logo);
await settledIn('custom');
s = await custom();
check('a logo chosen shows in the row and prints in page 1’s header', s.logo && J(s.row) === J(['company.typ', 'logo.png']), s);
const kept = await evaluate(`new Promise((resolve) => {
  indexedDB.open('liveprint').onsuccess = ({ target: { result: db } }) => {
    db.transaction('images').objectStore('images').getAllKeys().onsuccess = ({ target }) => {
      db.close();
      resolve(target.result.map(([, path]) => path));
    };
  };
})`);
check('the logo is in no document image, kept record or image notice', !kept.some((path) => path.includes('liveprint')) && !/liveprint|logo/.test(s.notice), { kept, notice: s.notice });

await load('custom');
s = await custom();
check('a reload keeps the custom theme and its logo', s.shown === 'custom' && s.checked === 'custom' && s.logo && J(s.row) === J(['company.typ', 'logo.png']) && s.failure === '', s);

await stopServer();
await load('custom');
s = await custom();
check('offline, with the service worker in control, a reload keeps them too', s.controlled && s.shown === 'custom' && s.logo && s.failure === '', s);

picks.push(['broken.typ']);
await inMenu(rowButton('Replace…'));
await until('the broken replacement refused', () => evaluate('__preludeFailed.length > 0'));
await sleep(300);
s = await custom();
check('a replacement with an error keeps company.typ on screen and says how to retry', s.failure === 'Could not use broken.typ: line 3: unknown variable: foo. Choose Replace… again to retry.' && s.shown === 'custom' && s.checked === 'custom' && s.logo && J(s.row) === J(['company.typ', 'logo.png']), s);

await inMenu(`document.querySelector('.remove-logo')`);
await until('the logo gone', async () => !(await custom()).logo);
await settledIn('custom');
s = await custom();
check('removing the logo takes it off the page and out of the row', !s.logo && J(s.row) === J(['company.typ']) && s.shown === 'custom', s);

await inMenu(rowButton('Remove'));
await settledIn('book');
s = await custom();
check('removing the prelude brings Book back and hides the row', s.shown === 'book' && s.checked === 'book' && s.stored === 'book' && s.row === null, s);
await load();
s = await custom();
check('a reload after removing it starts in Book with no custom theme', s.shown === 'book' && s.row === null && s.failure === '', s);

await close();
console.log(failures ? `\n${failures} failed` : '\nall passed');
process.exit(failures ? 1 : 0);
