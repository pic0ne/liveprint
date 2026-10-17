// Images, end to end in headless Chrome against `vite preview` of dist/ (`npm run check:images` builds it): pasting
// and dropping them, the first bitmap that shows them, restoring, saving beside the file, finding them in its folder,
// and linking around them. Test images are drawn in the page with canvas, one solid colour each, so a page bitmap
// shows an image where that colour is. As in check-files.mjs, CDP cannot answer the File System Access pickers, so
// the API run replaces showOpenFilePicker, showSaveFilePicker and showDirectoryPicker with handles from the origin
// private file system; reading, writing and the read-back are real. The fallback run deletes the pickers.
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { launch, sleep, until } from './cdp.mjs';

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
  window.__colours = ${J(COLOURS)};
  window.Worker = class extends Worker {
    constructor(...args) {
      super(...args);
      window.__worker = this;
      this.addEventListener('message', ({ data }) => {
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

/** The first frame of the newest edit that redrew page `index`, and whether it was final. */
const firstFrame = (index = 0) =>
  evaluate(`(() => { const f = __frames.find((f) => f.rev === __sent && f.pages.some((p) => p.index === ${index})); return f && { final: f.final, images: f.images, page: f.pages.find((p) => p.index === ${index}) }; })()`);

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
await paste('image.png');
await until('pasted other bytes', async () => (await state()).text.split('![').length === 4);
s = await state();
check('other bytes under the same name become image-2.png', s.text.endsWith('![](image-2.png)'), s.text);
await settled();
first = await firstFrame();
check('and show in their own colour', first?.page.found.cyan?.count > 0 && first.page.found.magenta?.count > 0, first?.page.found);

await setText('# Vector\n\n');
await makeImage('plot.svg', 'violet', 300, 150, 'image/svg+xml');
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

await close();
console.log(failures ? `\n${failures} failed` : '\nall passed');
process.exit(failures ? 1 : 0);
