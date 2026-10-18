# How liveprint works

The design behind liveprint, with the measurements that shaped it. For an overview, see the [README](../README.md).

## Speed

Keystroke to updated preview, measured on [`src/sample.md`](../src/sample.md) (7 A4 pages in the Book theme, about 3,000 words, with tables, code and LaTeX math):

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

## The pipeline

1. The editor (CodeMirror 6) sends the full Markdown text to a worker on every change.
2. The worker keeps only the newest edit. Older edits that arrive while it is busy are dropped, never compiled.
3. [`src/convert/toTypst.ts`](../src/convert/toTypst.ts) converts the Markdown to Typst source with the same lezer parser the editor uses. Math between `$` signs is passed to [mitex](https://github.com/mitex-rs/mitex), so ordinary LaTeX works.
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

Click a word in the preview and the editor cursor moves into that word. Move the cursor in the editor and the preview marks the same place: a pale band over the printed line and a thin bar at the character. If that line is out of sight, the preview scrolls it to a third of the way down, unless you scrolled the preview yourself in the last second. Images link too, as [Linking an image](#linking-an-image) describes.

A Markdown paragraph is usually one long source line, so linking by line would only find the paragraph. liveprint links by character. typst.ts 0.7.0 cannot map a click to the source or back, so liveprint matches the printed text against the Markdown instead:

1. The converter returns the Typst source and every piece of Markdown text it copied into it, with the offset of each piece. Math and generated text, such as list numbers, have no pieces.
2. When a click or a cursor move first needs it after a compile, the worker reads each page's text layer. This is the HTML that typst.ts builds for text selection, with every run of text and its position in points. A page whose typst.ts cache key has not changed keeps the runs it had.
3. Both texts are reduced to lowercase letters and digits, so curly quotes, dashes, hyphenation and ligatures cannot make them differ. A Myers diff pairs the two. On the sample that is 12,370 printed characters against 12,192 Markdown characters, 178 edits apart, which takes about 3 ms.
4. Every printed character now has a Markdown offset. A character the diff did not pair, such as a math glyph or a list number, takes its share of the Markdown between its paired neighbours.

The text layer gives only where a run of text starts and how wide it is. Spreading that width evenly over the characters put words up to 22 pt away from where they print (7 pt median). The worker measures the run in each font the theme sets text in instead, each word whole so that kerning counts. It picks the font whose spaces would have to stretch least to fill the run's width, where shrinking a space counts three times as much as stretching one, and gives the difference to the spaces, where justification puts it. A space at the end of a run takes no width, because the run ends at its last letter.

Inside a formula, linking pairs each printed letter or digit with the LaTeX that prints it. The converter lists the letters and digits of the formula's LaTeX outside command names, the names of operators such as `\sin`, and Greek letters such as `\alpha` as the symbol they print. A symbol it cannot name, such as an arrow, takes its share of the LaTeX between its neighbours.

Linking did not change keystroke latency measurably. Over five alternating runs per side of `npm run bench:browser`, typing in the title measured 42.7 ms at p50 before and 42.1 ms after, and the reflowing edit 26.9 ms before and 27.1 ms after. Run to run, each varied by 2 to 5 ms. The worker answers linking requests only after it has posted the edited page, and before it draws pages that are off-screen. Rebuilding the index after a one-word edit takes about 7 ms, and a keystroke that arrives during those 7 ms waits for them. The first request after the page loads took 48 ms in one measurement, because it reads the text layer of every page. A click gets its Markdown offset back in 8 ms at the median.

To check both directions in headless Chrome, run:

```bash
npm run check:linking
```

It runs once for each theme. In each, it samples 29 to 37 words from every page, among them a table cell, a code token, a list item, a word right after inline math and a word of a formula that shows as typed. It clicks each word in the preview and checks that the editor cursor lands inside it. Then it puts the cursor inside the word and checks that the bar in the preview lies inside the printed word. The printed word's box comes from the page's pixels, not from the text layer, so the check does not test the index against itself. It also clicks each symbol of `$a \quad \beta \quad \sin \quad 7 \quad \mathbb{R}$`, found as clusters of ink in the page's pixels, and checks that the cursor lands in that symbol's LaTeX. Before formulas gave linking their letters, 3 of the 5 clicks landed in a neighbour's LaTeX.

### Selecting text

Drag across the preview to select its text, or double-click a word, and copy it with **Ctrl+C**. Copying gives the printed text, with a line break where a printed line ends.

Each page has a text layer: its runs of text as transparent HTML over its canvas, as in a PDF viewer. The browser does the selecting. Each run is set in the font the worker fitted it to, with its justification slack on the spaces, so a selected word covers its printed letters.

The text layers are hidden while you type in the editor. They show as soon as the pointer moves or presses in the preview, or the editor loses focus. Over the page bitmaps, they made every redraw cost more layout and paint: with them always there, `npm run bench:browser` counted 1 to 4 main-thread tasks over 16 ms in each typing run, where the build before had none. Text that arrives while the layers are hidden waits and fills them when they show.

Typing did not get slower. Over three alternating runs per side of `npm run bench:browser`, against the build before selecting text, clicks in formulas, sharper SVGs and restoring per tab, typing in the title measured 44.1 to 46.3 ms at p50 before and 44.8 to 46.1 ms after. The reflowing edit measured 29.3 to 37.7 ms before and 30.5 to 33.5 ms after. No run after had a main-thread task over 16 ms, and two runs before had one each.

`check:linking` double-clicks each sampled word and checks that the selection is that word and that its edges lie within 0.3 em of the word's ink. It also drags from one word to a word a few lines below and checks the copied text. This check found four faults in the first version, and the same faults made linking a little less exact:

- The space at the end of a justified line took a share of the line's slack, so words drifted up to 4 pt to the left along the line.
- The font closest in width picked a bold face for some well-stretched lines.
- Every theme measured in the fonts loaded at start-up too, and some Paper lines matched Libertinus Bold best.
- Measuring letter by letter missed the kerning of IBM Plex Sans.

The first version selected 4 of the 33 sampled words in Book more than 0.3 em away from their ink. After the first two fixes, Paper still had 4 of 29 and Modern 3 of 37. Now none do, except an italic word in Paper, whose face Chrome cannot load, so there the check compares only the selected text.

## Formulas that are not valid yet

While you type a formula, its LaTeX is often not valid for a few keys, as in `\frac{1` before the second argument. That formula then shows as you typed it, between its dollar signs, in a grey monospace face, and the rest of the page keeps updating. A line in the corner of the preview says why, for example **A formula shows as typed: missing argument: den**. The key that makes the formula valid typesets it again. A click on the typed LaTeX puts the cursor in it, as on any other text.

Typst stops at the first error, and a document cannot catch one, so the worker finds the formula from the error:

1. The error points inside mitex. A hint after it points at the formula's call in the generated source, such as `mi("\\frac{1")`, by line and column.
2. The worker reads the call's text at that place and marks it as rejected. Two formulas with the same LaTeX fail the same way, so the call's text is the key, and no positions need to be tracked.
3. The converter shows every rejected call as typed, and the worker compiles again. A failed compile names only one formula, so this repeats until the compile succeeds, once for each formula newly rejected. It always ends, because each round removes one formula of the document from the compile.

A rejected call stays rejected while the document still has it, so typing elsewhere costs no extra compile. Any other failed compile, which liveprint itself should never cause, still keeps the last good pages and shows the error.

`node bench/browser.mjs --math` empties each of the sample's 16 formulas, keeping its dollar signs, and types its 694 characters of LaTeX back one key at a time, 150 ms apart:

| Keys | Before | After |
|---|---|---|
| Keys that leave a formula not valid | 240 of 694 failed to compile. The preview caught up 664 ms later at p50, 3.8 s at p95 | 0 failed. 48.6 ms at p50, 62.5 ms at p95 |
| Other keys in the formulas | 42.1 ms at p50, 54.7 ms at p95 | 41.9 ms at p50, 55.7 ms at p95 |

Before is one run and after is two. Both found the same 240 keys, the before side through the failed compiles and the after side through the formulas shown as typed. A key in a formula that is not valid costs about 7 ms more, because it converts and compiles twice. Its compile time, the failed compile and the good one together, was 11.4 ms at p50 against 8.2 ms for the other keys.

Ordinary typing did not change. Over three alternating runs per side of `npm run bench:browser`, typing in the title measured 43.3 to 47.1 ms at p50 before and 43.9 to 45.6 ms after. The reflowing edit measured 27.3 to 30.3 ms before and 25.8 to 32.3 ms after. A compile that succeeds runs exactly as it did.

## Page settings

The button left of the download buttons names the current paper, margins and theme, for example **A4 · Normal · Book**. It opens a menu with three choices:

- Paper: A4 or US Letter. The first visit picks US Letter in the countries that use it, such as the US, Canada and Mexico, and A4 elsewhere.
- Margins: narrow (18 mm), normal (25 mm) or wide (35 mm).
- Theme: Book (Libertinus Serif, justified, indented paragraphs), Paper (New Computer Modern, numbered sections, like a LaTeX article) or Modern (IBM Plex Sans, ragged right). Each theme's name in the menu is set in its own typeface.

A choice applies at once to the preview and to **Download .pdf**, and the browser keeps it for the next visit. The theme preludes are in [`src/typst/themes/`](../src/typst/themes), and [`src/typst/themes.ts`](../src/typst/themes.ts) lists them with the fonts each one needs.

Book uses only the fonts that load at start-up. Paper needs 2.2 MB of fonts and Modern 890 KB, and the worker downloads them only when you first choose that theme. While they download, the preview stays in the previous theme and keeps up with your typing. Over loopback in headless Chrome, a first choice of Paper showed its first pages after 189 to 217 ms, and of Modern after 163 to 184 ms. About 100 ms of that is compiling the whole document again in the new theme, and about 45 ms is drawing the visible pages. Choosing a theme again took 45 to 52 ms. To measure it, run `npm run build` and then `node bench/browser.mjs --switch`.

If the download fails, the preview stays in the previous theme, and a line in its corner says so until you choose a theme: **Could not download the Paper fonts: Failed to fetch. Choose Paper again to retry.** The menu goes back to the theme on screen, and so does the choice the browser keeps, so the button never names a theme the preview is not in, nothing pulses, and a reload starts cleanly. Because the failed theme is no longer the one checked, choosing it again is a change like any other, and it downloads the fonts again. If the stored theme's fonts fail while the page starts, the first pages are in Book, with the same line.

Fonts the service worker has cached never fail, so the check runs both with the service worker in control and without it:

```bash
npm run check:themes
```

It fails the Paper font requests through the DevTools protocol's Fetch domain on the browser, which also catches the service worker's own requests, and counts them to prove they were failed. It checks that the line stays over 10 keystrokes while the preview stays in Book and keeps up, that the menu and the stored choice say Book, that choosing Paper again clears the line and tries again, that a reload starts cleanly, and that once the fonts can download, choosing Paper shows Paper with no trace of the failure.

Typing latency did not change. Over three alternating runs of `npm run bench:browser`, typing in the title measured 40.1 to 42.1 ms at p50 before page settings, with the old 6-page layout, and 40.8 to 42.2 ms after, in Book. The reflowing edit measured 23.6 to 30.0 ms before and 23.8 to 30.3 ms after.

## Files

**Open** (Ctrl+O, or Cmd+O on a Mac) reads a Markdown file. **Save** (Ctrl+S) writes it back to the same file. **Shift+Ctrl+S**, or Shift-click on **Save**, saves it under a new name. You can also drop a `.md`, `.markdown` or `.txt` file anywhere on the app to open it, together with its images if you drop them with it. The bar shows the file's name, and **Edited** while the editor's text differs from what was last opened or saved. Undoing back to that text clears **Edited** again. **Download .pdf** names the PDF after the file, so `notes.md` becomes `notes.pdf`.

In Chrome and Edge, liveprint uses the File System Access API and keeps the file handle, so **Save** writes to the file you opened without asking again. Firefox and Safari do not have the API. There, **Open** uses the browser's file dialog and **Save** downloads the file under its name.

Opening another file while there are unsaved changes asks first. So does closing or reloading the tab.

When another program changes the open file, liveprint notices when its tab comes back into view. If the editor has no unsaved changes, it takes the new text as one change, which **Ctrl+Z** undoes. If it has, the bar says **Changed on disk** next to a **Reload** button, and the editor keeps your text. **Save** then asks before it overwrites the change. liveprint compares the file's text with the text it last opened or saved, so it keeps no timestamps. It also listens for the browser's own reports of changes to the file (`FileSystemObserver`) where it has them, which no check covers yet. All of this needs the File System Access API and permission to read the file, which Chrome may ask for again after a reload. Until then liveprint cannot look, and **Save** looks once it may write.

Each tab keeps its document in the browser's IndexedDB while you type, one write at a time: its text, its name, whether it was edited, its images, and in Chrome its file handle and folder. This protects against the losses a leave-page warning cannot catch, such as a crash, a closed laptop or a tab the browser discarded. The copy stays in this browser only, so **Edited** still means the file on disk is behind. After a reload, Chrome may ask once for permission to write to the file again.

A reload, or reopening a closed tab, brings that tab's own document back, because the tab's sessionStorage names its record. While a tab is open, it holds a Web Lock on its record, so no other tab takes it. A new tab takes the newest document that no open tab holds, so closing your last tab and coming back later brings back the document you worked on last. If every kept document is open in another tab, the new tab starts empty, and a duplicated tab gets a copy. liveprint keeps the 10 newest documents and deletes older ones that no tab holds. Images are kept as bytes, not as Blobs, because WebKit's private browsing hangs on putting a Blob into IndexedDB.

Finding the tab's document costs little. In one run of `check:files` before this and two after, the editor's text was known 73 ms into a reload before and 53 to 54 ms after, and 91 ms into a first visit before and 110 to 112 ms after. The compiler is ready only about 190 ms into a reload and 250 ms into a first visit, so the first pages do not wait for the document.

To check opening, saving, restoring, dropping, changes on disk and several tabs in headless Chrome, with the File System Access API and without it, run:

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
- **On disk, without the API** (Firefox and Safari). **Save** downloads the `.md` and then each image that was not downloaded with it before, so they land side by side in your downloads folder. A download cannot make a folder, and none is needed: liveprint names a pasted or dropped image after its file, beside the document, and an image in a subfolder can only come from reading a folder, so it is on disk already.

A browser lets one click open only one picker. The first save of an untitled document uses that click for the save picker, so its images are not written yet. The bar then says **1 image not saved beside notes.md** next to a **Choose folder** button, and **Save** asks for the folder the next time.

### Opening a file that has images

When the Markdown names an image that liveprint does not have, the preview shows a dashed frame with the image's alt text, or its path. The bar says **1 image not found** next to **Choose folder**. With the API, the button asks for the file's folder and reads the images from it. liveprint keeps that folder, so when you type `![](plot.png)` and `plot.png` is in the folder, the image shows at once. Without the API, the button reads the folder through the browser's folder dialog.

Remote images (`https://…`) and `data:` URLs are not loaded, and neither are paths that leave the folder, such as `../shared/x.png`. They show as a frame too.

### Linking an image

A click anywhere on an image puts the cursor inside its Markdown, just after `![`. With the cursor anywhere inside `![…](…)`, the preview lays the pale band over the whole image, with no caret, and scrolls to it like to any other line. Clicks on the text around an image, and the cursor just outside its Markdown, link as text.

An image prints no text, so the text layer that linking reads has nothing for it. Instead, the converter wraps each image it shows in `linked-image`, which places three marks that take no space: the image's natural size, a mark at its top-left corner and a mark under its left edge. When linking first needs it after a compile, the worker asks Typst for the marks with `query`, on a world compiled from the same source. The image's height is the distance between the last two marks, and its width keeps the image's aspect ratio. The marks come back in document order, and the converter lists the Markdown of each image it shows in the same order, so the worker pairs them up. A click tries these boxes first, and the text index answers everything else as before.

The marks hold no Markdown offsets, and the size has a context of its own. Both keep Typst from measuring an image again on every keystroke. With offsets in the marks, or the size measured where the position is asked, a compile of the sample with three images took 0.7 to 1.2 ms longer than with no marks. Now it takes 0.2 to 0.5 ms longer, over three runs of 140 compiles each in Node. With three images added to the sample, all 103 paragraphs laid out at exactly the same places with the marks and without them, in each theme.

Asking for the marks is cheap. Over 30 keystrokes in the sample with three pasted images, compiling the world took 0.20 ms and the query 0.10 ms at the median. It runs after the edited pages are posted, and a document that shows no image skips it. Typing did not slow down. Over two alternating runs per side of `node bench/browser.mjs --images --runs 1`, typing in the title with the three images measured 27.5 to 28.0 ms at p50 before and 27.5 to 28.4 ms after, and on the photo's page 30.6 to 31.2 ms before and 29.8 to 30.2 ms after. `check:linking` still passes in each theme, and a click gets its offset in 8.4 to 10.0 ms at the median.

### SVG in the preview

typst.ts draws an SVG image with `new Image()`, which a worker does not have, and Chrome cannot decode SVG in a worker at all. The main thread therefore draws each SVG at 2048 pixels along its longer side and sends that drawing to the worker, where a stand-in `Image` copies it. Only the preview uses the drawing. Typst lays out and prints the SVG itself, so the PDF keeps it as vectors.

When linking finds that an SVG prints larger than its drawing, as a full-column chart does in a wide preview, the worker asks for a drawing at the size it prints, in steps of 256 pixels and at most 16 million pixels. typst.ts keeps its own copy of an image it has drawn, so the main thread sends the SVG again with a comment naming the size, and typst.ts loads it as a new image. Each step costs one compile. In `check:images`, a striped SVG printed about 2800 pixels wide had 1.43 grey pixels at each edge between black and white, and now has 1.07. An edge that falls between two pixels has at least one.

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

CDP cannot answer the file and folder pickers, so the check answers them with folders of the origin private file system, like `check:files`. It also reads each preview bitmap's pixels to confirm the image is in the first one drawn after a paste, and to find the image's box for the linking checks. Those click the centre and near each corner of a block image and an inline image, and compare the band the cursor lays over each image with its box in the pixels.

## Offline

A service worker caches the app after the first visit: the page, the scripts, both WebAssembly files, the fonts used at start-up and the mitex package, about 33 MB in all. A theme's fonts are cached the first time you choose that theme, in a cache named after a hash of the theme fonts, so an update of the app keeps them unless the fonts themselves changed. `check:themes` installs a new `sw.js` and checks that Paper then shows with no font download. Later visits make no requests at all, and the app works with no network. You can also install it as an app from the browser's address bar.

The service worker is written by hand in [`src/sw.ts`](../src/sw.ts), with no plugin and no new dependency. A small Vite plugin, [`build/serviceWorker.ts`](../build/serviceWorker.ts), lists the built files and adds a hash of their contents to `sw.js`. Any change to the build changes `sw.js`, so the browser installs the new version on the next visit and deletes the old cache. The page you have open keeps running the version it started with. The new version shows on the visit after that. The service worker registers only after the first pages show, so on a first visit it does not download the large files while the page is still downloading them.

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
- The second visit is no faster than before, and on loopback it is about 330 ms slower. `node bench/wasm-cache.mjs` traces visits 2 and 3, each in a new tab, as a reader coming back opens one. The second visit is the first to compile the compiler from the service worker's copy, which has no stored code yet: 3397 functions compile while the first pages wait, which takes 226 ms, and validating the file as it streams in takes 133 ms more. V8 then stores its code beside the copy. The third visit deserializes it and compiles only 344 functions, in 25 ms. The first page came after 1056 ms on the second visit and 729 ms on the third. Before the service worker, the browser's HTTP cache kept the code compiled on the first visit.
- V8 stores that code only for a Cache Storage entry that a page compiled from through `fetch()` and ran long enough to optimize. Three ways to store it during the first visit did not work: compiling the cached copy in the background once the service worker is active, compiling from `caches.match()` in the worker, and passing the file through the service worker from the network. In each, the second visit still compiled all 3397 functions, and the last two also lost the third visit's stored code. What would work is to compile on the first visit from the service worker's copy, which makes the first visit wait for the whole 33 MB install. That would cost the first visit about what it saves the second, so the design stays.
- From the third visit on, the time is the same on any network. About 420 ms of it is the first full compile of the document, which is the limit now.

On a first visit, before the service worker has cached anything, the preview says how much of the compiler has arrived, such as **Downloading the typesetter, 4.9 of 28.3 MB**, until the first pages show. The worker counts the bytes as they arrive. Later visits get the file from the service worker unchanged, because a response rebuilt to count its bytes would lose the code V8 stores beside it. The download now starts together with the fonts instead of after them. Over two loopback runs per side of `node bench/load.mjs --runs 2 --warm 3`, a first visit measured 1086 to 1167 ms against 1110 to 1119 ms before, and later visits did not change.

To measure it, run:

```bash
npm run build
node bench/load.mjs --runs 2 --warm 3 --throttle 50 --offline
```

Without `--throttle` the bench runs over loopback. `--offline` stops the server at the end and loads the page once more. The Chrome profile goes in the system temp folder. If that folder is a small `tmpfs`, Chrome can fail to store the 28 MB WebAssembly file, and the bench prints `service worker: none`. Set `TMPDIR` to a folder on disk to avoid that.

## Browsers

`npm run check:browsers` runs the main paths in Chrome, Firefox and WebKit: typesetting the sample, typing, clicking in the preview, selecting and copying, the Paper theme, the PDF download, opening and saving without the File System Access API, images, restoring after a reload, and the service worker. It uses Playwright's builds of Firefox and WebKit, which `npx playwright-core install firefox webkit` downloads. Playwright's WebKit is not Safari, but it is Safari's engine. All three browsers pass, with Firefox 157 and WebKit 27.2. On Linux, Playwright's WebKit also needs libmanette, libenchant and libhidapi from the system.

The first run found two faults, both fixed:

- In WebKit's private browsing, putting an image's Blob into IndexedDB hung, and every later write waited behind it. A reload then brought back the text from before a paste. Images are now kept as bytes.
- In Firefox, after a reload in the Paper theme, the worker's `FontFace` for New Computer Modern Italic never finished loading. Measuring the theme's fonts never ended, so no page was drawn. A face that has not loaded within 3 s is now left unmeasured.

Firefox empties the clipboard data of a paste event that a script makes, so there the check reads its image through the folder dialog instead. The other checks, and the linking accuracy that `check:linking` measures, run in Chrome only.

## Scripts

- `npm test` runs the converter, linking, scheduler and compile tests.
- `npm run build` type-checks and builds to `dist/`.
- `npm run bench` compares compile cost of cmarker and the JavaScript converter in Node.
- `npm run bench:browser` measures keystroke latency in headless Chrome, in the Book theme on A4. `node bench/browser.mjs --theme modern` measures another theme, `--switch` measures choosing a theme, `--images` compares typing with and without images, and `--math` types the sample's formulas one key at a time.
- `npm run check:linking` checks clicking in the preview, following the cursor, selecting and copying text and clicking symbols in a formula in headless Chrome, in each theme.
- `npm run check:files` checks opening, saving, restoring and dropping files, changes on disk and several tabs in headless Chrome.
- `npm run check:images` checks pasting, dropping, restoring, saving and linking images in headless Chrome.
- `npm run check:themes` checks what happens when a theme's fonts fail to download, with the service worker and without it, and that an update keeps the cached theme fonts.
- `npm run check:browsers` checks the main paths in Chrome, Firefox and WebKit. It needs `npx playwright-core install firefox webkit` first.
- `npm run bench:load` measures the time to the first page, cold and warm, in headless Chrome.
- `node bench/wasm-cache.mjs` traces whether V8 compiles the compiler again on the second and third visits.
- `npm run record:demo` records `docs/demo.gif` in headless Chrome. It needs `ffmpeg`.

## Known limits

- The compiler WebAssembly is 28 MB, or 10.8 MB gzipped, so the first visit is slow. The preview shows how much has arrived.
- The second visit compiles the compiler again, which costs about 330 ms on loopback, as [Offline](#offline) explains. Later visits reuse the stored code.
- Firefox and WebKit are tested with Playwright's builds, not with released Firefox and Safari. A real paste in Firefox is untested, and linking accuracy is measured in Chrome only.
- The real file and folder pickers and permission prompts are not tested, because CDP cannot answer them. Asking again for a folder's permission after a reload is untested too.
- liveprint keeps the 10 newest documents, but nothing in the app lists them. A new tab gets the newest one that no other tab has open.
- liveprint notices a change on disk only with the File System Access API and permission to read the file, and only when the tab comes back into view, unless the browser reports the change itself.
- The preview's text layers show only while you point at the preview or work outside the editor, so the browser's find bar finds preview text only then.
- The preview draws pages at no more than twice the screen's pixel density, so at higher browser zoom its text and images look soft. The PDF is not affected.
- Opening a document with images can compile the previous document once more before the new one. In five measured opens, the new document's first pages took 73 to 100 ms either way.
- In a formula, a symbol that is not a letter, a digit, an operator name or a Greek letter, such as an arrow, links to its share of the LaTeX between its neighbours.
- Chrome cannot load New Computer Modern Regular and Italic as web fonts, although Typst can. In the Paper theme, linking and selecting measure body text with the math font's upright letters, which have the same design and advances, and italic text in the regular face, so a selected italic word can be a few points off its letters. The menu sets the name Paper in the math font.
- A formula that shows as typed also prints as typed in **Download .pdf**.
