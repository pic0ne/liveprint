import { expect, test } from 'vitest';
import { freeName, type ImagePath, imagePath, withExtension } from './images';

test.each([
  ['cat.png', 'cat.png'],
  ['./cat.png', 'cat.png'],
  ['figures/plot.svg', 'figures/plot.svg'],
  ['./figures/./plot.svg', 'figures/plot.svg'],
  ['<my cat.png>', 'my cat.png'],
  ['my%20cat.png', 'my cat.png'],
  ['k%C3%B6ln.jpg', 'köln.jpg'],
  ['100%.png', '100%.png'],
  ['cat.png?v=2', 'cat.png'],
  ['cat.png#frag', 'cat.png'],
  ['ěščř/žluťoučký kůň.webp', 'ěščř/žluťoučký kůň.webp'],
])('%j names the local image %j', (url, path) => {
  expect(imagePath(url)).toBe(path);
});

test.each([
  'https://example.com/cat.png',
  'http://x/y.png',
  'data:image/png;base64,AAAA',
  'file:///home/me/cat.png',
  'C:/photos/cat.png',
  '//cdn.example/cat.png',
  '/abs/cat.png',
  '../cat.png',
  'figures/../../cat.png',
  'figures/..',
  '%2E%2E/cat.png',
  'a//b.png',
  'figures/',
  '',
  '   ',
  '.',
  '?x',
  '.liveprint/logo.png',
  './.liveprint/logo.svg',
])('%j is not a local image', (url) => {
  expect(imagePath(url)).toBeNull();
});

test.each([
  ['image.png', [], 'image.png'],
  ['image.png', ['image.png'], 'image-2.png'],
  ['image.png', ['image.png', 'image-2.png'], 'image-3.png'],
  ['Screen Shot 2026-10-17 at 10.15.03.png', [], 'Screen-Shot-2026-10-17-at-10.15.03.png'],
  ['my  photo (1).JPG', [], 'my-photo-1.JPG'],
  ['žluťoučký kůň.webp', [], 'žluťoučký-kůň.webp'],
  ['a/b\\c?.png', [], 'a-b-c.png'],
  ['', [], 'image'],
  ['.png', [], 'image.png'],
  ['#?.png', [], 'image.png'],
  ['plot', ['plot'], 'plot-2'],
])('%j with %j taken is %j', (name, taken, path) => {
  expect(freeName(name, (p) => taken.includes(p))).toBe(path as ImagePath);
});

test.each([
  ['image.png', 'image/png', 'image.png'],
  ['photo.JPG', 'image/jpeg', 'photo.JPG'],
  ['photo.jpeg', 'image/jpeg', 'photo.jpeg'],
  ['image', 'image/png', 'image.png'],
  ['plot.data', 'image/svg+xml', 'plot.data.svg'],
  ['shot.png', 'image/webp', 'shot.png.webp'],
  ['notes.bmp', 'image/bmp', 'notes.bmp'],
])('%j of type %s is named %j', (name, type, named) => {
  expect(withExtension(name, type)).toBe(named);
});
