import { LAYER_ADVANCE, type Run } from './runs';

/** Where each character boundary of a run falls: `[...run.text].length + 1` values from `run.x` to `run.x + run.w`. */
export type Edges = (run: Run) => number[];

/** A face's advance width for a piece of text, per pt of font size, kerned and with ligatures, as typst sets it. */
export type Advance = (text: string) => number;

/** A font a run can be measured in: its path under public/, and its advances. */
export interface Face {
  path: string;
  advance: Advance;
}

/**
 * How a run fills its width: set in the font at `face`, with `spacing` pt added to each space, then
 * stretched by `scale`. Null `face` is the text layer's own monospace fallback, where every character is as wide.
 * `edges` are where its character boundaries fall.
 */
export interface Fit {
  face: string | null;
  spacing: number;
  scale: number;
  edges: number[];
}

export type Fitter = (run: Run) => Fit;

const SPACE = /^\s$/u;

const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);

/**
 * Each character's width in one face. A word is measured whole, so kerning and ligatures inside it count, and its
 * characters share that width in proportion to their own advances.
 */
function widthsIn(advance: Advance, chars: string[], size: number): number[] {
  const widths = chars.map((c) => advance(c) * size);
  for (let start = 0; start < chars.length; ) {
    let end = start;
    while (end < chars.length && SPACE.test(chars[end]!) === SPACE.test(chars[start]!)) end++;
    if (!SPACE.test(chars[start]!) && end - start > 1) {
      const own = sum(widths.slice(start, end));
      const whole = advance(chars.slice(start, end).join('')) * size;
      if (own > 0) for (let i = start; i < end; i++) widths[i]! *= whole / own;
    }
    start = end;
  }
  return widths;
}

function edgesFrom(x: number, widths: number[]): number[] {
  const out = [x];
  for (const w of widths) out.push((x += w));
  return out;
}

/** Every character equally wide, as the text layer itself draws them. */
export const evenFit: Fitter = (run) => {
  const n = [...run.text].length;
  return { face: null, spacing: 0, scale: run.w / (n * LAYER_ADVANCE * run.h), edges: edgesFrom(run.x, new Array<number>(n).fill(run.w / n)) };
};

export const evenEdges: Edges = (run) => evenFit(run).edges;

/** Justification shrinks a space this many times more reluctantly than it stretches one. */
const SHRINK_COST = 3;

/**
 * How unlikely a face is to have set a run of natural width `natural`: the share its spaces would have to stretch,
 * or shrink, which costs more. A run without spaces is scaled, so there it is the share it would have to scale by.
 */
function strain(run: Run, natural: number, room: number): number {
  const slack = run.w - natural;
  if (room <= 0) return Math.abs(slack) / natural;
  return slack >= 0 ? slack / room : (-slack / room) * SHRINK_COST;
}

/**
 * Proportional fits. The layer only gives a run's overall width, and spreading it evenly put words up to 22 pt
 * from where they print in the sample. Each run is measured in the face that sets it with the least strain on its
 * spaces, and the difference goes to the spaces, where justification puts it. Choosing the face whose width came
 * closest instead picks a wider face for some well-stretched justified lines: in Book, 2 of the 33 words that
 * check:linking samples then select a few pt away from their ink.
 */
export function fitRuns(faces: Face[]): Fitter {
  return (run) => {
    const chars = [...run.text];
    // A run's width ends at its last letter: the space after a line's last word takes none, and justification
    // stretches only the spaces between words.
    let end = chars.length;
    while (end > 0 && SPACE.test(chars[end - 1]!)) end--;
    const spaces = chars.slice(0, end).flatMap((c, i) => (SPACE.test(c) ? [i] : []));
    let widths: number[] = [];
    let face: string | null = null;
    let least = Infinity;
    for (const { path, advance } of faces) {
      const candidate = widthsIn(advance, chars.slice(0, end), run.h).concat(new Array<number>(chars.length - end).fill(0));
      const natural = sum(candidate);
      if (!(natural > 0)) continue;
      const cost = strain(run, natural, sum(spaces.map((i) => candidate[i]!)));
      if (cost < least) [widths, face, least] = [candidate, path, cost];
    }
    const natural = sum(widths);
    if (!(natural > 0)) return evenFit(run);
    const slack = run.w - natural;
    if (spaces.length > 0 && sum(spaces.map((i) => widths[i]!)) + slack >= 0) {
      const spacing = slack / spaces.length;
      for (const i of spaces) widths[i]! += spacing;
      return { face, spacing, scale: 1, edges: edgesFrom(run.x, widths) };
    }
    const scale = run.w / natural;
    return { face, spacing: 0, scale, edges: edgesFrom(run.x, widths.map((w) => w * scale)) };
  };
}
