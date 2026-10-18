import type { LayerRun, TextPage } from '../protocol';

// Transparent text laid over each page's canvas, so the reader can select, copy and find the printed text. A run is
// set in the font the worker fitted it to, kerned as typst kerns it, with its justification slack on the spaces, so
// its characters fall where they print and the selection covers what the reader sees.

/** The text layer's own fallback, which the worker's fit assumes when it measured a run in no face. */
const FALLBACK = 'fonts/DejaVuSansMono.ttf';

const families = new Map<string, string>();
const runOf = new WeakMap<Node, LayerRun>();

/** The CSS family of a font file, added to the document the first time a run asks for it. */
function family(face: string | null): string {
  const path = face ?? FALLBACK;
  let name = families.get(path);
  if (!name) {
    name = `liveprint-layer-${families.size}`;
    families.set(path, name);
    const font = new FontFace(name, `url("${import.meta.env.BASE_URL}${path}")`);
    document.fonts.add(font);
    font.load().catch(() => {});
  }
  return name;
}

/** Positions in page fractions, and sizes in the layer's width, so the layer scales with the page. */
export function fillLayer(layer: HTMLElement, { width, height, runs }: TextPage): void {
  const cqw = (pt: number) => `${(pt / width) * 100}cqw`;
  layer.replaceChildren(
    ...runs.map((run) => {
      const span = document.createElement('span');
      span.textContent = run.text;
      const style = [`left:${(run.x / width) * 100}%`, `top:${(run.y / height) * 100}%`, `font-size:${cqw(run.h)}`, `font-family:"${family(run.face)}"`];
      if (run.spacing !== 0) style.push(`word-spacing:${cqw(run.spacing)}`);
      if (run.scale !== 1) style.push(`transform:scaleX(${run.scale})`);
      span.style.cssText = style.join(';');
      runOf.set(span, run);
      return span;
    }),
    // Behind the runs, so a drag between two lines is over it rather than over the layer, whose position Chrome
    // can take for the drag's start: the selection then follows the pointer instead of growing.
    Object.assign(document.createElement('div'), { className: 'text-end' }),
  );
}

/** A run continues the line of the one before when they overlap vertically and it does not step back left. */
const sameLine = (a: LayerRun, b: LayerRun) => Math.min(a.y + a.h, b.y + b.h) > Math.max(a.y, b.y) && b.x >= a.x + a.w - 1;

/**
 * The selected text inside `root`'s layers, with a line break between printed lines and one space between runs that
 * a gap separates on one line. Null when the selection is not inside them.
 */
export function selectedText(selection: Selection, root: HTMLElement): string | null {
  if (selection.isCollapsed || !root.contains(selection.anchorNode) || !root.contains(selection.focusNode)) return null;
  const range = selection.getRangeAt(0);
  let text = '';
  let previous: { run: LayerRun; layer: Node } | null = null;
  for (const span of root.querySelectorAll<HTMLElement>('.text-layer span')) {
    const run = runOf.get(span);
    if (!run || !range.intersectsNode(span)) continue;
    const part = document.createRange();
    part.selectNodeContents(span);
    if (range.compareBoundaryPoints(Range.START_TO_START, part) > 0) part.setStart(range.startContainer, range.startOffset);
    if (range.compareBoundaryPoints(Range.END_TO_END, part) < 0) part.setEnd(range.endContainer, range.endOffset);
    if (part.collapsed) continue;
    const piece = part.toString();
    if (previous) {
      if (previous.layer !== span.parentNode || !sameLine(previous.run, run)) text = `${text.trimEnd()}\n`;
      else if (run.x - (previous.run.x + previous.run.w) > run.h * 0.1 && !/\s$/.test(text) && !/^\s/.test(piece)) text += ' ';
    }
    text += piece;
    previous = { run, layer: span.parentNode! };
  }
  return text.trimEnd();
}
