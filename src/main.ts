import { createEditor } from './editor';
import { afterNextPaint, LatencyMeter } from './metrics';
import { Preview } from './preview/preview';
import { type FromWorker, firstRev, nextRev, type Rev, type ToWorker } from './protocol';
import sample from './sample.md?raw';

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
const last = { bootMs: NaN, convertMs: NaN, compileMs: NaN, renderMs: NaN, pages: 0, failure: '' };
const ms = (n: number) => (Number.isNaN(n) ? '–' : n.toFixed(1));

/** Timings only while toggled on; the first diagnostic of a failed compile always shows. */
function drawOverlay(): void {
  const s = meter.stats();
  const stats = statsVisible
    ? [
        `keystroke → preview  ${ms(s.last)}  p50 ${ms(s.p50)}  p95 ${ms(s.p95)} ms  (${s.count})`,
        `convert ${ms(last.convertMs)}  compile ${ms(last.compileMs)}  render ${ms(last.renderMs)} ms`,
        `${last.pages} ${last.pages === 1 ? 'page' : 'pages'}, compiler ready in ${ms(last.bootMs)} ms`,
      ]
    : [];
  const lines = stats.map((text) => Object.assign(document.createElement('div'), { textContent: text }));
  if (last.failure) lines.push(Object.assign(document.createElement('div'), { textContent: last.failure, className: 'failure' }));
  overlay.replaceChildren(...lines);
  overlay.hidden = lines.length === 0;
}
drawOverlay();

const worker = new Worker(new URL('./worker/compiler.worker.ts', import.meta.url), { type: 'module' });
const send = (message: ToWorker) => worker.postMessage(message);
const previewReady = Preview.create($('pages'));

let rev: Rev = firstRev;
let pdfRequest: Rev | null = null;
// Start of the keystroke now being handled: keydown, or beforeinput for edits without one (paste, IME).
let inputStart: number | null = null;

const editor = createEditor($('editor'), sample, (markdown) => {
  rev = nextRev(rev);
  meter.input(rev, inputStart ?? performance.now());
  inputStart = null;
  send({ kind: 'edit', rev, markdown });
});
// Capture phase on the editor root runs before CodeMirror's own handlers apply the edit.
editor.dom.addEventListener('keydown', (e) => (inputStart = e.timeStamp), true);
editor.dom.addEventListener('beforeinput', (e) => (inputStart ??= e.timeStamp), true);
editor.dom.addEventListener('keyup', () => (inputStart = null), true);
send({ kind: 'edit', rev, markdown: sample });

function download(name: string, blob: Blob): void {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href));
}

$('download-md').addEventListener('click', () => {
  download('document.md', new Blob([editor.state.doc.toString()], { type: 'text/markdown' }));
});
$('download-pdf').addEventListener('click', () => {
  pdfRequest = rev;
  send({ kind: 'pdf', rev });
});

worker.onmessage = async ({ data }: MessageEvent<FromWorker>) => {
  switch (data.kind) {
    case 'ready':
      last.bootMs = data.bootMs;
      drawOverlay();
      break;
    case 'frame': {
      const preview = await previewReady;
      const t0 = performance.now();
      preview.apply(data.delta);
      Object.assign(last, {
        convertMs: data.convertMs,
        compileMs: data.compileMs,
        renderMs: performance.now() - t0,
        pages: preview.pageCount,
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
      download('document.pdf', new Blob([data.bytes], { type: 'application/pdf' }));
      break;
  }
};
worker.onerror = (e) => {
  last.failure = `Compiler failed to start: ${e.message}`;
  drawOverlay();
};
