import { datetime, type FrontMatter, str } from '../convert/toTypst';
import type { ImagePath } from '../images';
import { type BuiltInTheme, MARGIN_MM, type PageSettings, type ThemeId } from '../settings';
import type { Diagnostic } from './compileMarkdown';
import base from './base.typ?raw';
import { FONT_FILES } from './files';
import book from './themes/book.typ?raw';
import modern from './themes/modern.typ?raw';
import paper from './themes/paper.typ?raw';

/** What the app knows of a theme, the custom one included: its name and the fonts it uses. */
export interface Theme {
  label: string;
  /** Fonts under public/ the theme needs beyond the ones loaded at boot. */
  fonts: readonly string[];
  /**
   * Fonts under public/ the theme sets text in, which linking and the preview's text layer measure each run against.
   * A face the theme never uses can match a line's width by chance.
   */
  text: readonly string[];
  /** A face under public/ that the settings menu sets the theme's name in. Null for the interface's own. */
  face: string | null;
}

/** A theme liveprint ships: its prelude is one of src/typst/themes/. */
export interface BuiltIn extends Theme {
  source: string;
}

export const THEMES: Record<BuiltInTheme, BuiltIn> = {
  book: {
    label: 'Book',
    source: book,
    fonts: [],
    text: [
      'fonts/LibertinusSerif-Regular.otf',
      'fonts/LibertinusSerif-Bold.otf',
      'fonts/LibertinusSerif-Italic.otf',
      'fonts/LibertinusSerif-BoldItalic.otf',
      'fonts/NewCMMath-Regular.otf',
      'fonts/DejaVuSansMono.ttf',
      'fonts/DejaVuSansMono-Bold.ttf',
      'fonts/DejaVuSansMono-Oblique.ttf',
    ],
    face: 'fonts/LibertinusSerif-Regular.otf',
  },
  paper: {
    label: 'Paper',
    source: paper,
    fonts: ['fonts/NewCM10-Regular.otf', 'fonts/NewCM10-Italic.otf', 'fonts/NewCM10-Bold.otf', 'fonts/NewCM10-BoldItalic.otf'],
    // Chrome rejects the CFF in NewCM10-Regular.otf and NewCM10-Italic.otf. The math font's upright Latin letters are
    // the same design, with the same advances, so it stands in for the regular face.
    text: [
      'fonts/NewCM10-Regular.otf',
      'fonts/NewCM10-Italic.otf',
      'fonts/NewCM10-Bold.otf',
      'fonts/NewCM10-BoldItalic.otf',
      'fonts/NewCMMath-Regular.otf',
      'fonts/DejaVuSansMono.ttf',
      'fonts/DejaVuSansMono-Bold.ttf',
      'fonts/DejaVuSansMono-Oblique.ttf',
    ],
    face: 'fonts/NewCMMath-Regular.otf',
  },
  modern: {
    label: 'Modern',
    source: modern,
    fonts: [
      'fonts/IBMPlexSans-Regular.otf',
      'fonts/IBMPlexSans-Italic.otf',
      'fonts/IBMPlexSans-Bold.otf',
      'fonts/IBMPlexSans-BoldItalic.otf',
      'fonts/IBMPlexSans-SemiBold.otf',
      'fonts/IBMPlexMono-Regular.otf',
      'fonts/IBMPlexMono-Italic.otf',
    ],
    text: [
      'fonts/IBMPlexSans-Regular.otf',
      'fonts/IBMPlexSans-Italic.otf',
      'fonts/IBMPlexSans-Bold.otf',
      'fonts/IBMPlexSans-BoldItalic.otf',
      'fonts/IBMPlexSans-SemiBold.otf',
      'fonts/IBMPlexMono-Regular.otf',
      'fonts/IBMPlexMono-Italic.otf',
      'fonts/NewCMMath-Regular.otf',
    ],
    face: 'fonts/IBMPlexSans-Regular.otf',
  },
};

const bundled = (fonts: (theme: BuiltIn) => readonly string[]) => [...new Set(Object.values(THEMES).flatMap(fonts))];

/** A prelude the user loads can set text in any bundled family, so it gets every theme's fonts and is measured against them all. */
export const CUSTOM_THEME: Theme = {
  label: 'Custom',
  fonts: bundled((theme) => theme.fonts),
  text: [...new Set([...FONT_FILES, ...bundled((theme) => theme.fonts)])],
  face: null,
};

export const themeOf = (id: ThemeId): Theme => (id === 'custom' ? CUSTOM_THEME : THEMES[id]);

/** The custom theme as a compile sees it: the user's prelude, and its logo's path among the images, if it has one. */
export interface CustomSource {
  source: string;
  logo: ImagePath | null;
}

/**
 * The `liveprint` dictionary every theme can read: the page settings, the front matter as plain text, and the custom
 * theme's logo. A date the front matter writes as a calendar date is a `datetime`, any other a string.
 */
function variables({ paper, margins }: PageSettings, front: FrontMatter | null, logo: ImagePath | null): string {
  const date = front?.date ?? null;
  const fields = [
    `paper: ${str(paper)}`,
    `margin: ${MARGIN_MM[margins]}mm`,
    `title: ${front?.title ? str(front.title) : 'none'}`,
    `authors: (${(front?.authors ?? []).map((a) => `${str(a)},`).join(' ')})`,
    `date: ${date === null ? 'none' : typeof date === 'string' ? str(date) : datetime(date)}`,
    `logo: ${logo ? str(`/images/${logo}`) : 'none'}`,
  ];
  return `#let liveprint = (${fields.join(', ')})`;
}

/** The PDF takes the title, the authors and a calendar date; any other date leaves it without one, rather than with one the page does not print. */
function metadata(front: FrontMatter | null): string {
  if (!front) return '';
  const date = front.date === null ? [] : [`date: ${typeof front.date === 'string' ? 'none' : 'liveprint.date'}`];
  return `#set document(${['title: liveprint.title', 'author: liveprint.authors', ...date].join(', ')})\n`;
}

/** The prelude up to the theme's own source. */
function head(settings: PageSettings, front: FrontMatter | null, custom: CustomSource | null): string {
  const { paper, margins } = settings;
  return `${variables(settings, front, custom?.logo ?? null)}\n${base}\n${metadata(front)}#set page(paper: "${paper}", margin: ${MARGIN_MM[margins]}mm)\n`;
}

/** The Custom theme without a prelude is base.typ's defaults alone. */
export function preludeFor(settings: PageSettings, front: FrontMatter | null = null, custom: CustomSource | null = null): string {
  const source = settings.theme === 'custom' ? (custom?.source ?? '') : THEMES[settings.theme].source;
  return head(settings, front, custom) + source;
}

/**
 * The first error of the custom prelude compiled in the Custom theme with no front matter, as "line 3: unknown
 * variable: foo", its line counted in the user's file. An error outside that file, in base.typ or a package, names
 * no line. Null when there is no error.
 */
export function preludeError(settings: PageSettings, custom: CustomSource, diagnostics: Diagnostic[]): string | null {
  const error = diagnostics.find((d) => d.severity === 'error');
  if (!error) return null;
  const start = head(settings, null, custom).split('\n').length - 1;
  const at = /^(\d+):/.exec(error.range);
  const line = at && !error.package ? Number(at[1]) - start + 1 : 0;
  return line >= 1 && line <= custom.source.split('\n').length ? `line ${line}: ${error.message}` : error.message;
}
