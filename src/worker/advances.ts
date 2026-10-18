import type { Advance } from '../linking/edges';

/** Family names stay unique across calls, as every face joins the same set. */
let count = 0;

/**
 * Each font's advance widths per pt of font size, measured on a canvas in the faces typst lays the pages out with.
 * The canvas kerns and forms ligatures, as typst does.
 * Null for a font the browser will not load: Chrome's sanitizer rejects the CFF of NewCM10 Regular and Italic,
 * which typst reads fine.
 */
export async function measureFaces(fonts: Uint8Array[], into: FontFaceSet): Promise<(Advance | null)[]> {
  const context = new OffscreenCanvas(1, 1).getContext('2d')!;
  const faces = fonts.map((bytes) => new FontFace(`liveprint-measure-${count++}`, bytes as Uint8Array<ArrayBuffer>));
  const loaded = await Promise.all(faces.map((face) => face.load().then(() => face, () => null)));
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
