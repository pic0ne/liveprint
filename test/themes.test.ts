import { CompileFormatEnum, type TypstCompiler } from '@myriaddreamin/typst.ts/compiler';
import { beforeAll, expect, test } from 'vitest';
import { nodeCompiler, repoText } from '../bench/typst-node';
import { convert } from '../src/convert/toTypst';
import { MARGINS, type Margins, type Paper, PAPERS, THEME_IDS, type ThemeId } from '../src/settings';
import { MAIN_PATH, mainSource } from '../src/typst/compiler';
import { preludeFor } from '../src/typst/themes';

let compiler: TypstCompiler;
beforeAll(async () => {
  compiler = await nodeCompiler();
});

const body = convert(repoText('src/sample.md')).typst;

/** Every page's size in pt, from the PDF's media boxes, and any error diagnostics. */
async function print(paper: Paper, margins: Margins, theme: ThemeId) {
  compiler.addSource(MAIN_PATH, mainSource(preludeFor({ paper, margins, theme }), body));
  const { result, diagnostics = [] } = await compiler.compile({ mainFilePath: MAIN_PATH, format: CompileFormatEnum.pdf, diagnostics: 'unix' });
  const pdf = new TextDecoder('latin1').decode(result);
  const sizes = [...pdf.matchAll(/\/MediaBox \[0 0 ([\d.]+) ([\d.]+)\]/g)].map((m) => `${Number(m[1]).toFixed(2)} x ${Number(m[2]).toFixed(2)}`);
  return { errors: diagnostics.filter((d) => /\berror\b/.test(d)), sizes };
}

const PAGE_PT: Record<Paper, string> = { a4: '595.28 x 841.89', 'us-letter': '612.00 x 792.00' };

const matrix = THEME_IDS.flatMap((theme) => PAPERS.flatMap((paper) => MARGINS.map((margins) => [theme, paper, margins] as const)));

test.each(matrix)('the sample prints without errors in %s on %s with %s margins', async (theme, paper, margins) => {
  const { errors, sizes } = await print(paper, margins, theme);
  expect(errors).toEqual([]);
  expect(sizes.length).toBeGreaterThan(4);
  expect(new Set(sizes)).toEqual(new Set([PAGE_PT[paper]]));
});

test.each(THEME_IDS)('wider margins take more pages in %s', async (theme) => {
  const pages: number[] = [];
  for (const margins of MARGINS) pages.push((await print('a4', margins, theme)).sizes.length);
  const [narrow, normal, wide] = pages as [number, number, number];
  expect(narrow).toBeLessThanOrEqual(normal);
  expect(normal).toBeLessThanOrEqual(wide);
  expect(narrow).toBeLessThan(wide);
});
