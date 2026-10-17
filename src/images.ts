/** A local image as the Markdown names it, relative to the document's folder: "cat.png", "figures/plot.svg". */
export type ImagePath = string & { readonly __brand: 'ImagePath' };

function decoded(text: string): string {
  try {
    return decodeURIComponent(text);
  } catch {
    return text;
  }
}

/** Parses a Markdown image URL. Null for remote or data URLs, absolute paths, and paths that leave the folder. */
export function imagePath(url: string): ImagePath | null {
  const bare = url.trim().replace(/^<(.*)>$/, '$1').replace(/[?#].*$/, '');
  if (/^[a-z][a-z0-9+.-]*:/i.test(bare) || bare.startsWith('/')) return null;
  const segments = decoded(bare)
    .split('/')
    .filter((segment) => segment !== '.');
  if (segments.length === 0 || segments.some((segment) => segment === '' || segment === '..')) return null;
  return segments.join('/') as ImagePath;
}

/** The types Typst and the renderer both read. Anything else is refused at insert with a message naming these. */
export const IMAGE_TYPES: ReadonlySet<string> = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/svg+xml']);

export const IMAGE_TYPE_NAMES = 'PNG, JPEG, GIF, WebP and SVG';

/** A free name for an inserted image: its file name with spaces and unsafe characters made "-", then "-2", "-3"... Unicode letters stay. */
export function freeName(name: string, taken: (path: ImagePath) => boolean): ImagePath {
  const safe = (part: string) => part.replace(/[^\p{L}\p{M}\p{N}._-]+/gu, '-').replace(/^[-.]+|[-.]+$/g, '');
  const dot = name.lastIndexOf('.');
  const ext = dot >= 0 ? safe(name.slice(dot + 1)) : '';
  const stem = safe(dot >= 0 ? name.slice(0, dot) : name) || 'image';
  for (let n = 1; ; n++) {
    const path = `${stem}${n === 1 ? '' : `-${n}`}${ext ? `.${ext}` : ''}` as ImagePath;
    if (!taken(path)) return path;
  }
}
