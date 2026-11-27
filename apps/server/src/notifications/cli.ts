import { makeId } from '@agent-dock/agent-dock-shared';
import { callDaemon, requireDaemon } from '../session-cli.js';
import {
  MASKED_SECRET_SENTINEL,
  notificationRuleEventKinds,
  webhookPresets,
  type LarkNotifyTargetMode,
  type NotificationConfigState,
  type NotificationRuleEventKind,
  type PublicNotificationConfig,
  type ScheduledNotifyMode,
  type WebhookPreset
} from './config.js';

export interface NotifyCommonCliOptions {
  json?: boolean;
  daemonDir?: string;
}

export interface NotifyConfigSetCliOptions extends NotifyCommonCliOptions {
  enabled?: boolean;
  disabled?: boolean;
  events?: string;
  minDuration?: string;
  coalesceMs?: string;
  remoteOnlyWhenAway?: boolean;
  alwaysRemote?: boolean;
  awayAfter?: string;
  scopeNormal?: string;
  scopeSubtasks?: string;
  scopeScheduled?: string;
}

export interface NotifyChannelLarkSetCliOptions extends NotifyCommonCliOptions {
  enabled?: boolean;
  disabled?: boolean;
  app?: string;
  mode?: string;
  target?: string;
  targetType?: string;
  skipOriginal?: boolean;
  includeOriginal?: boolean;
  includeSummary?: boolean;
  noSummary?: boolean;
}

export interface NotifyWebhookAddCliOptions extends NotifyCommonCliOptions {
  name?: string;
  url?: string;
  preset?: string;
  secret?: string;
  header?: string[];
  timeout?: string;
  events?: string;
  disabled?: boolean;
}

export interface NotifyWebhookUpdateCliOptions extends NotifyWebhookAddCliOptions {
  enabled?: boolean;
}

export interface NotifyChannelCommandSetCliOptions extends NotifyCommonCliOptions {
  enabled?: boolean;
  disabled?: boolean;
  cmd?: string;
  timeout?: string;
  trustConfirm?: boolean;
}

export interface NotifyTestCliOptions extends NotifyCommonCliOptions {
  webhook?: string;
}

/** 将服务端返回的脱敏配置转为可安全回传 PUT /api/notifications/config 的结构（保留原密文）。 */
function preserveSecretsPayload(config: PublicNotificationConfig): Record<string, unknown> {
  return {
    ...config,
    webhooks: config.webhooks.map(hook => ({
      id: hook.id,
      name: hook.name,
      enabled: hook.enabled,
      preset: hook.preset,
      url: hook.url,
      headers: hook.headers.map(h => ({
        key: h.key,
        value: h.masked ? MASKED_SECRET_SENTINEL : h.value,
        masked: h.masked
      })),
      ...(hook.hasSecret ? { secret: MASKED_SECRET_SENTINEL } : {}),
      timeoutSec: hook.timeoutSec,
      ...(hook.events?.length ? { events: hook.events } : {})
    }))
  };
}

function parseBoolSwitch(value: string | undefined, flagName: string): boolean {
  const lower = value?.trim().toLowerCase();
  if (lower === 'on' || lower === 'true' || lower === '1') return true;
  if (lower === 'off' || lower === 'false' || lower === '0') return false;
  throw new Error(`${flagName} 必须是 on 或 off`);
}

function parseRuleEvents(raw: string): NotificationRuleEventKind[] {
  const parts = raw.split(',').map(s => s.trim()).filter(Boolean);
  for (const part of parts) {
    if (!(notificationRuleEventKinds as readonly string[]).includes(part)) {
      throw new Error(`--events 只支持 ${notificationRuleEventKinds.join(', ')}，收到：${part}`);
    }
  }
  return [...new Set(parts)] as NotificationRuleEventKind[];
}

function parseHeaders(items: string[] | undefined): Array<{ key: string; value: string }> {
  if (!items?.length) return [];
  return items.map(entry => {
    const eq = entry.indexOf('=');
    if (eq <= 0) throw new Error(`--header 格式应为 KEY=VALUE，收到：${entry}`);
    return { key: entry.slice(0, eq).trim(), value: entry.slice(eq + 1) };
  });
}

function formatNotifyState(state: NotificationConfigState): string {
  const c = state.config;
  const events = [
    c.events.completed ? 'completed' : '',
    c.events.failed ? 'failed' : '',
    c.events.waitingApproval ? 'waiting_approval' : ''
  ].filter(Boolean).join(', ') || '全部关闭';
  const lines = [
    `通知总开关：${c.enabled ? '已开启' : '已关闭'}${state.configured ? '' : '（默认配置）'}`,
    `触发事件：${events}`,
    `防打扰：最短耗时 ${c.antiSpam.minDurationSec}s · 短窗合并 ${c.antiSpam.coalesceWindowMs}ms · 离机推远程 ${c.antiSpam.remoteOnlyWhenAway ? `开启(${c.antiSpam.awayAfterSec}s)` : '关闭'}`,
    `作用范围：普通会话 ${c.scopes.normalSessions ? '开' : '关'} · 便签子会话 ${c.scopes.assistantSubtasks ? '开' : '关'} · 定时任务 ${c.scopes.scheduledSessions}`,
    `飞书通道：${c.lark.enabled ? `开启（模式=${c.lark.mode}${c.lark.appId ? ` · app=${c.lark.appId}` : ''}${c.lark.fallbackReceiveId ? ` · target=${c.lark.fallbackReceiveId}` : ''}）` : '关闭'}`,
    `Webhook 通道：${c.webhooks.length} 个（启用 ${c.webhooks.filter(w => w.enabled).length} 个）`,
    `本地命令 Hook：${c.commandHook.enabled ? `开启（${c.commandHook.command}）` : '关闭'}`
  ];
  const deliveries = Object.entries(state.lastDelivery);
  if (deliveries.length) {
    lines.push('最近投递状态：');
    for (const [key, item] of deliveries) {
      lines.push(`  - ${key}: ${item.ok ? '✓ 成功' : '✗ 失败'} (${item.durationMs}ms · ${item.at})${item.error ? ` — ${item.error}` : ''}`);
    }
  }
  return `${lines.join('\n')}\n`;
}

export async function runNotifyStatus(options: NotifyCommonCliOptions = {}): Promise<string> {
  const state = await callDaemon<NotificationConfigState>(requireDaemon(options.daemonDir), '/api/notifications/config', 'GET');
  if (options.json) return `${JSON.stringify({ ok: true, ...state }, null, 2)}\n`;
  return formatNotifyState(state);
}

export async function runNotifyConfigSet(options: NotifyConfigSetCliOptions = {}): Promise<string> {
  const daemon = requireDaemon(options.daemonDir);
  const current = await callDaemon<NotificationConfigState>(daemon, '/api/notifications/config', 'GET');
  const next = preserveSecretsPayload(current.config) as Record<string, any>;

  if (options.enabled) next.enabled = true;
  if (options.disabled) next.enabled = false;
  if (options.events !== undefined) {
    const selected = new Set(parseRuleEvents(options.events));
    next.events = {
      completed: selected.has('completed'),
      failed: selected.has('failed'),
      waitingApproval: selected.has('waiting_approval')
    };
  }
  if (options.minDuration !== undefined) next.antiSpam.minDurationSec = Number(options.minDuration);
  if (options.coalesceMs !== undefined) next.antiSpam.coalesceWindowMs = Number(options.coalesceMs);
  if (options.remoteOnlyWhenAway) next.antiSpam.remoteOnlyWhenAway = true;
  if (options.alwaysRemote) next.antiSpam.remoteOnlyWhenAway = false;
  if (options.awayAfter !== undefined) next.antiSpam.awayAfterSec = Number(options.awayAfter);
  if (options.scopeNormal !== undefined) next.scopes.normalSessions = parseBoolSwitch(options.scopeNormal, '--scope-normal');
  if (options.scopeSubtasks !== undefined) next.scopes.assistantSubtasks = parseBoolSwitch(options.scopeSubtasks, '--scope-subtasks');
  if (options.scopeScheduled !== undefined) {
    const mode = options.scopeScheduled.trim() as ScheduledNotifyMode;
    if (mode !== 'all' && mode !== 'failed_only' && mode !== 'off') throw new Error('--scope-scheduled 必须是 all / failed_only / off');
    next.scopes.scheduledSessions = mode;
  }

  const saved = await callDaemon<NotificationConfigState>(daemon, '/api/notifications/config', 'PUT', next);
  if (options.json) return `${JSON.stringify({ ok: true, ...saved }, null, 2)}\n`;
  return formatNotifyState(saved);
}

export async function runNotifyChannelLarkSet(options: NotifyChannelLarkSetCliOptions = {}): Promise<string> {
  const daemon = requireDaemon(options.daemonDir);
  const current = await callDaemon<NotificationConfigState>(daemon, '/api/notifications/config', 'GET');
  const next = preserveSecretsPayload(current.config) as Record<string, any>;

  if (options.enabled) next.lark.enabled = true;
  if (options.disabled) next.lark.enabled = false;
  if (options.app !== undefined) next.lark.appId = options.app.trim() || undefined;
  if (options.mode !== undefined) {
    const mode = options.mode.trim() as LarkNotifyTargetMode;
    if (!['auto_handover_then_fallback', 'direct_user', 'chat'].includes(mode)) {
      throw new Error('--mode 必须是 auto_handover_then_fallback / direct_user / chat');
    }
    next.lark.mode = mode;
  }
  if (options.target !== undefined) next.lark.fallbackReceiveId = options.target.trim() || undefined;
  if (options.targetType !== undefined) {
    if (options.targetType !== 'open_id' && options.targetType !== 'chat_id') throw new Error('--target-type 必须是 open_id 或 chat_id');
    next.lark.fallbackReceiveIdType = options.targetType;
  }
  if (options.skipOriginal) next.lark.skipOriginalLarkChat = true;
  if (options.includeOriginal) next.lark.skipOriginalLarkChat = false;
  if (options.includeSummary) next.lark.includeSummary = true;
  if (options.noSummary) next.lark.includeSummary = false;

  const saved = await callDaemon<NotificationConfigState>(daemon, '/api/notifications/config', 'PUT', next);
  if (options.json) return `${JSON.stringify({ ok: true, ...saved }, null, 2)}\n`;
  return formatNotifyState(saved);
}

export async function runNotifyWebhookList(options: NotifyCommonCliOptions = {}): Promise<string> {
  const state = await callDaemon<NotificationConfigState>(requireDaemon(options.daemonDir), '/api/notifications/config', 'GET');
  if (options.json) return `${JSON.stringify({ ok: true, webhooks: state.config.webhooks }, null, 2)}\n`;
  if (!state.config.webhooks.length) return '暂未配置 Webhook 通道。\n';
  return state.config.webhooks.map(w =>
    `${w.enabled ? '●' : '○'} ${w.id}  ${w.name}  [${w.preset}]  ${w.url}${w.hasSecret ? '  (已设签名密钥)' : ''}`
  ).join('\n') + '\n';
}

export async function runNotifyWebhookAdd(options: NotifyWebhookAddCliOptions = {}): Promise<string> {
  const name = options.name?.trim();
  const url = options.url?.trim();
  if (!name || !url) throw new Error('--name 和 --url 必填');
  const preset = (options.preset?.trim() || 'generic') as WebhookPreset;
  if (!(webhookPresets as readonly string[]).includes(preset)) {
    throw new Error(`--preset 必须是 ${webhookPresets.join(' / ')}`);
  }
  const daemon = requireDaemon(options.daemonDir);
  const current = await callDaemon<NotificationConfigState>(daemon, '/api/notifications/config', 'GET');
  const next = preserveSecretsPayload(current.config) as Record<string, any>;
  const id = makeId('wh');
  next.webhooks.push({
    id,
    name,
    enabled: !options.disabled,
    preset,
    url,
    headers: parseHeaders(options.header),
    ...(options.secret !== undefined ? { secret: options.secret } : {}),
    timeoutSec: options.timeout ? Number(options.timeout) : 8,
    ...(options.events ? { events: parseRuleEvents(options.events) } : {})
  });
  const saved = await callDaemon<NotificationConfigState>(daemon, '/api/notifications/config', 'PUT', next);
  const created = saved.config.webhooks.find(w => w.id === id);
  if (options.json) return `${JSON.stringify({ ok: true, webhook: created, config: saved.config }, null, 2)}\n`;
  return `已新增 Webhook「${name}」（${id}）。\n`;
}

export async function runNotifyWebhookUpdate(id: string, options: NotifyWebhookUpdateCliOptions = {}): Promise<string> {
  const daemon = requireDaemon(options.daemonDir);
  const current = await callDaemon<NotificationConfigState>(daemon, '/api/notifications/config', 'GET');
  const next = preserveSecretsPayload(current.config) as Record<string, any>;
  const target = (next.webhooks as Array<Record<string, any>>).find(w => w.id === id);
  if (!target) throw new Error(`Webhook 不存在：${id}`);
  if (options.name !== undefined) target.name = options.name.trim();
  if (options.url !== undefined) target.url = options.url.trim();
  if (options.preset !== undefined) target.preset = options.preset.trim();
  if (options.secret !== undefined) target.secret = options.secret;
  if (options.header?.length) target.headers = parseHeaders(options.header);
  if (options.timeout !== undefined) target.timeoutSec = Number(options.timeout);
  if (options.events !== undefined) target.events = parseRuleEvents(options.events);
  if (options.enabled) target.enabled = true;
  if (options.disabled) target.enabled = false;
  const saved = await callDaemon<NotificationConfigState>(daemon, '/api/notifications/config', 'PUT', next);
  if (options.json) return `${JSON.stringify({ ok: true, webhook: saved.config.webhooks.find(w => w.id === id) }, null, 2)}\n`;
  return `已更新 Webhook ${id}。\n`;
}

export async function runNotifyWebhookRemove(id: string, options: NotifyCommonCliOptions = {}): Promise<string> {
  const daemon = requireDaemon(options.daemonDir);
  const current = await callDaemon<NotificationConfigState>(daemon, '/api/notifications/config', 'GET');
  const next = preserveSecretsPayload(current.config) as Record<string, any>;
  const before = (next.webhooks as Array<{ id: string }>).length;
  next.webhooks = (next.webhooks as Array<{ id: string }>).filter(w => w.id !== id);
  if (next.webhooks.length === before) throw new Error(`Webhook 不存在：${id}`);
  await callDaemon<NotificationConfigState>(daemon, '/api/notifications/config', 'PUT', next);
  if (options.json) return `${JSON.stringify({ ok: true, deleted: true, id }, null, 2)}\n`;
  return `已删除 Webhook ${id}。\n`;
}

export async function runNotifyChannelCommandSet(options: NotifyChannelCommandSetCliOptions = {}): Promise<string> {
  // 安全护栏：启用任意本地 shell hook 必须由用户本人在独立终端执行，禁止会话内 Agent 自动代签安全确认。
  if (options.trustConfirm && process.env.agentdock_session_id?.trim()) {
    throw new Error('安全限制：--trust-confirm 只能由用户本人在本地终端执行，禁止 Agent 会话自行开启本地命令 Hook。');
  }
  const daemon = requireDaemon(options.daemonDir);
  const current = await callDaemon<NotificationConfigState>(daemon, '/api/notifications/config', 'GET');
  const next = preserveSecretsPayload(current.config) as Record<string, any>;
  if (options.enabled) next.commandHook.enabled = true;
  if (options.disabled) next.commandHook.enabled = false;
  if (options.cmd !== undefined) next.commandHook.command = options.cmd.trim();
  if (options.timeout !== undefined) next.commandHook.timeoutSec = Number(options.timeout);
  if (options.trustConfirm) next.commandHook.trustConfirmed = true;
  const saved = await callDaemon<NotificationConfigState>(daemon, '/api/notifications/config', 'PUT', next);
  if (options.json) return `${JSON.stringify({ ok: true, ...saved }, null, 2)}\n`;
  return formatNotifyState(saved);
}

export async function runNotifyTest(channel: string, options: NotifyTestCliOptions = {}): Promise<string> {
  if (channel !== 'lark' && channel !== 'webhook' && channel !== 'command') {
    throw new Error('channel 必须是 lark、webhook 或 command');
  }
  const result = await callDaemon<Record<string, unknown>>(requireDaemon(options.daemonDir), '/api/notifications/test', 'POST', {
    channel,
    ...(options.webhook ? { webhookId: options.webhook } : {})
  });
  if (options.json) return `${JSON.stringify({ ok: Boolean(result.ok), ...result }, null, 2)}\n`;
  return result.ok
    ? `✓ 测试通道 ${String(result.channel ?? channel)} 投递成功（${String(result.durationMs ?? 0)}ms）${result.detail ? `：${String(result.detail)}` : ''}\n`
    : `✗ 测试通道 ${String(result.channel ?? channel)} 投递失败：${String(result.error ?? '未知错误')}\n`;
}
