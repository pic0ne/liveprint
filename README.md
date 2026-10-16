# liveprint

Write Markdown on the left and see the real PDF pages on the right while you type. The preview is the typeset document itself, not an HTML approximation: Typst compiles it in your browser, and **Download .pdf** gives you the same pages you see.

Everything runs on the client. There is no server.

## Speed

Keystroke to updated preview, measured on [`src/sample.md`](src/sample.md) (6 A4 pages, about 3,000 words, with tables, code and LaTeX math):

| Edit | p50 | p95 | Main-thread tasks over 16 ms |
|---|---|---|---|
| Typing inside a heading | 45.2 ms | 59.7 ms | 0 |
| Adding paragraphs near the top, which reflows every later page | 24.9 ms | 65.3 ms | 0 |

Each row is 60 real keystrokes, 150 ms apart, sent to headless Chrome over the DevTools protocol. Chrome used software rendering (SwiftShader) for these runs, so a browser with GPU raster should do at least as well, but that is not measured yet. To reproduce the table, run:

```bash
npm run bench:browser
```

To see the live numbers in the app, press **Alt+D**.

Where the time goes, for a typical keystroke:

- About 2.5 ms converts the Markdown to Typst source.
- About 5–10 ms compiles it incrementally.
- About 23 ms draws the edited page into a bitmap. This is the limiter.
- The rest is messaging and waiting for the next frame.

All of that runs in a Web Worker. The main thread only runs the editor and swaps finished page bitmaps into place, which takes about 0.1 ms. Typing never waits for the preview.

## How it works

1. The editor (CodeMirror 6) sends the full Markdown text to a worker on every change.
2. The worker keeps only the newest edit. Older edits that arrive while it is busy are dropped, never compiled.
3. [`src/convert/toTypst.ts`](src/convert/toTypst.ts) converts the Markdown to Typst source with the same lezer parser the editor uses. Math between `$` signs is passed to [mitex](https://github.com/mitex-rs/mitex), so ordinary LaTeX works.
4. typst.ts compiles the source incrementally and produces a delta of the changed layout.
5. The worker draws the pages whose content changed into `OffscreenCanvas` bitmaps. Visible pages go first. Off-screen pages are drawn afterwards and stop as soon as a newer edit arrives.
6. The main thread puts each bitmap into its page's `<canvas>`. A page keeps its old bitmap until the new one is ready, so the preview never goes blank or flickers.

### Why not cmarker

[cmarker](https://typst.app/universe/package/cmarker) converts Markdown inside Typst and works in typst.ts. liveprint converts in JavaScript instead for two measured reasons:

- cmarker evaluates the whole document again on every keystroke. Its incremental compile took 19.6 ms against 10.8–11.5 ms for the JavaScript path (`npm run bench`).
- Source positions in cmarker's output point into a string it builds at compile time, not into your Markdown. Linking a click in the preview back to the editor needs real positions.

### Why canvas and not SVG

Rendering the pages as one SVG put about 21,000 elements in the page. Chrome then spent about 30 ms of main-thread layout and paint on every frame, including frames where only the editor changed. With the SVG preview, keystroke to preview was 98.7 ms at p50 and the editor stuttered. Moving to per-page canvases drawn in the worker fixed both.

## Run it

```bash
npm install
npm run dev
```

Other scripts:

- `npm test` runs the converter, scheduler and compile tests.
- `npm run build` type-checks and builds to `dist/`.
- `npm run bench` compares compile cost of cmarker and the JavaScript converter in Node.
- `npm run bench:browser` measures keystroke latency in headless Chrome.

## Status

This is the first milestone: the pipeline works end to end and the speed is measured. Not built yet:

- Two-way linking between the editor and the preview.
- Page settings and themes.
- Offline support and opening and saving local files.
- Images. Image syntax renders its alt text for now.
- Text selection in the preview.

Known limits:

- The compiler WebAssembly is 28 MB, or 10.8 MB gzipped, so the first load is slow until a service worker caches it.
- A LaTeX formula that is not valid yet, such as `\frac{1` while you type, stops the compile. The preview keeps the last good pages and shows the error until the formula is valid again.

## Licence

liveprint is released under the [MIT licence](LICENSE).

### Bundled assets

Bundled fonts and Typst packages are listed with their licences in [`public/fonts/LICENSES.md`](public/fonts/LICENSES.md) and [`public/packages/PROVENANCE.md`](public/packages/PROVENANCE.md).
