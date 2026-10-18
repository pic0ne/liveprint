// Two-way linking, end to end in headless Chrome against `vite preview` of dist/ (`npm run check:linking` builds it).
// For words sampled from every page of src/sample.md: (a) clicking the word in the preview puts the editor cursor
// inside it; (b) a cursor inside the word puts the preview's caret mark inside the word as printed; (c) a double
// click on the word selects it in the preview's text layer, and the selection covers its ink (except an italic word
// in Paper, whose face Chrome cannot load, where only the selected text is checked). A word's box is found in the
// page's pixels, as the ink between the gaps that separate its run's words, so neither the source index nor its
// character measuring decides what counts as correct. A formula mitex rejects is added to the first paragraph, and
// a word of its LaTeX, shown as typed, is sampled too, as are words of a front matter title and author. Then (d) a click on each symbol of a formula puts the cursor
// in that symbol's LaTeX, and (e) a drag across two lines selects and copies the text between.
// node bench/check-linking.mjs [--theme book] sets A4, normal margins and the theme with the message the UI sends.
import { parseArgs } from 'node:util';
import { launch, sleep, until } from './cdp.mjs';

const WORDS_PER_PAGE = 4;
const DPR = 2;
const { values: args } = parseArgs({ options: { theme: { type: 'string', default: 'book' }, verbose: { type: 'boolean', default: false } } });
const settings = { paper: 'a4', margins: 'normal', theme: args.theme };

const { url, page, evaluate, close } = await launch();
await page.send('Page.enable');
await page.send('Emulation.setDeviceMetricsOverride', { width: 1400, height: 900, deviceScaleFactor: DPR, mobile: false });
await page.send('Page.addScriptToEvaluateOnNewDocument', {
  source: `window.__located = 0;
    window.__sourced = [];
    window.__shown = null;
    window.Worker = class extends Worker {
      constructor(...args) {
        super(...args);
        window.__worker = this;
        let asked = 0;
        this.addEventListener('message', ({ data }) => {
          if (data.kind === 'located') __located++;
          if (data.kind === 'sourced') __sourced.push(performance.now() - asked);
          if (data.kind === 'pages') __shown = { ...data.settings, final: data.final };
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
await evaluate(`__worker.postMessage(${JSON.stringify({ kind: 'settings', settings })})`);
await until(`every page drawn in ${args.theme}`, () =>
  evaluate(`__shown?.final && ${JSON.stringify(Object.entries(settings))}.every(([key, value]) => __shown[key] === value)`),
);
const view = `document.querySelector('.cm-content').cmTile.view`;
const TYPED = '$\\foo zeugma$';
// Its own paragraph, so it prints on a line of its own, and quads part its symbols into clusters of ink.
const FORMULA = '$a \\quad \\beta \\quad \\sin \\quad 7 \\quad \\mathbb{R}$';
const SYMBOLS = ['a', '\\beta', '\\sin', '7', '\\mathbb{R}'];
// Front matter with words found nowhere else, so its title and authors are sampled.
const FRONT = '---\ntitle: Quillwort almanac\nauthor: [Ottoline Vexby, Barnaby Quist]\ndate: 2026-10-18\n---\n\n';
await evaluate(`(() => {
  __shown = null;
  const v = ${view};
  v.dispatch({ changes: [{ from: 0, insert: ${JSON.stringify(FRONT)} }, { from: v.state.doc.line(3).to, insert: ${JSON.stringify(` A formula being typed, ${TYPED}, shows as typed.\n\n${FORMULA}`)} }] });
})()`);
await until('the typed formula drawn', () => evaluate('__shown?.final'));
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
// A word printed from LaTeX, such as \exp, is not sampled: the formula check below clicks symbols of a formula.
const maths = [...markdown.matchAll(/\$\$[^]*?\$\$|\$[^$\n]+\$/g)].map((m) => [m.index, m.index + m[0].length]);
const typed = [markdown.indexOf(TYPED), markdown.indexOf(TYPED) + TYPED.length];
const emphasis = [...markdown.matchAll(/(?<![*_\w])([*_])(?![*_\s])[^*_\n]+?\1(?![*_\w])/g)].map((m) => [m.index, m.index + m[0].length]);
// Chrome cannot load New Computer Modern's italic, so in Paper an italic word is measured in the regular face.
const italicUnmeasured = (offset) => args.theme === 'paper' && emphasis.some(([a, b]) => offset > a && offset < b);
function kindAt(offset) {
  if (offset > typed[0] && offset < typed[1]) return 'typed math';
  const lineStart = markdown.lastIndexOf('\n', offset - 1) + 1;
  const line = markdown.slice(lineStart, markdown.indexOf('\n', offset) >>> 0);
  if (offset < FRONT.length) return /^\w+/.exec(line)[0];
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
      const token = run.text.slice(word.from, word.to);
      const text = token.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '');
      if (text.length < 3 || !isWord.test(text) || /[^\p{L}\p{N}]/u.test(text)) continue;
      const inMarkdown = occurrences(markdown, text);
      if (inMarkdown.length !== 1 || occurrences(allText, text).length !== 1) continue;
      const kind = kindAt(inMarkdown[0]);
      if (kind !== 'typed math' && maths.some(([from, to]) => inMarkdown[0] > from && inMarkdown[0] < to)) continue;
      // The ink box spans the whole token, so an edge where punctuation was stripped is not where the word ends.
      const edges = { left: /^[\p{L}\p{N}]/u.test(token), right: /[\p{L}\p{N}]$/u.test(token) };
      candidates.push({ text, page: p, run, box: word.box, edges, scale: ink[p][r].scale, from: inMarkdown[0], kind, y: run.y / height });
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
  candidates.push({ text: m[1], page: p, run, box: word.box, edges: { left: true, right: true }, scale: ink[p][r].scale, from: m.indices[1][0], kind: 'after math', y: run.y / height });
}

const picked = new Set();
const KINDS = ['title', 'author', 'table cell', 'code', 'list item', 'after math', 'typed math'];
for (const kind of KINDS) {
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

  await evaluate(`(() => { const c = document.querySelectorAll('#pages .page')[${p}]; const s = document.getElementById('pages'); s.scrollTop = c.offsetTop + ${midY} * c.offsetHeight - s.clientHeight / 2; })()`);
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

  // A double click selects the word in the text layer, and the selection covers its ink.
  for (const clickCount of [1, 2]) {
    for (const type of ['mousePressed', 'mouseReleased']) await page.send('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount });
  }
  await sleep(100);
  const selected = await evaluate(`(() => {
    const s = getSelection();
    const r = s.rangeCount ? s.getRangeAt(0).getBoundingClientRect() : null;
    const page = document.querySelectorAll('#pages .page')[${p}].getBoundingClientRect();
    const span = s.anchorNode?.parentElement;
    return { text: s.toString(), left: r && (r.left - page.left) / page.width, right: r && (r.right - page.left) / page.width, span: span && [span.getAttribute('style'), span.textContent] };
  })()`);
  const slack = (0.3 * run.h) / pages[p].width;
  const selectedWord = selected.text.trim().replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '');
  const selectOk =
    selectedWord === text && (!word.edges.left || Math.abs(selected.left - boxLeft) <= slack) && (!word.edges.right || Math.abs(selected.right - boxRight) <= slack);
  const selectNote = selectOk ? 'pass' : selectedWord === text && italicUnmeasured(from) ? 'italic, not measured' : null;
  await evaluate('getSelection().removeAllRanges()');

  const pt = (fraction) => (fraction * pages[p].width).toFixed(1);
  results.push({
    word: text,
    page: p + 1,
    kind: word.kind,
    click: clickOk ? 'pass' : `FAIL ${JSON.stringify(markdown.slice(Math.max(0, clicked.h - 8), clicked.h))}|${JSON.stringify(markdown.slice(clicked.h, clicked.h + 8))}`,
    caret: caretOk ? 'pass' : `FAIL caret ${pt(mark.left)}-${pt(mark.right)} pt`,
    select: selectNote ?? `FAIL ${JSON.stringify(selected.text)} ${pt(selected.left)}-${pt(selected.right)} pt${args.verbose ? ` in ${JSON.stringify(selected.span)}` : ''}`,
    box: `${pt(boxLeft)}-${pt(boxRight)} pt`,
  });
}

// A click on each symbol of FORMULA puts the cursor in that symbol's LaTeX. The symbols are found as clusters of ink
// on the formula's line, which is the run that prints its beta.
const formulaAt = markdown.indexOf(FORMULA);
const symbolRanges = [];
for (let at = formulaAt, k = 0; k < SYMBOLS.length; k++) {
  const from = markdown.indexOf(SYMBOLS[k], at);
  symbolRanges.push([from, from + SYMBOLS[k].length]);
  at = from + SYMBOLS[k].length;
}
const formulaPage = pages.findIndex((p) => p.runs.some((r) => r.text.normalize('NFKD').includes('β')));
const formulaRun = pages[formulaPage]?.runs.find((r) => r.text.normalize('NFKD').includes('β'));
const formulaResults = [];
if (formulaRun) {
  const p = formulaPage;
  await evaluate(`(() => { const c = document.querySelectorAll('#pages .page')[${p}]; const s = document.getElementById('pages'); s.scrollTop = c.offsetTop + ${formulaRun.y / pages[p].height} * c.offsetHeight - s.clientHeight / 2; })()`);
  await sleep(250);
  const clusters = await evaluate(`(() => {
    const canvas = document.querySelectorAll('#pages canvas')[${p}];
    const ctx = Object.assign(document.createElement('canvas'), { width: canvas.width, height: canvas.height }).getContext('2d', { willReadFrequently: true });
    ctx.drawImage(canvas, 0, 0);
    const s = canvas.width / ${pages[p].width};
    const [y0, y1] = [Math.floor(${formulaRun.y + formulaRun.h * 0.15} * s), Math.ceil(${formulaRun.y + formulaRun.h * 0.85} * s)];
    const { data } = ctx.getImageData(0, y0, canvas.width, y1 - y0);
    const spans = [];
    for (let col = 0; col < canvas.width; col++) {
      let dark = false;
      for (let row = 0; row < y1 - y0 && !dark; row++) {
        const i = (row * canvas.width + col) * 4;
        dark = 0.3 * data[i] + 0.59 * data[i + 1] + 0.11 * data[i + 2] < 140;
      }
      const last = spans[spans.length - 1];
      if (dark && last && col - last[1] < ${formulaRun.h * 0.4} * s) last[1] = col + 1;
      else if (dark) spans.push([col, col + 1]);
    }
    return spans.map(([a, b]) => (a + b) / 2 / canvas.width);
  })()`);
  const rect = await canvasRect(p);
  const y = rect.top + ((formulaRun.y + formulaRun.h / 2) / pages[p].height) * rect.height;
  for (const [k, centre] of clusters.entries()) {
    const before = await head();
    const t0 = performance.now();
    for (const type of ['mousePressed', 'mouseReleased']) await page.send('Input.dispatchMouseEvent', { type, x: rect.left + centre * rect.width, y, button: 'left', clickCount: 1 });
    const { h } = await until('cursor moved', async () => {
      const h = await head();
      return h !== before || performance.now() - t0 > 1000 ? { h } : null;
    });
    const [from, to] = symbolRanges[k] ?? [NaN, NaN];
    formulaResults.push({ symbol: SYMBOLS[k] ?? '?', ok: h >= from && h <= to, at: markdown.slice(h - 4, h) + '|' + markdown.slice(h, h + 4) });
    await evaluate(`${view}.dispatch({ selection: { anchor: 0 } })`);
  }
}
const formulaOk = formulaResults.length === SYMBOLS.length && formulaResults.every((r) => r.ok);

// A drag from one word to a word on a later line of the same page selects the text between, and copying it gives
// the printed text with a line break where the line ends.
const [from, to] = (() => {
  for (const a of words) {
    const plain = (w) => w.kind === 'text' || w.kind === 'list item' || w.kind === 'after math';
    const b = words.find((w) => w.page === a.page && w.run.y > a.run.y + a.run.h && w.run.y < a.run.y + 8 * a.run.h && plain(w) && plain(a));
    if (b) return [a, b];
  }
  return [];
})();
let dragged = { ok: false, text: 'no two words on nearby lines' };
if (from && to) {
  const p = from.page;
  await evaluate(`(() => { const c = document.querySelectorAll('#pages .page')[${p}]; const s = document.getElementById('pages'); s.scrollTop = c.offsetTop + ${from.run.y / pages[p].height} * c.offsetHeight - s.clientHeight / 3; })()`);
  await sleep(250);
  const rect = await canvasRect(p);
  const at = (word, edge) => ({
    x: rect.left + ((word.box[edge] + (edge === 0 ? 1 : -1)) / (pages[p].width * word.scale)) * rect.width,
    y: rect.top + ((word.run.y + word.run.h / 2) / pages[p].height) * rect.height,
  });
  const start = at(from, 0);
  const end = at(to, 1);
  await page.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...start, button: 'left', clickCount: 1 });
  for (let i = 1; i <= 8; i++) {
    await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: start.x + ((end.x - start.x) * i) / 8, y: start.y + ((end.y - start.y) * i) / 8, button: 'left', buttons: 1 });
  }
  await page.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...end, button: 'left', clickCount: 1 });
  await sleep(300);
  const copied = await evaluate(`new Promise((resolve) => {
    window.addEventListener('copy', (e) => resolve({ text: e.clipboardData.getData('text/plain'), headBefore: ${view}.state.selection.main.head }), { once: true });
    document.execCommand('copy');
  })`);
  const bare = copied.text.replace(/[^\p{L}\p{N}]+$/u, '');
  dragged = { ok: copied.text.startsWith(from.text) && bare.endsWith(to.text) && copied.text.includes('\n') && !/\n\n| \n|  /.test(copied.text), text: copied.text };
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
// The editor sets the front matter's marks and keys in the muted colour of other Markdown syntax, and its values in ink.
const colours = await evaluate(`(() => {
  const colour = (text, exact = true) => {
    const walker = document.createTreeWalker(document.querySelector('.cm-content'), NodeFilter.SHOW_TEXT);
    for (let node; (node = walker.nextNode()); ) {
      if (exact ? node.textContent === text : node.textContent.includes(text)) return getComputedStyle(node.parentElement).color;
    }
    return null;
  };
  const probe = (name) => {
    const span = Object.assign(document.createElement('span'), { style: \`color: var(--\${name})\` });
    document.querySelector('.cm-content').append(span);
    const value = getComputedStyle(span).color;
    span.remove();
    return value;
  };
  return { key: colour('title'), mark: colour('---'), value: colour('Quillwort almanac', false), muted: probe('muted'), ink: probe('ink') };
})()`);
const highlightOk = colours.key === colours.muted && colours.mark === colours.muted && colours.value === colours.ink && colours.muted !== colours.ink;
const sourcedMs = await evaluate('__sourced');
await close();

const columns = ['word', 'page', 'kind', 'box', 'click', 'caret', 'select'];
const width = Object.fromEntries(columns.map((c) => [c, Math.max(c.length, ...results.map((r) => String(r[c]).length))]));
const row = (r) => columns.map((c) => String(r[c]).padEnd(width[c])).join('  ');
console.log(`${args.theme}, A4, normal margins\n`);
console.log(row(Object.fromEntries(columns.map((c) => [c, c]))));
for (const r of results) console.log(row(r));
const failed = results.filter((r) => r.click !== 'pass' || r.caret !== 'pass' || r.select.startsWith('FAIL'));
const sorted = sourcedMs.sort((a, b) => a - b);
console.log(`\n${results.length} words on ${new Set(results.map((r) => r.page)).size} of ${pages.length} pages, from ${candidates.length} unambiguous candidates; ${failed.length} failed`);
console.log(`clicks on the symbols of ${FORMULA}: ${formulaOk ? 'pass' : 'FAIL'} ${formulaResults.map((r) => `${r.symbol} ${r.ok ? 'ok' : `at ${JSON.stringify(r.at)}`}`).join(', ') || 'no formula line found'}`);
console.log(`drag from ${JSON.stringify(from?.text)} to ${JSON.stringify(to?.text)} and copy: ${dragged.ok ? 'pass' : 'FAIL'} ${JSON.stringify(dragged.text)}`);
console.log(`front matter in the editor: ${highlightOk ? 'pass' : 'FAIL'} ${JSON.stringify(colours)}`);
console.log(`click to source offset: median ${sorted[sorted.length >> 1].toFixed(1)} ms, max ${sorted[sorted.length - 1].toFixed(1)} ms`);
console.log(`edit then locate: visible pages after ${timing.drawn.toFixed(1)} ms, located after ${timing.located.toFixed(1)} ms`);
const kinds = new Set(results.map((r) => r.kind));
const missing = KINDS.filter((k) => !kinds.has(k));
if (missing.length > 0) console.log(`no unambiguous word found of kind: ${missing.join(', ')}`);
process.exit(failed.length > 0 || missing.length > 0 || results.length < 20 || !dragged.ok || !formulaOk || !highlightOk ? 1 : 0);
