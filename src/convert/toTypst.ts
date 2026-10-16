import { markdownParser } from '../markdown/parser';

type SyntaxNode = ReturnType<typeof markdownParser.parse>['topNode'];

interface Doc {
  src: string;
  refs: ReadonlyMap<string, string>;
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
    if (end > pos) out += escapeText(doc.src.slice(pos, end));
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
  const rows = named(node, 'TableRow').map((r) => tableRow(r, doc, columns).join(', '));
  return [
    `#table(columns: ${columns}, align: (${aligns.join(', ')},),`,
    `  table.hline(), table.header(${tableRow(header, doc, columns).join(', ')}), table.hline(),`,
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

const textBlock = (text: string) => defuseLineStart(escapeText(text.trim()));

const paragraphFallback: Emit = (node, doc) => textBlock(slice(node, doc));

const drop: Emit = () => '';

const MARKS = new Set([
  'ListMark', 'QuoteMark', 'HeaderMark', 'EmphasisMark', 'CodeMark', 'CodeInfo', 'LinkMark', 'LinkLabel', 'LinkTitle',
  'TaskMarker', 'StrikethroughMark', 'TableDelimiter', 'MathMark',
]);

const EMITTERS: Record<string, Emit> = {
  Document: (node, doc) => blocks(childrenOf(node), doc),
  Paragraph: inline,
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
    return `#raw(${str(joinChildren(node, doc, 'CodeText'))}, block: true${lang ? `, lang: ${str(lang)}` : ''})`;
  },
  CodeBlock: (node, doc) => `#raw(${str(joinChildren(node, doc, 'CodeText').replace(/\n+$/, ''))}, block: true)`,
  HorizontalRule: () => '#line(length: 100%)',
  Table: table,
  BlockMath: (node, doc) => {
    const tex = joinChildren(node, doc, 'MathText');
    const closed = named(node, 'MathMark').length === 2;
    return closed ? `#mitex(${str(tex.trim())})` : `#raw(${str(`$$${tex}`)}, block: true)`;
  },
  HTMLBlock: paragraphFallback,
  LinkReference: drop,
  CommentBlock: (node, doc) => textBlock(slice(node, doc).replace(/^[^]*-->/, '')),
  ProcessingInstructionBlock: drop,

  Emphasis: (node, doc) => `#emph[${inline(node, doc)}];`,
  StrongEmphasis: (node, doc) => `#strong[${inline(node, doc)}];`,
  Strikethrough: (node, doc) => `#strike[${inline(node, doc)}];`,
  InlineCode: (node, doc) => {
    const [open, close] = named(node, 'CodeMark');
    let code = doc.src.slice(open?.to ?? node.from, close?.from ?? node.to).replace(/\n/g, ' ');
    if (/^ .*[^ ].* $/.test(code)) code = code.slice(1, -1);
    return `#raw(${str(code)});`;
  },
  InlineMath: (node, doc) => {
    const display = (node.getChild('MathMark')?.to ?? 0) - node.from === 2;
    return `#${display ? 'mitex' : 'mi'}(${str(joinChildren(node, doc, 'MathText'))});`;
  },
  Link: (node, doc) => {
    const body = inlineBetweenMarks(node, doc);
    const url = node.getChild('URL');
    if (url) return link(slice(url, doc), body);
    const label = node.getChild('LinkLabel');
    const target = doc.refs.get(normalizeLabel(label ? slice(label, doc) : `[${doc.src.slice(node.from + 1, node.to - 1)}]`));
    return target === undefined ? escapeText(slice(node, doc)) : link(target, body);
  },
  Image: inlineBetweenMarks,
  URL: (node, doc) => link(slice(node, doc), escapeText(slice(node, doc))),
  Autolink: (node, doc) => {
    const url = node.getChild('URL');
    return url ? emit(url, doc) : escapeText(slice(node, doc));
  },
  HardBreak: () => '#linebreak();',
  Escape: (node, doc) => escapeText(slice(node, doc).slice(1)),
  Entity: (node, doc) => escapeText(entity(slice(node, doc))),
  HTMLTag: (node, doc) => escapeText(slice(node, doc)),
  Comment: drop,
  ProcessingInstruction: drop,
};

function emit(node: SyntaxNode, doc: Doc): string {
  if (MARKS.has(node.name)) return '';
  const emitter = EMITTERS[node.name];
  return emitter ? emitter(node, doc) : paragraphFallback(node, doc);
}

function collectRefs(root: SyntaxNode, src: string): Map<string, string> {
  const refs = new Map<string, string>();
  const defs: SyntaxNode[] = [];
  root.cursor().iterate((n) => {
    if (n.name === 'LinkReference') defs.push(n.node);
  });
  for (const def of defs) {
    const label = def.getChild('LinkLabel');
    const url = def.getChild('URL');
    if (!label || !url) continue;
    const key = normalizeLabel(src.slice(label.from, label.to));
    if (!refs.has(key)) refs.set(key, src.slice(url.from, url.to).replace(/^<|>$/g, ''));
  }
  return refs;
}

/** Markdown to the Typst document body. Pure and total: every input yields Typst that parses. */
export function toTypst(markdown: string): string {
  const src = markdown.replace(/\r\n?/g, '\n').replace(/\0/g, '\uFFFD');
  const root = markdownParser.parse(src).topNode;
  return `${emit(root, { src, refs: collectRefs(root, src) })}\n`;
}
