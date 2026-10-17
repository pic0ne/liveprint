import type { Spot } from '../linking/sourceIndex';
import type { PageBitmap, PageRange, PageSize, View } from '../protocol';

/** A reader's own scroll holds off following the cursor for this long. */
const HANDS_OFF_MS = 1000;
/** The band reaches this share of the font size above and below the text, so it covers the line, not just the letters. */
const BAND_BLEED = 0.15;

const percent = (fraction: number) => `${fraction * 100}%`;

/**
 * One canvas per page inside the scroller. A page keeps its bitmap until a new one arrives, and pages not drawn
 * yet reserve their space, so the preview never blanks and scrolling stays put. Reports the View whenever the
 * pane's width, the display density, or the pages in sight change. Marks where the editor's cursor renders.
 */
export class Pages {
  readonly #scroller: HTMLElement;
  readonly #onView: (view: View) => void;
  readonly #canvases: HTMLCanvasElement[] = [];
  readonly #mark: HTMLElement;
  #spot: Spot | null = null;
  /** The spot changed since the last frame, so the preview may need to scroll to it. */
  #follow = false;
  #handsOffUntil = 0;
  #reported = '';
  #frame = 0;

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
    const canvas = spot && this.#canvases[spot.page];
    if (!canvas || performance.now() < this.#handsOffUntil) return;
    const top = canvas.offsetTop + spot.y * canvas.offsetHeight;
    const bottom = top + spot.h * canvas.offsetHeight;
    const { scrollTop, clientHeight } = this.#scroller;
    if (top >= scrollTop && bottom <= scrollTop + clientHeight) return;
    const smooth = !matchMedia('(prefers-reduced-motion: reduce)').matches;
    this.#scroller.scrollTo({ top: top - clientHeight / 3, behavior: smooth ? 'smooth' : 'instant' });
  }

  /** In page fractions inside a box laid over the page's canvas, so only that box moves when the pane resizes. */
  #placeMark(): void {
    const spot = this.#spot;
    const canvas = spot && this.#canvases[spot.page];
    this.#mark.hidden = !canvas;
    if (!canvas) return;
    Object.assign(this.#mark.style, {
      left: `${canvas.offsetLeft}px`,
      top: `${canvas.offsetTop}px`,
      width: `${canvas.offsetWidth}px`,
      height: `${canvas.offsetHeight}px`,
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
    const page = this.#canvases.indexOf(event.target as HTMLCanvasElement);
    if (page < 0) return null;
    const box = this.#canvases[page]!.getBoundingClientRect();
    return { page, fx: (event.clientX - box.left) / box.width, fy: (event.clientY - box.top) / box.height };
  }

  show(sizes: PageSize[], bitmaps: PageBitmap[]): void {
    while (this.#canvases.length < sizes.length) {
      this.#canvases.push(this.#scroller.appendChild(document.createElement('canvas')));
    }
    for (const extra of this.#canvases.splice(sizes.length)) extra.remove();
    sizes.forEach(({ width, height }, i) => (this.#canvases[i]!.style.aspectRatio = `${width} / ${height}`));
    for (const { index, bitmap } of bitmaps) {
      const canvas = this.#canvases[index]!;
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
    const seen = this.#canvases.flatMap((c, i) => (c.offsetTop < bottom && c.offsetTop + c.offsetHeight > top ? [i] : []));
    return { first: seen[0] ?? 0, last: seen[seen.length - 1] ?? 0 };
  }
}
