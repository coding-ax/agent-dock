import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ActivityPanel, TimelineItem } from './TimelineItems';
import { AssistantMarkdown } from './TypewriterText';
import { TooltipProvider } from './HoverTooltip';
import type { TimelineActivityGroup, TimelineEvent } from './timeline';

const thinking = (id: string, text: string): TimelineEvent => ({ id, sequence: 1, type: 'thinking', timestamp: '2026-01-01T00:00:00.000Z', data: { text } } as TimelineEvent);
const group = (id: string, events: TimelineEvent[]): TimelineActivityGroup => ({ id, label: id, labelTitle: id, events, startedAt: '2026-01-01T00:00:00.000Z' });
const carets = (groups: TimelineActivityGroup[]) => renderToStaticMarkup(createElement(TooltipProvider, null, createElement(ActivityPanel, { groups, ongoing: true, sessionId: 's1', modelLabel: 'Claude' }))).split('ui-typewriter-caret').length - 1;

describe('thinking caret', () => {
  it('blinks only on the thinking that is still streaming while the turn runs', () => {
    const groups = [group('stage-1', [thinking('t1', 'first')]), group('stage-2', [thinking('t2', 'second')])];
    expect(carets(groups)).toBe(1);
  });

  it('drops the caret once a tool call follows the thinking', () => {
    const tool = { id: 'tool-1', sequence: 2, type: 'tool_call', timestamp: '2026-01-01T00:00:01.000Z', data: { toolCallId: 'c1', title: 'Read', status: 'running' } } as TimelineEvent;
    const groups = [group('stage-1', [thinking('t1', 'first'), tool])];
    expect(carets(groups)).toBe(0);
  });

  it('does not keep a caret on text that is still draining after its stream ended', () => {
    const html = renderToStaticMarkup(createElement(AssistantMarkdown, { text: 'done', active: false, sessionId: 's1' }));
    expect(html).not.toContain('ui-typewriter-caret');
  });
});

describe('typewriter replay', () => {
  it('shows a settled answer in full instead of retyping it when it remounts as the final row', () => {
    const answer = { id: 'a1', sequence: 3, type: 'text', timestamp: '2099-01-01T00:00:00.000Z', data: { role: 'assistant', text: '已经返回的回答' } } as TimelineEvent;
    const html = renderToStaticMarkup(createElement(TooltipProvider, null, createElement(TimelineItem, { event: answer, final: true, streaming: false, sessionId: 's1' })));
    expect(html).toContain('已经返回的回答');
  });
});
