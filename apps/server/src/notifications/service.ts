/**
 * 通知调度中心（NotificationService）。
 *
 * 职责：
 * 1. 订阅 `runtime.onTurnEvent` 与收编 `agent-dock notify`（小猫主动提醒 / --ask）；
 * 2. 执行防打扰与防刷屏判定（user_stopped 硬抑制、最短耗时阈值、会话范围分层、冷却去重、短窗合并、离机判定）；
 * 3. 通过轻量 SSE `/api/notifications/stream` 实时广播到 Web / Electron 客户端；
 * 4. 异步分发至飞书机器人、通用 Webhook、本地 Shell Hook，并记录最近一次投递健康状态；
 * 5. 提供按通道「发送测试通知」能力（支持基于未保存草稿测试并自动补齐已存密文）。
 */
import { EventEmitter } from 'node:events';
import {
  makeId,
  now,
  RuntimeError,
  type RepositoryBundle,
  type RuntimeTurnEvent,
  type Session
} from '@agent-dock/agent-dock-shared';
import type { AgentDockRuntime } from '@agent-dock/agent-dock-runtime';
import {
  notificationsConfigKey,
  parseAndMergeNotificationConfig,
  safeReadStoredNotificationConfig,
  toPublicNotificationConfig,
  type ChannelDeliveryStatus,
  type NotificationConfigState,
  type NotificationEventKind,
  type NotificationRuleEventKind,
  type StoredNotificationConfig
} from './config.js';
import {
  deliverCommandHook,
  deliverLarkNotification,
  deliverWebhookNotification,
  resolveSessionActionUrl,
  summarizeNotificationText,
  type DeliveryResult,
  type NotificationPayload
} from './delivery.js';

const SYSTEM_TURN_ORIGINS = new Set(['maintenance', 'handoff']);
const INTERNAL_SESSION_SOURCE_PREFIXES = ['lark-avatar', 'router', 'delegated'];
const SCHEDULE_SEED_MARKER = '定时任务';

export interface RuleEvalContext {
  isAssistantSubtask: boolean;
  isScheduledSession: boolean;
}

export type RuleEvalDecision =
  | { notify: true; kind: NotificationRuleEventKind }
  | { notify: false; reason: string };

/**
 * 纯函数规则评估器：决定一条 `RuntimeTurnEvent` 是否应当触发用户通知。
 * 便于单测完整覆盖所有边界条件。
 */
export function evaluateNotificationRule(
  event: RuntimeTurnEvent,
  config: StoredNotificationConfig,
  context: RuleEvalContext
): RuleEvalDecision {
  if (!config.enabled) return { notify: false, reason: 'disabled' };

  // 1. 用户主动停止/中断：硬抑制，绝不反过来弹窗打扰用户。
  if (event.kind === 'interrupted') {
    if (event.interruptIntent === 'user') return { notify: false, reason: 'user_stopped' };
    if (event.interruptIntent === 'agent_cancelled') return { notify: false, reason: 'agent_cancelled' };
    if (event.interruptIntent !== 'daemon_restart') return { notify: false, reason: 'interrupted' };
  }

  // 2. 系统内部轮次与内部会话静默（小猫整理/交接轮次、AI 飞书替身内部会话）。
  if (event.taskOrigin && SYSTEM_TURN_ORIGINS.has(event.taskOrigin)) {
    return { notify: false, reason: 'system_turn' };
  }
  if (event.sessionSource && INTERNAL_SESSION_SOURCE_PREFIXES.some(prefix => event.sessionSource!.startsWith(prefix))) {
    return { notify: false, reason: 'internal_session' };
  }

  const effectiveKind: NotificationRuleEventKind = event.kind === 'interrupted' ? 'failed' : event.kind;

  // 3. 事件类型开关
  if (effectiveKind === 'completed' && !config.events.completed) return { notify: false, reason: 'event_completed_off' };
  if (effectiveKind === 'failed' && !config.events.failed) return { notify: false, reason: 'event_failed_off' };
  if (effectiveKind === 'waiting_approval' && !config.events.waitingApproval) return { notify: false, reason: 'event_approval_off' };

  // 4. 最短运行时长阈值：仅对正常完成生效；失败和等待审批秒报，不受耗时限制。
  if (
    effectiveKind === 'completed'
    && config.antiSpam.minDurationSec > 0
    && event.durationMs !== undefined
    && event.durationMs < config.antiSpam.minDurationSec * 1000
  ) {
    return { notify: false, reason: 'below_min_duration' };
  }

  // 5. 会话范围分层（便签子会话默认免打扰；定时任务默认仅失败；其余按普通会话控制）
  if (context.isAssistantSubtask) {
    if (!config.scopes.assistantSubtasks) return { notify: false, reason: 'assistant_subtask_muted' };
  } else if (context.isScheduledSession) {
    if (config.scopes.scheduledSessions === 'off') return { notify: false, reason: 'scheduled_off' };
    if (config.scopes.scheduledSessions === 'failed_only' && effectiveKind !== 'failed') {
      return { notify: false, reason: 'scheduled_failed_only' };
    }
  } else if (!config.scopes.normalSessions) {
    return { notify: false, reason: 'normal_sessions_off' };
  }

  return { notify: true, kind: effectiveKind };
}

export interface ClientPresenceRecord {
  clientId: string;
  focused: boolean;
  activeSessionId?: string;
  updatedAt: number;
}

export interface NotificationServiceOptions {
  runtime: AgentDockRuntime;
  repos: RepositoryBundle;
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  fetcher?: typeof globalThis.fetch;
  isAssistantSubtask?: (sessionId: string) => boolean;
  log?: { info?(message: string): void; warn(message: string): void };
  /** 便于单测覆写时钟。 */
  nowMs?: () => number;
}

export interface TestNotificationInput {
  channel: 'lark' | 'webhook' | 'command';
  webhookId?: string;
  /** 允许在不先保存的情况下直接按当前表单草稿测试；密文字段会自动沿用库中已保存值。 */
  draftConfig?: unknown;
}

export class NotificationService {
  private readonly emitter = new EventEmitter();
  private readonly lastDelivery = new Map<string, ChannelDeliveryStatus>();
  private readonly recentFingerprints = new Map<string, number>();
  private readonly presences = new Map<string, ClientPresenceRecord>();
  private readonly pendingRemote: NotificationPayload[] = [];
  private coalesceTimer?: NodeJS.Timeout;
  private unsubscribe?: () => void;
  private closed = false;
  private cachedConfig?: { configured: boolean; config: StoredNotificationConfig };
  private readonly nowMs: () => number;
  private readonly log: { info?(message: string): void; warn(message: string): void };

  constructor(private readonly options: NotificationServiceOptions) {
    this.nowMs = options.nowMs ?? Date.now;
    this.log = options.log ?? { warn: message => console.warn(`[notifications] ${message}`) };
  }

  start(): void {
    if (this.unsubscribe) return;
    this.unsubscribe = this.options.runtime.onTurnEvent(event => {
      void this.handleTurnEvent(event).catch(error => {
        this.log.warn(`处理轮次通知事件失败：${error instanceof Error ? error.message : String(error)}`);
      });
    });
  }

  async close(): Promise<void> {
    this.closed = true;
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    if (this.coalesceTimer) {
      clearTimeout(this.coalesceTimer);
      this.coalesceTimer = undefined;
    }
    this.pendingRemote.length = 0;
    this.emitter.removeAllListeners();
  }

  subscribe(listener: (payload: NotificationPayload) => void): () => void {
    this.emitter.on('notification', listener);
    return () => this.emitter.off('notification', listener);
  }

  private async readStoredState(): Promise<{ configured: boolean; config: StoredNotificationConfig }> {
    if (this.cachedConfig) return this.cachedConfig;
    const raw = await this.options.repos.config.get(notificationsConfigKey);
    const state = safeReadStoredNotificationConfig(raw);
    this.cachedConfig = state;
    return state;
  }

  async getPublicState(): Promise<NotificationConfigState> {
    const { configured, config } = await this.readStoredState();
    return {
      configured,
      config: toPublicNotificationConfig(config),
      lastDelivery: Object.fromEntries(this.lastDelivery)
    };
  }

  async saveConfig(input: unknown): Promise<NotificationConfigState> {
    const { config: existing } = await this.readStoredState();
    const merged = parseAndMergeNotificationConfig(input, existing);
    await this.options.repos.config.set(notificationsConfigKey, JSON.stringify(merged));
    this.cachedConfig = { configured: true, config: merged };
    return this.getPublicState();
  }

  /** 客户端汇报前台聚焦状态，供「仅离开电脑时推远程通道」判定。 */
  reportPresence(input: { clientId: string; focused: boolean; activeSessionId?: string }): void {
    const clientId = input.clientId.trim().slice(0, 120);
    if (!clientId) return;
    const timestamp = this.nowMs();
    this.presences.set(clientId, {
      clientId,
      focused: input.focused,
      ...(input.activeSessionId ? { activeSessionId: input.activeSessionId } : {}),
      updatedAt: timestamp
    });
    // 顺手清理超过 10 分钟未更新的旧客户端记录
    for (const [key, item] of this.presences) {
      if (timestamp - item.updatedAt > 10 * 60_000) this.presences.delete(key);
    }
  }

  isAnyClientActive(awayAfterSec: number): boolean {
    const current = this.nowMs();
    const windowMs = Math.max(awayAfterSec, 15) * 1000;
    for (const item of this.presences.values()) {
      if (item.focused && current - item.updatedAt <= windowMs) return true;
    }
    return false;
  }

  private isScheduledSession(session: Session | undefined): boolean {
    if (!session) return false;
    return Boolean(session.systemPrompt?.includes(SCHEDULE_SEED_MARKER));
  }

  private isDuplicate(fingerprint: string, cooldownMs: number): boolean {
    const current = this.nowMs();
    const previous = this.recentFingerprints.get(fingerprint);
    if (previous !== undefined && current - previous < cooldownMs) return true;
    this.recentFingerprints.set(fingerprint, current);
    if (this.recentFingerprints.size > 500) {
      for (const [key, at] of this.recentFingerprints) {
        if (current - at > 5 * 60_000) this.recentFingerprints.delete(key);
      }
    }
    return false;
  }

  async handleTurnEvent(event: RuntimeTurnEvent): Promise<{ dispatched: boolean; reason?: string }> {
    if (this.closed) return { dispatched: false, reason: 'closed' };
    const { config } = await this.readStoredState();
    const session = await this.options.repos.sessions.get(event.sessionId).catch(() => undefined);
    const isAssistantSubtask = this.options.isAssistantSubtask?.(event.sessionId) ?? false;
    const isScheduledSession = this.isScheduledSession(session);
    const decision = evaluateNotificationRule(event, config, { isAssistantSubtask, isScheduledSession });
    if (!decision.notify) return { dispatched: false, reason: decision.reason };

    // 同会话/任务短窗口防重复（待审批 30s 去重；同 taskId 终态 10s 去重）
    const cooldownMs = decision.kind === 'waiting_approval' ? 30_000 : 10_000;
    const fingerprint = decision.kind === 'waiting_approval'
      ? `${event.sessionId}:waiting_approval:${event.summary ?? ''}`
      : `${event.sessionId}:${event.taskId ?? 'no-task'}:${decision.kind}`;
    if (this.isDuplicate(fingerprint, cooldownMs)) {
      return { dispatched: false, reason: 'cooldown_deduped' };
    }

    const sessionUrl = await resolveSessionActionUrl({
      sessionId: event.sessionId,
      configRepo: this.options.repos.config,
      env: this.options.env
    });

    const payload: NotificationPayload = {
      id: event.id || makeId('ntf'),
      kind: decision.kind,
      sessionId: event.sessionId,
      ...(event.taskId ? { taskId: event.taskId } : {}),
      agentId: event.agentId,
      sessionTitle: event.sessionTitle?.trim() || session?.customTitle?.trim() || session?.agentTitle?.trim() || event.agentId || '未命名会话',
      ...(event.sessionSource ? { sessionSource: event.sessionSource } : {}),
      ...(event.sessionSourceId ? { sessionSourceId: event.sessionSourceId } : {}),
      ...(event.durationMs !== undefined ? { durationMs: event.durationMs } : {}),
      summary: summarizeNotificationText(event.summary, 240),
      ...(event.error ? { error: summarizeNotificationText(event.error, 240) } : {}),
      ...(sessionUrl ? { sessionUrl } : {}),
      timestamp: event.timestamp || now()
    };

    // 1) SSE 立即广播给所有前端/桌面端（客户端自行按焦点状态决定弹窗/提示音/未读点）
    this.emitter.emit('notification', payload);

    // 2) 远程/程序性通道入短窗合并队列（或立即发送）
    this.enqueueRemote(payload, config);
    return { dispatched: true };
  }

  /**
   * 接管 `agent-dock notify`（小猫主动提醒 / `--ask` 拍板 / `--urgent`）：
   * 广播到前端/桌面端，并分发到飞书/Webhook/本地 Hook；返回是否至少有一个通道（含已连接客户端或远程通道）成功送达。
   */
  async emitManualNotify(input: { text: string; ask: boolean; urgent: boolean; sessionId?: string }): Promise<boolean> {
    if (this.closed) return false;
    const { config } = await this.readStoredState();
    const session = input.sessionId ? await this.options.repos.sessions.get(input.sessionId).catch(() => undefined) : undefined;
    const sessionId = input.sessionId ?? '';
    const sessionUrl = sessionId
      ? await resolveSessionActionUrl({ sessionId, configRepo: this.options.repos.config, env: this.options.env })
      : undefined;

    const payload: NotificationPayload = {
      id: makeId('ntf'),
      kind: input.ask ? 'waiting_approval' : 'notify',
      sessionId,
      agentId: session?.agentId ?? 'assistant',
      sessionTitle: session?.customTitle?.trim() || session?.agentTitle?.trim() || '小猫主会话',
      ...(session?.source ? { sessionSource: session.source } : {}),
      ...(session?.sourceId ? { sessionSourceId: session.sourceId } : {}),
      summary: summarizeNotificationText(input.text, 260),
      urgent: input.urgent,
      ask: input.ask,
      ...(sessionUrl ? { sessionUrl } : {}),
      timestamp: now()
    };

    const hadSseClients = this.emitter.listenerCount('notification') > 0;
    this.emitter.emit('notification', payload);

    // 手动 notify（尤其 --ask / --urgent）不走合并延迟，直接并发推送已启用的远程通道。
    const results = await this.dispatchRemoteChannels(payload, config, { bypassAwayCheck: input.urgent || input.ask });
    return hadSseClients || results.some(result => result.ok);
  }

  private enqueueRemote(payload: NotificationPayload, config: StoredNotificationConfig): void {
    const hasRemote = config.lark.enabled
      || config.webhooks.some(hook => hook.enabled)
      || (config.commandHook.enabled && config.commandHook.trustConfirmed && Boolean(config.commandHook.command));
    if (!hasRemote) return;

    const windowMs = config.antiSpam.coalesceWindowMs;
    if (windowMs <= 0 || payload.kind === 'waiting_approval') {
      void this.dispatchRemoteChannels(payload, config);
      return;
    }

    this.pendingRemote.push(payload);
    if (this.coalesceTimer) return;
    this.coalesceTimer = setTimeout(() => {
      this.coalesceTimer = undefined;
      void this.flushRemoteQueue();
    }, windowMs);
    this.coalesceTimer.unref();
  }

  async flushRemoteQueue(): Promise<void> {
    if (!this.pendingRemote.length) return;
    const batch = this.pendingRemote.splice(0);
    const { config } = await this.readStoredState();
    const merged = coalescePayloads(batch);
    for (const item of merged) {
      await this.dispatchRemoteChannels(item, config);
    }
  }

  private recordDelivery(channelKey: string, result: DeliveryResult): void {
    this.lastDelivery.set(channelKey, {
      ok: result.ok,
      at: now(),
      durationMs: result.durationMs,
      ...(result.statusCode !== undefined ? { statusCode: result.statusCode } : {}),
      ...(result.detail ? { detail: result.detail } : {}),
      ...(result.error ? { error: result.error } : {})
    });
  }

  private async dispatchRemoteChannels(
    payload: NotificationPayload,
    config: StoredNotificationConfig,
    options: { bypassAwayCheck?: boolean } = {}
  ): Promise<DeliveryResult[]> {
    if (!options.bypassAwayCheck && config.antiSpam.remoteOnlyWhenAway && this.isAnyClientActive(config.antiSpam.awayAfterSec)) {
      return [];
    }

    const tasks: Array<Promise<DeliveryResult>> = [];

    if (config.lark.enabled) {
      tasks.push(
        deliverLarkNotification(config.lark, payload, {
          configRepo: this.options.repos.config,
          channelMappings: this.options.repos.channelMappings,
          env: this.options.env,
          fetcher: this.options.fetcher
        }).then(result => {
          this.recordDelivery('lark', result);
          if (!result.ok) this.log.warn(`飞书通知投递失败：${result.error}`);
          return result;
        })
      );
    }

    for (const hook of config.webhooks) {
      if (!hook.enabled) continue;
      if (hook.events?.length && payload.kind !== 'notify' && !hook.events.includes(payload.kind)) continue;
      tasks.push(
        deliverWebhookNotification(hook, payload, { fetcher: this.options.fetcher }).then(result => {
          this.recordDelivery(`webhook:${hook.id}`, result);
          if (!result.ok) this.log.warn(`Webhook(${hook.name}) 投递失败：${result.error}`);
          return result;
        })
      );
    }

    if (config.commandHook.enabled && config.commandHook.trustConfirmed && config.commandHook.command) {
      tasks.push(
        deliverCommandHook(config.commandHook, payload, {
          env: this.options.env,
          cwd: this.options.cwd
        }).then(result => {
          this.recordDelivery('command', result);
          if (!result.ok) this.log.warn(`本地命令 Hook 执行失败：${result.error}`);
          return result;
        })
      );
    }

    if (!tasks.length) return [];
    return Promise.all(tasks);
  }

  /** 发送测试通知：可测试已保存配置，也可直接测试前端尚未保存的草稿（密文自动回填）。 */
  async testChannel(input: TestNotificationInput): Promise<DeliveryResult & { channel: string }> {
    const { config: stored } = await this.readStoredState();
    const effective = input.draftConfig !== undefined
      ? parseAndMergeNotificationConfig(input.draftConfig, stored)
      : stored;

    const samplePayload: NotificationPayload = {
      id: makeId('ntf-test'),
      kind: 'completed',
      sessionId: 'ses_notification_test',
      agentId: 'AgentDock',
      sessionTitle: '测试通知 · AgentDock',
      durationMs: 18_000,
      summary: '这是一条来自 AgentDock 通知设置的测试消息。收到即表示当前通知通道配置已通畅！',
      timestamp: now()
    };

    if (input.channel === 'lark') {
      const result = await deliverLarkNotification(effective.lark, samplePayload, {
        configRepo: this.options.repos.config,
        channelMappings: this.options.repos.channelMappings,
        env: this.options.env,
        fetcher: this.options.fetcher
      });
      this.recordDelivery('lark', result);
      return { channel: 'lark', ...result };
    }

    if (input.channel === 'webhook') {
      const hook = input.webhookId
        ? effective.webhooks.find(item => item.id === input.webhookId)
        : effective.webhooks[0];
      if (!hook) throw new RuntimeError('WEBHOOK_NOT_FOUND', '未找到要测试的 Webhook 配置', 404);
      const result = await deliverWebhookNotification(hook, samplePayload, {
        fetcher: this.options.fetcher,
        retries: 0
      });
      this.recordDelivery(`webhook:${hook.id}`, result);
      return { channel: `webhook:${hook.id}`, ...result };
    }

    if (input.channel === 'command') {
      if (!effective.commandHook.trustConfirmed) {
        throw new RuntimeError('COMMAND_HOOK_TRUST_REQUIRED', '请先勾选确认本地命令 Hook 安全提示后再测试。', 400);
      }
      if (!effective.commandHook.command.trim()) {
        throw new RuntimeError('COMMAND_HOOK_EMPTY', '请先填写要测试的本地命令或脚本路径。', 400);
      }
      const result = await deliverCommandHook(effective.commandHook, samplePayload, {
        env: this.options.env,
        cwd: this.options.cwd
      });
      this.recordDelivery('command', result);
      return { channel: 'command', ...result };
    }

    throw new RuntimeError('INVALID_NOTIFICATION_CHANNEL', `不支持的测试通道：${String(input.channel)}`, 400);
  }
}

/**
 * 短窗合并：同类型且超过 1 条时合并成单条批量摘要，保留首条会话的直达链接。
 */
export function coalescePayloads(items: NotificationPayload[]): NotificationPayload[] {
  if (items.length <= 1) return items;
  const groups = new Map<NotificationEventKind, NotificationPayload[]>();
  for (const item of items) {
    const bucket = groups.get(item.kind);
    if (bucket) bucket.push(item);
    else groups.set(item.kind, [item]);
  }
  const merged: NotificationPayload[] = [];
  for (const [kind, bucket] of groups) {
    if (bucket.length === 1) {
      merged.push(bucket[0]!);
      continue;
    }
    const latest = bucket.at(-1)!;
    const titles = [...new Set(bucket.map(item => item.sessionTitle).filter(Boolean))];
    const previewList = titles.slice(0, 4).join('、') + (titles.length > 4 ? ` 等 ${titles.length} 个会话` : '');
    merged.push({
      ...latest,
      id: makeId('ntf-batch'),
      kind,
      batchCount: bucket.length,
      summary: `涉及会话：${previewList}`,
      ...(bucket.some(item => item.error)
        ? { error: bucket.map(item => item.error).filter(Boolean).slice(0, 2).join('；') }
        : {})
    });
  }
  return merged;
}
