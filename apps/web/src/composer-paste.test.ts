import { describe, expect, it } from 'vitest';
import { linkFromPastedHtml, linkedPasteToken, needsPasteSeparator, pastedLink } from './composer-paste';

describe('pastedLink', () => {
  it('recognizes a bare URL copied as plain text', () => {
    expect(pastedLink('https://bits.bytedance.net/devops/a?x=1')).toEqual({
      url: 'https://bits.bytedance.net/devops/a?x=1', label: 'https://bits.bytedance.net/devops/a?x=1'
    });
  });

  it('uses the anchor text when an <a> was copied with a matching href', () => {
    const html = '<meta charset="utf-8"><a href="https://example.com/a?b=1">TOM Bridge 文档</a>';
    expect(pastedLink('https://example.com/a?b=1', html)).toEqual({ url: 'https://example.com/a?b=1', label: 'TOM Bridge 文档' });
    expect(linkFromPastedHtml(html)?.label).toBe('TOM Bridge 文档');
  });

  it('ignores html that is more than a single link (formatted paragraphs)', () => {
    expect(linkFromPastedHtml('<p>看这个 <a href="https://a.com">文档</a> 然后继续</p>')).toBeUndefined();
    expect(pastedLink('  \n', '<p>看这个 <a href="https://a.com">文档</a></p>')).toBeUndefined();
  });

  it('does not hijack ordinary multi-line text or file paths', () => {
    expect(pastedLink('第一行\n第二行')).toBeUndefined();
    expect(pastedLink('/Users/me/repo/App.tsx')).toBeUndefined();
    expect(pastedLink('')).toBeUndefined();
  });
});

describe('linkedPasteToken / needsPasteSeparator', () => {
  it('renders a labeled link and a bare URL differently', () => {
    expect(linkedPasteToken({ url: 'https://example.com/a', label: 'TOM Bridge 文档' })).toBe('[TOM Bridge 文档](https://example.com/a)');
    expect(linkedPasteToken({ url: 'https://a.com/x', label: 'https://a.com/x' })).toBe('<https://a.com/x>');
    expect(linkedPasteToken({ url: 'https://a.com', label: '[a](b)' })).toBe('[ab](https://a.com)');
  });

  it('separates the link from preceding text, but not from whitespace', () => {
    expect(needsPasteSeparator('请先看')).toBe(true);
    expect(needsPasteSeparator('请先看 ')).toBe(false);
    expect(needsPasteSeparator('')).toBe(false);
    expect(needsPasteSeparator('前一行\n')).toBe(false);
  });
});
