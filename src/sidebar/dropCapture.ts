// Turn a drop's DataTransfer into a queue of items for the knowledge-base
// uploader. Two paths:
//   1. Real files (documents/PDFs) — the normal case.
//   2. A dragged *email* with no usable file — read its text/html + text/plain
//      and synthesise a Markdown file (see shared/emailDrop.ts). This is what
//      makes dragging a message out of desktop Outlook work, since Outlook
//      usually exposes only text, not a readable .msg file.
//
// The DataTransfer is only valid *during* the drop event, so every read here is
// synchronous — no awaits between the event and the last `getData`.

import { classifyUpload } from '../shared/uploadFile';
import { emailFileName, emailMarkdown, looksLikeEmail, parseDraggedEmail } from '../shared/emailDrop';

/** Parsed email fields shown on the "confirm what you caught" preview card. */
export interface EmailPreview {
  subject?: string;
  from?: string;
  date?: string;
  snippet: string;
}

/** One queued upload: a file, plus email metadata when it came from a drag. */
export interface DroppedItem {
  file: File;
  email?: EmailPreview;
}

/** Whether a drag carries something we can add (files, or dragged email text). */
export function dragHasContent(types: readonly string[] | undefined): boolean {
  if (!types) return false;
  // text/plain included so an email dragged from an app that exposes only plain
  // text (some Outlook builds) still lights up the overlay; the internal-drag
  // guard keeps in-panel text drags from triggering it.
  return types.includes('Files') || types.includes('text/html') || types.includes('text/plain');
}

/** Human-readable list of what a drop/paste offered — for a "couldn't read it" diagnostic. */
export function describeTypes(dt: DataTransfer | null): string {
  if (!dt) return '';
  const parts = Array.from(dt.types ?? []);
  const files = Array.from(dt.files ?? []);
  if (files.length) parts.push(`files: ${files.map((f) => f.name || f.type || '?').join(', ')}`);
  return parts.join(', ');
}

function safeGetData(dt: DataTransfer, type: string): string {
  try {
    return dt.getData(type) ?? '';
  } catch {
    return '';
  }
}

/**
 * Extract droppable items from a DataTransfer. Prefers real supported files;
 * if none, falls back to capturing a dragged email as a synthetic Markdown file.
 * Returns [] when there's nothing we can ingest.
 */
export function captureDrop(dt: DataTransfer | null): DroppedItem[] {
  if (!dt) return [];

  const realFiles = Array.from(dt.files ?? []).filter((f) => classifyUpload(f.name, f.type));
  if (realFiles.length > 0) return realFiles.map((file) => ({ file }));

  // No supported file — try the email/text payloads (e.g. a drag from Outlook).
  const html = safeGetData(dt, 'text/html');
  const plain = safeGetData(dt, 'text/plain');
  if (!html && !plain) return [];

  const parsed = parseDraggedEmail(html, plain);
  if (!parsed.body.trim()) return [];

  const file = new File([emailMarkdown(parsed)], emailFileName(parsed), { type: 'text/markdown' });
  return [
    { file, email: { subject: parsed.subject, from: parsed.from, date: parsed.date, snippet: parsed.snippet } },
  ];
}

/** Wrap plain picked files (from a file input) as DroppedItems, dropping unsupported ones. */
export function itemsFromFiles(files: File[]): DroppedItem[] {
  return files.filter((f) => classifyUpload(f.name, f.type)).map((file) => ({ file }));
}

/**
 * True when a paste's clipboard clearly holds an *email* (has HTML with a
 * From/Date header). Used so pasting a copied Outlook message into the composer
 * is recognised as "add this email", while ordinary rich-text pastes are left
 * to insert normally. (A `ClipboardEvent.clipboardData` is a DataTransfer.)
 */
export function clipboardIsEmail(cd: DataTransfer | null): boolean {
  if (!cd || !Array.from(cd.types).includes('text/html')) return false;
  return looksLikeEmail(safeGetData(cd, 'text/html'), safeGetData(cd, 'text/plain'));
}
