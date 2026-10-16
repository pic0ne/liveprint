import { expect, test } from 'vitest';
import type { Rev } from '../protocol';
import { Mailbox } from './mailbox';

const edit = (rev: number) => ({ kind: 'edit', rev: rev as Rev, markdown: `v${rev}` }) as const;
const pdf = (rev: number) => ({ kind: 'pdf', rev: rev as Rev }) as const;

/** A mailbox whose compiles finish only when the test says so. */
function harness() {
  const log: string[] = [];
  const running: (() => void)[] = [];
  const job = (name: string) => () =>
    new Promise<void>((resolve) => {
      log.push(name);
      running.push(resolve);
    });
  const mailbox = new Mailbox({
    edit: (e) => job(`edit ${e.rev}`)(),
    pdf: (rev) => job(`pdf ${rev}`)(),
    yieldToInbox: () => Promise.resolve(),
  });
  const settle = () => new Promise((r) => setTimeout(r));
  const finishCurrent = async () => {
    running.shift()?.();
    await settle();
  };
  return { mailbox, log, settle, finishCurrent };
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
