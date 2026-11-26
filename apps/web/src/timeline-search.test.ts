import { describe, expect, it } from 'vitest';
import type { DockEvent, Task } from './api';
import { buildTimeline, buildTimelineSections, groupTimelineSections } from './timeline';
import {
  countTextOccurrences,
  isTimelineFindShortcut,
  normalizeSearchQuery,
  searchTimeline,
  shouldHandleTimelineFindShortcut,
  stepSearchIndex,
  stripMarkdownForSearch,
  SYSTEM_PROMPT_SEARCH_KEY
} from './timeline-search';

function makeEvent(overrides: Partial<DockEvent> & { id: string; sequence: number; type: DockEvent['type']; data: DockEvent['data'] }): DockEvent {
  return {
    timestamp: `2026-11-26T10:00:${String(overrides.sequence).padStart(2, '0')}.000Z`,
    ...overrides
  };
}

describe('timeline-search pure helpers', () => {
  it('normalizes search query by trimming surrounding whitespace', () => {
    expect(normalizeSearchQuery('   ')).toBe('');
    expect(normalizeSearchQuery('  hello world  ')).toBe('hello world');
  });

  it('strips common markdown syntax while keeping readable text', () => {
    const md = [
      '## Heading Title',
      'Check **Bold** and `inlineCode` and [SessionPane.tsx](file:///repo/SessionPane.tsx)',
      '> quoted note',
      '```ts',
      'const value = 42;',
      '```'
    ].join('\n');
    const plain = stripMarkdownForSearch(md);
    expect(plain).toContain('Heading Title');
    expect(plain).toContain('Check Bold and inlineCode and SessionPane.tsx');
    expect(plain).toContain('quoted note');
    expect(plain).toContain('const value = 42;');
    expect(plain).not.toContain('file:///repo/SessionPane.tsx');
  });

  it('counts case-insensitive non-overlapping occurrences including regex metacharacters', () => {
    expect(countTextOccurrences('Foo foo FOO', 'foo')).toBe(3);
    expect(countTextOccurrences('aaaa', 'aa')).toBe(2);
    expect(countTextOccurrences('price is $10.50 + [tax] ($10.50)', '$10.50')).toBe(2);
    expect(countTextOccurrences('搜索对话内容：支持对话流搜索', '搜索')).toBe(2);
    expect(countTextOccurrences('abc', '')).toBe(0);
  });

  it('wraps around search index cleanly on next/prev', () => {
    expect(stepSearchIndex(0, 3, 1)).toBe(1);
    expect(stepSearchIndex(2, 3, 1)).toBe(0);
    expect(stepSearchIndex(0, 3, -1)).toBe(2);
    expect(stepSearchIndex(1, 3, -1)).toBe(0);
    expect(stepSearchIndex(0, 0, 1)).toBe(-1);
    expect(stepSearchIndex(-1, 3, 1)).toBe(0);
    expect(stepSearchIndex(-1, 3, -1)).toBe(2);
  });

  it('matches Cmd+F and Ctrl+F without Alt/Shift and never conflicts with Cmd+K', () => {
    expect(isTimelineFindShortcut({ key: 'f', metaKey: true, ctrlKey: false, altKey: false, shiftKey: false })).toBe(true);
    expect(isTimelineFindShortcut({ key: 'F', metaKey: false, ctrlKey: true, altKey: false, shiftKey: false })).toBe(true);
    expect(isTimelineFindShortcut({ key: 'f', metaKey: true, ctrlKey: false, altKey: false, shiftKey: true })).toBe(false);
    expect(isTimelineFindShortcut({ key: 'f', metaKey: true, ctrlKey: false, altKey: true, shiftKey: false })).toBe(false);
    expect(isTimelineFindShortcut({ key: 'k', metaKey: true, ctrlKey: false, altKey: false, shiftKey: false })).toBe(false);
    expect(isTimelineFindShortcut({ key: 'f', metaKey: false, ctrlKey: false, altKey: false, shiftKey: false })).toBe(false);
  });

  it('respects open modals and primary/secondary pane scoping', () => {
    expect(shouldHandleTimelineFindShortcut({
      hasActiveDialog: true,
      hasAriaModal: false,
      pane: 'primary',
      targetInsidePane: true,
      targetInsideSecondaryPane: false
    })).toBe(false);

    expect(shouldHandleTimelineFindShortcut({
      hasActiveDialog: false,
      hasAriaModal: true,
      pane: 'primary',
      targetInsidePane: true,
      targetInsideSecondaryPane: false
    })).toBe(false);

    expect(shouldHandleTimelineFindShortcut({
      hasActiveDialog: false,
      hasAriaModal: false,
      pane: 'secondary',
      targetInsidePane: true,
      targetInsideSecondaryPane: true
    })).toBe(true);

    expect(shouldHandleTimelineFindShortcut({
      hasActiveDialog: false,
      hasAriaModal: false,
      pane: 'primary',
      targetInsidePane: false,
      targetInsideSecondaryPane: true
    })).toBe(false);

    expect(shouldHandleTimelineFindShortcut({
      hasActiveDialog: false,
      hasAriaModal: false,
      pane: 'primary',
      targetInsidePane: false,
      targetInsideSecondaryPane: false
    })).toBe(true);
  });
});

describe('searchTimeline', () => {
  it('finds matches across system prompt, user messages, activity steps (thinking + tools), assistant output, and errors in visual order', () => {
    const tasks: Task[] = [
      {
        id: 'task-1',
        sessionId: 'sess-1',
        prompt: 'Inspect timeline search behavior',
        status: 'completed',
        createdAt: '2026-11-26T10:00:01.000Z',
        updatedAt: '2026-11-26T10:00:06.000Z'
      }
    ];
    const events: DockEvent[] = [
      makeEvent({ id: 'ev-1', sequence: 1, type: 'text', data: { role: 'user', taskId: 'task-1', text: 'Inspect timeline SEARCH behavior' } }),
      makeEvent({ id: 'ev-2', sequence: 2, type: 'thinking', data: { text: '**Plan search**\nNeed to support search in activity panels.' } }),
      makeEvent({ id: 'ev-3', sequence: 3, type: 'tool_call', data: { name: 'Bash', status: 'completed', input: { command: 'rg search apps/web/src' }, output: 'timeline-search.ts' } }),
      makeEvent({ id: 'ev-4', sequence: 4, type: 'text', data: { role: 'assistant', text: 'Implemented **search** with fast search navigation.' } }),
      makeEvent({ id: 'ev-5', sequence: 5, type: 'error', data: { message: 'Temporary search index timeout' } })
    ];

    const timeline = buildTimeline(events, tasks, []);
    const sections = buildTimelineSections(timeline, tasks);
    const turns = groupTimelineSections(sections);

    const matches = searchTimeline({
      turns,
      systemPrompt: 'Always optimize search latency.',
      query: 'search'
    });

    // 1 in systemPrompt
    expect(matches[0]).toMatchObject({ itemKey: SYSTEM_PROMPT_SEARCH_KEY, sectionKind: 'system-prompt', occurrenceIndex: 0 });

    // User message match
    const eventMatches = matches.filter(m => m.sectionKind === 'event');
    expect(eventMatches.length).toBeGreaterThanOrEqual(4); // 1 user + 2 assistant + 1 error

    // Activity panel matches (thinking + tool)
    const activityMatches = matches.filter(m => m.sectionKind === 'activity');
    expect(activityMatches.length).toBeGreaterThanOrEqual(2);
    expect(activityMatches.every(m => Boolean(m.stepId))).toBe(true);

    // Empty query returns empty array
    expect(searchTimeline({ turns, query: '   ' })).toEqual([]);
  });
});
