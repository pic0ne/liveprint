// Two-way linking, end to end in headless Chrome against `vite preview` of dist/ (`npm run check:linking` builds it).
// For words sampled from every page of src/sample.md: (a) clicking the word in the preview puts the editor cursor
// inside it; (b) a cursor inside the word puts the preview's caret mark inside the word as printed. A word's box is
// found in the page's pixels, as the ink between the gaps that separate its run's words, so neither the source
// index nor its character measuring decides what counts as correct.
import { launch, sleep, until } from './cdp.mjs';

const WORDS_PER_PAGE = 4;
const DPR = 2;

const { url, page, evaluate, close } = await launch();
await page.send('Page.enable');
await page.send('Emulation.setDeviceMetricsOverride', { width: 1400, height: 900, deviceScaleFactor: DPR, mobile: false });
await page.send('Page.addScriptToEvaluateOnNewDocument', {
  source: `window.__located = 0;
    window.__sourced = [];
    window.Worker = class extends Worker {
      constructor(...args) {
        super(...args);
        window.__worker = this;
        let asked = 0;
        this.addEventListener('message', ({ data }) => {
          if (data.kind === 'located') __located++;
          if (data.kind === 'sourced') __sourced.push(performance.now() - asked);
        });
        const post = this.postMessage.bind(this);
        this.postMessage = (message) => {
          if (message.kind === 'source') asked = performance.now();
          post(message);
        };
      }
    };`,
});
await page.send('Page.navigate', { url });
await until('every page drawn', () => evaluate(`(() => { const c = [...document.querySelectorAll('#pages canvas')]; return c.length > 1 && c.every((x) => x.width > 0); })()`), 600);
await sleep(1000);

const ask = (message, reply) =>
  evaluate(`new Promise((resolve) => {
    const t0 = performance.now();
    const on = ({ data }) => {
      if (data.kind !== '${reply}' || data.id !== ${message.id}) return;
      __worker.removeEventListener('message', on);
      resolve({ ms: performance.now() - t0, data });
    };
    __worker.addEventListener('message', on);
    __worker.postMessage(${JSON.stringify(message)});
  })`);
const view = `document.querySelector('.cm-content').cmTile.view`;
const markdown = await evaluate(`${view}.state.doc.toString()`);
const { data: { pages } } = await ask({ kind: 'runs', id: 1e9 }, 'runs');

// Ink columns of each run's line band, in bitmap pixels: [start, end) spans with any dark pixel.
const ink = await evaluate(`(() => {
  const pages = ${JSON.stringify(pages.map(({ width, height, runs }) => ({ width, height, runs: runs.map(({ x, y, w, h }) => ({ x, y, w, h })) })))};
  return [...document.querySelectorAll('#pages canvas')].map((canvas, p) => {
    const ctx = Object.assign(document.createElement('canvas'), { width: canvas.width, height: canvas.height }).getContext('2d', { willReadFrequently: true });
    ctx.drawImage(canvas, 0, 0);
    const { width, height, runs } = pages[p];
    const s = canvas.width / width;
    return runs.map(({ x, y, w, h }) => {
      const [x0, x1, y0, y1] = [Math.floor(x * s), Math.ceil((x + w) * s), Math.floor(y * s), Math.ceil((y + h) * s)];
      const { data } = ctx.getImageData(x0, y0, x1 - x0, y1 - y0);
      const spans = [];
      for (let col = 0; col < x1 - x0; col++) {
        let dark = false;
        for (let row = 0; row < y1 - y0 && !dark; row++) {
          const i = (row * (x1 - x0) + col) * 4;
          dark = 0.3 * data[i] + 0.59 * data[i + 1] + 0.11 * data[i + 2] < 140;
        }
        const last = spans[spans.length - 1];
        if (dark && last && last[1] === x0 + col) last[1]++;
        else if (dark) spans.push([x0 + col, x0 + col + 1]);
      }
      return { scale: s, spans };
    });
  });
})()`);

/** Splits a run's ink at its widest gaps, one fewer than it has words; null when those gaps are not clearly wider than the rest. */
function wordBoxes(text, { spans }) {
  const words = [...text.matchAll(/\S+/g)].map((m) => ({ from: m.index, to: m.index + m[0].length }));
  if (words.length === 0 || spans.length < words.length) return null;
  const gaps = spans.slice(1).map((span, i) => ({ i, size: span[0] - spans[i][1] }));
  const cuts = [...gaps].sort((a, b) => b.size - a.size).slice(0, words.length - 1);
  const rest = gaps.filter((g) => !cuts.includes(g));
  if (cuts.length > 0 && rest.length > 0 && Math.min(...cuts.map((g) => g.size)) < 1.5 * Math.max(...rest.map((g) => g.size))) return null;
  const ends = cuts.map((g) => g.i).sort((a, b) => a - b);
  const boxes = [];
  let first = 0;
  for (const end of [...ends, spans.length - 1]) {
    boxes.push([spans[first][0], spans[end][1]]);
    first = end + 1;
  }
  return words.map((word, k) => ({ ...word, box: boxes[k] }));
}

const isWord = /[\p{L}\p{N}]/u;
const occurrences = (text, word) => [...text.matchAll(new RegExp(`(?<![\\p{L}\\p{N}])${word}(?![\\p{L}\\p{N}])`, 'gu'))].map((m) => m.index);
const fences = [...markdown.matchAll(/^```[^\n]*\n[^]*?^```/gm)].map((m) => [m.index, m.index + m[0].length]);
function kindAt(offset) {
  const lineStart = markdown.lastIndexOf('\n', offset - 1) + 1;
  const line = markdown.slice(lineStart, markdown.indexOf('\n', offset) >>> 0);
  if (fences.some(([a, b]) => offset > a && offset < b)) return 'code';
  if (line.startsWith('|')) return 'table cell';
  if (/^\s*([-*+]|\d+\.)\s/.test(line)) return 'list item';
  if (/\$[^$\n]+\$[\s,.;:]*$/.test(markdown.slice(lineStart, offset))) return 'after math';
  if (line.startsWith('#')) return 'heading';
  return 'text';
}

const allText = pages.flatMap((p) => p.runs.map((r) => r.text)).join('\n');
const candidates = [];
pages.forEach(({ height, runs }, p) =>
  runs.forEach((run, r) => {
    for (const word of wordBoxes(run.text, ink[p][r]) ?? []) {
      const text = run.text.slice(word.from, word.to).replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '');
      if (text.length < 3 || !isWord.test(text) || /[^\p{L}\p{N}]/u.test(text)) continue;
      const inMarkdown = occurrences(markdown, text);
      if (inMarkdown.length !== 1 || occurrences(allText, text).length !== 1) continue;
      candidates.push({ text, page: p, run, box: word.box, scale: ink[p][r].scale, from: inMarkdown[0], kind: kindAt(inMarkdown[0]), y: run.y / height });
    }
  }),
);

// A word right after inline math is rarely unique, so it is found by the two words that follow it instead.
for (const m of markdown.matchAll(/\$[^$\n]+\$[\s,.;:]*([\p{L}\p{N}]+)((?:\s+[\p{L}\p{N}]+){2})/dgu)) {
  const phrase = `${m[1]}${m[2].replace(/\s+/g, ' ')}`;
  const holders = pages.flatMap(({ height, runs }, p) => runs.flatMap((run, r) => occurrences(run.text, phrase).map((at) => ({ p, r, run, at, height }))));
  if (holders.length !== 1 || occurrences(markdown, phrase).length !== 1) continue;
  const { p, r, run, at, height } = holders[0];
  const word = wordBoxes(run.text, ink[p][r])?.find((w) => w.from === at);
  if (!word) continue;
  candidates.push({ text: m[1], page: p, run, box: word.box, scale: ink[p][r].scale, from: m.indices[1][0], kind: 'after math', y: run.y / height });
}

const picked = new Set();
for (const kind of ['table cell', 'code', 'list item', 'after math']) {
  const found = candidates.find((c) => c.kind === kind);
  if (found) picked.add(found);
}
for (let p = 0; p < pages.length; p++) {
  const onPage = candidates.filter((c) => c.page === p);
  for (let k = 0; k < WORDS_PER_PAGE && onPage.length > 0; k++) picked.add(onPage[Math.floor(((k + 0.5) * onPage.length) / WORDS_PER_PAGE)]);
}
const words = [...picked].sort((a, b) => a.from - b.from);

const canvasRect = (p) => evaluate(`(() => { const r = document.querySelectorAll('#pages canvas')[${p}].getBoundingClientRect(); return { left: r.left, top: r.top, width: r.width, height: r.height }; })()`);
const head = () => evaluate(`${view}.state.selection.main.head`);

const results = [];
for (const word of words) {
  const { page: p, run, box, scale, from, text } = word;
  const to = from + text.length;
  const bitmapWidth = pages[p].width * scale;
  const [boxLeft, boxRight] = [box[0] / bitmapWidth, box[1] / bitmapWidth];
  const midY = (run.y + run.h / 2) / pages[p].height;

  await evaluate(`(() => { const c = document.querySelectorAll('#pages canvas')[${p}]; const s = document.getElementById('pages'); s.scrollTop = c.offsetTop + ${midY} * c.offsetHeight - s.clientHeight / 2; })()`);
  await sleep(250);
  const rect = await canvasRect(p);
  const x = rect.left + ((boxLeft + boxRight) / 2) * rect.width;
  const y = rect.top + midY * rect.height;
  const before = await head();
  const t0 = performance.now();
  for (const type of ['mousePressed', 'mouseReleased']) await page.send('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1 });
  const clicked = await until('cursor moved', async () => {
    const h = await head();
    return h !== before || performance.now() - t0 > 2000 ? { h } : null;
  });
  const clickOk = clicked.h >= from && clicked.h <= to;

  const located = await evaluate('__located');
  const cursor = from + (text.length >> 1);
  await evaluate(`${view}.dispatch({ selection: { anchor: ${cursor} } })`);
  await until('cursor located', async () => (await evaluate('__located')) > located);
  await sleep(50);
  const mark = await evaluate(`(() => {
    const caret = document.querySelector('.cursor-caret').getBoundingClientRect();
    const r = document.querySelectorAll('#pages canvas')[${p}].getBoundingClientRect();
    return { hidden: document.querySelector('.cursor-mark').hidden, left: (caret.left - r.left) / r.width, right: (caret.right - r.left) / r.width, mid: (caret.top + caret.height / 2 - r.top) / r.height };
  })()`);
  const lineBand = [run.y / pages[p].height, (run.y + run.h) / pages[p].height];
  const caretOk = !mark.hidden && mark.left >= boxLeft && mark.right <= boxRight && mark.mid >= lineBand[0] && mark.mid <= lineBand[1];
  const pt = (fraction) => (fraction * pages[p].width).toFixed(1);
  results.push({
    word: text,
    page: p + 1,
    kind: word.kind,
    click: clickOk ? 'pass' : `FAIL ${JSON.stringify(markdown.slice(Math.max(0, clicked.h - 8), clicked.h))}|${JSON.stringify(markdown.slice(clicked.h, clicked.h + 8))}`,
    caret: caretOk ? 'pass' : `FAIL caret ${pt(mark.left)}-${pt(mark.right)} pt`,
    box: `${pt(boxLeft)}-${pt(boxRight)} pt`,
  });
}

// One keystroke's worth of index rebuild: an edit and a locate posted together, so the locate waits for the edit's visible pages.
const edited = markdown.replace('printed page', 'printed pages');
const timing = await evaluate(`new Promise((resolve) => {
  const t0 = performance.now();
  let drawn = 0;
  const on = ({ data }) => {
    if (data.kind === 'pages' && data.rev === 1e6 && !drawn) drawn = performance.now() - t0;
    if (data.kind === 'located' && data.id === 1e9 + 1) {
      __worker.removeEventListener('message', on);
      resolve({ drawn, located: performance.now() - t0 });
    }
  };
  __worker.addEventListener('message', on);
  __worker.postMessage({ kind: 'edit', rev: 1e6, markdown: ${JSON.stringify(edited)} });
  __worker.postMessage({ kind: 'locate', id: 1e9 + 1, offset: 5000 });
})`);
const sourcedMs = await evaluate('__sourced');
await close();

const columns = ['word', 'page', 'kind', 'box', 'click', 'caret'];
const width = Object.fromEntries(columns.map((c) => [c, Math.max(c.length, ...results.map((r) => String(r[c]).length))]));
const row = (r) => columns.map((c) => String(r[c]).padEnd(width[c])).join('  ');
console.log(row(Object.fromEntries(columns.map((c) => [c, c]))));
for (const r of results) console.log(row(r));
const failed = results.filter((r) => r.click !== 'pass' || r.caret !== 'pass');
const sorted = sourcedMs.sort((a, b) => a - b);
console.log(`\n${results.length} words on ${new Set(results.map((r) => r.page)).size} of ${pages.length} pages, from ${candidates.length} unambiguous candidates; ${failed.length} failed`);
console.log(`click to source offset: median ${sorted[sorted.length >> 1].toFixed(1)} ms, max ${sorted[sorted.length - 1].toFixed(1)} ms`);
console.log(`edit then locate: visible pages after ${timing.drawn.toFixed(1)} ms, located after ${timing.located.toFixed(1)} ms`);
const kinds = new Set(results.map((r) => r.kind));
const missing = ['table cell', 'code', 'list item', 'after math'].filter((k) => !kinds.has(k));
if (missing.length > 0) console.log(`no unambiguous word found of kind: ${missing.join(', ')}`);
process.exit(failed.length > 0 || missing.length > 0 || results.length < 20 ? 1 : 0);
