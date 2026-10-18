/**
 * A button that opens a panel over the page. The button toggles it. Escape, a click outside `root` or focus leaving
 * `root` closes it. `fill` runs on each open, before the panel shows, and returns what to focus in it.
 */
export class Popover {
  readonly #button: HTMLButtonElement;
  readonly #panel: HTMLElement;
  readonly #fill: () => HTMLElement | null | Promise<HTMLElement | null>;
  /** Counts opens and closes, so a slow `fill` that a close overtook does not show the panel. */
  #turn = 0;

  constructor(root: HTMLElement, button: HTMLButtonElement, panel: HTMLElement, fill: () => HTMLElement | null | Promise<HTMLElement | null>) {
    this.#button = button;
    this.#panel = panel;
    this.#fill = fill;
    button.addEventListener('click', () => (this.#expanded ? this.close() : this.open()));
    root.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape' || !this.#expanded) return;
      e.preventDefault();
      this.close();
      button.focus();
    });
    root.addEventListener('focusout', (e) => {
      const to = e.relatedTarget as Node | null;
      if (to && !root.contains(to)) this.close();
    });
    document.addEventListener('pointerdown', (e) => {
      if (!this.#expanded || root.contains(e.target as Node)) return;
      const hadFocus = root.contains(document.activeElement);
      this.close();
      // A click on something focusable keeps that focus. Otherwise focus returns to the button, not the page.
      if (hadFocus) setTimeout(() => document.activeElement === document.body && button.focus({ preventScroll: true }));
    });
  }

  get #expanded(): boolean {
    return this.#button.getAttribute('aria-expanded') === 'true';
  }

  open(): void {
    const turn = ++this.#turn;
    this.#button.setAttribute('aria-expanded', 'true');
    void Promise.resolve(this.#fill()).then((focus) => {
      if (turn !== this.#turn) return;
      this.#panel.hidden = false;
      focus?.focus();
    });
  }

  close(): void {
    this.#turn++;
    this.#panel.hidden = true;
    this.#button.setAttribute('aria-expanded', 'false');
  }
}
