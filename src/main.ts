import { convert } from './convert/toTypst';
import { type Doc, documentTitle, imageNotice, isEdited, noticeText, pdfName, untitled } from './doc';
import { addImages, WorkerImages } from './docImages';
import { createEditor, jumpTo, replaceText } from './editor';
import { chooseFolder, diskText, download, droppedFile, imagesAllowed, openFile, saveFile, watchFile } from './files';
import { IMAGE_TYPE_NAMES, IMAGE_TYPES, type ImagePath } from './images';
import { afterNextPaint, LatencyMeter } from './metrics';
import { registerServiceWorker } from './offline';
import { Pages } from './preview/pages';
import { type FromWorker, firstRev, nextRev, type Rev, type Start, type ToWorker } from './protocol';
import { claimDoc, keepDoc, keepImages } from './restore';
import sample from './sample.md?raw';
import { defaultSettings, type PageSettings, parseSettings, sameSettings } from './settings';
import { SettingsMenu } from './settingsMenu';
import { THEMES } from './typst/themes';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const SPLIT_KEY = 'liveprint.split';
const split = $('split');
const divider = $('divider');

const ratio = () => Number(split.style.getPropertyValue('--ratio')) || 0.5;

function setRatio(value: number): void {
  split.style.setProperty('--ratio', String(Math.min(0.8, Math.max(0.2, value))));
}

function saveRatio(): void {
  try {
    localStorage.setItem(SPLIT_KEY, String(ratio()));
  } catch {}
}

try {
  const stored = Number(localStorage.getItem(SPLIT_KEY));
  if (stored > 0) setRatio(stored);
} catch {}

divider.addEventListener('pointerdown', (down) => {
  divider.setPointerCapture(down.pointerId);
  const box = split.getBoundingClientRect();
  const move = (e: PointerEvent) => setRatio((e.clientX - box.left) / box.width);
  divider.addEventListener('pointermove', move);
  divider.addEventListener(
    'lostpointercapture',
    () => {
      divider.removeEventListener('pointermove', move);
      saveRatio();
    },
    { once: true },
  );
});
divider.addEventListener('keydown', (e) => {
  const step = { ArrowLeft: -0.02, ArrowRight: 0.02 }[e.key];
  if (step === undefined) return;
  e.preventDefault();
  setRatio(ratio() + step);
  saveRatio();
});

const overlay = $('overlay');
let statsVisible = import.meta.env.DEV;
window.addEventListener('keydown', (e) => {
  if (e.altKey && e.code === 'KeyD') {
    e.preventDefault();
    statsVisible = !statsVisible;
    drawOverlay();
  }
});

const meter = new LatencyMeter();
// Raster time and redrawn pages add up over every `pages` message of one rev.
const last = { bootMs: NaN, rev: null as Rev | null, convertMs: NaN, compileMs: NaN, rasterMs: NaN, redrawn: 0, pages: 0, math: '', failure: '', fontFailure: '', fileFailure: '' };
const ms = (n: number) => (Number.isNaN(n) ? '–' : n.toFixed(1));

/**
 * Timings only while toggled on. Why a formula shows as typed, the first diagnostic of a failed compile and a failed
 * open or save always show.
 */
function drawOverlay(): void {
  const s = meter.stats();
  const stats = statsVisible
    ? [
        `keystroke → preview  ${ms(s.last)}  p50 ${ms(s.p50)}  p95 ${ms(s.p95)} ms  (${s.count})`,
        `convert ${ms(last.convertMs)}  compile ${ms(last.compileMs)}  raster ${ms(last.rasterMs)} ms`,
        `${last.redrawn} of ${last.pages} ${last.pages === 1 ? 'page' : 'pages'} redrawn, compiler ready in ${ms(last.bootMs)} ms`,
      ]
    : [];
  const lines = stats.map((text) => Object.assign(document.createElement('div'), { textContent: text }));
  if (last.math) lines.push(Object.assign(document.createElement('div'), { textContent: last.math, className: 'notice' }));
  for (const failure of [last.failure, last.fontFailure, last.fileFailure].filter(Boolean)) {
    lines.push(Object.assign(document.createElement('div'), { textContent: failure, className: 'failure' }));
  }
  overlay.replaceChildren(...lines);
  overlay.hidden = lines.length === 0;
}
drawOverlay();

const worker = new Worker(new URL('./worker/compiler.worker.ts', import.meta.url), { type: 'module' });
worker.postMessage({ kind: 'start', publicUrl: new URL(import.meta.env.BASE_URL, document.baseURI).href } satisfies Start);
const send = (message: ToWorker) => worker.postMessage(message);
const workerImages = new WorkerImages((message, transfer) => worker.postMessage(message, transfer));
// Before the await below, so that nothing the worker sends while the last document is read goes unheard.
worker.onmessage = fromWorker;
worker.onerror = (e) => {
  last.failure = `Compiler failed to start: ${e.message}`;
  drawOverlay();
};

// Read while the compiler boots, so that restoring the last document does not hold up the first compile.
const restoring = claimDoc().catch((error) => {
  last.fileFailure = `Could not restore the last document: ${message(error)}`;
  drawOverlay();
  return null;
});

const SETTINGS_KEY = 'liveprint.page';
let stored: string | null = null;
try {
  stored = localStorage.getItem(SETTINGS_KEY);
} catch {}
/** The reader's choice, which the browser keeps, except a theme whose fonts failed: then the theme on screen. */
let settings = parseSettings(stored, defaultSettings(navigator.language));
function keepSettings(next: PageSettings): void {
  settings = next;
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(next));
  } catch {}
}
send({ kind: 'settings', settings });
const menu = new SettingsMenu($('settings'), settings, (next) => {
  // Choosing a theme, the failed one again included, answers a font failure.
  if (next.theme !== settings.theme) {
    last.fontFailure = '';
    drawOverlay();
  }
  keepSettings(next);
  send({ kind: 'settings', settings: next });
});
const pages = new Pages($('pages'), (view) => send({ kind: 'view', ...view }));

let rev: Rev = firstRev;
let pdfRequest: Rev | null = null;
// Start of the keystroke now being handled: keydown, or beforeinput for edits without one (paste, IME).
let inputStart: number | null = null;

// Ids for linking requests. Only the newest click is acted on, and a cursor spot never replaces a newer one.
let linkId = 0;
let clicked = 0;
let spotShown = 0;
let locateFrame = 0;
/** The newest document whose index the cursor spot was asked of. A new finished one re-asks, since its text moved. */
let located: { rev: Rev; settings: PageSettings } | null = null;

/** At most once a frame, asks where the editor's cursor renders. */
function locateCursor(): void {
  locateFrame ||= requestAnimationFrame(() => {
    locateFrame = 0;
    send({ kind: 'locate', id: ++linkId, offset: editor.state.selection.main.head });
  });
}

const claimed = await restoring;
/** A first visit shows the sample. A tab opened while every kept document is open in another starts empty. */
const start: Doc = claimed?.doc ?? untitled(claimed && !claimed.first ? '' : sample);
performance.mark('liveprint:restored');
let file = start.file;
let images = start.images;
/** The local images the newest compile's Markdown references, which the bar's notice counts. */
let referenced: readonly ImagePath[] = [];
/** Referenced images already looked for in the document's folder. */
let looked = new Set<ImagePath>();

const { view: editor, load } = createEditor(
  $('editor'),
  start.text,
  (markdown) => {
    changed(markdown);
    meter.input(rev, inputStart ?? performance.now());
    inputStart = null;
  },
  locateCursor,
  (files) => insertImages(files, null),
);
// Capture phase on the editor root runs before CodeMirror's own handlers apply the edit.
editor.dom.addEventListener(
  'keydown',
  (e) => {
    inputStart = e.timeStamp;
    pages.typing();
  },
  true,
);
editor.dom.addEventListener('focusout', () => pages.reading());
editor.dom.addEventListener('beforeinput', (e) => (inputStart ??= e.timeStamp), true);
editor.dom.addEventListener('keyup', () => (inputStart = null), true);
await workerImages.show(images);
send({ kind: 'edit', rev, markdown: start.text });

const fileName = $('file-name');
const editedMark = $('file-edited');
let shownFile = '';

function showFile(text = editor.state.doc.toString()): void {
  const edited = isEdited(text, file);
  const shown = `${edited} ${file.name}`;
  if (shown === shownFile) return;
  shownFile = shown;
  fileName.textContent = fileName.title = file.name;
  editedMark.hidden = !edited;
  document.title = documentTitle(file.name, edited);
}
showFile();

const notice = $('image-notice');
const noticeLine = $('image-notice-text');

function showNotice(): void {
  const text = noticeText(imageNotice(referenced, images, file), file.name);
  noticeLine.textContent = text;
  notice.hidden = text === '';
}

/**
 * A referenced image the document lacks is read from its folder when reading that is allowed already, once per
 * image, so that typing ![](plot.png) shows plot.png from beside the file.
 */
async function lookInFolder(): Promise<void> {
  const folder = file.folder;
  const wanted = referenced.filter((path) => !images.has(path) && !looked.has(path));
  if (!folder || wanted.length === 0) return;
  for (const path of wanted) looked.add(path);
  const found = await imagesAllowed(folder, wanted);
  if (found.size === 0 || file.folder !== folder) return;
  file = { ...file, savedImages: new Set([...file.savedImages, ...found.keys()]) };
  keep();
  await setImages(new Map([...images, ...found]));
}

// A write started as the page unloads can be aborted with it, so the copy is kept current all along instead: one
// write at a time, and the newest document written as soon as the last one ends.
let keeping = false;
let keepAgain = false;
function keep(): void {
  if (!claimed) return;
  if (keeping) {
    keepAgain = true;
    return;
  }
  keeping = true;
  keepDoc(claimed.id, { text: editor.state.doc.toString(), file })
    .catch((error) => {
      last.fileFailure = `Could not keep a copy of ${file.name} in this browser: ${message(error)}`;
      drawOverlay();
    })
    .finally(() => {
      keeping = false;
      if (keepAgain) {
        keepAgain = false;
        keep();
      }
    });
}
window.addEventListener('beforeunload', (e) => {
  if (isEdited(editor.state.doc.toString(), file)) e.preventDefault();
});

function changed(markdown: string): void {
  rev = nextRev(rev);
  send({ kind: 'edit', rev, markdown });
  showFile(markdown);
  keep();
}

/** The worker gets the images before any edit that references them. */
async function setImages(next: ReadonlyMap<ImagePath, Blob>): Promise<void> {
  images = next;
  showNotice();
  if (claimed) {
    keepImages(claimed.id, next).catch((error) => {
      last.fileFailure = `Could not keep the images of ${file.name} in this browser: ${message(error)}`;
      drawOverlay();
    });
  }
  await workerImages.show(next);
}

/**
 * Shows `doc` in the editor at once, so a key pressed while its images go to the worker types into it, not into the
 * document it replaced. The worker gets the editor's text once it has the images.
 */
async function openDoc(doc: Doc): Promise<void> {
  file = doc.file;
  showDiskChange(false);
  watchDisk();
  referenced = [];
  looked = new Set();
  const shown = setImages(doc.images);
  load(doc.text);
  $('pages').scrollTop = 0;
  showFile(doc.text);
  await shown;
  changed(editor.state.doc.toString());
}

/** Inserts `![](path)` for each image file at `at`, or over the selection. Other files are named in the failure line. */
function insertImages(files: File[], at: number | null): void {
  const refused = files.filter((f) => !IMAGE_TYPES.has(f.type)).map((f) => f.name);
  const names = (refused.length > 0 ? refused : files.map((f) => f.name)).join(', ');
  void fileAction(`insert ${names}`, async () => {
    const added = await addImages(files, images);
    if (added.paths.length > 0) {
      await setImages(added.images);
      const text = added.paths.map((path) => `![](${path})`).join(' ');
      const pos = at === null ? null : Math.min(at, editor.state.doc.length);
      const { from, to } = pos === null ? editor.state.selection.main : { from: pos, to: pos };
      editor.dispatch({ changes: { from, to, insert: text }, selection: { anchor: from + text.length }, scrollIntoView: true });
      editor.focus();
    }
    if (refused.length > 0) throw new Error(`liveprint shows ${IMAGE_TYPE_NAMES} images`);
  });
}

/**
 * The images the text references now. The newest compile's list can be a keystroke or a paste behind, and saving by
 * it would leave a just-pasted image off the disk while the text that names it is saved.
 */
const imagesIn = (text: string) => convert(text).images;

const mayDiscard = () => !isEdited(editor.state.doc.toString(), file) || confirm(`Discard unsaved changes to ${file.name}?`);

let busy = false;
/** One open or save at a time. A failure shows under the preview until the next attempt. */
async function fileAction(verb: string, action: () => Promise<void>): Promise<void> {
  if (busy) return;
  busy = true;
  last.fileFailure = '';
  try {
    await action();
  } catch (error) {
    last.fileFailure = `Could not ${verb}: ${message(error)}`;
  } finally {
    busy = false;
    drawOverlay();
  }
}

/** The picker comes before the question: it needs the click or key that asked for it, and a dialog can outlast that. */
const open = () =>
  fileAction('open the file', async () => {
    const doc = await openFile();
    if (doc && mayDiscard()) await openDoc(doc);
  });

const save = (as: boolean) =>
  fileAction(`save ${file.name}`, async () => {
    const text = editor.state.doc.toString();
    const overwrite = () => confirm(`${file.name} has changed on disk since it was opened. Overwrite it with the text here?`);
    const saved = await saveFile(text, file, images, imagesIn(text), as, overwrite);
    if (!saved) return void checkDisk();
    file = saved;
    showDiskChange(false);
    watchDisk();
    showFile();
    showNotice();
    keep();
  });

const diskNotice = $('disk-notice');
const showDiskChange = (changed: boolean) => (diskNotice.hidden = !changed);

/**
 * Compares the file on disk with the text last opened or saved there. When another program changed it, a clean
 * document takes the new text, as one change the reader can undo, and an edited one says so in the bar, where Reload
 * takes it. Asked when the tab comes back into view and when the browser reports a change to the file.
 */
async function checkDisk(): Promise<void> {
  const checked = file;
  const disk = await diskText(checked).catch(() => null);
  if (file !== checked || busy || disk === null) return;
  const changed = disk !== checked.saved;
  if (changed && !isEdited(editor.state.doc.toString(), checked)) reloadFrom(disk);
  else showDiskChange(changed);
}

function reloadFrom(text: string): void {
  file = { ...file, saved: text };
  showDiskChange(false);
  replaceText(editor, text);
  showFile();
  keep();
}

const reload = () =>
  fileAction(`reload ${file.name}`, async () => {
    const disk = await diskText(file);
    if (disk === null) throw new Error('liveprint cannot read it');
    reloadFrom(disk);
  });

let unwatch = () => {};
let watched: FileSystemFileHandle | null = null;
function watchDisk(): void {
  if (file.handle === watched) return;
  unwatch();
  watched = file.handle;
  unwatch = watched ? watchFile(watched, () => void checkDisk()) : () => {};
}
watchDisk();
window.addEventListener('focus', () => void checkDisk());
document.addEventListener('visibilitychange', () => document.visibilityState === 'visible' && void checkDisk());

const chooseImageFolder = () =>
  fileAction('read the folder', async () => {
    const chosen = await chooseFolder(file, images, imagesIn(editor.state.doc.toString()));
    if (!chosen) return;
    file = chosen.file;
    keep();
    await setImages(chosen.images);
  });

window.addEventListener('keydown', (e) => {
  if (!(e.ctrlKey || e.metaKey) || e.altKey) return;
  const key = e.key.toLowerCase();
  if (key === 'o' && !e.shiftKey) {
    e.preventDefault();
    void open();
  } else if (key === 's') {
    e.preventDefault();
    void save(e.shiftKey);
  }
});

// A Markdown file dropped anywhere opens, with the images dropped beside it. Images dropped on their own are inserted
// where they land in the editor, or at the cursor. Every file drop is cancelled, so the browser never navigates away.
window.addEventListener('dragover', (e) => {
  if (!e.dataTransfer?.types.includes('Files')) return;
  e.preventDefault();
  e.dataTransfer.dropEffect = 'copy';
});
window.addEventListener('drop', (e) => {
  if (!e.dataTransfer?.types.includes('Files')) return;
  e.preventDefault();
  const dropped = droppedFile(e.dataTransfer);
  if (dropped) {
    void fileAction('open the dropped file', async () => {
      const doc = await dropped;
      if (mayDiscard()) await openDoc(doc);
    });
    return;
  }
  const onEditor = e.target instanceof Node && editor.dom.contains(e.target);
  insertImages([...e.dataTransfer.files], onEditor ? editor.posAtCoords({ x: e.clientX, y: e.clientY }) : null);
});

const mac = /Mac|iPhone|iPad/.test(navigator.platform);
$('open').title = `Open (${mac ? '⌘O' : 'Ctrl+O'})`;
$('save').title = `Save (${mac ? '⌘S' : 'Ctrl+S'}). Shift-click or press ${mac ? '⇧⌘S' : 'Shift+Ctrl+S'} to save as`;
$('open').addEventListener('click', () => void open());
$('choose-folder').addEventListener('click', () => void chooseImageFolder());
$('reload').addEventListener('click', () => void reload());
$('save').addEventListener('click', (e) => void save(e.shiftKey));

// A click links to the editor. A drag or double click that selected text does not, so the selection stays.
$('pages').addEventListener('click', (e) => {
  const point = pages.selecting ? null : pages.pointAt(e);
  if (!point) return;
  clicked = ++linkId;
  send({ kind: 'source', id: clicked, ...point });
});

$('download-pdf').addEventListener('click', () => {
  pdfRequest = rev;
  send({ kind: 'pdf', rev });
});

function fromWorker({ data }: MessageEvent<FromWorker>): void {
  switch (data.kind) {
    case 'ready':
      last.bootMs = data.bootMs;
      drawOverlay();
      break;
    case 'loading':
      showLoading(data.loaded, data.total);
      break;
    case 'pages': {
      loading.remove();
      pages.show(data.sizes, data.bitmaps);
      if (data.final && data.rev === rev) {
        referenced = data.images;
        showNotice();
        void lookInFolder().catch(() => {});
      }
      registerServiceWorker();
      menu.showing(data.settings.theme);
      if (data.final && !(located?.rev === data.rev && sameSettings(located.settings, data.settings))) {
        located = { rev: data.rev, settings: data.settings };
        locateCursor();
      }
      const sameRev = data.rev === last.rev;
      Object.assign(last, {
        rev: data.rev,
        convertMs: data.convertMs,
        compileMs: data.compileMs,
        rasterMs: (sameRev ? last.rasterMs : 0) + data.rasterMs,
        redrawn: (sameRev ? last.redrawn : 0) + data.bitmaps.length,
        pages: data.sizes.length,
        math: mathNotice(data.mathErrors),
        failure: '',
      });
      afterNextPaint(() => {
        meter.painted(data.rev, performance.now());
        drawOverlay();
      });
      break;
    }
    case 'failed':
      if (data.rev === pdfRequest) pdfRequest = null;
      last.failure = data.diagnostics[0] ?? 'Compile failed';
      drawOverlay();
      break;
    case 'fontsFailed': {
      // The reader has moved on to another theme since.
      if (data.theme !== settings.theme) break;
      const name = THEMES[data.theme].label;
      last.fontFailure = `Could not download the ${name} fonts: ${data.message}. Choose ${name} again to retry.`;
      keepSettings({ ...settings, theme: data.showing });
      menu.select(settings);
      drawOverlay();
      break;
    }
    case 'pdf':
      if (data.rev !== pdfRequest) break;
      pdfRequest = null;
      download(pdfName(file.name), new Blob([data.bytes], { type: 'application/pdf' }));
      break;
    case 'sourced':
      if (data.id === clicked && data.offset !== null && !pages.selecting) jumpTo(editor, data.offset);
      break;
    case 'text':
      pages.showText(data.pages);
      break;
    case 'svgWanted':
      void workerImages.sharpen(data.path, data.longSide).catch(() => {});
      break;
    case 'located':
      if (data.id < spotShown) break;
      spotShown = data.id;
      pages.showSpot(data.spot);
      break;
  }
}

const loading = $('loading');
const mb = (bytes: number) => (bytes / 1e6).toFixed(1);
/** The first visit's download of the typesetter, which a fast connection finishes before it is worth showing. */
function showLoading(loaded: number, total: number | null): void {
  if (!loading.isConnected || performance.now() < 400) return;
  loading.textContent = `Downloading the typesetter, ${mb(loaded)}${total ? ` of ${mb(total)}` : ''} MB`;
  loading.hidden = false;
}

function mathNotice(errors: string[]): string {
  if (errors.length === 0) return '';
  return errors.length === 1 ? `A formula shows as typed: ${errors[0]}` : `${errors.length} formulas show as typed. The first: ${errors[0]}`;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
