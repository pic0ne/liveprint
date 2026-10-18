import type { Advance } from '../linking/edges';

/** Family names stay unique across calls, as every face joins the same set. */
let count = 0;

/** A face that has not loaded by then is left unmeasured: Firefox can leave a worker's FontFace loading for good. */
const LOAD_MS = 3000;

const loadedFace = (face: FontFace) =>
  new Promise<FontFace | null>((resolve) => {
    setTimeout(() => resolve(null), LOAD_MS);
    face.load().then(() => resolve(face), () => resolve(null));
  });

/**
 * Each font's advance widths per pt of font size, measured on a canvas in the faces typst lays the pages out with.
 * The canvas kerns and forms ligatures, as typst does.
 * Null for a font the browser will not load: Chrome's sanitizer rejects the CFF of NewCM10 Regular and Italic,
 * which typst reads fine, and Firefox sometimes never finishes loading NewCM10 Italic in a worker.
 */
export async function measureFaces(fonts: Uint8Array[], into: FontFaceSet): Promise<(Advance | null)[]> {
  const context = new OffscreenCanvas(1, 1).getContext('2d')!;
  const faces = fonts.map((bytes) => new FontFace(`liveprint-measure-${count++}`, bytes as Uint8Array<ArrayBuffer>));
  const loaded = await Promise.all(faces.map(loadedFace));
  return loaded.map((face) => {
    if (!face) return null;
    into.add(face);
    const font = `100px "${face.family}"`;
    const widths = new Map<string, number>();
    return (text) => {
      let width = widths.get(text);
      if (width === undefined) {
        context.font = font;
        widths.set(text, (width = context.measureText(text).width / 100));
      }
      return width;
    };
  });
}
