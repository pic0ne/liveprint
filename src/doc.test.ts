import { expect, test } from 'vitest';
import { type DocFile, documentTitle, type ImageNotice, imageNotice, isEdited, isMarkdown, noticeText, pdfName, untitled } from './doc';
import type { ImagePath } from './images';

test('a new document is Untitled.md, never saved, and clean', () => {
  const doc = untitled('# Hello');
  expect(doc).toEqual({
    text: '# Hello',
    file: { name: 'Untitled.md', handle: null, saved: '# Hello', folder: null, savedImages: new Set() },
    images: new Map(),
  });
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

const path = (p: string) => p as ImagePath;
const blob = new Blob(['x']);
const withHandle = (folder: boolean, saved: string[] = []): DocFile => ({
  name: 'notes.md',
  handle: {} as FileSystemFileHandle,
  saved: '',
  folder: folder ? ({} as FileSystemDirectoryHandle) : null,
  savedImages: new Set(saved.map(path)),
});

test.each<[string, string[], string[], DocFile, ImageNotice]>([
  ['nothing referenced', [], ['a.png'], untitled('').file, { missing: 0, unsaved: 0 }],
  ['an untitled document never counts unsaved images', ['a.png', 'b.png'], ['a.png'], untitled('').file, { missing: 1, unsaved: 0 }],
  ['a saved file whose folder is unknown counts images not beside it', ['a.png', 'b.png', 'c.png'], ['a.png', 'b.png'], withHandle(false, ['a.png']), { missing: 1, unsaved: 1 }],
  ['a saved file with its folder counts none: Save writes them', ['a.png'], ['a.png'], withHandle(true), { missing: 0, unsaved: 0 }],
  ['a missing image is not also unsaved', ['gone.png'], [], withHandle(false), { missing: 1, unsaved: 0 }],
])('%s', (_, referenced, have, file, notice) => {
  expect(imageNotice(referenced.map(path), new Map(have.map((p) => [path(p), blob])), file)).toEqual(notice);
});

test.each<[ImageNotice, string]>([
  [{ missing: 0, unsaved: 0 }, ''],
  [{ missing: 1, unsaved: 0 }, '1 image not found'],
  [{ missing: 2, unsaved: 0 }, '2 images not found'],
  [{ missing: 0, unsaved: 1 }, '1 image not saved beside notes.md'],
  [{ missing: 0, unsaved: 3 }, '3 images not saved beside notes.md'],
  [{ missing: 2, unsaved: 1 }, '2 images not found, 1 not saved beside notes.md'],
])('the notice for %j reads %j', (notice, text) => {
  expect(noticeText(notice, 'notes.md')).toBe(text);
});
