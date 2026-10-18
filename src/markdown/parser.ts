import { tags } from '@lezer/highlight';
import { GFM, parser as commonmark } from '@lezer/markdown';
import type { BlockContext, Element, Line, MarkdownConfig, MarkdownExtension } from '@lezer/markdown';

const DOLLAR = 36;
const BACKSLASH = 92;

const isSpace = (ch: number) => ch === 32 || ch === 9 || ch === 10 || ch === 13;
const isDigit = (ch: number) => ch >= 48 && ch <= 57;

// The same container-continuation test lezer's own FencedCode uses; these fields are not in the public typings.
const continuesContainers = (cx: BlockContext, line: Line) =>
  (line as unknown as { depth: number }).depth >= (cx as unknown as { stack: unknown[] }).stack.length;

function parseBlockMath(cx: BlockContext, line: Line): boolean {
  if (!line.text.startsWith('$$', line.pos)) return false;
  const from = cx.lineStart + line.pos;
  const open = line.pos + 2;
  const sameLineClose = line.text.indexOf('$$', open);
  if (sameLineClose >= 0 && line.skipSpace(sameLineClose + 2) < line.text.length) return false;

  const children: Element[] = [cx.elt('MathMark', from, from + 2)];
  const text = (a: number, b: number) => {
    if (a < b) children.push(cx.elt('MathText', a, b));
  };
  const close = (at: number) => children.push(cx.elt('MathMark', at, at + 2));

  if (sameLineClose >= 0) {
    text(cx.lineStart + open, cx.lineStart + sameLineClose);
    close(cx.lineStart + sameLineClose);
    cx.nextLine();
  } else {
    text(cx.lineStart + open, cx.lineStart + line.text.length);
    while (cx.nextLine() && continuesContainers(cx, line)) {
      children.push(...line.markers);
      text(cx.lineStart - 1, cx.lineStart);
      const end = line.text.indexOf('$$', line.basePos);
      if (end >= 0) {
        text(cx.lineStart + line.basePos, cx.lineStart + end);
        close(cx.lineStart + end);
        cx.nextLine();
        break;
      }
      text(cx.lineStart + line.basePos, cx.lineStart + line.text.length);
    }
  }
  cx.addElement(cx.elt('BlockMath', from, cx.prevLineEnd(), children));
  return true;
}

const MathSyntax: MarkdownConfig = {
  defineNodes: [
    { name: 'BlockMath', block: true, style: tags.monospace },
    { name: 'InlineMath', style: tags.monospace },
    { name: 'MathText' },
    { name: 'MathMark', style: tags.processingInstruction },
  ],
  parseBlock: [{ name: 'BlockMath', parse: parseBlockMath, before: 'FencedCode' }],
  parseInline: [
    {
      name: 'InlineMath',
      parse(cx, next, pos) {
        if (next !== DOLLAR) return -1;
        const width = cx.char(pos + 1) === DOLLAR ? 2 : 1;
        const start = pos + width;
        if (width === 1 && (start >= cx.end || isSpace(cx.char(start)))) return -1;
        for (let i = start; i < cx.end; i++) {
          const ch = cx.char(i);
          if (ch === BACKSLASH) {
            i++;
            continue;
          }
          if (ch !== DOLLAR || i === start) continue;
          if (width === 2) {
            if (cx.char(i + 1) !== DOLLAR) continue;
          } else if (isSpace(cx.char(i - 1)) || isDigit(cx.char(i + 1))) {
            continue;
          }
          return cx.addElement(
            cx.elt('InlineMath', pos, i + width, [
              cx.elt('MathMark', pos, start),
              cx.elt('MathText', start, i),
              cx.elt('MathMark', i, i + width),
            ]),
          );
        }
        return -1;
      },
    },
  ],
};

// The parse's whole input, which a block parser cannot see past the next line through the public API.
const inputOf = (cx: BlockContext) => (cx as unknown as { input: { read(from: number, to: number): string; length: number } }).input;

/** Front matter longer than this is not looked for. */
const FRONT_MATTER_MAX = 64 * 1024;
const FRONT_MATTER = /^---[ \t]*\n(?![ \t]*\n)((?:.*\n)*?)(?:---|\.\.\.)[ \t]*(?:\n|$)/;
/** A line YAML could hold: blank, a comment, indented, a list item, or a key. Prose is none of these. */
const YAML_LINE = /^(?:[ \t]*(?:#.*)?|[ \t].*|- .*|-|[\w-][\w -]*:(?:[ \t].*)?)$/;
const KEY_LINE = /^([\w-][\w -]*?)[ \t]*:(?:[ \t]+(.*?))?[ \t]*$/;
const ITEM_LINE = /^[ \t]*- (.*?)[ \t]*$/;

/**
 * A YAML block that opens the document between `---` lines, as Pandoc and static site generators read it. A closing
 * `---` or `...` line is required, and every line between must be one YAML could hold, so a thematic break at the
 * top of a document, or one being typed, is never taken for it.
 */
function parseFrontMatter(cx: BlockContext, line: Line): boolean {
  if (cx.lineStart !== 0 || line.pos !== 0 || !line.text.startsWith('---')) return false;
  const input = inputOf(cx);
  const match = FRONT_MATTER.exec(input.read(0, Math.min(input.length, FRONT_MATTER_MAX)));
  const body = match?.[1]!.slice(0, -1).split('\n') ?? [];
  if (!match || !body.every((text) => YAML_LINE.test(text))) return false;

  const children: Element[] = [cx.elt('FrontMatterMark', 0, 3)];
  let at = line.text.length + 1;
  for (const text of body) {
    const key = KEY_LINE.exec(text);
    const item = key ? null : ITEM_LINE.exec(text);
    if (key) {
      children.push(cx.elt('FrontMatterKey', at, at + key[1]!.length));
      if (key[2]) children.push(...values(cx, key[2], at + text.indexOf(key[2], key[1]!.length + 1)));
    } else if (item?.[1]) {
      children.push(...values(cx, item[1], at + text.lastIndexOf(item[1])));
    }
    at += text.length + 1;
  }
  children.push(cx.elt('FrontMatterMark', at, at + 3));
  const end = match[0].replace(/\n$/, '').length;
  while (cx.lineStart < end && cx.nextLine());
  cx.addElement(cx.elt('FrontMatter', 0, end, children));
  return true;
}

/** The values of a scalar at `from`, or of each item of a `[flow, list]`, without quotes or a trailing comment. */
function values(cx: BlockContext, raw: string, from: number): Element[] {
  const flow = /^\[(.*)\]$/.exec(raw);
  const parts = flow ? [...flow[1]!.matchAll(/(?:"[^"]*"|'[^']*'|[^,])+/g)].map((m) => ({ text: m[0], at: from + 1 + m.index })) : [{ text: raw, at: from }];
  return parts.flatMap(({ text, at }) => {
    const lead = text.length - text.trimStart().length;
    let value = text.trim();
    at += lead;
    const quoted = /^(["'])(.*)\1$/.exec(value);
    if (quoted) {
      value = quoted[2]!;
      at += 1;
    } else {
      value = value.replace(/\s+#.*$/, '');
    }
    return value === '' ? [] : [cx.elt('FrontMatterValue', at, at + value.length)];
  });
}

const FrontMatterSyntax: MarkdownConfig = {
  defineNodes: [
    { name: 'FrontMatter', block: true },
    { name: 'FrontMatterMark', style: tags.processingInstruction },
    { name: 'FrontMatterKey', style: tags.propertyName },
    { name: 'FrontMatterValue', style: tags.string },
  ],
  parseBlock: [{ name: 'FrontMatter', parse: parseFrontMatter, before: 'HorizontalRule' }],
};

const FOOTNOTE_LABEL = /^\[\^([^\]\s]+)\]/;
/** The label of a footnote definition that `text` opens. A definition ends the paragraph before it. */
function isFootnoteDefinition(text: string): RegExpExecArray | null {
  const label = FOOTNOTE_LABEL.exec(text);
  return label && text[label[0].length] === ':' ? label : null;
}
/** A definition's text continues on lines indented this far, as in GitHub's footnotes. */
const FOOTNOTE_INDENT = 4;

/**
 * GitHub's footnotes: `[^label]` refers to a definition `[^label]: text`, whose later lines are indented. A
 * definition is a block of its own, like a list item, so it can hold several paragraphs.
 */
const FootnoteSyntax: MarkdownConfig = {
  defineNodes: [
    {
      name: 'FootnoteDefinition',
      block: true,
      composite(_cx, line, value) {
        if (line.indent < line.baseIndent + value && line.next > -1) return false;
        line.moveBaseColumn(line.baseIndent + value);
        return true;
      },
    },
    { name: 'FootnoteReference', style: tags.labelName },
    { name: 'FootnoteLabel', style: tags.labelName },
  ],
  parseBlock: [
    {
      name: 'FootnoteDefinition',
      parse(cx, line) {
        const label = isFootnoteDefinition(line.text.slice(line.pos));
        if (!label) return false;
        const from = cx.lineStart + line.pos;
        cx.startComposite('FootnoteDefinition', line.pos, FOOTNOTE_INDENT);
        cx.addElement(cx.elt('FootnoteLabel', from, from + label[0].length + 1));
        line.moveBase(line.skipSpace(line.pos + label[0].length + 1));
        return null;
      },
      endLeaf: (_cx, line) => isFootnoteDefinition(line.text.slice(line.pos)) !== null,
      before: 'LinkReference',
    },
  ],
  parseInline: [
    {
      name: 'FootnoteReference',
      parse(cx, next, pos) {
        if (next !== 91 /* [ */ || cx.char(pos + 1) !== 94 /* ^ */) return -1;
        const label = FOOTNOTE_LABEL.exec(cx.slice(pos, cx.end));
        return label ? cx.addElement(cx.elt('FootnoteReference', pos, pos + label[0].length)) : -1;
      },
      before: 'Link',
    },
  ],
};

/** A `[[toc]]` line, where the table of contents goes. */
const TOC_LINE = /^\[\[toc\]\][ \t]*$/i;
const TocSyntax: MarkdownConfig = {
  defineNodes: [{ name: 'TableOfContents', block: true, style: tags.processingInstruction }],
  parseBlock: [
    {
      name: 'TableOfContents',
      parse(cx, line) {
        if (!TOC_LINE.test(line.text.slice(line.pos))) return false;
        cx.addElement(cx.elt('TableOfContents', cx.lineStart + line.pos, cx.lineStart + line.text.length));
        cx.nextLine();
        return true;
      },
      endLeaf: (_cx, line) => TOC_LINE.test(line.text.slice(line.pos)),
      before: 'LinkReference',
    },
  ],
};

/**
 * The one Markdown dialect: CommonMark + GFM + `$..$` / `$$..$$` math + YAML front matter + footnotes + `[[toc]]`. The
 * editor and the converter both use it.
 */
export const markdownExtensions: MarkdownExtension = [GFM, MathSyntax, FrontMatterSyntax, FootnoteSyntax, TocSyntax];

export const markdownParser = commonmark.configure(markdownExtensions);
