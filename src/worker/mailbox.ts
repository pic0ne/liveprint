import type { Rev, ToWorker } from '../protocol';

export type Edit = Extract<ToWorker, { kind: 'edit' }>;

export interface MailboxHandlers {
  edit(edit: Edit): Promise<void>;
  pdf(rev: Rev): Promise<void>;
  /** Let queued messages land before the next job is picked, so a burst coalesces to its newest edit. */
  yieldToInbox(): Promise<void>;
}

/**
 * Single-slot mailbox, latest wins. An edit that arrives while booting or compiling replaces `pending`,
 * so stale edits are never compiled. A PDF request runs after any pending edit, so it prints the newest text.
 */
export class Mailbox {
  #phase: 'booting' | 'idle' | 'compiling' = 'booting';
  #pending: Edit | null = null;
  #pdf: Rev | null = null;
  readonly #handlers: MailboxHandlers;

  constructor(handlers: MailboxHandlers) {
    this.#handlers = handlers;
  }

  get phase() {
    return this.#phase;
  }

  receive(message: ToWorker): void {
    if (message.kind === 'edit') this.#pending = message;
    else this.#pdf = message.rev;
    void this.#pump();
  }

  booted(): void {
    this.#phase = 'idle';
    void this.#pump();
  }

  async #pump(): Promise<void> {
    if (this.#phase !== 'idle') return;
    this.#phase = 'compiling';
    try {
      for (;;) {
        await this.#handlers.yieldToInbox();
        const edit = this.#pending;
        const pdf = this.#pdf;
        if (edit) {
          this.#pending = null;
          await this.#handlers.edit(edit);
        } else if (pdf !== null) {
          this.#pdf = null;
          await this.#handlers.pdf(pdf);
        } else {
          return;
        }
      }
    } finally {
      this.#phase = 'idle';
    }
  }
}
