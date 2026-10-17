import type { Doc, DocFile } from './doc';
import type { ImagePath } from './images';

// The document in the editor, kept in IndexedDB so a reload, crash or discarded tab never loses typed text. One
// record; structured clone keeps the file and folder handles, so Save still writes to the same file after a reload.
// Its images are a store of their own, written only when they change, so typing never writes their bytes again.
const DB = 'liveprint';
const STORE = 'doc';
const IMAGES = 'images';
const KEY = 'last';

let db: Promise<IDBDatabase> | null = null;

const done = <T>(request: IDBRequest<T>) =>
  new Promise<T>((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });

function open(): Promise<IDBDatabase> {
  db ??= new Promise((resolve, reject) => {
    const request = indexedDB.open(DB, 2);
    request.onupgradeneeded = ({ oldVersion }) => {
      if (oldVersion < 1) request.result.createObjectStore(STORE);
      if (oldVersion < 2) request.result.createObjectStore(IMAGES);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  return db;
}

/** A version 1 record has no folder and no saved images. */
function parse(value: unknown, images: ReadonlyMap<ImagePath, Blob>): Doc | null {
  const doc = value as Partial<Doc> | undefined;
  const file = doc?.file as Partial<DocFile> | undefined;
  const valid =
    typeof doc?.text === 'string' &&
    typeof file?.name === 'string' &&
    typeof file.saved === 'string' &&
    (file.handle === null || file.handle?.kind === 'file');
  if (!valid) return null;
  const folder = file.folder?.kind === 'directory' ? file.folder : null;
  const savedImages = file.savedImages instanceof Set ? file.savedImages : new Set<ImagePath>();
  return { text: doc.text!, file: { name: file.name!, handle: file.handle!, saved: file.saved!, folder, savedImages }, images };
}

/** The document as last kept, with its images, or null if there is none. */
export async function restoreDoc(): Promise<Doc | null> {
  const transaction = (await open()).transaction([STORE, IMAGES]);
  const images = transaction.objectStore(IMAGES);
  const [record, paths, blobs] = await Promise.all([
    done(transaction.objectStore(STORE).get(KEY)),
    done(images.getAllKeys()),
    done(images.getAll()),
  ]);
  const kept = new Map<ImagePath, Blob>();
  paths.forEach((path, i) => {
    if (typeof path === 'string' && blobs[i] instanceof Blob) kept.set(path as ImagePath, blobs[i]);
  });
  return parse(record, kept);
}

/** Keeps the text and where it lives. Images are kept apart, so typing never writes their bytes again. */
export async function keepDoc(doc: Omit<Doc, 'images'>): Promise<void> {
  await done((await open()).transaction(STORE, 'readwrite').objectStore(STORE).put(doc, KEY));
}

/** Replaces the kept images with these, in one transaction. */
export async function keepImages(images: ReadonlyMap<ImagePath, Blob>): Promise<void> {
  const transaction = (await open()).transaction(IMAGES, 'readwrite');
  const store = transaction.objectStore(IMAGES);
  store.clear();
  for (const [path, blob] of images) store.put(blob, path);
  await new Promise<void>((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = transaction.onabort = () => reject(transaction.error);
  });
}
