import { MARGINS, MARGINS_LABEL, type PageSettings, PAPER_LABEL, PAPERS, parseSettings, THEME_IDS, type ThemeId } from './settings';
import { THEMES } from './typst/themes';

interface Option<K extends keyof PageSettings> {
  value: PageSettings[K];
  label: string;
}

type Group = { [K in keyof PageSettings]: { key: K; legend: string; options: Option<K>[] } }[keyof PageSettings];

const GROUPS: Group[] = [
  { key: 'paper', legend: 'Paper', options: PAPERS.map((value) => ({ value, label: PAPER_LABEL[value] })) },
  { key: 'margins', legend: 'Margins', options: MARGINS.map((value) => ({ value, label: MARGINS_LABEL[value] })) },
  { key: 'theme', legend: 'Theme', options: THEME_IDS.map((value) => ({ value, label: THEMES[value].label })) },
];

const faceFamily = (theme: ThemeId) => `liveprint theme ${theme}`;

const settingsLabel = (s: PageSettings) => `${PAPER_LABEL[s.paper]} · ${MARGINS_LABEL[s.margins]} · ${THEMES[s.theme].label}`;

/**
 * The top bar's page settings: a button that names the current choice and opens a panel of segmented radio groups.
 * A change applies at once. Escape or a click outside closes the panel. Each theme's name is set in its own face,
 * loaded the first time the panel opens.
 */
export class SettingsMenu {
  readonly #button: HTMLButtonElement;
  readonly #panel: HTMLElement;
  readonly #onChange: (settings: PageSettings) => void;
  #settings: PageSettings;
  #shownTheme: ThemeId | null = null;
  #facesLoaded = false;

  constructor(root: HTMLElement, settings: PageSettings, onChange: (settings: PageSettings) => void) {
    this.#button = root.querySelector('button')!;
    this.#panel = root.querySelector('.settings-panel')!;
    this.#settings = settings;
    this.#onChange = onChange;
    this.#panel.append(...GROUPS.map((group) => this.#group(group)));
    this.#render();

    this.#button.addEventListener('click', () => (this.#panel.hidden ? this.#open() : this.#close()));
    this.#panel.addEventListener('change', (e) => {
      const input = e.target as HTMLInputElement;
      this.#settings = parseSettings({ ...this.#settings, [input.name]: input.value }, this.#settings);
      this.#render();
      this.#onChange(this.#settings);
    });
    root.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape' || this.#panel.hidden) return;
      e.preventDefault();
      this.#close();
      this.#button.focus();
    });
    root.addEventListener('focusout', (e) => {
      const to = e.relatedTarget as Node | null;
      if (to && !root.contains(to)) this.#close();
    });
    document.addEventListener('pointerdown', (e) => {
      if (this.#panel.hidden || root.contains(e.target as Node)) return;
      const hadFocus = root.contains(document.activeElement);
      this.#close();
      // A click on something focusable keeps that focus. Otherwise focus returns to the button, not the page.
      if (hadFocus) setTimeout(() => document.activeElement === document.body && this.#button.focus({ preventScroll: true }));
    });
  }

  /** The theme the preview is typeset in. A chosen theme that differs is still loading its fonts. */
  showing(theme: ThemeId): void {
    if (theme === this.#shownTheme) return;
    this.#shownTheme = theme;
    this.#render();
  }

  #group({ key, legend, options }: Group): HTMLFieldSetElement {
    const fieldset = document.createElement('fieldset');
    const row = Object.assign(document.createElement('div'), { className: 'segments' });
    row.append(
      ...options.map(({ value, label }) => {
        const option = document.createElement('label');
        const input = Object.assign(document.createElement('input'), { type: 'radio', name: key, value });
        const text = Object.assign(document.createElement('span'), { textContent: label });
        if (key === 'theme') text.style.fontFamily = `"${faceFamily(value as ThemeId)}", serif`;
        option.append(input, text);
        return option;
      }),
    );
    fieldset.append(Object.assign(document.createElement('legend'), { textContent: legend }), row);
    return fieldset;
  }

  #render(): void {
    this.#button.textContent = settingsLabel(this.#settings);
    for (const input of this.#panel.querySelectorAll('input')) {
      input.checked = this.#settings[input.name as keyof PageSettings] === input.value;
      const loading = input.name === 'theme' && input.checked && this.#shownTheme !== null && input.value !== this.#shownTheme;
      input.parentElement!.toggleAttribute('data-loading', loading);
      input.setAttribute('aria-busy', String(loading));
    }
  }

  #open(): void {
    if (!this.#facesLoaded) {
      this.#facesLoaded = true;
      const rules = THEME_IDS.map(
        (id) => `@font-face { font-family: "${faceFamily(id)}"; src: url("${import.meta.env.BASE_URL}${THEMES[id].face}"); font-display: swap; }`,
      );
      document.head.append(Object.assign(document.createElement('style'), { textContent: rules.join('\n') }));
    }
    this.#panel.hidden = false;
    this.#button.setAttribute('aria-expanded', 'true');
    this.#panel.querySelector<HTMLInputElement>('input:checked')?.focus();
  }

  #close(): void {
    this.#panel.hidden = true;
    this.#button.setAttribute('aria-expanded', 'false');
  }
}
