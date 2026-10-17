import type { TextPiece } from '../convert/toTypst';
import { matchPairs } from './diff';
import { type Edges, evenEdges } from './edges';
import type { Run } from './runs';

export interface PageRuns {
  /** In pt. */
  width: number;
  height: number;
  runs: Run[];
}

/**
 * Where a Markdown offset renders, in fractions of the page's width and height: a caret at `x` on a line of text, or
 * the whole box of the image whose Markdown holds the offset.
 */
export type Spot =
  | { kind: 'text'; page: number; x: number; y: number; h: number; lineLeft: number; lineRight: number }
  | { kind: 'image'; page: number; x: number; y: number; w: number; h: number };

interface Line {
  page: number;
  /** Everything on the line, a radical's tall stroke included. */
  top: number;
  bottom: number;
  /** The line's longest run, which the spot covers, so one tall glyph does not stretch it. */
  body: Run;
  left: number;
  right: number;
  runs: Placed[];
}

interface LaidOut {
  width: number;
  height: number;
  lines: Line[];
}

interface Placed {
  run: Run;
  line: Line;
  edges: number[];
  /** Index of the run's first character among all rendered characters. */
  first: number;
}

const FOLDED = new Map<string, string>();
/** Letters and digits only, case-folded and without accents, so quotes, dashes, hyphens and ligatures never differ. */
function fold(char: string): string {
  let out = FOLDED.get(char);
  if (out === undefined) FOLDED.set(char, (out = char.normalize('NFKD').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '')));
  return out;
}

/**
 * A run continues the line when it overlaps it at all and does not step back left. A radical or a superscript sits
 * well above its neighbours, and a styled word a hair lower; reading order always starts a new line back at the left.
 */
function continues(line: Line, run: Run): boolean {
  const previous = line.runs[line.runs.length - 1]!.run;
  return Math.min(line.bottom, run.y + run.h) > Math.max(line.top, run.y) && run.x >= previous.x + previous.w - 1;
}

const gap = (from: number, to: number, at: number) => (at < from ? from - at : at > to ? at - to : 0);

/** Index of the item nearest by `distance`, the last on a tie: where one run ends and the next begins, the next one's first character is the real offset. */
function nearest<T>(items: T[], distance: (item: T) => number): number {
  let best = 0;
  for (let i = 1; i < items.length; i++) if (distance(items[i]!) <= distance(items[best]!)) best = i;
  return best;
}

/**
 * Maps between Markdown offsets and page positions by aligning the rendered text with the Markdown text the
 * converter showed. Both sides fold to letters and digits and a diff pairs them up; every rendered character then
 * has an offset. One the diff left unpaired (a math glyph, a list number, a space) takes its share of the Markdown
 * between its paired neighbours, which is the offset just after the previous one when nothing lies between.
 */
export class SourceIndex {
  readonly #pages: LaidOut[];
  /** Per rendered character, in reading order: its Markdown offset (never decreasing), whether the diff paired it, and its run. */
  readonly #offsets: Int32Array;
  readonly #paired: Uint8Array;
  readonly #placed: Placed[];

  private constructor(pages: LaidOut[], offsets: Int32Array, paired: Uint8Array, placed: Placed[]) {
    this.#pages = pages;
    this.#offsets = offsets;
    this.#paired = paired;
    this.#placed = placed;
  }

  static build(pages: PageRuns[], pieces: TextPiece[], edges: Edges = evenEdges): SourceIndex {
    const byChar: Placed[] = [];
    const rendered: number[] = [];
    const renderedChar: number[] = [];
    const laidOut = pages.map(({ width, height, runs }, page) => {
      const lines: Line[] = [];
      for (const run of runs) {
        let line = lines[lines.length - 1];
        if (line && continues(line, run)) {
          Object.assign(line, {
            top: Math.min(line.top, run.y),
            bottom: Math.max(line.bottom, run.y + run.h),
            left: Math.min(line.left, run.x),
            right: Math.max(line.right, run.x + run.w),
            body: run.text.length > line.body.text.length ? run : line.body,
          });
        } else {
          line = { page, top: run.y, bottom: run.y + run.h, left: run.x, right: run.x + run.w, body: run, runs: [] };
          lines.push(line);
        }
        const placed: Placed = { run, line, edges: edges(run), first: byChar.length };
        line.runs.push(placed);
        for (const char of run.text) {
          for (const unit of fold(char)) {
            rendered.push(unit.codePointAt(0)!);
            renderedChar.push(byChar.length);
          }
          byChar.push(placed);
        }
      }
      return { width, height, lines };
    });

    const source: number[] = [];
    const sourceOffset: number[] = [];
    for (const { from, text } of pieces) {
      let at = from;
      for (const char of text) {
        for (const unit of fold(char)) {
          source.push(unit.codePointAt(0)!);
          sourceOffset.push(at);
        }
        at += char.length;
      }
    }

    const offsets = new Int32Array(byChar.length).fill(-1);
    const paired = new Uint8Array(byChar.length);
    const pairs = matchPairs(rendered, source);
    for (let i = 0; i < pairs.length; i += 2) {
      const char = renderedChar[pairs[i]!]!;
      if (paired[char]) continue;
      paired[char] = 1;
      offsets[char] = sourceOffset[pairs[i + 1]!]!;
    }
    let previous = -1;
    for (let char = 0; char <= offsets.length; char++) {
      if (char < offsets.length && !paired[char]) continue;
      const start = previous < 0 ? 0 : offsets[previous]! + 1;
      const room = char < offsets.length ? Math.max(0, offsets[char]! - start) : 0;
      const count = char - previous - 1;
      for (let j = 0; j < count; j++) offsets[previous + 1 + j] = start + Math.floor((j * room) / count);
      previous = char;
    }
    return new SourceIndex(laidOut, offsets, paired, byChar);
  }

  /** Markdown offset under a point on a page (fractions). Nearest run on the nearest line if the point is between runs. */
  sourceAt(page: number, fx: number, fy: number): number | null {
    const laidOut = this.#pages[page];
    if (!laidOut || laidOut.lines.length === 0) return null;
    const [x, y] = [fx * laidOut.width, fy * laidOut.height];
    const below = Math.min(...laidOut.lines.map((l) => gap(l.top, l.bottom, y)));
    const runs = laidOut.lines.filter((l) => gap(l.top, l.bottom, y) === below).flatMap((l) => l.runs);
    const placed = runs[nearest(runs, ({ run }) => gap(run.x, run.x + run.w, x))]!;
    const boundary = nearest(placed.edges, (edge) => Math.abs(edge - x));
    const count = placed.edges.length - 1;
    return boundary < count ? this.#offsets[placed.first + boundary]! : this.#offsets[placed.first + count - 1]! + 1;
  }

  /** Where a Markdown offset renders: before the first character at or after it, or right after the one before it. */
  spotOf(offset: number): Spot | null {
    const offsets = this.#offsets;
    if (offsets.length === 0) return null;
    let lo = 0;
    let hi = offsets.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (offsets[mid]! < offset) lo = mid + 1;
      else hi = mid;
    }
    // Of the characters at exactly this offset, a paired one is where it prints: a hyphen the line break added takes the offset of the letter after it.
    for (let char = lo; char < offsets.length && offsets[char] === offset; char++) {
      if (this.#paired[char]) return this.#spot(char, false);
    }
    if (lo === offsets.length) return this.#spot(lo - 1, true);
    if (lo > 0 && offsets[lo]! > offset && offset === offsets[lo - 1]! + 1) return this.#spot(lo - 1, true);
    return this.#spot(lo, false);
  }

  #spot(char: number, after: boolean): Spot {
    const { line, edges, first } = this.#placed[char]!;
    const { width, height } = this.#pages[line.page]!;
    return {
      kind: 'text',
      page: line.page,
      x: edges[char - first + (after ? 1 : 0)]! / width,
      y: line.body.y / height,
      h: line.body.h / height,
      lineLeft: line.left / width,
      lineRight: line.right / width,
    };
  }
}
