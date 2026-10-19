export const PAPERS = ['a4', 'us-letter'] as const;
export const MARGINS = ['narrow', 'normal', 'wide'] as const;
export const BUILT_IN_THEMES = ['book', 'paper', 'modern'] as const;
/** The built-in themes, and the custom one, which a prelude the user loads sets. */
export const THEME_IDS = [...BUILT_IN_THEMES, 'custom'] as const;

/** Typst's own paper names, so they go into `#set page` as they are. */
export type Paper = (typeof PAPERS)[number];
export type Margins = (typeof MARGINS)[number];
export type BuiltInTheme = (typeof BUILT_IN_THEMES)[number];
export type ThemeId = (typeof THEME_IDS)[number];

export interface PageSettings {
  paper: Paper;
  margins: Margins;
  theme: ThemeId;
}

export const MARGIN_MM: Record<Margins, number> = { narrow: 18, normal: 25, wide: 35 };

export const PAPER_LABEL: Record<Paper, string> = { a4: 'A4', 'us-letter': 'Letter' };
export const MARGINS_LABEL: Record<Margins, string> = { narrow: 'Narrow', normal: 'Normal', wide: 'Wide' };

/** Regions whose default paper is US Letter, from CLDR's measurement data. */
const LETTER_REGIONS = new Set(['BZ', 'CA', 'CL', 'CO', 'CR', 'GT', 'MX', 'NI', 'PA', 'PH', 'PR', 'SV', 'US', 'VE']);

function region(locale: string): string | undefined {
  try {
    return new Intl.Locale(locale).maximize().region;
  } catch {
    return undefined;
  }
}

export function defaultSettings(locale: string): PageSettings {
  const paper = LETTER_REGIONS.has(region(locale) ?? '') ? 'us-letter' : 'a4';
  return { paper, margins: 'normal', theme: 'book' };
}

const pick = <T extends string>(options: readonly T[], value: unknown, fallback: T): T =>
  options.includes(value as T) ? (value as T) : fallback;

/** Reads what was stored, a JSON string or an object. A field that is missing or unknown takes the fallback's. */
export function parseSettings(stored: unknown, fallback: PageSettings): PageSettings {
  let value = stored;
  if (typeof stored === 'string') {
    try {
      value = JSON.parse(stored);
    } catch {
      return fallback;
    }
  }
  const record = (typeof value === 'object' && value !== null ? value : {}) as Record<string, unknown>;
  return {
    paper: pick(PAPERS, record.paper, fallback.paper),
    margins: pick(MARGINS, record.margins, fallback.margins),
    theme: pick(THEME_IDS, record.theme, fallback.theme),
  };
}

export const sameSettings = (a: PageSettings, b: PageSettings) => a.paper === b.paper && a.margins === b.margins && a.theme === b.theme;
