import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { commonmarkLanguage, markdown } from '@codemirror/lang-markdown';
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language';
import { EditorView, keymap } from '@codemirror/view';
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
      EditorView.updateListener.of((update) => {
        if (update.docChanged) onDocChange(update.state.doc.toString());
      }),
    ],
  });
}
