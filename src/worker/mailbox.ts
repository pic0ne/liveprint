import type { ImagePath } from '../images';
import type { LinkRequest, Rev, ToWorker, View } from '../protocol';
import type { PageSettings } from '../settings';

export type Edit = Extract<ToWorker, { kind: 'edit' }>;
export type ImageUpdate = Extract<ToWorker, { kind: 'image' }>;

/** Clicks go before cursor moves, and both before the check's run dump. */
const LINK_ORDER: LinkRequest['kind'][] = ['source', 'locate', 'runs'];

export interface MailboxHandlers {
  /** True when the document must compile again to show them. */
  settings(settings: PageSettings): Promise<boolean>;
  edit(edit: Edit): Promise<void>;
  /** Bookkeeping only, applied between jobs so the next job draws at the new size. */
  view(view: View): void;
  /** Gives the compiler each image's newest bytes, or takes it away for null. */
  images(updates: ImageUpdate[]): void;
  pdf(rev: Rev): Promise<void>;
  /** Answers one linking request. */
  link(request: LinkRequest): Promise<void>;
  /** Draws the next batch of dirty pages. False when there was none. */
  raster(): Promise<boolean>;
  /** Let queued messages land before the next job is picked, so a burst coalesces to its newest edit. */
  yieldToInbox(): Promise<void>;
}

/**
 * Single-slot mailbox, latest wins, and the worker's only scheduler. An edit that arrives while booting or busy
 * replaces `pending`, so stale edits are never compiled. Settings coalesce the same way and run before the edit, so
 * a change and an edit in one burst compile once. A change on its own compiles the last edit again. Images coalesce
 * per path and apply before both, then compile the last edit again the same way, so an image sent ahead of the edit
 * that references it is there when that edit compiles. A PDF request
 * runs after any pending edit, so it prints the newest text. Linking requests keep one slot per kind and run after
 * edits and PDFs, so they answer from the newest document. Dirty pages are drawn only when nothing else waits, one
 * batch per job, so an edit or a view that arrives meanwhile runs before the next batch.
 */
export class Mailbox {
  #phase: 'booting' | 'idle' | 'busy' = 'booting';
  #settings: PageSettings | null = null;
  #pending: Edit | null = null;
  /** The newest edit compiled, which a settings change compiles again. */
  #last: Edit | null = null;
  #view: View | null = null;
  #images = new Map<ImagePath, ImageUpdate>();
  #pdf: Rev | null = null;
  readonly #links = new Map<LinkRequest['kind'], LinkRequest>();
  readonly #handlers: MailboxHandlers;

  constructor(handlers: MailboxHandlers) {
    this.#handlers = handlers;
  }

  get phase() {
    return this.#phase;
  }

  receive(message: ToWorker): void {
    switch (message.kind) {
      case 'settings':
        this.#settings = message.settings;
        break;
      case 'edit':
        this.#pending = message;
        break;
      case 'view': {
        const { kind: _, ...view } = message;
        this.#view = view;
        break;
      }
      case 'image':
        this.#images.set(message.path, message);
        break;
      case 'pdf':
        this.#pdf = message.rev;
        break;
      default:
        this.#links.set(message.kind, message);
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
        if (this.#images.size > 0) {
          const images = this.#images;
          this.#images = new Map();
          this.#handlers.images([...images.values()]);
          this.#pending ??= this.#last;
        }
        const settings = this.#settings;
        const edit = this.#pending;
        const pdf = this.#pdf;
        const link = LINK_ORDER.map((kind) => this.#links.get(kind)).find((request) => request !== undefined);
        if (settings) {
          this.#settings = null;
          if (await this.#handlers.settings(settings)) this.#pending ??= this.#last;
        } else if (edit) {
          this.#pending = null;
          this.#last = edit;
          await this.#handlers.edit(edit);
        } else if (pdf !== null) {
          this.#pdf = null;
          await this.#handlers.pdf(pdf);
        } else if (link) {
          this.#links.delete(link.kind);
          await this.#handlers.link(link);
        } else if (!(await this.#handlers.raster())) {
          return;
        }
      }
    } finally {
      this.#phase = 'idle';
    }
  }
}
