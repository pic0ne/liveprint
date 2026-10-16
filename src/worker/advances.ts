import type { Advance } from '../linking/edges';

/** Each font's advance widths per pt of font size, measured on a canvas in the faces typst lays the pages out with. */
export async function measureFaces(fonts: Uint8Array[], into: FontFaceSet): Promise<Advance[]> {
  const context = new OffscreenCanvas(1, 1).getContext('2d')!;
  const faces = fonts.map((bytes, i) => new FontFace(`liveprint-measure-${i}`, bytes as Uint8Array<ArrayBuffer>));
  await Promise.all(faces.map((face) => face.load()));
  return faces.map((face) => {
    into.add(face);
    const font = `100px "${face.family}"`;
    const widths = new Map<string, number>();
    return (char) => {
      let width = widths.get(char);
      if (width === undefined) {
        context.font = font;
        widths.set(char, (width = context.measureText(char).width / 100));
      }
      return width;
    };
  });
}
