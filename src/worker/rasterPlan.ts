import type { PageSize, View } from '../protocol';

/** A page's size in points, as typst lays it out. */
export interface PagePt {
  width: number;
  height: number;
}

/** `key` is typst.ts's cache key for the bitmap the preview shows, undefined when it shows none at this resolution. */
type PageState = { status: 'clean'; key: string } | { status: 'dirty'; key: string | undefined };

interface Page {
  pt: PagePt;
  state: PageState;
}

export interface RasterJob {
  index: number;
  pixelPerPt: number;
  size: PageSize;
  cacheKey: string | undefined;
}

const MAX_DPR = 2;
/** Pages beyond the visible ones that are drawn before the first message, so a short scroll finds them ready. */
const MARGIN = 1;

function job({ pt, state }: Page, index: number, view: View): RasterJob {
  const pixelPerPt = (view.widthPx / pt.width) * Math.min(view.dpr, MAX_DPR);
  return {
    index,
    pixelPerPt,
    size: { width: Math.round(pt.width * pixelPerPt), height: Math.round(pt.height * pixelPerPt) },
    cacheKey: state.key,
  };
}

/**
 * Which pages need drawing, and in what order. After a compile every page is dirty: only typst.ts can tell
 * whether its content changed, by returning the same cache key. Dirty pages near the viewport go first as
 * one batch, then the rest one at a time, nearest first, so the caller can stop between any two.
 */
export class RasterPlan {
  #view: View | null = null;
  #pages: Page[] = [];

  setDocument(pages: PagePt[]): void {
    this.#pages = pages.map((pt, i) => ({ pt, state: { status: 'dirty', key: this.#pages[i]?.state.key } }));
  }

  setView(view: View): void {
    const resized = this.#view?.widthPx !== view.widthPx || this.#view.dpr !== view.dpr;
    this.#view = view;
    if (resized) for (const page of this.#pages) page.state = { status: 'dirty', key: undefined };
  }

  get sizes(): PageSize[] {
    const view = this.#view;
    return view ? this.#pages.map((page, i) => job(page, i, view).size) : [];
  }

  /** Nothing is left to draw until the next compile or view. Without a view nothing can be drawn. */
  get final(): boolean {
    return !this.#view || this.#pages.every((page) => page.state.status === 'clean');
  }

  /** The dirty pages within a page of the viewport, or else the single dirty page nearest to it, ties going to the later page. */
  nextBatch(): RasterJob[] {
    const view = this.#view;
    if (!view) return [];
    const { first, last } = view.visible;
    const dirty = this.#pages.flatMap((page, i) => (page.state.status === 'dirty' ? [job(page, i, view)] : []));
    const near = dirty.filter(({ index }) => index >= first - MARGIN && index <= last + MARGIN);
    if (near.length > 0) return near;
    const distance = ({ index }: RasterJob) => (index < first ? first - index : index - last);
    const nearest = dirty.reduce<RasterJob | undefined>((best, j) => (best && distance(best) < distance(j) ? best : j), undefined);
    return nearest ? [nearest] : [];
  }

  drawn(index: number, key: string): void {
    const page = this.#pages[index];
    if (page) page.state = { status: 'clean', key };
  }
}
