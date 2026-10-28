import { describe, expect, it } from 'vitest';
import { previewKindForName } from './fs-paths.js';

describe('workspace preview types', () => {
  it('recognizes text, images and PDF artifacts', () => {
    expect(previewKindForName('notes.md')).toBe('text');
    expect(previewKindForName('screen.png')).toBe('image');
    expect(previewKindForName('report.PDF')).toBe('pdf');
    expect(previewKindForName('archive.zip')).toBe('unsupported');
  });
});
