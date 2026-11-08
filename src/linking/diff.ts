type Sequence = ArrayLike<number>;

/**
 * The positions a longest common subsequence pairs up, as `[i0, j0, i1, j1, …]` with `a[i] === b[j]`, both
 * increasing. Myers' O((N+M)D) diff in linear space: each step finds the middle snake of the shortest edit script
 * and recurses on both halves, so a document's worth of characters needs no D² trace.
 */
export function matchPairs(a: Sequence, b: Sequence): number[] {
  const out: number[] = [];
  const size = 2 * (a.length + b.length) + 4;
  const forward = new Int32Array(size);
  const backward = new Int32Array(size);
  const offset = a.length + b.length + 2;

  function snake(aLo: number, aHi: number, bLo: number, bHi: number): [number, number, number, number] {
    const n = aHi - aLo;
    const m = bHi - bLo;
    const delta = n - m;
    const odd = (delta & 1) === 1;
    forward[offset + 1] = 0;
    backward[offset + 1] = 0;
    const most = Math.ceil((n + m) / 2);
    for (let d = 0; d <= most; d++) {
      for (let k = -d; k <= d; k += 2) {
        let x = k === -d || (k !== d && forward[offset + k - 1]! < forward[offset + k + 1]!) ? forward[offset + k + 1]! : forward[offset + k - 1]! + 1;
        const x0 = x;
        while (x < n && x - k < m && a[aLo + x] === b[bLo + x - k]) x++;
        forward[offset + k] = x;
        const back = delta - k;
        if (odd && back >= -(d - 1) && back <= d - 1 && x + backward[offset + back]! >= n) return [aLo + x0, bLo + x0 - k, aLo + x, bLo + x - k];
      }
      for (let k = -d; k <= d; k += 2) {
        let x = k === -d || (k !== d && backward[offset + k - 1]! < backward[offset + k + 1]!) ? backward[offset + k + 1]! : backward[offset + k - 1]! + 1;
        const x0 = x;
        while (x < n && x - k < m && a[aHi - 1 - x] === b[bHi - 1 - x + k]) x++;
        backward[offset + k] = x;
        const ahead = delta - k;
        if (!odd && ahead >= -d && ahead <= d && x + forward[offset + ahead]! >= n) return [aHi - x, bHi - x + k, aHi - x0, bHi - x0 + k];
      }
    }
    throw new Error('unreachable: every pair of sequences has a middle snake');
  }

  function align(aLo: number, aHi: number, bLo: number, bHi: number): void {
    while (aLo < aHi && bLo < bHi && a[aLo] === b[bLo]) out.push(aLo++, bLo++);
    let aEnd = aHi;
    let bEnd = bHi;
    while (aEnd > aLo && bEnd > bLo && a[aEnd - 1] === b[bEnd - 1]) {
      aEnd--;
      bEnd--;
    }
    if (aLo < aEnd && bLo < bEnd) {
      const [x, y, u, v] = snake(aLo, aEnd, bLo, bEnd);
      align(aLo, x, bLo, y);
      for (let i = 0; i < u - x; i++) out.push(x + i, y + i);
      align(u, aEnd, v, bEnd);
    }
    for (let i = 0; i < aHi - aEnd; i++) out.push(aEnd + i, bEnd + i);
  }

  align(0, a.length, 0, b.length);
  return out;
}

/**
 * `matchPairs(a, b)` without its strays, the runs kept grown over equal neighbours. A longest common subsequence
 * pairs as many elements as it can, not neighbours with neighbours, so text that one side has and the other lacks can
 * take a letter that belongs elsewhere: the `i` of a name paired with the `i` of a contents entry further down the
 * page. A run of consecutive pairs is a stray when it is shorter than the jump on both sides of it: how much further
 * one sequence moved than the other since the run before, or until the run after. Dropping a stray frees the letters
 * it took, and the runs beside them take them back.
 */
export function matchRuns(a: Sequence, b: Sequence): number[] {
  const pairs = matchPairs(a, b);
  const runs: { a: number; b: number; length: number }[] = [];
  for (let i = 0; i < pairs.length; i += 2) {
    const last = runs[runs.length - 1];
    if (last && pairs[i] === last.a + last.length && pairs[i + 1] === last.b + last.length) last.length++;
    else runs.push({ a: pairs[i]!, b: pairs[i + 1]!, length: 1 });
  }
  const end = { a: a.length, b: b.length, length: 0 };
  const start = { a: 0, b: 0, length: 0 };
  const jump = (from: { a: number; b: number; length: number }, to: { a: number; b: number }) =>
    Math.abs(to.a - from.a - from.length - (to.b - from.b - from.length));
  const kept = runs.filter((run, r) => run.length >= jump(runs[r - 1] ?? start, run) || run.length >= jump(run, runs[r + 1] ?? end));
  const out: number[] = [];
  kept.forEach((run, r) => {
    const next = kept[r + 1] ?? end;
    let length = run.length;
    while (run.a + length < next.a && run.b + length < next.b && a[run.a + length] === b[run.b + length]) length++;
    let back = 0;
    const previous = out.length > 0 ? { a: out[out.length - 2]! + 1, b: out[out.length - 1]! + 1 } : start;
    while (run.a - back > previous.a && run.b - back > previous.b && a[run.a - back - 1] === b[run.b - back - 1]) back++;
    for (let i = -back; i < length; i++) out.push(run.a + i, run.b + i);
  });
  return out;
}
