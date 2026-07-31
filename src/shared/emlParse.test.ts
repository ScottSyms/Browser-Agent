import { describe, expect, it } from 'vitest';
import { parseEml } from './emlParse';

describe('parseEml', () => {
  it('parses a simple text/plain message', () => {
    const eml = [
      'From: Alice <alice@example.com>',
      'To: Bob <bob@example.com>',
      'Subject: Lunch',
      'Date: Mon, 6 Jul 2026 09:00:00 -0400',
      'Content-Type: text/plain; charset=utf-8',
      '',
      "Let's meet at noon.",
    ].join('\n');
    const p = parseEml(eml);
    expect(p.from).toBe('Alice <alice@example.com>');
    expect(p.subject).toBe('Lunch');
    expect(p.date).toBe('Mon, 6 Jul 2026 09:00:00 -0400');
    expect(p.body).toBe("Let's meet at noon.");
  });

  it('strips HTML from a text/html message', () => {
    const eml = ['Subject: HTML note', 'Content-Type: text/html; charset=utf-8', '', '<p>Hello <b>world</b></p>'].join('\n');
    expect(parseEml(eml).body).toBe('Hello world');
  });

  it('prefers the text/plain alternative in a multipart message', () => {
    const eml = [
      'Subject: Multi',
      'Content-Type: multipart/alternative; boundary="B"',
      '',
      '--B',
      'Content-Type: text/plain; charset=utf-8',
      '',
      'Plain version.',
      '--B',
      'Content-Type: text/html; charset=utf-8',
      '',
      '<p>HTML version.</p>',
      '--B--',
    ].join('\n');
    expect(parseEml(eml).body).toBe('Plain version.');
  });

  it('decodes base64 bodies', () => {
    const eml = [
      'Subject: B64',
      'Content-Type: text/plain; charset=utf-8',
      'Content-Transfer-Encoding: base64',
      '',
      'SGVsbG8gYmFzZTY0', // "Hello base64"
    ].join('\n');
    expect(parseEml(eml).body).toBe('Hello base64');
  });

  it('decodes quoted-printable bodies with soft line breaks', () => {
    const eml = [
      'Subject: QP',
      'Content-Type: text/plain; charset=utf-8',
      'Content-Transfer-Encoding: quoted-printable',
      '',
      'Caf=C3=A9 time=',
      ' now',
    ].join('\n');
    expect(parseEml(eml).body).toBe('Café time now');
  });

  it('decodes RFC-2047 encoded-word subjects (Base64 and Q)', () => {
    const b = parseEml(['Subject: =?UTF-8?B?SGVsbG8gd29ybGQ=?=', 'Content-Type: text/plain', '', 'x'].join('\n'));
    expect(b.subject).toBe('Hello world');
    const q = parseEml(['Subject: =?UTF-8?Q?Caf=C3=A9?=', 'Content-Type: text/plain', '', 'x'].join('\n'));
    expect(q.subject).toBe('Café');
  });

  it('unfolds a header wrapped across lines', () => {
    const eml = ['Subject: a very long', '  subject line', 'Content-Type: text/plain', '', 'body'].join('\n');
    expect(parseEml(eml).subject).toBe('a very long subject line');
  });
});
