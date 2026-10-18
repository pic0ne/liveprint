import { expect, test } from 'vitest';
import { FONT_FILES } from './files';
import { preludeFor, THEMES } from './themes';

test('preludeFor sets the page after the shared preamble and before the theme', () => {
  const lines = preludeFor({ paper: 'us-letter', margins: 'wide', theme: 'modern' }).split('\n');
  const page = lines.indexOf('#set page(paper: "us-letter", margin: 35mm)');
  expect(lines[0]).toBe('#import "@preview/mitex:0.2.6": mitex, mi');
  expect(page).toBeGreaterThan(0);
  expect(lines[page + 1]).toBe('// Modern: IBM Plex Sans, ragged right, open spacing, tinted code and table header.');
});

test('preludeFor writes each margin in millimetres', () => {
  const pageLine = (margins: 'narrow' | 'normal') => preludeFor({ paper: 'a4', margins, theme: 'book' }).split('\n').find((l) => l.startsWith('#set page(paper'));
  expect(pageLine('narrow')).toBe('#set page(paper: "a4", margin: 18mm)');
  expect(pageLine('normal')).toBe('#set page(paper: "a4", margin: 25mm)');
});

test.each(Object.values(THEMES))('every face $label measures text in is loaded at boot or with the theme', ({ text, fonts }) => {
  const loaded = new Set<string>([...FONT_FILES, ...fonts]);
  expect(text.filter((path) => !loaded.has(path))).toEqual([]);
});

test('preludeFor gives the theme the liveprint variables, and the PDF the front matter', () => {
  const front = { title: 'A "guide"', authors: ['Ada', 'Doe'], date: { year: 2026, month: 10, day: 18 } };
  const lines = preludeFor({ paper: 'a4', margins: 'narrow', theme: 'book' }, front).split('\n');
  expect(lines).toContain('#let liveprint = (paper: "a4", margin: 18mm, title: "A \\"guide\\"", authors: ("Ada", "Doe",), date: datetime(year: 2026, month: 10, day: 18))');
  expect(lines).toContain('#set document(title: liveprint.title, author: liveprint.authors, date: liveprint.date)');
  expect(preludeFor({ paper: 'a4', margins: 'narrow', theme: 'book' }).split('\n')).toContain('#let liveprint = (paper: "a4", margin: 18mm, title: none, authors: (), date: none)');
});
