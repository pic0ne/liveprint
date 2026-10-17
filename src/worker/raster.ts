import { createTypstRenderer, type RenderSession, type TypstRenderer } from '@myriaddreamin/typst.ts/renderer';
import rendererWasm from '@myriaddreamin/typst-ts-renderer/wasm?url';
import type { ImagePath } from '../images';
import type { Bytes, PageBitmap, PageSize, View } from '../protocol';
import { type PagePt, RasterPlan } from './rasterPlan';

// The renderer wasm accepts only `instanceof CanvasRenderingContext2D`, which workers do not define.
const scope = self as { CanvasRenderingContext2D?: unknown; Window?: unknown; Image?: unknown };
scope.CanvasRenderingContext2D ??= OffscreenCanvasRenderingContext2D;

/** Each SVG image's drawing, by the SVG's text, and the text by the path it was sent under. */
const svgDrawings = new Map<string, ImageBitmap>();
const svgTexts = new Map<ImagePath, string>();

/** Keeps the main thread's drawing of the SVG image at `path` for the stand-in below, or forgets it for null bytes. */
export function drawSvgFrom(path: ImagePath, bytes: Bytes | null, drawn: ImageBitmap | null): void {
  const old = svgTexts.get(path);
  svgTexts.delete(path);
  if (old !== undefined && ![...svgTexts.values()].includes(old)) {
    svgDrawings.get(old)?.close();
    svgDrawings.delete(old);
  }
  if (!bytes || !drawn) return;
  const text = new TextDecoder().decode(bytes);
  svgTexts.set(path, text);
  svgDrawings.set(text, drawn);
}

// The renderer decodes PNG, JPEG, GIF and WebP with createImageBitmap, but an SVG it loads into `new Image()`, and
// only when `self` passes for a Window; without one it panics. Workers have no Image and cannot decode SVG at all, so
// the stand-in is a canvas that copies the main thread's drawing of the SVG its `src` names. It never reports an
// error, which the renderer would also panic on: an SVG it has no drawing of stays blank.
scope.Window ??= self.constructor;
scope.Image ??= function Image() {
  const canvas = Object.assign(new OffscreenCanvas(1, 1), { onload: null as (() => void) | null });
  Object.defineProperty(canvas, 'src', {
    set(url: string) {
      void fetch(url)
        .then((response) => response.text())
        .then((text) => {
          const drawing = svgDrawings.get(text);
          if (drawing) {
            Object.assign(canvas, { width: drawing.width, height: drawing.height });
            canvas.getContext('2d')!.drawImage(drawing, 0, 0);
          }
        })
        .catch(() => {})
        .finally(() => canvas.onload?.());
    },
  });
  return canvas;
};

/** runWithSession frees the session when its callback settles, so this callback never does. */
const openSession = (renderer: TypstRenderer) =>
  new Promise<RenderSession>((resolve) => {
    void renderer.runWithSession((session) => {
      resolve(session);
      return new Promise<never>(() => {});
    });
  });

export interface RasterBatch {
  bitmaps: PageBitmap[];
  rasterMs: number;
}

/** Holds the document the compiler's deltas build up, and draws its pages into transferable bitmaps. */
export class PageRaster {
  readonly #renderer: TypstRenderer;
  readonly #session: RenderSession;
  readonly #plan = new RasterPlan();
  readonly #canvas = new OffscreenCanvas(1, 1);
  readonly #context = this.#canvas.getContext('2d')!;
  #pages: PagePt[] = [];

  private constructor(renderer: TypstRenderer, session: RenderSession) {
    this.#renderer = renderer;
    this.#session = session;
  }

  static async create(): Promise<PageRaster> {
    const renderer = createTypstRenderer();
    await renderer.init({ getModule: () => rendererWasm });
    return new PageRaster(renderer, await openSession(renderer));
  }

  merge(delta: Uint8Array): void {
    this.#renderer.manipulateData({ renderSession: this.#session, action: 'merge', data: delta });
    this.#pages = this.#session.retrievePagesInfo();
    this.#plan.setDocument(this.#pages);
  }

  /** Every page's size in pt. */
  get pages(): PagePt[] {
    return this.#pages;
  }

  setView(view: View): void {
    this.#plan.setView(view);
  }

  get sizes(): PageSize[] {
    return this.#plan.sizes;
  }

  get final(): boolean {
    return this.#plan.final;
  }

  /** typst.ts's cache key for a page, the same one drawing it returns. Selecting no data draws nothing, so it costs about 0.1 ms. */
  async pageKey(index: number): Promise<string> {
    return (await this.#render(index, { body: false, semantics: false })).cacheKey;
  }

  /** A page's text layer, the HTML typst.ts builds for selecting text: 1–4 ms a page. */
  async semantics(index: number): Promise<string> {
    return (await this.#render(index, { body: false, semantics: true })).htmlSemantics.join('');
  }

  #render(index: number, dataSelection: { body: boolean; semantics: boolean }) {
    return this.#renderer.renderCanvas({
      renderSession: this.#session,
      canvas: this.#context as unknown as CanvasRenderingContext2D,
      pageOffset: index,
      dataSelection,
    });
  }

  /** Draws the plan's next batch. A page whose cache key comes back unchanged yields no bitmap. */
  async draw(): Promise<RasterBatch> {
    const t0 = performance.now();
    const bitmaps: PageBitmap[] = [];
    for (const { index, pixelPerPt, size, cacheKey } of this.#plan.nextBatch()) {
      if (this.#canvas.width !== size.width || this.#canvas.height !== size.height) {
        Object.assign(this.#canvas, size);
      }
      const result = await this.#renderer.renderCanvas({
        renderSession: this.#session,
        canvas: this.#context as unknown as CanvasRenderingContext2D,
        pageOffset: index,
        pixelPerPt,
        backgroundColor: '#ffffff',
        cacheKey,
      });
      if (result.cacheKey !== cacheKey) bitmaps.push({ index, bitmap: this.#canvas.transferToImageBitmap() });
      this.#plan.drawn(index, result.cacheKey);
    }
    return { bitmaps, rasterMs: performance.now() - t0 };
  }
}
