import { expect, test } from 'vitest';
import type { Rev } from '../protocol';
import { Mailbox } from './mailbox';

const edit = (rev: number) => ({ kind: 'edit', rev: rev as Rev, markdown: `v${rev}` }) as const;
const pdf = (rev: number) => ({ kind: 'pdf', rev: rev as Rev }) as const;
const view = (widthPx: number) => ({ kind: 'view', widthPx, dpr: 1, visible: { first: 0, last: 0 } }) as const;
const locate = (id: number) => ({ kind: 'locate', id, offset: id }) as const;
const source = (id: number) => ({ kind: 'source', id, page: 0, fx: 0, fy: 0 }) as const;

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
  const mailbox = new Mailbox({
    edit: (e) => job(`edit ${e.rev}`)(),
    view: (v) => log.push(`view ${v.widthPx}`),
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
