import { CompileFormatEnum, type IncrementalServer, type TypstCompiler } from '@myriaddreamin/typst.ts/compiler';
import compilerWasm from '@myriaddreamin/typst-ts-web-compiler/wasm?url';
import { convert } from '../convert/toTypst';
import { fittedEdges } from '../linking/edges';
import type { Bytes, FromWorker, LinkRequest, Rev, ToWorker } from '../protocol';
import { createCompiler, FONT_FILES, MAIN_PATH, mainSource, PACKAGE_FILES } from '../typst/compiler';
import { preludeFor } from '../typst/themes';
import { measureFaces } from './advances';
import { Linker } from './linker';
import { type Edit, Mailbox } from './mailbox';
import { PageRaster } from './raster';

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
let raster: PageRaster;
let linker: Linker;

interface Compiled {
  rev: Rev;
  convertMs: number;
  compileMs: number;
}
/** The compile whose document the raster holds. */
let shown: Compiled | null = null;

/** Draws the next batch. A background batch whose pages all kept their cache key is not posted, unless it was the last. */
async function drawNext(compiled: Compiled, background: boolean): Promise<void> {
  const { bitmaps, rasterMs } = await raster.draw();
  if (background && bitmaps.length === 0 && !raster.final) return;
  post({ kind: 'pages', ...compiled, sizes: raster.sizes, bitmaps, final: raster.final, rasterMs }, bitmaps.map((b) => b.bitmap));
}

async function compileEdit({ rev, markdown }: Edit): Promise<void> {
  const t0 = performance.now();
  const { typst, pieces } = convert(markdown);
  const t1 = performance.now();
  compiler.addSource(MAIN_PATH, mainSource(preludeFor({ paper: 'a4', margins: 'normal', theme: 'book' }), typst));
  try {
    const { result, diagnostics = [] } = await compiler.compile({
      mainFilePath: MAIN_PATH,
      incrementalServer: server,
      diagnostics: 'unix',
    });
    const t2 = performance.now();
    if (!result) {
      post({ kind: 'failed', rev, diagnostics });
      return;
    }
    raster.merge(result);
    linker.setDocument(pieces);
    shown = { rev, convertMs: t1 - t0, compileMs: t2 - t1 };
    await drawNext(shown, false);
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

async function rasterNext(): Promise<boolean> {
  if (!shown || raster.final) return false;
  try {
    await drawNext(shown, true);
    return true;
  } catch (error) {
    // Stop the background pass instead of retrying the same page forever; the next compile or view restarts it.
    post({ kind: 'failed', rev: shown.rev, diagnostics: [errorText(error)] });
    return false;
  }
}

/** Answers from the document on screen. Before the first compile, or if reading the text layer fails, there is nothing to link. */
async function answerLink(request: LinkRequest): Promise<void> {
  const linked = shown ? await linker.linked().catch(() => null) : null;
  switch (request.kind) {
    case 'source':
      post({ kind: 'sourced', id: request.id, offset: linked?.index.sourceAt(request.page, request.fx, request.fy) ?? null });
      break;
    case 'locate':
      post({ kind: 'located', id: request.id, spot: linked?.index.spotOf(request.offset) ?? null });
      break;
    case 'runs':
      post({ kind: 'runs', id: request.id, pages: linked?.pages ?? [] });
      break;
  }
}

const mailbox = new Mailbox({
  edit: compileEdit,
  view: (view) => raster.setView(view),
  pdf: compilePdf,
  link: answerLink,
  raster: rasterNext,
  yieldToInbox,
});
self.onmessage = (event: MessageEvent<ToWorker>) => mailbox.receive(event.data);

async function boot(): Promise<void> {
  const [fonts, packages] = await Promise.all([
    Promise.all(FONT_FILES.map(fetchBytes)),
    Promise.all(Object.entries(PACKAGE_FILES).map(async ([spec, path]) => [spec, await fetchTarball(path)] as const)),
  ]);
  const faces = measureFaces(fonts, self.fonts);
  [compiler, raster] = await Promise.all([createCompiler({ wasm: compilerWasm, fonts, packages: new Map(packages) }), PageRaster.create()]);
  linker = new Linker(raster, fittedEdges(await faces));
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
