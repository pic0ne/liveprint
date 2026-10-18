import type { TypstCompiler } from '@myriaddreamin/typst.ts/compiler';
import { beforeAll, describe, expect, test } from 'vitest';
import { nodeCompiler, repoFile, repoText } from '../bench/typst-node';
import { convert, type MathCall } from '../src/convert/toTypst';
import type { ImagePath } from '../src/images';
import { type ImageMark, imageBoxes } from '../src/linking/imageBoxes';
import { compileMarkdown } from '../src/typst/compileMarkdown';
import { MAIN_PATH, mainSource } from '../src/typst/compiler';
import { preludeFor } from '../src/typst/themes';

const prelude = preludeFor({ paper: 'a4', margins: 'normal', theme: 'book' });

let compiler: TypstCompiler;
beforeAll(async () => {
  compiler = await nodeCompiler();
});

async function errorsFor(markdown: string): Promise<string[]> {
  compiler.addSource(MAIN_PATH, mainSource(prelude, convert(markdown).typst));
  const { result, diagnostics = [] } = await compiler.compile({ mainFilePath: MAIN_PATH, diagnostics: 'unix' });
  const errors = diagnostics.filter((d) => /\berror\b/.test(d));
  return result ? errors : ['no artifact', ...errors];
}

const PUNCTUATION = '!"#$%&\'()*+,-./:;<=>?@[\\]^_`{|}~';

const adversarial: Record<string, string> = {
  'every ASCII punctuation char, alone and run together': `${PUNCTUATION}\n\n${[...PUNCTUATION].join(' ')}\n\n${[...PUNCTUATION].join('\n\n')}`,
  'every punctuation char opening a line inside each container': [...PUNCTUATION]
    .map((c) => `${c} a\n\n- ${c} b\n\n> ${c} c\n\n1. ${c} d\n\n# ${c} e\n\n| ${c} |\n|---|\n| ${c} |`)
    .join('\n\n'),
  'unbalanced emphasis and code': '*a **b _c __d ~~e `f\n\n**x* y_ z__ ~~ `` ` ```',
  'nested lists and quotes': '- a\n  > b\n  > - c\n  >   1. d\n  >      > e *f*\n- > g\n  ```\n  h\n  ```',
  'Typst comments and code-looking text': '// line\n\n/* block */ a // b /* c\n\n#let x = 1 #x #{ panic() } #(1/0) $ x $ @ref <label> = - + 1. / term: d',
  'URLs and autolinks': 'https://a.b/c?d=e&f#g <https://x.y> www.z.com/p_q mail@ex.org <javascript:alert(1)> [a](<b c>) [d]() [e](#)',
  HTML: '<div>\n*a*\n</div>\n\n<script>alert("x")</script> <img src=x onerror=y> <!-- c --> <?pi ?> <![CDATA[x]]> &#0; &#xFFFFFF; &amp',
  'code with Typst string specials': '```"\\n\n"\\"\\\\ \t\r```\n\n`` `"\\` ``\n\n    "\\',
  'odd ordered lists and tables': '0. a\n\n999999999. b\n\n|a|\n|-|\n\n| a | b |\n|---|---|\n| \\| | `|` |',
  'dollars that are not math': '$5 and $6, a lone $ sign, $ spaced $, $$ alone',
  'footnotes and contents': '[[toc]]\n\n# H[^x](h).k\n\nA[^x][^y](z).w [^] [^a"b]\n\n[^x]: *n* [^x] $x$\n[^y]:\n\n> [^z]: q\n\n[^a"b]: `c`\n\n- [[toc]]',
  'front matter': '---\ntitle: "#t" [x] $y$ \\\nauthor: ["*a*", b\\]\ndate: 2026-02-30\n---\n\nText',
  'headings and breaks at the edges': '#\n\n######\n\n=\n\n-\n\n***\n\na  \n\\',
  'the sample document': repoText('src/sample.md'),
};

describe('convert output compiles without errors', () => {
  test.each(Object.entries(adversarial))('%s', async (_, markdown) => {
    expect(await errorsFor(markdown)).toEqual([]);
  });

  test('200 seeded random strings over Markdown-significant characters', async () => {
    // `$` is left out: malformed LaTeX inside math is a mitex error at compile time, not a converter bug.
    const alphabet = [...'!"#%&\'()*+,-./:;<=>?@[\\]^_`{|}~ab1 \n\n\t', '  \n', '```', '> ', '- ', '1. ', '| ', '[x] ', '<a>', 'http://'];
    let seed = 1;
    const random = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
    const failures: string[] = [];
    for (let i = 0; i < 200; i++) {
      const input = Array.from({ length: 40 }, () => alphabet[Math.floor(random() * alphabet.length)]).join('');
      const errors = await errorsFor(input);
      if (errors.length > 0) failures.push(JSON.stringify(input), ...errors);
    }
    expect(failures).toEqual([]);
  });
});

describe('compileMarkdown shows rejected formulas as typed', () => {
  const rejected = new Map<MathCall, string>();
  const compileText = (markdown: string) =>
    compileMarkdown(markdown, () => prelude, new Set(), rejected, (source) => {
      compiler.addSource(MAIN_PATH, source);
      return compiler.compile({ mainFilePath: MAIN_PATH, diagnostics: 'full' });
    });

  test('every rejected formula in one compile, each with its reason, and the rest still typesets', async () => {
    const { result, converted } = await compileText('a $\\frac{1$ b $x^2$ c $\\foo$\n\n$$\n\\left( x\n$$');
    expect(result).toBeDefined();
    expect(converted.typedMath.map((call) => [call, rejected.get(call)])).toEqual([
      ['mi("\\\\frac{1")', 'missing argument: den'],
      ['mi("\\\\foo")', 'unknown command: \\foo'],
      ['mitex("\\\\left( x")', 'unclosed delimiter'],
    ]);
    expect(converted.typst).toContain('#mi("x^2")');
  });

  test('a formula valid again typesets, and its rejection is forgotten', async () => {
    const { result, converted } = await compileText('a $\\frac{1}{2}$ b $\\foo$');
    expect(result).toBeDefined();
    expect(converted.typst).toContain('#mi("\\\\frac{1}{2}")');
    expect([...rejected.keys()]).toEqual(['mi("\\\\foo")']);
  });

  test('200 seeded random strings of LaTeX between dollars all compile', async () => {
    const alphabet = ['$', '$$', '\\', '\\frac', '\\foo', '\\left(', '\\right)', '\\begin{matrix}', '\\end{x}', '{', '}', '^', '_', '&', 'a', '1', ' ', '\n', '\n\n', '- ', '| '];
    let seed = 7;
    const random = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
    const failures: string[] = [];
    let typed = 0;
    for (let i = 0; i < 200; i++) {
      const input = Array.from({ length: 30 }, () => alphabet[Math.floor(random() * alphabet.length)]).join('');
      const { result, diagnostics = [] } = await compileText(input);
      if (!result) failures.push(JSON.stringify(input), ...diagnostics.map((d) => d.message));
      if (rejected.size > 0) typed++;
    }
    expect(failures).toEqual([]);
    expect(typed).toBeGreaterThan(50);
  });

  test('a failure that is not a formula is still reported', async () => {
    const { result, diagnostics = [] } = await compileMarkdown('x', () => `${prelude}\n#panic("boom")`, new Set(), rejected, (source) => {
      compiler.addSource(MAIN_PATH, source);
      return compiler.compile({ mainFilePath: MAIN_PATH, diagnostics: 'full' });
    });
    expect(result).toBeUndefined();
    expect(diagnostics.map((d) => d.message)).toEqual(['panicked with: "boom"']);
  });
});

describe('image marks', () => {
  test('give each shown image its box, and none to a missing one', async () => {
    compiler.mapShadow('/images/small.png', repoFile('public/icon-192.png'));
    compiler.mapShadow('/images/wide.png', repoFile('public/icon-512.png'));
    const available = new Set(['small.png', 'wide.png'] as ImagePath[]);
    const markdown = 'Text ![](small.png) inline.\n\n![a](small.png)\n\n![](gone.png)\n\n![](wide.png)\n\nAfter.';
    const { typst, shownImages } = convert(markdown, available);
    compiler.addSource(MAIN_PATH, mainSource(prelude, typst));
    const marks = await compiler.runWithWorld({ mainFilePath: MAIN_PATH }, async (world) => {
      await world.compile();
      return world.query<ImageMark[]>({ selector: '<liveprint-image>', field: 'value' });
    });
    const boxes = imageBoxes(marks, shownImages);
    expect(imageBoxes(marks.slice(1), shownImages)).toEqual([]);
    const round = (n: number) => Math.round(n * 10) / 10;
    expect(boxes.map(({ x, y, w, h, ...rest }) => ({ ...rest, x: round(x), y: round(y), w: round(w), h: round(h) }))).toEqual([
      { from: 5, to: 19, path: 'small.png', page: 0, x: 94.2, y: 70.9, w: 192, h: 192 },
      { from: 29, to: 44, path: 'small.png', page: 0, x: 201.6, y: 270, w: 192, h: 192 },
      { from: 61, to: 74, path: 'wide.png', page: 1, x: 70.9, y: 70.9, w: 453.5, h: 453.5 },
    ]);
  });

  test('pair up with a table of contents, which prints a heading with an image again', async () => {
    compiler.mapShadow('/images/small.png', repoFile('public/icon-192.png'));
    const { typst, shownImages } = convert('[[toc]]\n\n# Logo ![l](small.png)\n\nText ![](small.png)', new Set(['small.png'] as ImagePath[]));
    compiler.addSource(MAIN_PATH, mainSource(prelude, typst));
    const marks = await compiler.runWithWorld({ mainFilePath: MAIN_PATH }, async (world) => {
      await world.compile();
      return world.query<ImageMark[]>({ selector: '<liveprint-image>', field: 'value' });
    });
    expect(shownImages.map(({ from }) => from)).toEqual([38]);
    expect(imageBoxes(marks, shownImages).map(({ from, path }) => ({ from, path }))).toEqual([{ from: 38, path: 'small.png' }]);
  });
});
