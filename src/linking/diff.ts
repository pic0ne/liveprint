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
