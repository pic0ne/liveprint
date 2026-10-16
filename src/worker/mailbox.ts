import type { Rev, ToWorker, View } from '../protocol';

export type Edit = Extract<ToWorker, { kind: 'edit' }>;

export interface MailboxHandlers {
  edit(edit: Edit): Promise<void>;
  /** Bookkeeping only, applied between jobs so the next job draws at the new size. */
  view(view: View): void;
  pdf(rev: Rev): Promise<void>;
  /** Let queued messages land before the next job is picked, so a burst coalesces to its newest edit. */
  yieldToInbox(): Promise<void>;
}

/**
 * Single-slot mailbox, latest wins, and the worker's only scheduler. An edit that arrives while booting or busy
 * replaces `pending`, so stale edits are never compiled. A PDF request runs after any pending edit, so it prints
 * the newest text.
 */
export class Mailbox {
  #phase: 'booting' | 'idle' | 'busy' = 'booting';
  #pending: Edit | null = null;
  #view: View | null = null;
  #pdf: Rev | null = null;
  readonly #handlers: MailboxHandlers;

  constructor(handlers: MailboxHandlers) {
    this.#handlers = handlers;
  }

  get phase() {
    return this.#phase;
  }

  receive(message: ToWorker): void {
    switch (message.kind) {
      case 'edit':
        this.#pending = message;
        break;
      case 'view': {
        const { kind: _, ...view } = message;
        this.#view = view;
        break;
      }
      case 'pdf':
        this.#pdf = message.rev;
        break;
    }
    void this.#pump();
  }

  booted(): void {
    this.#phase = 'idle';
    void this.#pump();
  }

  async #pump(): Promise<void> {
    if (this.#phase !== 'idle') return;
    this.#phase = 'busy';
    try {
      for (;;) {
        await this.#handlers.yieldToInbox();
        const view = this.#view;
        if (view) {
          this.#view = null;
          this.#handlers.view(view);
        }
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
