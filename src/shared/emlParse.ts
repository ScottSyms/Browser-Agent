// Parse a `.eml` (RFC-822 / MIME) message into the same ParsedEmail shape the
// drag/paste path uses. `.eml` is the stable, portable way to get a message out
// of Outlook or Apple Mail on macOS (drag it to the Finder, or Save As), so we
// parse it directly rather than depending on the app's flaky drag/clipboard.
//
// Best-effort and pure: handles the common real-world cases (single-part text,
// multipart/alternative + /mixed, base64 / quoted-printable transfer encodings,
// UTF-8 encoded-word headers) and degrades to raw text otherwise.

import { type ParsedEmail, stripHtml } from './emailDrop';

function makeSnippet(body: string): string {
  const collapsed = body.replace(/\s+/g, ' ').trim();
  return collapsed.length > 200 ? `${collapsed.slice(0, 200).trimEnd()}…` : collapsed;
}

/** Split a raw message into its header block and body at the first blank line. */
function splitHeaders(raw: string): { headers: Record<string, string>; body: string } {
  const norm = raw.replace(/\r\n/g, '\n');
  const sep = norm.indexOf('\n\n');
  const headerBlock = sep >= 0 ? norm.slice(0, sep) : norm;
  const body = sep >= 0 ? norm.slice(sep + 2) : '';
  // Unfold continuation lines (a header value wrapped onto lines starting with WS).
  const unfolded = headerBlock.replace(/\n[ \t]+/g, ' ');
  const headers: Record<string, string> = {};
  for (const line of unfolded.split('\n')) {
    const m = line.match(/^([A-Za-z0-9-]+):\s*(.*)$/);
    if (m && !(m[1].toLowerCase() in headers)) headers[m[1].toLowerCase()] = m[2].trim();
  }
  return { headers, body };
}

function b64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64.replace(/\s+/g, ''));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function decodeQuotedPrintable(input: string, forHeader = false): Uint8Array {
  let s = input;
  if (!forHeader) s = s.replace(/=\r?\n/g, ''); // soft line breaks
  if (forHeader) s = s.replace(/_/g, ' '); // RFC 2047 Q-encoding uses _ for space
  const bytes: number[] = [];
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '=' && i + 2 < s.length && /[0-9A-Fa-f]{2}/.test(s.slice(i + 1, i + 3))) {
      bytes.push(parseInt(s.slice(i + 1, i + 3), 16));
      i += 2;
    } else {
      bytes.push(s.charCodeAt(i) & 0xff);
    }
  }
  return new Uint8Array(bytes);
}

function decodeBytes(bytes: Uint8Array, charset = 'utf-8'): string {
  try {
    return new TextDecoder(charset).decode(bytes);
  } catch {
    return new TextDecoder('utf-8').decode(bytes);
  }
}

/** Decode RFC-2047 encoded-words (=?charset?B|Q?text?=) in a header value. */
function decodeEncodedWords(value: string): string {
  return value.replace(/=\?([^?]+)\?([BbQq])\?([^?]*)\?=/g, (_, charset: string, enc: string, text: string) => {
    const bytes = enc.toUpperCase() === 'B' ? b64ToBytes(text) : decodeQuotedPrintable(text, true);
    return decodeBytes(bytes, charset.toLowerCase());
  });
}

function param(contentType: string, name: string): string | undefined {
  const m = contentType.match(new RegExp(`${name}\\s*=\\s*"?([^";]+)"?`, 'i'));
  return m?.[1];
}

/** Decode a single MIME part's body to text, given its headers. */
function decodePart(headers: Record<string, string>, body: string): { mime: string; text: string } {
  const contentType = headers['content-type'] ?? 'text/plain';
  const mime = contentType.split(';')[0].trim().toLowerCase();
  const cte = (headers['content-transfer-encoding'] ?? '').toLowerCase();
  const charset = param(contentType, 'charset') ?? 'utf-8';
  let text: string;
  if (cte === 'base64') text = decodeBytes(b64ToBytes(body), charset);
  else if (cte === 'quoted-printable') text = decodeBytes(decodeQuotedPrintable(body), charset);
  else text = body;
  return { mime, text };
}

/** Recursively resolve a message/part body to readable text, preferring plain then HTML. */
function resolveBody(headers: Record<string, string>, body: string): string {
  const contentType = headers['content-type'] ?? 'text/plain';
  const mime = contentType.split(';')[0].trim().toLowerCase();

  if (mime.startsWith('multipart/')) {
    const boundary = param(contentType, 'boundary');
    if (!boundary) return stripHtml(body);
    const marker = `--${boundary}`;
    const segments = body
      .split(marker)
      .slice(1) // text before the first boundary is the preamble
      .filter((s) => !s.startsWith('--')) // the closing "--boundary--"
      .map((s) => s.replace(/^\r?\n/, ''));
    const parts = segments.map((seg) => {
      const { headers: ph, body: pb } = splitHeaders(seg);
      return { headers: ph, body: pb };
    });
    const findByMime = (want: string) =>
      parts.find((p) => (p.headers['content-type'] ?? 'text/plain').toLowerCase().startsWith(want));
    // Prefer readable text; recurse into nested multiparts.
    const plain = findByMime('text/plain');
    if (plain) return decodePart(plain.headers, plain.body).text.trim();
    const htmlPart = findByMime('text/html');
    if (htmlPart) return stripHtml(decodePart(htmlPart.headers, htmlPart.body).text);
    const nested = parts.find((p) => (p.headers['content-type'] ?? '').toLowerCase().startsWith('multipart/'));
    if (nested) return resolveBody(nested.headers, nested.body);
    return parts.length ? decodePart(parts[0].headers, parts[0].body).text.trim() : '';
  }

  const { mime: partMime, text } = decodePart(headers, body);
  return partMime === 'text/html' ? stripHtml(text) : text.trim();
}

/** Parse a raw `.eml` message into structured email fields. */
export function parseEml(raw: string): ParsedEmail {
  const { headers, body } = splitHeaders(raw);
  const subject = headers['subject'] ? decodeEncodedWords(headers['subject']) : undefined;
  const from = headers['from'] ? decodeEncodedWords(headers['from']) : undefined;
  const date = headers['date'] || undefined;
  const text = resolveBody(headers, body).trim();
  return { subject, from, date, body: text, snippet: makeSnippet(text) };
}
