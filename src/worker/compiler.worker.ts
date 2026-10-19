import { CompileFormatEnum, createTypstFontBuilder, type IncrementalServer, type TypstCompiler } from '@myriaddreamin/typst.ts/compiler';
import compilerWasm from '@myriaddreamin/typst-ts-web-compiler/wasm?url';
import type { MathCall } from '../convert/toTypst';
import type { Prelude } from '../customTheme';
import { type ImagePath, isLogoPath } from '../images';
import { type Advance, fitRuns } from '../linking/edges';
import { type ImageBox, type ImageMark, imageBoxes } from '../linking/imageBoxes';
import { type Bytes, type CustomRequest, type FromWorker, type LinkRequest, type Rev, type Start, type ThemeFailure, type ToWorker } from '../protocol';
import { type PageSettings, sameSettings, type ThemeId } from '../settings';
import { compileMarkdown, type Diagnostic } from '../typst/compileMarkdown';
import { createCompiler, MAIN_PATH, mainSource } from '../typst/compiler';
import { FONT_FILES, PACKAGE_FILES } from '../typst/files';
import { type CustomSource, preludeError, preludeFor, themeOf } from '../typst/themes';
import { measureFaces } from './advances';
import { FontFiles } from './fonts';
import { Linker, sourceAt, spotOf } from './linker';
import { type Edit, type ImageUpdate, Mailbox } from './mailbox';
import { drawSvgFrom, PageRaster, svgLongSide } from './raster';

declare const self: DedicatedWorkerGlobalScope;

const post = (message: FromWorker, transfer: Transferable[] = []) => self.postMessage(message, transfer);

let started: (publicUrl: URL) => void;
const publicUrl = new Promise<URL>((resolve) => (started = resolve));

const fetchBytes = async (path: string) => {
  const response = await fetch(new URL(path, await publicUrl));
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

/**
 * The compiler WebAssembly. On a first visit, before the service worker has cached anything, the download is long,
 * so its progress is posted as it arrives. Later visits get it from the service worker unchanged, which V8 keeps its
 * compiled code beside: a response rebuilt to count its bytes would lose that.
 */
async function compilerModule(): Promise<Response | string> {
  const cached = await caches.keys().then((names) => names.some((name) => name.startsWith('liveprint-')), () => false);
  if (cached) return compilerWasm;
  const response = await fetch(compilerWasm);
  if (!response.ok || !response.body) return response;
  // A compressed download's length counts compressed bytes, and the body yields them inflated.
  const total = response.headers.has('Content-Encoding') ? null : Number(response.headers.get('Content-Length')) || null;
  let loaded = 0;
  let posted = 0;
  const counted = response.body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        loaded += chunk.byteLength;
        if (performance.now() - posted > 100) {
          posted = performance.now();
          post({ kind: 'loading', loaded, total });
        }
        controller.enqueue(chunk);
      },
    }),
  );
  return new Response(counted, { headers: { 'Content-Type': 'application/wasm' } });
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
/** The prelude the Custom theme typesets with: the newest that compiled on its own. Null until one does. */
let custom: Prelude | null = null;

/** What a compile needs of the custom theme. The logo is the one among the images. */
const customSource = (): CustomSource | null => custom && { source: custom.text, logo: [...available].find(isLogoPath) ?? null };

/** Fits runs in the faces the theme sets text in that the browser could load. */
const fitterFor = (theme: ThemeId) => fitRuns(themeOf(theme).text.flatMap((path) => (faces.has(path) ? [{ path, advance: faces.get(path)! }] : [])));

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
  const theme = themeOf(next.theme);
  const report = (error: unknown) => failed(next.theme, { kind: 'fonts', message: errorText(error) });
  // Before the first compile there is nothing to keep showing, so the fallback is Book, which needs only the boot fonts.
  const fallBack = (error: unknown) => (report(error), applied ? false : applySettings({ ...next, theme: 'book' }));
  // The prelude failed on its own, and said so.
  if (next.theme === 'custom' && !custom) return applied ? false : applySettings({ ...next, theme: 'book' });
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

const failed = (theme: ThemeId, reason: ThemeFailure) => post({ kind: 'themeFailed', theme, showing: applied?.theme ?? 'book', reason });

/** A path of its own, so the document's main.typ, which the PDF and the image marks compile, stays as it is. */
const CHECK_PATH = '/prelude.typ';

/**
 * Takes the custom prelude if it compiles on its own, with an empty body, in the page settings on screen. An error
 * keeps the one before, and the theme on screen. A prelude that compiles can still fail on a real document: that
 * shows as any failed compile does.
 */
async function applyCustom({ id, prelude }: CustomRequest): Promise<boolean> {
  const changed = prelude?.text !== custom?.text;
  if (changed && prelude) {
    const settings: PageSettings = { paper: applied?.paper ?? 'a4', margins: applied?.margins ?? 'normal', theme: 'custom' };
    const source = { source: prelude.text, logo: [...available].find(isLogoPath) ?? null };
    let error: string | null;
    try {
      compiler.addSource(CHECK_PATH, mainSource(preludeFor(settings, null, source), ''));
      const { result, diagnostics = [] } = await compiler.compile({ mainFilePath: CHECK_PATH, diagnostics: 'full' });
      error = result ? null : (preludeError(settings, source, diagnostics) ?? 'it does not compile');
    } catch (e) {
      error = errorText(e);
    }
    if (error !== null) {
      failed('custom', { kind: 'prelude', id, name: prelude.name, error });
      return false;
    }
  }
  custom = prelude;
  post({ kind: 'custom', id });
  if (applied?.theme !== 'custom' || !changed) return false;
  if (!custom) applied = { ...applied, theme: 'book' };
  return true;
}

const diagnosticText = ({ package: pkg, path, range, severity, message }: Diagnostic) =>
  `${pkg ? `${pkg}@` : ''}${path}:${range.replace(/\d+/g, (n) => String(Number(n) + 1))}: ${severity}: ${message}`;

async function compileEdit({ rev, markdown }: Edit): Promise<void> {
  const settings = applied!;
  const theme = customSource();
  try {
    const { converted, result, diagnostics = [], convertMs, compileMs } = await compileMarkdown(markdown, (front) => preludeFor(settings, front, theme), available, rejected, (source) => {
      compiler.addSource(MAIN_PATH, source);
      return compiler.compile({ mainFilePath: MAIN_PATH, incrementalServer: server, diagnostics: 'full' });
    });
    if (!result) {
      post({ kind: 'failed', rev, diagnostics: diagnostics.map(diagnosticText) });
      return;
    }
    raster.merge(result);
    const { shownImages } = converted;
    linker.setDocument(converted.pieces, fitterFor(settings.theme), async () => (shownImages.length > 0 ? imageBoxes(await queryMarks(), shownImages) : []));
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
  const text = linked ? linker.textChanges(linked) : [];
  if (text.length > 0) post({ kind: 'text', pages: text });
  if (linked) askSharperSvgs(linked.images);
}

/**
 * Asks the main thread to draw again each SVG image that prints larger than its drawing, at the size it prints, in
 * steps of 256 pixels. It asks again after every compile until the new drawing is in; the main thread draws each
 * size once. Typst prints the SVG itself; only the preview uses the drawing.
 */
function askSharperSvgs(boxes: ImageBox[]): void {
  for (const { path, page, w, h } of boxes) {
    const drawn = svgLongSide(path);
    const prints = Math.max(w, h) * raster.pixelPerPt(page);
    if (drawn !== null && prints > drawn * 1.05) post({ kind: 'svgWanted', path, longSide: Math.ceil(prints / 256) * 256 });
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
  custom: applyCustom,
  images: applyImages,
  edit: compileEdit,
  view: (view) => raster.setView(view),
  pdf: compilePdf,
  link: answerLink,
  raster: rasterNext,
  yieldToInbox,
});
self.onmessage = ({ data }: MessageEvent<Start | ToWorker>) => {
  if (data.kind === 'start') return started(new URL(data.publicUrl));
  // A theme's fonts start downloading when it is chosen, even while the worker boots or compiles.
  if (data.kind === 'settings') fonts.load(themeOf(data.settings.theme).fonts).catch(() => {});
  mailbox.receive(data);
};

async function boot(): Promise<void> {
  const wasm = compilerModule();
  const [, packages] = await Promise.all([
    fonts.load(FONT_FILES),
    Promise.all(Object.entries(PACKAGE_FILES).map(async ([spec, path]) => [spec, await fetchTarball(path)] as const)),
  ]);
  const bootFonts = fonts.bytes(FONT_FILES);
  const measured = measureFaces(bootFonts, self.fonts);
  [compiler, raster] = await Promise.all([createCompiler({ wasm: await wasm, fonts: bootFonts, packages: new Map(packages) }), PageRaster.create()]);
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
