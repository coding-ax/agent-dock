import {
  BUILTIN_ASK_USER_QUESTION_PLUGIN_ID,
  defaultOutputPluginRegistry,
  pickFinalAssistantText,
  resolveOutputPluginEnabled,
  type AgentEvent,
  type ChannelMappingRepository,
  type ConfigRepository,
  type OutputPluginRegistry,
  type RuntimeTurnEvent,
  type RuntimeTurnStartedEvent,
  type Session,
  type TaskRecord
} from '@agent-dock/agent-dock-shared';
import {
  defaultLarkTraceLimit,
  normalizeLarkTurnSyncConfig,
  readLarkConfig,
  type LarkTurnSyncConfig,
  type LarkTurnSyncConfigInput,
  type StoredLarkConfig
} from './config.js';
import {
  createLarkSessionBindingLookup,
  type LarkSessionBindingKind
} from './handover-binding.js';
import type { HandoverCatLike } from './kitten-handover.js';
import {
  eventsForRuntimeTask,
  isLarkCardContentRejected,
  isLarkMessageRateLimit,
  isLarkMessageUnupdatable,
  larkRateLimitBackoffMs,
  patchRejectedCardDelta,
  renderLarkCardElements
} from './listener.js';
import {
  boundLarkCardElements,
  type LarkCardService,
  type LarkCardSourceBadgeColor
} from './service.js';
import {
  defaultLarkOutputPluginAdapterRegistry,
  dispatchLarkOutputPluginCard,
  type LarkOutputPluginAdapterRegistry
} from './output-plugins/index.js';
import { readAskUserQuestionConfig } from '../ask-user-question.js';
import { readOutputPluginsGlobalConfig, type OutputPluginService } from '../output-plugins/service.js';
import type { LarkTurnTracker } from './turn-tracker.js';

export type LarkSyncTurnCategory = 'supervision' | 'web' | 'schedule' | 'maintenance';

export interface ClassifiedTurnSource {
  category: LarkSyncTurnCategory;
  /** 飞书卡片/文本顶部展示的轻巧来源徽标，如「🐾 小猫督办」「💻 网页同步」「⏰ 定时任务」 */
  badge: string;
  /** 不含 emoji 的来源简称 */
  label: string;
  /** 飞书卡片 <text_tag color='...'> 颜色 */
  tagColor: LarkCardSourceBadgeColor;
  /** 细分子类型（如验收督办 / 计划待确认 / 异常预警 / 看板联动） */
  detailLabel?: string;
}

const SUPERVISION_PREFIX_RE = /^(?:📋\s*督办|⏸\s*用户已停止)/;
const SUPERVISION_SENT_MARKER = '以下是 daemon 汇总的督办信号';
const SCHEDULE_PROMPT_RE = /^\[AgentDock 定时任务\s+([^\]]+)\]/;

/**
 * 归类一条非飞书触发轮次的来源，返回用于细粒度过滤的分类与卡片/文本徽标。
 * 分类优先级：整理维护（maintenance/handoff） > 系统督办（injected） > 定时任务（schedule） > Web/其他对话。
 */
export function classifyTurnSource(input: {
  taskOrigin?: string | null;
  prompt?: string | null;
  sentPrompt?: string | null;
}): ClassifiedTurnSource {
  const origin = (input.taskOrigin ?? '').trim();
  const prompt = (input.prompt ?? '').trim();
  const sentPrompt = (input.sentPrompt ?? '').trim();

  if (origin === 'handoff') {
    return {
      category: 'maintenance',
      badge: '🧹 交接说明',
      label: '交接说明',
      tagColor: 'neutral'
    };
  }
  if (origin === 'maintenance') {
    return {
      category: 'maintenance',
      badge: '🧹 整理维护',
      label: '整理维护',
      tagColor: 'neutral'
    };
  }

  if (
    origin === 'injected'
    || SUPERVISION_PREFIX_RE.test(prompt)
    || sentPrompt.includes(SUPERVISION_SENT_MARKER)
  ) {
    const combined = `${prompt}\n${sentPrompt}`;
    let detailLabel: string | undefined;
    if (/\[(?:failed|interrupted)\]|侧边会话(?:失败|超时)|卡死|停滞/.test(combined)) {
      detailLabel = '异常预警';
    } else if (/\[user_stopped\]|用户主动停止|用户已停止/.test(combined)) {
      detailLabel = '已暂停';
    } else if (/\[plan\]|计划待确认|待确认计划/.test(combined)) {
      detailLabel = '计划待确认';
    } else if (/\[needs_you\]|等权限确认|需要你拍板/.test(combined)) {
      detailLabel = '待确认';
    } else if (/\[review\]|等待验收|验收/.test(combined)) {
      detailLabel = '验收督办';
    }
    return {
      category: 'supervision',
      badge: '🐾 小猫督办',
      label: '小猫督办',
      tagColor: 'purple',
      ...(detailLabel ? { detailLabel } : {})
    };
  }

  if (origin === 'schedule' || SCHEDULE_PROMPT_RE.test(prompt)) {
    return {
      category: 'schedule',
      badge: '⏰ 定时任务',
      label: '定时任务',
      tagColor: 'orange'
    };
  }

  if (origin === 'board-mention') {
    return {
      category: 'web',
      badge: '💻 网页同步 · 看板',
      label: '网页同步',
      tagColor: 'blue',
      detailLabel: '看板联动'
    };
  }

  if (origin === 'emoji') {
    return {
      category: 'web',
      badge: '💻 表情触发',
      label: '表情触发',
      tagColor: 'blue'
    };
  }

  return {
    category: 'web',
    badge: '💻 网页同步',
    label: '网页同步',
    tagColor: 'blue'
  };
}

export function isTurnCategoryEnabled(config: LarkTurnSyncConfig, category: LarkSyncTurnCategory): boolean {
  if (!config.enabled) return false;
  return config.sources[category] === true;
}

const SILENT_SENTINEL_TOKENS = new Set([
  'heartbeat_ok',
  'no_op',
  'noop',
  'silent',
  'skip',
  'none',
  'nothing_to_report',
  'ok'
]);

const SILENT_NOOP_SENTENCE_RE = /^(?:(?:本次|当前|暂|目前)?(?:无|没有)(?:新消息|新动态|新变化|变化|异常|更新|待办|事项|内容|需要处理的(?:事项|问题|任务)?)|一切正常|状态正常|无需(?:处理|操作|汇报|回复|行动)|静默跳过|无动作|跳过本次|no\s+(?:updates?|changes?|new\s+messages?|action\s+(?:needed|required))|nothing\s+(?:new|to\s+report)|all\s+clear)[。！!.~\s]*$/i;

/**
 * 判定定时任务轮次的最终输出是否为「静默 / 无动作」结果。
 * 保守判定：失败/中断永远不过滤；只有完全匹配哨兵标记或纯无动作短句时才过滤。
 */
export function isSilentScheduledOutput(
  finalText: string | undefined,
  state: 'completed' | 'failed' | 'interrupted'
): boolean {
  if (state !== 'completed') return false;
  const trimmed = (finalText ?? '').trim();
  if (!trimmed) return true;
  const normalizedToken = trimmed.replace(/^[`"'*_\[\]（）()【】\s]+|[`"'*_\[\]（）()【】.。!！~\s]+$/g, '').toLowerCase();
  if (SILENT_SENTINEL_TOKENS.has(normalizedToken)) return true;
  if (trimmed.length <= 100 && SILENT_NOOP_SENTENCE_RE.test(trimmed)) {
    return true;
  }
  return false;
}

/**
 * 防御性凭据脱敏：避免 Agent 误打印的内部 token、Bearer 凭证或机器人 App Secret 泄露到飞书群。
 */
export function redactSensitiveContent(text: string, extraSecrets: readonly (string | undefined)[] = []): string {
  if (!text) return text;
  let result = text;
  for (const secret of extraSecrets) {
    const trimmed = secret?.trim();
    if (trimmed && trimmed.length >= 6) {
      result = result.replaceAll(trimmed, '[REDACTED]');
    }
  }
  result = result
    .replace(/(agentdock_group_tools_token\s*[=:]\s*['"]?)([^\s'",}\]]+)/gi, '$1[REDACTED]')
    .replace(/(Authorization\s*:\s*Bearer\s+)([^\s'",}\]]+)/gi, '$1[REDACTED]')
    .replace(/(app_secret\s*[=:"']+\s*)([^\s'",}\]]+)/gi, '$1[REDACTED]')
    .replace(/\bv1\.[A-Za-z0-9_-]{32,}\b/g, '[REDACTED]');
  return result;
}

function sanitizeEventForSync(event: AgentEvent, secrets: readonly (string | undefined)[]): AgentEvent {
  if (!event.data || typeof event.data !== 'object') return event;
  const data = event.data as Record<string, unknown>;
  let changed = false;
  const next: Record<string, unknown> = { ...data };
  for (const key of ['text', 'message', 'output', 'title'] as const) {
    if (typeof data[key] === 'string') {
      const sanitized = redactSensitiveContent(data[key] as string, secrets);
      if (sanitized !== data[key]) {
        next[key] = sanitized;
        changed = true;
      }
    }
  }
  if (typeof data.input === 'string') {
    const sanitized = redactSensitiveContent(data.input, secrets);
    if (sanitized !== data.input) {
      next.input = sanitized;
      changed = true;
    }
  }
  return changed ? { ...event, data: next } : event;
}

/** 提炼绑定群同步卡片/文本顶部的简洁任务摘要（绝不暴露原始结构化 JSON 或系统提示词）。 */
export function formatSyncedTaskName(
  prompt: string | undefined,
  source: ClassifiedTurnSource,
  pluginRegistry: OutputPluginRegistry = defaultOutputPluginRegistry,
  taskOrigin?: string | null,
  secrets: readonly (string | undefined)[] = []
): string {
  const raw = (prompt ?? '').trim();
  if (taskOrigin) {
    const parsedInteraction = pluginRegistry.parseInteractionEvent(taskOrigin, raw);
    if (parsedInteraction) {
      const summary = parsedInteraction.plugin.summarizeInteraction?.(parsedInteraction.payload)
        ?? `已响应「${parsedInteraction.plugin.name}」`;
      return redactSensitiveContent(summary.replace(/\s+/g, ' ').trim(), secrets).slice(0, 80);
    }
  }
  if (source.category === 'schedule') {
    const matched = SCHEDULE_PROMPT_RE.exec(raw);
    if (matched?.[1]) {
      const parts = matched[1].split('·').map(item => item.trim()).filter(Boolean);
      const header = parts.length > 1 ? parts.slice(1).join(' · ') : matched[1].trim();
      return redactSensitiveContent(header, secrets).slice(0, 80);
    }
  }
  let compact = raw.replace(/\s+/g, ' ').trim();
  if (!compact) return source.detailLabel ?? source.label;
  if (source.category === 'supervision' && source.detailLabel) {
    const cleaned = compact.replace(/^📋\s*督办\s*·\s*/, '').trim();
    if (cleaned && !cleaned.includes(source.detailLabel)) {
      compact = `${source.detailLabel} · ${cleaned}`;
    } else if (cleaned) {
      compact = cleaned;
    }
  } else if (source.category === 'web' && !taskOrigin) {
    compact = `问：${compact}`;
  }
  return redactSensitiveContent(compact, secrets).slice(0, 80);
}

type SyncLog = {
  info(details: unknown, message?: string): void;
  warn(details: unknown, message?: string): void;
  error(details: unknown, message?: string): void;
};

export interface LarkTurnSyncRuntime {
  getSession(id: string): Promise<Session | undefined>;
  getTasks?(id: string): Promise<TaskRecord[]>;
  getRecentEvents?(id: string, limit: number): Promise<AgentEvent[]>;
  getEvents?(id: string, afterSequence?: number): Promise<AgentEvent[]>;
  subscribe(sessionId: string, listener: (event: AgentEvent) => void): () => void;
  onTurnStart?(listener: (event: RuntimeTurnStartedEvent) => void): () => void;
  onTurnEvent(listener: (event: RuntimeTurnEvent) => void): () => void;
}

export type LarkTurnSyncCardPort = Pick<LarkCardService, 'send' | 'update' | 'sendText'> & Partial<Pick<LarkCardService, 'sendInteractiveCard'>>;

export interface LarkTurnSyncServiceOptions {
  runtime: LarkTurnSyncRuntime;
  configRepository: ConfigRepository;
  cardMappings: ChannelMappingRepository;
  turnTracker: LarkTurnTracker;
  resolveService: (appId: string) => Promise<LarkTurnSyncCardPort>;
  log: SyncLog;
  getLineage?: () => HandoverCatLike[];
  outputPlugins?: OutputPluginService;
  larkPluginAdapters?: LarkOutputPluginAdapterRegistry;
  nowMs?: () => number;
}

export type LarkTurnSyncOutcome =
  | { action: 'synced_card'; messageId: string; category: LarkSyncTurnCategory; chatId: string; appId: string; chatType?: 'group' | 'p2p'; bindingKind?: LarkSessionBindingKind }
  | { action: 'synced_text'; messageId: string; category: LarkSyncTurnCategory; chatId: string; appId: string; chatType?: 'group' | 'p2p'; bindingKind?: LarkSessionBindingKind }
  | { action: 'finalized_deduped_card'; messageId: string; category: LarkSyncTurnCategory; chatId: string; appId: string; chatType?: 'group' | 'p2p'; bindingKind?: LarkSessionBindingKind }
  | { action: 'skipped'; reason: string };

interface ResolvedSyncTarget {
  appId: string;
  chatId: string;
  receiveIdType: 'chat_id' | 'open_id';
  chatType: 'group' | 'p2p';
  kind: LarkSessionBindingKind;
  turnSyncOverride?: LarkTurnSyncConfigInput;
}

type PendingCardUpdate = {
  input: Parameters<LarkTurnSyncCardPort['update']>[0];
  terminal: boolean;
  completed: boolean;
};

interface ActiveSyncedTurn {
  sessionId: string;
  taskId: string;
  target: ResolvedSyncTarget;
  botConfig: StoredLarkConfig;
  syncConfig: LarkTurnSyncConfig;
  source: ClassifiedTurnSource;
  prompt: string;
  taskOrigin?: string;
  taskName: string;
  startedAt: number;
  events: AgentEvent[];
  cardMessageId?: string;
  lastSuccessfulElements?: Record<string, unknown>[];
  sentViaGroupTool: boolean;
  settling: boolean;
  settled: boolean;
  heartbeatTimer?: NodeJS.Timeout;
  /** 正在进行中的首帧建卡 Promise，终态收口必须等待它落定，杜绝并发发出两张卡片。 */
  streamingSendPromise?: Promise<void>;
  updateChain?: Promise<void>;
  pendingUpdate?: PendingCardUpdate;
  cardRateLimitFailures: number;
  cardRateLimitedUntil: number;
  unsubscribeEvents: () => void;
  enabledOutputPluginIds?: Set<string>;
}

const MAX_SYNCED_TERMINAL_TASKS = 5_000;

/**
 * 绑定飞书会话全轮次实时同步服务。
 *
 * 将非飞书入站触发的轮次（系统督办、Web/桌面对话、定时任务、可选整理维护）自动实时同步至
 * 会话绑定的飞书群主线程或飞书私聊：
 * - 覆盖全部绑定形态：普通托管群、主小猫托管群（含换代交接血缘继承）、普通飞书群聊会话、普通飞书私聊会话；
 * - 支持机器人默认策略 + 会话/托管群级覆盖策略；
 * - 复用机器人的 Trace 流式卡片 / 静默文本回复策略、推送间隔与阶段上限；
 * - 自动追踪同轮 `group send` 主动发送并去重，杜绝双倍消息与机器人自激循环；
 * - 与纯 XML 交互插件体系（LarkOutputPluginAdapterRegistry）无缝衔接。
 */
export class LarkTurnSyncService {
  private readonly bindingLookup: ReturnType<typeof createLarkSessionBindingLookup>;
  private readonly activeTurns = new Map<string, ActiveSyncedTurn>();
  private readonly settlingTerminalTasks = new Set<string>();
  private readonly syncedTerminalTasks = new Set<string>();
  private readonly inflightOperations = new Set<Promise<unknown>>();
  private readonly nowMs: () => number;
  private readonly larkPluginAdapters: LarkOutputPluginAdapterRegistry;
  private unsubscribeStart?: () => void;
  private unsubscribeTurn?: () => void;
  private unsubscribeGroupSend?: () => void;
  private stopped = false;

  constructor(private readonly options: LarkTurnSyncServiceOptions) {
    this.bindingLookup = createLarkSessionBindingLookup(
      options.configRepository,
      options.cardMappings,
      sessionId => options.runtime.getSession(sessionId),
      options.getLineage
    );
    this.nowMs = options.nowMs ?? Date.now;
    this.larkPluginAdapters = options.larkPluginAdapters ?? defaultLarkOutputPluginAdapterRegistry;
  }

  private get pluginRegistry(): OutputPluginRegistry {
    return this.options.outputPlugins?.registry ?? defaultOutputPluginRegistry;
  }

  start(): void {
    if (this.unsubscribeTurn) return;
    if (typeof this.options.runtime.onTurnEvent !== 'function') return;
    this.stopped = false;
    if (typeof this.options.runtime.onTurnStart === 'function') {
      this.unsubscribeStart = this.options.runtime.onTurnStart(event => {
        this.track(this.handleTurnStart(event).catch(error => {
          this.options.log.warn({ error, sessionId: event.sessionId, taskId: event.taskId }, '飞书绑定群全轮次同步启动跟踪失败');
        }));
      });
    }
    this.unsubscribeTurn = this.options.runtime.onTurnEvent(event => {
      if (event.kind === 'waiting_approval') return;
      this.track(this.handleTurnEvent(event).catch(error => {
        this.options.log.warn({ error, sessionId: event.sessionId, taskId: event.taskId, kind: event.kind }, '飞书绑定群全轮次同步终态转发失败');
      }));
    });
    this.unsubscribeGroupSend = this.options.turnTracker.onGroupSend(record => {
      for (const turn of this.activeTurns.values()) {
        if (turn.sessionId === record.sessionId && turn.target.chatId === record.chatId && record.timestamp >= turn.startedAt) {
          turn.sentViaGroupTool = true;
          if (turn.heartbeatTimer) {
            clearTimeout(turn.heartbeatTimer);
            turn.heartbeatTimer = undefined;
          }
        }
      }
    });
  }

  close(): void {
    this.stopped = true;
    this.unsubscribeStart?.();
    this.unsubscribeStart = undefined;
    this.unsubscribeTurn?.();
    this.unsubscribeTurn = undefined;
    this.unsubscribeGroupSend?.();
    this.unsubscribeGroupSend = undefined;
    for (const turn of this.activeTurns.values()) {
      this.cleanupTurn(turn);
    }
    this.activeTurns.clear();
    this.settlingTerminalTasks.clear();
  }

  /** 供测试等待所有异步回调落定。 */
  async flushPending(): Promise<void> {
    while (this.inflightOperations.size > 0) {
      await Promise.allSettled([...this.inflightOperations]);
    }
  }

  private track<T>(promise: Promise<T>): Promise<T> {
    this.inflightOperations.add(promise);
    void promise.finally(() => this.inflightOperations.delete(promise));
    return promise;
  }

  private cleanupTurn(turn: ActiveSyncedTurn): void {
    turn.settled = true;
    if (turn.heartbeatTimer) {
      clearTimeout(turn.heartbeatTimer);
      turn.heartbeatTimer = undefined;
    }
    try { turn.unsubscribeEvents(); } catch { /* ignore */ }
    this.activeTurns.delete(turn.taskId);
  }

  private markTerminalSynced(taskId: string | undefined): void {
    if (!taskId) return;
    this.syncedTerminalTasks.add(taskId);
    if (this.syncedTerminalTasks.size > MAX_SYNCED_TERMINAL_TASKS) {
      const oldest = this.syncedTerminalTasks.values().next().value;
      if (oldest) this.syncedTerminalTasks.delete(oldest);
    }
  }

  private recipientFor(target: Pick<ResolvedSyncTarget, 'chatId' | 'receiveIdType'>): { chatId: string } | { receiveId: string; receiveIdType: 'open_id' } {
    if (target.receiveIdType === 'open_id') {
      return { receiveId: target.chatId, receiveIdType: 'open_id' };
    }
    return { chatId: target.chatId };
  }

  private async resolveTarget(
    sessionId: string,
    hint?: { sessionSource?: string; sessionSourceId?: string }
  ): Promise<ResolvedSyncTarget | undefined> {
    const binding = await this.bindingLookup(sessionId, hint).catch(() => undefined);
    if (!binding) return undefined;
    return {
      appId: binding.appId,
      chatId: binding.chatId,
      receiveIdType: binding.receiveIdType,
      chatType: binding.chatType,
      kind: binding.kind,
      ...(binding.turnSync ? { turnSyncOverride: binding.turnSync } : {})
    };
  }

  private async resolveEnabledOutputPluginIds(sessionId: string): Promise<Set<string>> {
    const session = await this.options.runtime.getSession(sessionId).catch(() => undefined);
    if (this.options.outputPlugins) {
      return this.options.outputPlugins.enabledPluginIdsForSession(session);
    }
    const globalState = await readOutputPluginsGlobalConfig(this.options.configRepository);
    const askGlobal = (await readAskUserQuestionConfig(this.options.configRepository)).askUserQuestionXmlEnabled;
    const mergedGlobal = {
      plugins: {
        [BUILTIN_ASK_USER_QUESTION_PLUGIN_ID]: askGlobal,
        ...globalState.config.plugins
      }
    };
    const enabled = new Set<string>();
    for (const plugin of this.pluginRegistry.list()) {
      if (resolveOutputPluginEnabled(plugin.id, {
        defaultEnabled: plugin.defaultEnabled,
        globalConfig: mergedGlobal,
        sessionOverrides: session?.outputPlugins,
        legacySessionAskEnabled: session?.askUserQuestionEnabled
      })) {
        enabled.add(plugin.id);
      }
    }
    return enabled;
  }

  private async pushTrailingOutputPluginCard(input: {
    service: LarkTurnSyncCardPort;
    turn: ActiveSyncedTurn;
    pluginId: string;
    spec: unknown;
  }): Promise<string | undefined> {
    const dispatched = await dispatchLarkOutputPluginCard({
      pluginRegistry: this.pluginRegistry,
      larkPluginAdapters: this.larkPluginAdapters,
      service: input.service,
      turnTracker: this.options.turnTracker,
      cardMappings: this.options.cardMappings,
      appId: input.turn.target.appId,
      sessionId: input.turn.sessionId,
      taskId: input.turn.taskId,
      chatId: input.turn.target.chatId,
      receiveIdType: input.turn.target.receiveIdType,
      chatType: input.turn.target.chatType,
      webBaseUrl: input.turn.botConfig.webBaseUrl,
      pluginId: input.pluginId,
      spec: input.spec
    });
    return dispatched?.messageId;
  }

  private secretsFor(config: StoredLarkConfig): string[] {
    return config.appSecret ? [config.appSecret] : [];
  }

  private isGroupSentForTurn(turn: Pick<ActiveSyncedTurn, 'sessionId' | 'target' | 'startedAt' | 'sentViaGroupTool'>): boolean {
    return turn.sentViaGroupTool
      || this.options.turnTracker.hasGroupSendSince(turn.sessionId, turn.target.chatId, turn.startedAt);
  }

  private scheduleHeartbeat(turn: ActiveSyncedTurn): void {
    if (this.stopped || turn.settled || turn.settling || turn.heartbeatTimer) return;
    if (turn.botConfig.quietReply) return;
    if (turn.source.category === 'schedule' && turn.syncConfig.filterSilentSchedule) return;
    if (this.isGroupSentForTurn(turn)) {
      turn.sentViaGroupTool = true;
      return;
    }
    const delay = Math.max(turn.botConfig.pushIntervalMs, turn.cardRateLimitedUntil - this.nowMs());
    turn.heartbeatTimer = setTimeout(() => {
      turn.heartbeatTimer = undefined;
      if (this.stopped || turn.settled || turn.settling) return;
      if (this.isGroupSentForTurn(turn)) {
        turn.sentViaGroupTool = true;
        return;
      }
      this.track(this.pushStreamingFrame(turn).catch(error => {
        this.options.log.warn({ error, sessionId: turn.sessionId, taskId: turn.taskId }, '飞书绑定群同步流式心跳更新失败');
      }).finally(() => {
        this.scheduleHeartbeat(turn);
      }));
    }, Math.max(50, delay));
    turn.heartbeatTimer.unref?.();
  }

  private async pushStreamingFrame(turn: ActiveSyncedTurn): Promise<void> {
    if (this.stopped || turn.settled || turn.settling) return;
    if (this.isGroupSentForTurn(turn)) {
      turn.sentViaGroupTool = true;
      return;
    }
    const secrets = this.secretsFor(turn.botConfig);
    if (!turn.enabledOutputPluginIds) {
      turn.enabledOutputPluginIds = await this.resolveEnabledOutputPluginIds(turn.sessionId);
    }
    const sanitizedEvents = turn.events.map(event => sanitizeEventForSync(event, secrets));
    const elements = boundLarkCardElements(renderLarkCardElements(sanitizedEvents, turn.botConfig, false, false, {
      outputPluginRegistry: this.pluginRegistry,
      enabledOutputPluginIds: turn.enabledOutputPluginIds,
      larkPluginAdapters: this.larkPluginAdapters
    }));
    const elapsedSeconds = Math.max(0, (this.nowMs() - turn.startedAt) / 1_000);
    const service = await this.options.resolveService(turn.target.appId);

    if (!turn.cardMessageId) {
      // 发送前再次确认，避免异步解析期间刚好结束或调用了 group send。
      if (this.stopped || turn.settled || turn.settling || this.isGroupSentForTurn(turn)) return;
      if (turn.streamingSendPromise) {
        await turn.streamingSendPromise;
        return;
      }
      const sendOp = (async () => {
        const sent = await service.send({
          ...this.recipientFor(turn.target),
          state: 'running',
          readOnly: true,
          sourceBadge: { label: turn.source.badge, color: turn.source.tagColor },
          taskId: turn.taskId,
          taskName: turn.taskName,
          elapsedSeconds,
          sessionId: turn.sessionId,
          ...(turn.botConfig.webBaseUrl ? { webBaseUrl: turn.botConfig.webBaseUrl } : {}),
          elements,
          idempotencyKey: `tsync_${turn.taskId}`.slice(0, 50)
        });
        turn.cardMessageId = sent.messageId;
        turn.lastSuccessfulElements = elements;
        this.options.turnTracker.markOutboundMessage(sent.messageId);
      })();
      turn.streamingSendPromise = sendOp;
      try {
        await sendOp;
      } finally {
        if (turn.streamingSendPromise === sendOp) turn.streamingSendPromise = undefined;
      }
      return;
    }

    turn.pendingUpdate = {
      terminal: false,
      completed: false,
      input: {
        messageId: turn.cardMessageId,
        state: 'running',
        readOnly: true,
        sourceBadge: { label: turn.source.badge, color: turn.source.tagColor },
        taskId: turn.taskId,
        taskName: turn.taskName,
        elapsedSeconds,
        sessionId: turn.sessionId,
        ...(turn.botConfig.webBaseUrl ? { webBaseUrl: turn.botConfig.webBaseUrl } : {}),
        elements
      }
    };
    await this.flushCardUpdates(turn, service);
  }

  private flushCardUpdates(turn: ActiveSyncedTurn, service: LarkTurnSyncCardPort): Promise<void> {
    if (turn.updateChain) return turn.updateChain;
    turn.updateChain = (async () => {
      while (turn.pendingUpdate) {
        const pending = turn.pendingUpdate;
        turn.pendingUpdate = undefined;
        let lastError: unknown;
        let contentRejected = false;
        const attempts = pending.terminal ? 3 : 1;
        for (let attempt = 1; attempt <= attempts; attempt++) {
          try {
            await service.update(pending.input);
            lastError = undefined;
            if (pending.input.elements) turn.lastSuccessfulElements = pending.input.elements;
            turn.cardRateLimitFailures = 0;
            turn.cardRateLimitedUntil = 0;
            break;
          } catch (error) {
            lastError = error;
            if (isLarkCardContentRejected(error)) {
              contentRejected = true;
              break;
            }
            if (isLarkMessageRateLimit(error)) {
              turn.cardRateLimitFailures += 1;
              turn.cardRateLimitedUntil = this.nowMs() + larkRateLimitBackoffMs(turn.cardRateLimitFailures);
            }
            if (attempt < attempts) {
              const delay = isLarkMessageRateLimit(error)
                ? Math.max(0, turn.cardRateLimitedUntil - this.nowMs())
                : attempt * 300;
              await new Promise(resolve => setTimeout(resolve, Math.min(delay, 5_000)));
            }
          }
        }
        if (lastError && contentRejected && turn.lastSuccessfulElements?.length) {
          const patched = patchRejectedCardDelta(turn.lastSuccessfulElements, pending.input.elements);
          try {
            await service.update({ ...pending.input, elements: patched, markdown: undefined });
            turn.lastSuccessfulElements = patched;
            lastError = undefined;
          } catch (error) {
            lastError = error;
          }
        }
        if (lastError && pending.terminal && isLarkMessageUnupdatable(lastError)) {
          const replacementElements = contentRejected
            ? patchRejectedCardDelta(turn.lastSuccessfulElements, pending.input.elements)
            : pending.input.elements;
          const sent = await service.send({
            ...this.recipientFor(turn.target),
            state: pending.input.state,
            readOnly: true,
            sourceBadge: pending.input.sourceBadge,
            taskId: pending.input.taskId,
            taskName: pending.input.taskName,
            elapsedSeconds: pending.input.elapsedSeconds,
            sessionId: pending.input.sessionId,
            ...(pending.input.webBaseUrl ? { webBaseUrl: pending.input.webBaseUrl } : {}),
            elements: replacementElements,
            idempotencyKey: `tsync_c_${turn.taskId}_${pending.input.state}`.slice(0, 50)
          });
          turn.cardMessageId = sent.messageId;
          this.options.turnTracker.markOutboundMessage(sent.messageId);
        } else if (lastError && pending.terminal) {
          this.options.log.warn({ error: lastError, sessionId: turn.sessionId, taskId: turn.taskId, messageId: pending.input.messageId }, '更新飞书同步终态卡片失败');
        }
      }
    })().finally(() => {
      turn.updateChain = undefined;
      if (turn.pendingUpdate) void this.flushCardUpdates(turn, service);
    });
    return turn.updateChain;
  }

  /**
   * 轮次正式开始时的入口：判定该轮是否属于受同步的非飞书轮次，并按机器人策略挂载事件订阅与流式心跳。
   */
  async handleTurnStart(event: RuntimeTurnStartedEvent): Promise<{ tracked: boolean; reason?: string }> {
    if (this.stopped) return { tracked: false, reason: 'stopped' };
    if (this.activeTurns.has(event.taskId)) return { tracked: true };

    await this.options.turnTracker.waitForPendingLarkDispatch(event.sessionId);
    if (this.options.turnTracker.isLarkOwnedTask(event.taskId) || this.options.turnTracker.isLarkSendActive(event.sessionId)) {
      return { tracked: false, reason: 'lark_owned' };
    }

    const target = await this.resolveTarget(event.sessionId, {
      sessionSource: event.sessionSource,
      sessionSourceId: event.sessionSourceId
    });
    if (!target) return { tracked: false, reason: 'unbound' };

    const botConfig = await readLarkConfig(this.options.configRepository, target.appId);
    if (!botConfig) return { tracked: false, reason: 'bot_not_found' };

    const syncConfig = normalizeLarkTurnSyncConfig(target.turnSyncOverride, normalizeLarkTurnSyncConfig(botConfig.turnSync));
    const source = classifyTurnSource({ taskOrigin: event.taskOrigin, prompt: event.prompt });
    if (!isTurnCategoryEnabled(syncConfig, source.category)) {
      return { tracked: false, reason: `category_disabled:${source.category}` };
    }

    const secrets = this.secretsFor(botConfig);
    const taskName = formatSyncedTaskName(event.prompt, source, this.pluginRegistry, event.taskOrigin, secrets);
    const maxBufferedEvents = Math.max((botConfig.traceLimit ?? defaultLarkTraceLimit) * 20, 200);
    const startedAt = this.nowMs();

    const turn: ActiveSyncedTurn = {
      sessionId: event.sessionId,
      taskId: event.taskId,
      target,
      botConfig,
      syncConfig,
      source,
      prompt: event.prompt,
      ...(event.taskOrigin ? { taskOrigin: event.taskOrigin } : {}),
      taskName,
      startedAt,
      events: [],
      sentViaGroupTool: false,
      settling: false,
      settled: false,
      cardRateLimitFailures: 0,
      cardRateLimitedUntil: 0,
      unsubscribeEvents: () => {}
    };

    turn.unsubscribeEvents = this.options.runtime.subscribe(event.sessionId, agentEvent => {
      if (turn.settled) return;
      if (agentEvent.type === 'task') {
        const record = (agentEvent.data as Record<string, any> | undefined)?.task;
        if (record?.id && record.id !== turn.taskId) return;
      }
      turn.events.push(agentEvent);
      if (turn.events.length > maxBufferedEvents) {
        turn.events = turn.events.slice(-maxBufferedEvents);
      }
    });

    this.activeTurns.set(event.taskId, turn);
    this.scheduleHeartbeat(turn);
    return { tracked: true };
  }

  private async reloadTurnEvents(
    sessionId: string,
    config: StoredLarkConfig,
    fallback: AgentEvent[],
    taskId?: string
  ): Promise<AgentEvent[]> {
    if (!taskId) return fallback;
    const limit = Math.max((config.traceLimit ?? defaultLarkTraceLimit) * 30, 500);
    try {
      const persisted = this.options.runtime.getRecentEvents
        ? await this.options.runtime.getRecentEvents(sessionId, limit)
        : this.options.runtime.getEvents
          ? await this.options.runtime.getEvents(sessionId)
          : undefined;
      if (!persisted?.length) return fallback;
      const scoped = eventsForRuntimeTask(persisted, taskId);
      if (!scoped.length) return fallback;
      const seen = new Set(scoped.map(item => item.id));
      const extra = fallback.filter(item => !seen.has(item.id));
      return extra.length ? [...scoped, ...extra] : scoped;
    } catch {
      return fallback;
    }
  }

  private async lookupTaskRecord(sessionId: string, taskId: string | undefined): Promise<TaskRecord | undefined> {
    if (!taskId || !this.options.runtime.getTasks) return undefined;
    try {
      const tasks = await this.options.runtime.getTasks(sessionId);
      return tasks.find(item => item.id === taskId);
    } catch {
      return undefined;
    }
  }

  private formatQuietText(input: {
    source: ClassifiedTurnSource;
    taskName: string;
    body: string;
    state: 'completed' | 'failed' | 'interrupted';
    error?: string;
  }): string {
    const header = input.taskName && input.taskName !== input.source.label
      ? `【${input.source.badge}】${input.taskName}`
      : `【${input.source.badge}】`;
    const body = input.body.trim();
    const errorLine = input.state === 'failed'
      ? (input.error?.trim() ? `错误：${input.error.trim()}` : '任务未完全成功，详见 AgentDock Web 会话记录。')
      : input.state === 'interrupted'
        ? '任务已被取消。'
        : '';
    const parts = [header];
    if (body) parts.push(body);
    if (errorLine && (!body || !body.includes(errorLine))) parts.push(`（${errorLine}）`);
    if (parts.length === 1) parts.push('（Agent 未返回最终输出）');
    return parts.join('\n\n');
  }

  /**
   * 轮次终态入口：执行同轮 group send 去重、静默定时任务过滤，并按机器人配置交付卡片或纯文本。
   */
  async handleTurnEvent(event: RuntimeTurnEvent): Promise<LarkTurnSyncOutcome> {
    if (this.stopped) return { action: 'skipped', reason: 'stopped' };
    if (event.kind === 'waiting_approval') return { action: 'skipped', reason: 'waiting_approval' };

    const taskId = event.taskId;
    if (taskId && (this.syncedTerminalTasks.has(taskId) || this.settlingTerminalTasks.has(taskId))) {
      return { action: 'skipped', reason: 'already_synced' };
    }
    if (taskId) this.settlingTerminalTasks.add(taskId);
    try {
      return await this.processTurnEvent(event);
    } finally {
      if (taskId) this.settlingTerminalTasks.delete(taskId);
    }
  }

  private async processTurnEvent(event: RuntimeTurnEvent): Promise<LarkTurnSyncOutcome> {
    const taskId = event.taskId;
    await this.options.turnTracker.waitForPendingLarkDispatch(event.sessionId);
    if (this.options.turnTracker.isLarkOwnedTask(taskId) || this.options.turnTracker.isLarkSendActive(event.sessionId)) {
      const active = taskId ? this.activeTurns.get(taskId) : undefined;
      if (active) this.cleanupTurn(active);
      return { action: 'skipped', reason: 'lark_owned' };
    }

    let turn = taskId ? this.activeTurns.get(taskId) : undefined;
    const taskRecord = await this.lookupTaskRecord(event.sessionId, taskId);

    if (!turn) {
      // 未经历 onTurnStart（如重连失败、单测直发 onTurnEvent 或重启后终态）的兜底路径。
      const target = await this.resolveTarget(event.sessionId, {
        sessionSource: event.sessionSource,
        sessionSourceId: event.sessionSourceId
      });
      if (!target) return { action: 'skipped', reason: 'unbound' };

      const botConfig = await readLarkConfig(this.options.configRepository, target.appId);
      if (!botConfig) return { action: 'skipped', reason: 'bot_not_found' };

      const syncConfig = normalizeLarkTurnSyncConfig(target.turnSyncOverride, normalizeLarkTurnSyncConfig(botConfig.turnSync));
      const prompt = taskRecord?.prompt ?? '';
      const sentPrompt = taskRecord?.sentPrompt ?? '';
      const taskOrigin = event.taskOrigin ?? taskRecord?.origin ?? undefined;
      const source = classifyTurnSource({ taskOrigin, prompt, sentPrompt });
      if (!isTurnCategoryEnabled(syncConfig, source.category)) {
        return { action: 'skipped', reason: `category_disabled:${source.category}` };
      }

      // 用户主动取消且从未发过流式卡片：静默跳过，不打扰群聊。
      if (event.kind === 'interrupted' && event.interruptIntent === 'user') {
        return { action: 'skipped', reason: 'user_interrupted' };
      }

      const startedAt = taskRecord?.createdAt && Number.isFinite(Date.parse(taskRecord.createdAt))
        ? Date.parse(taskRecord.createdAt)
        : Math.max(0, this.nowMs() - (event.durationMs ?? 0));
      const secrets = this.secretsFor(botConfig);
      turn = {
        sessionId: event.sessionId,
        taskId: taskId ?? `sync_${event.id}`,
        target,
        botConfig,
        syncConfig,
        source,
        prompt,
        ...(taskOrigin ? { taskOrigin } : {}),
        taskName: formatSyncedTaskName(prompt, source, this.pluginRegistry, taskOrigin, secrets),
        startedAt,
        events: [],
        sentViaGroupTool: false,
        settling: true,
        settled: false,
        cardRateLimitFailures: 0,
        cardRateLimitedUntil: 0,
        unsubscribeEvents: () => {}
      };
    } else {
      turn.settling = true;
      if (turn.heartbeatTimer) {
        clearTimeout(turn.heartbeatTimer);
        turn.heartbeatTimer = undefined;
      }
      // 终态拿到完整 sentPrompt 后细化督办徽标摘要（例如补充「验收督办」「异常预警」）。
      if (taskRecord?.sentPrompt && turn.source.category === 'supervision' && !turn.source.detailLabel) {
        const refined = classifyTurnSource({
          taskOrigin: turn.taskOrigin,
          prompt: turn.prompt || taskRecord.prompt,
          sentPrompt: taskRecord.sentPrompt
        });
        turn.source = refined;
        turn.taskName = formatSyncedTaskName(
          turn.prompt || taskRecord.prompt,
          refined,
          this.pluginRegistry,
          turn.taskOrigin,
          this.secretsFor(turn.botConfig)
        );
      }
    }

    // 等待正在进行的流式首帧建卡与更新完成，确保 cardMessageId 状态稳定后再收口终态。
    if (turn.streamingSendPromise) {
      await turn.streamingSendPromise.catch(() => undefined);
    }
    if (turn.updateChain) {
      await turn.updateChain.catch(() => undefined);
    }

    const state: 'completed' | 'failed' | 'interrupted' = event.kind === 'completed'
      ? 'completed'
      : event.kind === 'failed'
        ? 'failed'
        : 'interrupted';

    // 用户主动取消且尚未发过流式卡片：静默退出。
    if (state === 'interrupted' && event.interruptIntent === 'user' && !turn.cardMessageId) {
      this.cleanupTurn(turn);
      this.markTerminalSynced(taskId);
      return { action: 'skipped', reason: 'user_interrupted' };
    }

    const secrets = this.secretsFor(turn.botConfig);
    const reloaded = await this.reloadTurnEvents(turn.sessionId, turn.botConfig, turn.events, taskId);
    turn.events = reloaded;

    const rawFinalFromEvents = pickFinalAssistantText(turn.events);
    const rawFinalText = rawFinalFromEvents || event.summary || taskRecord?.finalText || '';
    const redactedFinalText = redactSensitiveContent(rawFinalText, secrets);
    const redactedError = event.error ? redactSensitiveContent(event.error, secrets) : undefined;

    // 1. 同轮 group send 智能去重
    const sentViaGroup = this.isGroupSentForTurn(turn);
    if (sentViaGroup) {
      this.options.turnTracker.consumeGroupSends(turn.sessionId, turn.target.chatId, this.nowMs());
      const dedupEnabledOutputPluginIds = state === 'completed'
        ? (turn.enabledOutputPluginIds ?? await this.resolveEnabledOutputPluginIds(turn.sessionId))
        : undefined;
      const dedupExtractedPlugin = state === 'completed' && dedupEnabledOutputPluginIds && dedupEnabledOutputPluginIds.size > 0
        ? this.pluginRegistry.parseTrailingOutput(redactedFinalText, dedupEnabledOutputPluginIds)
        : null;
      if (!turn.cardMessageId) {
        // group send 仅能发文本/富文本，无法发 Schema 2.0 交互插件卡片；若本轮末尾携带已启用交互插件，仍须补推一次交互卡片。
        if (dedupExtractedPlugin) {
          const service = await this.options.resolveService(turn.target.appId);
          await this.pushTrailingOutputPluginCard({
            service,
            turn,
            pluginId: dedupExtractedPlugin.pluginId,
            spec: dedupExtractedPlugin.spec
          }).catch(error => {
            this.options.log.warn({ error, sessionId: turn.sessionId, pluginId: dedupExtractedPlugin.pluginId }, 'group send 去重轮次附加推送飞书交互插件卡片失败');
          });
        }
        this.options.log.info(
          { sessionId: turn.sessionId, taskId: turn.taskId, chatId: turn.target.chatId, category: turn.source.category },
          '本轮已通过 group send 主动向绑定群发送消息，跳过重复同步'
        );
        this.cleanupTurn(turn);
        this.markTerminalSynced(taskId);
        return { action: 'skipped', reason: 'group_send_deduped' };
      }
      // 已建流式卡片但同轮又调用了 group send：原地收口为精简去重态（不重复正文，也不遗留运行中卡片）。
      const service = await this.options.resolveService(turn.target.appId);
      const elapsedSeconds = event.durationMs !== undefined
        ? Math.max(0, event.durationMs / 1_000)
        : Math.max(0, (this.nowMs() - turn.startedAt) / 1_000);
      const dedupElements = boundLarkCardElements([
        {
          tag: 'markdown',
          element_id: 'final_output',
          content: turn.target.chatType === 'p2p'
            ? "<font color='grey'>本轮结果已主动发送，此处不重复正文。</font>"
            : "<font color='grey'>本轮结果已通过群消息主动发送，此处不重复正文。</font>",
          text_size: 'notation',
          margin: '0px'
        }
      ]);
      turn.pendingUpdate = {
        terminal: true,
        completed: state === 'completed',
        input: {
          messageId: turn.cardMessageId,
          state,
          readOnly: true,
          sourceBadge: { label: turn.source.badge, color: turn.source.tagColor },
          taskId: turn.taskId,
          taskName: turn.taskName,
          elapsedSeconds,
          sessionId: turn.sessionId,
          ...(turn.botConfig.webBaseUrl ? { webBaseUrl: turn.botConfig.webBaseUrl } : {}),
          elements: dedupElements
        }
      };
      await this.flushCardUpdates(turn, service);
      if (dedupExtractedPlugin) {
        await this.pushTrailingOutputPluginCard({
          service,
          turn,
          pluginId: dedupExtractedPlugin.pluginId,
          spec: dedupExtractedPlugin.spec
        }).catch(error => {
          this.options.log.warn({ error, sessionId: turn.sessionId, pluginId: dedupExtractedPlugin.pluginId }, '去重收口轮次附加推送飞书交互插件卡片失败');
        });
      }
      const messageId = turn.cardMessageId;
      this.cleanupTurn(turn);
      this.markTerminalSynced(taskId);
      return {
        action: 'finalized_deduped_card',
        messageId,
        category: turn.source.category,
        chatId: turn.target.chatId,
        appId: turn.target.appId,
        chatType: turn.target.chatType,
        bindingKind: turn.target.kind
      };
    }

    // 2. 静默无动作定时任务过滤
    if (
      turn.source.category === 'schedule'
      && turn.syncConfig.filterSilentSchedule
      && isSilentScheduledOutput(redactedFinalText, state)
      && !turn.cardMessageId
    ) {
      this.options.log.info(
        { sessionId: turn.sessionId, taskId: turn.taskId, chatId: turn.target.chatId },
        '定时任务本轮无实质输出，按静默过滤策略跳过同步'
      );
      this.cleanupTurn(turn);
      this.markTerminalSynced(taskId);
      return { action: 'skipped', reason: 'silent_schedule' };
    }

    const enabledOutputPluginIds = turn.enabledOutputPluginIds ?? await this.resolveEnabledOutputPluginIds(turn.sessionId);
    const extractedPlugin = state === 'completed' && enabledOutputPluginIds.size > 0
      ? this.pluginRegistry.parseTrailingOutput(redactedFinalText, enabledOutputPluginIds)
      : null;

    const service = await this.options.resolveService(turn.target.appId);
    const elapsedSeconds = event.durationMs !== undefined
      ? Math.max(0, event.durationMs / 1_000)
      : Math.max(0, (this.nowMs() - turn.startedAt) / 1_000);

    // 3. 静默回复模式（quietReply: true）：仅最终回复以纯文本直发群主线程
    if (turn.botConfig.quietReply) {
      const prose = extractedPlugin ? extractedPlugin.proseText : redactedFinalText;
      if (!prose.trim() && extractedPlugin && state === 'completed') {
        const pluginMsgId = await this.pushTrailingOutputPluginCard({
          service,
          turn,
          pluginId: extractedPlugin.pluginId,
          spec: extractedPlugin.spec
        }).catch(error => {
          this.options.log.warn({ error, sessionId: turn.sessionId, pluginId: extractedPlugin.pluginId }, '静默同步推送飞书交互插件卡片失败');
          return undefined;
        });
        this.cleanupTurn(turn);
        this.markTerminalSynced(taskId);
        return pluginMsgId
          ? { action: 'synced_card', messageId: pluginMsgId, category: turn.source.category, chatId: turn.target.chatId, appId: turn.target.appId, chatType: turn.target.chatType, bindingKind: turn.target.kind }
          : { action: 'skipped', reason: 'plugin_card_only' };
      }
      const text = this.formatQuietText({
        source: turn.source,
        taskName: turn.taskName,
        body: prose.length > 6_000 ? `${prose.slice(0, 5_999)}…` : prose,
        state,
        ...(redactedError ? { error: redactedError } : {})
      });
      const idempotencyKey = `tsync_q_${turn.taskId}_${state}`.slice(0, 50);
      let sentMessageId = '';
      let lastError: unknown;
      for (let attempt = 1; attempt <= 3; attempt++) {
        try {
          const sent = await service.sendText({ ...this.recipientFor(turn.target), text, idempotencyKey });
          sentMessageId = sent.messageId;
          this.options.turnTracker.markOutboundMessage(sent.messageId);
          lastError = undefined;
          break;
        } catch (error) {
          lastError = error;
          if (attempt < 3) {
            const delay = isLarkMessageRateLimit(error) ? larkRateLimitBackoffMs(attempt) : attempt * 500;
            await new Promise(resolve => setTimeout(resolve, Math.min(delay, 5_000)));
          }
        }
      }
      if (lastError === undefined && extractedPlugin) {
        await this.pushTrailingOutputPluginCard({
          service,
          turn,
          pluginId: extractedPlugin.pluginId,
          spec: extractedPlugin.spec
        }).catch(error => {
          this.options.log.warn({ error, sessionId: turn.sessionId, pluginId: extractedPlugin.pluginId }, '静默同步附加推送飞书交互插件卡片失败');
        });
      }
      this.cleanupTurn(turn);
      this.markTerminalSynced(taskId);
      if (lastError !== undefined) throw lastError;
      return {
        action: 'synced_text',
        messageId: sentMessageId,
        category: turn.source.category,
        chatId: turn.target.chatId,
        appId: turn.target.appId,
        chatType: turn.target.chatType,
        bindingKind: turn.target.kind
      };
    }

    // 4. Trace 卡片模式（quietReply: false）：复用机器人既有卡片样式直发/更新群主线程
    let renderEvents = turn.events.map(item => sanitizeEventForSync(item, secrets));
    const hasAssistantTextInEvents = Boolean(pickFinalAssistantText(renderEvents));
    if (!hasAssistantTextInEvents && redactedFinalText.trim()) {
      renderEvents = [
        ...renderEvents,
        {
          id: `tsync-text-${turn.taskId}`,
          sessionId: turn.sessionId,
          sequence: Number.MAX_SAFE_INTEGER - 1,
          type: 'text',
          timestamp: event.timestamp,
          data: { role: 'assistant', text: redactedFinalText }
        }
      ];
    }
    if (state === 'failed' && redactedError && !renderEvents.some(item => item.type === 'error')) {
      renderEvents = [
        ...renderEvents,
        {
          id: `tsync-err-${turn.taskId}`,
          sessionId: turn.sessionId,
          sequence: Number.MAX_SAFE_INTEGER,
          type: 'error',
          timestamp: event.timestamp,
          data: { message: redactedError }
        }
      ];
    }

    const elements = boundLarkCardElements(renderLarkCardElements(renderEvents, turn.botConfig, state === 'completed', false, {
      outputPluginRegistry: this.pluginRegistry,
      enabledOutputPluginIds,
      larkPluginAdapters: this.larkPluginAdapters
    }));

    let finalMessageId: string;
    if (turn.cardMessageId) {
      turn.pendingUpdate = {
        terminal: true,
        completed: state === 'completed',
        input: {
          messageId: turn.cardMessageId,
          state,
          readOnly: true,
          sourceBadge: { label: turn.source.badge, color: turn.source.tagColor },
          taskId: turn.taskId,
          taskName: turn.taskName,
          elapsedSeconds,
          sessionId: turn.sessionId,
          ...(turn.botConfig.webBaseUrl ? { webBaseUrl: turn.botConfig.webBaseUrl } : {}),
          elements
        }
      };
      await this.flushCardUpdates(turn, service);
      finalMessageId = turn.cardMessageId;
    } else {
      const sent = await service.send({
        ...this.recipientFor(turn.target),
        state,
        readOnly: true,
        sourceBadge: { label: turn.source.badge, color: turn.source.tagColor },
        taskId: turn.taskId,
        taskName: turn.taskName,
        elapsedSeconds,
        sessionId: turn.sessionId,
        ...(turn.botConfig.webBaseUrl ? { webBaseUrl: turn.botConfig.webBaseUrl } : {}),
        elements,
        idempotencyKey: `tsync_${turn.taskId}_${state}`.slice(0, 50)
      });
      finalMessageId = sent.messageId;
      this.options.turnTracker.markOutboundMessage(sent.messageId);
    }

    if (extractedPlugin) {
      await this.pushTrailingOutputPluginCard({
        service,
        turn,
        pluginId: extractedPlugin.pluginId,
        spec: extractedPlugin.spec
      }).catch(error => {
        this.options.log.warn({ error, sessionId: turn.sessionId, pluginId: extractedPlugin.pluginId }, '同步轮次附加推送飞书交互插件卡片失败');
      });
    }

    this.cleanupTurn(turn);
    this.markTerminalSynced(taskId);
    return {
      action: 'synced_card',
      messageId: finalMessageId,
      category: turn.source.category,
      chatId: turn.target.chatId,
      appId: turn.target.appId,
      chatType: turn.target.chatType,
      bindingKind: turn.target.kind
    };
  }
}
