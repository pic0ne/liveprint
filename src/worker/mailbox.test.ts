import { expect, test } from 'vitest';
import type { ImagePath } from '../images';
import type { Bytes, Rev } from '../protocol';
import type { ThemeId } from '../settings';
import { Mailbox } from './mailbox';

const edit = (rev: number) => ({ kind: 'edit', rev: rev as Rev, markdown: `v${rev}` }) as const;
const pdf = (rev: number) => ({ kind: 'pdf', rev: rev as Rev }) as const;
const view = (widthPx: number) => ({ kind: 'view', widthPx, dpr: 1, visible: { first: 0, last: 0 } }) as const;
const locate = (id: number) => ({ kind: 'locate', id, offset: id }) as const;
const source = (id: number) => ({ kind: 'source', id, page: 0, fx: 0, fy: 0 }) as const;
const image = (path: string, size: number | null) =>
  ({ kind: 'image', path: path as ImagePath, bytes: size === null ? null : (new Uint8Array(size) as Bytes), drawn: null }) as const;
const settings = (theme: ThemeId) => ({ kind: 'settings', settings: { paper: 'a4', margins: 'normal', theme } }) as const;

/** A mailbox whose compiles finish only when the test says so. */
function harness() {
  const log: string[] = [];
  const running: (() => void)[] = [];
  const job = (name: string) => () =>
    new Promise<void>((resolve) => {
      log.push(name);
      running.push(resolve);
    });
  const raster = { batchesLeft: 0 };
  /** Themes whose settings the handler reports as changing the document. */
  const changes = new Set<ThemeId>(['paper', 'modern']);
  const mailbox = new Mailbox({
    settings: async (s) => {
      await job(`settings ${s.theme}`)();
      return changes.has(s.theme);
    },
    edit: (e) => job(`edit ${e.rev}`)(),
    view: (v) => log.push(`view ${v.widthPx}`),
    images: (updates) => log.push(`images ${updates.map(({ path, bytes }) => `${path}=${bytes?.length ?? null}`).join(' ')}`),
    pdf: (rev) => job(`pdf ${rev}`)(),
    link: (request) => job(`${request.kind} ${request.id}`)(),
    raster: async () => {
      if (raster.batchesLeft === 0) return false;
      await job('raster')();
      raster.batchesLeft--;
      return true;
    },
    yieldToInbox: () => Promise.resolve(),
  });
  const settle = () => new Promise((r) => setTimeout(r));
  const finishCurrent = async () => {
    running.shift()?.();
    await settle();
  };
  return { mailbox, log, settle, finishCurrent, raster };
}

test('edits sent while booting coalesce to the newest', async () => {
  const { mailbox, log, settle } = harness();
  mailbox.receive(edit(1));
  mailbox.receive(edit(2));
  mailbox.receive(edit(3));
  await settle();
  expect(log).toEqual([]);
  mailbox.booted();
  await settle();
  expect(log).toEqual(['edit 3']);
});

test('edits arriving during a compile replace each other; stale ones never compile', async () => {
  const { mailbox, log, settle, finishCurrent } = harness();
  mailbox.booted();
  mailbox.receive(edit(1));
  await settle();
  for (const rev of [2, 3, 4]) mailbox.receive(edit(rev));
  await finishCurrent();
  await finishCurrent();
  expect(log).toEqual(['edit 1', 'edit 4']);
  expect(mailbox.phase).toBe('idle');
});

test('a PDF request waits for the pending edit so it prints the newest text', async () => {
  const { mailbox, log, settle, finishCurrent } = harness();
  mailbox.booted();
  mailbox.receive(edit(1));
  await settle();
  mailbox.receive(pdf(1));
  mailbox.receive(edit(2));
  await finishCurrent();
  await finishCurrent();
  await finishCurrent();
  expect(log).toEqual(['edit 1', 'edit 2', 'pdf 1']);
});

test('views coalesce to the newest and apply before the job they arrived ahead of', async () => {
  const { mailbox, log, settle, finishCurrent } = harness();
  mailbox.receive(view(300));
  mailbox.booted();
  mailbox.receive(edit(1));
  await settle();
  mailbox.receive(view(400));
  mailbox.receive(view(500));
  mailbox.receive(edit(2));
  await finishCurrent();
  await finishCurrent();
  expect(log).toEqual(['view 300', 'edit 1', 'view 500', 'edit 2']);
});

test('dirty pages are drawn one batch per job, after edits and PDFs, and an edit arriving mid-raster goes next', async () => {
  const { mailbox, log, settle, finishCurrent, raster } = harness();
  mailbox.booted();
  raster.batchesLeft = 3;
  mailbox.receive(edit(1));
  mailbox.receive(pdf(1));
  await settle();
  await finishCurrent();
  await finishCurrent();
  mailbox.receive(edit(2));
  for (let i = 0; i < 4; i++) await finishCurrent();
  expect(log).toEqual(['edit 1', 'pdf 1', 'raster', 'edit 2', 'raster', 'raster']);
  expect(mailbox.phase).toBe('idle');
});

test('linking waits for the edit, a click goes before a cursor move, and only the newest cursor move is answered', async () => {
  const { mailbox, log, settle, finishCurrent, raster } = harness();
  mailbox.booted();
  raster.batchesLeft = 1;
  mailbox.receive(edit(1));
  await settle();
  mailbox.receive(locate(1));
  mailbox.receive(edit(2));
  mailbox.receive(locate(2));
  mailbox.receive(source(3));
  for (let i = 0; i < 5; i++) await finishCurrent();
  expect(log).toEqual(['edit 1', 'edit 2', 'source 3', 'locate 2', 'raster']);
  expect(mailbox.phase).toBe('idle');
});

test('settings sent while booting coalesce to the newest and run before the first edit', async () => {
  const { mailbox, log, settle, finishCurrent } = harness();
  mailbox.receive(settings('paper'));
  mailbox.receive(edit(1));
  mailbox.receive(settings('modern'));
  mailbox.booted();
  await settle();
  await finishCurrent();
  await finishCurrent();
  expect(log).toEqual(['settings modern', 'edit 1']);
  expect(mailbox.phase).toBe('idle');
});

test('a settings change and an edit in the same burst compile once, with both', async () => {
  const { mailbox, log, settle, finishCurrent } = harness();
  mailbox.booted();
  mailbox.receive(edit(1));
  await settle();
  mailbox.receive(edit(2));
  mailbox.receive(settings('paper'));
  for (let i = 0; i < 3; i++) await finishCurrent();
  expect(log).toEqual(['edit 1', 'settings paper', 'edit 2']);
  expect(mailbox.phase).toBe('idle');
});

test('a settings change on its own compiles the last edit again, and one that changes nothing does not', async () => {
  const { mailbox, log, settle, finishCurrent } = harness();
  mailbox.booted();
  mailbox.receive(edit(1));
  await settle();
  await finishCurrent();
  mailbox.receive(settings('modern'));
  await settle();
  await finishCurrent();
  await finishCurrent();
  mailbox.receive(settings('book'));
  await settle();
  await finishCurrent();
  expect(log).toEqual(['edit 1', 'settings modern', 'edit 1', 'settings book']);
  expect(mailbox.phase).toBe('idle');
});

test('settings go before a PDF request and linking, so both answer from the new document', async () => {
  const { mailbox, log, settle, finishCurrent } = harness();
  mailbox.booted();
  mailbox.receive(edit(1));
  await settle();
  mailbox.receive(locate(2));
  mailbox.receive(pdf(1));
  mailbox.receive(settings('paper'));
  for (let i = 0; i < 5; i++) await finishCurrent();
  expect(log).toEqual(['edit 1', 'settings paper', 'edit 1', 'pdf 1', 'locate 2']);
  expect(mailbox.phase).toBe('idle');
});

test('images coalesce per path to the newest bytes and apply before settings and the edit of the same burst, which compiles once', async () => {
  const { mailbox, log, settle, finishCurrent } = harness();
  mailbox.booted();
  mailbox.receive(edit(1));
  await settle();
  mailbox.receive(image('a.png', 3));
  mailbox.receive(image('b.png', 5));
  mailbox.receive(settings('paper'));
  mailbox.receive(image('a.png', 4));
  mailbox.receive(image('b.png', null));
  mailbox.receive(edit(2));
  for (let i = 0; i < 3; i++) await finishCurrent();
  expect(log).toEqual(['edit 1', 'images a.png=4 b.png=null', 'settings paper', 'edit 2']);
  expect(mailbox.phase).toBe('idle');
});

test('an image on its own compiles the last edit again', async () => {
  const { mailbox, log, settle, finishCurrent } = harness();
  mailbox.booted();
  mailbox.receive(edit(1));
  await settle();
  await finishCurrent();
  mailbox.receive(image('plot.png', 7));
  await settle();
  await finishCurrent();
  expect(log).toEqual(['edit 1', 'images plot.png=7', 'edit 1']);
  expect(mailbox.phase).toBe('idle');
});

test('images sent while booting apply before the first edit, which compiles once', async () => {
  const { mailbox, log, settle, finishCurrent } = harness();
  mailbox.receive(image('cat.png', 2));
  mailbox.receive(edit(1));
  mailbox.booted();
  await settle();
  await finishCurrent();
  expect(log).toEqual(['images cat.png=2', 'edit 1']);
  expect(mailbox.phase).toBe('idle');
});
