// Images, end to end in headless Chrome against `vite preview` of dist/ (`npm run check:images` builds it): pasting
// and dropping them, the first bitmap that shows them, restoring, saving beside the file, finding them in its folder,
// and linking images and around them. Test images are drawn in the page with canvas, one solid colour each, so a page bitmap
// shows an image where that colour is. As in check-files.mjs, CDP cannot answer the File System Access pickers, so
// the API run replaces showOpenFilePicker, showSaveFilePicker and showDirectoryPicker with handles from the origin
// private file system; reading, writing and the read-back are real. The fallback run deletes the pickers.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { launch, sleep, until } from './cdp.mjs';

const { values: args } = parseArgs({ options: { shots: { type: 'string' } } });

const J = JSON.stringify;
const dir = mkdtempSync(join(tmpdir(), 'liveprint-images-'));

let failures = 0;
function check(label, ok, detail) {
  if (!ok) failures++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}${!ok && detail !== undefined ? `: ${J(detail)}` : ''}`);
}

const { url, browser, page, evaluate, close, stopServer } = await launch();
await page.send('Page.enable');
await page.send('DOM.enable');
page.listeners.add(({ method }) => {
  if (method === 'Page.javascriptDialogOpening') page.send('Page.handleJavaScriptDialog', { accept: true });
});

// Colours in bitmaps compare within a tolerance: JPEG and scaling move them a little.
const COLOURS = { magenta: [255, 0, 255], cyan: [0, 200, 255], orange: [255, 140, 0], green: [0, 170, 60], violet: [120, 60, 220] };

/**
 * Records each edit sent to the worker, and for every pages message which pages it redrew and, per colour, how many
 * pixels of each bitmap have it and their bounding box, measured before the preview takes the bitmap.
 */
const WATCH_WORKER = `
  localStorage.setItem('liveprint.page', ${J(J({ paper: 'a4', margins: 'normal', theme: 'book' }))});
  window.__sent = -1;
  window.__frames = [];
  window.__located = 0;
  window.__colours = ${J(COLOURS)};
  window.Worker = class extends Worker {
    constructor(...args) {
      super(...args);
      window.__worker = this;
      this.addEventListener('message', ({ data }) => {
        if (data.kind === 'located') __located++;
        if (data.kind !== 'pages') return;
        const pages = data.bitmaps.map(({ index, bitmap }) => {
          const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
          const ctx = canvas.getContext('2d', { willReadFrequently: true });
          ctx.drawImage(bitmap, 0, 0);
          const pixels = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
          const found = {};
          for (const [name, [r, g, b]] of Object.entries(__colours)) {
            let count = 0, left = Infinity, top = Infinity, right = -1, bottom = -1;
            for (let i = 0; i < pixels.length; i += 4) {
              if (Math.abs(pixels[i] - r) + Math.abs(pixels[i + 1] - g) + Math.abs(pixels[i + 2] - b) > 60) continue;
              const x = (i / 4) % canvas.width, y = Math.floor(i / 4 / canvas.width);
              count++;
              left = Math.min(left, x); right = Math.max(right, x); top = Math.min(top, y); bottom = Math.max(bottom, y);
            }
            if (count) found[name] = { count, box: [left, top, right + 1, bottom + 1] };
          }
          return { index, width: bitmap.width, height: bitmap.height, found };
        });
        __frames.push({ rev: data.rev, final: data.final, images: data.images, pages });
      });
      const post = this.postMessage.bind(this);
      this.postMessage = (message, transfer) => {
        if (message.kind === 'edit') __sent = message.rev;
        post(message, transfer);
      };
    }
  };`;
await page.send('Page.addScriptToEvaluateOnNewDocument', { source: WATCH_WORKER });

/** Pickers answered from folders of the origin private file system: `__picker.folder` is the user's chosen one. */
const STUB_PICKERS = `
  window.__picker = { open: null, folder: 'notes', saveIn: 'notes', save: null, opened: 0, saved: 0, folders: 0 };
  const opfsFolder = async (name) => (await navigator.storage.getDirectory()).getDirectoryHandle(name, { create: true });
  window.showOpenFilePicker = async () => (__picker.opened++, [await (await opfsFolder(__picker.saveIn)).getFileHandle(__picker.open)]);
  window.showSaveFilePicker = async () => (__picker.saved++, (await opfsFolder(__picker.saveIn)).getFileHandle(__picker.save, { create: true }));
  window.showDirectoryPicker = async () => (__picker.folders++, opfsFolder(__picker.folder));`;
const stub = await page.send('Page.addScriptToEvaluateOnNewDocument', { source: STUB_PICKERS });
const NO_PICKERS = ['showOpenFilePicker', 'showSaveFilePicker', 'showDirectoryPicker'].map((name) => `delete window.${name}; delete Window.prototype.${name};`).join(' ');

const view = `document.querySelector('.cm-content').cmTile.view`;
const state = () =>
  evaluate(`({
    text: ${view}.state.doc.toString(),
    head: ${view}.state.selection.main.head,
    name: document.getElementById('file-name').textContent,
    edited: !document.getElementById('file-edited').hidden,
    notice: document.getElementById('image-notice')?.hidden === false ? document.getElementById('image-notice-text').textContent : '',
    failure: [...document.querySelectorAll('#overlay .failure')].map((d) => d.textContent).join(' | '),
  })`);

/** The final frame of the newest edit, once the preview has it. */
const settled = () =>
  until('final pages of the newest edit', () => evaluate(`__frames.findLast((f) => f.rev === __sent && f.final) !== undefined`), 600);

async function load(how = () => page.send('Page.navigate', { url })) {
  await how();
  await until('app booted', () => evaluate(`document.getElementById('file-name').textContent !== ''`));
  await settled();
}

const setText = (text) =>
  evaluate(`(() => { const v = ${view}; v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: ${J(text)} }, selection: { anchor: ${text.length} } }); v.focus(); })()`);

/** Draws a solid image of `colour` in the page and keeps it as `window.__images[name]`, a File. */
const makeImage = (name, colour, width, height, type = 'image/png') =>
  evaluate(`(async () => {
    window.__images ??= {};
    const [r, g, b] = __colours[${J(colour)}];
    let blob;
    if (${J(type)} === 'image/svg+xml') {
      blob = new Blob([\`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><rect width="${width}" height="${height}" fill="rgb(\${r},\${g},\${b})"/></svg>\`], { type: 'image/svg+xml' });
    } else {
      const canvas = new OffscreenCanvas(${width}, ${height});
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = \`rgb(\${r},\${g},\${b})\`;
      ctx.fillRect(0, 0, ${width}, ${height});
      blob = await canvas.convertToBlob({ type: ${J(type === 'image/bmp' ? 'image/png' : type)}, quality: 0.9 });
    }
    __images[${J(name)}] = new File([blob], ${J(name)}, { type: ${J(type)} });
    return __images[${J(name)}].size;
  })()`);
/** The bytes of a page-made image, base64, for files on disk. */
const imageBytes = async (name) =>
  Buffer.from(await evaluate(`(async () => { const b = new Uint8Array(await __images[${J(name)}].arrayBuffer()); let s = ''; for (const x of b) s += String.fromCharCode(x); return btoa(s); })()`), 'base64');

const opfsWrite = (folder, name, data) =>
  evaluate(`(async () => {
    let dir = await navigator.storage.getDirectory();
    for (const part of ${J(folder)}.split('/')) dir = await dir.getDirectoryHandle(part, { create: true });
    const w = await (await dir.getFileHandle(${J(name)}, { create: true })).createWritable();
    await w.write(${data.startsWith('__images') ? data : J(data)});
    await w.close();
  })()`);
/** A file of an OPFS folder, as text, or as base64 with `binary`; null when it is not there. */
const opfsRead = (folder, name, binary = false) =>
  evaluate(`(async () => {
    try {
      const dir = await (await navigator.storage.getDirectory()).getDirectoryHandle(${J(folder)});
      const file = await (await dir.getFileHandle(${J(name)})).getFile();
      if (!${binary}) return await file.text();
      let s = '';
      for (const x of new Uint8Array(await file.arrayBuffer())) s += String.fromCharCode(x);
      return btoa(s);
    } catch { return null; }
  })()`);

async function key(k, { ctrl = false, shift = false } = {}) {
  const modifiers = (ctrl ? 2 : 0) | (shift ? 8 : 0);
  const event = { modifiers, key: shift ? k.toUpperCase() : k, code: `Key${k.toUpperCase()}`, windowsVirtualKeyCode: k.toUpperCase().charCodeAt(0) };
  await page.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...event });
  await page.send('Input.dispatchKeyEvent', { type: 'keyUp', ...event });
}

async function type(text) {
  for (const ch of text) {
    const [key, typed] = ch === '\n' ? ['Enter', '\r'] : [ch, ch];
    await page.send('Input.dispatchKeyEvent', { type: 'keyDown', key, text: typed, unmodifiedText: typed, windowsVirtualKeyCode: ch === '\n' ? 13 : 0 });
    await page.send('Input.dispatchKeyEvent', { type: 'keyUp', key });
  }
}

async function clickAt({ x, y }) {
  for (const type of ['mousePressed', 'mouseReleased']) await page.send('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1 });
}
const centreOf = (selector) => evaluate(`(() => { const r = document.querySelector(${J(selector)}).getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);

const paste = (...names) =>
  evaluate(`(() => {
    const data = new DataTransfer();
    for (const name of ${J(names)}) data.items.add(__images[name]);
    document.querySelector('.cm-content').dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
  })()`);

async function drop(paths, at) {
  const data = { items: [], files: paths, dragOperationsMask: 1 };
  for (const type of ['dragEnter', 'dragOver', 'drop']) await page.send('Input.dispatchDragEvent', { type, ...at, data });
}

/** Frames before this are older than the action a check is about. A reload starts the count again. */
const markFrames = () => evaluate(`window.__since = __frames.length`);
/** The first frame of the newest edit since the mark that redrew page `index`, and whether it was final. */
const firstFrame = (index = 0) =>
  evaluate(`(() => {
    const f = __frames.find((f, i) => i >= (window.__since ?? 0) && f.rev === __sent && f.pages.some((p) => p.index === ${index}));
    return f && { final: f.final, images: f.images, page: f.pages.find((p) => p.index === ${index}) };
  })()`);

/** A box in bitmap pixels as fractions of the page, rounded. */
const fractions = ({ width, height }, [l, t, r, b]) => [l / width, t / height, r / width, b / height].map((v) => Math.round(v * 1000) / 1000);
const A4_PT = 595.28;
/** Whether a block image `widthPt` wide is centred on the page, at its natural width. */
function centredAt(page, colour, widthPt) {
  const hit = page?.found[colour];
  if (!hit) return false;
  const [l, , r] = fractions(page, hit.box);
  return Math.abs((l + r) / 2 - 0.5) < 0.01 && Math.abs(r - l - widthPt / A4_PT) < 0.01;
}

console.log('Pasting and dropping');
await load();
await page.send('Storage.clearDataForOrigin', { origin: new URL(url).origin, storageTypes: 'indexeddb' });
await load(() => page.send('Page.reload'));
await setText('# Images\n\nBefore the image.\n\n');
await settled();
await makeImage('image.png', 'magenta', 200, 100);
await markFrames();
await paste('image.png');
await until('pasted', async () => (await state()).text.includes('!['));
let s = await state();
check('a pasted PNG is inserted at the cursor as ![](image.png)', s.text === '# Images\n\nBefore the image.\n\n![](image.png)' && s.head === s.text.length, s);
await settled();
let first = await firstFrame();
check(
  'the first bitmap of page 1 after the paste already shows it, centred at its natural width',
  centredAt(first?.page, 'magenta', 200) && J(first.images) === '["image.png"]',
  first && { final: first.final, images: first.images, box: first.page.found.magenta && fractions(first.page, first.page.found.magenta.box) },
);
console.log(`     that bitmap was the edit's ${first?.final ? 'final' : 'first, not final,'} pages message`);

await setText(`${s.text}\n\n`);
await paste('image.png');
await until('pasted again', async () => (await state()).text.split('![').length === 3);
s = await state();
check('pasting the same bytes again reuses image.png', s.text.endsWith('![](image.png)\n\n![](image.png)'), s.text);
await makeImage('image.png', 'cyan', 200, 100);
await setText(`${s.text}\n\n`);
await markFrames();
await paste('image.png');
await until('pasted other bytes', async () => (await state()).text.split('![').length === 4);
s = await state();
check('other bytes under the same name become image-2.png', s.text.endsWith('![](image-2.png)'), s.text);
await settled();
first = await firstFrame();
check('and show in their own colour', first?.page.found.cyan?.count > 0 && first.page.found.magenta?.count > 0, first?.page.found);

const pdf = await evaluate(`new Promise((resolve) => {
  const on = ({ data }) => {
    if (data.kind !== 'pdf') return;
    __worker.removeEventListener('message', on);
    resolve(new TextDecoder('latin1').decode(data.bytes));
  };
  __worker.addEventListener('message', on);
  __worker.postMessage({ kind: 'pdf', rev: __sent });
})`);
const pictures = [...pdf.matchAll(/\/Subtype\s*\/Image[^]*?\/Width\s+(\d+)[^]*?\/Height\s+(\d+)|\/Width\s+(\d+)[^]*?\/Height\s+(\d+)[^]*?\/Subtype\s*\/Image/g)].map((m) => `${m[1] ?? m[3]}x${m[2] ?? m[4]}`);
// Each canvas-made PNG has an alpha channel, which the PDF keeps as a soft mask image of the same size.
check('the PDF holds the pasted images at their pixel size', pictures.length >= 2 && pictures.every((size) => size === '200x100'), pictures);

await setText('# Vector\n\n');
await makeImage('plot.svg', 'violet', 300, 150, 'image/svg+xml');
await markFrames();
await paste('plot.svg');
await until('svg pasted', async () => (await state()).text.includes('plot.svg'));
await settled();
first = await firstFrame();
check('a pasted SVG shows in the first bitmap after it, at its natural width (300 px is 225 pt)', centredAt(first?.page, 'violet', 225), first?.page.found);

await setText('# Dropped\n\nOne two three.\n');
await settled();
await makeImage('dropped.png', 'orange', 120, 60);
writeFileSync(join(dir, 'dropped.png'), await imageBytes('dropped.png'));
const target = '# Dropped\n\nOne two'.length;
const at = await evaluate(`(() => { const r = ${view}.coordsAtPos(${target}); return { x: r.left + 1, y: (r.top + r.bottom) / 2 }; })()`);
await markFrames();
await drop([join(dir, 'dropped.png')], at);
await until('dropped', async () => (await state()).text.includes('dropped.png'));
s = await state();
check('an image dropped on the editor is inserted where it lands', s.text === '# Dropped\n\nOne two![](dropped.png) three.\n', s.text);
await settled();
first = await firstFrame();
check('and shows inline in the first bitmap after the drop', first?.page.found.orange?.count > 0, first?.page.found);

await makeImage('scan.bmp', 'green', 10, 10, 'image/bmp');
const before = (await state()).text;
await paste('scan.bmp');
await until('refusal shown', async () => (await state()).failure !== '');
s = await state();
check('a BMP is refused in the failure line, naming it and the types that work, and the text is unchanged', s.text === before && s.failure === 'Could not insert scan.bmp: liveprint shows PNG, JPEG, GIF, WebP and SVG images', s);

console.log('\nRestoring');
await setText('# Kept\n\n![](image.png)\n');
await sleep(500);
await page.send('Network.enable');
const requested = [];
const onRequest = ({ method, params }) => method === 'Network.requestWillBeSent' && requested.push(params.request.url);
page.listeners.add(onRequest);
await load(() => page.send('Page.reload'));
page.listeners.delete(onRequest);
s = await state();
first = await firstFrame();
check('a reload restores the text and the image, shown in the first bitmap', s.text === '# Kept\n\n![](image.png)\n' && centredAt(first?.page, 'magenta', 200), { s, found: first?.page.found });
check('with no request for it', requested.length > 0 && !requested.some((u) => u.includes('image')), requested.filter((u) => u.includes('image')));

await page.send('Page.navigate', { url: `${url}manifest.webmanifest` });
await until('a page of the origin without the app', () => evaluate(`location.pathname === '/manifest.webmanifest'`));
await page.send('Storage.clearDataForOrigin', { origin: new URL(url).origin, storageTypes: 'indexeddb' });
await evaluate(`new Promise((resolve, reject) => {
  const request = indexedDB.open('liveprint', 1);
  request.onupgradeneeded = () => request.result.createObjectStore('doc');
  request.onsuccess = () => {
    const t = request.result.transaction('doc', 'readwrite');
    t.objectStore('doc').put(${J({ text: '# Before images\n', file: { name: 'old.md', handle: null, saved: '# Before images\n' } })}, 'last');
    t.oncomplete = () => (request.result.close(), resolve());
    t.onerror = () => reject(t.error);
  };
})`);
await load();
s = await state();
check('a version 1 record, from before images, restores', s.text === '# Before images\n' && s.name === 'old.md' && !s.edited && s.failure === '', s);

await makeImage('image.png', 'magenta', 200, 100);
const keptPng = (await imageBytes('image.png')).toString('base64');
await page.send('Page.navigate', { url: `${url}manifest.webmanifest` });
await until('a page of the origin without the app', () => evaluate(`location.pathname === '/manifest.webmanifest'`));
await page.send('Storage.clearDataForOrigin', { origin: new URL(url).origin, storageTypes: 'indexeddb' });
await evaluate(`new Promise((resolve, reject) => {
  const request = indexedDB.open('liveprint', 2);
  request.onupgradeneeded = () => (request.result.createObjectStore('doc'), request.result.createObjectStore('images'));
  request.onsuccess = () => {
    const t = request.result.transaction(['doc', 'images'], 'readwrite');
    const text = '# One document\\n\\n![](image.png)\\n';
    t.objectStore('doc').put({ text, file: { name: 'v2.md', handle: null, saved: text, folder: null, savedImages: new Set(['image.png']) } }, 'last');
    t.objectStore('images').put(new Blob([Uint8Array.from(atob(${J(keptPng)}), (c) => c.charCodeAt(0))], { type: 'image/png' }), 'image.png');
    t.oncomplete = () => (request.result.close(), resolve());
    t.onerror = () => reject(t.error);
  };
})`);
await markFrames();
await load();
s = await state();
first = await firstFrame();
check('a version 2 record, with one document and its images, restores both', s.text === '# One document\n\n![](image.png)\n' && s.name === 'v2.md' && !s.edited && centredAt(first?.page, 'magenta', 200), { s, found: first?.page.found });

console.log('\nSaving beside the file, with the File System Access API');
await opfsWrite('notes', 'notes.md', '# Notes\n\n');
await evaluate(`__picker.open = 'notes.md'`);
await key('o', { ctrl: true });
await until('notes.md open', async () => (await state()).name === 'notes.md');
await settled();
await evaluate(`${view}.dispatch({ selection: { anchor: ${view}.state.doc.length } })`);
await makeImage('image.png', 'magenta', 200, 100);
const pastedBytes = (await imageBytes('image.png')).toString('base64');
await paste('image.png');
await until('pasted into notes.md', async () => (await state()).text === '# Notes\n\n![](image.png)');
await settled();
s = await state();
check('an image pasted into a saved file whose folder is unknown says so, with Choose folder', s.notice === '1 image not saved beside notes.md', s);
await evaluate(`__picker.folder = 'elsewhere'`);
await key('s', { ctrl: true });
await until('wrong folder refused', async () => (await state()).failure !== '');
s = await state();
check('Save asks for the folder, and refuses one that does not hold the file', s.failure === 'Could not save notes.md: Choose the folder that contains notes.md' && s.edited && (await opfsRead('notes', 'notes.md')) === '# Notes\n\n', s);
await evaluate(`__picker.folder = 'notes'`);
await key('s', { ctrl: true });
await until('saved with its image', async () => !(await state()).edited);
s = await state();
const savedMd = await opfsRead('notes', 'notes.md');
const savedImage = await opfsRead('notes', 'image.png', true);
check('Save in the right folder writes the .md and the image beside it, byte for byte', savedMd === '# Notes\n\n![](image.png)' && savedImage === pastedBytes, { savedMd, image: savedImage?.length, pasted: pastedBytes.length });
check('then the notice is gone, and the folder was asked for once per save', s.notice === '' && s.failure === '' && (await evaluate('__picker.folders')) === 2, { s, folders: await evaluate('__picker.folders') });
await type('\n\nMore.');
await key('s', { ctrl: true });
await until('saved again', async () => !(await state()).edited);
check('a later save knows the folder and asks for none', (await evaluate('__picker.folders')) === 2 && (await opfsRead('notes', 'notes.md')).endsWith(')\n\nMore.'));

const beforeQuick = (await state()).text;
await makeImage('quick.png', 'green', 3000, 2000);
await paste('quick.png');
await until('quick.png pasted', async () => (await state()).text.endsWith('![](quick.png)'));
const compiling = await evaluate(`!__frames.some((f) => f.rev === __sent && f.final)`);
await key('s', { ctrl: true });
await until('saved right after the paste', async () => !(await state()).edited);
await settled();
const quick = await opfsRead('notes', 'quick.png', true);
check('Save pressed while the paste still compiles writes the pasted image too', compiling && quick !== null, { compiling, written: quick?.length ?? null });
await setText(beforeQuick);
await key('s', { ctrl: true });
await until('saved without quick.png', async () => !(await state()).edited);
await settled();

await evaluate(`Object.assign(__picker, { saveIn: 'elsewhere', save: 'copy.md' })`);
await key('s', { ctrl: true, shift: true });
await until('saved as elsewhere', async () => (await state()).name === 'copy.md');
await settled();
s = await state();
check('Save as into another folder writes only the .md there, and the notice offers Choose folder', s.notice === '1 image not saved beside copy.md' && (await opfsRead('elsewhere', 'image.png', true)) === null, s);
await barLayout();

console.log('\nFinding images in the folder');
await evaluate(`Object.assign(__picker, { saveIn: 'notes', open: 'notes.md', folder: 'notes' })`);
await markFrames();
await key('o', { ctrl: true });
await until('notes.md opened fresh', async () => (await state()).name === 'notes.md');
await settled();
s = await state();
// notes.md has the text copy.md had, so the new edit may redraw nothing: the frame is in the last page 1 drawn since.
const shownNow = await evaluate(`__frames.slice(__since).findLast((f) => f.pages.some((p) => p.index === 0))?.pages.find((p) => p.index === 0)`);
check('opened fresh, its image is not found, says the bar, and the preview shows a frame instead', s.notice === '1 image not found' && shownNow && !shownNow.found.magenta, { s, found: shownNow?.found });
await markFrames();
await clickAt(await centreOf('#choose-folder'));
await until('image read from the folder', async () => (await state()).notice === '');
await settled();
first = await firstFrame();
check('Choose folder reads it from the folder: shown, notice gone', centredAt(first?.page, 'magenta', 200), first?.page.found);
await makeImage('plot.png', 'cyan', 150, 50);
await opfsWrite('notes', 'plot.png', '__images["plot.png"]');
await evaluate(`(() => { const v = ${view}; v.dispatch({ selection: { anchor: v.state.doc.length } }); v.focus(); })()`);
await type('\n\n![](plot.png)');
const typedShown = await until('typed image found', () => evaluate(`__frames.findLast((f) => f.rev === __sent && f.final)?.pages.some((p) => p.found.cyan)`)).catch(() => false);
s = await state();
check('typing ![](plot.png) shows plot.png from the folder, with no notice', typedShown && s.text.endsWith('\n\n![](plot.png)') && s.notice === '', s);
await makeImage('chart.png', 'green', 120, 60);
await opfsWrite('notes/figures', 'chart.png', '__images["chart.png"]');
await type('\n\n![](figures/chart.png)');
const nestedShown = await until('image in a subfolder found', () => evaluate(`__frames.findLast((f) => f.rev === __sent && f.final)?.pages.some((p) => p.found.green)`)).catch(() => false);
s = await state();
check('typing ![](figures/chart.png) shows chart.png from the subfolder, with no notice', nestedShown && s.notice === '', s);

console.log('\nWithout the File System Access API');
await page.send('Page.removeScriptToEvaluateOnNewDocument', stub);
await page.send('Page.addScriptToEvaluateOnNewDocument', { source: NO_PICKERS });
await page.send('Page.navigate', { url: 'about:blank' });
await page.send('Storage.clearDataForOrigin', { origin: new URL(url).origin, storageTypes: 'all' });
await page.send('Page.setInterceptFileChooserDialog', { enabled: true });
const chosen = [];
page.listeners.add(({ method, params }) => {
  if (method === 'Page.fileChooserOpened' && params.backendNodeId) page.send('DOM.setFileInputFiles', { files: chosen.shift(), backendNodeId: params.backendNodeId });
});
const downloads = join(dir, 'downloads');
mkdirSync(downloads);
const downloaded = new Map();
await browser.send('Browser.setDownloadBehavior', { behavior: 'allowAndName', downloadPath: downloads, eventsEnabled: true });
browser.listeners.add(({ method, params }) => {
  if (method === 'Browser.downloadWillBegin') downloaded.set(params.guid, { name: params.suggestedFilename, done: false });
  if (method === 'Browser.downloadProgress' && params.state === 'completed') downloaded.get(params.guid).done = true;
});
async function nextDownloads(count, start) {
  const seen = new Set(downloaded.keys());
  await start();
  const guids = await until('downloads', async () => {
    const fresh = [...downloaded].filter(([g, d]) => !seen.has(g) && d.done);
    return fresh.length >= count && fresh.map(([g]) => g);
  });
  return guids.map((guid) => ({ name: downloaded.get(guid).name, bytes: readFileSync(join(downloads, guid)) }));
}
await load();
check('the pickers are gone', !(await evaluate(`'showOpenFilePicker' in window || 'showSaveFilePicker' in window || 'showDirectoryPicker' in window`)));
await setText('# Fallback\n\n');
await makeImage('image.png', 'magenta', 200, 100);
await paste('image.png');
await until('pasted', async () => (await state()).text.includes('!['));
await settled();
let files = await nextDownloads(2, () => key('s', { ctrl: true }));
const md = files.find((f) => f.name === 'Untitled.md');
const png = files.find((f) => f.name === 'image.png');
check('Save downloads the .md and then the image beside it, bytes equal', md?.bytes.toString() === '# Fallback\n\n![](image.png)' && png?.bytes.toString('base64') === pastedBytes, files.map((f) => f.name));
files = await nextDownloads(1, async () => {
  await type(' Again.');
  await key('s', { ctrl: true });
});
await sleep(500);
check('a second save downloads only the .md: the image went with the first', files.length === 1 && files[0].name === 'Untitled.md' && [...downloaded.values()].filter((d) => d.name === 'image.png').length === 1, files.map((f) => f.name));

const folder = join(dir, 'folder');
mkdirSync(folder);
writeFileSync(join(folder, 'fallback.md'), '# From disk\n\n![](image.png)\n');
writeFileSync(join(folder, 'image.png'), Buffer.from(pastedBytes, 'base64'));
chosen.push([join(folder, 'fallback.md')]);
await key('s', { ctrl: true });
await sleep(300);
await key('o', { ctrl: true });
await until('fallback.md open', async () => (await state()).name === 'fallback.md');
await settled();
check('opened through the file input, its image is not found', (await state()).notice === '1 image not found', await state());
chosen.push([folder]);
await markFrames();
await clickAt(await centreOf('#choose-folder'));
await until('folder read', async () => (await state()).notice === '');
await settled();
first = await firstFrame();
check('Choose folder through the folder input reads the image: shown, notice gone', centredAt(first?.page, 'magenta', 200), first?.page.found);

console.log('\nDropping a Markdown file with its image');
writeFileSync(join(folder, 'dropped.md'), '# Dropped with its image\n\n![](image.png)\n');
await markFrames();
await drop([join(folder, 'dropped.md'), join(folder, 'image.png')], await centreOf('#pages'));
await until('dropped.md open', async () => (await state()).name === 'dropped.md');
await settled();
s = await state();
first = await firstFrame();
check('a .md dropped with its image opens with the image shown, and nothing to notice', centredAt(first?.page, 'magenta', 200) && s.notice === '' && !s.edited, { s, found: first?.page.found });

console.log('\nLinking around an image');
const LINKED = '# Linked\n\nBefore the picture.\n\n![](image.png)\n\nAfter the picture.\n';
await markFrames();
await setText(LINKED);
await settled();
const { data: { pages: runPages } } = await evaluate(`new Promise((resolve) => {
  const on = ({ data }) => data.kind === 'runs' && (__worker.removeEventListener('message', on), resolve({ data }));
  __worker.addEventListener('message', on);
  __worker.postMessage({ kind: 'runs', id: 1e9 });
})`);
const pageBox = await evaluate(`(() => { const r = document.querySelector('#pages canvas').getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; })()`);
const onPage = (fx, fy) => ({ x: pageBox.x + fx * pageBox.w, y: pageBox.y + fy * pageBox.h });
const runAt = (text) => {
  const { width, height, runs } = runPages[0];
  const run = runs.find((r) => r.text.includes(text));
  return run && onPage((run.x + run.w / 2) / width, (run.y + run.h / 2) / height);
};
/** Where a click on the preview puts the editor's cursor, which starts at 0. */
async function clickPreview(point) {
  await evaluate(`${view}.dispatch({ selection: { anchor: 0 } })`);
  await clickAt(point);
  await until('cursor moved', async () => (await evaluate(`${view}.state.selection.main.head`)) !== 0, 50).catch(() => null);
  return evaluate(`${view}.state.selection.main.head`);
}
const inside = (head, text) => head >= LINKED.indexOf(text) && head <= LINKED.indexOf(text) + text.length;
let head = await clickPreview(runAt('Before'));
check('a click on the text right before a block image puts the cursor in that text', inside(head, 'Before the picture.'), { head, near: LINKED.slice(head - 5, head + 5) });
head = await clickPreview(runAt('After'));
check('a click on the text right after it puts the cursor in that text', inside(head, 'After the picture.'), { head, near: LINKED.slice(head - 5, head + 5) });
await linkImage(LINKED, 'a block image');
await markFrames();
await setText('# Inline\n\nWords before ![](image.png) words after.\n');
await settled();
await linkImage(await evaluate(`${view}.state.doc.toString()`), 'an inline image');

await close();
rmSync(dir, { recursive: true, force: true });
console.log(failures ? `\n${failures} failed` : '\nall passed');
process.exit(failures ? 1 : 0);

/**
 * Checks both directions for the one image in `text`, against its box in the first bitmap that showed it: a click
 * anywhere on it lands inside its Markdown, and the cursor inside its Markdown lays the band over it, with no caret.
 */
async function linkImage(text, what) {
  const from = text.indexOf('![](image.png)');
  const to = from + '![](image.png)'.length;
  const frame = await firstFrame();
  const box = fractions(frame.page, frame.page.found.magenta.box);
  const [l, t, r, b] = box;
  const heads = [];
  for (const [u, v] of [[0.5, 0.5], [0.04, 0.06], [0.96, 0.06], [0.04, 0.94], [0.96, 0.94]]) heads.push(await clickPreview(onPage(l + u * (r - l), t + v * (b - t))));
  check(`a click on ${what}, in its centre or near a corner, puts the cursor inside its ![](image.png)`, heads.every((h) => h > from && h < to), { heads, from, to });

  const marks = [];
  for (const offset of [from + 1, from + 5, to - 1]) marks.push(await markFor(offset));
  const near = (band) => band.every((v, i) => Math.abs(v - box[i]) < 0.004);
  check(`the cursor inside ${what}'s Markdown lays the band over the image, with no caret`, marks.every((m) => !m.hidden && !m.caret && near(m.band)), { box, marks });
  const beside = [await markFor(from), await markFor(to)];
  check(`the cursor just before or after ${what}'s Markdown shows the text caret`, beside.every((m) => !m.hidden && m.caret), beside);

  const times = [];
  for (let i = 0; i < 11; i++) {
    times.push(await evaluate(`new Promise((resolve) => {
      const t0 = performance.now();
      const on = ({ data }) => data.kind === 'sourced' && data.id === ${2e9 + i} && (__worker.removeEventListener('message', on), resolve(performance.now() - t0));
      __worker.addEventListener('message', on);
      __worker.postMessage({ kind: 'source', id: ${2e9 + i}, page: 0, fx: ${(l + r) / 2}, fy: ${(t + b) / 2} });
    })`));
  }
  console.log(`     click on ${what} to source offset: median ${times.sort((x, y) => x - y)[5].toFixed(1)} ms, max ${times[10].toFixed(1)} ms`);
}

/** Where the preview marks the cursor at `offset`: the band as page fractions, and whether the caret shows. */
async function markFor(offset) {
  const seen = await evaluate('__located');
  await evaluate(`${view}.dispatch({ selection: { anchor: ${offset} } })`);
  await until('cursor located', async () => (await evaluate('__located')) > seen);
  await sleep(100);
  return evaluate(`(() => {
    const page = document.querySelector('#pages canvas').getBoundingClientRect();
    const band = document.querySelector('.cursor-line').getBoundingClientRect();
    const round = (v) => Math.round(v * 1000) / 1000;
    return {
      hidden: document.querySelector('.cursor-mark').hidden,
      caret: !document.querySelector('.cursor-caret').hidden,
      band: [(band.left - page.left) / page.width, (band.top - page.top) / page.height, (band.right - page.left) / page.width, (band.bottom - page.top) / page.height].map(round),
    };
  })()`);
}

/** The bar with the notice showing, at desktop and phone widths in both schemes: rows, and nothing off screen or overlapping. */
async function barLayout() {
  if (args.shots) mkdirSync(args.shots, { recursive: true });
  for (const [width, height, mobile] of [
    [1400, 900, false],
    [375, 812, true],
  ]) {
    await page.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 2, mobile });
    for (const scheme of ['light', 'dark']) {
      await page.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: scheme }] });
      await sleep(300);
      const bar = await evaluate(`(() => {
        const box = (el) => el.getBoundingClientRect();
        const bar = box(document.querySelector('.bar'));
        const name = box(document.getElementById('file-name'));
        const notice = box(document.getElementById('image-notice'));
        const actions = box(document.querySelector('.actions'));
        const apart = (a, b) => a.right <= b.left || b.right <= a.left || a.bottom <= b.top || b.bottom <= a.top;
        return {
          height: Math.round(bar.height),
          shown: !document.getElementById('image-notice').hidden,
          inside: [notice, ...[...document.querySelectorAll('.bar button')].map(box)].every((b) => b.left >= 0 && b.right <= innerWidth && b.top >= bar.top && b.bottom <= bar.bottom),
          clear: apart(name, notice) && apart(notice, actions) && apart(name, actions),
          nameWidth: Math.round(name.width),
        };
      })()`);
      check(
        `${width} px ${scheme}: with the notice the bar ${width > 720 ? 'stays one row' : 'gains a third row for it'}, all of it on screen, nothing overlapping, the name not squeezed out`,
        bar.shown && bar.height < (width > 720 ? 50 : 120) && bar.inside && bar.clear && bar.nameWidth > 40,
        bar,
      );
      if (!args.shots) continue;
      const file = join(args.shots, `notice-${width}-${scheme}.png`);
      writeFileSync(file, Buffer.from((await page.send('Page.captureScreenshot', { clip: { x: 0, y: 0, width, height: 160, scale: 1 } })).data, 'base64'));
      console.log(`     ${file}`);
    }
  }
  await page.send('Emulation.clearDeviceMetricsOverride');
  await page.send('Emulation.setEmulatedMedia', { features: [] });
}
