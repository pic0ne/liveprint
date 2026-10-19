import type { Doc, DocFile } from './doc';
import type { ImagePath } from './images';
import { listRecent, type Recent } from './recent';

// The document in each tab, kept in IndexedDB so a reload, crash or discarded tab never loses typed text. One record
// per tab; structured clone keeps the file and folder handles, so Save still writes to the same file after a reload.
// Its images are a store of their own, keyed by record and path, written only when they change, so typing never
// writes their bytes again.
//
// A tab finds its record again by the id in its sessionStorage, which survives a reload and reopening a closed tab.
// While a tab is open it holds a Web Lock named after its record, so no other tab takes that record. A new tab takes
// the newest record no open tab holds. A tab moves to another record by holding it and letting go of its own.
const DB = 'liveprint';
const DOCS = 'docs';
const IMAGES = 'images';
/** Versions 1 and 2 kept one document, under this key of this store, and its images under their paths alone. */
const LEGACY_DOC = 'doc';
const LEGACY_KEY = 'last';
const SESSION_KEY = 'liveprint.doc';
/** Records past this many, newest first, are deleted when a tab starts, unless a tab holds them. */
const KEEP = 10;

/** A kept record: the document of one tab. */
export type DocId = string & { readonly __brand: 'DocId' };

interface Kept {
  text: string;
  file: DocFile;
  /** When the record was last written, in ms since the epoch. */
  keptAt: number;
}

/**
 * An image as kept: its bytes and type, not a Blob, since WebKit's private browsing hangs on putting a Blob into
 * IndexedDB, and every write after it waits. Records from before this kept Blobs, which still read.
 */
interface KeptImage {
  type: string;
  bytes: ArrayBuffer;
}

const imageOf = (value: unknown): Blob | null =>
  value instanceof Blob ? value : value && (value as KeptImage).bytes instanceof ArrayBuffer ? new Blob([(value as KeptImage).bytes], { type: (value as KeptImage).type }) : null;

let db: Promise<IDBDatabase> | null = null;

const done = <T>(request: IDBRequest<T>) =>
  new Promise<T>((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });

export const completed = (transaction: IDBTransaction) =>
  new Promise<void>((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = transaction.onabort = () => reject(transaction.error);
  });

const newId = () => crypto.randomUUID() as DocId;
const lockName = (id: DocId) => `liveprint-doc-${id}`;
/** Every image key of one record. Arrays sort after strings, so `[id, []]` comes after every `[id, path]`. */
const imagesOf = (id: DocId) => IDBKeyRange.bound([id], [id, []]);

/** Version 3 moves the one document of version 1 or 2, and its images, into a record of its own. */
function upgrade(request: IDBOpenDBRequest, oldVersion: number): void {
  const database = request.result;
  const transaction = request.transaction!;
  const docs = database.createObjectStore(DOCS);
  const images = oldVersion < 2 ? database.createObjectStore(IMAGES) : transaction.objectStore(IMAGES);
  if (oldVersion < 1) return;
  const id = newId();
  transaction.objectStore(LEGACY_DOC).get(LEGACY_KEY).onsuccess = ({ target }) => {
    const value = (target as IDBRequest<Omit<Kept, 'keptAt'> | undefined>).result;
    if (value) docs.put({ ...value, keptAt: 0 }, id);
    database.deleteObjectStore(LEGACY_DOC);
  };
  if (oldVersion < 2) return;
  const legacy = IDBKeyRange.upperBound([], true);
  images.getAllKeys(legacy).onsuccess = ({ target }) => {
    const paths = (target as IDBRequest<IDBValidKey[]>).result;
    images.getAll(legacy).onsuccess = ({ target }) => {
      const blobs = (target as IDBRequest<Blob[]>).result;
      paths.forEach((path, i) => images.put(blobs[i], [id, path as string]));
      images.delete(legacy);
    };
  };
}

function open(): Promise<IDBDatabase> {
  db ??= new Promise((resolve, reject) => {
    const request = indexedDB.open(DB, 3);
    request.onupgradeneeded = ({ oldVersion }) => upgrade(request, oldVersion);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  return db;
}

/** A version 1 record has no folder and no saved images. */
function parse(value: unknown, images: ReadonlyMap<ImagePath, Blob>): Doc | null {
  const doc = value as Partial<Kept> | undefined;
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

async function read(id: DocId): Promise<Doc | null> {
  const transaction = (await open()).transaction([DOCS, IMAGES]);
  const images = transaction.objectStore(IMAGES);
  const [record, keys, values] = await Promise.all([
    done(transaction.objectStore(DOCS).get(id)),
    done(images.getAllKeys(imagesOf(id))),
    done(images.getAll(imagesOf(id))),
  ]);
  const kept = new Map<ImagePath, Blob>();
  keys.forEach((key, i) => {
    const path = (key as [DocId, string])[1];
    const image = imageOf(values[i]);
    if (typeof path === 'string' && image) kept.set(path as ImagePath, image);
  });
  return parse(record, kept);
}

/** Every record, unparsed. */
async function records(): Promise<{ id: DocId; value: unknown }[]> {
  const transaction = (await open()).transaction(DOCS);
  const store = transaction.objectStore(DOCS);
  const [ids, values] = await Promise.all([done(store.getAllKeys()), done(store.getAll())]);
  return ids.map((id, i) => ({ id: id as DocId, value: values[i] }));
}

const keptAt = (value: unknown) => (value as Partial<Kept> | undefined)?.keptAt ?? 0;

/** Every record's id, newest first. */
async function newestFirst(): Promise<DocId[]> {
  return (await records()).sort((a, b) => keptAt(b.value) - keptAt(a.value)).map(({ id }) => id);
}

/** How to let go of each record this tab holds. */
const releases = new Map<DocId, () => void>();

/**
 * Holds the lock on a record until `letGo`, if no other tab holds it. True when this tab now holds it. Without Web
 * Locks, every record is free.
 */
function hold(id: DocId): Promise<boolean> {
  if (!navigator.locks) return Promise.resolve(true);
  return new Promise((resolve) => {
    navigator.locks
      .request(lockName(id), { ifAvailable: true }, (lock) => {
        resolve(lock !== null);
        return lock ? new Promise<void>((release) => releases.set(id, release)) : undefined;
      })
      .catch(() => resolve(false));
  });
}

/** Lets another tab take the record. */
export function letGo(id: DocId): void {
  releases.get(id)?.();
  releases.delete(id);
}

/** Deletes these records, except the ones an open tab holds. */
async function remove(ids: readonly DocId[]): Promise<void> {
  const held = new Set((await navigator.locks?.query())?.held?.map((lock) => lock.name));
  ids = ids.filter((id) => !held.has(lockName(id)));
  if (ids.length === 0) return;
  const transaction = (await open()).transaction([DOCS, IMAGES], 'readwrite');
  for (const id of ids) {
    transaction.objectStore(DOCS).delete(id);
    transaction.objectStore(IMAGES).delete(imagesOf(id));
  }
  await completed(transaction);
}

export interface Claimed {
  /** The record this tab keeps its document in. */
  id: DocId;
  /** The document to show, or null for a new one. */
  doc: Doc | null;
  /** Whether nothing was kept before: a first visit. */
  first: boolean;
}

/**
 * Finds this tab's document: its own record after a reload, a copy of it in a duplicated tab, or else the newest
 * record no open tab holds. Deletes records past the newest few that no tab holds.
 */
export async function claimDoc(): Promise<Claimed> {
  let own: DocId | null = null;
  try {
    own = sessionStorage.getItem(SESSION_KEY) as DocId | null;
  } catch {}
  const ids = await newestFirst();
  const claim = (id: DocId, doc: Doc | null): Claimed => {
    try {
      sessionStorage.setItem(SESSION_KEY, id);
    } catch {}
    void remove(ids.slice(KEEP).filter((old) => old !== id)).catch(() => {});
    return { id, doc, first: ids.length === 0 };
  };

  if (own && ids.includes(own)) {
    if (await hold(own)) return claim(own, await read(own));
    // A duplicated tab copies its sessionStorage, so the tab it came from holds the record: take a copy.
    const copy = newId();
    await hold(copy);
    const doc = await read(own);
    if (doc) {
      await keepDoc(copy, doc);
      await keepImages(copy, doc.images);
    }
    return claim(copy, doc);
  }
  for (const id of ids) {
    if (await hold(id)) return claim(id, await read(id));
  }
  const id = newId();
  await hold(id);
  return claim(id, null);
}

/** The kept documents other than `current`, newest first, each saying whether another tab holds it. */
export async function recentDocs(current: DocId): Promise<Recent[]> {
  const [all, locks] = await Promise.all([records(), navigator.locks?.query()]);
  const held = new Set(locks?.held?.map((lock) => lock.name));
  return listRecent(
    all.flatMap(({ id, value }) => {
      const doc = parse(value, new Map());
      return doc ? [{ id, text: doc.text, file: doc.file, keptAt: keptAt(value), elsewhere: held.has(lockName(id)) }] : [];
    }),
    current,
  );
}

/**
 * Moves this tab onto the record `id`: holds it, reads it and names it in sessionStorage, so a reload comes back to
 * it. Null when another tab holds it. The record the tab leaves stays held until `letGo`, so the writes still on their
 * way to it land before another tab can take it.
 */
export async function takeDoc(id: DocId): Promise<Doc | null> {
  if (!(await hold(id))) return null;
  const doc = await read(id).catch((error: unknown) => {
    letGo(id);
    throw error;
  });
  if (!doc) {
    letGo(id);
    throw new Error('it is no longer kept in this browser');
  }
  try {
    sessionStorage.setItem(SESSION_KEY, id);
  } catch {}
  return doc;
}

/** Keeps the text and where it lives. Images are kept apart, so typing never writes their bytes again. */
export async function keepDoc(id: DocId, doc: Omit<Doc, 'images'>): Promise<void> {
  const record: Kept = { text: doc.text, file: doc.file, keptAt: Date.now() };
  await done((await open()).transaction(DOCS, 'readwrite').objectStore(DOCS).put(record, id));
}

/** Replaces the record's kept images with these, in one transaction. */
export async function keepImages(id: DocId, images: ReadonlyMap<ImagePath, Blob>): Promise<void> {
  const kept = await Promise.all([...images].map(async ([path, blob]) => [path, { type: blob.type, bytes: await blob.arrayBuffer() }] as const));
  const transaction = (await open()).transaction(IMAGES, 'readwrite');
  const store = transaction.objectStore(IMAGES);
  store.delete(imagesOf(id));
  for (const [path, image] of kept) store.put(image satisfies KeptImage, [id, path]);
  await completed(transaction);
}
