import type { DocFile } from './doc';
import type { DocId } from './restore';

/** A kept document other than this tab's, as the Recent list shows it. */
export interface Recent {
  id: DocId;
  name: string;
  /** When its record was last written, in ms since the epoch. */
  keptAt: number;
  /** Its first non-empty line, without heading marks. */
  preview: string;
  /** Whether another open tab holds it, so this tab cannot open it. */
  elsewhere: boolean;
}

/** A record as read for the list. */
export interface KeptDoc {
  id: DocId;
  text: string;
  file: Pick<DocFile, 'name' | 'handle'>;
  keptAt: number;
  elsewhere: boolean;
}

/** Longer than any panel shows, so a line of pasted data never goes whole into the page. */
const PREVIEW_CHARS = 200;

/** The first non-empty line of `text`, trimmed, with the marks of a `#` heading stripped. */
export function previewLine(text: string): string {
  const line = text.split('\n').find((l) => l.trim() !== '') ?? '';
  return line
    .trim()
    .replace(/^#{1,6}(\s+|$)/, '')
    .replace(/\s+#+$/, '')
    .slice(0, PREVIEW_CHARS);
}

/**
 * The other kept documents, newest first. Leaves out this tab's own record and an empty document never saved, which
 * an empty Untitled.md is.
 */
export function listRecent(kept: readonly KeptDoc[], current: DocId): Recent[] {
  return kept
    .filter((doc) => doc.id !== current && (doc.text !== '' || doc.file.handle !== null))
    .sort((a, b) => b.keptAt - a.keptAt)
    .map((doc) => ({ id: doc.id, name: doc.file.name, keptAt: doc.keptAt, preview: previewLine(doc.text), elsewhere: doc.elsewhere }));
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

/**
 * When `keptAt` was, from `now`, in `locale` (the browser's when undefined): "now", "5 minutes ago", "3 hours ago" on
 * the same day, "yesterday", then the date, with its year when that is not this year.
 */
export function editedWhen(keptAt: number, now: number, locale?: string): string {
  const relative = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' });
  const ago = now - keptAt;
  if (ago < MINUTE) return relative.format(0, 'second');
  if (ago < HOUR) return relative.format(-Math.floor(ago / MINUTE), 'minute');
  const day = new Date(now);
  day.setHours(0, 0, 0, 0);
  if (keptAt >= day.getTime()) return relative.format(-Math.floor(ago / HOUR), 'hour');
  day.setDate(day.getDate() - 1);
  if (keptAt >= day.getTime()) return relative.format(-1, 'day');
  const sameYear = new Date(keptAt).getFullYear() === new Date(now).getFullYear();
  return new Intl.DateTimeFormat(locale, { month: 'short', day: 'numeric', year: sameYear ? undefined : 'numeric' }).format(keptAt);
}
