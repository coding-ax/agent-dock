import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  computeBackfillSelectionStats,
  DEFAULT_REGEX_QUICK_PROMPTS,
  FALLBACK_PROMPT_TEMPLATES,
  FALLBACK_TEMPLATE_VARIABLES,
  formatLarkMessageClock,
  insertVariableAtCursor,
  normalizeRegexFlagSet,
  splitTextByMatchSpans,
  toggleRegexFlag
} from './lark-regex-trigger-utils';
import type { LarkPreviewChatMessage, LarkRegexTriggerHit } from './api';

const here = dirname(fileURLToPath(import.meta.url));

describe('LarkRegexTriggerDialog utils & UI consistency', () => {
  it('splits text cleanly by exact match spans, merging overlaps and preserving all characters', () => {
    const text = '线上出现 P0 告警：支付接口 502 超时';
    const segments = splitTextByMatchSpans(text, [
      { start: 16, end: 19, text: '502' },
      { start: 5, end: 7, text: 'P0' },
      { start: 6, end: 10, text: '0 告警' } // overlapping with P0
    ]);
    expect(segments).toEqual([
      { text: '线上出现 ', matched: false },
      { text: 'P0 告警', matched: true },
      { text: '：支付接口 ', matched: false },
      { text: '502', matched: true },
      { text: ' 超时', matched: false }
    ]);
    expect(segments.map(s => s.text).join('')).toBe(text);
  });

  it('handles empty text, no spans, and out-of-bounds spans gracefully', () => {
    expect(splitTextByMatchSpans('', [{ start: 0, end: 2, text: 'ab' }])).toEqual([{ text: '', matched: false }]);
    expect(splitTextByMatchSpans('hello', [])).toEqual([{ text: 'hello', matched: false }]);
    expect(splitTextByMatchSpans('abc', [{ start: -5, end: 99, text: 'abc' }])).toEqual([{ text: 'abc', matched: true }]);
  });

  it('inserts template variable chips at cursor or replaces current selection', () => {
    expect(insertVariableAtCursor('请排查 中的告警', '{{chatName}}', 4, 4)).toEqual({
      nextValue: '请排查 {{chatName}}中的告警',
      nextCursor: 16
    });
    expect(insertVariableAtCursor('hello world', '{{senderName}}', 6, 11)).toEqual({
      nextValue: 'hello {{senderName}}',
      nextCursor: 20
    });
    expect(insertVariableAtCursor('prefix ', '{{matchedText}}')).toEqual({
      nextValue: 'prefix {{matchedText}}',
      nextCursor: 22
    });
  });

  it('normalizes and toggles regex flags in canonical order', () => {
    expect(normalizeRegexFlagSet('smi')).toBe('ims');
    expect(toggleRegexFlag('i', 'm')).toBe('im');
    expect(toggleRegexFlag('im', 'i')).toBe('m');
    expect(toggleRegexFlag('', 'i')).toBe('i');
  });

  it('computes backfill selection stats separating compensated vs uncompensated matched messages', () => {
    const messages: LarkPreviewChatMessage[] = [
      { messageId: 'm1', chatId: 'oc_1', senderName: 'A', senderType: 'user', text: 'P0 告警', msgType: 'text', createTime: '1732670400000', createdAt: '2026-11-27T01:00:00.000Z' },
      { messageId: 'm2', chatId: 'oc_1', senderName: 'B', senderType: 'user', text: '普通消息', msgType: 'text', createTime: '1732670500000', createdAt: '2026-11-27T01:01:00.000Z' },
      { messageId: 'm3', chatId: 'oc_1', senderName: 'C', senderType: 'user', text: 'P1 报错', msgType: 'text', createTime: '1732670600000', createdAt: '2026-11-27T01:02:00.000Z' },
      { messageId: 'm4', chatId: 'oc_1', senderName: 'D', senderType: 'user', text: 'P0 超时', msgType: 'text', createTime: '1732670700000', createdAt: '2026-11-27T01:03:00.000Z' }
    ];
    const matchById = new Map([
      ['m1', { matched: true, matches: [{ start: 0, end: 2, text: 'P0' }] }],
      ['m2', { matched: false, matches: [] }],
      ['m3', { matched: true, matches: [{ start: 0, end: 2, text: 'P1' }] }],
      ['m4', { matched: true, matches: [{ start: 0, end: 2, text: 'P0' }] }]
    ]);
    const hitsByMessageId: Record<string, LarkRegexTriggerHit[]> = {
      m1: [{
        id: 'r1:m1',
        ruleId: 'r1',
        botId: 'cli_1',
        chatId: 'oc_1',
        messageId: 'm1',
        sessionId: 'sess_1',
        matchedText: 'P0',
        triggerType: 'realtime',
        status: 'triggered',
        triggeredAt: '2026-11-27T01:00:05.000Z'
      }]
    };
    const localTriggered = new Set(['m3']);
    const selected = new Set(['m4']);

    const stats = computeBackfillSelectionStats(messages, matchById, hitsByMessageId, localTriggered, selected);
    expect(stats).toEqual({
      matchedIds: ['m1', 'm3', 'm4'],
      uncompensatedMatchedIds: ['m4'],
      compensatedMatchedCount: 2,
      selectedCount: 1
    });
  });

  it('formats timestamps and ships at least 4 preset prompt templates & 9 context variables', () => {
    expect(formatLarkMessageClock('2026-01-15T08:30:00.000Z')).not.toBe('');
    expect(formatLarkMessageClock(undefined, '1732670400000')).not.toBe('');
    expect(formatLarkMessageClock('invalid', '')).toBe('');
    expect(FALLBACK_PROMPT_TEMPLATES.length).toBeGreaterThanOrEqual(4);
    expect(FALLBACK_TEMPLATE_VARIABLES.length).toBe(9);
    expect(DEFAULT_REGEX_QUICK_PROMPTS.length).toBeGreaterThanOrEqual(4);
  });

  it('follows tooltip-consistency, dark-mode CSS, and unified AiTextAssist wiring', () => {
    const dialogSource = readFileSync(join(here, 'LarkRegexTriggerDialog.tsx'), 'utf8');
    const cssSource = readFileSync(join(here, 'lark-regex-trigger.css'), 'utf8');

    // 不使用原生 button title
    expect(dialogSource).not.toMatch(/<(?:button|span)[^>]*\b(?:role="button"|aria-label=)[^>]*\btitle="/);
    // 复用全站统一 AiTextAssistControl（正则生成 + Prompt 编写/优化 + 未配置置灰提示）
    expect(dialogSource).toContain('mode="regex_generate"');
    expect(dialogSource).toContain('LLM_UNCONFIGURED_TOOLTIP');
    expect(dialogSource).toContain("promptTemplate.trim() ? 'prompt_optimize' : 'prompt_write'");
    // 暗色主题与减动效样式就绪
    expect(cssSource).toContain('html[data-theme="dark"] .ui-regex-mark');
    expect(cssSource).toContain('html[data-theme="dark"] .ui-regex-bubble[data-matched="true"]');
    expect(cssSource).toContain('prefers-reduced-motion: reduce');
  });
});
