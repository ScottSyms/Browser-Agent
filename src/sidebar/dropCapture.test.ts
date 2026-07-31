import { describe, expect, it } from 'vitest';
import { describeTypes, dragHasContent } from './dropCapture';

describe('dragHasContent', () => {
  it('is true for files, HTML, or plain-text drags', () => {
    expect(dragHasContent(['Files'])).toBe(true);
    expect(dragHasContent(['text/html'])).toBe(true);
    expect(dragHasContent(['text/plain'])).toBe(true); // some Outlook builds expose only this
  });
  it('is false for an unrelated or empty drag', () => {
    expect(dragHasContent(['application/x-moz-place'])).toBe(false);
    expect(dragHasContent([])).toBe(false);
    expect(dragHasContent(undefined)).toBe(false);
  });
});

describe('describeTypes', () => {
  it('lists the offered MIME types', () => {
    const dt = { types: ['text/plain', 'text/html'], files: [] } as unknown as DataTransfer;
    expect(describeTypes(dt)).toBe('text/plain, text/html');
  });
  it('appends dropped file names', () => {
    const dt = { types: ['Files'], files: [{ name: 'note.eml', type: '' }] } as unknown as DataTransfer;
    expect(describeTypes(dt)).toBe('Files, files: note.eml');
  });
  it('is empty for a null transfer', () => {
    expect(describeTypes(null)).toBe('');
  });
});
