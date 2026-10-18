import { TreeFragment } from '@lezer/common';
import { expect, test } from 'vitest';
import { markdownParser } from './parser';

const blocks = (tree: ReturnType<typeof markdownParser.parse>) => {
  const names: string[] = [];
  for (let node = tree.topNode.firstChild; node; node = node.nextSibling) names.push(node.name);
  return names.join(' ');
};

test('typing the closing line of a long front matter turns the first rule into front matter, as the editor parses it', () => {
  const head = `---\ntitle: A field guide\nauthor:\n  - Ada Byron\n  - Robert Bringhurst\ndate: 2026-10-18\nabstract: ${'words '.repeat(30)}\nkeywords: [type, print]\n`;
  let doc = `${head}\nBody text.\n`;
  let tree = markdownParser.parse(doc);
  let fragments = TreeFragment.addTree(tree);
  for (let at = head.length; at < head.length + 3; at++) {
    doc = `${doc.slice(0, at)}-${doc.slice(at)}`;
    fragments = TreeFragment.applyChanges(fragments, [{ fromA: at, toA: at, fromB: at, toB: at + 1 }]);
    tree = markdownParser.parse(doc, fragments);
    fragments = TreeFragment.addTree(tree, fragments);
  }
  expect(blocks(tree)).toBe('FrontMatter Paragraph');
  expect(blocks(tree)).toBe(blocks(markdownParser.parse(doc)));
});
