import { expect, test } from 'vitest';
import { SourceIndex } from '../linking/sourceIndex';
import { type Linked, sourceAt, spotOf } from './linker';

const runs = [{ text: 'Before', x: 0, y: 10, w: 60, h: 10 }];
const pages = [{ width: 200, height: 400, runs }];
const linked: Linked = {
  index: SourceIndex.build(pages, [{ from: 0, text: 'Before' }]),
  pages,
  images: [{ from: 8, to: 22, page: 0, x: 50, y: 100, w: 100, h: 80 }],
};

test('a click on an image puts the offset after its `![`, and anywhere else is text', () => {
  expect(sourceAt(linked, 0, 0.5, 0.35)).toBe(10);
  expect(sourceAt(linked, 0, 0.26, 0.25)).toBe(10);
  expect(sourceAt(linked, 0, 0.1, 0.03)).toBe(2);
  expect(sourceAt(linked, 0, 0.9, 0.35)).toBe(6);
});

test("an offset inside an image's Markdown marks the image; its edges are outside", () => {
  expect(spotOf(linked, 9)).toEqual({ kind: 'image', page: 0, x: 0.25, y: 0.25, w: 0.5, h: 0.2 });
  expect(spotOf(linked, 21)).toEqual({ kind: 'image', page: 0, x: 0.25, y: 0.25, w: 0.5, h: 0.2 });
  expect(spotOf(linked, 8)).toMatchObject({ kind: 'text' });
  expect(spotOf(linked, 22)).toMatchObject({ kind: 'text' });
});
