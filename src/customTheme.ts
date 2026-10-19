import { completed } from './restore';

// The custom theme, kept in a database of its own: a new version of the documents' database would wait, blocked,
// while a tab of an older build holds it open. It belongs to the browser, like the page settings, not to a document.
const DB = 'liveprint-theme';
const STORE = 'theme';
const KEY = 'custom';

/** A Typst prelude the user loaded, which the Custom theme typesets with. */
export interface Prelude {
  name: string;
  text: string;
}

/** Bytes, not a Blob, for the reason restore.ts gives. */
export interface Logo {
  name: string;
  type: string;
  bytes: ArrayBuffer;
}

export interface CustomTheme {
  prelude: Prelude;
  logo: Logo | null;
}

export const logoBlob = (logo: Logo) => new Blob([logo.bytes], { type: logo.type });

let db: Promise<IDBDatabase> | null = null;

/**
 * The connection, opened once. It closes when a newer build asks for a new version, so that build is not blocked
 * while this tab stays open, and a failed or closed one is opened again on the next call.
 */
function open(): Promise<IDBDatabase> {
  db ??= new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(DB, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE);
    request.onsuccess = () => {
      const connection = request.result;
      connection.onversionchange = () => {
        connection.close();
        db = null;
      };
      connection.onclose = () => (db = null);
      resolve(connection);
    };
    request.onerror = () => reject(request.error);
  }).catch((error: unknown) => {
    db = null;
    throw error;
  });
  return db;
}

const done = <T>(request: IDBRequest<T>) =>
  new Promise<T>((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });

type Stored = Partial<Record<string, unknown>> | null | undefined;

function parse(value: unknown): CustomTheme | null {
  const prelude = (value as Stored)?.prelude as Stored;
  const logo = (value as Stored)?.logo as Stored;
  if (typeof prelude?.name !== 'string' || typeof prelude.text !== 'string') return null;
  return { prelude: { name: prelude.name, text: prelude.text }, logo: logoOf(logo) };
}

function logoOf(logo: Stored): Logo | null {
  if (typeof logo?.name !== 'string' || typeof logo.type !== 'string' || !(logo.bytes instanceof ArrayBuffer)) return null;
  return { name: logo.name, type: logo.type, bytes: logo.bytes };
}

export async function readCustomTheme(): Promise<CustomTheme | null> {
  return parse(await done((await open()).transaction(STORE).objectStore(STORE).get(KEY)));
}

/** Keeps the custom theme, or removes it for null. Resolves once the write is committed, which a full disk can still abort. */
export async function keepCustomTheme(theme: CustomTheme | null): Promise<void> {
  const transaction = (await open()).transaction(STORE, 'readwrite');
  const store = transaction.objectStore(STORE);
  if (theme) store.put(theme, KEY);
  else store.delete(KEY);
  await completed(transaction);
}
