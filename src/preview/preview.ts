import { patchRoot } from '@myriaddreamin/typst.ts/render/svg/patch';
import { createTypstRenderer, type RenderSession, type TypstRenderer } from '@myriaddreamin/typst.ts/renderer';
import rendererWasm from '@myriaddreamin/typst-ts-renderer/wasm?url';

const SVG_NS = 'http://www.w3.org/2000/svg';
const PAGE_GAP_PT = 14;

/** typst.ts stacks pages edge to edge with no fill. Space them out and give each a sheet to sit on. */
function separatePages(svg: SVGSVGElement): void {
  let y = 0;
  for (const page of svg.querySelectorAll<SVGGElement>(':scope > g.typst-page')) {
    const width = page.dataset.pageWidth ?? '0';
    const height = Number(page.dataset.pageHeight ?? 0);
    page.setAttribute('transform', `translate(0, ${y})`);
    if (!page.firstElementChild?.classList.contains('page-sheet')) {
      const sheet = document.createElementNS(SVG_NS, 'rect');
      sheet.setAttribute('class', 'page-sheet');
      sheet.setAttribute('width', width);
      sheet.setAttribute('height', String(height));
      page.prepend(sheet);
    }
    y += height + PAGE_GAP_PT;
  }
  const total = Math.max(0, y - PAGE_GAP_PT);
  svg.setAttribute('viewBox', `0 0 ${svg.dataset.width ?? 0} ${total}`);
  svg.setAttribute('height', String(total));
}

/** runWithSession frees the session when its callback settles, so this callback never does. */
const openSession = (renderer: TypstRenderer) =>
  new Promise<RenderSession>((resolve) => {
    void renderer.runWithSession((session) => {
      resolve(session);
      return new Promise<never>(() => {});
    });
  });

/**
 * Owns the renderer and its session. Each delta is merged, then the SVG in `container` is patched in place.
 * renderToSvg is not used: in 0.7.0 it replaces innerHTML, skips re-rendering at an unchanged width, and
 * panics without a global `typstProcessSvg`. renderSvgDiff plus patchRoot is the path typst-preview takes:
 * the diff names unchanged groups by `data-tid` and patchRoot keeps those DOM nodes.
 */
export class Preview {
  readonly #renderer: TypstRenderer;
  readonly #session: RenderSession;
  readonly #container: HTMLElement;

  private constructor(renderer: TypstRenderer, session: RenderSession, container: HTMLElement) {
    this.#renderer = renderer;
    this.#session = session;
    this.#container = container;
  }

  static async create(container: HTMLElement): Promise<Preview> {
    const renderer = createTypstRenderer();
    await renderer.init({ getModule: () => rendererWasm });
    return new Preview(renderer, await openSession(renderer), container);
  }

  /** Synchronous: when this returns, the DOM holds the new pages. */
  apply(delta: Uint8Array): void {
    this.#renderer.manipulateData({ renderSession: this.#session, action: 'merge', data: delta });
    const svg = this.#renderer.renderSvgDiff({ renderSession: this.#session });
    const current = this.#container.firstElementChild;
    if (current instanceof SVGSVGElement) {
      const parsed = document.createElement('template');
      parsed.innerHTML = svg;
      patchRoot(current, parsed.content.firstElementChild as SVGSVGElement);
    } else {
      this.#container.innerHTML = svg;
    }
    separatePages(this.#container.firstElementChild as SVGSVGElement);
  }

  get pageCount(): number {
    return this.#session.retrievePagesInfo().length;
  }
}
