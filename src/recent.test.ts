import { expect, test } from 'vitest';
import { editedWhen, type KeptDoc, listRecent, previewLine } from './recent';
import type { DocId } from './restore';

test.each([
  ['# Notes\n\nFirst draft.', 'Notes'],
  ['\n\n   \n## Plan for May ##\nmore', 'Plan for May'],
  ['###### Six', 'Six'],
  ['#hashtag is not a heading', '#hashtag is not a heading'],
  ['  Indented line  \nsecond', 'Indented line'],
  ['#\nBody', ''],
  ['', ''],
  [`${'a'.repeat(250)}`, 'a'.repeat(200)],
  ['---\ntitle: "Field notes"\nauthor: Ada\n---\n\n# Body', 'Field notes'],
  ['---\nauthor: Ada\n---\n\n# Body', 'Body'],
  ['---\ntitle: >-\n  Long\n---\nFirst line', 'First line'],
])('the preview of %j is %j', (text, preview) => {
  expect(previewLine(text)).toBe(preview);
});

const at = (y: number, m: number, d: number, h = 0, min = 0) => new Date(y, m - 1, d, h, min).getTime();
const now = at(2026, 10, 18, 15, 30);

test.each([
  [now - 20_000, 'now'],
  [now + 5_000, 'now'],
  [now - 60_000, '1 minute ago'],
  [now - 5 * 60_000 - 59_000, '5 minutes ago'],
  [at(2026, 10, 18, 14, 0), '1 hour ago'],
  [at(2026, 10, 18, 0, 5), '15 hours ago'],
  [at(2026, 10, 17, 23, 59), 'yesterday'],
  [at(2026, 10, 17, 0, 0), 'yesterday'],
  [at(2026, 10, 16, 23, 59), 'Oct 16'],
  [at(2026, 1, 2, 9, 0), 'Jan 2'],
  [at(2025, 12, 31, 9, 0), 'Dec 31, 2025'],
])('a record kept at %d reads %j', (keptAt, text) => {
  expect(editedWhen(keptAt, now, 'en')).toBe(text);
});

test('just after midnight, a record from late last evening is minutes ago, not yesterday', () => {
  expect(editedWhen(at(2026, 10, 17, 23, 50), at(2026, 10, 18, 0, 10), 'en')).toBe('20 minutes ago');
});

test('the time follows the locale', () => {
  expect(editedWhen(now - 5 * 60_000, now, 'de')).toBe('vor 5 Minuten');
  expect(editedWhen(at(2026, 10, 17, 9, 0), now, 'de')).toBe('gestern');
});

const handle = { kind: 'file', name: 'notes.md' } as FileSystemFileHandle;
const kept = (id: string, text: string, keptAt: number, extra: Partial<KeptDoc> = {}): KeptDoc => ({
  id: id as DocId,
  text,
  file: { name: 'Untitled.md', handle: null },
  keptAt,
  elsewhere: false,
  ...extra,
});

test('the list is the other documents, newest first, without this tab’s own or an empty one never saved', () => {
  const list = listRecent(
    [
      kept('old', '# Old\nText', 100),
      kept('mine', '# Mine', 900),
      kept('empty', '', 800),
      kept('saved-empty', '', 700, { file: { name: 'blank.md', handle } }),
      kept('held', 'Elsewhere', 500, { file: { name: 'notes.md', handle }, elsewhere: true }),
    ],
    'mine' as DocId,
  );
  expect(list).toEqual([
    { id: 'saved-empty', name: 'blank.md', keptAt: 700, preview: '', elsewhere: false },
    { id: 'held', name: 'notes.md', keptAt: 500, preview: 'Elsewhere', elsewhere: true },
    { id: 'old', name: 'Untitled.md', keptAt: 100, preview: 'Old', elsewhere: false },
  ]);
});
