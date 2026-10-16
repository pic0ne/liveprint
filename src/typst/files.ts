/** Fonts the worker loads at start-up, by path under public/. */
export const FONT_FILES = [
  'fonts/LibertinusSerif-Regular.otf',
  'fonts/LibertinusSerif-Bold.otf',
  'fonts/LibertinusSerif-Italic.otf',
  'fonts/LibertinusSerif-BoldItalic.otf',
  'fonts/NewCMMath-Regular.otf',
  'fonts/DejaVuSansMono.ttf',
  'fonts/DejaVuSansMono-Bold.ttf',
  'fonts/DejaVuSansMono-Oblique.ttf',
] as const;

/** Package tarballs keyed `name:version`, by path under public/. */
export const PACKAGE_FILES: Record<string, string> = {
  'mitex:0.2.6': 'packages/mitex-0.2.6.tar.gz',
};
