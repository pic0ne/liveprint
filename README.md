# liveprint

A Markdown editor that shows the real PDF pages as you type.

![Typing in liveprint: the typeset pages update on each keystroke with the latency overlay showing about 40 ms, then a click on a heading in the preview moves the editor cursor there, the arrow keys move a highlight through the preview, and a click on the pasted image puts the cursor in its Markdown and lays the highlight over the image](docs/demo.gif)

The preview is the typeset document, not an HTML approximation. Typst compiles it in your browser, and **Download .pdf** saves the same pages you see. There is no server and no account, and nothing you write leaves your machine.

## Typing never waits

A keystroke reaches the typeset page in about 40 ms on a seven-page document. Compiling and drawing run in a Web Worker, only the pages that changed are redrawn, and a new edit replaces any edit still waiting to compile. Press **Alt+D** to see the timings live.

## What it does

- **Two-way linking.** Click a word or an image in the preview, and the cursor moves to it in the Markdown. Move the cursor, and the preview marks the same place.
- **LaTeX math.** Write formulas between `$` signs. While a formula is still incomplete, it shows as typed and the rest of the page keeps updating.
- **Page settings.** Choose the Book, Paper, or Modern theme, A4 or US Letter, and narrow, normal, or wide margins.
- **Real files.** Open and save `.md` files on disk, with their images beside them. Paste or drop an image to add it.
- **Offline.** After the first visit, the app needs no network. You can install it from the address bar.

## How it works

1. CodeMirror sends the Markdown to a worker on every change. The worker keeps only the newest edit.
2. A converter turns the Markdown into Typst source and passes math to [mitex](https://github.com/mitex-rs/mitex).
3. typst.ts compiles the source incrementally and draws the changed pages into `OffscreenCanvas` bitmaps, visible pages first.
4. The main thread swaps each finished bitmap into place, so the preview never goes blank.

[How liveprint works](docs/how-it-works.md) covers the design decisions, the linking algorithm, and the measurements behind them.

## Run it

```bash
npm install
npm run dev
```

`npm test` runs the unit tests, and `npm run build` type-checks and builds to `dist/`. The browser checks and benchmarks are listed under [Scripts](docs/how-it-works.md#scripts).

## Limits

- The first visit downloads the 28 MB compiler, 11 MB gzipped. Later visits load it from the cache.
- Only Chrome is tested. Firefox and Safari open and save through file dialogs and downloads.
- If a file changes on disk while it is open, **Save** overwrites the change.
- Text selection in the preview is not built yet.

The full list is under [Known limits](docs/how-it-works.md#known-limits).

## Licence

liveprint is released under the [MIT licence](LICENSE). Bundled fonts and Typst packages are listed with their licences in [`public/fonts/LICENSES.md`](public/fonts/LICENSES.md) and [`public/packages/PROVENANCE.md`](public/packages/PROVENANCE.md).
