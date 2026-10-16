import { describe, expect, test } from 'vitest';
import { fittedEdges } from './edges';
import type { Run } from './runs';
import { SourceIndex } from './sourceIndex';

// Pages are 100 pt square and runs 5 pt per character, so fractions read as pt / 100.
const run = (text: string, x: number, y: number): Run => ({ text, x, y, w: 5 * [...text].length, h: 10 });
const index = (runs: Run[], pieces: { from: number; text: string }[]) => SourceIndex.build([{ width: 100, height: 100, runs }], pieces);
const spot = (page: number, x: number, y: number, h: number, lineLeft: number, lineRight: number) => ({ page, x, y, h, lineLeft, lineRight });

describe('SourceIndex', () => {
  test('a plain line', () => {
    const plain = index([run('hello world', 10, 10)], [{ from: 0, text: 'hello world' }]);
    expect(plain.sourceAt(0, 0.41, 0.15)).toBe(6);
    expect(plain.sourceAt(0, 0.99, 0.95)).toBe(11);
    expect(plain.spotOf(6)).toEqual(spot(0, 0.4, 0.1, 0.1, 0.1, 0.65));
    expect(plain.spotOf(11)).toEqual(spot(0, 0.65, 0.1, 0.1, 0.1, 0.65));
  });

  test('a line split by an emphasised word, which sits a hair lower', () => {
    // a *bc* d
    const split = index([run('a ', 10, 10), run('bc', 20, 10.2), run(' d', 30, 10)], [{ from: 0, text: 'a ' }, { from: 3, text: 'bc' }, { from: 6, text: ' d' }]);
    expect(split.spotOf(3)).toEqual(spot(0, 0.2, 0.1, 0.102, 0.1, 0.4));
    expect(split.spotOf(2)!.x).toBe(0.2);
    expect(split.spotOf(4)!.x).toBe(0.25);
    expect(split.spotOf(7)!.x).toBe(0.35);
    expect(split.sourceAt(0, 0.21, 0.15)).toBe(3);
    expect(split.sourceAt(0, 0.36, 0.15)).toBe(7);
  });

  test('hyphenation across two lines', () => {
    const hyphenated = index([run('type-', 10, 10), run('setting is', 10, 24)], [{ from: 0, text: 'typesetting is' }]);
    expect(hyphenated.spotOf(4)).toEqual(spot(0, 0.1, 0.24, 0.1, 0.1, 0.6));
    expect(hyphenated.spotOf(3)).toEqual(spot(0, 0.25, 0.1, 0.1, 0.1, 0.35));
    expect(hyphenated.sourceAt(0, 0.16, 0.28)).toBe(5);
    expect(hyphenated.sourceAt(0, 0.31, 0.12)).toBe(4);
  });

  test('smart quotes take the place of the straight ones', () => {
    const quoted = index([run('say “hi”', 0, 0)], [{ from: 0, text: 'say "hi"' }]);
    expect(quoted.spotOf(5)!.x).toBe(0.25);
    expect(quoted.sourceAt(0, 0.2, 0.05)).toBe(4);
    expect(quoted.sourceAt(0, 0.4, 0.05)).toBe(8);
  });

  test('a table row is one line across its cells', () => {
    // | a | b |\n|---|---|\n| cc | dd |
    const table = index(
      [run('a', 10, 10), run('b', 50, 10), run('cc', 10, 25), run('dd', 50, 25)],
      [{ from: 2, text: 'a' }, { from: 6, text: 'b' }, { from: 22, text: 'cc' }, { from: 27, text: 'dd' }],
    );
    expect(table.spotOf(27)).toEqual(spot(0, 0.5, 0.25, 0.1, 0.1, 0.6));
    expect(table.sourceAt(0, 0.51, 0.3)).toBe(27);
    expect(table.sourceAt(0, 0.3, 0.3)).toBe(24);
  });

  test('math glyphs share out the formula between the words around it', () => {
    // if $x^2$ then
    const math = index([run('if ', 0, 0), run('x', 15, 0), run('2', 20, -2), run(' then', 25, 0)], [{ from: 0, text: 'if ' }, { from: 8, text: ' then' }]);
    expect(math.spotOf(9)!.x).toBe(0.3);
    expect(math.spotOf(4)!.x).toBe(0.2);
    expect(math.sourceAt(0, 0.16, 0.05)).toBe(3);
    expect(math.sourceAt(0, 0.31, 0.05)).toBe(9);
  });

  test('enum numbers take the offsets of their markers', () => {
    // 1. first\n2. second
    const list = index(
      [run('1.', 0, 0), run('first', 15, 0), run('2.', 0, 14), run('second', 15, 14)],
      [{ from: 3, text: 'first' }, { from: 12, text: 'second' }],
    );
    expect(list.spotOf(12)).toEqual(spot(0, 0.15, 0.14, 0.1, 0, 0.45));
    expect(list.sourceAt(0, 0.01, 0.05)).toBe(0);
    expect(list.sourceAt(0, 0.04, 0.19)).toBe(10);
  });

  test('pages are searched by their own index; an empty index finds nothing', () => {
    const two = SourceIndex.build(
      [{ width: 100, height: 100, runs: [run('one', 0, 0)] }, { width: 100, height: 100, runs: [run('two', 0, 0)] }],
      [{ from: 0, text: 'one\n\ntwo' }],
    );
    expect(two.spotOf(5)).toEqual(spot(1, 0, 0, 0.1, 0, 0.15));
    expect(two.sourceAt(1, 0.06, 0.05)).toBe(6);
    expect(two.sourceAt(2, 0, 0)).toBe(null);
    expect(SourceIndex.build([], []).spotOf(0)).toBe(null);
  });

  test('round trip: every offset inside a word comes back to itself', () => {
    const markdown = 'The *quick* brown fox\njumps over the **lazy** dog.';
    const pieces = [
      { from: 0, text: 'The ' }, { from: 5, text: 'quick' }, { from: 11, text: ' brown fox\njumps over the ' },
      { from: 39, text: 'lazy' }, { from: 45, text: ' dog.' },
    ];
    const roundTrip = SourceIndex.build(
      [
        { width: 200, height: 100, runs: [run('The ', 10, 10), run('quick', 30, 10), run(' brown fox ', 55, 10)] },
        { width: 200, height: 100, runs: [run('jumps over the ', 10, 10), run('lazy', 85, 10), run(' dog.', 105, 10)] },
      ],
      pieces,
    );
    const missed: string[] = [];
    for (const word of markdown.matchAll(/\w+/g)) {
      for (let o = word.index; o < word.index + word[0].length; o++) {
        const at = roundTrip.spotOf(o)!;
        const back = roundTrip.sourceAt(at.page, at.x, at.y + at.h / 2);
        if (back !== o) missed.push(`${word[0]}@${o} -> ${back}`);
      }
    }
    expect(missed).toEqual([]);
  });
});

describe('fittedEdges', () => {
  const narrowI = (c: string) => (c === 'i' ? 0.25 : 0.5);
  const mono = () => 0.6;
  const edges = fittedEdges([narrowI, mono]);

  test('measures in the face closest to the real width and gives justification slack to the spaces', () => {
    expect(edges({ text: 'mi i', x: 0, y: 0, w: 17, h: 10 })).toEqual([0, 5, 7.5, 14.5, 17]);
  });

  test('scales a run without spaces', () => {
    expect(edges({ text: 'mi', x: 0, y: 0, w: 15, h: 10 })).toEqual([0, 7.5, 15]);
  });
});
