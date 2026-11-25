import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { SystemPromptBubble, TimelineItem } from './TimelineItems';
import { Disclosure } from './Disclosure';
import { TooltipProvider } from './HoverTooltip';
import { EMOJI_TRIGGER_ORIGIN, type TimelineEvent } from './timeline';
import { formatUserMessageTime } from './send-time';

const userText = (optimistic: boolean): TimelineEvent => ({
  id: 'u1', sequence: 1, type: 'text', timestamp: '2026-01-01T00:00:00.000Z',
  data: { role: 'user', text: '检查项目', ...(optimistic ? { optimistic: true } : {}) }
} as TimelineEvent);
const render = (event: TimelineEvent, sentPrompt?: string) => renderToStaticMarkup(createElement(TooltipProvider, null, createElement(TimelineItem, { event, sessionId: 's1', sentPrompt })));

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

  it('keeps the send time under the bubble for hover reveal, with touch devices still seeing it', () => {
    const html = render(userText(false));
    expect(html).toContain('ui-user-send-time-row');
    expect(html).toContain('ui-user-send-time-slot');
    expect(html).toContain('ui-user-send-time');
    expect(html).toContain(`发送 ${formatUserMessageTime(userText(false).timestamp)}`);
    // 气泡时间不复用轮末角标：桌面端悬停显示，触摸屏仍靠 CSS 常驻。
    expect(html).not.toContain('ui-send-time"');
    const css = readFileSync(new URL('./index.css', import.meta.url), 'utf8');
    expect(css).toMatch(/\.ui-user-send-time-row:hover \.ui-user-send-time/);
    expect(css).toMatch(/\.ui-user-send-time-slot\s*\{[^}]*position:\s*absolute/);
  });

  it('lets long links wrap instead of overflowing the bubble', () => {
    // 用户气泡没有挂 .markdown 类，长 URL 默认会顶破 80% 宽的圆角边界。
    const css = readFileSync(new URL('./index.css', import.meta.url), 'utf8');
    expect(css).toMatch(/\.ui-user-bubble[^{]*\{[^}]*overflow-wrap:\s*anywhere/);
    expect(render(userText(false))).toContain('ui-user-bubble');
  });

  it('shows a collapsible injection block inside the user bubble when sentPrompt has an injected prefix', () => {
    const sentPrompt = '<agentdock-context>\n你的名字：小橘\n</agentdock-context>\n\n<agentdock-superagent>\n先派活\n</agentdock-superagent>\n\n检查项目';
    const html = render(userText(false), sentPrompt);
    expect(html).toContain('注入');
    expect(html).toContain('上下文快照 · 编排指令');
    expect(html).toContain('data-timeline-disclosure');
    expect(html).toContain('transition-[grid-template-rows,opacity]');
    expect(html).toContain('grid-rows-[0fr]');
    // 默认折叠时不挂载 <pre>，避免未展开就撑宽 shrink-to-fit 用户气泡。
    expect(html).not.toContain('<pre');
    expect(html).toContain('检查项目');
    // 没有注入前缀时不渲染注入条。
    expect(render(userText(false), '检查项目')).not.toContain('上下文快照');
  });

  it('renders emoji-triggered turns as visible bubbles with their injected prompt', () => {
    const emojiEvent: TimelineEvent = {
      id: 'e1', sequence: 2, type: 'text', timestamp: '2026-01-01T00:00:00.000Z',
      data: { role: 'user', origin: EMOJI_TRIGGER_ORIGIN, text: '飞书表情触发（THUMBSUP）：帮我看下' }
    } as TimelineEvent;
    const html = render(emojiEvent, '用户在飞书消息上添加了「THUMBSUP」表情');
    expect(html).toContain('表情触发注入');
    expect(html).toContain('飞书表情触发（THUMBSUP）：帮我看下');
  });

  it('renders a collapsible SystemPromptBubble for session-level systemPrompt', () => {
    const html = renderToStaticMarkup(createElement(SystemPromptBubble, { prompt: '[AgentDock]\n你运行在 AgentDock 托管的会话中。' }));
    expect(html).toContain('会话 System Prompt');
    expect(html).toContain('data-timeline-disclosure');
    expect(html).toContain('transition-[grid-template-rows,opacity]');
    expect(html).toContain('grid-rows-[0fr]');
    expect(html).not.toContain('<pre');
  });

  it('renders quoted blockquotes inside user bubbles with dedicated bounded styling and marks assistant outputs', () => {
    const quotedEvent: TimelineEvent = {
      id: 'u-quote', sequence: 3, type: 'text', timestamp: '2026-01-01T00:00:00.000Z',
      data: { role: 'user', text: '> 被引用的 Agent 结论\n\n请展开说明这一点' }
    } as TimelineEvent;
    const html = render(quotedEvent);
    expect(html).toContain('<blockquote>');
    expect(html).toContain('被引用的 Agent 结论');
    expect(html).toContain('请展开说明这一点');

    const assistantEvent: TimelineEvent = {
      id: 'a-1', sequence: 4, type: 'text', timestamp: '2026-01-01T00:00:01.000Z',
      data: { role: 'assistant', text: '这是 Agent 回复正文' }
    } as TimelineEvent;
    const assistantHtml = render(assistantEvent);
    expect(assistantHtml).toContain('data-assistant-output');

    const css = readFileSync(new URL('./index.css', import.meta.url), 'utf8');
    expect(css).toMatch(/\.ui-user-bubble blockquote\s*\{[^}]*border-left:/);
    expect(css).toMatch(/\.ui-user-bubble blockquote\s*\{[^}]*max-height:/);
  });

  it('Disclosure uses grid-template-rows transition and respects initial open state with unmountOnClose', () => {
    const closed = renderToStaticMarkup(createElement(Disclosure, { open: false, unmountOnClose: true, children: createElement('pre', null, 'hidden body') }));
    expect(closed).toContain('transition-[grid-template-rows,opacity]');
    expect(closed).toContain('grid-rows-[0fr]');
    expect(closed).toContain('opacity-0');
    expect(closed).not.toContain('hidden body');

    const opened = renderToStaticMarkup(createElement(Disclosure, { open: true, unmountOnClose: true, children: createElement('pre', null, 'visible body') }));
    expect(opened).toContain('grid-rows-[1fr]');
    expect(opened).toContain('opacity-100');
    expect(opened).toContain('visible body');
  });
});
