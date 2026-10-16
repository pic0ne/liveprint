/** One run of text as typst.ts lays it out, in pt from the page's top-left corner. `h` is the font size. */
export interface Run {
  x: number;
  y: number;
  w: number;
  h: number;
  text: string;
}

// The text layer sizes every run in a monospace fallback whose advance is DejaVu Sans Mono's 1233/2048 em, then
// squeezes it with scaleX to the run's real width.
const LAYER_ADVANCE = 1233 / 2048;

const TEXT_SPAN = /<span class="typst-content-text"[^>]*?style="([^"]*)"[^>]*>([^<]*)<\/span>/g;
const ENTITY = /&(?:#(\d+)|#x([0-9a-f]+)|(lt|gt|amp|quot|apos|nbsp));/gi;
const NAMED: Record<string, string> = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'", nbsp: ' ' };

const decode = (text: string) =>
  text.replace(ENTITY, (_, dec?: string, hex?: string, name?: string) =>
    name ? NAMED[name.toLowerCase()]! : String.fromCodePoint(parseInt(dec ?? hex!, dec ? 10 : 16)),
  );

function property(style: string, name: string): number {
  const match = new RegExp(`(?:^|[;\\s])${name}: calc\\(var\\(--data-text-(?:width|height)\\) \\* (-?[\\d.]+)\\)`).exec(style);
  return match ? Number(match[1]) : NaN;
}

/** The text runs of one page's `htmlSemantics`, in reading order. A string scan, because workers have no DOMParser. */
export function parseRuns(html: string): Run[] {
  const runs: Run[] = [];
  for (const [, style, raw] of html.matchAll(TEXT_SPAN)) {
    const text = decode(raw!);
    const h = property(style!, 'font-size');
    const scaleX = Number(/scaleX\(([\d.]+)\)/.exec(style!)?.[1] ?? 1);
    const run = { x: property(style!, 'left'), y: property(style!, 'top'), w: [...text].length * LAYER_ADVANCE * h * scaleX, h, text };
    if (text !== '' && [run.x, run.y, run.w, run.h].every(Number.isFinite)) runs.push(run);
  }
  return runs;
}
