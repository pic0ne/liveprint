// Draws the app icon, a page in A4 proportions on ink with a lowercase letter of the wordmark's face, and renders its PNGs
// in headless Chrome. Writes public/icon.svg and the PNGs that public/manifest.webmanifest and index.html name.
// node bench/icon.mjs [--letter p]
import { readFileSync, writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { launch } from './cdp.mjs';

const { values: args } = parseArgs({ options: { letter: { type: 'string', default: 'p' } } });
const INK = '#1f1e1c';
const PAGE = '#ffffff';
const SIZE = 512;
const font = readFileSync(new URL('../public/fonts/LibertinusSerif-Regular.otf', import.meta.url));

function table(tag) {
  for (let i = 0; i < font.readUInt16BE(4); i++) {
    const at = 12 + i * 16;
    if (font.toString('latin1', at, at + 4) !== tag) continue;
    const start = font.readUInt32BE(at + 8);
    return font.subarray(start, start + font.readUInt32BE(at + 12));
  }
  throw new Error(`no ${tag} table`);
}

/** The glyph id of a character in the Windows Unicode BMP subtable (format 4). */
function glyphId(char) {
  const cmap = table('cmap');
  const code = char.codePointAt(0);
  for (let i = 0; i < cmap.readUInt16BE(2); i++) {
    const sub = cmap.subarray(cmap.readUInt32BE(8 + i * 8));
    if (cmap.readUInt16BE(4 + i * 8) !== 3 || cmap.readUInt16BE(6 + i * 8) !== 1 || sub.readUInt16BE(0) !== 4) continue;
    const segments = sub.readUInt16BE(6);
    const [ends, starts, deltas, ranges] = [14, 16 + segments, 16 + 2 * segments, 16 + 3 * segments];
    for (let s = 0; s < segments; s += 2) {
      if (sub.readUInt16BE(ends + s) < code) continue;
      const start = sub.readUInt16BE(starts + s);
      if (start > code) break;
      const delta = sub.readUInt16BE(deltas + s);
      const range = sub.readUInt16BE(ranges + s);
      if (range === 0) return (code + delta) & 0xffff;
      const glyph = sub.readUInt16BE(ranges + s + range + (code - start) * 2);
      return glyph === 0 ? 0 : (glyph + delta) & 0xffff;
    }
  }
  throw new Error(`${char} is not in the font`);
}

function readIndex(buf, at) {
  const count = buf.readUInt16BE(at);
  if (count === 0) return { items: [], end: at + 2 };
  const size = buf[at + 2];
  const offset = (i) => buf.readUIntBE(at + 3 + i * size, size);
  const base = at + 3 + (count + 1) * size - 1;
  const items = Array.from({ length: count }, (_, i) => buf.subarray(base + offset(i), base + offset(i + 1)));
  return { items, end: base + offset(count) };
}

/** Integer operands by operator; real numbers are skipped, since only offsets and sizes are read. */
function readDict(buf) {
  const dict = {};
  let operands = [];
  for (let i = 0; i < buf.length; ) {
    const b = buf[i];
    if (b <= 21) {
      const op = b === 12 ? 1200 + buf[i + 1] : b;
      i += b === 12 ? 2 : 1;
      dict[op] = operands;
      operands = [];
    } else if (b === 28) (operands.push(buf.readInt16BE(i + 1)), (i += 3));
    else if (b === 29) (operands.push(buf.readInt32BE(i + 1)), (i += 5));
    else if (b === 30) {
      while ((buf[++i] & 15) !== 15 && buf[i] >> 4 !== 15);
      i++;
      operands.push(NaN);
    } else if (b <= 246) (operands.push(b - 139), i++);
    else if (b <= 250) (operands.push((b - 247) * 256 + buf[i + 1] + 108), (i += 2));
    else (operands.push(-(b - 251) * 256 - buf[i + 1] - 108), (i += 2));
  }
  return dict;
}

const bias = (subrs) => (subrs.length < 1240 ? 107 : subrs.length < 33900 ? 1131 : 32768);

/** The glyph's outline as absolute points in font units, y up: a list of contours of ['M' | 'L' | 'C', ...coordinates]. */
function outline(char) {
  const cff = table('CFF ');
  const names = readIndex(cff, cff[2]);
  const tops = readIndex(cff, names.end);
  const gsubrs = readIndex(cff, readIndex(cff, tops.end).end).items;
  const top = readDict(tops.items[0]);
  if (top[1230]) throw new Error('CID-keyed fonts are not supported');
  const [privateSize, privateAt] = top[18];
  const priv = readDict(cff.subarray(privateAt, privateAt + privateSize));
  const subrs = priv[19] ? readIndex(cff, privateAt + priv[19][0]).items : [];

  const commands = [];
  let x = 0;
  let y = 0;
  let stack = [];
  let hints = 0;
  const move = (dx, dy) => commands.push(['M', (x += dx), (y += dy)]);
  const line = (dx, dy) => commands.push(['L', (x += dx), (y += dy)]);
  const curve = (a, b, c, d, e, f) => {
    const [x1, y1] = [x + a, y + b];
    const [x2, y2] = [x1 + c, y1 + d];
    commands.push(['C', x1, y1, x2, y2, (x = x2 + e), (y = y2 + f)]);
  };
  // The first stack-clearing operator may carry the advance width as an extra leading operand; it is dropped.
  const stems = () => ((hints += stack.length >> 1), (stack = []));
  const args = (n) => (stack.length > n ? stack.slice(1) : stack);

  function run(code) {
    for (let i = 0; i < code.length; ) {
      const b = code[i];
      if (b === 28) (stack.push(code.readInt16BE(i + 1)), (i += 3));
      else if (b >= 32 && b <= 246) (stack.push(b - 139), i++);
      else if (b >= 247 && b <= 250) (stack.push((b - 247) * 256 + code[i + 1] + 108), (i += 2));
      else if (b >= 251 && b <= 254) (stack.push(-(b - 251) * 256 - code[i + 1] - 108), (i += 2));
      else if (b === 255) (stack.push(code.readInt32BE(i + 1) / 65536), (i += 5));
      else {
        i++;
        const op = b === 12 ? 1200 + code[i++] : b;
        const s = stack;
        switch (op) {
          case 1: case 3: case 18: case 23:
            stems();
            break;
          case 19: case 20:
            stems();
            i += Math.ceil(hints / 8);
            break;
          case 21: move(...args(2)); stack = []; break;
          case 22: move(args(1)[0], 0); stack = []; break;
          case 4: move(0, args(1)[0]); stack = []; break;
          case 5: for (let k = 0; k < s.length; k += 2) line(s[k], s[k + 1]); stack = []; break;
          case 6: case 7:
            s.forEach((d, k) => ((k % 2 === 0) === (op === 6) ? line(d, 0) : line(0, d)));
            stack = [];
            break;
          case 8: for (let k = 0; k + 5 < s.length; k += 6) curve(...s.slice(k, k + 6)); stack = []; break;
          case 24: {
            let k = 0;
            for (; k + 6 < s.length; k += 6) curve(...s.slice(k, k + 6));
            line(s[k], s[k + 1]);
            stack = [];
            break;
          }
          case 25: {
            let k = 0;
            for (; k + 6 < s.length; k += 2) line(s[k], s[k + 1]);
            curve(...s.slice(k, k + 6));
            stack = [];
            break;
          }
          case 26: case 27: {
            let k = s.length % 2;
            let first = k ? s[0] : 0;
            for (; k < s.length; k += 4, first = 0) {
              if (op === 26) curve(first, s[k], s[k + 1], s[k + 2], 0, s[k + 3]);
              else curve(s[k], first, s[k + 1], s[k + 2], s[k + 3], 0);
            }
            stack = [];
            break;
          }
          case 30: case 31: {
            let horizontal = op === 31;
            for (let k = 0; k + 3 < s.length; k += 4, horizontal = !horizontal) {
              const last = s.length - k === 5 ? s[k + 4] : 0;
              if (horizontal) curve(s[k], 0, s[k + 1], s[k + 2], last, s[k + 3]);
              else curve(0, s[k], s[k + 1], s[k + 2], s[k + 3], last);
            }
            stack = [];
            break;
          }
          case 10: case 29: {
            const pool = op === 10 ? subrs : gsubrs;
            if (run(pool[stack.pop() + bias(pool)]) === 'end') return 'end';
            break;
          }
          case 1235: curve(...s.slice(0, 6)); curve(...s.slice(6, 12)); stack = []; break;
          case 1234: curve(s[0], 0, s[1], s[2], s[3], 0); curve(s[4], 0, s[5], -s[2], s[6], 0); stack = []; break;
          case 1236:
            curve(s[0], s[1], s[2], s[3], s[4], 0);
            curve(s[5], 0, s[6], s[7], s[8], -(s[1] + s[3] + s[7]));
            stack = [];
            break;
          case 1237: {
            const dx = s[0] + s[2] + s[4] + s[6] + s[8];
            const dy = s[1] + s[3] + s[5] + s[7] + s[9];
            curve(...s.slice(0, 6));
            curve(s[6], s[7], s[8], s[9], ...(Math.abs(dx) > Math.abs(dy) ? [s[10], -dy] : [-dx, s[10]]));
            stack = [];
            break;
          }
          case 11: return;
          case 14: return 'end';
          default: throw new Error(`charstring operator ${op} is not supported`);
        }
      }
    }
  }
  run(readIndex(cff, top[17][0]).items[glyphId(char)]);
  return commands;
}

const round = (n) => Math.round(n * 100) / 100;

/** The glyph as an SVG path, its outline's box `height` tall and centred on the page. */
function letterPath(commands, page, height) {
  const xs = commands.flatMap(([, ...c]) => c.filter((_, i) => i % 2 === 0));
  const ys = commands.flatMap(([, ...c]) => c.filter((_, i) => i % 2 === 1));
  const [minX, maxX, minY, maxY] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
  const scale = height / (maxY - minY);
  const left = page.x + page.width / 2 - ((minX + maxX) / 2) * scale;
  const baseline = page.y + page.height / 2 + ((maxY - minY) / 2) * scale + minY * scale;
  const point = (px, py) => `${round(left + px * scale)} ${round(baseline - py * scale)}`;
  return commands
    .map(([op, ...c], i) => {
      const close = op === 'M' && i > 0 ? 'Z' : '';
      const points = [];
      for (let k = 0; k < c.length; k += 2) points.push(point(c[k], c[k + 1]));
      return `${close}${op}${points.join(' ')}`;
    })
    .join('')
    .concat('Z');
}

/** A page in A4 proportions, `height` tall, centred on the square. */
function svg(height) {
  const width = height / Math.SQRT2;
  const page = { x: (SIZE - width) / 2, y: (SIZE - height) / 2, width, height };
  const d = letterPath(outline(args.letter), page, height * 0.58);
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${SIZE} ${SIZE}"><rect width="${SIZE}" height="${SIZE}" fill="${INK}"/><rect x="${round(page.x)}" y="${round(page.y)}" width="${round(width)}" height="${height}" fill="${PAGE}"/><path fill="${INK}" d="${d}"/></svg>\n`;
}

// 384 puts the top and bottom edges on whole pixels at 32 px.
const any = svg(384);
// The maskable page's corners stay inside the central 80% circle: its diagonal is 1.22 × 320 = 392 of the 410 allowed.
const maskable = svg(320);
const publicFile = (name) => new URL(`../public/${name}`, import.meta.url);
writeFileSync(publicFile('icon.svg'), any);

const { page, close } = await launch({ serve: false, width: SIZE, height: SIZE });
async function png(source, size, name) {
  await page.send('Emulation.setDeviceMetricsOverride', { width: size, height: size, deviceScaleFactor: 1, mobile: false });
  const html = `<body style="margin:0;overflow:hidden"><img style="display:block" width="${size}" height="${size}" src="data:image/svg+xml;base64,${Buffer.from(source).toString('base64')}"></body>`;
  await page.send('Page.navigate', { url: `data:text/html;base64,${Buffer.from(html).toString('base64')}` });
  await new Promise((r) => setTimeout(r, 300));
  const { data } = await page.send('Page.captureScreenshot', { format: 'png', clip: { x: 0, y: 0, width: size, height: size, scale: 1 } });
  writeFileSync(publicFile(name), Buffer.from(data, 'base64'));
  console.log(`public/${name}`);
}
await png(any, 192, 'icon-192.png');
await png(any, 512, 'icon-512.png');
await png(any, 180, 'apple-touch-icon.png');
await png(maskable, 512, 'icon-maskable-512.png');
await close();
console.log('public/icon.svg');
process.exit(0);
