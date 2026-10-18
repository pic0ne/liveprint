import type { Spot } from '../linking/sourceIndex';
import type { PageBitmap, PageRange, PageSize, TextPage, View } from '../protocol';
import { fillLayer, selectedText } from './textLayer';

/** A reader's own scroll holds off following the cursor for this long. */
const HANDS_OFF_MS = 1000;
/** The band reaches this share of the font size above and below the text, so it covers the line, not just the letters. */
const BAND_BLEED = 0.15;

const percent = (fraction: number) => `${fraction * 100}%`;

interface PageView {
  root: HTMLElement;
  canvas: HTMLCanvasElement;
  /** The page's text, transparent over the canvas, for selecting and copying. */
  text: HTMLElement;
}

/**
 * One canvas per page inside the scroller, with the page's text laid over it. A page keeps its bitmap until a new
 * one arrives, and pages not drawn yet reserve their space, so the preview never blanks and scrolling stays put.
 * Reports the View whenever the pane's width, the display density, or the pages in sight change. Marks where the
 * editor's cursor renders.
 */
export class Pages {
  readonly #scroller: HTMLElement;
  readonly #onView: (view: View) => void;
  readonly #pages: PageView[] = [];
  readonly #mark: HTMLElement;
  #spot: Spot | null = null;
  /** The spot changed since the last frame, so the preview may need to scroll to it. */
  #follow = false;
  #handsOffUntil = 0;
  #reported = '';
  #frame = 0;
  /** Text waiting for its page's layer, by page, while the layers are hidden. */
  readonly #pendingText = new Map<number, TextPage>();

  constructor(scroller: HTMLElement, onView: (view: View) => void) {
    this.#scroller = scroller;
    this.#onView = onView;
    this.#mark = scroller.appendChild(Object.assign(document.createElement('div'), { className: 'cursor-mark', hidden: true }));
    this.#mark.append(
      Object.assign(document.createElement('div'), { className: 'cursor-line' }),
      Object.assign(document.createElement('div'), { className: 'cursor-caret' }),
    );
    this.#report();
    new ResizeObserver(() => this.#schedule()).observe(scroller);
    scroller.addEventListener('scroll', () => this.#schedule(), { passive: true });
    for (const type of ['wheel', 'touchmove', 'pointerdown', 'keydown']) {
      scroller.addEventListener(type, () => (this.#handsOffUntil = performance.now() + HANDS_OFF_MS), { passive: true });
    }
    // Pointer events come before the press that starts a selection, so the layers are there to select in.
    for (const type of ['pointermove', 'pointerdown']) scroller.addEventListener(type, () => this.reading());
    document.addEventListener('copy', (e) => {
      const text = selectedText(getSelection()!, scroller);
      if (text === null || !e.clipboardData) return;
      e.clipboardData.setData('text/plain', text);
      e.preventDefault();
    });
  }

  /** Whether the reader has selected text in the preview. */
  get selecting(): boolean {
    const selection = getSelection();
    return !!selection && !selection.isCollapsed && this.#scroller.contains(selection.anchorNode);
  }

  /** Sets the text of the pages that changed, at once while the layers show, or else when they next show. */
  showText(pages: TextPage[]): void {
    for (const page of pages) this.#pendingText.set(page.index, page);
    if (this.#scroller.classList.contains('reading')) this.#fillLayers();
  }

  /** Shows the text layers, for selecting, copying and finding. */
  reading(): void {
    if (this.#scroller.classList.contains('reading')) return;
    this.#fillLayers();
    this.#scroller.classList.add('reading');
  }

  /** Hides the text layers while the reader types, unless they have text selected in them. */
  typing(): void {
    if (!this.selecting) this.#scroller.classList.remove('reading');
  }

  #fillLayers(): void {
    for (const [index, page] of this.#pendingText) {
      const view = this.#pages[index];
      if (view) fillLayer(view.text, page);
    }
    this.#pendingText.clear();
  }

  /**
   * Marks where the editor's cursor renders, or nothing for null. If that line is out of sight, scrolls it to a
   * third from the top, unless the reader scrolled the preview in the last second. Both happen in the next frame,
   * with the layout that frame computes anyway.
   */
  showSpot(spot: Spot | null): void {
    this.#spot = spot;
    this.#follow = spot !== null;
    this.#schedule();
  }

  #reveal(): void {
    const spot = this.#spot;
    const root = spot && this.#pages[spot.page]?.root;
    if (!root || performance.now() < this.#handsOffUntil) return;
    const top = root.offsetTop + spot.y * root.offsetHeight;
    const bottom = top + spot.h * root.offsetHeight;
    const { scrollTop, clientHeight } = this.#scroller;
    if (top >= scrollTop && bottom <= scrollTop + clientHeight) return;
    const smooth = !matchMedia('(prefers-reduced-motion: reduce)').matches;
    this.#scroller.scrollTo({ top: top - clientHeight / 3, behavior: smooth ? 'smooth' : 'instant' });
  }

  /** In page fractions inside a box laid over the page's canvas, so only that box moves when the pane resizes. */
  #placeMark(): void {
    const spot = this.#spot;
    const root = spot && this.#pages[spot.page]?.root;
    this.#mark.hidden = !root;
    if (!root) return;
    Object.assign(this.#mark.style, {
      left: `${root.offsetLeft}px`,
      top: `${root.offsetTop}px`,
      width: `${root.offsetWidth}px`,
      height: `${root.offsetHeight}px`,
    });
    const [band, caret] = this.#mark.children as unknown as [HTMLElement, HTMLElement];
    caret.hidden = spot.kind === 'image';
    if (spot.kind === 'image') {
      Object.assign(band.style, { left: percent(spot.x), width: percent(spot.w), top: percent(spot.y), height: percent(spot.h) });
      return;
    }
    const vertical = { top: percent(spot.y - spot.h * BAND_BLEED), height: percent(spot.h * (1 + 2 * BAND_BLEED)) };
    Object.assign(band.style, { left: percent(spot.lineLeft), width: percent(spot.lineRight - spot.lineLeft), ...vertical });
    Object.assign(caret.style, { left: percent(spot.x), ...vertical });
  }

  /** The page under a click, and where on it in fractions of its width and height. */
  pointAt(event: MouseEvent): { page: number; fx: number; fy: number } | null {
    const root = event.target instanceof Element ? event.target.closest('.page') : null;
    const page = this.#pages.findIndex((view) => view.root === root);
    if (page < 0) return null;
    const box = this.#pages[page]!.root.getBoundingClientRect();
    return { page, fx: (event.clientX - box.left) / box.width, fy: (event.clientY - box.top) / box.height };
  }

  show(sizes: PageSize[], bitmaps: PageBitmap[]): void {
    while (this.#pages.length < sizes.length) {
      const root = this.#scroller.appendChild(Object.assign(document.createElement('div'), { className: 'page' }));
      const canvas = root.appendChild(document.createElement('canvas'));
      const text = root.appendChild(Object.assign(document.createElement('div'), { className: 'text-layer' }));
      this.#pages.push({ root, canvas, text });
    }
    for (const extra of this.#pages.splice(sizes.length)) extra.root.remove();
    sizes.forEach(({ width, height }, i) => (this.#pages[i]!.root.style.aspectRatio = `${width} / ${height}`));
    for (const { index, bitmap } of bitmaps) {
      const { canvas } = this.#pages[index]!;
      if (canvas.width !== bitmap.width || canvas.height !== bitmap.height) Object.assign(canvas, { width: bitmap.width, height: bitmap.height });
      canvas.getContext('bitmaprenderer')!.transferFromImageBitmap(bitmap);
    }
    this.#schedule();
  }

  #schedule(): void {
    this.#frame ||= requestAnimationFrame(() => {
      this.#frame = 0;
      this.#report();
      if (this.#follow) this.#reveal();
      this.#follow = false;
      this.#placeMark();
    });
  }

  #report(): void {
    const style = getComputedStyle(this.#scroller);
    const padding = parseFloat(style.paddingLeft) + parseFloat(style.paddingRight);
    const view: View = {
      widthPx: Math.round(this.#scroller.clientWidth - padding),
      dpr: devicePixelRatio,
      visible: this.#visible(),
    };
    const key = JSON.stringify(view);
    if (key === this.#reported) return;
    this.#reported = key;
    this.#onView(view);
  }

  #visible(): PageRange {
    const top = this.#scroller.scrollTop;
    const bottom = top + this.#scroller.clientHeight;
    const seen = this.#pages.flatMap(({ root }, i) => (root.offsetTop < bottom && root.offsetTop + root.offsetHeight > top ? [i] : []));
    return { first: seen[0] ?? 0, last: seen[seen.length - 1] ?? 0 };
  }
}
