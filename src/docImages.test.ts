import { expect, test } from 'vitest';
import { addImages, WorkerImages } from './docImages';
import type { ImagePath } from './images';
import type { ToWorker } from './protocol';

const png = (name: string, ...bytes: number[]) => new File([new Uint8Array(bytes)], name, { type: 'image/png' });

test('an image is added under its file name, the same name and bytes again reuse it, other bytes get the next name', async () => {
  const first = await addImages([png('image.png', 1, 2, 3)], new Map());
  expect(first.paths).toEqual(['image.png']);
  const again = await addImages([png('image.png', 1, 2, 3)], first.images);
  expect(again.paths).toEqual(['image.png']);
  expect([...again.images.keys()]).toEqual(['image.png']);
  const other = await addImages([png('image.png', 9, 9, 9), png('image.png', 1, 2, 3), png('image.png', 9, 9, 9)], again.images);
  expect(other.paths).toEqual(['image-2.png', 'image.png', 'image-2.png']);
  expect([...other.images.keys()]).toEqual(['image.png', 'image-2.png']);
});

test('types liveprint does not show are left out, and a missing extension is added', async () => {
  const bmp = new File([new Uint8Array([1])], 'scan.bmp', { type: 'image/bmp' });
  const svg = new File(['<svg/>'], 'plot', { type: 'image/svg+xml' });
  const { paths, images } = await addImages([bmp, svg], new Map());
  expect(paths).toEqual(['plot.svg']);
  expect([...images.keys()]).toEqual(['plot.svg']);
});

test('the worker is sent only the images that changed, removals as null, in call order', async () => {
  const sent: string[] = [];
  const worker = new WorkerImages((message: ToWorker) => {
    if (message.kind === 'image') sent.push(`${message.path} ${message.bytes ? [...message.bytes].join('') : null}`);
  });
  const a = png('a.png', 1);
  const b = png('b.png', 2);
  const path = (p: string) => p as ImagePath;
  void worker.show(new Map([[path('a.png'), a]]));
  await worker.show(new Map([[path('a.png'), a], [path('b.png'), b]]));
  await worker.show(new Map([[path('b.png'), png('b.png', 3)]]));
  expect(sent).toEqual(['a.png 1', 'b.png 2', 'a.png null', 'b.png 3']);
});
