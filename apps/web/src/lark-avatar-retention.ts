import type { Locale } from '@agent-dock/agent-dock-shared';
import { bi, getCurrentLocale } from './i18n';

export const DEFAULT_INBOX_MAX_ITEMS = 60;
export const DEFAULT_INBOX_CLEANUP_WARN_THRESHOLD = 200;
export const MAX_CONFIGURABLE_INBOX_ITEMS = 100_000;

export type RetentionInputResult =
  | { ok: true; value: number }
  | { ok: false; error: string };

/**
 * 校验并解析消息记录保留上限 / 清理提醒阈值输入。
 * 允许 0 到 MAX_CONFIGURABLE_INBOX_ITEMS 的非负整数；拒绝空字符串、负数、小数或越界值。
 */
export function parseRetentionInput(
  raw: string,
  label: string,
  zeroHint: string,
  locale: Locale = getCurrentLocale()
): RetentionInputResult {
  const trimmed = raw.trim();
  if (!trimmed) {
    return { ok: false, error: bi(`请填写${label}（${zeroHint}）`, `Please enter ${label} (${zeroHint})`, locale) };
  }
  if (!/^\d+$/.test(trimmed)) {
    return {
      ok: false,
      error: bi(
        `${label}必须是 0 到 ${MAX_CONFIGURABLE_INBOX_ITEMS} 之间的整数（${zeroHint}）`,
        `${label} must be an integer between 0 and ${MAX_CONFIGURABLE_INBOX_ITEMS} (${zeroHint})`,
        locale
      )
    };
  }
  const value = Number(trimmed);
  if (!Number.isSafeInteger(value) || value < 0 || value > MAX_CONFIGURABLE_INBOX_ITEMS) {
    return {
      ok: false,
      error: bi(
        `${label}必须是 0 到 ${MAX_CONFIGURABLE_INBOX_ITEMS} 之间的整数（${zeroHint}）`,
        `${label} must be an integer between 0 and ${MAX_CONFIGURABLE_INBOX_ITEMS} (${zeroHint})`,
        locale
      )
    };
  }
  return { ok: true, value };
}

export interface CleanupReminderState {
  shouldShow: boolean;
  inboxCount: number;
  warnThreshold: number;
  excessCount: number;
}

/**
 * 判断打开飞书替身面板时是否应展示超阈值清理提醒：
 * - 提醒阈值为 0 时关闭提醒；
 * - 仅当当前消息记录数严格超过提醒阈值且本轮未点「暂不处理」时展示。
 */
export function evaluateCleanupReminder(input: {
  inboxCount: number;
  warnThreshold: number;
  dismissed: boolean;
}): CleanupReminderState {
  const inboxCount = Math.max(0, Math.floor(Number.isFinite(input.inboxCount) ? input.inboxCount : 0));
  const warnThreshold = Math.max(0, Math.floor(Number.isFinite(input.warnThreshold) ? input.warnThreshold : 0));
  const shouldShow = !input.dismissed && warnThreshold > 0 && inboxCount > warnThreshold;
  return {
    shouldShow,
    inboxCount,
    warnThreshold,
    excessCount: shouldShow ? inboxCount - warnThreshold : 0
  };
}

/**
 * 计算快捷「保留最近 N 条」清理目标：
 * - 确保清理后条数不超过默认 60 条，也不超过当前提醒阈值（若已开启）与保留上限（若非 0）；
 * - 若算出的保留条数已不小于当前总数（清理无效果），返回 0 表示仅提供「清空全部」。
 */
export function resolveQuickKeepLatest(input: {
  inboxCount: number;
  inboxMaxItems: number;
  warnThreshold: number;
}): number {
  const count = Math.max(0, Math.floor(input.inboxCount));
  if (count <= 1) return 0;
  let target = DEFAULT_INBOX_MAX_ITEMS;
  if (input.warnThreshold > 0) target = Math.min(target, Math.floor(input.warnThreshold));
  if (input.inboxMaxItems > 0) target = Math.min(target, Math.floor(input.inboxMaxItems));
  if (target <= 0 || target >= count) return 0;
  return target;
}

export function formatRetentionSummary(inboxMaxItems: number, locale: Locale = getCurrentLocale()): string {
  return inboxMaxItems <= 0
    ? bi('不限制', 'Unlimited', locale)
    : bi(`上限 ${inboxMaxItems} 条`, `Limit ${inboxMaxItems}`, locale);
}

export function formatCleanupSuccessMessage(
  result: {
    deleted: number;
    remaining: number;
    keepLatest: number;
  },
  locale: Locale = getCurrentLocale()
): string {
  if (result.deleted <= 0) return bi('当前没有需要清理的消息记录', 'No message records need cleanup', locale);
  if (result.keepLatest <= 0) {
    return bi(`已清空 ${result.deleted} 条消息记录`, `Cleared ${result.deleted} message records`, locale);
  }
  return bi(
    `已清理 ${result.deleted} 条旧消息，保留最近 ${result.remaining} 条`,
    `Cleaned up ${result.deleted} older messages; kept the latest ${result.remaining}`,
    locale
  );
}
