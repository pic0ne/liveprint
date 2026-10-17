import type { Doc } from './doc';

// The document in the editor, kept in IndexedDB so a reload, crash or discarded tab never loses typed text. One
// record; structured clone keeps the file handle, so Save still writes to the same file after a reload.
const DB = 'liveprint';
const STORE = 'doc';
const KEY = 'last';

let db: Promise<IDBDatabase> | null = null;

const done = <T>(request: IDBRequest<T>) =>
  new Promise<T>((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });

function open(): Promise<IDBDatabase> {
  db ??= new Promise((resolve, reject) => {
    const request = indexedDB.open(DB, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  return db;
}

function parse(value: unknown): Doc | null {
  const doc = value as Partial<Doc> | undefined;
  const file = doc?.file;
  const valid =
    typeof doc?.text === 'string' &&
    typeof file?.name === 'string' &&
    typeof file.saved === 'string' &&
    (file.handle === null || file.handle?.kind === 'file');
  return valid ? (doc as Doc) : null;
}

/** The document as last kept, or null if there is none. */
export async function restoreDoc(): Promise<Doc | null> {
  const store = (await open()).transaction(STORE).objectStore(STORE);
  return parse(await done(store.get(KEY)));
}

export async function keepDoc(doc: Doc): Promise<void> {
  await done((await open()).transaction(STORE, 'readwrite').objectStore(STORE).put(doc, KEY));
}
