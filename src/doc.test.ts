import { expect, test } from 'vitest';
import { documentTitle, isEdited, isMarkdown, pdfName, untitled } from './doc';

test('a new document is Untitled.md, never saved, and clean', () => {
  const doc = untitled('# Hello');
  expect(doc).toEqual({ text: '# Hello', file: { name: 'Untitled.md', handle: null, saved: '# Hello' } });
  expect(isEdited(doc.text, doc.file)).toBe(false);
});

test('a document is edited while its text differs from the saved text, and clean again once undone back', () => {
  const { file } = untitled('# Hello');
  expect(isEdited('# Hello!', file)).toBe(true);
  expect(isEdited('', file)).toBe(true);
  expect(isEdited('# Hello', file)).toBe(false);
});

test.each([
  ['notes.md', false, 'notes.md · liveprint'],
  ['notes.md', true, '• notes.md · liveprint'],
  ['Untitled.md', false, 'Untitled.md · liveprint'],
])('the title of %s, edited %s, is %j', (name, edited, title) => {
  expect(documentTitle(name, edited)).toBe(title);
});

test.each([
  ['notes.md', 'notes.pdf'],
  ['Untitled.md', 'Untitled.pdf'],
  ['README.MARKDOWN', 'README.pdf'],
  ['todo.txt', 'todo.pdf'],
  ['v1.2 draft.md', 'v1.2 draft.pdf'],
  ['notes', 'notes.pdf'],
  ['.md', 'Untitled.pdf'],
])('the PDF of %s downloads as %s', (name, pdf) => {
  expect(pdfName(name)).toBe(pdf);
});

test.each([
  ['notes.md', '', true],
  ['notes.md', 'text/markdown', true],
  ['NOTES.MD', '', true],
  ['book.markdown', '', true],
  ['todo.txt', 'text/plain', true],
  ['README', 'text/plain', true],
  ['notes', 'text/x-markdown', true],
  ['photo.png', 'image/png', false],
  ['page.html', 'text/html', false],
  ['data.csv', 'text/csv', false],
  ['notes.md.zip', 'application/zip', false],
  ['notes', '', false],
])('a dropped %s of type %j opens: %s', (name, type, opens) => {
  expect(isMarkdown({ name, type })).toBe(opens);
});
