import type { ImagePath } from './images';
import type { Fit } from './linking/edges';
import type { Run } from './linking/runs';
import type { PageRuns, Spot } from './linking/sourceIndex';
import type { PageSettings, ThemeId } from './settings';

/** Editor revision. Every edit the main thread sends gets the next one. */
export type Rev = number & { readonly __brand: 'Rev' };

export const firstRev = 0 as Rev;
export const nextRev = (rev: Rev) => (rev + 1) as Rev;

/** Owns a whole, non-shared buffer, so it can be transferred. */
export type Bytes = Uint8Array<ArrayBuffer>;

/** Inclusive page indices. */
export interface PageRange {
  first: number;
  last: number;
}

/** What the preview pane shows: page width in CSS pixels, the display's density, and the pages in sight. */
export interface View {
  widthPx: number;
  dpr: number;
  visible: PageRange;
}

/** A page bitmap's size in device pixels. */
export interface PageSize {
  width: number;
  height: number;
}

export interface PageBitmap {
  index: number;
  bitmap: ImageBitmap;
}

/** Requests that link the preview and the editor. Each is answered by the reply with the same `id`. */
export type LinkRequest =
  /** The Markdown offset under a point on a page, in fractions of its width and height. */
  | { kind: 'source'; id: number; page: number; fx: number; fy: number }
  /** Where a Markdown offset renders. */
  | { kind: 'locate'; id: number; offset: number }
  /** Every page's text runs, which the linking check measures words against. */
  | { kind: 'runs'; id: number };

/** A run of a page's text, in pt, and how the preview sets it so that its characters fall where they print. */
export interface LayerRun extends Run, Omit<Fit, 'edges'> {}

/** The text of one page, for the preview's text layer, which lets the reader select and copy it. */
export interface TextPage {
  index: number;
  /** In pt. */
  width: number;
  height: number;
  runs: LayerRun[];
}

export type ToWorker =
  /** Sent before the first edit and on every change. */
  | { kind: 'settings'; settings: PageSettings }
  | { kind: 'edit'; rev: Rev; markdown: string }
  /**
   * An image the document can show, sent before the edit that references it. Null bytes remove it. `drawn` is an
   * SVG image drawn by the main thread, since a worker cannot decode SVG; null for the other types.
   */
  | { kind: 'image'; path: ImagePath; bytes: Bytes | null; drawn: ImageBitmap | null }
  | { kind: 'pdf'; rev: Rev }
  | ({ kind: 'view' } & View)
  | LinkRequest;

export type FromWorker =
  | { kind: 'ready'; bootMs: number }
  | {
      kind: 'pages';
      rev: Rev;
      /** What the pages are typeset with. A new theme shows here only once its fonts are in. */
      settings: PageSettings;
      /** Every page, so the preview can reserve space for pages not drawn yet. */
      sizes: PageSize[];
      /** Every local image this rev's Markdown references, shown or not, in document order. */
      images: ImagePath[];
      /** Why mitex rejected each formula shown as typed, in document order. */
      mathErrors: string[];
      /** Only the pages redrawn since the last message. */
      bitmaps: PageBitmap[];
      /** False while dirty pages of this rev are still waiting to be drawn. */
      final: boolean;
      convertMs: number;
      compileMs: number;
      rasterMs: number;
    }
  | { kind: 'failed'; rev: Rev; diagnostics: string[] }
  /** A theme's fonts did not download or install. The preview stays in `showing`, and choosing the theme again retries. */
  | { kind: 'fontsFailed'; theme: ThemeId; showing: ThemeId; message: string }
  | { kind: 'pdf'; rev: Rev; bytes: Bytes }
  /** The SVG image at `path` prints larger than its drawing: draw it `longSide` pixels along its longer side. */
  | { kind: 'svgWanted'; path: ImagePath; longSide: number }
  | { kind: 'sourced'; id: number; offset: number | null }
  | { kind: 'located'; id: number; spot: Spot | null }
  | { kind: 'runs'; id: number; pages: PageRuns[] }
  /** The pages whose text changed since the last of these, sent after a linking reply. */
  | { kind: 'text'; pages: TextPage[] };
