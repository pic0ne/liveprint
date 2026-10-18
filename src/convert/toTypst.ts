import { type ImagePath, imagePath } from '../images';
import { markdownParser } from '../markdown/parser';
import { mathPieces } from './mathText';

type SyntaxNode = ReturnType<typeof markdownParser.parse>['topNode'];

/** A formula's Typst call, `mi("…")` or `mitex("…")`, exactly as the converter writes it. */
export type MathCall = string & { readonly __brand: 'MathCall' };

/** `text[i]` renders the Markdown character at offset `from + i`. */
export interface TextPiece {
  from: number;
  text: string;
  /** `text` is the symbol a LaTeX command at `from` prints, such as α for `\alpha`, not a copy of the Markdown. */
  symbol?: true;
}

export interface Converted {
  typst: string;
  /** The Markdown text the Typst source shows, in document order. Generated text (bullets, numbers) and math have none. */
  pieces: TextPiece[];
  /** Every local image the Markdown references, in document order, each once, whether it is available or not. */
  images: ImagePath[];
  /** The Markdown of each image shown, in document order, which is the order of their marks on the pages. */
  shownImages: Span[];
  /** The rejected formulas the Markdown has, shown as typed, in document order. */
  typedMath: MathCall[];
}

/** A stretch of the Markdown, from offset `from` up to `to`. */
export interface Span {
  from: number;
  to: number;
}

/** A link reference definition's URL, and where it starts in the Markdown. */
interface Ref {
  url: string;
  from: number;
}

interface Doc {
  src: string;
  refs: ReadonlyMap<string, Ref>;
  pieces: TextPiece[];
  available: ReadonlySet<ImagePath>;
  images: Set<ImagePath>;
  shownImages: Span[];
  rejected: Pick<ReadonlySet<MathCall>, 'has'>;
  typedMath: MathCall[];
}

type Emit = (node: SyntaxNode, doc: Doc) => string;

const TEXT_SPECIALS = /[\\#*_`$<>@[\]~/]/g;
const LINE_START_MARKER = /^(\s*)(?:(=+|[+-])|(\d+)\.)(?=\s|$)/;

const softBreaks = (text: string) => text.replace(/[ \t]*\n[ \t]*/g, ' ');
const escapeText = (text: string) => softBreaks(text).replace(TEXT_SPECIALS, '\\$&');

/** Content that opens a line or a content block must not read as a heading, list or enum marker. */
const defuseLineStart = (markup: string) =>
  markup.replace(LINE_START_MARKER, (_, space: string, marker?: string, digits?: string) =>
    marker ? `${space}\\${marker}` : `${space}${digits}\\.`,
  );

function str(text: string): string {
  return `"${text.replace(/[\\"\n\r\t]/g, (c) => STRING_ESCAPES[c]!)}"`;
}
const STRING_ESCAPES: Record<string, string> = { '\\': '\\\\', '"': '\\"', '\n': '\\n', '\r': '\\r', '\t': '\\t' };

const slice = (node: SyntaxNode, doc: Doc) => doc.src.slice(node.from, node.to);

/** Shows `text` as typed at `from`, so its characters link back to the Markdown. */
function shown(doc: Doc, from: number, text: string): string {
  if (text !== '') doc.pieces.push({ from, text });
  return text;
}
const verbatim = (doc: Doc, from: number, to: number) => shown(doc, from, doc.src.slice(from, to));
const childrenOf = (node: SyntaxNode): SyntaxNode[] => {
  const out: SyntaxNode[] = [];
  for (let c = node.firstChild; c; c = c.nextSibling) out.push(c);
  return out;
};
const named = (node: SyntaxNode, name: string) => childrenOf(node).filter((c) => c.name === name);

function inline(node: SyntaxNode, doc: Doc, from = node.from, to = node.to): string {
  let out = '';
  let pos = from;
  const text = (end: number) => {
    if (end > pos) out += escapeText(verbatim(doc, pos, end));
  };
  for (const child of childrenOf(node)) {
    if (child.to <= from || child.from >= to) continue;
    text(child.from);
    out += emit(child, doc);
    pos = child.to;
  }
  text(to);
  return defuseLineStart(out.trim());
}

const blankLineBetween = (doc: Doc, from: number, to: number) => /\n[ \t>]*\n/.test(doc.src.slice(from, to));

function blocks(nodes: SyntaxNode[], doc: Doc, separator = '\n\n'): string {
  return nodes
    .map((n) => emit(n, doc))
    .filter((s) => s !== '')
    .join(separator);
}

const contentOf = (node: SyntaxNode) => childrenOf(node).filter((c) => !MARKS.has(c.name));

function joinChildren(node: SyntaxNode, doc: Doc, part: string): string {
  return named(node, part)
    .map((c) => slice(c, doc))
    .join('');
}

const shownChildren = (node: SyntaxNode, doc: Doc, part: string) =>
  named(node, part)
    .map((c) => verbatim(doc, c.from, c.to))
    .join('');

function inlineBetweenMarks(node: SyntaxNode, doc: Doc): string {
  const [open, close] = named(node, 'LinkMark');
  return inline(node, doc, open?.to ?? node.from, close?.from ?? node.to);
}

function normalizeLabel(label: string): string {
  return label.slice(1, -1).trim().replace(/\s+/g, ' ').toLowerCase();
}

function linkTarget(url: string): string {
  if (/^[a-z][a-z0-9+.-]*:/i.test(url)) return url;
  if (/^www\./i.test(url)) return `https://${url}`;
  if (/^[^\s@/]+@[^\s@/]+\.[^\s@/]+$/.test(url)) return `mailto:${url}`;
  return url;
}

function link(url: string, body: string): string {
  return url.trim() === '' ? body : `#link(${str(linkTarget(url.trim()))})[${body}];`;
}

function heading(level: number): Emit {
  return (node, doc) => `#heading(level: ${level})[${inline(node, doc)}]`;
}

function list(node: SyntaxNode, doc: Doc): string {
  const items = named(node, 'ListItem');
  const loose =
    items.some((item, i) => i > 0 && blankLineBetween(doc, items[i - 1]!.to, item.from)) ||
    items.some((item) => {
      const kids = contentOf(item);
      return kids.some((kid, i) => i > 0 && blankLineBetween(doc, kids[i - 1]!.to, kid.from));
    });
  const args = [`tight: ${!loose}`];
  if (node.name === 'OrderedList') {
    const first = items[0]?.getChild('ListMark');
    const start = first ? parseInt(slice(first, doc), 10) : 1;
    if (Number.isFinite(start) && start !== 1) args.push(`start: ${start}`);
  }
  if (items.length > 0 && items.every((item) => item.getChild('Task'))) args.push('marker: []');
  const bodies = items.map((item) => `[${blocks(contentOf(item), doc, loose ? '\n\n' : '\n')}]`);
  return `#${node.name === 'OrderedList' ? 'enum' : 'list'}(${args.join(', ')})${bodies.join('')}`;
}

function tableRow(row: SyntaxNode, doc: Doc, columns: number): string[] {
  const kids = childrenOf(row);
  const cells: (SyntaxNode | null)[] = [];
  let current: SyntaxNode | null = null;
  for (const kid of kids) {
    if (kid.name === 'TableDelimiter') {
      cells.push(current);
      current = null;
    } else if (kid.name === 'TableCell') {
      current = kid;
    }
  }
  cells.push(current);
  if (kids[0]?.name === 'TableDelimiter' && kids[0].from === row.from) cells.shift();
  const last = kids[kids.length - 1];
  if (last?.name === 'TableDelimiter' && last.to === row.to) cells.pop();
  return Array.from({ length: columns }, (_, i) => {
    const cell = cells[i];
    return `[${cell ? inline(cell, doc) : ''}]`;
  });
}

function table(node: SyntaxNode, doc: Doc): string {
  const header = node.getChild('TableHeader');
  const rule = childrenOf(node).find((c) => c.name === 'TableDelimiter');
  if (!header || !rule) return paragraphFallback(node, doc);
  const aligns = slice(rule, doc)
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map((spec) => {
      const s = spec.trim();
      return s.endsWith(':') ? (s.startsWith(':') ? 'center' : 'right') : 'left';
    });
  const columns = aligns.length;
  const head = tableRow(header, doc, columns).join(', ');
  const rows = named(node, 'TableRow').map((r) => tableRow(r, doc, columns).join(', '));
  return [
    `#table(columns: ${columns}, align: (${aligns.join(', ')},),`,
    `  table.hline(), table.header(${head}), table.hline(),`,
    ...rows.map((r) => `  ${r},`),
    `  table.hline(),`,
    `)`,
  ].join('\n');
}

const ENTITIES: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: '\u00a0', copy: '©', reg: '®', trade: '™',
  mdash: '—', ndash: '–', hellip: '…', laquo: '«', raquo: '»', times: '×', middot: '·', deg: '°',
};

function entity(raw: string): string {
  const body = raw.slice(1, -1);
  const code = body.startsWith('#x') || body.startsWith('#X') ? parseInt(body.slice(2), 16) : body.startsWith('#') ? parseInt(body.slice(1), 10) : NaN;
  if (Number.isInteger(code) && code > 0 && code <= 0x10ffff && (code < 0xd800 || code > 0xdfff)) return String.fromCodePoint(code);
  return ENTITIES[body] ?? raw;
}

const textBlock = (doc: Doc, from: number, to: number) => defuseLineStart(escapeText(verbatim(doc, from, to).trim()));

const paragraphFallback: Emit = (node, doc) => textBlock(doc, node.from, node.to);

const drop: Emit = () => '';

/** A formula, or its LaTeX between its marks in a quiet monospace face when it was rejected or is not closed. */
const math: Emit = (node, doc) => {
  const block = node.name === 'BlockMath';
  const marks = named(node, 'MathMark').map((mark) => slice(mark, doc));
  const tex = joinChildren(node, doc, 'MathText');
  const call = `${marks[0] === '$$' ? 'mitex' : 'mi'}(${str(block ? tex.trim() : tex)})` as MathCall;
  const closed = marks.length === 2;
  if (closed && !doc.rejected.has(call)) {
    for (const part of named(node, 'MathText')) doc.pieces.push(...mathPieces(slice(part, doc), part.from));
    return `#${call}`;
  }
  if (closed) doc.typedMath.push(call);
  const typed = `${marks[0]}${shownChildren(node, doc, 'MathText')}${marks[1] ?? ''}`;
  return `#typed-math(raw(${str(block ? typed : typed.replace(/\n/g, ' '))}${block ? ', block: true' : ''}))`;
};

/** An image's URL as written, or as its reference defines it. Undefined for a reference with no definition. */
function imageTarget(node: SyntaxNode, doc: Doc): Ref | undefined {
  const url = node.getChild('URL');
  if (url) {
    const text = slice(url, doc);
    return { url: text, from: url.from };
  }
  const label = node.getChild('LinkLabel');
  const alt = named(node, 'LinkMark');
  return doc.refs.get(normalizeLabel(label ? slice(label, doc) : `[${doc.src.slice(alt[0]?.to ?? node.from, alt[1]?.from ?? node.to)}]`));
}

/** The image's local path, noted as referenced, if it names one that is available. */
function local(target: Ref, doc: Doc): ImagePath | null {
  const path = imagePath(target.url);
  if (!path) return null;
  doc.images.add(path);
  return doc.available.has(path) ? path : null;
}

/** Text as the reader would say it: marks, URLs and markup dropped, escapes and entities resolved. */
function plain(node: SyntaxNode, doc: Doc, from: number, to: number): string {
  let out = '';
  let pos = from;
  for (const child of childrenOf(node)) {
    if (child.to <= from || child.from >= to) continue;
    out += doc.src.slice(pos, child.from);
    if (child.name === 'Escape') out += doc.src.slice(child.from + 1, child.to);
    else if (child.name === 'Entity') out += entity(slice(child, doc));
    else if (!MARKS.has(child.name) && child.name !== 'URL') out += plain(child, doc, child.from, child.to);
    pos = child.to;
  }
  return out + doc.src.slice(pos, to);
}

/**
 * The image, marked so the preview can link it to the Markdown that names it. It shows no Markdown text: its alt text
 * is for screen readers and the PDF's tags, not printed.
 */
function image(node: SyntaxNode, doc: Doc, path: ImagePath): string {
  const [open, close] = named(node, 'LinkMark');
  const alt = softBreaks(plain(node, doc, open?.to ?? node.from, close?.from ?? node.to)).trim();
  doc.shownImages.push({ from: node.from, to: node.to });
  return `linked-image(image(${str(`/images/${path}`)}, alt: ${str(alt)}))`;
}

const PLACEHOLDER = 'block(stroke: (paint: luma(185), thickness: 0.5pt, dash: "dashed"), inset: 10pt, text(fill: luma(115))';

/** An image that cannot be shown keeps its place: its alt text in a quiet frame, or its URL when it has no alt text. */
function placeholder(node: SyntaxNode, doc: Doc, target: Ref): string {
  const alt = inlineBetweenMarks(node, doc);
  const body = alt !== '' ? alt : defuseLineStart(escapeText(shown(doc, target.from, target.url.trim())));
  return `${PLACEHOLDER}[${body}])`;
}

/** A paragraph of nothing but images, each centred on its own line. Null for any other paragraph. */
function blockImages(node: SyntaxNode, doc: Doc): string | null {
  const kids = childrenOf(node);
  const targets = kids.map((kid) => (kid.name === 'Image' ? imageTarget(kid, doc) : undefined));
  const gaps = kids.map((kid, i) => doc.src.slice(i === 0 ? node.from : kids[i - 1]!.to, kid.from)).concat(doc.src.slice(kids.at(-1)?.to ?? node.from, node.to));
  if (kids.length === 0 || targets.includes(undefined) || gaps.some((gap) => gap.trim() !== '')) return null;
  return kids
    .map((kid, i) => {
      const target = targets[i]!;
      const path = local(target, doc);
      return `#align(center, ${path ? `block(breakable: false, ${image(kid, doc, path)})` : placeholder(kid, doc, target)})`;
    })
    .join('\n');
}

const MARKS = new Set([
  'ListMark', 'QuoteMark', 'HeaderMark', 'EmphasisMark', 'CodeMark', 'CodeInfo', 'LinkMark', 'LinkLabel', 'LinkTitle',
  'TaskMarker', 'StrikethroughMark', 'TableDelimiter', 'MathMark',
]);

const EMITTERS: Record<string, Emit> = {
  Document: (node, doc) => blocks(childrenOf(node), doc),
  Paragraph: (node, doc) => blockImages(node, doc) ?? inline(node, doc),
  ATXHeading1: heading(1), ATXHeading2: heading(2), ATXHeading3: heading(3),
  ATXHeading4: heading(4), ATXHeading5: heading(5), ATXHeading6: heading(6),
  SetextHeading1: heading(1), SetextHeading2: heading(2),
  Blockquote: (node, doc) => `#quote(block: true)[\n${blocks(contentOf(node), doc)}\n]`,
  BulletList: list,
  OrderedList: list,
  Task: (node, doc) => {
    const marker = node.getChild('TaskMarker');
    const done = marker ? /x/i.test(slice(marker, doc)) : false;
    return `#task(${done})[${inline(node, doc, marker?.to ?? node.from)}]`;
  },
  FencedCode: (node, doc) => {
    const info = node.getChild('CodeInfo');
    const lang = info ? slice(info, doc).split(/\s/)[0]! : '';
    return `#raw(${str(shownChildren(node, doc, 'CodeText'))}, block: true${lang ? `, lang: ${str(lang)}` : ''})`;
  },
  CodeBlock: (node, doc) => `#raw(${str(shownChildren(node, doc, 'CodeText').replace(/\n+$/, ''))}, block: true)`,
  HorizontalRule: () => '#line(length: 100%)',
  Table: table,
  BlockMath: math,
  HTMLBlock: paragraphFallback,
  LinkReference: drop,
  CommentBlock: (node, doc) => textBlock(doc, node.from + (/^[^]*-->/.exec(slice(node, doc))?.[0].length ?? 0), node.to),
  ProcessingInstructionBlock: drop,

  Emphasis: (node, doc) => `#emph[${inline(node, doc)}];`,
  StrongEmphasis: (node, doc) => `#strong[${inline(node, doc)}];`,
  Strikethrough: (node, doc) => `#strike[${inline(node, doc)}];`,
  InlineCode: (node, doc) => {
    const [open, close] = named(node, 'CodeMark');
    let from = open?.to ?? node.from;
    let to = close?.from ?? node.to;
    if (/^ .*[^ ].* $/.test(doc.src.slice(from, to).replace(/\n/g, ' '))) [from, to] = [from + 1, to - 1];
    return `#raw(${str(verbatim(doc, from, to).replace(/\n/g, ' '))});`;
  },
  InlineMath: (node, doc) => `${math(node, doc)};`,
  Link: (node, doc) => {
    const url = node.getChild('URL');
    if (url) return link(slice(url, doc), inlineBetweenMarks(node, doc));
    const label = node.getChild('LinkLabel');
    const target = doc.refs.get(normalizeLabel(label ? slice(label, doc) : `[${doc.src.slice(node.from + 1, node.to - 1)}]`));
    return target === undefined ? escapeText(verbatim(doc, node.from, node.to)) : link(target.url, inlineBetweenMarks(node, doc));
  },
  Image: (node, doc) => {
    const target = imageTarget(node, doc);
    const path = target && local(target, doc);
    return path ? `#box(${image(node, doc, path)});` : inlineBetweenMarks(node, doc);
  },
  URL: (node, doc) => link(slice(node, doc), escapeText(verbatim(doc, node.from, node.to))),
  Autolink: (node, doc) => {
    const url = node.getChild('URL');
    return url ? emit(url, doc) : escapeText(verbatim(doc, node.from, node.to));
  },
  HardBreak: () => '#linebreak();',
  Escape: (node, doc) => escapeText(verbatim(doc, node.from + 1, node.to)),
  Entity: (node, doc) => escapeText(shown(doc, node.from, entity(slice(node, doc)))),
  HTMLTag: (node, doc) => escapeText(verbatim(doc, node.from, node.to)),
  Comment: drop,
  ProcessingInstruction: drop,
};

function emit(node: SyntaxNode, doc: Doc): string {
  if (MARKS.has(node.name)) return '';
  const emitter = EMITTERS[node.name];
  return emitter ? emitter(node, doc) : paragraphFallback(node, doc);
}

function collectRefs(root: SyntaxNode, src: string): Map<string, Ref> {
  const refs = new Map<string, Ref>();
  const defs: SyntaxNode[] = [];
  root.cursor().iterate((n) => {
    if (n.name === 'LinkReference') defs.push(n.node);
  });
  for (const def of defs) {
    const label = def.getChild('LinkLabel');
    const url = def.getChild('URL');
    if (!label || !url) continue;
    const key = normalizeLabel(src.slice(label.from, label.to));
    const text = src.slice(url.from, url.to);
    if (!refs.has(key)) refs.set(key, { url: text.replace(/^<|>$/g, ''), from: url.from + (text.startsWith('<') ? 1 : 0) });
  }
  return refs;
}

/**
 * Markdown to the Typst document body, the Markdown text it shows, and the local images it references. Images in
 * `available` are typeset from `/images/<path>`, and formulas whose call is in `rejected` show as typed. Pure and
 * total: every input yields Typst that parses. Piece offsets count in the text after `\r\n` became `\n`; the editor's
 * text never has `\r`.
 */
export function convert(
  markdown: string,
  available: ReadonlySet<ImagePath> = new Set(),
  rejected: Pick<ReadonlySet<MathCall>, 'has'> = new Set(),
): Converted {
  const src = markdown.replace(/\r\n?/g, '\n').replace(/\0/g, '\uFFFD');
  const root = markdownParser.parse(src).topNode;
  const doc: Doc = { src, refs: collectRefs(root, src), pieces: [], available, images: new Set(), shownImages: [], rejected, typedMath: [] };
  const typst = `${emit(root, doc)}\n`;
  return { typst, pieces: doc.pieces, images: [...doc.images], shownImages: doc.shownImages, typedMath: doc.typedMath };
}
