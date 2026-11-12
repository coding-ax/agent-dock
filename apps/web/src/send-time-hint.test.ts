import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { SendTimeHint } from './SendTimeHint';

const timestamp = new Date(2026, 10, 12, 21, 50).toISOString();

describe('SendTimeHint', () => {
  it('is absolutely positioned, focusable, and carries the stored timestamp', () => {
    const html = renderToStaticMarkup(createElement(SendTimeHint, { timestamp }));
    expect(html).toContain('ui-send-time');
    expect(html).toContain('absolute');
    expect(html).toContain('-bottom-3');
    expect(html).toContain(`dateTime="${timestamp}"`);
    expect(html).toContain('tabindex="0"');
    expect(html).toContain('>21:50</time>');
  });

  it('aligns the user bubble hint to the right edge', () => {
    expect(renderToStaticMarkup(createElement(SendTimeHint, { timestamp, align: 'right' }))).toContain('right-1');
    expect(renderToStaticMarkup(createElement(SendTimeHint, { timestamp }))).toContain('left-1');
  });

  it('renders nothing without a usable timestamp', () => {
    expect(renderToStaticMarkup(createElement(SendTimeHint, { timestamp: '' }))).toBe('');
    expect(renderToStaticMarkup(createElement(SendTimeHint, { timestamp: 'nope' }))).toBe('');
  });
});
