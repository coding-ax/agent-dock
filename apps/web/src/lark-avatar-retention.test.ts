import { describe, expect, it } from 'vitest';
import {
  DEFAULT_INBOX_CLEANUP_WARN_THRESHOLD,
  DEFAULT_INBOX_MAX_ITEMS,
  MAX_CONFIGURABLE_INBOX_ITEMS,
  evaluateCleanupReminder,
  formatCleanupSuccessMessage,
  formatRetentionSummary,
  parseRetentionInput,
  resolveQuickKeepLatest
} from './lark-avatar-retention';

describe('lark-avatar-retention', () => {
  it('validates retention count inputs including 0 (unlimited / disabled) and rejects invalid values', () => {
    expect(parseRetentionInput('0', '记录保留上限', '0 表示不限制')).toEqual({ ok: true, value: 0 });
    expect(parseRetentionInput('60', '记录保留上限', '0 表示不限制')).toEqual({ ok: true, value: 60 });
    expect(parseRetentionInput(' 200 ', '清理提醒阈值', '0 表示关闭提醒')).toEqual({ ok: true, value: 200 });
    expect(parseRetentionInput(String(MAX_CONFIGURABLE_INBOX_ITEMS), '记录保留上限', '0 表示不限制')).toEqual({
      ok: true,
      value: MAX_CONFIGURABLE_INBOX_ITEMS
    });

    expect(parseRetentionInput('', '记录保留上限', '0 表示不限制').ok).toBe(false);
    expect(parseRetentionInput('-1', '记录保留上限', '0 表示不限制').ok).toBe(false);
    expect(parseRetentionInput('12.5', '记录保留上限', '0 表示不限制').ok).toBe(false);
    expect(parseRetentionInput('abc', '清理提醒阈值', '0 表示关闭提醒').ok).toBe(false);
    expect(parseRetentionInput(String(MAX_CONFIGURABLE_INBOX_ITEMS + 1), '记录保留上限', '0 表示不限制').ok).toBe(false);
  });

  it('triggers cleanup reminder only when strictly above positive threshold and not dismissed', () => {
    expect(DEFAULT_INBOX_MAX_ITEMS).toBe(60);
    expect(DEFAULT_INBOX_CLEANUP_WARN_THRESHOLD).toBe(200);

    // 超过阈值 -> 触发
    expect(evaluateCleanupReminder({ inboxCount: 201, warnThreshold: 200, dismissed: false })).toEqual({
      shouldShow: true,
      inboxCount: 201,
      warnThreshold: 200,
      excessCount: 1
    });

    // 等于或低于阈值 -> 不触发
    expect(evaluateCleanupReminder({ inboxCount: 200, warnThreshold: 200, dismissed: false }).shouldShow).toBe(false);
    expect(evaluateCleanupReminder({ inboxCount: 60, warnThreshold: 200, dismissed: false }).shouldShow).toBe(false);

    // 阈值为 0（关闭提醒）-> 不触发
    expect(evaluateCleanupReminder({ inboxCount: 500, warnThreshold: 0, dismissed: false }).shouldShow).toBe(false);

    // 本轮已点「暂不处理」-> 不触发
    expect(evaluateCleanupReminder({ inboxCount: 260, warnThreshold: 200, dismissed: true }).shouldShow).toBe(false);
  });

  it('computes a quick keep-latest target that always brings counts down to a safe level', () => {
    expect(resolveQuickKeepLatest({ inboxCount: 250, inboxMaxItems: 0, warnThreshold: 200 })).toBe(60);
    expect(resolveQuickKeepLatest({ inboxCount: 80, inboxMaxItems: 0, warnThreshold: 50 })).toBe(50);
    expect(resolveQuickKeepLatest({ inboxCount: 120, inboxMaxItems: 200, warnThreshold: 0 })).toBe(60);
    // 已不超过 60 且低于阈值时无需「保留最近 N 条」，返回 0
    expect(resolveQuickKeepLatest({ inboxCount: 40, inboxMaxItems: 60, warnThreshold: 200 })).toBe(0);
    expect(resolveQuickKeepLatest({ inboxCount: 1, inboxMaxItems: 0, warnThreshold: 0 })).toBe(0);
  });

  it('formats retention summary and cleanup feedback messages', () => {
    expect(formatRetentionSummary(0)).toBe('不限制');
    expect(formatRetentionSummary(60)).toBe('上限 60 条');
    expect(formatCleanupSuccessMessage({ deleted: 0, remaining: 10, keepLatest: 60 })).toBe('当前没有需要清理的消息记录');
    expect(formatCleanupSuccessMessage({ deleted: 120, remaining: 0, keepLatest: 0 })).toBe('已清空 120 条消息记录');
    expect(formatCleanupSuccessMessage({ deleted: 140, remaining: 60, keepLatest: 60 })).toBe('已清理 140 条旧消息，保留最近 60 条');
  });
});
