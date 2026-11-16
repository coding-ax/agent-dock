const ignoredLabels: Record<string, string> = {
  disabled: '表情触发未启用',
  emoji_not_configured: '未配置触发 emoji',
  emoji_mismatch: 'emoji 与配置不匹配',
  self_reaction: '替身自己加的反馈表情',
  bot_reaction: '机器人/应用添加的表情',
  operator_not_allowed: '操作人不在机器人白名单',
  operator_identity_unresolved: '事件只给了 user_id/union_id，无法匹配 open_id 白名单',
  duplicate: '重复事件，已触发过',
  listening_paused: '替身监听已暂停',
  chat_not_listened: '会话不在监听白名单',
  not_connected: '替身尚未配置'
};

const failedLabels: Record<string, string> = {
  permission_denied: '机器人没有读取消息权限',
  missing_message: '找不到被反应的消息',
  message_fetch_failed: '读取消息失败',
  no_main_session: '还没有主会话',
  ask_card_failed: '询问卡片发送失败',
  dispatch_failed: '派发 Agent 轮次失败',
  dispatch_uncertain: '上次派发后进程中断，无法确认是否已开始'
};

/** 把服务端的 outcome 字符串翻译成设置页能直接看懂的结论。 */
export function reactionOutcomeLabel(outcome?: string): string {
  if (!outcome) return '未知';
  const [kind, detail = ''] = outcome.split(':');
  if (kind === 'triggered') {
    return detail === 'main' ? '已发到主会话' : detail === 'independent' ? '已开独立轮次' : '已触发一轮 Agent';
  }
  if (kind === 'awaiting_route') return '已发询问卡片，等待选择';
  if (kind === 'route') return detail === 'failed' ? '卡片选择后执行失败' : '卡片选择后已执行';
  if (kind === 'ignored') return ignoredLabels[detail] ?? `已忽略（${detail || 'unknown'}）`;
  if (kind === 'failed') return `失败：${failedLabels[detail] ?? (detail || 'unknown')}`;
  return outcome;
}

export function reactionStateLabel(state: string): string {
  return {
    pending: '处理中',
    dispatching: '派发中',
    awaiting_route: '等待选择',
    dispatched: '已派发',
    ignored: '已跳过',
    failed: '失败'
  }[state] ?? state;
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
export function reactionSourceStatus(source?: LarkReactionSourceStatus): { ok: boolean; label: string; detail: string } {
  if (!source) return { ok: false, label: '事件通道状态未知', detail: '还没有读取到机器人监听状态' };
  if (source.listenerDisabled) {
    return {
      ok: false,
      label: '机器人事件监听已关闭',
      detail: '当前实例设置了 AGENTDOCK_DISABLE_LARK_LISTENER=true，reaction 事件不会到达'
    };
  }
  if (!source.botConfigured) {
    return {
      ok: false,
      label: '还没有配置飞书机器人',
      detail: 'reaction 事件只由飞书机器人长连接投递；替身扫码登录本身收不到'
    };
  }
  if (source.botEnabled === 0) {
    return { ok: false, label: '没有启用中的飞书机器人', detail: `已配置 ${source.botAppIds.join(', ') || '0'} 个，但没有一个打开监听` };
  }
  if (!source.listenerActive) {
    return { ok: false, label: '机器人监听未连接', detail: `等待连接：${source.botAppIds.join(', ')}` };
  }
  return { ok: true, label: '机器人事件监听已就绪', detail: `监听中：${source.activeAppIds.join(', ')}` };
}
