// Opening, saving and restoring .md files, end to end in headless Chrome against `vite preview` of dist/
// (`npm run check:files` builds it). node bench/check-files.mjs [--shots <dir>] also screenshots the bar.
// CDP cannot answer showOpenFilePicker or showSaveFilePicker: with file chooser interception on, Chrome rejects
// them with AbortError and gives no node to set files on. So the File System Access run replaces only those two
// calls, with handles from the origin private file system; reading, createWritable and the read-back are real.
// The fallback run deletes both pickers, chooses a real file through the intercepted <input type=file>, and
// saves as a real download.
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { launch, sleep, until } from './cdp.mjs';

const { values: args } = parseArgs({ options: { shots: { type: 'string' } } });
const J = JSON.stringify;
const dir = mkdtempSync(join(tmpdir(), 'liveprint-files-'));
const downloads = join(dir, 'downloads');
mkdirSync(downloads);

let failures = 0;
function check(label, ok, detail) {
  if (!ok) failures++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}${!ok && detail !== undefined ? `: ${J(detail)}` : ''}`);
}

const { url, browser, page, evaluate, close } = await launch();
await page.send('Page.enable');
await page.send('DOM.enable');

/** Every dialog the page opens, answered with the next queued answer, or accepted. */
const dialogs = [];
const answers = [];
page.listeners.add(({ method, params }) => {
  if (method !== 'Page.javascriptDialogOpening') return;
  dialogs.push({ type: params.type, message: params.message });
  page.send('Page.handleJavaScriptDialog', { accept: answers.shift() ?? true });
});

const view = `document.querySelector('.cm-content').cmTile.view`;
const state = () =>
  evaluate(`({
    text: ${view}.state.doc.toString(),
    name: document.getElementById('file-name').textContent,
    edited: !document.getElementById('file-edited').hidden,
    title: document.title,
    failure: [...document.querySelectorAll('#overlay .failure')].map((d) => d.textContent).join(' | '),
    pages: document.querySelectorAll('#pages canvas').length,
  })`);

async function key(k, { ctrl = false, shift = false } = {}) {
  const modifiers = (ctrl ? 2 : 0) | (shift ? 8 : 0);
  const event = { modifiers, key: shift ? k.toUpperCase() : k, code: `Key${k.toUpperCase()}`, windowsVirtualKeyCode: k.toUpperCase().charCodeAt(0) };
  await page.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...event });
  await page.send('Input.dispatchKeyEvent', { type: 'keyUp', ...event });
}

async function type(text) {
  for (const ch of text) {
    await page.send('Input.dispatchKeyEvent', { type: 'keyDown', key: ch, text: ch, unmodifiedText: ch });
    await page.send('Input.dispatchKeyEvent', { type: 'keyUp', key: ch });
  }
}

const cursorToEnd = () => evaluate(`(() => { const v = ${view}; v.dispatch({ selection: { anchor: v.state.doc.length } }); v.focus(); })()`);

/** Waits until the worker's final pages of the newest edit are painted, and returns how many pages there are. */
const settled = () =>
  until('pages of the newest edit', () => evaluate(`__pages.final && __pages.rev === __pages.sent && document.querySelectorAll('#pages canvas').length`), 600);

async function load(how = () => page.send('Page.navigate', { url })) {
  await how();
  await until('app booted', () => evaluate(`document.getElementById('file-name').textContent !== ''`));
  await settled();
}

const opfsWrite = (name, text) =>
  evaluate(`(async () => {
    const w = await (await (await navigator.storage.getDirectory()).getFileHandle(${J(name)}, { create: true })).createWritable();
    await w.write(${J(text)});
    await w.close();
  })()`);
const opfsRead = (name) => evaluate(`(async () => (await (await (await navigator.storage.getDirectory()).getFileHandle(${J(name)})).getFile()).text())()`);

/** Records each edit sent to the worker and the newest pages message, so a check can wait for the preview. */
const WATCH_WORKER = `
  window.__pages = { sent: -1, rev: -1, final: false, readyAt: NaN };
  window.__asked = [];
  const request = FileSystemHandle.prototype.requestPermission;
  FileSystemHandle.prototype.requestPermission = function (descriptor) {
    __asked.push(this.name);
    return request.call(this, descriptor);
  };
  window.Worker = class extends Worker {
    constructor(...args) {
      super(...args);
      this.addEventListener('message', ({ data }) => {
        if (data.kind === 'ready') __pages.readyAt = performance.now();
        if (data.kind === 'pages') Object.assign(__pages, { rev: data.rev, final: data.final });
      });
      const post = this.postMessage.bind(this);
      this.postMessage = (message) => {
        if (message.kind === 'edit') __pages.sent = message.rev;
        post(message);
      };
    }
  };`;
const STUB_PICKERS = `
  window.__picker = { open: null, save: null, opened: 0, saved: 0, suggested: null };
  window.showOpenFilePicker = async () => {
    __picker.opened++;
    return [await (await navigator.storage.getDirectory()).getFileHandle(__picker.open)];
  };
  window.showSaveFilePicker = async ({ suggestedName }) => {
    __picker.saved++;
    __picker.suggested = suggestedName;
    return (await navigator.storage.getDirectory()).getFileHandle(__picker.save, { create: true });
  };`;
const NO_PICKERS = `delete window.showOpenFilePicker; delete window.showSaveFilePicker; delete Window.prototype.showOpenFilePicker; delete Window.prototype.showSaveFilePicker;`;

await page.send('Page.addScriptToEvaluateOnNewDocument', { source: WATCH_WORKER });
const stub = await page.send('Page.addScriptToEvaluateOnNewDocument', { source: STUB_PICKERS });

console.log('File System Access, pickers answered from the origin private file system');
await load();
let s = await state();
check('a first visit shows the sample as a clean Untitled.md', s.name === 'Untitled.md' && !s.edited && s.title === 'Untitled.md · liveprint' && s.pages > 1, s);
const firstBoot = await evaluate(`({ restored: performance.getEntriesByName('liveprint:restored')[0].startTime, ready: __pages.readyAt })`);

const NOTES = '# Notes\n\nFirst draft.\n';
await opfsWrite('notes.md', NOTES);
await evaluate(`__picker.open = 'notes.md'`);
await key('o', { ctrl: true });
await until('notes.md open', async () => (await state()).name === 'notes.md');
let pages = await settled();
s = await state();
check('Ctrl+O on a clean document opens without asking', dialogs.length === 0, dialogs);
check('the opened file is in the editor, named, clean and titled', s.text === NOTES && !s.edited && s.title === 'notes.md · liveprint', s);
check('the preview typesets the opened file', pages === 1, pages);

await cursorToEnd();
await type('More.');
s = await state();
check('typing marks it Edited, in the bar and the title', s.edited && s.title === '• notes.md · liveprint', s);
for (let i = 0; i < 5; i++) await key('z', { ctrl: true });
s = await state();
check('undoing back to the opened text is clean again', s.text === NOTES && !s.edited && s.title === 'notes.md · liveprint', s);
for (let i = 0; i < 20; i++) await key('z', { ctrl: true });
check('opening started a new undo history: undoing further never brings back the sample', (await state()).text === NOTES);
await type('Second draft.');
await key('s', { ctrl: true });
await until('saved', async () => !(await state()).edited);
const written = await opfsRead('notes.md');
s = await state();
check('Ctrl+S writes through the opened handle, without a picker', written === `${NOTES}Second draft.` && (await evaluate('__picker.saved')) === 0, written);
check('after saving it is clean', !s.edited && s.title === 'notes.md · liveprint', s);

await opfsWrite('notes.md', `${written}\nChanged on disk.\n`);
await key('o', { ctrl: true });
await until('reopened', async () => (await state()).text.includes('Changed on disk.'));
s = await state();
check('reopening reads the file again', s.text === `${written}\nChanged on disk.\n` && !s.edited, s);

await cursorToEnd();
await type('Unsaved line.');
dialogs.length = 0;
await sleep(400);
await load(() => page.send('Page.reload'));
s = await state();
check('a reload with unsaved changes asks first (beforeunload)', dialogs.length === 1 && dialogs[0].type === 'beforeunload', dialogs);
check('the reload restores the unsaved text, the name and Edited', s.text.endsWith('Unsaved line.') && s.name === 'notes.md' && s.edited && s.title === '• notes.md · liveprint', s);
const restoreBoot = await evaluate(`({ restored: performance.getEntriesByName('liveprint:restored')[0].startTime, ready: __pages.readyAt })`);
await key('s', { ctrl: true });
await until('saved after reload', async () => !(await state()).edited);
check('Ctrl+S after the reload writes through the restored handle', (await opfsRead('notes.md')) === s.text && (await evaluate('__picker.saved')) === 0);

await evaluate(`__picker.save = 'copy.md'`);
await key('s', { ctrl: true, shift: true });
await until('saved as', async () => (await state()).name === 'copy.md');
s = await state();
const suggested = await evaluate('__picker.suggested');
check('Shift+Ctrl+S asks where, suggesting the current name', suggested === 'notes.md', suggested);
check('Save as writes the new file and names it in the bar', (await opfsRead('copy.md')) === s.text && !s.edited && s.title === 'copy.md · liveprint', s);

await cursorToEnd();
await type(' Draft.');
await evaluate(`__picker.open = 'notes.md'`);
dialogs.length = 0;
answers.push(false);
await key('o', { ctrl: true });
await until('discard asked', async () => dialogs.length === 1);
await sleep(200);
s = await state();
check('opening over unsaved changes asks, naming the file', dialogs[0]?.type === 'confirm' && dialogs[0].message === 'Discard unsaved changes to copy.md?', dialogs);
check('declining keeps the edited document', s.name === 'copy.md' && s.edited && s.text.endsWith(' Draft.'), s);
answers.push(true);
await key('o', { ctrl: true });
await until('discarded and opened', async () => (await state()).name === 'notes.md');
s = await state();
check('accepting opens the file', !s.edited && s.text === (await opfsRead('notes.md')), s);

await page.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: 200, y: 200, button: 'left', clickCount: 1 });
await page.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: 200, y: 200, button: 'left', clickCount: 1 });
dialogs.length = 0;
await load(() => page.send('Page.reload'));
s = await state();
check('a reload with no unsaved changes does not ask', dialogs.length === 0, dialogs);
check('it restores the last document, clean', s.name === 'notes.md' && !s.edited, s);

const box = (selector) => evaluate(`(() => { const r = document.querySelector(${J(selector)}).getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
async function drop(path, at) {
  const data = { items: [], files: [path], dragOperationsMask: 1 };
  for (const type of ['dragEnter', 'dragOver', 'drop']) await page.send('Input.dispatchDragEvent', { type, ...at, data });
}
const DROPPED = '# Dropped\n\nFrom the desktop.\n';
writeFileSync(join(dir, 'dropped.md'), DROPPED);
const png = join(dir, 'photo.png');
writeFileSync(png, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64'));

dialogs.length = 0;
await drop(join(dir, 'dropped.md'), await box('.cm-content'));
await until('dropped file open', async () => (await state()).name === 'dropped.md');
s = await state();
check('a .md dropped on the editor opens as the document, with its text not inserted', s.text === DROPPED && !s.edited && dialogs.length === 0, { s, dialogs });

await cursorToEnd();
await type(' More.');
dialogs.length = 0;
answers.push(false);
await drop(join(dir, 'dropped.md'), await box('#pages'));
await sleep(300);
s = await state();
check('a drop on the preview over unsaved changes asks first, and declining keeps them', dialogs[0]?.message === 'Discard unsaved changes to dropped.md?' && s.text.endsWith(' More.') && s.edited, { dialogs, s });

dialogs.length = 0;
await drop(png, await box('.cm-content'));
await drop(png, await box('#pages'));
await sleep(500);
s = await state();
const href = await evaluate('location.href');
check('a dropped image is inserted, on the editor or the preview, and neither opens nor navigates away nor asks', href === url && s.name === 'dropped.md' && s.text.match(/!\[\]\(photo\.png\)/g)?.length === 2 && dialogs.length === 0, { href, s, dialogs });

if (args.shots) await screenshots(args.shots);

console.log('\nWithout the File System Access API: <input type=file> and downloads');
await page.send('Page.removeScriptToEvaluateOnNewDocument', stub);
await page.send('Page.addScriptToEvaluateOnNewDocument', { source: NO_PICKERS });
await page.send('Page.navigate', { url: 'about:blank' });
await page.send('Storage.clearDataForOrigin', { origin: new URL(url).origin, storageTypes: 'all' });
await page.send('Page.setInterceptFileChooserDialog', { enabled: true });
const FALLBACK = '# Fallback\n\nChosen through the file input.\n';
writeFileSync(join(dir, 'fallback.md'), FALLBACK);
page.listeners.add(({ method, params }) => {
  if (method === 'Page.fileChooserOpened' && params.backendNodeId) page.send('DOM.setFileInputFiles', { files: [join(dir, 'fallback.md')], backendNodeId: params.backendNodeId });
});
const downloaded = new Map();
await browser.send('Browser.setDownloadBehavior', { behavior: 'allowAndName', downloadPath: downloads, eventsEnabled: true });
browser.listeners.add(({ method, params }) => {
  if (method === 'Browser.downloadWillBegin') downloaded.set(params.guid, { name: params.suggestedFilename, done: false });
  if (method === 'Browser.downloadProgress' && params.state === 'completed') downloaded.get(params.guid).done = true;
});
async function nextDownload(start) {
  const seen = new Set(downloaded.keys());
  await start();
  const guid = await until('download', async () => [...downloaded].find(([g, d]) => !seen.has(g) && d.done)?.[0]);
  return { name: downloaded.get(guid).name, bytes: readFileSync(join(downloads, guid), 'utf8') };
}

dialogs.length = 0;
await load();
check('the pickers are gone', !(await evaluate(`'showOpenFilePicker' in window || 'showSaveFilePicker' in window`)));
check('after site data is cleared, the sample is back', (await state()).name === 'Untitled.md');
await key('o', { ctrl: true });
await until('fallback.md open', async () => (await state()).name === 'fallback.md');
s = await state();
check('Ctrl+O opens a real file chosen in the file input', s.text === FALLBACK && !s.edited && s.title === 'fallback.md · liveprint', s);
await cursorToEnd();
await type('Typed.');
let file = await nextDownload(() => key('s', { ctrl: true }));
s = await state();
check('Ctrl+S downloads the text under the file name', file.name === 'fallback.md' && file.bytes === `${FALLBACK}Typed.`, file);
check('after the download it is clean', !s.edited && s.title === 'fallback.md · liveprint', s);
await type(' Again.');
file = await nextDownload(async () => {
  const at = await box('#save');
  for (const type of ['mousePressed', 'mouseReleased']) await page.send('Input.dispatchMouseEvent', { type, ...at, button: 'left', clickCount: 1, modifiers: 8 });
});
check('Shift-click on Save is also a download without the API', file.name === 'fallback.md' && file.bytes === `${FALLBACK}Typed. Again.`, file);
file = await nextDownload(() => evaluate(`document.getElementById('download-pdf').click()`));
check('Download .pdf is named after the file', file.name === 'fallback.pdf' && file.bytes.startsWith('%PDF'), file.name);
check('no failure was shown at any point in this run', (await state()).failure === '', (await state()).failure);

dialogs.length = 0;
await drop(join(dir, 'dropped.md'), await box('#pages'));
await until('dropped file open', async () => (await state()).name === 'dropped.md');
check('a dropped file opens without the pickers too', (await state()).text === DROPPED && dialogs.length === 0);
await cursorToEnd();
await type('Edited.');
const before = downloaded.size;
await key('s', { ctrl: true });
await until('write permission asked', () => evaluate('__asked.length > 0'));
await sleep(1000);
const asked = await evaluate('__asked');
check('Ctrl+S on a dropped file asks to write to that file, and downloads nothing', J(asked) === '["dropped.md"]' && downloaded.size === before, { asked, downloads: downloaded.size - before });
// Headless Chrome shows that prompt to no one, and CDP cannot grant file system permissions, so the save waits
// and the tab loses its keyboard. This is the last step that needs one; a reload ends the wait.
await load(() => page.send('Page.reload'));
s = await state();
check('the reload restores the dropped file and its unsaved text', s.name === 'dropped.md' && s.text === `${DROPPED}Edited.` && s.edited, s);

console.log(`\nrestore cost, page clock from navigation start:`);
console.log(`  first visit:          editor text known at ${firstBoot.restored.toFixed(1)} ms, compiler ready at ${firstBoot.ready.toFixed(1)} ms`);
console.log(`  reload with a record: editor text known at ${restoreBoot.restored.toFixed(1)} ms, compiler ready at ${restoreBoot.ready.toFixed(1)} ms`);
await close();
console.log(failures ? `\n${failures} failed` : '\nall passed');
process.exit(failures ? 1 : 0);

async function screenshots(out) {
  mkdirSync(out, { recursive: true });
  const LONG = 'Quarterly planning notes for the platform team, final draft with comments.md';
  for (const [width, height, mobile] of [
    [1400, 900, false],
    [375, 812, true],
  ]) {
    await page.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 2, mobile });
    for (const scheme of ['light', 'dark']) {
      await page.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: scheme }] });
      for (const [name, edited] of [
        ['dropped.md', false],
        ['dropped.md', true],
        [LONG, true],
      ]) {
        await opfsWrite(name, DROPPED);
        await evaluate(`__picker.open = ${J(name)}`);
        const opened = await evaluate('__picker.opened');
        await key('o', { ctrl: true });
        await until('opened for the screenshot', async () => (await evaluate('__picker.opened')) > opened && (await state()).name === name && !(await state()).edited);
        await sleep(100);
        if (edited) {
          await cursorToEnd();
          await type('x');
        }
        await settled();
        await sleep(300);
        const bar = await evaluate(`(() => {
          const bar = document.querySelector('.bar').getBoundingClientRect();
          const name = document.getElementById('file-name');
          const buttons = [...document.querySelectorAll('.bar button')].map((b) => b.getBoundingClientRect());
          const actions = document.querySelector('.actions').getBoundingClientRect();
          return {
            height: bar.height,
            truncated: name.scrollWidth > name.clientWidth,
            clear: (({ right, bottom }) => right <= actions.left || bottom <= actions.top)(name.getBoundingClientRect()),
            edited: !document.getElementById('file-edited').hidden,
            inside: buttons.every((b) => b.right <= innerWidth && b.top >= bar.top && b.bottom <= bar.bottom),
          };
        })()`);
        const file = join(out, `bar-${width}-${scheme}-${name === LONG ? 'long' : edited ? 'edited' : 'clean'}.png`);
        writeFileSync(file, Buffer.from((await page.send('Page.captureScreenshot', { clip: { x: 0, y: 0, width, height: Math.min(height, 240), scale: 1 } })).data, 'base64'));
        check(`${width} px ${scheme}${name === LONG ? ', long name' : edited ? ', edited' : ''}: the bar ${width > 720 ? 'is one row' : 'has two rows'}, the name clear of the buttons, every button on screen${name === LONG && width <= 720 ? ', the name cut short' : ''}`, bar.height < (width > 720 ? 50 : 90) && bar.inside && bar.clear && bar.edited === edited && (name !== LONG || width > 720 || bar.truncated), bar);
        console.log(`     ${file}`);
      }
    }
  }
  await page.send('Emulation.clearDeviceMetricsOverride');
  await page.send('Emulation.setEmulatedMedia', { features: [] });
}
