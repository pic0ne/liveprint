/** Editor revision. Every edit the main thread sends gets the next one. */
export type Rev = number & { readonly __brand: 'Rev' };

export const firstRev = 0 as Rev;
export const nextRev = (rev: Rev) => (rev + 1) as Rev;

/** Owns a whole, non-shared buffer, so it can be transferred. */
export type Bytes = Uint8Array<ArrayBuffer>;

export type ToWorker =
  | { kind: 'edit'; rev: Rev; markdown: string }
  | { kind: 'pdf'; rev: Rev };

export type FromWorker =
  | { kind: 'ready'; bootMs: number }
  | { kind: 'frame'; rev: Rev; delta: Bytes; convertMs: number; compileMs: number }
  | { kind: 'failed'; rev: Rev; diagnostics: string[] }
  | { kind: 'pdf'; rev: Rev; bytes: Bytes };
