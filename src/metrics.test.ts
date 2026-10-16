import { expect, test } from 'vitest';
import { LatencyMeter } from './metrics';
import type { Rev } from './protocol';

const r = (n: number) => n as Rev;

test('a paint completes every outstanding input up to its rev, each with its own latency', () => {
  const meter = new LatencyMeter();
  meter.input(r(1), 100);
  meter.input(r(2), 110);
  meter.input(r(3), 120);
  meter.painted(r(2), 150);
  expect(meter.stats()).toEqual({ last: 40, p50: 40, p95: 50, count: 2 });
  meter.painted(r(3), 125);
  expect(meter.stats()).toEqual({ last: 5, p50: 40, p95: 50, count: 3 });
});

test('a stale paint does not complete newer inputs', () => {
  const meter = new LatencyMeter();
  meter.input(r(5), 0);
  meter.painted(r(4), 10);
  expect(meter.stats().count).toBe(0);
});

test('percentiles cover only the last 100 inputs', () => {
  const meter = new LatencyMeter();
  for (let i = 1; i <= 150; i++) {
    meter.input(r(i), 0);
    meter.painted(r(i), i);
  }
  expect(meter.stats()).toEqual({ last: 150, p50: 100, p95: 145, count: 150 });
});
