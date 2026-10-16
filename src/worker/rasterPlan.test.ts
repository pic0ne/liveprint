import { expect, test } from 'vitest';
import type { View } from '../protocol';
import { type RasterJob, RasterPlan } from './rasterPlan';

const A4 = { width: 595, height: 842 };
const view = (visible: [number, number], widthPx = 595, dpr = 1): View => ({ widthPx, dpr, visible: { first: visible[0], last: visible[1] } });

/** Draws batches until none is left, recording each batch's pages. A page's key is its index plus `version`. */
function drainOrder(plan: RasterPlan, version = 'a'): number[][] {
  const order: number[][] = [];
  for (let batch = plan.nextBatch(); batch.length > 0; batch = plan.nextBatch()) {
    order.push(batch.map((job) => job.index));
    for (const job of batch) plan.drawn(job.index, `${job.index}${version}`);
  }
  return order;
}

const keys = (batch: RasterJob[]) => batch.map((job) => [job.index, job.cacheKey]);

test('visible pages and one page either side come first as one batch, then the rest one at a time, nearest first, later pages winning ties', () => {
  const plan = new RasterPlan();
  plan.setView(view([3, 4]));
  plan.setDocument(Array(9).fill(A4));
  expect(plan.final).toBe(false);
  expect(drainOrder(plan)).toEqual([[2, 3, 4, 5], [6], [1], [7], [0], [8]]);
  expect(plan.final).toBe(true);
});

test('a compile marks every page dirty but keeps its key, so typst.ts can skip pages that did not change', () => {
  const plan = new RasterPlan();
  plan.setView(view([0, 0]));
  plan.setDocument([A4, A4, A4]);
  drainOrder(plan);
  plan.setDocument([A4, A4, A4, A4]);
  expect(keys(plan.nextBatch())).toEqual([
    [0, '0a'],
    [1, '1a'],
  ]);
  expect(drainOrder(plan, 'b')).toEqual([[0, 1], [2], [3]]);
  plan.setDocument([A4]);
  expect(keys(plan.nextBatch())).toEqual([[0, '0b']]);
});

test('a view at a new width or density forgets every key; a scroll keeps them and draws newly visible dirty pages first', () => {
  const plan = new RasterPlan();
  plan.setView(view([0, 0]));
  plan.setDocument([A4, A4, A4, A4, A4, A4]);
  expect(drainOrder(plan)).toEqual([[0, 1], [2], [3], [4], [5]]);

  plan.setDocument([A4, A4, A4, A4, A4, A4]);
  plan.setView(view([4, 5]));
  expect(keys(plan.nextBatch())).toEqual([
    [3, '3a'],
    [4, '4a'],
    [5, '5a'],
  ]);

  plan.setView(view([4, 5], 595, 2));
  expect(keys(plan.nextBatch())).toEqual([
    [3, undefined],
    [4, undefined],
    [5, undefined],
  ]);
});

test('pages are sized from the view width, with density capped at 2', () => {
  const plan = new RasterPlan();
  plan.setDocument([A4, { width: 842, height: 595 }]);
  expect(plan.sizes).toEqual([]);
  expect(plan.final).toBe(true);
  plan.setView(view([0, 0], 600, 3));
  expect(plan.sizes).toEqual([
    { width: 1200, height: 1698 },
    { width: 1200, height: 848 },
  ]);
  expect(plan.nextBatch().map((job) => job.pixelPerPt)).toEqual([1200 / 595, 1200 / 842]);
});
