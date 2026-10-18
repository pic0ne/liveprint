# liveprint

A Markdown editor that typesets as you type. [Typst](https://typst.app) compiles each edit in the browser and redraws the changed pages in about 40 ms, so the preview is the PDF you download.

It runs at [liveprint.picone.dev](https://liveprint.picone.dev).

![Typing in liveprint: the typeset pages update on each keystroke with the latency overlay showing about 40 ms, then a click on a heading in the preview moves the editor cursor there, the arrow keys move a highlight through the preview, and a click on the pasted image puts the cursor in its Markdown and lays the highlight over the image](docs/demo.gif)

## Features

- Click a word or an image in the preview to move the cursor to its Markdown. Moving the cursor marks the same place in the preview.
- Select and copy text in the preview, as in a PDF viewer.
- Write LaTeX math between `$` signs. An incomplete formula shows as typed while the rest of the page keeps updating.
- Choose the Book, Paper, or Modern theme, A4 or US Letter, and narrow, normal, or wide margins. The choice applies to the preview and the PDF.
- Open and save `.md` files on disk. Pasted images are saved beside the file, as VS Code does.
- Use it offline after the first visit, or install it as an app from the address bar.

## How it works

Each edit goes to a Web Worker, which converts the Markdown to Typst source, compiles it incrementally, and draws only the pages that changed, visible pages first. The editor never waits for the worker. An edit that arrives while the worker is busy replaces any edit still waiting.

There is no server and no account. Documents stay in the browser's IndexedDB and in the files you save.

[How liveprint works](docs/how-it-works.md) covers the design, the linking algorithm, and the measurements behind them.

## Run locally

Requires Node.js 22.12 or later.

```sh
npm install
npm run dev     # start the dev server at http://localhost:5173
npm run build   # type-check and build the static site into dist/
```

`dist/` is a static site with a service worker. Serve it from any path on a static host. The first visit downloads about 33 MB, or 14 MB from a host that compresses, as GitHub Pages does. Most of it is the compiler, and later visits load from the cache.

## Tests

```sh
npm test                # run the unit tests
npm run check:linking   # click in the preview and follow the cursor, in each theme
npm run check:files     # open, save, restore, and drop files
npm run check:images    # paste, drop, save, and link images
npm run check:themes    # fail a theme's font download and recover
npm run check:browsers  # run the main paths in Chrome, Firefox, and WebKit
npm run bench:browser   # measure keystroke-to-preview latency
```

Most `check:` and `bench:` scripts drive headless Chrome over the DevTools protocol. `check:browsers` uses Playwright's Firefox and WebKit builds, which `npx playwright-core install firefox webkit` downloads. Firefox and Safari open and save through file dialogs and downloads instead of the File System Access API.

## License

liveprint is released under the [MIT License](LICENSE). Bundled fonts and Typst packages keep their upstream licenses, listed in [`public/fonts/LICENSES.md`](public/fonts/LICENSES.md) and [`public/packages/PROVENANCE.md`](public/packages/PROVENANCE.md).
