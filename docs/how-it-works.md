# How liveprint works

The design behind liveprint and the numbers that decided it. For an overview, see the [README](../README.md).

## Speed

Keystroke to updated preview, on [`src/sample.md`](../src/sample.md) (7 A4 pages in the Book theme, about 3,000 words, with tables, code and LaTeX math):

| Edit | p50 | p95 |
|---|---|---|
| Typing inside a heading | 41.3 ms | 53.1 ms |
| Adding paragraphs near the top, which reflows every later page | 24.4 ms | 60.8 ms |

Each row is 60 keystrokes, 150 ms apart, in headless Chrome with software rendering, and the median of three runs. No main-thread task took over 16 ms. To reproduce the table, run `npm run bench:browser`. To see live numbers in the app, press **Alt+D**.

For a typical keystroke, converting the Markdown takes about 2.5 ms, compiling 5 to 10 ms, and drawing the edited page about 23 ms. Drawing is the limit. All of it runs in a Web Worker. The main thread runs the editor and swaps finished page bitmaps into place, which takes about 0.1 ms, so typing never waits for the preview.

## The pipeline

1. The editor (CodeMirror 6) sends the full Markdown text to a worker on every change.
2. The worker keeps only the newest edit. An edit that arrives while the worker is busy replaces the one waiting.
3. [`src/convert/toTypst.ts`](../src/convert/toTypst.ts) converts the Markdown to Typst source with the same lezer parser the editor uses. Math between `$` signs goes to [mitex](https://github.com/mitex-rs/mitex), so ordinary LaTeX works.
4. typst.ts compiles the source incrementally.
5. The worker draws the pages whose content changed into `OffscreenCanvas` bitmaps, visible pages first. It draws off-screen pages afterwards and stops when a newer edit arrives.
6. The main thread puts each bitmap into its page's `<canvas>`. A page keeps its old bitmap until the new one is ready, so the preview never goes blank.

liveprint converts Markdown in JavaScript rather than with the [cmarker](https://typst.app/universe/package/cmarker) Typst package. cmarker evaluates the whole document on every keystroke (19.6 ms per compile, against about 11 ms here, from `npm run bench`), and the source positions in its output do not point into your Markdown, which linking needs.

The preview is one canvas per page rather than SVG. The SVG preview put about 21,000 elements in the page, and Chrome spent about 30 ms of layout and paint on every frame, so keystroke to preview was 98.7 ms and the editor stuttered.

## Two-way linking

Click a word in the preview and the editor cursor moves into that word. Move the cursor and the preview marks the same place with a pale band over the line and a thin bar at the character. If that line is out of sight, the preview scrolls to it, unless you scrolled the preview yourself in the last second.

A Markdown paragraph is usually one long source line, so liveprint links by character, not by line. typst.ts 0.7.0 cannot map a click to the source, so liveprint matches the printed text against the Markdown:

1. The converter returns the Typst source and every piece of Markdown text it copied into it, with each piece's offset. Math and generated text, such as list numbers, have no pieces.
2. After a compile, when a click or cursor move first needs it, the worker reads each page's text layer. typst.ts builds this HTML for text selection, with every run of text and its position. A page whose content did not change keeps its runs.
3. Both texts are reduced to lowercase letters and digits, so curly quotes, hyphenation and ligatures cannot make them differ. A Myers diff pairs them, in about 3 ms on the sample.
4. Every printed character now has a Markdown offset. A character the diff did not pair takes its share of the Markdown between its paired neighbours.

The text layer gives only where a run starts and how wide it is. To place each character, the worker measures the run in each font the theme uses, word by word so that kerning counts. It picks the font whose spaces would need the least stretching to fill the run, and gives the remaining width to the spaces, where justification put it.

Inside a formula, linking pairs each printed letter or digit with the LaTeX that prints it. The converter lists the formula's letters and digits, operator names such as `\sin`, and Greek letters such as `\alpha`. Any other symbol, such as an arrow, takes its share of the LaTeX between its neighbours.

Footnotes and table of contents entries print out of the Markdown's order: a footnote at the foot of its page, an entry before its heading. The diff needs both texts in order, so the converter marks their pieces as asides, which it leaves out. A second diff pairs the asides with the printed characters the first left unpaired. A click on footnote text then goes to its definition and a click on an entry to its heading, while a cursor in a heading still marks the heading in the text.

The worker answers linking requests after it posts the edited page and before it draws off-screen pages, so linking does not change keystroke latency. A click gets its Markdown offset back in about 8 ms.

### Selecting text

Drag across the preview to select text, or double-click a word, and copy it with **Ctrl+C**. Each page has its text layer as transparent HTML over its canvas, as in a PDF viewer, and the browser does the selecting. Each run is set in the font the worker fitted it to, so a selection covers its printed letters.

A block behind the runs covers each layer. Without it, a drag passing between two lines was over the layer itself, and next to a small superscript such as a footnote number Chrome took that for a new start, so the selection stopped growing.

The text layers are hidden while you type in the editor, and show when the pointer moves in the preview or the editor loses focus. Kept visible, they added layout and paint to every redraw and produced main-thread tasks over 16 ms.

## Formulas that are not valid yet

While you type a formula, its LaTeX is often invalid for a few keys, as in `\frac{1`. That formula then shows as typed, in a grey monospace face, and the rest of the page keeps updating. A line in the corner of the preview says why, for example **A formula shows as typed: missing argument: den**.

Typst stops at the first error, and a document cannot catch one, so the worker finds the formula from the error:

1. The error points inside mitex. A hint after it points at the formula's call in the generated source, such as `mi("\\frac{1")`.
2. The worker reads the call's text at that place and marks it as rejected. The call's text is the key, so no positions need tracking.
3. The converter shows every rejected call as typed, and the worker compiles again. Each round removes one formula from the compile, so this always ends.

A rejected call stays rejected while the document still has it, so typing elsewhere costs no extra compile. A key that leaves a formula invalid costs about 7 ms more, because it compiles twice. Before this, 240 of the 694 keys that type the sample's formulas failed to compile, and the preview fell behind by 664 ms at the median. `node bench/browser.mjs --math` measures it.

## Page settings

The button left of the download buttons names the current paper, margins and theme, for example **A4 · Normal · Book**. Its menu has three choices:

- Paper: A4 or US Letter. The first visit picks US Letter in the countries that use it and A4 elsewhere.
- Margins: narrow (18 mm), normal (25 mm) or wide (35 mm).
- Theme: Book (Libertinus Serif, justified, indented paragraphs), Paper (New Computer Modern, numbered sections, like a LaTeX article) or Modern (IBM Plex Sans, ragged right).

A choice applies to the preview and to **Download .pdf**, and the browser keeps it for the next visit. The theme preludes are in [`src/typst/themes/`](../src/typst/themes), and [`src/typst/themes.ts`](../src/typst/themes.ts) lists the fonts each needs.

Book uses the fonts that load at start-up. Paper (2.2 MB of fonts) and Modern (890 KB) download their fonts when you first choose them, and the preview stays in the previous theme until they arrive, about 200 ms over loopback. If the download fails, the preview stays in the previous theme, the menu goes back to it, and a line says what failed. Choosing the theme again retries.

## Front matter

A YAML block between `---` lines at the top of a document gives its title, authors and date:

```yaml
---
title: A field guide to the printed page
author: [Ada Byron, Robert Bringhurst]
date: 2026-10-18
---
```

Each theme prints them as a title block, and the PDF takes them as its title, author and creation date. `author` takes one name or a list, and other keys are ignored. The editor shows the block's rules and keys in the grey of other Markdown syntax.

The block counts as front matter only when a `---` or `...` line closes it and every line between is one YAML could hold: a key, a list item, an indented line, a comment or a blank line. A rule at the top of a document, or front matter half typed, stays a rule and the text under it stays in the preview. liveprint reads the three keys with a small parser of its own instead of a YAML library.

A `date` written as `YYYY-MM-DD`, with or without a time, is printed in the theme's format and becomes the PDF's date. Typst's `date` takes only a real day, so any other date, such as `Spring 2026` or `2026-02-30`, prints as written and leaves the PDF without a date, rather than with one the page does not show.

The printed title and authors link both ways, like body text. A date printed in the theme's format is generated text, like a list number, so it has no Markdown to link to.

### Running header

From page 2 on, each theme prints the title in a running header, or the date when there is no title: Book in italics, Paper in small capitals, and Modern with the title on the left and the date on the right. Page 1 is the title page and has no header. Front matter can only open a document, so the title block is always on page 1. Page numbers stay in the footer, as each theme had them.

The header has no setting of its own. A document has one when its front matter gives a title or a date, so the document decides, while page settings belong to the browser and apply to every document. The header is generated text, so it has no Markdown to link to.

## Footnotes and contents

`[^label]` refers to a footnote whose text a `[^label]: …` line gives, anywhere in the document, as on GitHub. Later lines of the same footnote are indented four spaces. Each footnote prints at the foot of the page that refers to it first, and later references repeat its number. A reference to a footnote that has no definition shows as typed.

A `[[toc]]` line prints a table of contents of the headings to level 3, with their page numbers, where the line is. A line rather than a front matter key lets the writer place it, after an introduction for example, and a click on the **Contents** title lands on that line.

Footnote text and contents entries link both ways, as the linking section describes. A footnote first referred to in a heading prints again at its next reference: the table of contents prints the heading a second time, and Typst lets a footnote's label occur only once.

## Files

**Open** (Ctrl+O) reads a Markdown file and **Save** (Ctrl+S) writes it back. **Shift+Ctrl+S**, or Shift-click on **Save**, saves under a new name. You can also drop a `.md`, `.markdown` or `.txt` file on the app, with its images. The bar shows the file's name, and **Edited** while the text differs from what was last opened or saved. **Download .pdf** names the PDF after the file.

In Chrome and Edge, liveprint uses the File System Access API and keeps the file handle, so **Save** writes to the same file without asking. Firefox and Safari do not have the API. There, **Open** uses the file dialog and **Save** downloads the file.

Opening another file or closing the tab with unsaved changes asks first.

When another program changes the open file, liveprint notices when its tab comes back into view, or when the browser reports it through `FileSystemObserver`. With no unsaved changes, it takes the new text as one change that **Ctrl+Z** undoes. With unsaved changes, the bar shows **Changed on disk** and a **Reload** button, and **Save** asks before it overwrites. This needs the File System Access API.

Each tab keeps its document in IndexedDB as you type: its text, name, images and, in Chrome, its file handle and folder. This covers a crash, a closed laptop or a discarded tab. A reload brings back that tab's own document, because the tab's sessionStorage names its record, and a Web Lock keeps other tabs off it. A new tab takes the newest document that no open tab holds. liveprint keeps the 10 newest documents. Images are stored as bytes, not Blobs, because WebKit's private browsing hangs on putting a Blob into IndexedDB.

The button joined to **Open** lists the other kept documents, newest first, with each one's name, when it was last edited and its first line. It leaves out this tab's own document and empty untitled ones. A document open in another tab is listed but cannot be opened here: two tabs on one record would overwrite each other's text, and opening a copy would fork the document without saying so. Opening a listed document moves the tab onto its record and does not change when it was last edited. The document the tab leaves stays in its own record, unsaved text included, and shows in the list, so nothing is discarded and liveprint does not ask first.

## Images

Paste an image, or drop an image file on the editor, and liveprint writes `![](image.png)` at the cursor. The image is in the first preview drawn after the paste. An image alone in its paragraph is centred at its natural size, scaled down to the column if wider. PNG, JPEG, GIF, WebP and SVG work.

A pasted file keeps its name, with unsafe characters changed to `-`. A different image under a taken name becomes `image-2.png`. Pasting the same bytes again reuses the first name.

### Where the image files go

The Markdown records a path relative to the `.md` file, and the image goes beside it, as VS Code does. GitHub and other Markdown tools then show the same images.

- **In this browser.** IndexedDB keeps the document's images in their own store, written only when the images change.
- **With the File System Access API** (Chrome and Edge). **Save** writes the `.md` and every image not in its folder yet. A file handle cannot reach its folder, so the first save with images asks for the folder that holds the file.
- **Without the API** (Firefox and Safari). **Save** downloads the `.md` and each image not downloaded before, so they land side by side in your downloads folder.

A browser lets one click open only one picker. When the first save of an untitled document uses it for the save picker, the bar says **1 image not saved beside notes.md** with a **Choose folder** button.

When the Markdown names an image liveprint does not have, the preview shows a dashed frame with its alt text, and the bar offers **Choose folder** to read the images from the file's folder. Remote images, `data:` URLs and paths that leave the folder, such as `../shared/x.png`, are not loaded.

### Linking an image

A click on an image puts the cursor inside its Markdown. With the cursor inside `![…](…)`, the preview lays the band over the whole image.

An image prints no text, so the text layer has nothing for it. The converter wraps each image in `linked-image`, which places zero-size marks for the image's corner, its height and its natural size. The worker reads the marks with Typst's `query`, in document order, and pairs them with the images' Markdown, which the converter lists in the same order. The marks hold no offsets, so they add at most 0.5 ms to a compile.

### SVG in the preview

typst.ts draws an SVG with `new Image()`, which a worker does not have. The main thread draws each SVG and sends the bitmap to the worker. When an SVG prints larger than its drawing, the worker asks for a sharper one, in steps of 256 pixels up to 16 million pixels. Only the preview uses the drawing. The PDF keeps the SVG as vectors.

### Cost

Typing with three images in the sample (a 0.23 MB PNG, a 4.42 MB photo and an SVG chart) is no slower than without them. Pasting the 4.42 MB photo takes about 370 ms from paste to paint. The renderer process grows by about 65 MB, most of it likely the photo's 48 MB of decoded pixels. To measure it, run `node bench/browser.mjs --images`.

## Offline

A service worker caches the app after the first visit: the page, scripts, both WebAssembly files, the start-up fonts and the mitex package, about 33 MB. A theme's fonts are cached the first time you choose it, in a cache named after a hash of those fonts, so app updates keep them. Later visits make no network requests, and you can install the app from the address bar.

The service worker is hand-written in [`src/sw.ts`](../src/sw.ts). A small Vite plugin, [`build/serviceWorker.ts`](../build/serviceWorker.ts), adds a hash of the built files to `sw.js`, so any change to the build installs a new version on the next visit. An open page keeps the version it started with, and the new one shows on the visit after. The service worker registers after the first pages show, so it does not compete with the first download.

Time from navigation to the first page, in headless Chrome against `vite preview`:

| Visit | 50 Mbit/s | Loopback |
|---|---|---|
| First | 7.4 s | 1.1 s |
| Second | 1.1 s | 1.1 s |
| Third and later | 0.75 s | 0.75 s |
| Offline | 0.75 s | 0.75 s |

The second visit is about 330 ms slower than later ones. It is the first to compile the compiler from the service worker's copy, and V8 stores the compiled code only after that. Making the first visit compile from the cache would cost it as much as the second saves, so the design stays. From the third visit on, the first full compile of the document, about 420 ms, is the limit.

On a first visit, the preview shows the compiler's download progress, such as **Downloading the typesetter, 4.9 of 28.3 MB**.

To measure it, run:

```bash
npm run build
node bench/load.mjs --runs 2 --warm 3 --throttle 50 --offline
```

If the system temp folder is a small `tmpfs`, Chrome can fail to cache the 28 MB WebAssembly file and the bench prints `service worker: none`. Set `TMPDIR` to a folder on disk.

## Hosting

liveprint is served at <https://liveprint.picone.dev> from GitHub Pages. The build uses `base: './'` in [`vite.config.ts`](../vite.config.ts), so one `dist/` works at a domain's root or under a path. Pages compresses each file, so a first visit transfers 13.8 MB, and takes about 2 s on a fast home connection or 4 s at 50 Mbit/s. To measure it, run:

```bash
LIVEPRINT_URL=https://liveprint.picone.dev/ node bench/load.mjs --runs 5 --warm 2
```

The scripts that use [`bench/cdp.mjs`](../bench/cdp.mjs) read two variables. `LIVEPRINT_URL` points them at a deployed site instead of `vite preview`, and `LIVEPRINT_BASE=/liveprint/` serves `dist/` under a path.

[`.github/workflows/ci.yml`](../.github/workflows/ci.yml) runs `npm test`, `npm run build` and the five `check:` scripts on every push and pull request, on the current stable Chrome. On `main`, a deploy job publishes `dist/` once every job passes.

## Scripts

- `npm test` runs the converter, linking, scheduler and compile tests.
- `npm run build` type-checks and builds to `dist/`.
- `npm run bench` compares the compile cost of cmarker and the JavaScript converter in Node.
- `npm run bench:browser` measures keystroke latency in headless Chrome. `node bench/browser.mjs --theme modern` measures another theme, `--switch` measures choosing a theme, `--images` compares typing with and without images, and `--math` types the sample's formulas one key at a time.
- `npm run bench:load` measures time to the first page, cold and warm.
- `node bench/wasm-cache.mjs` traces whether V8 compiles the compiler again on the second and third visits.
- `npm run check:linking` checks clicking, cursor following, text selection and formula clicks, in each theme.
- `npm run check:files` checks opening, saving, restoring and dropping files, changes on disk, several tabs and the recent documents list.
- `npm run check:images` checks pasting, dropping, restoring, saving and linking images.
- `npm run check:themes` checks theme font download failures and that an update keeps cached theme fonts.
- `npm run check:browsers` checks the main paths in Chrome, Firefox and WebKit. It needs `npx playwright-core install firefox webkit`, and on Linux WebKit also needs libmanette, libenchant and libhidapi.
- `npm run record:demo` records `docs/demo.gif`. It needs `ffmpeg`.

The `check:` scripts read page pixels to find where words and images print, so they test linking against the drawn page rather than against the index. Chrome's file pickers cannot be driven over the DevTools protocol, so the checks answer them with the origin private file system.

## Known limits

- The compiler WebAssembly is 28 MB, or 10.8 MB compressed, so the first visit is slow.
- The second visit compiles the compiler again, about 330 ms on loopback.
- Firefox and WebKit are tested with Playwright's builds, not released Firefox and Safari. A real paste in Firefox is untested, and linking accuracy is measured in Chrome only.
- The real file and folder pickers and permission prompts are untested.
- Without the File System Access API, liveprint cannot notice a change on disk.
- The browser's find bar finds preview text only while the text layers show.
- The preview draws at most twice the screen's pixel density, so at high zoom it looks soft. The PDF is not affected.
- In the Paper theme, Chrome cannot load New Computer Modern Regular and Italic as web fonts, so a selected italic word can be a few points off its letters.
- Opening a document with images can compile the previous document once more first.
- A formula that shows as typed also prints as typed in **Download .pdf**.
