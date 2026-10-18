import { Popover } from './popover';
import { editedWhen, type Recent } from './recent';

const span = (className: string, textContent: string) => Object.assign(document.createElement('span'), { className, textContent });

/**
 * The other documents kept in this browser, in a menu opened by the button joined to Open, read afresh on each open.
 * A document another tab holds is listed but does not open: two tabs on one record would overwrite each other's text.
 */
export class RecentMenu {
  readonly #panel: HTMLElement;
  readonly #list: () => Promise<Recent[]>;
  readonly #rows = new WeakMap<Element, Recent>();

  constructor(root: HTMLElement, list: () => Promise<Recent[]>, onOpen: (recent: Recent) => void) {
    const button = root.querySelector<HTMLButtonElement>('.recent-toggle')!;
    this.#panel = root.querySelector('.recent-panel')!;
    this.#list = list;
    const popover = new Popover(root, button, this.#panel, () => this.#fill());
    this.#panel.addEventListener('click', (e) => {
      const row = (e.target as Element).closest('.recent-row');
      const recent = row && this.#rows.get(row);
      if (!recent || recent.elsewhere) return;
      popover.close();
      button.focus();
      onOpen(recent);
    });
    this.#panel.addEventListener('keydown', (e) => {
      const items = [...this.#panel.querySelectorAll<HTMLElement>('[role=menuitem]')];
      const at = items.indexOf(document.activeElement as HTMLElement);
      const to = ({ ArrowDown: at + 1, ArrowUp: at - 1, Home: 0, End: items.length - 1 } as Record<string, number>)[e.key];
      if (to === undefined || items.length === 0) return;
      e.preventDefault();
      items[(to + items.length) % items.length]!.focus();
    });
  }

  /** Lists the documents and returns the first one that opens, or else the first line. */
  async #fill(): Promise<HTMLElement | null> {
    let lines: HTMLElement[];
    try {
      const now = Date.now();
      lines = (await this.#list()).map((recent) => this.#row(recent, now));
      if (lines.length === 0) lines = [this.#line('No other documents are kept in this browser.')];
    } catch (error) {
      lines = [this.#line(`Could not read the kept documents: ${error instanceof Error ? error.message : String(error)}`)];
    }
    this.#panel.replaceChildren(...lines);
    return lines.find((line) => !line.hasAttribute('aria-disabled')) ?? lines[0]!;
  }

  #row(recent: Recent, now: number): HTMLButtonElement {
    const row = Object.assign(document.createElement('button'), { type: 'button', className: 'recent-row', tabIndex: -1 });
    row.setAttribute('role', 'menuitem');
    let when: HTMLElement;
    if (recent.elsewhere) {
      row.setAttribute('aria-disabled', 'true');
      when = span('recent-when', 'Open in another tab');
    } else {
      when = Object.assign(document.createElement('time'), {
        className: 'recent-when',
        dateTime: new Date(recent.keptAt).toISOString(),
        textContent: editedWhen(recent.keptAt, now),
        title: new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(recent.keptAt),
      });
    }
    row.append(span('recent-name', recent.name), when, span('recent-preview', recent.preview));
    this.#rows.set(row, recent);
    return row;
  }

  #line(text: string): HTMLElement {
    const line = Object.assign(document.createElement('p'), { className: 'recent-empty', textContent: text, tabIndex: -1 });
    line.setAttribute('role', 'menuitem');
    line.setAttribute('aria-disabled', 'true');
    return line;
  }
}
