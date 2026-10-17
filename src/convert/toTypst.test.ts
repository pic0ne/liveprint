import { describe, expect, test } from 'vitest';
import sample from '../sample.md?raw';
import type { ImagePath } from '../images';
import { convert, type MathCall, type TextPiece } from './toTypst';

const cases: [string, string, string][] = [
  ['ATX and setext headings', '# Title #\n\nSetext\n---', '#heading(level: 1)[Title]\n\n#heading(level: 2)[Setext]'],
  [
    'nested emphasis, strike and inline code',
    'a *b **c** d* ~~e~~ `f` and ` g `',
    'a #emph[b #strong[c]; d]; #strike[e]; #raw("f"); and #raw("g");',
  ],
  [
    'Typst specials escaped, smart punctuation left alone',
    'x \\* y #z $5 and $6 a_b <c> @d [e] ~f // g /* h */ 1/2 "q" -- ... it\'s',
    'x \\* y \\#z \\$5 and \\$6 a\\_b \\<c\\> \\@d \\[e\\] \\~f \\/\\/ g \\/\\* h \\*\\/ 1\\/2 "q" -- ... it\'s',
  ],
  ['soft breaks become spaces', 'one\ntwo\n  three', 'one two three'],
  ['hard breaks', 'line  \nbreak\\\nend', 'line#linebreak();break#linebreak();end'],
  [
    'tight lists, nesting and enum start',
    '- a\n- b\n  - c\n\n3. x\n4. y',
    '#list(tight: true)[a][b\n#list(tight: true)[c]]\n\n#enum(tight: true, start: 3)[x][y]',
  ],
  ['loose list from blank line between items', '- a\n\n- b', '#list(tight: false)[a][b]'],
  ['loose list from blank line inside an item', '1. a\n\n   para\n2. b', '#enum(tight: false)[a\n\npara][b]'],
  ['task list', '- [x] done\n- [ ] todo', '#list(tight: true, marker: [])[#task(true)[done]][#task(false)[todo]]'],
  ['nested quotes', '> q1\n>\n> > nested *e*', '#quote(block: true)[\nq1\n\n#quote(block: true)[\nnested #emph[e];\n]\n]'],
  [
    'fenced code keeps bytes and takes the first info word',
    '```py title\nprint("hi\\\\n")\n\tx\n```',
    '#raw("print(\\"hi\\\\\\\\n\\")\\n\\tx", block: true, lang: "py")',
  ],
  ['fenced code inside a quote drops the quote marks', '> ```\n> a\n>\n> b\n> ```', '#quote(block: true)[\n#raw("a\\n\\nb", block: true)\n]'],
  ['indented code', '    indented\n    code\n', '#raw("indented\\ncode", block: true)'],
  ['inline and inline-display math', 'inline $x^2$ and $$\\sum_i i$$ end', 'inline #mi("x^2"); and #mitex("\\\\sum_i i"); end'],
  ['block math over lines', '$$\na \\\\\nb\n$$', '#mitex("a \\\\\\\\\\nb")'],
  ['unclosed block math shows as typed', '$$\nunclosed', '#typed-math(raw("$$\\nunclosed", block: true))'],
  [
    'table alignment, empty cells, ragged rows',
    '| a | b | c |\n|:--|:-:|--:|\n| 1 |  | 3 | 4 |\n| only |',
    '#table(columns: 3, align: (left, center, right,),\n  table.hline(), table.header([a], [b], [c]), table.hline(),\n  [1], [], [3],\n  [only], [], [],\n  table.hline(),\n)',
  ],
  [
    'links of every kind; images show alt text',
    '[text](http://a.b "t") [ref] [Nope] ![alt *x*](i.png) <http://u> <me@x.org> www.e.com\n\n[ref]: http://r.example',
    '#link("http://a.b")[text]; #link("http://r.example")[ref]; \\[Nope\\] alt #emph[x]; #link("http://u")[http:\\/\\/u]; #link("mailto:me@x.org")[me\\@x.org]; #link("https://www.e.com")[www.e.com];',
  ],
  ['entities', '&amp; &lt; &#65; &#x263A; &bogus;', '& \\< A ☺ &bogus;'],
  ['HTML is shown as text, comments dropped', 'a <b>c</b> <!-- d --> e\n\n<!-- x -->- y', 'a \\<b\\>c\\<\\/b\\>  e\n\n\\- y'],
  ['thematic breaks', '---\n\n***', '#line(length: 100%)\n\n#line(length: 100%)'],
  [
    'line-start markers never become Typst structure',
    '\\- x\n\n\\= y\n\n\\+ z\n\n2\\. w\n\n&#45; v\n\n- = h\n- *- e*',
    '\\- x\n\n\\= y\n\n\\+ z\n\n2\\. w\n\n\\- v\n\n#list(tight: true)[\\= h][#emph[\\- e];]',
  ],
  ['CRLF and NUL', 'a\r\nb\0c', 'a b�c'],
  ['empty input', '', ''],
];

describe('convert: Typst source', () => {
  test.each(cases)('%s', (_, markdown, typst) => {
    expect(convert(markdown).typst).toBe(`${typst}\n`);
  });
});

const FRAME = '#align(center, block(stroke: (paint: luma(185), thickness: 0.5pt, dash: "dashed"), inset: 10pt, text(fill: luma(115))';
const available = new Set(['cat.png', 'figures/plot.svg', 'my cat.png'] as ImagePath[]);

const imageCases: [string, string, string][] = [
  ['an image alone in its paragraph is a centred block', '![A *grey* cat](cat.png)', '#align(center, block(breakable: false, linked-image(image("/images/cat.png", alt: "A grey cat"))))'],
  [
    'images alone in one paragraph each get a line, whatever the whitespace between them',
    '![a](cat.png) ![b](./figures/plot.svg)\n![](<my cat.png> "title")',
    '#align(center, block(breakable: false, linked-image(image("/images/cat.png", alt: "a"))))\n#align(center, block(breakable: false, linked-image(image("/images/figures/plot.svg", alt: "b"))))\n#align(center, block(breakable: false, linked-image(image("/images/my cat.png", alt: ""))))',
  ],
  ['an image inside text is boxed inline', 'Look: ![cat](cat.png) here.', 'Look: #box(linked-image(image("/images/cat.png", alt: "cat"))); here.'],
  ['an image inside a link is boxed inline', '[![cat](cat.png)](https://x.org)', '#link("https://x.org")[#box(linked-image(image("/images/cat.png", alt: "cat")));];'],
  ['a reference image resolves through its definition', '![cat][c]\n\n[c]: <cat.png>', '#align(center, block(breakable: false, linked-image(image("/images/cat.png", alt: "cat"))))'],
  [
    'alt text is plain: markup, URLs, escapes and entities resolved, quotes escaped',
    '![a `b` [c](http://u) \\* &amp; "q"\nline](cat.png)',
    '#align(center, block(breakable: false, linked-image(image("/images/cat.png", alt: "a b c * & \\"q\\" line"))))',
  ],
  ['a missing block image is a quiet frame holding its alt text', '![Missing *one*](gone.png)', `${FRAME}[Missing #emph[one];]))`],
  ['a remote block image is a frame too, with its URL when it has no alt text', '![](https://x.org/a.png)', `${FRAME}[https:\\/\\/x.org\\/a.png]))`],
  ['a missing inline image keeps its alt text', 'See ![the plot](gone.png).', 'See the plot.'],
  ['an unresolved reference image stays text', '![nope]', 'nope'],
  ['an image in a heading is inline', '# Logo ![l](cat.png)', '#heading(level: 1)[Logo #box(linked-image(image("/images/cat.png", alt: "l")));]'],
];

describe('convert: images', () => {
  test.each(imageCases)('%s', (_, markdown, typst) => {
    expect(convert(markdown, available).typst).toBe(`${typst}\n`);
  });

  test('every local image is listed once, in order, available or not; remote ones are not', () => {
    const markdown = '![](b.png) ![](https://x/y.png)\n\ntext ![](a.png) ![](./b.png) ![][r] ![](../out.png)\n\n[r]: figures/plot.svg';
    expect(convert(markdown, available).images).toEqual(['b.png', 'a.png', 'figures/plot.svg']);
  });

  test('lists the Markdown of each shown image in order, and no missing one', () => {
    expect(convert('![a](cat.png) and ![](gone.png)\n\n![](figures/plot.svg)', available).shownImages).toEqual([{ from: 0, to: 13 }, { from: 33, to: 54 }]);
  });

  test('a shown image adds no text pieces; a frame shows its alt text or URL where they are typed', () => {
    expect(convert('a ![cat](cat.png) b', available).pieces).toEqual([{ from: 0, text: 'a ' }, { from: 17, text: ' b' }]);
    expect(convert('![cat](cat.png)', available).pieces).toEqual([]);
    expect(convert('![lost](x.png)', available).pieces).toEqual([{ from: 2, text: 'lost' }]);
    expect(convert('![](http://u/x.png)', available).pieces).toEqual([{ from: 4, text: 'http://u/x.png' }]);
    expect(convert('![][r]\n\n[r]: <gone.png>', available).pieces).toEqual([{ from: 14, text: 'gone.png' }]);
  });
});

describe('convert: rejected formulas', () => {
  const rejected = new Set(['mi("\\\\frac{1")', 'mitex("\\\\foo")'] as MathCall[]);

  test('show as typed, with their marks, and are listed in order; other formulas still typeset', () => {
    const markdown = 'a $\\frac{1$ b $x$ c $$\\foo$$\n\n$$\n\\foo\n$$\n\nd $\\frac{1$';
    const { typst, typedMath } = convert(markdown, new Set(), rejected);
    expect(typst).toBe(
      [
        'a #typed-math(raw("$\\\\frac{1$")); b #mi("x"); c #typed-math(raw("$$\\\\foo$$"));',
        '#typed-math(raw("$$\\n\\\\foo\\n$$", block: true))',
        'd #typed-math(raw("$\\\\frac{1$"));\n',
      ].join('\n\n'),
    );
    expect(typedMath).toEqual(['mi("\\\\frac{1")', 'mitex("\\\\foo")', 'mitex("\\\\foo")', 'mi("\\\\frac{1")']);
  });

  test('link through their LaTeX', () => {
    expect(convert('a $\\frac{1$ b', new Set(), rejected).pieces).toEqual([{ from: 0, text: 'a ' }, { from: 3, text: '\\frac{1' }, { from: 11, text: ' b' }]);
  });

  test('a call counts only for its own kind of formula', () => {
    expect(convert('$\\foo$', new Set(), rejected)).toMatchObject({ typst: '#mi("\\\\foo");\n', typedMath: [] });
  });
});

const pieceCases: [string, string, TextPiece[]][] = [
  ['escapes show the escaped character at its own offset', 'a \\*b\\* c', [
    { from: 0, text: 'a ' }, { from: 3, text: '*' }, { from: 4, text: 'b' }, { from: 6, text: '*' }, { from: 7, text: ' c' },
  ]],
  ['an entity is one piece at its start', '&amp; &#65; &bogus;', [
    { from: 0, text: '&' }, { from: 5, text: ' ' }, { from: 6, text: 'A' }, { from: 11, text: ' ' }, { from: 12, text: '&bogus;' },
  ]],
  ['inline code, with the padding spaces left out', 'x `y z` w ``  a `` e', [
    { from: 0, text: 'x ' }, { from: 3, text: 'y z' }, { from: 7, text: ' w ' }, { from: 13, text: ' a' }, { from: 18, text: ' e' },
  ]],
  ['fenced and indented code', '```js\nlet a\n```\n\n    b', [{ from: 6, text: 'let a' }, { from: 21, text: 'b' }]],
  ['link text yes, URL no; autolinks show their URL', '[te*x*t](http://u) <http://v>', [
    { from: 1, text: 'te' }, { from: 4, text: 'x' }, { from: 6, text: 't' }, { from: 18, text: ' ' }, { from: 20, text: 'http://v' },
  ]],
  ['an unresolved reference shows as typed', '[Nope]', [{ from: 0, text: '[Nope]' }]],
  ['math and list markers show nothing', '- [x] a $x^2$ b\n1. c', [
    { from: 5, text: ' a ' }, { from: 13, text: ' b' }, { from: 19, text: 'c' },
  ]],
  ['heading markers and emphasis marks show nothing', '## T *e*', [{ from: 2, text: ' T ' }, { from: 6, text: 'e' }]],
];

describe('convert: text pieces', () => {
  test.each(pieceCases)('%s', (_, markdown, pieces) => {
    expect(convert(markdown).pieces).toEqual(pieces);
  });
});

test('the sample\'s pieces run forward through the Markdown and copy it', () => {
  const { pieces } = convert(sample);
  const out = pieces.filter((p, i) => sample.slice(p.from, p.from + p.text.length) !== p.text || (i > 0 && p.from < pieces[i - 1]!.from + pieces[i - 1]!.text.length));
  expect(pieces.length).toBeGreaterThan(200);
  expect(out).toEqual([]);
});
