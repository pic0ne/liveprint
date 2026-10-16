import { CompileFormatEnum, createTypstFontBuilder, type IncrementalServer, type TypstCompiler } from '@myriaddreamin/typst.ts/compiler';
import compilerWasm from '@myriaddreamin/typst-ts-web-compiler/wasm?url';
import { convert } from '../convert/toTypst';
import { type Advance, fittedEdges } from '../linking/edges';
import { type Bytes, type FromWorker, firstRev, type LinkRequest, type Rev, type ToWorker } from '../protocol';
import { type PageSettings, sameSettings, type ThemeId } from '../settings';
import { createCompiler, MAIN_PATH, mainSource } from '../typst/compiler';
import { FONT_FILES, PACKAGE_FILES } from '../typst/files';
import { preludeFor, THEMES } from '../typst/themes';
import { measureFaces } from './advances';
import { FontFiles } from './fonts';
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

const fonts = new FontFiles(fetchBytes);
/** Every font the compiler has, by path. */
const installed = new Set<string>();
/** Advances of the installed fonts the browser could load, by path. */
const faces = new Map<string, Advance>();
/** What the compiler typesets with; null until the first settings arrive. */
let applied: PageSettings | null = null;
/** The newest settings asked for, which wait while their fonts download. */
let wanted: PageSettings | null = null;

/** The faces a fresh session in this theme would measure with, so fonts of themes visited before cannot be picked. */
const edgesFor = (theme: ThemeId) => fittedEdges([...FONT_FILES, ...THEMES[theme].fonts].flatMap((path) => faces.get(path) ?? []));

function addFaces(paths: string[], advances: (Advance | null)[]): void {
  paths.forEach((path, i) => {
    installed.add(path);
    const advance = advances[i];
    if (advance) faces.set(path, advance);
  });
}

interface Compiled {
  rev: Rev;
  settings: PageSettings;
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

/** Gives the compiler every font loaded so far, the ones it had included, and measures the new ones for linking. */
async function installFonts(): Promise<void> {
  const paths = fonts.paths;
  const added = paths.filter((path) => !installed.has(path));
  const builder = createTypstFontBuilder();
  await builder.init({ getModule: () => compilerWasm });
  for (const bytes of fonts.bytes(paths)) await builder.addFontData(bytes);
  const [measured] = await Promise.all([
    measureFaces(fonts.bytes(added), self.fonts),
    builder.build(async (resolver) => compiler.setFonts(resolver)),
  ]);
  addFaces(added, measured);
}

/**
 * Applies the settings once their theme's fonts are in. Until then the previous settings stay, so the preview keeps
 * up with typing, and the settings are asked for again when the download ends. Only the first settings wait for it.
 */
async function applySettings(next: PageSettings): Promise<boolean> {
  wanted = next;
  const theme = THEMES[next.theme];
  const report = (error: unknown) =>
    post({ kind: 'failed', rev: shown?.rev ?? firstRev, diagnostics: [`Could not load the ${theme.label} fonts: ${errorText(error)}`] });
  // Before the first compile there is nothing to keep showing, so the fallback is Book, which needs only the boot fonts.
  const fallBack = (error: unknown) => (report(error), applied ? false : applySettings({ ...next, theme: 'book' }));
  if (!fonts.has(theme.fonts)) {
    const loaded = fonts.load(theme.fonts);
    if (applied) {
      void loaded.then(() => mailbox.receive({ kind: 'settings', settings: wanted! }), report);
      return false;
    }
    try {
      await loaded;
    } catch (error) {
      return fallBack(error);
    }
  }
  if (theme.fonts.some((path) => !installed.has(path))) {
    try {
      await installFonts();
    } catch (error) {
      return fallBack(error);
    }
  }
  if (applied && sameSettings(applied, next)) return false;
  applied = next;
  return true;
}

async function compileEdit({ rev, markdown }: Edit): Promise<void> {
  const settings = applied!;
  const t0 = performance.now();
  const { typst, pieces } = convert(markdown);
  const t1 = performance.now();
  compiler.addSource(MAIN_PATH, mainSource(preludeFor(settings), typst));
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
    linker.setDocument(pieces, edgesFor(settings.theme));
    shown = { rev, settings, convertMs: t1 - t0, compileMs: t2 - t1 };
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
  settings: applySettings,
  edit: compileEdit,
  view: (view) => raster.setView(view),
  pdf: compilePdf,
  link: answerLink,
  raster: rasterNext,
  yieldToInbox,
});
self.onmessage = ({ data }: MessageEvent<ToWorker>) => {
  // A theme's fonts start downloading when it is chosen, even while the worker boots or compiles.
  if (data.kind === 'settings') fonts.load(THEMES[data.settings.theme].fonts).catch(() => {});
  mailbox.receive(data);
};

async function boot(): Promise<void> {
  const [, packages] = await Promise.all([
    fonts.load(FONT_FILES),
    Promise.all(Object.entries(PACKAGE_FILES).map(async ([spec, path]) => [spec, await fetchTarball(path)] as const)),
  ]);
  const bootFonts = fonts.bytes(FONT_FILES);
  const measured = measureFaces(bootFonts, self.fonts);
  [compiler, raster] = await Promise.all([createCompiler({ wasm: compilerWasm, fonts: bootFonts, packages: new Map(packages) }), PageRaster.create()]);
  addFaces([...FONT_FILES], await measured);
  linker = new Linker(raster);
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
