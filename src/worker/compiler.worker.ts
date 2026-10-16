import { CompileFormatEnum, type IncrementalServer, type TypstCompiler } from '@myriaddreamin/typst.ts/compiler';
import compilerWasm from '@myriaddreamin/typst-ts-web-compiler/wasm?url';
import { toTypst } from '../convert/toTypst';
import type { Bytes, FromWorker, Rev, ToWorker } from '../protocol';
import { createCompiler, FONT_FILES, MAIN_PATH, mainSource, PACKAGE_FILES } from '../typst/compiler';
import prelude from '../typst/prelude.typ?raw';
import { type Edit, Mailbox } from './mailbox';

declare const self: DedicatedWorkerGlobalScope;

const post = (message: FromWorker, transfer: Transferable[] = []) => self.postMessage(message, transfer);

const fetchBytes = async (path: string) => {
  const response = await fetch(new URL(`${import.meta.env.BASE_URL}${path}`, self.location.origin));
  if (!response.ok) throw new Error(`${path}: HTTP ${response.status}`);
  return new Uint8Array(await response.arrayBuffer());
};

// Static servers (Vite's included) send `.tar.gz` with `Content-Encoding: gzip`, so fetch may hand back the
// inflated tar. typst.ts only untars gzip, so restore it.
async function fetchTarball(path: string): Promise<Uint8Array> {
  const bytes = await fetchBytes(path);
  if (bytes[0] === 0x1f && bytes[1] === 0x8b) return bytes;
  const gzipped = new Blob([bytes]).stream().pipeThrough(new CompressionStream('gzip'));
  return new Uint8Array(await new Response(gzipped).arrayBuffer());
}

/** withIncrementalServer frees the server when its callback settles, so this callback never does. */
const openIncrementalServer = (compiler: TypstCompiler) =>
  new Promise<IncrementalServer>((resolve) => {
    void compiler.withIncrementalServer((server) => {
      resolve(server);
      return new Promise<never>(() => {});
    });
  });

const inbox = new MessageChannel();
const yieldToInbox = () =>
  new Promise<void>((resolve) => {
    inbox.port1.onmessage = () => resolve();
    inbox.port2.postMessage(null);
  });

// wasm-bindgen copies results out of wasm memory into a fresh ArrayBuffer.
const owned = (bytes: Uint8Array) => bytes as Bytes;

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

let compiler: TypstCompiler;
let server: IncrementalServer;

async function compileEdit({ rev, markdown }: Edit): Promise<void> {
  const t0 = performance.now();
  const body = toTypst(markdown);
  const t1 = performance.now();
  compiler.addSource(MAIN_PATH, mainSource(prelude, body));
  try {
    const { result, diagnostics = [] } = await compiler.compile({
      mainFilePath: MAIN_PATH,
      incrementalServer: server,
      diagnostics: 'unix',
    });
    const t2 = performance.now();
    if (result) post({ kind: 'frame', rev, delta: owned(result), convertMs: t1 - t0, compileMs: t2 - t1 }, [result.buffer]);
    else post({ kind: 'failed', rev, diagnostics });
  } catch (error) {
    post({ kind: 'failed', rev, diagnostics: [errorText(error)] });
  }
}

async function compilePdf(rev: Rev): Promise<void> {
  try {
    const { result, diagnostics = [] } = await compiler.compile({
      mainFilePath: MAIN_PATH,
      format: CompileFormatEnum.pdf,
      diagnostics: 'unix',
    });
    if (result) post({ kind: 'pdf', rev, bytes: owned(result) }, [result.buffer]);
    else post({ kind: 'failed', rev, diagnostics });
  } catch (error) {
    post({ kind: 'failed', rev, diagnostics: [errorText(error)] });
  }
}

const mailbox = new Mailbox({ edit: compileEdit, pdf: compilePdf, yieldToInbox });
self.onmessage = (event: MessageEvent<ToWorker>) => mailbox.receive(event.data);

async function boot(): Promise<void> {
  const [fonts, packages] = await Promise.all([
    Promise.all(FONT_FILES.map(fetchBytes)),
    Promise.all(Object.entries(PACKAGE_FILES).map(async ([spec, path]) => [spec, await fetchTarball(path)] as const)),
  ]);
  compiler = await createCompiler({ wasm: compilerWasm, fonts, packages: new Map(packages) });
  server = await openIncrementalServer(compiler);
  post({ kind: 'ready', bootMs: performance.now() });
  mailbox.booted();
}

// Rethrown from a task so it surfaces as the Worker's `error` event, which a rejected promise would not.
boot().catch((error) =>
  setTimeout(() => {
    throw error;
  }),
);
