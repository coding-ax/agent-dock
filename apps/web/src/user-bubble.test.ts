import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { TimelineItem } from './TimelineItems';
import { TooltipProvider } from './HoverTooltip';
import type { TimelineEvent } from './timeline';
import { formatUserMessageTime } from './send-time';

const userText = (optimistic: boolean): TimelineEvent => ({
  id: 'u1', sequence: 1, type: 'text', timestamp: '2026-01-01T00:00:00.000Z',
  data: { role: 'user', text: '检查项目', ...(optimistic ? { optimistic: true } : {}) }
} as TimelineEvent);
const render = (event: TimelineEvent) => renderToStaticMarkup(createElement(TooltipProvider, null, createElement(TimelineItem, { event, sessionId: 's1' })));

describe('user bubble sending state', () => {
  it('spins beside the bubble instead of adding a text row inside it', () => {
    const html = render(userText(true));
    expect(html).toContain('aria-label="发送中"');
    expect(html).not.toContain('发送中…');
    // 绝对定位在气泡左外侧：不参与布局，气泡尺寸和发送完成后一致。
    expect(html).toMatch(/aria-label="发送中" class="[^"]*\babsolute\b[^"]*\bright-full\b/);
  });

  it('drops the spinner once the message is confirmed', () => {
    expect(render(userText(false))).not.toContain('发送中');
  });

  it('shows the stored send time visibly under the bubble, not only on hover', () => {
    const html = render(userText(false));
    expect(html).toContain('ui-user-send-time');
    expect(html).toContain(`发送 ${formatUserMessageTime(userText(false).timestamp)}`);
    // 气泡时间不能复用轮末的 hover 角标，否则触摸屏上仍然看不到。
    expect(html).not.toContain('ui-send-time"');
  });

  it('lets long links wrap instead of overflowing the bubble', () => {
    // 用户气泡没有挂 .markdown 类，长 URL 默认会顶破 80% 宽的圆角边界。
    const css = readFileSync(new URL('./index.css', import.meta.url), 'utf8');
    expect(css).toMatch(/\.ui-user-bubble[^{]*\{[^}]*overflow-wrap:\s*anywhere/);
    expect(render(userText(false))).toContain('ui-user-bubble');
  });
});
