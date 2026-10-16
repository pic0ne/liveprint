import type { PageBitmap, PageRange, PageSize, View } from '../protocol';

/**
 * One canvas per page inside the scroller. A page keeps its bitmap until a new one arrives, and pages not drawn
 * yet reserve their space, so the preview never blanks and scrolling stays put. Reports the View whenever the
 * pane's width, the display density, or the pages in sight change.
 */
export class Pages {
  readonly #scroller: HTMLElement;
  readonly #onView: (view: View) => void;
  readonly #canvases: HTMLCanvasElement[] = [];
  #reported = '';
  #frame = 0;

  constructor(scroller: HTMLElement, onView: (view: View) => void) {
    this.#scroller = scroller;
    this.#onView = onView;
    this.#report();
    new ResizeObserver(() => this.#schedule()).observe(scroller);
    scroller.addEventListener('scroll', () => this.#schedule(), { passive: true });
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
