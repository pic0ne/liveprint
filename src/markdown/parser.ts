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

/** The one Markdown dialect: CommonMark + GFM + `$..$` / `$$..$$` math. The editor and the converter both use it. */
export const markdownExtensions: MarkdownExtension = [GFM, MathSyntax];

export const markdownParser = commonmark.configure(markdownExtensions);
