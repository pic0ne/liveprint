import { MARGIN_MM, type PageSettings, type ThemeId } from '../settings';
import base from './base.typ?raw';
import book from './themes/book.typ?raw';
import modern from './themes/modern.typ?raw';
import paper from './themes/paper.typ?raw';

export interface Theme {
  id: ThemeId;
  label: string;
  source: string;
  /** Fonts under public/ the theme needs beyond the ones loaded at boot. */
  fonts: readonly string[];
  /** A face under public/ that the settings menu sets the theme's name in. */
  face: string;
}

export const THEMES: Record<ThemeId, Theme> = {
  book: { id: 'book', label: 'Book', source: book, fonts: [], face: 'fonts/LibertinusSerif-Regular.otf' },
  paper: {
    id: 'paper',
    label: 'Paper',
    source: paper,
    fonts: ['fonts/NewCM10-Regular.otf', 'fonts/NewCM10-Italic.otf', 'fonts/NewCM10-Bold.otf', 'fonts/NewCM10-BoldItalic.otf'],
    // Chrome rejects the CFF in NewCM10-Regular.otf. The math font's upright Latin letters are the same design.
    face: 'fonts/NewCMMath-Regular.otf',
  },
  modern: {
    id: 'modern',
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
    face: 'fonts/IBMPlexSans-Regular.otf',
  },
};

export function preludeFor({ paper, margins, theme }: PageSettings): string {
  return `${base}\n#set page(paper: "${paper}", margin: ${MARGIN_MM[margins]}mm)\n${THEMES[theme].source}`;
}
