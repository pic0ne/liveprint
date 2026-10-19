import { expect, test } from 'vitest';
import { defaultSettings, type PageSettings, parseSettings } from './settings';

test.each([
  ['en-US', 'us-letter'],
  ['en-CA', 'us-letter'],
  ['fr-CA', 'us-letter'],
  ['es-MX', 'us-letter'],
  ['fil-PH', 'us-letter'],
  ['es-CO', 'us-letter'],
  ['en', 'us-letter'],
  ['en-GB', 'a4'],
  ['de-DE', 'a4'],
  ['es', 'a4'],
  ['pt-BR', 'a4'],
  ['ja', 'a4'],
  ['not a locale!', 'a4'],
  ['', 'a4'],
])('defaultSettings(%j) prints on %s, with normal margins in Book', (locale, paper) => {
  expect(defaultSettings(locale)).toEqual({ paper, margins: 'normal', theme: 'book' });
});

const fallback: PageSettings = { paper: 'a4', margins: 'normal', theme: 'book' };

test.each([
  ['nothing stored', null],
  ['undefined', undefined],
  ['not JSON', 'A4 please'],
  ['JSON null', 'null'],
  ['a JSON number', '42'],
  ['a JSON array', '["us-letter","wide","modern"]'],
  ['an empty object', '{}'],
  ['unknown values', '{"paper":"a5","margins":"huge","theme":"Modern"}'],
  ['values of the wrong type', '{"paper":1,"margins":true,"theme":{}}'],
])('parseSettings falls back on %s', (_, stored) => {
  expect(parseSettings(stored, fallback)).toEqual(fallback);
});

test('parseSettings keeps each valid field of a partial value', () => {
  expect(parseSettings('{"paper":"us-letter","theme":"nope"}', fallback)).toEqual({ paper: 'us-letter', margins: 'normal', theme: 'book' });
  expect(parseSettings({ margins: 'wide' }, fallback)).toEqual({ paper: 'a4', margins: 'wide', theme: 'book' });
});

test('parseSettings reads a full stored value and drops extra fields', () => {
  expect(parseSettings('{"paper":"us-letter","margins":"narrow","theme":"modern","zoom":2}', fallback)).toEqual({
    paper: 'us-letter',
    margins: 'narrow',
    theme: 'modern',
  });
});

test('parseSettings reads the custom theme', () => {
  expect(parseSettings('{"paper":"a4","margins":"wide","theme":"custom"}', fallback)).toEqual({ paper: 'a4', margins: 'wide', theme: 'custom' });
});
