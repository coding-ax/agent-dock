import type { Locale } from '@agent-dock/agent-dock-shared';
import { bi, getCurrentLocale } from './i18n';

function getIgnoredLabels(locale: Locale): Record<string, string> {
  return {
    disabled: bi('表情触发未启用', 'Reaction trigger disabled', locale),
    emoji_not_configured: bi('未配置触发 emoji', 'Trigger emoji not configured', locale),
    emoji_mismatch: bi('emoji 与配置不匹配', 'Emoji does not match configured trigger', locale),
    self_reaction: bi('替身自己加的反馈表情', 'Feedback reaction added by avatar itself', locale),
    bot_reaction: bi('机器人/应用添加的表情', 'Reaction added by a bot/app', locale),
    operator_not_allowed: bi('操作人不在机器人白名单', 'Operator is not in bot allowlist', locale),
    operator_identity_unresolved: bi(
      '事件只给了 user_id/union_id，无法匹配 open_id 白名单',
      'Event only provided user_id/union_id; cannot match open_id allowlist',
      locale
    ),
    duplicate: bi('重复事件，已触发过', 'Duplicate event; already triggered', locale),
    listening_paused: bi('替身监听已暂停', 'Avatar listening is paused', locale),
    chat_not_listened: bi('会话不在监听白名单', 'Chat is not in listened allowlist', locale),
    not_connected: bi('替身尚未配置', 'Avatar is not configured yet', locale)
  };
}

function getFailedLabels(locale: Locale): Record<string, string> {
  return {
    permission_denied: bi('机器人没有读取消息权限', 'Bot lacks permission to read messages', locale),
    missing_message: bi('找不到被反应的消息', 'Reacted message not found', locale),
    message_fetch_failed: bi('读取消息失败', 'Failed to fetch message', locale),
    no_main_session: bi('还没有主会话', 'No main session yet', locale),
    ask_card_failed: bi('询问卡片发送失败', 'Failed to send route selection card', locale),
    dispatch_failed: bi('派发 Agent 轮次失败', 'Failed to dispatch Agent turn', locale),
    dispatch_uncertain: bi(
      '上次派发后进程中断，无法确认是否已开始',
      'Process interrupted after last dispatch; cannot confirm whether it started',
      locale
    )
  };
}

/** 把服务端的 outcome 字符串翻译成设置页能直接看懂的结论。 */
export function reactionOutcomeLabel(outcome?: string, locale: Locale = getCurrentLocale()): string {
  if (!outcome) return bi('未知', 'Unknown', locale);
  const [kind, detail = ''] = outcome.split(':');
  if (kind === 'triggered') {
    return detail === 'main'
      ? bi('已发到主会话', 'Dispatched to main session', locale)
      : detail === 'independent'
        ? bi('已开独立轮次', 'Started independent turn', locale)
        : bi('已触发一轮 Agent', 'Triggered an Agent turn', locale);
  }
  if (kind === 'awaiting_route') return bi('已发询问卡片，等待选择', 'Prompt card sent, awaiting choice', locale);
  if (kind === 'route') {
    return detail === 'failed'
      ? bi('卡片选择后执行失败', 'Failed after card selection', locale)
      : bi('卡片选择后已执行', 'Executed after card selection', locale);
  }
  if (kind === 'ignored') {
    const ignoredLabels = getIgnoredLabels(locale);
    return ignoredLabels[detail] ?? bi(`已忽略（${detail || 'unknown'}）`, `Ignored (${detail || 'unknown'})`, locale);
  }
  if (kind === 'failed') {
    const failedLabels = getFailedLabels(locale);
    const reason = failedLabels[detail] ?? (detail || 'unknown');
    return bi(`失败：${reason}`, `Failed: ${reason}`, locale);
  }
  return outcome;
}

export function reactionStateLabel(state: string, locale: Locale = getCurrentLocale()): string {
  const labels: Record<string, string> = {
    pending: bi('处理中', 'Pending', locale),
    dispatching: bi('派发中', 'Dispatching', locale),
    awaiting_route: bi('等待选择', 'Awaiting choice', locale),
    dispatched: bi('已派发', 'Dispatched', locale),
    ignored: bi('已跳过', 'Skipped', locale),
    failed: bi('失败', 'Failed', locale)
  };
  return labels[state] ?? state;
}

export type LarkReactionSourceStatus = {
  botConfigured: boolean;
  botEnabled: number;
  botAppIds: string[];
  listenerActive: boolean;
  activeAppIds: string[];
  listenerDisabled: boolean;
};

/**
 * 飞书 reaction 事件只能由机器人长连接投递。没有事件时先看这条，
 * 避免把「通道没开/没配机器人」误判成「表情没触发」。
 */
export function reactionSourceStatus(
  source?: LarkReactionSourceStatus,
  locale: Locale = getCurrentLocale()
): { ok: boolean; label: string; detail: string } {
  if (!source) {
    return {
      ok: false,
      label: bi('事件通道状态未知', 'Event channel status unknown', locale),
      detail: bi('还没有读取到机器人监听状态', 'Bot listener status has not been loaded yet', locale)
    };
  }
  if (source.listenerDisabled) {
    return {
      ok: false,
      label: bi('机器人事件监听已关闭', 'Bot event listener disabled', locale),
      detail: bi(
        '当前实例设置了 AGENTDOCK_DISABLE_LARK_LISTENER=true，reaction 事件不会到达',
        'AGENTDOCK_DISABLE_LARK_LISTENER=true is set on this instance; reaction events will not arrive',
        locale
      )
    };
  }
  if (!source.botConfigured) {
    return {
      ok: false,
      label: bi('还没有配置飞书机器人', 'No Lark bot configured', locale),
      detail: bi(
        'reaction 事件只由飞书机器人长连接投递；替身扫码登录本身收不到',
        'Reaction events are only delivered via a Lark bot WebSocket connection; avatar QR login alone cannot receive them',
        locale
      )
    };
  }
  if (source.botEnabled === 0) {
    return {
      ok: false,
      label: bi('没有启用中的飞书机器人', 'No enabled Lark bot', locale),
      detail: bi(
        `已配置 ${source.botAppIds.join(', ') || '0'} 个，但没有一个打开监听`,
        `Configured (${source.botAppIds.join(', ') || '0'}), but none have listening enabled`,
        locale
      )
    };
  }
  if (!source.listenerActive) {
    return {
      ok: false,
      label: bi('机器人监听未连接', 'Bot listener disconnected', locale),
      detail: bi(`等待连接：${source.botAppIds.join(', ')}`, `Waiting to connect: ${source.botAppIds.join(', ')}`, locale)
    };
  }
  return {
    ok: true,
    label: bi('机器人事件监听已就绪', 'Bot event listener ready', locale),
    detail: bi(`监听中：${source.activeAppIds.join(', ')}`, `Listening: ${source.activeAppIds.join(', ')}`, locale)
  };
}
