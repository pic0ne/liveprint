import type { ImagePath } from './images';

/** Where the document in the editor lives. */
export interface DocFile {
  /** Shown in the bar, e.g. "notes.md". "Untitled.md" until the first save. */
  name: string;
  /** Null when never saved, or opened/saved without the File System Access API. */
  handle: FileSystemFileHandle | null;
  /** The text as last opened or saved. Unsaved changes = editor text !== saved, so undoing back shows clean. */
  saved: string;
  /** The folder that holds the file, once the user chose it: images are read from and written to it. Chromium only. */
  folder: FileSystemDirectoryHandle | null;
  /** Images the user has beside the file: read from its folder or a drop, written there, or downloaded with it. */
  savedImages: ReadonlySet<ImagePath>;
}

/** A document and where it lives, as opened, dropped or restored. */
export interface Doc {
  text: string;
  file: DocFile;
  /** Every image the document can show, by the path its Markdown writes. */
  images: ReadonlyMap<ImagePath, Blob>;
}

export const untitled = (text: string): Doc => ({
  text,
  file: { name: 'Untitled.md', handle: null, saved: text, folder: null, savedImages: new Set() },
  images: new Map(),
});

export const isEdited = (text: string, file: DocFile) => text !== file.saved;

/** Referenced images the preview has no bytes for, and ones not yet saved beside a file whose folder liveprint cannot write. */
export interface ImageNotice {
  missing: number;
  unsaved: number;
}

/**
 * What the bar says about the images `referenced` by the Markdown. "Unsaved" counts only for a file saved with the
 * File System Access API whose folder liveprint cannot write; an untitled or downloaded document shows Edited instead.
 */
export function imageNotice(referenced: readonly ImagePath[], images: ReadonlyMap<ImagePath, Blob>, file: DocFile): ImageNotice {
  const shown = referenced.filter((path) => images.has(path));
  return {
    missing: referenced.length - shown.length,
    unsaved: file.handle && !file.folder ? shown.filter((path) => !file.savedImages.has(path)).length : 0,
  };
}

const images = (n: number) => `${n} ${n === 1 ? 'image' : 'images'}`;

/** "2 images not found", "1 image not saved beside notes.md", both joined, or '' when there is nothing to say. */
export function noticeText({ missing, unsaved }: ImageNotice, name: string): string {
  const parts = [missing && `${images(missing)} not found`, unsaved && `${missing ? unsaved : images(unsaved)} not saved beside ${name}`];
  return parts.filter(Boolean).join(', ');
}

export const documentTitle = (name: string, edited: boolean) => `${edited ? '• ' : ''}${name} · liveprint`;

/** The PDF of `notes.md` is `notes.pdf`. */
export const pdfName = (name: string) => `${name.replace(/\.(md|markdown|txt)$/i, '') || 'Untitled'}.pdf`;

const TEXT_TYPES = new Set(['text/markdown', 'text/x-markdown', 'text/plain']);

/** Whether a file is one liveprint opens: Markdown or plain text, by its extension or, when it has none of those, its type. */
export function isMarkdown(file: { name: string; type: string }): boolean {
  return /\.(md|markdown|txt)$/i.test(file.name) || TEXT_TYPES.has(file.type);
}
