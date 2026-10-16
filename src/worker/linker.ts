import type { TextPiece } from '../convert/toTypst';
import type { Edges } from '../linking/edges';
import { parseRuns, type Run } from '../linking/runs';
import { type PageRuns, SourceIndex } from '../linking/sourceIndex';
import type { PageRaster } from './raster';

export interface Linked {
  index: SourceIndex;
  pages: PageRuns[];
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
  #linked: Linked | null = null;
  #runs = new Map<string, Run[]>();

  constructor(raster: PageRaster) {
    this.#raster = raster;
  }

  /** The Markdown text of the document just merged into the raster, and how to measure its runs. */
  setDocument(pieces: TextPiece[], edges: Edges): void {
    this.#pieces = pieces;
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
    return (this.#linked = { index: SourceIndex.build(pages, this.#pieces, this.#edges), pages });
  }
}
