import type { Run } from './runs';

/** Where each character boundary of a run falls: `[...run.text].length + 1` values from `run.x` to `run.x + run.w`. */
export type Edges = (run: Run) => number[];

/** A face's advance width for one character, per pt of font size. */
export type Advance = (char: string) => number;

const SPACE = /^\s$/u;

const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);

function edgesFrom(x: number, widths: number[]): number[] {
  const out = [x];
  for (const w of widths) out.push((x += w));
  return out;
}

/** Every character equally wide, as the text layer itself draws them. */
export const evenEdges: Edges = (run) => {
  const n = [...run.text].length;
  return edgesFrom(run.x, new Array<number>(n).fill(run.w / n));
};

/**
 * Proportional edges. The layer only gives a run's overall width, and spreading it evenly put words up to 22 pt
 * from where they print in the sample. Each run is measured in whichever face's natural width comes closest to its
 * real one, and the difference goes to the spaces, where justification puts it.
 */
export function fittedEdges(faces: Advance[]): Edges {
  return (run) => {
    const chars = [...run.text];
    let widths: number[] = [];
    let miss = Infinity;
    for (const face of faces) {
      const candidate = chars.map((c) => face(c) * run.h);
      const candidateMiss = Math.abs(run.w - sum(candidate));
      if (candidateMiss < miss) [widths, miss] = [candidate, candidateMiss];
    }
    const natural = sum(widths);
    if (!(natural > 0)) return evenEdges(run);
    const spaces = chars.flatMap((c, i) => (SPACE.test(c) ? [i] : []));
    const slack = run.w - natural;
    if (spaces.length > 0 && sum(spaces.map((i) => widths[i]!)) + slack >= 0) {
      for (const i of spaces) widths[i]! += slack / spaces.length;
      return edgesFrom(run.x, widths);
    }
    return edgesFrom(run.x, widths.map((w) => (w * run.w) / natural));
  };
}
