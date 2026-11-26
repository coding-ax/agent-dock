import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { BrandLogo, BrandWordmark, KittenMark } from './BrandLogo';
import { handoverKittenAvatarSrc } from './HandoverDialog';

describe('BrandLogo', () => {
  it('renders KittenMark pointing to the new pixel kitten SVG', () => {
    const html = renderToStaticMarkup(createElement(KittenMark, { size: 32 }));
    expect(html).toContain('src="/brand/kitten-mark.svg"');
    expect(html).toContain('ui-pixelated');
    expect(html).toContain('width="32"');
    expect(html).toContain('height="32"');
  });

  it('renders BrandWordmark with light and dark SVG variants', () => {
    const html = renderToStaticMarkup(createElement(BrandWordmark, { height: 16 }));
    expect(html).toContain('src="/brand/wordmark-light.svg"');
    expect(html).toContain('src="/brand/wordmark-dark.svg"');
    expect(html).toContain('aria-label="AgentDock"');
  });

  it('renders BrandLogo with both KittenMark and BrandWordmark', () => {
    const html = renderToStaticMarkup(createElement(BrandLogo, { iconSize: 28, wordmarkHeight: 14 }));
    expect(html).toContain('/brand/kitten-mark.svg');
    expect(html).toContain('/brand/wordmark-light.svg');
    expect(html).toContain('/brand/wordmark-dark.svg');
  });
});

describe('handoverKittenAvatarSrc', () => {
  it('appends a cache-busting query param for the built-in kitten avatar endpoint', () => {
    expect(handoverKittenAvatarSrc('/api/lark/kitten-avatar.png')).toBe('/api/lark/kitten-avatar.png?v=2');
  });

  it('preserves custom or already-versioned avatar URLs unchanged', () => {
    expect(handoverKittenAvatarSrc('/api/lark/kitten-avatar.png?v=custom')).toBe('/api/lark/kitten-avatar.png?v=custom');
    expect(handoverKittenAvatarSrc('https://cdn.example.com/cat.png')).toBe('https://cdn.example.com/cat.png');
  });
});
