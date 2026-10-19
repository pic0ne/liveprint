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

const { url, browser, page, evaluate, newTab, close } = await launch();
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

const box = (selector) => evaluate(`(() => { const r = document.querySelector(${J(selector)}).getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
async function clickAt(at, modifiers = 0) {
  for (const type of ['mousePressed', 'mouseReleased']) await page.send('Input.dispatchMouseEvent', { type, ...at, button: 'left', clickCount: 1, modifiers });
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

/**
 * Records each edit sent to the worker and the newest pages message, so a check can wait for the preview. `__hold`
 * stops the open picker, the read of a dropped file or the reading of image bytes until `__release`, so a check can
 * type while an open is in progress.
 */
const WATCH_WORKER = `
  window.__pages = { sent: -1, rev: -1, final: false, readyAt: NaN };
  window.__holds = {};
  window.__hold = (name) => {
    let release;
    const promise = new Promise((resolve) => (release = resolve));
    __holds[name] = { promise, release, reached: 0 };
  };
  window.__release = (name) => {
    __holds[name]?.release();
    delete __holds[name];
  };
  window.__held = async (name) => {
    const hold = __holds[name];
    if (!hold) return;
    hold.reached++;
    await hold.promise;
  };
  const arrayBuffer = Blob.prototype.arrayBuffer;
  Blob.prototype.arrayBuffer = async function () {
    await __held('bytes');
    return arrayBuffer.call(this);
  };
  const getHandle = DataTransferItem.prototype.getAsFileSystemHandle;
  DataTransferItem.prototype.getAsFileSystemHandle = function () {
    const handle = getHandle.call(this);
    return __held('drop').then(() => handle);
  };
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
    await __held('picker');
    return [await (await navigator.storage.getDirectory()).getFileHandle(__picker.open)];
  };
  window.showSaveFilePicker = async ({ suggestedName }) => {
    __picker.saved++;
    __picker.suggested = suggestedName;
    return (await navigator.storage.getDirectory()).getFileHandle(__picker.save, { create: true });
  };`;
// Without FileSystemObserver the app checks the file on disk only when the tab comes back. Its reports arrive when the
// browser chooses, so the run that keeps it counts them and waits for each one it causes.
const NO_OBSERVER = `delete window.FileSystemObserver;`;
const COUNT_REPORTS = `
  window.__reports = 0;
  window.__comebacks = 0;
  window.addEventListener('focus', () => __comebacks++);
  document.addEventListener('visibilitychange', () => __comebacks++);
  const Observer = window.FileSystemObserver;
  window.FileSystemObserver = class extends Observer {
    constructor(callback) {
      super((...args) => {
        __reports++;
        callback(...args);
      });
    }
  };`;
const NO_PICKERS = `delete window.showOpenFilePicker; delete window.showSaveFilePicker; delete Window.prototype.showOpenFilePicker; delete Window.prototype.showSaveFilePicker;`;

await page.send('Page.addScriptToEvaluateOnNewDocument', { source: WATCH_WORKER });
const stub = await page.send('Page.addScriptToEvaluateOnNewDocument', { source: STUB_PICKERS });
let noObserver = await page.send('Page.addScriptToEvaluateOnNewDocument', { source: NO_OBSERVER });

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

console.log('\nA file another program changes');
const disk = () => evaluate(`!document.getElementById('disk-notice').hidden`);
const comeBack = () => evaluate(`window.dispatchEvent(new Event('focus'))`);
const opened = s.text;
await opfsWrite('notes.md', `${opened}Written elsewhere.\n`);
await comeBack();
await until('clean document reloaded', async () => (await state()).text === `${opened}Written elsewhere.\n`).catch(() => null);
s = await state();
check('a clean document takes the new text when the tab comes back, and stays clean', s.text === `${opened}Written elsewhere.\n` && !s.edited && !(await disk()), s);
await key('z', { ctrl: true });
s = await state();
check('undo brings back the text from before, now Edited', s.text === opened && s.edited, s);
await key('z', { ctrl: true, shift: true });
check('redo is clean again', !(await state()).edited);

await cursorToEnd();
await type('Mine.');
await opfsWrite('notes.md', `${opened}Theirs.\n`);
await comeBack();
await until('notice shown', disk).catch(() => null);
s = await state();
check('an edited document keeps its text and says the file changed on disk', s.text === `${opened}Written elsewhere.\nMine.` && s.edited && (await disk()), s);
dialogs.length = 0;
answers.push(false);
await key('s', { ctrl: true });
await until('overwrite asked', async () => dialogs.length === 1);
await sleep(300);
check('Save asks before overwriting the change, naming the file', dialogs[0]?.type === 'confirm' && dialogs[0].message === 'notes.md has changed on disk since it was opened. Overwrite it with the text here?', dialogs);
check('declining leaves the file on disk alone, the document Edited and the notice up', (await opfsRead('notes.md')) === `${opened}Theirs.\n` && (await state()).edited && (await disk()));
await evaluate(`document.getElementById('reload').click()`);
await until('reloaded', async () => !(await state()).edited);
s = await state();
check('Reload takes the text on disk and clears the notice', s.text === `${opened}Theirs.\n` && !(await disk()), s);
await key('z', { ctrl: true });
check('undo after Reload brings back the unsaved text', (await state()).text === `${opened}Written elsewhere.\nMine.`);

await opfsWrite('notes.md', `${opened}Theirs again.\n`);
dialogs.length = 0;
answers.push(true);
await key('s', { ctrl: true });
await until('saved over the change', async () => !(await state()).edited);
s = await state();
check('accepting overwrites the file with the text here', dialogs.length === 1 && (await opfsRead('notes.md')) === s.text && s.text.endsWith('Mine.') && !(await disk()), { s, dialogs });
await opfsWrite('notes.md', opened);
await comeBack();
await until('back to the opened text', async () => (await state()).text === opened);

console.log('\nA file another program changes, reported by FileSystemObserver');
await page.send('Page.removeScriptToEvaluateOnNewDocument', noObserver);
const counting = await page.send('Page.addScriptToEvaluateOnNewDocument', { source: COUNT_REPORTS });
await load(() => page.send('Page.reload'));
const reports = () => evaluate('__reports');
const comebacks = () => evaluate('__comebacks');
let reported = await reports();
let cameBack = await comebacks();
await opfsWrite('notes.md', `${opened}Observed.\n`);
await until('the observer reloads the clean document', async () => (await reports()) > reported && (await state()).text === `${opened}Observed.\n`).catch(() => null);
s = await state();
check('a clean document takes the change the observer reports, without the tab coming back', s.text === `${opened}Observed.\n` && !s.edited && !(await disk()) && (await comebacks()) === cameBack, { s, comebacks: (await comebacks()) - cameBack });

await cursorToEnd();
await type('Mine.');
reported = await reports();
cameBack = await comebacks();
await opfsWrite('notes.md', `${opened}Observed again.\n`);
await until('the observer shows the notice', async () => (await reports()) > reported && (await disk())).catch(() => null);
s = await state();
check('an edited document keeps its text and shows Changed on disk when the observer reports a change', s.text === `${opened}Observed.\nMine.` && s.edited && (await disk()) && (await comebacks()) === cameBack, { s, comebacks: (await comebacks()) - cameBack });
await evaluate(`document.getElementById('reload').click()`);
await until('reloaded', async () => !(await state()).edited);

reported = await reports();
await opfsWrite('notes.md', `${opened}Before the open.\n`);
await until('the observer reloads before the open', async () => (await reports()) > reported && (await state()).text === `${opened}Before the open.\n`);
await opfsWrite('copy.md', '# Copy\n');
await evaluate(`__picker.open = 'copy.md'`);
dialogs.length = 0;
await key('o', { ctrl: true });
await until('copy.md open', async () => (await state()).name === 'copy.md');
await settled();
s = await state();
check('Ctrl+O after the observer reloaded opens the file, clean and without asking', s.text === '# Copy\n' && !s.edited && dialogs.length === 0, { s, dialogs });
await page.send('Page.removeScriptToEvaluateOnNewDocument', counting);
noObserver = await page.send('Page.addScriptToEvaluateOnNewDocument', { source: NO_OBSERVER });
await evaluate(`__picker.open = 'notes.md'`);
await key('o', { ctrl: true });
await until('notes.md open again', async () => (await state()).name === 'notes.md');

await page.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: 200, y: 200, button: 'left', clickCount: 1 });
await page.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: 200, y: 200, button: 'left', clickCount: 1 });
dialogs.length = 0;
await load(() => page.send('Page.reload'));
s = await state();
check('a reload with no unsaved changes does not ask', dialogs.length === 0, dialogs);
check('it restores the last document, clean', s.name === 'notes.md' && !s.edited, s);

async function drop(paths, at) {
  const data = { items: [], files: [paths].flat(), dragOperationsMask: 1 };
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

console.log('\nTyping while a file opens');
const holding = (name) => until(`${name} held`, () => evaluate(`__holds[${J(name)}]?.reached > 0`));
const setIn = (ev, text) => ev(`(() => { const v = ${view}; v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: ${J(text)} } }); })()`);
await evaluate(`__picker.open = 'notes.md'`);
await key('o', { ctrl: true });
await until('notes.md open', async () => (await state()).name === 'notes.md' && !(await state()).edited);
const clean = (await state()).text;

await evaluate(`__hold('picker')`);
answers.length = 0;
await key('o', { ctrl: true });
await holding('picker');
await cursorToEnd();
await type(' Typed.');
dialogs.length = 0;
answers.push(false);
await evaluate(`__release('picker')`);
await until('discard asked', async () => dialogs.length === 1).catch(() => null);
await sleep(200);
s = await state();
check('text typed while the open picker is up makes Ctrl+O ask first, and declining keeps it', dialogs[0]?.message === 'Discard unsaved changes to notes.md?' && s.text === `${clean} Typed.` && s.edited, { dialogs, s });
await setIn(evaluate, clean);

await evaluate(`__hold('drop')`);
answers.length = 0;
dialogs.length = 0;
await drop(join(dir, 'dropped.md'), await box('#pages'));
await holding('drop');
await cursorToEnd();
await type(' Typed.');
answers.push(false);
await evaluate(`__release('drop')`);
await until('discard asked', async () => dialogs.length === 1).catch(() => null);
await sleep(200);
s = await state();
check('text typed while a dropped file is read makes the drop ask first, and declining keeps it', dialogs[0]?.message === 'Discard unsaved changes to notes.md?' && s.text === `${clean} Typed.` && s.name === 'notes.md', { dialogs, s });
await setIn(evaluate, clean);

await evaluate(`__hold('bytes')`);
answers.length = 0;
dialogs.length = 0;
await drop([join(dir, 'dropped.md'), png], await box('#pages'));
await holding('bytes');
const sentBefore = await evaluate('__pages.sent');
await cursorToEnd();
await type(' Typed.');
const sentWhileHeld = await evaluate('__pages.sent');
await evaluate(`__release('bytes')`);
await until('dropped.md open', async () => (await state()).name === 'dropped.md');
await settled();
s = await state();
check('text typed while a dropped file’s images load goes into the opened file and stays', s.text === `${DROPPED} Typed.` && s.edited && dialogs.length === 0, { dialogs, s });
check('the worker gets none of it before the images, and then compiles it without a failure', sentWhileHeld === sentBefore && s.failure === '' && s.pages > 0, { sentBefore, sentWhileHeld, s });

console.log('\nSeveral tabs');
const textIn = (ev) => ev(`${view}.state.doc.toString()`);
const docId = (ev) => ev(`sessionStorage.getItem('liveprint.doc')`);
async function openTab(beforeLoad) {
  const tab = await newTab();
  await tab.page.send('Page.enable');
  if (beforeLoad) await tab.page.send('Page.addScriptToEvaluateOnNewDocument', { source: beforeLoad });
  tab.page.listeners.add(({ method }) => method === 'Page.javascriptDialogOpening' && tab.page.send('Page.handleJavaScriptDialog', { accept: true }));
  tab.reload = async (how = { url }) => {
    await tab.page.send('Page.navigate', how);
    await until('tab booted', () => tab.evaluate(`document.getElementById('file-name').textContent !== '' && !!document.querySelector('.cm-content')`));
  };
  await tab.reload();
  return tab;
}
await setIn(evaluate, 'Tab A.');
const b = await openTab();
s = { text: await textIn(b.evaluate), name: await b.evaluate(`document.getElementById('file-name').textContent`) };
check('a second tab starts empty, since the first holds the only document', s.text === '' && s.name === 'Untitled.md', s);
await setIn(b.evaluate, 'Tab B.');
await setIn(evaluate, 'Tab A again.');
await sleep(400);
await b.reload();
check('reloading the second tab brings back its own text', (await textIn(b.evaluate)) === 'Tab B.', await textIn(b.evaluate));
await load(() => page.send('Page.reload'));
check('reloading the first tab brings back its own text, not the one written last', (await textIn(evaluate)) === 'Tab A again.', await textIn(evaluate));

const first = await docId(evaluate);
const c = await openTab(`sessionStorage.setItem('liveprint.doc', ${J(first)})`);
s = { text: await textIn(c.evaluate), id: await docId(c.evaluate) };
check('a duplicated tab shows a copy of the document under a record of its own', s.text === 'Tab A again.' && s.id && s.id !== first, s);
await setIn(c.evaluate, 'Tab C.');
await sleep(400);
await load(() => page.send('Page.reload'));
check('typing in the copy leaves the first tab alone', (await textIn(evaluate)) === 'Tab A again.', await textIn(evaluate));

await b.close();
await c.close();
await sleep(300);
const d = await openTab();
check('a new tab, after the others closed, takes the newest document no open tab holds', (await textIn(d.evaluate)) === 'Tab C.', await textIn(d.evaluate));

console.log('\nRecent documents');
const panelOpen = () => evaluate(`!document.getElementById('recent-panel').hidden`);
async function showRecent() {
  if (!(await panelOpen())) await clickAt(await box('.recent-toggle'));
  await until('the recent list shown', panelOpen);
  return evaluate(`[...document.querySelectorAll('#recent-panel .recent-row')].map((r) => ({
    name: r.querySelector('.recent-name').textContent,
    when: r.querySelector('.recent-when').textContent,
    dateTime: r.querySelector('time')?.dateTime ?? null,
    preview: r.querySelector('.recent-preview').textContent,
    disabled: r.getAttribute('aria-disabled') === 'true',
  }))`);
}
const ROW = (preview) => `[...document.querySelectorAll('.recent-row')].find((r) => r.querySelector('.recent-preview').textContent === ${J(preview)})`;
const rowAt = (preview) => evaluate(`(() => { const r = ${ROW(preview)}.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
const keptAtOf = (text) =>
  evaluate(`new Promise((resolve) => {
    indexedDB.open('liveprint').onsuccess = ({ target: { result: db } }) => {
      db.transaction('docs').objectStore('docs').getAll().onsuccess = ({ target }) => {
        db.close();
        resolve(target.result.find((r) => r.text === ${J(text)})?.keptAt ?? null);
      };
    };
  })`);

let rows = await showRecent();
check('the list shows the document another tab holds, disabled, saying it is open there', rows.some((r) => r.preview === 'Tab C.' && r.name === 'dropped.md' && r.disabled && r.when === 'Open in another tab' && r.dateTime === null), rows);
const e = await openTab();
check('a tab opened meanwhile takes the closed tab’s document', (await textIn(e.evaluate)) === 'Tab B.', await textIn(e.evaluate));
dialogs.length = 0;
await clickAt(await rowAt('Tab B.'));
await until('the open failed', async () => (await state()).failure !== '').catch(() => null);
s = await state();
check('opening a document another tab took after the list was read fails, and the line says why', s.failure === 'Could not open Untitled.md: it is open in another tab' && s.text === 'Tab A again.' && dialogs.length === 0, { s, dialogs });
const f = await openTab();
await setIn(f.evaluate, 'x');
await setIn(f.evaluate, '');
await sleep(400);
await f.close();
await e.close();
await sleep(300);

rows = await showRecent();
const keptB = await keptAtOf('Tab B.');
const b2 = rows.find((r) => r.preview === 'Tab B.');
check('a closed tab’s document is listed, with its name, first line and when it was last edited', b2?.name === 'Untitled.md' && !b2.disabled && /^(now|\d+ minutes? ago)$/.test(b2.when) && b2.dateTime === new Date(keptB).toISOString(), { rows, keptB });
check('this tab’s own document and an empty Untitled.md are not listed', rows.length === 2 && rows.every((r) => r.preview !== 'Tab A again.' && r.preview !== ''), rows);
await clickAt(await rowAt('Tab C.'));
await sleep(300);
check('clicking the held document opens nothing and leaves the list up', (await textIn(evaluate)) === 'Tab A again.' && (await panelOpen()));

// A write transaction from another connection holds up the read of the document opened, so the two keystrokes
// typed meanwhile are still waiting to be written when the tab moves to the other record.
await evaluate(`new Promise((resolve) => {
  indexedDB.open('liveprint').onsuccess = ({ target: { result: db } }) => {
    const store = db.transaction('docs', 'readwrite').objectStore('docs');
    window.__unblock = false;
    const busy = () => (window.__unblock ? db.close() : (store.count().onsuccess = busy));
    busy();
    resolve();
  };
})`);
dialogs.length = 0;
await evaluate(`${ROW('Tab B.')}.click()`);
await sleep(200);
await evaluate(`(() => {
  const v = ${view};
  v.dispatch({ changes: { from: v.state.doc.length, insert: ' Unsaved' } });
  v.dispatch({ changes: { from: v.state.doc.length, insert: '.' } });
  window.__unblock = true;
})()`);
await until('the recent document open', async () => (await state()).text === 'Tab B.');
await settled();
s = await state();
check('opening a listed document shows its text and name, without asking', s.name === 'Untitled.md' && s.edited && s.title === '• Untitled.md · liveprint' && s.failure === '' && dialogs.length === 0 && !(await panelOpen()), { s, dialogs });
await sleep(500);
check('opening it leaves when it was last edited alone', (await keptAtOf('Tab B.')) === keptB, { before: keptB, after: await keptAtOf('Tab B.') });
await load(() => page.send('Page.reload'));
check('a reload comes back to the document opened from the list', (await textIn(evaluate)) === 'Tab B.', await textIn(evaluate));

rows = await showRecent();
check('the document left behind is listed, with the text typed just before the switch', rows.some((r) => r.name === 'dropped.md' && r.preview === 'Tab A again. Unsaved.' && !r.disabled), rows);
await clickAt(await rowAt('Tab A again. Unsaved.'));
await until('the left document open again', async () => (await state()).name === 'dropped.md');
s = await state();
check('it opens back with that text intact, still Edited', s.text === 'Tab A again. Unsaved.' && s.edited && s.failure === '', s);

await showRecent();
await page.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
await page.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
check('Escape closes the list and puts focus back on its button', !(await panelOpen()) && (await evaluate(`document.activeElement.classList.contains('recent-toggle')`)));
await d.close();

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
file = await nextDownload(async () => clickAt(await box('#save'), 8));
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
      await clickAt(await box('.recent-toggle'));
      await until('the recent list shown', () => evaluate(`!document.getElementById('recent-panel').hidden`));
      await sleep(200);
      const panel = await evaluate(`(() => {
        const bar = document.querySelector('.bar').getBoundingClientRect();
        const r = document.getElementById('recent-panel').getBoundingClientRect();
        return { bar: bar.height, rows: document.querySelectorAll('.recent-row').length, left: r.left, right: r.right, bottom: r.bottom };
      })()`);
      const file = join(out, `recent-${width}-${scheme}.png`);
      writeFileSync(file, Buffer.from((await page.send('Page.captureScreenshot', { clip: { x: 0, y: 0, width, height: Math.min(height, Math.ceil(panel.bottom) + 24), scale: 1 } })).data, 'base64'));
      check(`${width} px ${scheme}: the recent list opens on screen, under a bar ${width > 720 ? 'of one row' : 'of two rows'}`, panel.bar < (width > 720 ? 50 : 90) && panel.rows > 0 && panel.left >= 0 && panel.right <= width && panel.bottom <= height, panel);
      console.log(`     ${file}`);
      await page.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
    }
  }
  await page.send('Emulation.clearDeviceMetricsOverride');
  await page.send('Emulation.setEmulatedMedia', { features: [] });
}
