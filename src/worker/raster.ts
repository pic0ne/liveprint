import { createTypstRenderer, type RenderSession, type TypstRenderer } from '@myriaddreamin/typst.ts/renderer';
import rendererWasm from '@myriaddreamin/typst-ts-renderer/wasm?url';
import type { PageBitmap, PageSize, View } from '../protocol';
import { RasterPlan } from './rasterPlan';

// The renderer wasm accepts only `instanceof CanvasRenderingContext2D`, which workers do not define.
const scope = self as { CanvasRenderingContext2D?: unknown };
scope.CanvasRenderingContext2D ??= OffscreenCanvasRenderingContext2D;

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
    this.#plan.setDocument(this.#session.retrievePagesInfo());
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
