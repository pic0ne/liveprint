import { expect, test } from 'vitest';
import { parseRuns } from './runs';
import fixture from './semantics.fixture.html?raw';

// Captured from typst.ts 0.7.0 rendering src/sample.md in Chrome: a heading, a line split by two emphasised words,
// a table row, a code token, and an escaped `<`. `right` is the layer's own right edge (its rb2 box), which the
// parser does not read.
const expected = [
  { text: 'Lists', x: 62.36221, y: 163.43021, h: 13.2, right: 90.2274 },
  { text: 'Space ', x: 62.36221, y: 76.75021, h: 11, right: 91.26695 },
  { text: 'above', x: 91.26695, y: 76.8932, h: 11, right: 116.33595 },
  { text: ' a heading should be larger than space ', x: 116.33595, y: 76.75021, h: 11, right: 294.98291 },
  { text: 'below', x: 294.98291, y: 76.8932, h: 11, right: 320.09592 },
  { text: ' it, so the heading clearly belongs to the text it ', x: 320.09592, y: 76.75021, h: 11, right: 532.91339 },
  { text: 'Header row', x: 68.36221, y: 491.27319, h: 11, right: 121.34921 },
  { text: 'Bold or a rule below', x: 155.6792, y: 491.27319, h: 11, right: 246.61621 },
  { text: 'Separates labels from data', x: 304.3432, y: 491.27319, h: 11, right: 421.70221 },
  { text: 'badness', x: 86.61758, y: 700.79504, h: 9, right: 124.54678 },
  { text: '<', x: 140.80215, y: 108.42587, h: 9, right: 146.22061 },
];

test('parseRuns reads every text run of a captured page in order, with its box in pt', () => {
  const runs = parseRuns(fixture);
  expect(runs.map(({ text, x, y, h }) => ({ text, x, y, h }))).toEqual(expected.map(({ text, x, y, h }) => ({ text, x, y, h })));
  runs.forEach((run, i) => expect(run.x + run.w).toBeCloseTo(expected[i]!.right, 2));
});

test('parseRuns marks a run whose line carries on in the next run', () => {
  expect(parseRuns(fixture).map((run) => !!run.continued)).toEqual([false, true, true, true, true, false, false, false, false, false, false]);
});

test('parseRuns decodes entities and skips spans without text or position', () => {
  const span = (style: string, text: string) => `<span class="typst-content-text" data-text-id="0" style="${style}">${text}</span>`;
  const at = 'font-size: calc(var(--data-text-height) * 10.00000); left: calc(var(--data-text-width) * 1.50000); top: calc(var(--data-text-height) * 2.00000)';
  const runs = parseRuns(span(at, 'a&amp;b&#233;&#x263A;&quot;') + span(at, '') + span('font-size: calc(var(--data-text-height) * 10.00000)', 'x'));
  expect(runs).toEqual([{ text: 'a&bé☺"', x: 1.5, y: 2, h: 10, w: 6 * (1233 / 2048) * 10 }]);
});
