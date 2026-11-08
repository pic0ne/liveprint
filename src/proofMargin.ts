import type { EditorView } from '@codemirror/view';

const SVG = 'http://www.w3.org/2000/svg';
/** How far the leader runs level out of the margin and into the page, in px, before and after its slant. */
const LEVEL = 12;
/** The mark this close to the margin's middle, in px, would sit on the resize grip. */
const NEAR_GRIP = 30;

/**
 * The divider as a proofreader's margin: the number of the cursor's line at the cursor's height, and a hairline from
 * it to the cursor's line on the page. Drawn from the layout as it stands, so the caller draws it after either pane
 * moves.
 */
export class ProofMargin {
  readonly #editor: EditorView;
  readonly #margin: HTMLElement;
  readonly #preview: HTMLElement;
  readonly #markedLine: () => HTMLElement | null;
  readonly #mark: HTMLElement;
  readonly #number: HTMLElement;
  readonly #svg: SVGSVGElement;
  readonly #leader: SVGPathElement;
  #frame = 0;

  /** `markedLine` gives the page's mark over the cursor's line, or null while the page has none. */
  constructor(editor: EditorView, margin: HTMLElement, preview: HTMLElement, markedLine: () => HTMLElement | null) {
    this.#editor = editor;
    this.#margin = margin;
    this.#preview = preview;
    this.#markedLine = markedLine;
    this.#mark = margin.appendChild(Object.assign(document.createElement('div'), { className: 'proof-mark', hidden: true }));
    this.#mark.setAttribute('aria-hidden', 'true');
    this.#mark.innerHTML = '<svg width="16" height="10" viewBox="0 0 16 10"><path d="M2 9 8 2l6 7" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/></svg>';
    this.#number = this.#mark.appendChild(document.createElement('span'));
    this.#svg = margin.parentElement!.appendChild(document.createElementNS(SVG, 'svg'));
    this.#svg.classList.add('proof-leader');
    this.#svg.setAttribute('aria-hidden', 'true');
    this.#leader = this.#svg.appendChild(document.createElementNS(SVG, 'path'));
    editor.scrollDOM.addEventListener('scroll', () => this.schedule(), { passive: true });
    editor.dom.addEventListener('focusin', () => this.schedule());
  }

  /** Draws in the next frame, at most once a frame. */
  schedule(): void {
    this.#frame ||= requestAnimationFrame(() => {
      this.#frame = 0;
      this.draw();
    });
  }

  /** Shown only while the editor has focus, as the page's own mark is. Reads all the layout it needs before writing. */
  draw(): void {
    if (!this.#editor.hasFocus) return;
    const head = this.#editor.state.selection.main.head;
    const caret = this.#editor.coordsAtPos(head);
    const pane = this.#editor.scrollDOM.getBoundingClientRect();
    const margin = this.#margin.getBoundingClientRect();
    const line = this.#markedLine()?.getBoundingClientRect();
    const preview = this.#preview.getBoundingClientRect();
    const origin = this.#svg.getBoundingClientRect();

    const y = caret && (caret.top + caret.bottom) / 2;
    const shown = y !== null && y >= pane.top && y <= pane.bottom && margin.width > 0;
    this.#mark.hidden = !shown;
    this.#margin.toggleAttribute('data-mark-near-grip', shown && Math.abs(y - (margin.top + margin.height / 2)) < NEAR_GRIP);
    if (!shown) return this.#leader.setAttribute('d', '');
    this.#mark.style.top = `${y - margin.top}px`;
    this.#number.textContent = String(this.#editor.state.doc.lineAt(head).number);
    if (!line || line.bottom < preview.top || line.bottom > preview.bottom) return this.#leader.setAttribute('d', '');
    const fromX = margin.right - origin.left;
    const toX = line.left - origin.left;
    // Half a pixel off the row, so the 1px line lands on one row of device pixels instead of blurring across two.
    const fromY = Math.round(y - origin.top) + 0.5;
    const toY = Math.round(line.bottom - origin.top) - 0.5;
    this.#leader.setAttribute('d', `M${fromX - LEVEL} ${fromY}H${fromX + LEVEL}L${toX - LEVEL} ${toY}H${toX}`);
  }
}
