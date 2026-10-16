import type { TypstCompiler } from '@myriaddreamin/typst.ts/compiler';
import { beforeAll, describe, expect, test } from 'vitest';
import { nodeCompiler, prelude, repoText } from '../bench/typst-node';
import { convert } from '../src/convert/toTypst';
import { MAIN_PATH, mainSource } from '../src/typst/compiler';

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
