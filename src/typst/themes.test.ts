import { expect, test } from 'vitest';
import type { ImagePath } from '../images';
import { FONT_FILES } from './files';
import { CUSTOM_THEME, preludeError, preludeFor, THEMES } from './themes';

test('preludeFor sets the variables, then the shared preamble, the page and the theme', () => {
  const lines = preludeFor({ paper: 'us-letter', margins: 'wide', theme: 'modern' }).split('\n');
  const page = lines.indexOf('#set page(paper: "us-letter", margin: 35mm)');
  expect(lines[0]).toMatch(/^#let liveprint = \(/);
  expect(lines[1]).toBe('#import "@preview/mitex:0.2.6": mitex, mi');
  expect(page).toBeGreaterThan(0);
  expect(lines[page + 1]).toBe('// Modern: IBM Plex Sans, ragged right, open spacing, tinted code and table header.');
});

test('preludeFor writes each margin in millimetres', () => {
  const pageLine = (margins: 'narrow' | 'normal') => preludeFor({ paper: 'a4', margins, theme: 'book' }).split('\n').find((l) => l.startsWith('#set page(paper'));
  expect(pageLine('narrow')).toBe('#set page(paper: "a4", margin: 18mm)');
  expect(pageLine('normal')).toBe('#set page(paper: "a4", margin: 25mm)');
});

test.each([...Object.values(THEMES), CUSTOM_THEME])('every face $label measures text in is loaded at boot or with the theme', ({ text, fonts }) => {
  const loaded = new Set<string>([...FONT_FILES, ...fonts]);
  expect(text.filter((path) => !loaded.has(path))).toEqual([]);
});

test('preludeFor gives the theme the liveprint variables, and the PDF the front matter', () => {
  const front = { title: 'A "guide"', authors: ['Ada', 'Doe'], date: { year: 2026, month: 10, day: 18 } };
  const lines = preludeFor({ paper: 'a4', margins: 'narrow', theme: 'book' }, front).split('\n');
  expect(lines).toContain('#let liveprint = (paper: "a4", margin: 18mm, title: "A \\"guide\\"", authors: ("Ada", "Doe",), date: datetime(year: 2026, month: 10, day: 18), logo: none)');
  expect(lines).toContain('#set document(title: liveprint.title, author: liveprint.authors, date: liveprint.date)');
  expect(preludeFor({ paper: 'a4', margins: 'narrow', theme: 'book' }).split('\n')).toContain('#let liveprint = (paper: "a4", margin: 18mm, title: none, authors: (), date: none, logo: none)');
});

const company = { source: '#set text(font: "IBM Plex Sans")\n#let rule = line(length: 100%)', logo: '.liveprint/logo.png' as ImagePath };

test('preludeFor ends the Custom theme with the user\'s prelude, and gives every theme the logo', () => {
  const custom = preludeFor({ paper: 'a4', margins: 'normal', theme: 'custom' }, null, company).split('\n');
  expect(custom[0]).toBe('#let liveprint = (paper: "a4", margin: 25mm, title: none, authors: (), date: none, logo: "/images/.liveprint/logo.png")');
  expect(custom.slice(-3)).toEqual(['#set page(paper: "a4", margin: 25mm)', '#set text(font: "IBM Plex Sans")', '#let rule = line(length: 100%)']);
  const book = preludeFor({ paper: 'a4', margins: 'normal', theme: 'book' }, null, company).split('\n');
  expect(book[0]).toBe(custom[0]);
  expect(book).toContain('// Book: Libertinus Serif, justified, indented paragraphs, old-style figures, quiet rules.');
  expect(book).not.toContain('#let rule = line(length: 100%)');
  expect(preludeFor({ paper: 'a4', margins: 'normal', theme: 'custom' }).endsWith('#set page(paper: "a4", margin: 25mm)\n')).toBe(true);
});

test('preludeError counts the line of an error in the user\'s file, and names none for an error outside it', () => {
  const settings = { paper: 'us-letter', margins: 'wide', theme: 'custom' } as const;
  const first = preludeFor(settings, null, company).split('\n').length - 2;
  const at = (line: number, pkg = '') => [{ package: pkg, path: '/check.typ', severity: 'error', range: `${line}:5-${line}:8`, message: 'unknown variable: foo' }];
  expect(preludeError(settings, company, at(first))).toBe('line 1: unknown variable: foo');
  expect(preludeError(settings, company, at(first + 1))).toBe('line 2: unknown variable: foo');
  expect(preludeError(settings, company, at(first - 1))).toBe('unknown variable: foo');
  expect(preludeError(settings, company, at(first + 1, '@preview/mitex:0.2.6'))).toBe('unknown variable: foo');
  expect(preludeError(settings, company, [{ ...at(first)[0]!, severity: 'warning' }])).toBeNull();
});
