import { describe, expect, test } from 'vitest';
import { toTypst } from './toTypst';

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
  ['unclosed block math shows as code', '$$\nunclosed', '#raw("$$\\nunclosed", block: true)'],
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

describe('toTypst', () => {
  test.each(cases)('%s', (_, markdown, typst) => {
    expect(toTypst(markdown)).toBe(`${typst}\n`);
  });
});
