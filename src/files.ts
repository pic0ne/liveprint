import { type Doc, type DocFile, isMarkdown } from './doc';
import { IMAGE_TYPES, type ImagePath, imagePath } from './images';

// The parts of the File System Access API that liveprint uses and TypeScript's DOM library lacks. Chromium only.
interface FilePickerType {
  description: string;
  accept: Record<string, string[]>;
}
type Permission = 'granted' | 'denied' | 'prompt';
declare global {
  interface Window {
    showOpenFilePicker?(options: { types: FilePickerType[] }): Promise<FileSystemFileHandle[]>;
    showSaveFilePicker?(options: { suggestedName: string; types: FilePickerType[]; startIn?: FileSystemHandle }): Promise<FileSystemFileHandle>;
  }
  interface FileSystemHandle {
    queryPermission?(descriptor: { mode: 'readwrite' }): Promise<Permission>;
    requestPermission?(descriptor: { mode: 'readwrite' }): Promise<Permission>;
  }
  interface DataTransferItem {
    getAsFileSystemHandle?(): Promise<FileSystemHandle | null>;
  }
}

const MARKDOWN: FilePickerType[] = [{ description: 'Markdown', accept: { 'text/markdown': ['.md', '.markdown'] } }];

/** A cancelled picker rejects with AbortError. */
const cancelled = (error: unknown) => error instanceof DOMException && error.name === 'AbortError';

export function download(name: string, blob: Blob): void {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href));
}

const NO_IMAGES = { folder: null, savedImages: new Set<ImagePath>() };

async function read(handle: FileSystemFileHandle): Promise<Doc> {
  const text = await (await handle.getFile()).text();
  return { text, file: { name: handle.name, handle, saved: text, ...NO_IMAGES }, images: new Map() };
}

/** Without the API: the opened file is read, and saving it again is a download. */
async function readCopy(file: File): Promise<Doc> {
  const text = await file.text();
  return { text, file: { name: file.name, handle: null, saved: text, ...NO_IMAGES }, images: new Map() };
}

/** Asks for a Markdown file. Null when the user cancels. */
export async function openFile(): Promise<Doc | null> {
  if (window.showOpenFilePicker) {
    try {
      const [handle] = await window.showOpenFilePicker({ types: MARKDOWN });
      return handle ? await read(handle) : null;
    } catch (error) {
      if (cancelled(error)) return null;
      throw error;
    }
  }
  const input = Object.assign(document.createElement('input'), { type: 'file', accept: '.md,.markdown,text/markdown,text/plain' });
  const file = await new Promise<File | null>((resolve) => {
    input.addEventListener('change', () => resolve(input.files?.[0] ?? null));
    input.addEventListener('cancel', () => resolve(null));
    input.click();
  });
  return file ? readCopy(file) : null;
}

async function mayWrite(handle: FileSystemFileHandle): Promise<boolean> {
  if (!handle.queryPermission || !handle.requestPermission) return true;
  if ((await handle.queryPermission({ mode: 'readwrite' })) === 'granted') return true;
  return (await handle.requestPermission({ mode: 'readwrite' })) === 'granted';
}

async function write(handle: FileSystemFileHandle, text: string, file: DocFile): Promise<DocFile> {
  const writable = await handle.createWritable();
  await writable.write(text);
  await writable.close();
  return handle === file.handle ? { ...file, saved: text } : { name: handle.name, handle, saved: text, ...NO_IMAGES };
}

/**
 * Writes `text` back to the file it came from. Without a writable handle, or with `as`, asks where to save it first;
 * without the API, downloads it under its current name. Returns where it now lives, or null when the user cancels.
 */
export async function saveFile(text: string, file: DocFile, as: boolean): Promise<DocFile | null> {
  if (!as && file.handle && (await mayWrite(file.handle))) return write(file.handle, text, file);
  if (!window.showSaveFilePicker) {
    download(file.name, new Blob([text], { type: 'text/markdown' }));
    return { ...file, saved: text };
  }
  try {
    const handle = await window.showSaveFilePicker({ suggestedName: file.name, types: MARKDOWN, ...(file.handle && { startIn: file.handle }) });
    return await write(handle, text, file);
  } catch (error) {
    if (cancelled(error)) return null;
    throw error;
  }
}

/**
 * The first Markdown file in a drop, read through a file handle when the browser gives one, so that saving writes
 * back to it, with the images dropped beside it as its images. Null when the drop has no such file. Call it during
 * the drop event: its items are gone once that ends.
 */
export function droppedFile(data: DataTransfer): Promise<Doc> | null {
  const item = [...data.items].find((it) => {
    const file = it.kind === 'file' ? it.getAsFile() : null;
    return file !== null && isMarkdown(file);
  });
  if (!item) return null;
  const file = item.getAsFile()!;
  const handle = item.getAsFileSystemHandle?.();
  const images = new Map<ImagePath, Blob>();
  for (const image of data.files) {
    const path = IMAGE_TYPES.has(image.type) ? imagePath(image.name) : null;
    if (path) images.set(path, image);
  }
  return (async () => {
    const h = await handle?.catch(() => null);
    const doc = h instanceof FileSystemFileHandle ? await read(h) : await readCopy(file);
    return { ...doc, file: { ...doc.file, savedImages: new Set(images.keys()) }, images };
  })();
}
