import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { commonmarkLanguage, markdown } from '@codemirror/lang-markdown';
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language';
import { StateEffect, StateField } from '@codemirror/state';
import { Decoration, type DecorationSet, EditorView, keymap } from '@codemirror/view';
import { tags } from '@lezer/highlight';
import { markdownExtensions } from './markdown/parser';

const highlight = HighlightStyle.define([
  { tag: tags.heading, fontWeight: '650' },
  { tag: tags.heading1, fontSize: '1.15em' },
  { tag: tags.emphasis, fontStyle: 'italic' },
  { tag: tags.strong, fontWeight: '650' },
  { tag: tags.strikethrough, textDecoration: 'line-through' },
  { tag: [tags.link, tags.url], color: 'var(--link)' },
  { tag: tags.monospace, color: 'var(--code)' },
  { tag: [tags.processingInstruction, tags.contentSeparator, tags.quote, tags.labelName], color: 'var(--muted)' },
]);

const theme = EditorView.theme({
  '&': { height: '100%', backgroundColor: 'var(--editor)', color: 'var(--ink)' },
  '&.cm-focused': { outline: 'none' },
  '.cm-scroller': { fontFamily: 'ui-monospace, "SF Mono", Menlo, Consolas, monospace', fontSize: '14px', lineHeight: '1.6' },
  '.cm-content': { padding: '24px 28px 40vh', maxWidth: '72ch', caretColor: 'var(--ink)' },
  '.cm-cursor': { borderLeftColor: 'var(--ink)', borderLeftWidth: '2px' },
  '&.cm-focused .cm-selectionBackground, .cm-selectionBackground': { backgroundColor: 'var(--selection)' },
});

/** The line a preview click landed on, marked for a moment. Alternating classes restart the fade on a repeat click. */
const markJump = StateEffect.define<{ pos: number; mark: Decoration } | null>();
const JUMP_MARKS = [Decoration.line({ class: 'lp-jumped-a' }), Decoration.line({ class: 'lp-jumped-b' })];
let jumps = 0;
let unmark = 0;

const jumpedLine = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(marks, tr) {
    marks = marks.map(tr.changes);
    for (const effect of tr.effects) {
      if (effect.is(markJump)) marks = effect.value ? Decoration.set(effect.value.mark.range(tr.state.doc.lineAt(effect.value.pos).from)) : Decoration.none;
    }
    return marks;
  },
  provide: (field) => EditorView.decorations.from(field),
});

/** Puts the cursor at `offset`, scrolls only if its line is out of sight, focuses the editor and marks the line. */
export function jumpTo(view: EditorView, offset: number): void {
  const pos = Math.min(Math.max(offset, 0), view.state.doc.length);
  const at = view.coordsAtPos(pos);
  const box = view.scrollDOM.getBoundingClientRect();
  const hidden = !at || at.top < box.top || at.bottom > box.bottom;
  const mark = markJump.of({ pos, mark: JUMP_MARKS[jumps++ % 2]! });
  view.dispatch({ selection: { anchor: pos }, effects: hidden ? [mark, EditorView.scrollIntoView(pos, { y: 'center' })] : [mark] });
  view.focus();
  clearTimeout(unmark);
  unmark = window.setTimeout(() => view.dispatch({ effects: markJump.of(null) }), 600);
}

export function createEditor(parent: HTMLElement, doc: string, onDocChange: (doc: string) => void): EditorView {
  return new EditorView({
    parent,
    doc,
    extensions: [
      history(),
      keymap.of([...defaultKeymap, ...historyKeymap, indentWithTab]),
      markdown({ base: commonmarkLanguage, extensions: markdownExtensions }),
      syntaxHighlighting(highlight),
      EditorView.lineWrapping,
      theme,
      jumpedLine,
      EditorView.updateListener.of((update) => {
        if (update.docChanged) onDocChange(update.state.doc.toString());
      }),
    ],
  });
}
