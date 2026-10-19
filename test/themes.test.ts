import { CompileFormatEnum, type TypstCompiler } from '@myriaddreamin/typst.ts/compiler';
import { beforeAll, expect, test } from 'vitest';
import { nodeCompiler, repoText } from '../bench/typst-node';
import { convert } from '../src/convert/toTypst';
import type { ImagePath } from '../src/images';
import { BUILT_IN_THEMES, MARGINS, type Margins, type Paper, PAPERS, type ThemeId } from '../src/settings';
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

const matrix = BUILT_IN_THEMES.flatMap((theme) => PAPERS.flatMap((paper) => MARGINS.map((margins) => [theme, paper, margins] as const)));

test.each(matrix)('the sample prints without errors in %s on %s with %s margins', async (theme, paper, margins) => {
  const { errors, sizes } = await print(paper, margins, theme);
  expect(errors).toEqual([]);
  expect(sizes.length).toBeGreaterThan(4);
  expect(new Set(sizes)).toEqual(new Set([PAGE_PT[paper]]));
});

test.each(BUILT_IN_THEMES)('wider margins take more pages in %s', async (theme) => {
  const pages: number[] = [];
  for (const margins of MARGINS) pages.push((await print('a4', margins, theme)).sizes.length);
  const [narrow, normal, wide] = pages as [number, number, number];
  expect(narrow).toBeLessThanOrEqual(normal);
  expect(normal).toBeLessThanOrEqual(wide);
  expect(narrow).toBeLessThan(wide);
});

const FRONT = '---\ntitle: A field guide\nauthor: [Ada Byron, Doe]\ndate: 2026-10-18\n---\n\n# The measure\n\nText.\n';

/** The PDF of `markdown` in `theme`, as Latin-1 text, and any error diagnostics. */
async function pdfOf(markdown: string, theme: ThemeId) {
  const { typst, frontMatter } = convert(markdown);
  compiler.addSource(MAIN_PATH, mainSource(preludeFor({ paper: 'a4', margins: 'normal', theme }, frontMatter), typst));
  const { result, diagnostics = [] } = await compiler.compile({ mainFilePath: MAIN_PATH, format: CompileFormatEnum.pdf, diagnostics: 'unix' });
  return { pdf: new TextDecoder('latin1').decode(result), errors: diagnostics.filter((d) => /\berror\b/.test(d)) };
}

test.each(BUILT_IN_THEMES)('front matter prints a title block in %s and fills the PDF title, authors and date', async (theme) => {
  const { pdf, errors } = await pdfOf(FRONT, theme);
  expect(errors).toEqual([]);
  expect(pdf).toContain('/Title (A field guide)');
  expect(pdf).toContain('/Author (Ada Byron, Doe)');
  expect(pdf).toContain('/CreationDate (D:20261018000000Z)');
});

test('a date that names no calendar day prints, and leaves the PDF without a date', async () => {
  const { pdf, errors } = await pdfOf('---\ntitle: T\ndate: Spring 2026\n---\n', 'book');
  expect(errors).toEqual([]);
  expect(pdf).toContain('/Title (T)');
  expect(pdf).not.toContain('/CreationDate');
});

/** The example prelude in the docs' Custom theme section. */
const example = /## Custom theme\n[\s\S]*?```typst\n([\s\S]*?)```/.exec(repoText('docs/how-it-works.md'))![1]!;

test('the docs’ example prelude prints a document with front matter and a logo, as a Custom theme', async () => {
  const { typst, frontMatter } = convert(FRONT);
  const logo = '.liveprint/logo.png' as ImagePath;
  compiler.mapShadow(`/images/${logo}`, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64'));
  compiler.addSource(MAIN_PATH, mainSource(preludeFor({ paper: 'a4', margins: 'normal', theme: 'custom' }, frontMatter, { source: example, logo }), typst));
  const { result, diagnostics = [] } = await compiler.compile({ mainFilePath: MAIN_PATH, format: CompileFormatEnum.pdf, diagnostics: 'unix' });
  compiler.unmapShadow(`/images/${logo}`);
  expect(diagnostics.filter((d) => /\berror\b/.test(d))).toEqual([]);
  const pdf = new TextDecoder('latin1').decode(result);
  expect(pdf).toContain('/Title (A field guide)');
  expect(pdf).toContain('IBMPlexSans');
  expect(pdf).toContain('/Subtype /Image');
});
