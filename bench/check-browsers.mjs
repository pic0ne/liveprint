// The app's main paths in Chrome, Firefox and WebKit (Safari's engine), against `vite preview` of dist/
// (`npm run check:browsers` builds it). Firefox and WebKit are Playwright's builds:
// `npx playwright-core install firefox webkit` fetches them. Chrome is the system one, as in the other checks.
// node bench/check-browsers.mjs [--browser firefox]
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { chromium, firefox, webkit } from 'playwright-core';
import { preview, sleep, until } from './cdp.mjs';

const { values: args } = parseArgs({ options: { browser: { type: 'string' } } });
const BROWSERS = { chrome: () => chromium.launch({ executablePath: '/usr/bin/google-chrome' }), firefox: () => firefox.launch(), webkit: () => webkit.launch() };
const J = JSON.stringify;

const WATCH_WORKER = `
  window.__pages = { sent: -1, rev: -1, final: false, theme: null };
  window.Worker = class extends Worker {
    constructor(...args) {
      super(...args);
      this.addEventListener('message', ({ data }) => {
        if (data.kind === 'pages') Object.assign(__pages, { rev: data.rev, final: data.final, theme: data.settings.theme });
        if (data.kind === 'failed') (window.__failed ??= []).push(data.diagnostics[0]);
      });
      const post = this.postMessage.bind(this);
      this.postMessage = (message, transfer) => {
        if (message.kind === 'edit') __pages.sent = message.rev;
        post(message, transfer);
      };
    }
  };`;

const view = `document.querySelector('.cm-content').cmTile.view`;
const { url } = await preview();
let failures = 0;

for (const name of args.browser ? [args.browser] : Object.keys(BROWSERS)) {
  console.log(`\n${name}`);
  const check = (label, ok, detail) => {
    if (!ok) failures++;
    console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}${!ok && detail !== undefined ? `: ${J(detail)}` : ''}`);
  };
  const browser = await BROWSERS[name]();
  const context = await browser.newContext({ viewport: { width: 1400, height: 900 }, acceptDownloads: true });
  await context.addInitScript(WATCH_WORKER);
  const page = await context.newPage();
  // Discarding unsaved changes and leaving with them are what each step means to do.
  page.on('dialog', (dialog) => dialog.accept());
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => message.type() === 'error' && errors.push(message.text()));
  const settled = () =>
    page.waitForFunction(() => __pages.final && __pages.rev === __pages.sent, null, { timeout: 60_000 }).catch(async (error) => {
      throw new Error(`${error.message.split('\n')[0]} ${J(await page.evaluate(() => ({ pages: __pages, failed: window.__failed, overlay: document.getElementById('overlay').textContent })))}`);
    });
  const text = () => page.evaluate(`${view}.state.doc.toString()`);

  try {
    const t0 = Date.now();
    await page.goto(url);
    await settled();
    const pages = await page.locator('#pages canvas[width]').count();
    check(`the sample typesets: ${pages} pages in ${Date.now() - t0} ms`, pages > 3, { pages, errors });
    check('no error on the console or in the page while it loads', errors.length === 0, errors);

    await page.evaluate(`(() => { const v = ${view}; v.dispatch({ selection: { anchor: v.state.doc.line(1).to } }); v.focus(); })()`);
    const before = await page.evaluate('__pages.rev');
    await page.keyboard.type(' typed');
    await settled();
    check('typing updates the preview', (await page.evaluate('__pages.rev')) > before && (await text()).split('\n')[0].endsWith(' typed'));

    const box = await page.locator('#pages .page').first().boundingBox();
    await page.mouse.click(box.x + box.width * 0.3, box.y + box.height * 0.35);
    await sleep(500);
    const head = await page.evaluate(`${view}.state.selection.main.head`);
    check('a click in the preview moves the editor cursor into the document', head > 40, head);

    await page.mouse.move(box.x + box.width * 0.5, box.y + box.height * 0.4);
    await page.waitForFunction(() => document.querySelectorAll('.text-layer span').length > 20, null, { timeout: 10_000 }).catch(() => {});
    const word = page.locator('.text-layer span').nth(5);
    const wordBox = await word.boundingBox();
    await page.mouse.dblclick(wordBox.x + wordBox.width * 0.3, wordBox.y + wordBox.height / 2);
    const selected = await page.evaluate(() => getSelection().toString().trim());
    check('a double click in the preview selects a word of it', /^[\p{L}\p{N}’'-]+$/u.test(selected), selected);
    const copied = await page.evaluate(
      () =>
        new Promise((resolve) => {
          addEventListener('copy', (e) => resolve(e.clipboardData.getData('text/plain')), { once: true });
          document.execCommand('copy');
        }),
    );
    check('copying it gives the word', copied === selected, { copied, selected });

    await page.locator('#settings > button').click();
    await page.locator('input[name=theme][value=paper]').check();
    await page.waitForFunction(() => __pages.theme === 'paper' && __pages.final, null, { timeout: 30_000 }).catch(() => {});
    check('choosing Paper typesets the pages in Paper', (await page.evaluate('__pages.theme')) === 'paper', { failed: await page.evaluate('window.__failed') });
    await page.keyboard.press('Escape');

    const [pdf] = await Promise.all([page.waitForEvent('download'), page.locator('#download-pdf').click()]);
    const pdfBytes = readFileSync(await pdf.path());
    check('Download .pdf downloads a PDF named after the file', pdf.suggestedFilename() === 'Untitled.pdf' && pdfBytes.subarray(0, 4).toString() === '%PDF', pdf.suggestedFilename());

    // check:files covers opening and saving with the File System Access API.
    if (!(await page.evaluate(() => 'showOpenFilePicker' in window))) {
      const [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.locator('#open').click()]);
      await chooser.setFiles({ name: 'notes.md', mimeType: 'text/markdown', buffer: Buffer.from('# Notes\n\nOpened.\n') });
      await page.waitForFunction(() => document.getElementById('file-name').textContent === 'notes.md', null, { timeout: 10_000 }).catch(() => {});
      check("Open reads a file through the browser's file dialog", (await text()) === '# Notes\n\nOpened.\n', await text());
      await page.evaluate(`(() => { const v = ${view}; v.dispatch({ changes: { from: v.state.doc.length, insert: 'Saved.' } }); })()`);
      const [saved] = await Promise.all([page.waitForEvent('download'), page.locator('#save').click()]);
      check('Save downloads the text under its name', saved.suggestedFilename() === 'notes.md' && readFileSync(await saved.path(), 'utf8') === '# Notes\n\nOpened.\nSaved.', saved.suggestedFilename());
    }

    // Firefox empties the clipboard data of a paste event a script made, so there an image arrives through the
    // folder dialog instead, as it does when a document's images are not found.
    const setText = (value) => page.evaluate(`(() => { const v = ${view}; v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: ${J(value)} }, selection: { anchor: ${value.length} } }); v.focus(); })()`);
    await setText('# Kept\n\n');
    const pasted = await page.evaluate(async () => {
      const canvas = new OffscreenCanvas(200, 100);
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = 'magenta';
      ctx.fillRect(0, 0, 200, 100);
      const blob = await canvas.convertToBlob();
      window.__png = [...new Uint8Array(await blob.arrayBuffer())];
      const data = new DataTransfer();
      data.items.add(new File([blob], 'pasted.png', { type: 'image/png' }));
      const event = new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true });
      let carried = false;
      document.addEventListener('paste', (e) => (carried = (e.clipboardData?.files.length ?? 0) > 0), { capture: true, once: true });
      document.querySelector('.cm-content').dispatchEvent(event);
      return carried;
    });
    if (pasted) {
      await page.waitForFunction(() => document.querySelector('.cm-content').cmTile.view.state.doc.toString().includes('![](pasted.png)'), null, { timeout: 10_000 }).catch(() => {});
      check('pasting an image writes its Markdown', (await text()) === '# Kept\n\n![](pasted.png)', await text());
    } else if (!(await page.evaluate(() => 'showDirectoryPicker' in window))) {
      const folder = mkdtempSync(join(tmpdir(), 'liveprint-browsers-'));
      writeFileSync(join(folder, 'pasted.png'), Buffer.from(await page.evaluate('__png')));
      await setText('# Kept\n\n![](pasted.png)');
      await settled();
      check('a missing image is reported in the bar', await page.locator('#image-notice').isVisible());
      const [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.locator('#choose-folder').click()]);
      await chooser.setFiles(folder);
      await page.waitForFunction(() => document.getElementById('image-notice').hidden, null, { timeout: 10_000 }).catch(() => {});
      check('Choose folder reads it through the folder dialog', !(await page.locator('#image-notice').isVisible()));
    }
    await settled();
    await sleep(500);
    await page.reload();
    await settled();
    check('a reload restores the text', (await text()) === '# Kept\n\n![](pasted.png)', await text());
    check('and the image, which the bar does not report missing', !(await page.locator('#image-notice').isVisible()));
    const shown = await page.evaluate(() => {
      const canvas = document.querySelector('#pages canvas');
      const ctx = Object.assign(document.createElement('canvas'), { width: canvas.width, height: canvas.height }).getContext('2d');
      ctx.drawImage(canvas, 0, 0);
      const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height);
      let magenta = 0;
      for (let i = 0; i < data.length; i += 4) if (data[i] > 200 && data[i + 1] < 60 && data[i + 2] > 200) magenta++;
      return magenta;
    });
    check('the preview draws the image', shown > 1000, shown);

    const worker = await page
      .waitForFunction(() => navigator.serviceWorker?.getRegistration().then((r) => r?.active?.state === 'activated'), null, { timeout: 60_000 })
      .then(() => true, () => false);
    check('the service worker installs', worker);
    check('no error on the console or in the page at any point', errors.length === 0, errors);
  } catch (error) {
    check('the run finished', false, error.message.split('\n')[0]);
  }
  await browser.close();
}

console.log(failures ? `\n${failures} failed` : '\nall passed');
process.exit(failures ? 1 : 0);
