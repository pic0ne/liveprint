/** Font files by their path under public/, each fetched at most once at a time. A failed fetch is tried again on the next load. */
export class FontFiles {
  readonly #fetch: (path: string) => Promise<Uint8Array>;
  readonly #loading = new Map<string, Promise<Uint8Array>>();
  readonly #loaded = new Map<string, Uint8Array>();

  constructor(fetch: (path: string) => Promise<Uint8Array>) {
    this.#fetch = fetch;
  }

  has(paths: readonly string[]): boolean {
    return paths.every((path) => this.#loaded.has(path));
  }

  async load(paths: readonly string[]): Promise<void> {
    await Promise.all(paths.map((path) => this.#loading.get(path) ?? this.#start(path)));
  }

  #start(path: string): Promise<Uint8Array> {
    const loading = this.#fetch(path).then(
      (bytes) => (this.#loaded.set(path, bytes), bytes),
      (error: unknown) => {
        this.#loading.delete(path);
        throw error;
      },
    );
    this.#loading.set(path, loading);
    return loading;
  }

  /** Loaded files only. */
  bytes(paths: readonly string[]): Uint8Array[] {
    return paths.map((path) => this.#loaded.get(path)!);
  }

  /** Every loaded file's path, in the order it arrived. */
  get paths(): string[] {
    return [...this.#loaded.keys()];
  }
}
