import { type Doc, documentTitle, isEdited, pdfName, untitled } from './doc';
import { addImages, WorkerImages } from './docImages';
import { createEditor, jumpTo } from './editor';
import { download, droppedFile, openFile, saveFile } from './files';
import { IMAGE_TYPE_NAMES, IMAGE_TYPES, type ImagePath } from './images';
import { afterNextPaint, LatencyMeter } from './metrics';
import { registerServiceWorker } from './offline';
import { Pages } from './preview/pages';
import { type FromWorker, firstRev, nextRev, type Rev, type ToWorker } from './protocol';
import { keepDoc, keepImages, restoreDoc } from './restore';
import sample from './sample.md?raw';
import { defaultSettings, type PageSettings, parseSettings, sameSettings } from './settings';
import { SettingsMenu } from './settingsMenu';

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
const last = { bootMs: NaN, rev: null as Rev | null, convertMs: NaN, compileMs: NaN, rasterMs: NaN, redrawn: 0, pages: 0, failure: '', fileFailure: '' };
const ms = (n: number) => (Number.isNaN(n) ? '–' : n.toFixed(1));

/** Timings only while toggled on; the first diagnostic of a failed compile and a failed open or save always show. */
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
  for (const failure of [last.failure, last.fileFailure].filter(Boolean)) {
    lines.push(Object.assign(document.createElement('div'), { textContent: failure, className: 'failure' }));
  }
  overlay.replaceChildren(...lines);
  overlay.hidden = lines.length === 0;
}
drawOverlay();

const worker = new Worker(new URL('./worker/compiler.worker.ts', import.meta.url), { type: 'module' });
const send = (message: ToWorker) => worker.postMessage(message);
const workerImages = new WorkerImages((message, transfer) => worker.postMessage(message, transfer));
// Before the await below, so that nothing the worker sends while the last document is read goes unheard.
worker.onmessage = fromWorker;
worker.onerror = (e) => {
  last.failure = `Compiler failed to start: ${e.message}`;
  drawOverlay();
};

// Read while the compiler boots, so that restoring the last document does not hold up the first compile.
const restoring = restoreDoc().catch((error) => {
  last.fileFailure = `Could not restore the last document: ${message(error)}`;
  drawOverlay();
  return null;
});

const SETTINGS_KEY = 'liveprint.page';
let stored: string | null = null;
try {
  stored = localStorage.getItem(SETTINGS_KEY);
} catch {}
const settings = parseSettings(stored, defaultSettings(navigator.language));
send({ kind: 'settings', settings });
const menu = new SettingsMenu($('settings'), settings, (next) => {
  send({ kind: 'settings', settings: next });
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(next));
  } catch {}
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

const start: Doc = (await restoring) ?? untitled(sample);
performance.mark('liveprint:restored');
let file = start.file;
let images = start.images;

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
editor.dom.addEventListener('keydown', (e) => (inputStart = e.timeStamp), true);
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

// A write started as the page unloads can be aborted with it, so the copy is kept current all along instead: one
// write at a time, and the newest document written as soon as the last one ends.
let keeping = false;
let keepAgain = false;
function keep(): void {
  if (keeping) {
    keepAgain = true;
    return;
  }
  keeping = true;
  keepDoc({ text: editor.state.doc.toString(), file })
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
  keepImages(next).catch((error) => {
    last.fileFailure = `Could not keep the images of ${file.name} in this browser: ${message(error)}`;
    drawOverlay();
  });
  await workerImages.show(next);
}

async function openDoc(doc: Doc): Promise<void> {
  await setImages(doc.images);
  load(doc.text);
  file = doc.file;
  $('pages').scrollTop = 0;
  changed(doc.text);
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
    const saved = await saveFile(editor.state.doc.toString(), file, as);
    if (!saved) return;
    file = saved;
    showFile();
    keep();
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
    if (mayDiscard()) void fileAction('open the dropped file', async () => openDoc(await dropped));
    return;
  }
  const onEditor = e.target instanceof Node && editor.dom.contains(e.target);
  insertImages([...e.dataTransfer.files], onEditor ? editor.posAtCoords({ x: e.clientX, y: e.clientY }) : null);
});

const mac = /Mac|iPhone|iPad/.test(navigator.platform);
$('open').title = `Open (${mac ? '⌘O' : 'Ctrl+O'})`;
$('save').title = `Save (${mac ? '⌘S' : 'Ctrl+S'}). Shift-click or press ${mac ? '⇧⌘S' : 'Shift+Ctrl+S'} to save as`;
$('open').addEventListener('click', () => void open());
$('save').addEventListener('click', (e) => void save(e.shiftKey));

$('pages').addEventListener('click', (e) => {
  const point = pages.pointAt(e);
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
    case 'pages': {
      pages.show(data.sizes, data.bitmaps);
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
    case 'pdf':
      if (data.rev !== pdfRequest) break;
      pdfRequest = null;
      download(pdfName(file.name), new Blob([data.bytes], { type: 'application/pdf' }));
      break;
    case 'sourced':
      if (data.id === clicked && data.offset !== null) jumpTo(editor, data.offset);
      break;
    case 'located':
      if (data.id < spotShown) break;
      spotShown = data.id;
      pages.showSpot(data.spot);
      break;
  }
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
