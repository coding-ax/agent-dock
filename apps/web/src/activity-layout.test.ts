import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ActivityPanel, TimelineItem } from './TimelineItems';
import { AssistantMarkdown } from './TypewriterText';
import { TooltipProvider } from './HoverTooltip';
import type { TimelineActivityGroup, TimelineEvent } from './timeline';

const at = '2026-01-01T00:00:00.000Z';
const tool = (id: string, status: string): TimelineEvent => ({ id, sequence: 2, type: 'tool_call', timestamp: at, data: { id, name: 'Read', status } } as TimelineEvent);
const assistantText = (id: string, text: string): TimelineEvent => ({ id, sequence: 3, type: 'text', timestamp: at, data: { role: 'assistant', text } } as TimelineEvent);
const group = (events: TimelineEvent[]): TimelineActivityGroup => ({ id: `group-${events[0]!.id}`, label: 'x', labelTitle: 'x', events, startedAt: at });
const panel = (groups: TimelineActivityGroup[], ongoing = true) =>
  renderToStaticMarkup(createElement(TooltipProvider, null, createElement(ActivityPanel, { groups, ongoing, sessionId: 's1', modelLabel: 'Claude', startedAt: at })));
// 「处理中」那一行的外壳：显示与留空时是同一个 min-h-8 节点。
const slots = (html: string) => html.split('relative min-h-8 py-1').length - 1;

describe('processing row keeps its place while tools come and go', () => {
  it('shows the processing row before any step exists', () => {
    const html = panel([]);
    expect(slots(html)).toBe(1);
    expect(html).toContain('处理中');
  });

  it('reserves the same row, empty, while a tool is still running', () => {
    // 连续工具调用会并进同一行；「处理中」若随每次起落增删，时间线就跟着上下跳 32px。
    const running = panel([group([tool('c1', 'completed'), tool('c2', 'running')])]);
    const idle = panel([group([tool('c1', 'completed'), tool('c2', 'completed')])]);
    expect(slots(running)).toBe(1);
    expect(running).not.toContain('处理中');
    expect(running).toContain('aria-hidden="true" class="relative min-h-8 py-1');
    expect(slots(idle)).toBe(1);
    expect(idle).toContain('处理中');
  });

  it('stops the step line at the last step while the reserved row is empty', () => {
    expect(panel([group([tool('c1', 'running')])])).toContain('left-2 top-2 w-px bg-zinc-200 bottom-11');
    expect(panel([group([tool('c1', 'completed')])])).toContain('left-2 top-2 w-px bg-zinc-200 bottom-3');
  });

  it('lets a streaming answer take the row over instead of reserving it below', () => {
    const html = panel([group([tool('c1', 'completed'), assistantText('a1', '好')])]);
    expect(slots(html)).toBe(0);
  });

  it('never reserves the row once the turn is over', () => {
    expect(slots(panel([group([tool('c1', 'completed')])], false))).toBe(0);
  });
});

describe('streaming answer height', () => {
  it('occupies at least one line while streaming, even before the first character shows', () => {
    // 打字机从 0 字起播：空 article 的上下外边距叠成一个，顶替「处理中」时时间线先缩 44px 再撑开 50px。
    const streaming = renderToStaticMarkup(createElement(AssistantMarkdown, { text: '好', active: true, sessionId: 's1' }));
    expect(streaming).toContain('min-h-[1.7em]');
    expect(renderToStaticMarkup(createElement(AssistantMarkdown, { text: '好', active: false, sessionId: 's1' }))).not.toContain('min-h-[1.7em]');
  });
});

describe('final answer entrance', () => {
  const answer = (timestamp: string) => ({ id: 'a1', sequence: 3, type: 'text', timestamp, data: { role: 'assistant', text: '回答' } } as TimelineEvent);
  const render = (replay: boolean) => renderToStaticMarkup(createElement(TooltipProvider, null, createElement(TimelineItem, { event: answer(at), final: true, streaming: false, replay, sessionId: 's1' })));

  it('does not fade back in when the answer moves out of the activity panel at turn end', () => {
    expect(render(false)).not.toContain('ui-timeline-item');
  });

  it('still fades in with the rest of the history on first paint', () => {
    expect(render(true)).toContain('ui-timeline-item');
  });
});
