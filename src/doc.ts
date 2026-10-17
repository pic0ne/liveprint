/** Where the document in the editor lives. */
export interface DocFile {
  /** Shown in the bar, e.g. "notes.md". "Untitled.md" until the first save. */
  name: string;
  /** Null when never saved, or opened/saved without the File System Access API. */
  handle: FileSystemFileHandle | null;
  /** The text as last opened or saved. Unsaved changes = editor text !== saved, so undoing back shows clean. */
  saved: string;
}

/** A document and where it lives, as opened, dropped or restored. */
export interface Doc {
  text: string;
  file: DocFile;
}

export const untitled = (text: string): Doc => ({ text, file: { name: 'Untitled.md', handle: null, saved: text } });

export const isEdited = (text: string, file: DocFile) => text !== file.saved;

export const documentTitle = (name: string, edited: boolean) => `${edited ? '• ' : ''}${name} · liveprint`;

/** The PDF of `notes.md` is `notes.pdf`. */
export const pdfName = (name: string) => `${name.replace(/\.(md|markdown|txt)$/i, '') || 'Untitled'}.pdf`;

const TEXT_TYPES = new Set(['text/markdown', 'text/x-markdown', 'text/plain']);

/** Whether a file is one liveprint opens: Markdown or plain text, by its extension or, when it has none of those, its type. */
export function isMarkdown(file: { name: string; type: string }): boolean {
  return /\.(md|markdown|txt)$/i.test(file.name) || TEXT_TYPES.has(file.type);
}
