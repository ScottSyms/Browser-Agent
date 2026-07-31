import { describe, expect, it } from 'vitest';
import { emailFileName, emailMarkdown, parseDraggedEmail, stripHtml } from './emailDrop';

describe('stripHtml', () => {
  it('drops tags and converts block ends to newlines', () => {
    expect(stripHtml('<p>Hello</p><p>World</p>')).toBe('Hello\nWorld');
    expect(stripHtml('a<br>b')).toBe('a\nb');
  });

  it('removes script/style blocks entirely', () => {
    expect(stripHtml('<style>.x{color:red}</style>Body<script>evil()</script>')).toBe('Body');
  });

  it('decodes common entities', () => {
    expect(stripHtml('Tom&nbsp;&amp;&nbsp;Jerry &lt;3')).toBe('Tom & Jerry <3');
  });

  it('collapses excess blank lines', () => {
    expect(stripHtml('<div>a</div><div></div><div></div><div>b</div>')).toBe('a\n\nb');
  });
});

describe('parseDraggedEmail', () => {
  it('extracts a From/Sent/Subject header block from the HTML body', () => {
    const html =
      '<div>From: Alice &lt;alice@example.com&gt;<br>Sent: Monday, July 6, 2026 9:00 AM<br>' +
      'To: Bob<br>Subject: Q3 planning<br><br>Let us meet Thursday.</div>';
    const p = parseDraggedEmail(html, '');
    expect(p.from).toBe('Alice <alice@example.com>');
    expect(p.date).toBe('Monday, July 6, 2026 9:00 AM');
    expect(p.subject).toBe('Q3 planning');
    expect(p.body).toContain('Let us meet Thursday.');
  });

  it('uses a short single-line text/plain as the subject when no header is present', () => {
    const p = parseDraggedEmail('<div>Full message body goes here.</div>', 'Weekly status');
    expect(p.subject).toBe('Weekly status');
    expect(p.body).toBe('Full message body goes here.');
  });

  it('falls back to text/plain for the body when there is no HTML', () => {
    const p = parseDraggedEmail('', 'just a plain note');
    expect(p.body).toBe('just a plain note');
  });

  it('builds a truncated one-line snippet', () => {
    const long = 'x'.repeat(500);
    const p = parseDraggedEmail(`<div>${long}</div>`, '');
    expect(p.snippet.length).toBeLessThanOrEqual(201);
    expect(p.snippet.endsWith('…')).toBe(true);
  });

  it('does not treat a long text/plain as a subject', () => {
    const p = parseDraggedEmail('<div>body</div>', 'x'.repeat(250));
    expect(p.subject).toBeUndefined();
  });
});

describe('emailFileName', () => {
  it('derives a safe .md name from the subject', () => {
    expect(emailFileName({ subject: 'Re: Q3 / plan?', body: '', snippet: '' })).toBe('Re Q3 plan.md');
  });

  it('falls back to email.md when there is no subject', () => {
    expect(emailFileName({ body: '', snippet: '' })).toBe('email.md');
  });

  it('truncates a very long subject', () => {
    const name = emailFileName({ subject: 'A'.repeat(200), body: '', snippet: '' });
    expect(name.length).toBeLessThanOrEqual(63); // 60 + ".md"
  });
});

describe('emailMarkdown', () => {
  it('includes subject, from/date, and body', () => {
    const md = emailMarkdown({ subject: 'Hi', from: 'Alice', date: 'today', body: 'the body', snippet: '' });
    expect(md).toContain('# Hi');
    expect(md).toContain('**From:** Alice');
    expect(md).toContain('**Date:** today');
    expect(md).toContain('the body');
  });

  it('omits missing meta lines', () => {
    const md = emailMarkdown({ body: 'b', snippet: '' });
    expect(md).toContain('# Email');
    expect(md).not.toContain('**From:**');
  });
});
