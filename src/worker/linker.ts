import type { TextPiece } from '../convert/toTypst';
import type { Edges } from '../linking/edges';
import { type ImageBox, imageAt, imageOf } from '../linking/imageBoxes';
import { parseRuns, type Run } from '../linking/runs';
import { type PageRuns, SourceIndex, type Spot } from '../linking/sourceIndex';
import type { PageRaster } from './raster';

export interface Linked {
  index: SourceIndex;
  pages: PageRuns[];
  images: ImageBox[];
}

/** The Markdown offset under a point on a page, in fractions: inside an image's `![`, or else from the text. */
export function sourceAt({ index, pages, images }: Linked, page: number, fx: number, fy: number): number | null {
  const size = pages[page];
  const image = size && imageAt(images, page, fx * size.width, fy * size.height);
  return image ? image.from + 2 : index.sourceAt(page, fx, fy);
}

/** Where a Markdown offset renders: the image whose Markdown holds it, or else its place in the text. */
export function spotOf({ index, pages, images }: Linked, offset: number): Spot | null {
  const image = imageOf(images, offset);
  const size = image && pages[image.page];
  if (!image || !size) return index.spotOf(offset);
  const { page, x, y, w, h } = image;
  return { kind: 'image', page, x: x / size.width, y: y / size.height, w: w / size.width, h: h / size.height };
}

/**
 * The source index of the document the raster holds, built when a linking request first needs it after a compile.
 * A page whose typst.ts cache key is unchanged keeps its runs and their measured edges, so typing on one page
 * re-reads only that page's text layer.
 */
export class Linker {
  readonly #raster: PageRaster;
  /** A run belongs to one page's cache key, and so to one theme, so its edges are measured once. */
  readonly #measured = new WeakMap<Run, number[]>();
  #edges: Edges = () => [];
  #pieces: TextPiece[] = [];
  #images: () => Promise<ImageBox[]> = async () => [];
  #linked: Linked | null = null;
  #runs = new Map<string, Run[]>();

  constructor(raster: PageRaster) {
    this.#raster = raster;
  }

  /** The Markdown text of the document just merged into the raster, how to measure its runs, and where its images are. */
  setDocument(pieces: TextPiece[], edges: Edges, images: () => Promise<ImageBox[]>): void {
    this.#pieces = pieces;
    this.#images = images;
    this.#edges = (run) => {
      let out = this.#measured.get(run);
      if (!out) this.#measured.set(run, (out = edges(run)));
      return out;
    };
    this.#linked = null;
  }

  async linked(): Promise<Linked> {
    if (this.#linked) return this.#linked;
    const runs = new Map<string, Run[]>();
    const pages: PageRuns[] = [];
    for (const [i, { width, height }] of this.#raster.pages.entries()) {
      const key = await this.#raster.pageKey(i);
      const pageRuns = runs.get(key) ?? this.#runs.get(key) ?? parseRuns(await this.#raster.semantics(i));
      runs.set(key, pageRuns);
      pages.push({ width, height, runs: pageRuns });
    }
    this.#runs = runs;
    const images = await this.#images().catch(() => []);
    return (this.#linked = { index: SourceIndex.build(pages, this.#pieces, this.#edges), pages, images });
  }
}
