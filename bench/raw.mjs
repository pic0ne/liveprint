// Lets tsx import `file?raw` as Vite does, as the file's text, so Node scripts share the app's modules.
import { register } from 'node:module';

register(
  `data:text/javascript,${encodeURIComponent(`
    import { readFileSync } from 'node:fs';
    export async function load(url, context, next) {
      if (!url.startsWith('file:') || !url.endsWith('?raw')) return next(url, context);
      const text = readFileSync(new URL(url.slice(0, -'?raw'.length)), 'utf8');
      return { format: 'module', shortCircuit: true, source: 'export default ' + JSON.stringify(text) };
    }
  `)}`,
);
