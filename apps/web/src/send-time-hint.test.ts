import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { SendTimeHint, TimelineTurn, UserMessageTime } from './SendTimeHint';
import { formatSendTime } from './send-time';

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

  it('is absolutely positioned with breathing room and a left-aligned text edge', () => {
    const html = renderToStaticMarkup(createElement(SendTimeHint, { timestamp }));
    expect(html).toContain('ui-send-time');
    expect(html).toContain('absolute');
    expect(html).toContain('-bottom-7');
    expect(html).toContain('py-0.5');
    expect(html).toContain('left-0');
    expect(html).toContain(`dateTime="${timestamp}"`);
    expect(html).toContain('tabindex="-1"');
    expect(html).toContain(`>发送 ${formatSendTime(timestamp)}</time>`);
  });

  it('aligns the user bubble hint to the right edge', () => {
    expect(renderToStaticMarkup(createElement(SendTimeHint, { timestamp, align: 'right' }))).toContain('right-0');
    expect(renderToStaticMarkup(createElement(SendTimeHint, { timestamp }))).toContain('left-0');
  });

  it('labels a finished turn separately from the send time', () => {
    const html = renderToStaticMarkup(createElement(SendTimeHint, { timestamp, kind: '完成' }));
    expect(html).toContain(`>完成 ${formatSendTime(timestamp)}</time>`);
    expect(html).toContain('title="完成于 2026-11-12 21:50:00"');
  });

  it('renders nothing without a usable timestamp', () => {
    expect(renderToStaticMarkup(createElement(SendTimeHint, { timestamp: '' }))).toBe('');
    expect(renderToStaticMarkup(createElement(SendTimeHint, { timestamp: 'nope' }))).toBe('');
  });

  it('puts the keyboard stop and accessible time on the finished turn, not the badge', () => {
    const html = renderToStaticMarkup(createElement(TimelineTurn, {
      turnId: 'turn-1',
      time: { timestamp, kind: '完成' },
      children: createElement('p', null, '答案')
    }));
    expect(html.match(/<time/g)).toHaveLength(1);
    expect(html).toContain('data-timeline-turn="turn-1"');
    expect(html).toContain('tabindex="0"');
    expect(html).toContain('role="group"');
    expect(html).toContain('mb-10');
    expect(html).toContain('aria-label="完成于 2026-11-12 21:50:00"');
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

describe('UserMessageTime', () => {
  it('carries a date qualifier for the bubble time, leaving visibility to the message row CSS', () => {
    const recent = new Date();
    recent.setHours(12, 0, 0, 0);
    const timestamp = recent.toISOString();
    const html = renderToStaticMarkup(createElement(UserMessageTime, { timestamp }));
    expect(html).toContain('ui-user-send-time');
    expect(html).not.toContain('ui-send-time');
    // 绝对定位在消息行上，时间本身仍是普通行内文本。
    expect(html).not.toContain('absolute');
    expect(html).toContain('发送 今天 12:00');
    expect(html).toContain(`dateTime="${timestamp}"`);
  });

  it('renders nothing without a usable timestamp', () => {
    expect(renderToStaticMarkup(createElement(UserMessageTime, { timestamp: '' }))).toBe('');
    expect(renderToStaticMarkup(createElement(UserMessageTime, { timestamp: 'nope' }))).toBe('');
  });
});
