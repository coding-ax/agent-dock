import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { SendTimeHint, TimelineTurn } from './SendTimeHint';

// 组件内部用 new Date() 判断「是不是今天」。夹具和冻结时钟都用本机时区构造，
// 这样无论跑在哪一天、哪个时区，21:50 都落在同一天，断言不会随日历翻篇。
const now = new Date(2026, 10, 12, 22, 5);
const timestamp = new Date(2026, 10, 12, 21, 50).toISOString();

describe('SendTimeHint', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(now);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('is absolutely positioned and carries the stored timestamp without taking its own tab stop', () => {
    const html = renderToStaticMarkup(createElement(SendTimeHint, { timestamp }));
    expect(html).toContain('ui-send-time');
    expect(html).toContain('absolute');
    expect(html).toContain('-bottom-3');
    expect(html).toContain(`dateTime="${timestamp}"`);
    expect(html).toContain('tabindex="-1"');
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

  it('puts the keyboard stop and accessible time on the finished turn, not the badge', () => {
    const html = renderToStaticMarkup(createElement(TimelineTurn, {
      turnId: 'turn-1',
      sendTime: { timestamp },
      children: createElement('p', null, '答案')
    }));
    expect(html.match(/<time/g)).toHaveLength(1);
    expect(html).toContain('data-timeline-turn="turn-1"');
    expect(html).toContain('tabindex="0"');
    expect(html).toContain('role="group"');
    expect(html).toContain('aria-label="发送于 2026-11-12 21:50:00"');
  });

  it('keeps an ongoing turn out of the tab order and renders no time', () => {
    const html = renderToStaticMarkup(createElement(TimelineTurn, {
      turnId: 'turn-running',
      children: createElement('p', null, '处理中')
    }));
    expect(html).not.toContain('ui-send-time');
    expect(html).not.toContain('tabindex');
  });
});
