import { describe, expect, test } from 'vitest';
import sample from '../sample.md?raw';
import type { ImagePath } from '../images';
import { calendarDate, convert, type MathCall, type TextPiece } from './toTypst';

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
    expect(convert('![a](cat.png) and ![](gone.png)\n\n![](figures/plot.svg)', available).shownImages).toEqual([
      { from: 0, to: 13, path: 'cat.png' },
      { from: 33, to: 54, path: 'figures/plot.svg' },
    ]);
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
  ['list markers show nothing, and a formula shows the letters and digits it prints', '- [x] a $x^2$ b\n1. c', [
    { from: 5, text: ' a ' }, { from: 9, text: 'x' }, { from: 11, text: '2' }, { from: 13, text: ' b' }, { from: 19, text: 'c' },
  ]],
  ['a formula: operator names, Greek letters as their symbol, no command names or environment names', '$\\sin \\alpha + \\frac{a}{b_1}$ $$\\begin{pmatrix} x \\end{pmatrix}$$', [
    { from: 2, text: 'sin' }, { from: 6, text: 'α', symbol: true }, { from: 21, text: 'a' }, { from: 24, text: 'b' }, { from: 26, text: '1' }, { from: 29, text: ' ' }, { from: 48, text: 'x' },
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
  const copies = (p: TextPiece) => p.symbol || sample.slice(p.from, p.from + p.text.length) === p.text;
  const out = pieces.filter((p, i) => !copies(p) || (i > 0 && p.from < pieces[i - 1]!.from + pieces[i - 1]!.text.length));
  expect(pieces.length).toBeGreaterThan(200);
  expect(out).toEqual([]);
});

describe('convert: front matter', () => {
  const FRONT = '---\ntitle: "A *field* guide"\nauthor: [Ada Byron, "Doe, J."]\ndate: 2026-10-18\nlayout: post\n---\n\n# Hi\n';

  test('is a title block from the title, authors and date, with other keys left out', () => {
    expect(convert(FRONT).typst).toBe(
      '#title-block(title: [A \\*field\\* guide], authors: ([Ada Byron], [Doe, J.],), date: datetime(year: 2026, month: 10, day: 18))\n\n#heading(level: 1)[Hi]\n',
    );
  });

  test('gives the title and authors as plain text, and the date as a calendar date', () => {
    expect(convert(FRONT).frontMatter).toEqual({ title: 'A *field* guide', authors: ['Ada Byron', 'Doe, J.'], date: { year: 2026, month: 10, day: 18 } });
  });

  test('the printed title and authors link to where they are written', () => {
    expect(convert(FRONT).pieces.slice(0, 3)).toEqual([
      { from: 12, text: 'A *field* guide' },
      { from: 38, text: 'Ada Byron' },
      { from: 50, text: 'Doe, J.' },
    ]);
  });

  test('a date that names no calendar day prints as written', () => {
    const { typst, frontMatter, pieces } = convert('---\ndate: Spring 2026\n---\n');
    expect(typst).toBe('#title-block(title: none, authors: (), date: [Spring 2026])\n');
    expect(frontMatter).toEqual({ title: null, authors: [], date: 'Spring 2026' });
    expect(pieces).toEqual([{ from: 10, text: 'Spring 2026' }]);
    expect(convert('---\ndate: 2026-02-30\n---\n').frontMatter?.date).toBe('2026-02-30');
  });

  test('a block scalar title over several lines, and Pandoc authors written as mappings', () => {
    const { frontMatter, typst } = convert('---\ntitle: >-\n  A long\n  title\nauthor:\n  - name: Ada Byron\n    affiliation: X\n  - name: Doe\n---\n');
    expect(frontMatter).toEqual({ title: 'A long title', authors: ['Ada Byron', 'Doe'], date: null });
    expect(typst).toBe('#title-block(title: [A long title], authors: ([Ada Byron], [Doe],), date: none)\n');
  });

  test('two rules with nothing between are rules, not empty front matter', () => {
    expect(convert('---\n---\n\nText').typst).toBe('#line(length: 100%)\n\n#line(length: 100%)\n\nText\n');
  });

  test('a block list of authors, an ellipsis to close, and a comment after a value', () => {
    expect(convert('---\ntitle: Notes # draft\nauthor:\n  - A\n  - B\n...\n').frontMatter).toEqual({ title: 'Notes', authors: ['A', 'B'], date: null });
  });

  test('without a title, author or date there is no title block', () => {
    expect(convert('---\nlayout: post\n---\n\nText').typst).toBe('Text\n');
    expect(convert('---\nlayout: post\n---\n\nText').frontMatter).toBeNull();
  });

  test.each([
    ['an unclosed block', '---\ntitle: x\n', '#line(length: 100%)\n\ntitle: x\n'],
    ['a blank line after the opening', '---\n\ntitle: x\n---\n', '#line(length: 100%)\n\n#heading(level: 2)[title: x]\n'],
    ['prose between the rules', '---\nSome prose\n---\n', '#line(length: 100%)\n\n#heading(level: 2)[Some prose]\n'],
    ['a block that does not open the document', 'Intro\n\n---\ntitle: x\n---\n', 'Intro\n\n#line(length: 100%)\n\n#heading(level: 2)[title: x]\n'],
  ])('%s is not front matter', (_, markdown, typst) => {
    expect(convert(markdown).typst).toBe(typst);
  });
});

test.each([
  ['2026-10-18', { year: 2026, month: 10, day: 18 }],
  ['2024-02-29', { year: 2024, month: 2, day: 29 }],
  ['2026-10-18T09:30:00Z', { year: 2026, month: 10, day: 18 }],
  ['2026-10-18 09:30', { year: 2026, month: 10, day: 18 }],
  ['2025-02-29', null],
  ['2026-13-01', null],
  ['18 October 2026', null],
])('calendarDate(%j)', (text, date) => {
  expect(calendarDate(text)).toEqual(date);
});

describe('convert: footnotes', () => {
  test('a reference prints its definition as a footnote, and a later one repeats its number', () => {
    expect(convert('A[^n] b[^N].\n\n[^n]: The *note*.').typst).toBe('A#footnote[The #emph[note];.]<liveprint-footnote-0> b#footnote(<liveprint-footnote-0>);.\n');
  });

  test('a definition holds paragraphs on indented lines, and ends at the next definition', () => {
    expect(convert('A[^1] B[^2]\n\n[^1]: One.\n\n    Two.\n[^2]: Three.').typst).toBe('A#footnote[One.\n\nTwo.]<liveprint-footnote-0> B#footnote[Three.]<liveprint-footnote-1>\n');
  });

  test('a reference ends its call, so a parenthesis or a dot after it stays text', () => {
    expect(convert('A[^1](x) b[^1](y).c\n\n# H[^2](z)\n\n[^1]: N.\n[^2]: M.').typst).toBe(
      'A#footnote[N.]<liveprint-footnote-0>(x) b#footnote(<liveprint-footnote-0>);(y).c\n\n#heading(level: 1)[H#footnote[M.];(z)]\n',
    );
  });

  test('a definition or a [[toc]] indented as code stays code', () => {
    expect(convert('A[^1]\n\n    [^1]: code\n    [[toc]]').typst).toBe('A\\[^1\\]\n\n#raw("[^1]: code\\n[[toc]]", block: true)\n');
  });

  test('a heading inside a footnote inside a heading keeps the footnote unlabelled', () => {
    expect(convert('# H[^1]\n\n[^1]: # Inner').typst).toBe('#heading(level: 1)[H#footnote[#heading(level: 1)[Inner]];]\n');
  });

  test('a reference with no definition, or inside a footnote, shows as typed; an unused definition prints nothing', () => {
    expect(convert('A[^x] B[^1]\n\n[^1]: See[^1].\n\n[^2]: Unused.').typst).toBe('A\\[^x\\] B#footnote[See\\[^1\\].]<liveprint-footnote-0>\n');
  });

  test('the footnote text links to its definition as an aside, where the reference is', () => {
    expect(convert('A[^1] b.\n\n[^1]: Note.').pieces).toEqual([
      { from: 0, text: 'A' },
      { from: 16, text: 'Note.', aside: true },
      { from: 5, text: ' b.' },
    ]);
  });
});

describe('convert: table of contents', () => {
  test('a [[toc]] line is an outline of the headings to level 3', () => {
    expect(convert('Intro\n[[TOC]]\n\n# A\n\n#### Deep').typst).toBe('Intro\n\n#outline(depth: 3)\n\n#heading(level: 1)[A]\n\n#heading(level: 4)[Deep]\n');
  });

  test('its entries link to the headings as asides, and the headings still link where they print', () => {
    expect(convert('[[toc]]\n\n# Alpha\n\n## *Beta*').pieces).toEqual([
      { from: 10, text: ' Alpha', aside: true },
      { from: 20, text: ' ', aside: true },
      { from: 22, text: 'Beta', aside: true },
      { from: 10, text: ' Alpha' },
      { from: 20, text: ' ' },
      { from: 22, text: 'Beta' },
    ]);
  });

  test('[[toc]] inside a paragraph is text', () => {
    expect(convert('See [[toc]] here').typst).toBe('See \\[\\[toc\\]\\] here\n');
  });
});
