import type { Span } from '../convert/toTypst';

/** A shown image: the Markdown that names it, from `![` to its end, and its box on its page in pt. */
export interface ImageBox {
  from: number;
  to: number;
  page: number;
  x: number;
  y: number;
  w: number;
  h: number;
}

/** A `here().position()`, with lengths as Typst writes them, such as `"152.67pt"`, and pages counted from 1. */
interface Position {
  page: number;
  x: string;
  y: string;
}

/** The values of `<liveprint-image>` marks, in document order: each image's natural size, its top-left corner, and the mark under it. */
export type ImageMark = { size: { width: string; height: string } } | { at: Position };

const pt = (length: string) => parseFloat(length);

/**
 * Gives each shown image, in document order, the box its three marks describe: its height is between the last two,
 * and its width keeps its natural aspect ratio. None at all if the marks do not match the images one to one.
 */
export function imageBoxes(marks: ImageMark[], shown: Span[]): ImageBox[] {
  if (marks.length !== shown.length * 3) return [];
  return shown.flatMap(({ from, to }, k) => {
    const [size, start, end] = marks.slice(k * 3, k * 3 + 3) as [ImageMark, ImageMark, ImageMark];
    if (!('size' in size) || !('at' in start) || !('at' in end) || start.at.page !== end.at.page) return [];
    const h = pt(end.at.y) - pt(start.at.y);
    const w = (h * pt(size.size.width)) / pt(size.size.height);
    const box = { from, to, page: start.at.page - 1, x: pt(start.at.x), y: pt(start.at.y), w, h };
    return [box.x, box.y, w, h].every(Number.isFinite) && h > 0 ? [box] : [];
  });
}

/** The image under a point on a page, in pt. */
export const imageAt = (boxes: ImageBox[], page: number, x: number, y: number) =>
  boxes.find((b) => b.page === page && x >= b.x && x <= b.x + b.w && y >= b.y && y <= b.y + b.h);

/** The image whose Markdown has the offset inside it, between its first and last character. */
export const imageOf = (boxes: ImageBox[], offset: number) => boxes.find((b) => offset > b.from && offset < b.to);
