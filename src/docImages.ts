import { freeName, IMAGE_TYPES, type ImagePath, logoPath, withExtension } from './images';
import type { Bytes, ToWorker } from './protocol';

/** An SVG is drawn this many pixels along its longer side, enough for a column on a 2x display. */
const SVG_LONG_SIDE = 2048;
/** A sharper drawing the worker asks for stays within this many pixels, 64 MB of memory. */
const SVG_MAX_PIXELS = 4096 * 4096;

const isSvg = (path: ImagePath, blob: Blob) => blob.type === 'image/svg+xml' || /\.svg$/i.test(path);

/** Draws an SVG for the worker, which cannot decode SVG, `longSide` pixels along its longer side. Null when the browser cannot either. */
async function drawSvg(blob: Blob, longSide = SVG_LONG_SIDE): Promise<ImageBitmap | null> {
  const image = new Image();
  image.src = URL.createObjectURL(blob);
  try {
    await image.decode();
  } catch {
    return null;
  } finally {
    URL.revokeObjectURL(image.src);
  }
  const [width, height] = [image.naturalWidth || 300, image.naturalHeight || 150];
  const scale = Math.min(longSide / Math.max(width, height), Math.sqrt(SVG_MAX_PIXELS / (width * height)));
  const canvas = new OffscreenCanvas(Math.round(width * scale), Math.round(height * scale));
  canvas.getContext('2d')!.drawImage(image, 0, 0, canvas.width, canvas.height);
  return canvas.transferToImageBitmap();
}

/**
 * Keeps the worker's images equal to the document's, with the custom theme's logo beside them. Each `show` or
 * `showLogo` sends only what changed since the one before, in the order they were called, so an image is in the
 * worker before any message sent after its call resolves.
 */
export class WorkerImages {
  readonly #send: (message: ToWorker, transfer: Transferable[]) => void;
  #doc: ReadonlyMap<ImagePath, Blob> = new Map();
  #logo: Blob | null = null;
  #sent: ReadonlyMap<ImagePath, Blob> = new Map();
  /** The longer side each SVG image was last drawn again at, since its blob was sent. */
  readonly #sharpened = new Map<ImagePath, number>();
  #queue = Promise.resolve();

  constructor(send: (message: ToWorker, transfer: Transferable[]) => void) {
    this.#send = send;
  }

  /**
   * Draws the SVG image at `path` again, `longSide` pixels along its longer side, once per size, after any `show`
   * before it. The worker gets it as a new image: the SVG with a comment naming the size, which typst.ts loads afresh,
   * since it keeps its own copy of an image it has drawn.
   */
  sharpen(path: ImagePath, longSide: number): Promise<void> {
    const sharpened = this.#queue.then(async () => {
      const blob = this.#sent.get(path);
      if (!blob || !isSvg(path, blob) || (this.#sharpened.get(path) ?? 0) >= longSide) return;
      this.#sharpened.set(path, longSide);
      const drawn = await drawSvg(blob, longSide);
      if (!drawn) return;
      const bytes = new Uint8Array(await new Blob([blob, `\n<!-- liveprint draws this at ${longSide} px -->\n`]).arrayBuffer()) as Bytes;
      this.#send({ kind: 'image', path, bytes, drawn }, [bytes.buffer, drawn]);
    });
    this.#queue = sharpened.catch(() => {});
    return sharpened;
  }

  show(images: ReadonlyMap<ImagePath, Blob>): Promise<void> {
    this.#doc = images;
    return this.#push();
  }

  showLogo(logo: Blob | null): Promise<void> {
    this.#logo = logo;
    return this.#push();
  }

  #push(): Promise<void> {
    const images = this.#logo ? new Map([...this.#doc, [logoPath(this.#logo.type), this.#logo]]) : this.#doc;
    const sent = this.#queue.then(() => this.#sync(images));
    this.#queue = sent.catch(() => {});
    return sent;
  }

  async #sync(images: ReadonlyMap<ImagePath, Blob>): Promise<void> {
    const before = this.#sent;
    this.#sent = images;
    for (const path of before.keys()) {
      if (!images.has(path)) this.#send({ kind: 'image', path, bytes: null, drawn: null }, []);
    }
    for (const [path, blob] of images) {
      if (before.get(path) === blob) continue;
      this.#sharpened.delete(path);
      const bytes = new Uint8Array(await blob.arrayBuffer()) as Bytes;
      const drawn = isSvg(path, blob) ? await drawSvg(blob) : null;
      this.#send({ kind: 'image', path, bytes, drawn }, drawn ? [bytes.buffer, drawn] : [bytes.buffer]);
    }
  }
}

async function sameBytes(a: Blob, b: Blob): Promise<boolean> {
  if (a.size !== b.size) return false;
  const [x, y] = await Promise.all([a.arrayBuffer(), b.arrayBuffer()]).then((buffers) => buffers.map((buffer) => new Uint8Array(buffer)));
  return x!.every((byte, i) => byte === y![i]);
}

export interface Added {
  images: ReadonlyMap<ImagePath, Blob>;
  /** Where each accepted file went, in order. A file whose name and bytes the document already has reuses that path. */
  paths: ImagePath[];
}

/** Adds image files of the IMAGE_TYPES under free names. Files of other types are left out. */
export async function addImages(files: readonly File[], images: ReadonlyMap<ImagePath, Blob>): Promise<Added> {
  const next = new Map(images);
  const paths: ImagePath[] = [];
  for (const file of files.filter((f) => IMAGE_TYPES.has(f.type))) {
    const same = new Set<ImagePath>();
    for (const [path, blob] of next) if (await sameBytes(blob, file)) same.add(path);
    const path = freeName(withExtension(file.name, file.type), (p) => next.has(p) && !same.has(p));
    if (!next.has(path)) next.set(path, file);
    paths.push(path);
  }
  return { images: next, paths };
}
