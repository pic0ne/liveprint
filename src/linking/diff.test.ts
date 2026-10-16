import { expect, test } from 'vitest';
import { matchPairs } from './diff';

const codes = (s: string) => [...s].map((c) => c.codePointAt(0)!);
const pairs = (a: string, b: string) => matchPairs(codes(a), codes(b));

test('equal, empty and disjoint sequences', () => {
  expect(pairs('abc', 'abc')).toEqual([0, 0, 1, 1, 2, 2]);
  expect(pairs('', 'abc')).toEqual([]);
  expect(pairs('abc', '')).toEqual([]);
  expect(pairs('abc', 'xyz')).toEqual([]);
});

test('insertions on either side keep the rest paired', () => {
  expect(pairs('ab12cd', 'abcd')).toEqual([0, 0, 1, 1, 4, 2, 5, 3]);
  expect(pairs('abcd', 'xabycdz')).toEqual([0, 1, 1, 2, 2, 4, 3, 5]);
});

function lcsLength(a: number[], b: number[]): number {
  let row = new Array<number>(b.length + 1).fill(0);
  for (const x of a) {
    const next = [0];
    for (let j = 0; j < b.length; j++) next.push(x === b[j] ? row[j]! + 1 : Math.max(row[j + 1]!, next[j]!));
    row = next;
  }
  return row[b.length]!;
}

test('500 seeded random pairs: always a common subsequence, always a longest one', () => {
  let seed = 7;
  const random = (n: number) => Math.floor(((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31) * n);
  const failures: string[] = [];
  for (let t = 0; t < 500; t++) {
    const a = Array.from({ length: random(40) }, () => random(4));
    const b = random(2) ? Array.from({ length: random(40) }, () => random(4)) : a.filter(() => random(5) > 0).flatMap((x) => (random(6) ? [x] : [x, 9]));
    const out = matchPairs(a, b);
    const valid = out.every((v, i) => (i % 2 === 0 ? a[v] === b[out[i + 1]!] && (i === 0 || (v > out[i - 2]! && out[i + 1]! > out[i - 1]!)) : true));
    if (!valid || out.length / 2 !== lcsLength(a, b)) failures.push(`${JSON.stringify(a)} ${JSON.stringify(b)}`);
  }
  expect(failures).toEqual([]);
});
