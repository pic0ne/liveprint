import { CompileFormatEnum, createTypstFontBuilder, type IncrementalServer, type TypstCompiler } from '@myriaddreamin/typst.ts/compiler';
import compilerWasm from '@myriaddreamin/typst-ts-web-compiler/wasm?url';
import type { MathCall } from '../convert/toTypst';
import type { ImagePath } from '../images';
import { type Advance, fittedEdges } from '../linking/edges';
import { type ImageMark, imageBoxes } from '../linking/imageBoxes';
import { type Bytes, type FromWorker, type LinkRequest, type Rev, type ToWorker } from '../protocol';
import { type PageSettings, sameSettings, type ThemeId } from '../settings';
import { compileMarkdown, type Diagnostic } from '../typst/compileMarkdown';
import { createCompiler, MAIN_PATH } from '../typst/compiler';
import { FONT_FILES, PACKAGE_FILES } from '../typst/files';
import { preludeFor, THEMES } from '../typst/themes';
import { measureFaces } from './advances';
import { FontFiles } from './fonts';
import { Linker, sourceAt, spotOf } from './linker';
import { type Edit, type ImageUpdate, Mailbox } from './mailbox';
import { drawSvgFrom, PageRaster } from './raster';

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
/** The images the compiler has, at `/images/<path>`. */
const available = new Set<ImagePath>();
/** Formulas mitex rejected, with its message, that the newest Markdown still has. */
const rejected = new Map<MathCall, string>();
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
  images: ImagePath[];
  mathErrors: string[];
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
  const report = (error: unknown) => post({ kind: 'fontsFailed', theme: next.theme, showing: applied?.theme ?? 'book', message: errorText(error) });
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

const diagnosticText = ({ package: pkg, path, range, severity, message }: Diagnostic) =>
  `${pkg ? `${pkg}@` : ''}${path}:${range.replace(/\d+/g, (n) => String(Number(n) + 1))}: ${severity}: ${message}`;

async function compileEdit({ rev, markdown }: Edit): Promise<void> {
  const settings = applied!;
  try {
    const { converted, result, diagnostics = [], convertMs, compileMs } = await compileMarkdown(markdown, preludeFor(settings), available, rejected, (source) => {
      compiler.addSource(MAIN_PATH, source);
      return compiler.compile({ mainFilePath: MAIN_PATH, incrementalServer: server, diagnostics: 'full' });
    });
    if (!result) {
      post({ kind: 'failed', rev, diagnostics: diagnostics.map(diagnosticText) });
      return;
    }
    raster.merge(result);
    const { shownImages } = converted;
    linker.setDocument(converted.pieces, edgesFor(settings.theme), async () => (shownImages.length > 0 ? imageBoxes(await queryMarks(), shownImages) : []));
    const mathErrors = converted.typedMath.map((call) => rejected.get(call)!);
    shown = { rev, settings, images: converted.images, mathErrors, convertMs, compileMs };
    await drawNext(shown, false);
  } catch (error) {
    post({ kind: 'failed', rev, diagnostics: [errorText(error)] });
  }
}

/**
 * The `linked-image` marks of the newest compile, which say where its images print. Asked when linking first needs
 * them after a compile, which is after the edited pages are posted, and a world compiled from the same source reuses
 * the compile's work. If a newer compile failed, the world does not compile, and the images are left out.
 */
const queryMarks = () =>
  compiler.runWithWorld({ mainFilePath: MAIN_PATH }, async (world) => {
    await world.compile();
    return world.query<ImageMark[]>({ selector: '<liveprint-image>', field: 'value' });
  });

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
      post({ kind: 'sourced', id: request.id, offset: linked ? sourceAt(linked, request.page, request.fx, request.fy) : null });
      break;
    case 'locate':
      post({ kind: 'located', id: request.id, spot: linked ? spotOf(linked, request.offset) : null });
      break;
    case 'runs':
      post({ kind: 'runs', id: request.id, pages: linked?.pages ?? [] });
      break;
  }
}

function applyImages(updates: ImageUpdate[]): void {
  for (const { path, bytes, drawn } of updates) {
    if (bytes) {
      compiler.mapShadow(`/images/${path}`, bytes);
      available.add(path);
    } else {
      compiler.unmapShadow(`/images/${path}`);
      available.delete(path);
    }
    drawSvgFrom(path, bytes, drawn);
  }
}

const mailbox = new Mailbox({
  settings: applySettings,
  images: applyImages,
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
