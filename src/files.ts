import { type Doc, type DocFile, isMarkdown } from './doc';
import { IMAGE_TYPES, type ImagePath, imagePath } from './images';

// The parts of the File System Access API that liveprint uses and TypeScript's DOM library lacks. Chromium only.
interface FilePickerType {
  description: string;
  accept: Record<string, string[]>;
}
type Permission = 'granted' | 'denied' | 'prompt';
type Mode = { mode: 'read' | 'readwrite' };
declare global {
  interface Window {
    showOpenFilePicker?(options: { types: FilePickerType[] }): Promise<FileSystemFileHandle[]>;
    showSaveFilePicker?(options: { suggestedName: string; types: FilePickerType[]; startIn?: FileSystemHandle }): Promise<FileSystemFileHandle>;
    showDirectoryPicker?(options: { mode: 'readwrite'; startIn?: FileSystemHandle }): Promise<FileSystemDirectoryHandle>;
  }
  interface FileSystemHandle {
    queryPermission?(descriptor: Mode): Promise<Permission>;
    requestPermission?(descriptor: Mode): Promise<Permission>;
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

const allowed = async (handle: FileSystemHandle, mode: Mode['mode']) => !handle.queryPermission || (await handle.queryPermission({ mode })) === 'granted';

/** Asks for write access when it is not granted yet. The ask needs the click or key that started the save. */
async function mayWrite(handle: FileSystemHandle): Promise<boolean> {
  if (await allowed(handle, 'readwrite')) return true;
  return (await handle.requestPermission?.({ mode: 'readwrite' })) === 'granted';
}

async function writeFile(handle: FileSystemFileHandle, data: string | Blob): Promise<void> {
  const writable = await handle.createWritable();
  await writable.write(data);
  await writable.close();
}

const notFound = (error: unknown) => error instanceof DOMException && (error.name === 'NotFoundError' || error.name === 'TypeMismatchError');

/** The folder that holds `path`, made when `create`. */
async function folderOf(folder: FileSystemDirectoryHandle, path: ImagePath, create: boolean): Promise<{ dir: FileSystemDirectoryHandle; name: string }> {
  const segments = path.split('/');
  const name = segments.pop()!;
  let dir = folder;
  for (const segment of segments) dir = await dir.getDirectoryHandle(segment, { create });
  return { dir, name };
}

/** The images at `paths` under `folder` that are there. */
export async function readImages(folder: FileSystemDirectoryHandle, paths: readonly ImagePath[]): Promise<Map<ImagePath, File>> {
  const found = new Map<ImagePath, File>();
  for (const path of paths) {
    try {
      const { dir, name } = await folderOf(folder, path, false);
      found.set(path, await (await dir.getFileHandle(name)).getFile());
    } catch (error) {
      if (!notFound(error)) throw error;
    }
  }
  return found;
}

/** Like readImages, but finds nothing unless reading the folder is allowed already, since it never asks. */
export async function imagesAllowed(folder: FileSystemDirectoryHandle, paths: readonly ImagePath[]): Promise<Map<ImagePath, File>> {
  return (await allowed(folder, 'read')) ? readImages(folder, paths) : new Map();
}

async function writeImages(folder: FileSystemDirectoryHandle, paths: readonly ImagePath[], images: ReadonlyMap<ImagePath, Blob>): Promise<void> {
  for (const path of paths) {
    const { dir, name } = await folderOf(folder, path, true);
    await writeFile(await dir.getFileHandle(name, { create: true }), images.get(path)!);
  }
}

/** Asks for the folder that holds `file`, or with no file, any folder. Null when the user cancels. */
async function pickFolder(file: DocFile): Promise<FileSystemDirectoryHandle | null> {
  try {
    const folder = await window.showDirectoryPicker!({ mode: 'readwrite', ...(file.handle && { startIn: file.handle }) });
    if (file.handle && (await folder.resolve(file.handle))?.length !== 1) throw new Error(`Choose the folder that contains ${file.name}`);
    return folder;
  } catch (error) {
    if (cancelled(error)) return null;
    throw error;
  }
}

/** The document's images that have bytes and are not beside its file yet, in the order the Markdown names them. */
const unsavedImages = (file: DocFile, images: ReadonlyMap<ImagePath, Blob>, referenced: readonly ImagePath[]) =>
  referenced.filter((path) => images.has(path) && !file.savedImages.has(path));

const withSaved = (file: DocFile, paths: Iterable<ImagePath>): DocFile => ({ ...file, savedImages: new Set([...file.savedImages, ...paths]) });

/**
 * The folder to write unsaved images into: the file's own, when liveprint has it, or the one the user chooses now.
 * Asking for the folder takes the click or key of the save, so it comes before any other ask: one grant on the
 * folder covers the file too. Null when there is nothing to write or no folder to write to.
 */
async function folderToWrite(file: DocFile, unsaved: readonly ImagePath[]): Promise<FileSystemDirectoryHandle | null> {
  if (unsaved.length === 0) return null;
  if (file.folder) return (await mayWrite(file.folder)) ? file.folder : null;
  return window.showDirectoryPicker ? pickFolder(file) : null;
}

/**
 * Writes `text` back to the file it came from, and the referenced images not yet beside it into its folder. Without a
 * writable handle, or with `as`, asks where to save it first; without the API, downloads it and those images under
 * their names. Returns where it now lives, or null when the user cancels.
 */
export async function saveFile(
  text: string,
  file: DocFile,
  images: ReadonlyMap<ImagePath, Blob>,
  referenced: readonly ImagePath[],
  as: boolean,
): Promise<DocFile | null> {
  const unsaved = unsavedImages(file, images, referenced);
  if (!as && file.handle) {
    const folder = await folderToWrite(file, unsaved);
    if (await mayWrite(file.handle)) {
      await writeFile(file.handle, text);
      if (folder) await writeImages(folder, unsaved, images);
      return withSaved({ ...file, saved: text, folder: folder ?? file.folder }, folder ? unsaved : []);
    }
  }
  if (!window.showSaveFilePicker) {
    download(file.name, new Blob([text], { type: 'text/markdown' }));
    for (const path of unsaved) download(path.split('/').pop()!, images.get(path)!);
    return withSaved({ ...file, saved: text }, unsaved);
  }
  let handle: FileSystemFileHandle;
  try {
    handle = await window.showSaveFilePicker({ suggestedName: file.name, types: MARKDOWN, ...(file.handle && { startIn: file.handle }) });
  } catch (error) {
    if (cancelled(error)) return null;
    throw error;
  }
  await writeFile(handle, text);
  // The picker took the click, so the folder is kept only if the new file is right in it and writing it is allowed.
  const folder = file.folder && (await file.folder.resolve(handle))?.length === 1 ? file.folder : null;
  const saved: DocFile = { name: handle.name, handle, saved: text, folder, savedImages: folder ? file.savedImages : new Set() };
  if (!folder || !(await allowed(folder, 'readwrite'))) return saved;
  const toWrite = unsavedImages(saved, images, referenced);
  await writeImages(folder, toWrite, images);
  return withSaved(saved, toWrite);
}

/** Without the API: every file in a folder the user chooses, by its path inside that folder. Null when cancelled. */
function pickFolderFiles(): Promise<Map<string, File> | null> {
  const input = Object.assign(document.createElement('input'), { type: 'file', webkitdirectory: true });
  return new Promise((resolve) => {
    input.addEventListener('change', () =>
      resolve(new Map([...(input.files ?? [])].map((f) => [f.webkitRelativePath.split('/').slice(1).join('/'), f]))),
    );
    input.addEventListener('cancel', () => resolve(null));
    input.click();
  });
}

export interface Chosen {
  file: DocFile;
  images: ReadonlyMap<ImagePath, Blob>;
}

/**
 * Asks for the folder of the file, reads the referenced images the document lacks from it, and writes the ones not
 * yet beside the file into it. A folder chosen before that lost its grant after a reload is asked for again instead
 * of picked. Without the API, the folder is read through a file input, and nothing is written. Null when cancelled.
 */
export async function chooseFolder(file: DocFile, images: ReadonlyMap<ImagePath, Blob>, referenced: readonly ImagePath[]): Promise<Chosen | null> {
  const lacking = referenced.filter((path) => !images.has(path));
  if (!window.showDirectoryPicker) {
    const files = await pickFolderFiles();
    if (!files) return null;
    const found = new Map(lacking.flatMap((path) => (files.has(path) ? [[path, files.get(path)!] as const] : [])));
    return { file: withSaved(file, found.keys()), images: new Map([...images, ...found]) };
  }
  const folder = file.folder && (await mayWrite(file.folder)) ? file.folder : await pickFolder(file);
  if (!folder) return null;
  const found = await readImages(folder, lacking);
  // An untitled document is not in the folder yet, so its images are written only when it is saved there.
  const unsaved = file.handle ? unsavedImages(file, images, referenced) : [];
  await writeImages(folder, unsaved, images);
  return { file: withSaved({ ...file, folder }, [...found.keys(), ...unsaved]), images: new Map([...images, ...found]) };
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
