# liveprint

![Typing in liveprint: the typeset pages update on each keystroke with the latency overlay showing about 40 ms, then a click on a heading in the preview moves the editor cursor there, and the arrow keys move a highlight through the preview](docs/demo.gif)

Write Markdown on the left and see the real PDF pages on the right while you type. The preview is the typeset document itself, not an HTML approximation: Typst compiles it in your browser, and **Download .pdf** gives you the same pages you see.

Everything runs on the client. There is no server. After the first visit the app works offline, and it opens and saves real `.md` files on your disk, with their images.

## Speed

Keystroke to updated preview, measured on [`src/sample.md`](src/sample.md) (7 A4 pages in the Book theme, about 3,000 words, with tables, code and LaTeX math):

| Edit | p50 | p95 | Main-thread tasks over 16 ms |
|---|---|---|---|
| Typing inside a heading | 41.3 ms | 53.1 ms | 0 |
| Adding paragraphs near the top, which reflows every later page | 24.4 ms | 60.8 ms | 0 |

Each row is 60 real keystrokes, 150 ms apart, sent to headless Chrome over the DevTools protocol, and each value is the median of three runs. Chrome used software rendering (SwiftShader) for these runs, so a browser with GPU raster should do at least as well, but that is not measured yet. To reproduce the table, run:

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

## Two-way linking

Click a word in the preview and the editor cursor moves into that word. Move the cursor in the editor and the preview marks the same place: a pale band over the printed line and a thin bar at the character. If that line is out of sight, the preview scrolls it to a third of the way down, unless you scrolled the preview yourself in the last second.

A Markdown paragraph is usually one long source line, so linking by line would only find the paragraph. liveprint links by character. typst.ts 0.7.0 cannot map a click to the source or back, so liveprint matches the printed text against the Markdown instead:

1. The converter returns the Typst source and every piece of Markdown text it copied into it, with the offset of each piece. Math and generated text, such as list numbers, have no pieces.
2. When a click or a cursor move first needs it after a compile, the worker reads each page's text layer. This is the HTML that typst.ts builds for text selection, with every run of text and its position in points. A page whose typst.ts cache key has not changed keeps the runs it had.
3. Both texts are reduced to lowercase letters and digits, so curly quotes, dashes, hyphenation and ligatures cannot make them differ. A Myers diff pairs the two. On the sample that is 12,370 printed characters against 12,192 Markdown characters, 178 edits apart, which takes about 3 ms.
4. Every printed character now has a Markdown offset. A character the diff did not pair, such as a math glyph or a list number, takes its share of the Markdown between its paired neighbours.

The text layer gives only where a run of text starts and how wide it is. Spreading that width evenly over the characters put words up to 22 pt away from where they print (7 pt median). The worker measures each character in the bundled fonts instead, takes the font whose total comes closest to the run's width, and gives the rest of the width to the spaces, where justification puts it.

Linking did not change keystroke latency measurably. Over five alternating runs per side of `npm run bench:browser`, typing in the title measured 42.7 ms at p50 before and 42.1 ms after, and the reflowing edit 26.9 ms before and 27.1 ms after. Run to run, each varied by 2 to 5 ms. The worker answers linking requests only after it has posted the edited page, and before it draws pages that are off-screen. Rebuilding the index after a one-word edit takes about 7 ms, and a keystroke that arrives during those 7 ms waits for them. The first request after the page loads took 48 ms in one measurement, because it reads the text layer of every page. A click gets its Markdown offset back in 8 ms at the median.

To check both directions in headless Chrome, run:

```bash
npm run check:linking
```

It runs once for each theme. In each, it samples 28 to 36 words from every page, among them a table cell, a code token, a list item and a word right after inline math. It clicks each word in the preview and checks that the editor cursor lands inside it. Then it puts the cursor inside the word and checks that the bar in the preview lies inside the printed word. The printed word's box comes from the page's pixels, not from the text layer, so the check does not test the index against itself.

## Page settings

The button left of the download buttons names the current paper, margins and theme, for example **A4 · Normal · Book**. It opens a menu with three choices:

- Paper: A4 or US Letter. The first visit picks US Letter in the countries that use it, such as the US, Canada and Mexico, and A4 elsewhere.
- Margins: narrow (18 mm), normal (25 mm) or wide (35 mm).
- Theme: Book (Libertinus Serif, justified, indented paragraphs), Paper (New Computer Modern, numbered sections, like a LaTeX article) or Modern (IBM Plex Sans, ragged right). Each theme's name in the menu is set in its own typeface.

A choice applies at once to the preview and to **Download .pdf**, and the browser keeps it for the next visit. The theme preludes are in [`src/typst/themes/`](src/typst/themes), and [`src/typst/themes.ts`](src/typst/themes.ts) lists them with the fonts each one needs.

Book uses only the fonts that load at start-up. Paper needs 2.2 MB of fonts and Modern 890 KB, and the worker downloads them only when you first choose that theme. While they download, the preview stays in the previous theme and keeps up with your typing. Over loopback in headless Chrome, a first choice of Paper showed its first pages after 189 to 217 ms, and of Modern after 163 to 184 ms. About 100 ms of that is compiling the whole document again in the new theme, and about 45 ms is drawing the visible pages. Choosing a theme again took 45 to 52 ms. To measure it, run `npm run build` and then `node bench/browser.mjs --switch`.

Typing latency did not change. Over three alternating runs of `npm run bench:browser`, typing in the title measured 40.1 to 42.1 ms at p50 before page settings, with the old 6-page layout, and 40.8 to 42.2 ms after, in Book. The reflowing edit measured 23.6 to 30.0 ms before and 23.8 to 30.3 ms after.

## Files

**Open** (Ctrl+O, or Cmd+O on a Mac) reads a Markdown file. **Save** (Ctrl+S) writes it back to the same file. **Shift+Ctrl+S**, or Shift-click on **Save**, saves it under a new name. You can also drop a `.md`, `.markdown` or `.txt` file anywhere on the app to open it, together with its images if you drop them with it. The bar shows the file's name, and **Edited** while the editor's text differs from what was last opened or saved. Undoing back to that text clears **Edited** again. **Download .pdf** names the PDF after the file, so `notes.md` becomes `notes.pdf`.

In Chrome and Edge, liveprint uses the File System Access API and keeps the file handle, so **Save** writes to the file you opened without asking again. Firefox and Safari do not have the API. There, **Open** uses the browser's file dialog and **Save** downloads the file under its name.

Opening another file while there are unsaved changes asks first. So does closing or reloading the tab.

liveprint restores the last document when you come back: its text, its name, whether it was edited, its images, and in Chrome its file handle and folder. It keeps a copy in the browser's IndexedDB while you type, one write at a time. This protects against the losses a leave-page warning cannot catch, such as a crash, a closed laptop or a tab the browser discarded. The copy stays in this browser only, so **Edited** still means the file on disk is behind. After a reload, Chrome may ask once for permission to write to the file again.

To check opening, saving, restoring and dropping in headless Chrome, with the File System Access API and without it, run:

```bash
npm run check:files
```

CDP cannot answer Chrome's file pickers, so with the API the check returns files from the origin private file system in place of the picker. Reading, writing and reading back are real. Without the API, the check chooses a real file through the file input and compares the bytes of the real download.

## Images

Paste an image, or drop an image file on the editor, and liveprint writes `![](image.png)` at the cursor or where you dropped it. The image is already in the first preview drawn after the paste. An image alone in its paragraph is centred on a line of its own at its natural size, and Typst scales it down to the column when it is wider. An image inside a sentence sits on the line. PNG, JPEG, GIF, WebP and SVG work. A file of any other type is refused, and the message names the types that work.

A pasted file keeps its name, with spaces and unsafe characters changed to `-`. When the document already has a different image under that name, the new one becomes `image-2.png`, then `image-3.png`. Pasting the same bytes again reuses the first name.

### Where the image files go

The Markdown records a path relative to the `.md` file, and the image file goes beside it, as VS Code does by default. GitHub, editors and other Markdown tools then show the same images.

- **In this browser.** IndexedDB keeps every image of the document in a store of its own, which liveprint writes only when the images change. Typing never writes image bytes. A reload restores the text and the images without the network.
- **On disk, with the File System Access API** (Chrome and Edge). **Save** writes the `.md` and every image it names that is not in its folder yet. A file handle cannot reach its folder, so the first save of a file with images asks for the folder that holds it. liveprint refuses a folder that does not contain the file. After that, **Save** writes new images without asking.
- **On disk, without the API** (Firefox and Safari). **Save** downloads the `.md` and then each image that was not downloaded with it before, so they land side by side in your downloads folder.

A browser lets one click open only one picker. The first save of an untitled document uses that click for the save picker, so its images are not written yet. The bar then says **1 image not saved beside notes.md** next to a **Choose folder** button, and **Save** asks for the folder the next time.

### Opening a file that has images

When the Markdown names an image that liveprint does not have, the preview shows a dashed frame with the image's alt text, or its path. The bar says **1 image not found** next to **Choose folder**. With the API, the button asks for the file's folder and reads the images from it. liveprint keeps that folder, so when you type `![](plot.png)` and `plot.png` is in the folder, the image shows at once. Without the API, the button reads the folder through the browser's folder dialog.

Remote images (`https://…`) and `data:` URLs are not loaded, and neither are paths that leave the folder, such as `../shared/x.png`. They show as a frame too.

### Linking around an image

An image prints no Markdown text, so linking passes over it. A click on the text before or after an image puts the cursor in that text. A click on the image itself puts the cursor at the end of the text printed before it.

### SVG in the preview

typst.ts draws an SVG image with `new Image()`, which a worker does not have, and Chrome cannot decode SVG in a worker at all. The main thread therefore draws each SVG at 2048 pixels along its longer side and sends that drawing to the worker, where a stand-in `Image` copies it. Only the preview uses the drawing. Typst lays out and prints the SVG itself, so the PDF keeps it as vectors.

### Cost

`node bench/browser.mjs --images` types in the sample with three pasted images and without them, in alternating runs. The images are a 1200×800 PNG of 0.23 MB, a 4000×3000 JPEG photo of 4.42 MB, and an SVG chart. Each value is the median of three runs of 110 keystrokes:

| Edit | Without images, p50 / p95 | With images, p50 / p95 |
|---|---|---|
| Typing in the title | 41.6 / 55.3 ms | 28.8 / 46.3 ms |
| Typing on the page that holds the photo | 46.7 / 56.6 ms | 32.0 / 50.3 ms |

Typing did not get slower with images. It got faster because the images push text off the page you type on, and drawing a page takes time for each run of text on it. Page 1 holds 32 runs of text without the images and 25 with them. The photo's page holds 29, and the same paragraph without images sits on a page with 79. Compiling stayed at 7.5 to 8.2 ms per keystroke. Drawing the photo again on each keystroke costs little: its page took 14.0 ms to draw, and page 1, with 25 runs and no photo, took 12.6 ms.

Pasting the photo is the expensive step. From the paste to the paint of its pages took 356 to 393 ms over six pastes, of which the first compile was 201 to 226 ms and drawing pages 2 to 4 was 124 to 132 ms. The keystrokes after it are back to the numbers in the table.

The page's renderer process grew from 573 MB to 639 MB with the three images, in a fresh process. Earlier runs measured growth of 47 to 83 MB. The photo alone is 48 MB as decoded pixels, which is likely most of the growth, but no profile confirms that. The worker's JavaScript heap stays at about 3.4 MB, because the bytes live in WebAssembly memory.

To check pasting, dropping, restoring, saving, finding images in a folder and the fallback path in headless Chrome, run:

```bash
npm run check:images
```

CDP cannot answer the file and folder pickers, so the check answers them with folders of the origin private file system, like `check:files`. It also reads each preview bitmap's pixels to confirm the image is in the first one drawn after a paste.

## Offline

A service worker caches the app after the first visit: the page, the scripts, both WebAssembly files, the fonts used at start-up and the mitex package, about 33 MB in all. A theme's fonts are cached the first time you choose that theme. Later visits make no requests at all, and the app works with no network. You can also install it as an app from the browser's address bar.

The service worker is written by hand in [`src/sw.ts`](src/sw.ts), with no plugin and no new dependency. A small Vite plugin, [`build/serviceWorker.ts`](build/serviceWorker.ts), lists the built files and adds a hash of their contents to `sw.js`. Any change to the build changes `sw.js`, so the browser installs the new version on the next visit and deletes the old cache. The page you have open keeps running the version it started with. The new version shows on the visit after that. The service worker registers only after the first pages show, so on a first visit it does not download the large files while the page is still downloading them.

Time from navigation to the first page, in headless Chrome, two runs per cell except three for the loopback runs after the change. Each run is a cold load with all site data cleared, then three reloads:

| Load | Before, 50 Mbit/s | After, 50 Mbit/s | Before, loopback | After, loopback |
|---|---|---|---|---|
| First visit | 7.36–7.41 s | 7.38–7.43 s | 1.14 s | 1.10–1.16 s |
| Second visit | 0.99–1.01 s | 1.06–1.09 s | 0.74–0.75 s | 1.08–1.09 s |
| Third and later | 0.99–1.01 s | 0.72–0.77 s | 0.72–0.80 s | 0.72–0.77 s |
| Offline | fails | 0.75 s | fails | 0.75 s |

The throttled runs add 40 ms of latency. The offline row is one load with the server stopped, so throttling does not apply to it. `vite preview` does not compress, so a first visit transfers 32.9 MB, where a host that gzips would send about 13 MB.

What these numbers mean:

- Before, every later visit asked the server about each of 18 files, and those round trips set the warm time on a network. After, the service worker answers all 20 requests and nothing goes over the network.
- The second visit is no faster than before, and on loopback it is about 330 ms slower. The extra time is in the first compile of the document, which takes about 770 ms on that visit and about 420 ms on later ones. The likely cause, not yet confirmed by a profile, is that the second visit is the first to load the compiler from the service worker's copy. Chrome has no compiled code stored for that copy yet, so it compiles all 28 MB again and stores the result. Before this change, the browser's HTTP cache kept the code compiled on the first visit.
- From the third visit on, the time is the same on any network. About 420 ms of it is the first full compile of the document, which is the limit now.

To measure it, run:

```bash
npm run build
node bench/load.mjs --runs 2 --warm 3 --throttle 50 --offline
```

Without `--throttle` the bench runs over loopback. `--offline` stops the server at the end and loads the page once more. The Chrome profile goes in the system temp folder. If that folder is a small `tmpfs`, Chrome can fail to store the 28 MB WebAssembly file, and the bench prints `service worker: none`. Set `TMPDIR` to a folder on disk to avoid that.

## Run it

```bash
npm install
npm run dev
```

Other scripts:

- `npm test` runs the converter, linking, scheduler and compile tests.
- `npm run build` type-checks and builds to `dist/`.
- `npm run bench` compares compile cost of cmarker and the JavaScript converter in Node.
- `npm run bench:browser` measures keystroke latency in headless Chrome, in the Book theme on A4. `node bench/browser.mjs --theme modern` measures another theme, `--switch` measures choosing a theme, and `--images` compares typing with and without images.
- `npm run check:linking` checks clicking in the preview and following the cursor in headless Chrome, in each theme.
- `npm run check:files` checks opening, saving, restoring and dropping files in headless Chrome.
- `npm run check:images` checks pasting, dropping, restoring and saving images in headless Chrome.
- `npm run bench:load` measures the time to the first page, cold and warm, in headless Chrome.
- `npm run record:demo` records `docs/demo.gif` in headless Chrome. It needs `ffmpeg`.

## Status

The pipeline works end to end, the speed is measured, the editor and the preview link both ways, and documents hold images. Not built yet:

- Text selection in the preview.

Known limits:

- The compiler WebAssembly is 28 MB, or 10.8 MB gzipped, so the first visit is slow. Later visits load it from the service worker's cache.
- After an update, the theme fonts cached before it are downloaded again the next time you choose that theme, and until then they are not available offline.
- Only one document is restored. If two tabs are open, the one that wrote last is the one that comes back.
- If a file changes on disk while it is open in liveprint, liveprint does not notice, and **Save** overwrites the change.
- Only Chrome has been tested. The Firefox and Safari paths for opening and saving are tested in Chrome with the API removed.
- The real file and folder pickers and permission prompts are not tested, because CDP cannot answer them. Asking again for a folder's permission after a reload is untested too.
- Images in subfolders, such as `figures/plot.png`, are covered by unit tests only. Without the API, **Save** downloads `figures/plot.png` as `plot.png`.
- A click on an image in the preview puts the cursor before the image, not on its Markdown.
- An SVG in the preview is a 2048-pixel drawing, so it can blur at high zoom. The PDF is not affected.
- Opening a document with images can compile the previous document once more before the new one. In five measured opens, the new document's first pages took 73 to 100 ms either way.
- Linking inside math is approximate. A click on a formula puts the cursor in its LaTeX in proportion to the glyph's position, not on the matching symbol.
- Chrome cannot load New Computer Modern Regular and Italic as web fonts, although Typst can. In the Paper theme, linking measures body text with the math font's upright letters, which have the same design, and the menu sets the name Paper in the math font.
- If a theme's fonts fail to download, the preview stays in the previous theme and the menu keeps showing the chosen theme as loading. Choosing it again retries the download.
- A LaTeX formula that is not valid yet, such as `\frac{1` while you type, stops the compile. The preview keeps the last good pages and shows the error until the formula is valid again.

## Licence

liveprint is released under the [MIT licence](LICENSE).

### Bundled assets

Bundled fonts and Typst packages are listed with their licences in [`public/fonts/LICENSES.md`](public/fonts/LICENSES.md) and [`public/packages/PROVENANCE.md`](public/packages/PROVENANCE.md).
