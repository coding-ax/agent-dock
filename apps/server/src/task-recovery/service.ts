import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import {
  buildRecoveryAgentPrompt,
  buildRecoveryVisiblePrompt,
  DEFAULT_TASK_RECOVERY_CONFIG,
  makeId,
  normalizeTaskRecoveryConfig,
  now,
  RuntimeError,
  TASK_RECOVERY_CONFIG_KEY,
  TASK_RECOVERY_ORIGIN,
  tShared,
  type DaemonRestartInterruptedCandidate,
  type RepositoryBundle,
  type Session,
  type TaskRecord,
  type TaskRecoveryConfig,
  type TaskRecoveryConfigInput,
  type TaskRecoveryDecisionSource,
  type TaskRecoveryListFilter,
  type TaskRecoveryRecord,
  type TaskRecoverySkipReason
} from '@agent-dock/agent-dock-shared';
import {
  buildTaskRecoveryConfirmCard,
  buildTaskRecoveryResolvedCard,
  parseTaskRecoveryCardAction
} from './lark-card.js';
import { getActiveServerLocale } from '../locale-service.js';

/** 内部临时会话（runOnce 替身分析等）绝不纳入普通会话自动恢复。 */
const EPHEMERAL_SESSION_SOURCES = new Set(['lark-avatar', 'lark-avatar-reaction']);
/** 系统内部注入轮次（主小猫督办 / 整理维护 / 换代交接）由各自体系管理，绝不纳入普通会话恢复。 */
const SYSTEM_TASK_ORIGINS = new Set(['injected', 'maintenance', 'handoff']);
const BUSY_OR_TERMINAL_UNRECOVERABLE_STATES = new Set(['stopped', 'failed']);

export interface TaskRecoveryRuntimePort {
  getStartupInterruptedTasks?(): DaemonRestartInterruptedCandidate[];
  getSession(id: string): Promise<Session | undefined>;
  getTasks(id: string): Promise<TaskRecord[]>;
  dispatch(
    id: string,
    prompt: string,
    mode?: 'queue' | 'interrupt',
    agentPrompt?: string,
    riskPolicy?: unknown,
    origin?: string,
    clientMessageId?: string
  ): Promise<{ id: string; status: string }>;
}

export interface TaskRecoveryLarkPort {
  sendConfirmCard(record: TaskRecoveryRecord): Promise<{
    appId: string;
    chatId: string;
    messageId: string;
    cardId: string;
  } | undefined>;
  updateCard(record: TaskRecoveryRecord): Promise<void>;
}

export interface TaskRecoveryLog {
  info(message: string): void;
  warn(message: string): void;
}

export interface TaskRecoveryServiceOptions {
  repos: RepositoryBundle;
  runtime: TaskRecoveryRuntimePort;
  /** 判定会话是否为主小猫本身或已由主小猫 assistant_tasks 督办接管的侧边会话。 */
  isAssistantManaged?: (session: Session) => boolean;
  /** 可选飞书确认卡投递/更新端口；未注入或飞书监听关闭时只走 Web 端。 */
  larkPort?: TaskRecoveryLarkPort;
  /** 多任务错峰启动前的最小初始延迟（毫秒），默认 400ms；测试可设为 0。 */
  initialDelayMs?: number;
  /** 测试可覆盖 stagger 秒到毫秒的换算基数（默认 1000ms）。 */
  staggerUnitMs?: number;
  nowMs?: () => number;
  log?: TaskRecoveryLog;
}

export interface TaskRecoveryAuditSummary {
  scanned: number;
  scheduled: number;
  pendingConfirm: number;
  skipped: number;
  records: TaskRecoveryRecord[];
}

export interface TaskRecoveryDecisionResult {
  record: TaskRecoveryRecord;
  alreadyDecided: boolean;
  dispatchedTaskId?: string;
}

function isValidTimestampMs(iso: string | null | undefined): number | undefined {
  if (!iso) return undefined;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : undefined;
}

function maxIsoTimestamp(values: Array<string | null | undefined>): string | undefined {
  let bestIso: string | undefined;
  let bestMs = Number.NEGATIVE_INFINITY;
  for (const value of values) {
    const ms = isValidTimestampMs(value);
    if (ms !== undefined && ms > bestMs) {
      bestMs = ms;
      bestIso = value!;
    }
  }
  return bestIso;
}

export async function readTaskRecoveryConfig(repos: Pick<RepositoryBundle, 'config'>): Promise<TaskRecoveryConfig> {
  const raw = await repos.config.get(TASK_RECOVERY_CONFIG_KEY);
  if (!raw?.trim()) return { ...DEFAULT_TASK_RECOVERY_CONFIG };
  try {
    const parsed = JSON.parse(raw) as TaskRecoveryConfigInput;
    return normalizeTaskRecoveryConfig(parsed);
  } catch {
    return { ...DEFAULT_TASK_RECOVERY_CONFIG };
  }
}

export async function saveTaskRecoveryConfig(
  repos: Pick<RepositoryBundle, 'config'>,
  patch: TaskRecoveryConfigInput
): Promise<TaskRecoveryConfig> {
  const current = await readTaskRecoveryConfig(repos);
  const next = normalizeTaskRecoveryConfig(patch, current);
  await repos.config.set(TASK_RECOVERY_CONFIG_KEY, JSON.stringify(next));
  return next;
}

/**
 * 普通会话任务因守护进程重启被动中断的审计与恢复服务：
 * - 精准排除用户手动停止（user_stopped / interrupting）、已完成任务、主小猫自身及其督办侧边任务；
 * - 内置安全护栏：时间窗口（默认 15 分钟）、单任务链最大自动恢复次数（默认 1 次防死循环）、
 *   多任务错峰启动、以及先核对现状再续做的防重复副作用断点自检 Prompt；
 * - 完整支持 auto（默认自动安全断点续跑）、confirm（Web + 飞书交互确认卡双端幂等锁定）与 off 三档策略。
 */
export class TaskRecoveryService {
  private readonly emitter = new EventEmitter();
  private readonly timers = new Set<ReturnType<typeof setTimeout>>();
  private readonly inflight = new Set<Promise<unknown>>();
  private larkPort?: TaskRecoveryLarkPort;
  private started = false;
  private closed = false;
  private readonly nowMs: () => number;
  private readonly initialDelayMs: number;
  private readonly staggerUnitMs: number;
  private readonly log: TaskRecoveryLog;

  constructor(private readonly options: TaskRecoveryServiceOptions) {
    this.larkPort = options.larkPort;
    this.nowMs = options.nowMs ?? (() => Date.now());
    this.initialDelayMs = options.initialDelayMs ?? 400;
    this.staggerUnitMs = options.staggerUnitMs ?? 1_000;
    this.log = options.log ?? {
      info: () => undefined,
      warn: message => console.warn(message)
    };
  }

  setLarkPort(port: TaskRecoveryLarkPort | undefined): void {
    this.larkPort = port;
  }

  onChange(listener: (record: TaskRecoveryRecord) => void): () => void {
    this.emitter.on('change', listener);
    return () => { this.emitter.off('change', listener); };
  }

  private emitChange(record: TaskRecoveryRecord): void {
    this.emitter.emit('change', record);
  }

  private track<T>(promise: Promise<T>): Promise<T> {
    this.inflight.add(promise);
    void promise.finally(() => this.inflight.delete(promise));
    return promise;
  }

  async getConfig(): Promise<TaskRecoveryConfig> {
    return readTaskRecoveryConfig(this.options.repos);
  }

  async updateConfig(patch: TaskRecoveryConfigInput): Promise<TaskRecoveryConfig> {
    return saveTaskRecoveryConfig(this.options.repos, patch);
  }

  async listRecords(filter?: TaskRecoveryListFilter): Promise<TaskRecoveryRecord[]> {
    return this.options.repos.taskRecoveries.list(filter);
  }

  async listSessionRecords(sessionId: string): Promise<TaskRecoveryRecord[]> {
    return this.options.repos.taskRecoveries.listBySession(sessionId);
  }

  async getRecord(id: string): Promise<TaskRecoveryRecord | undefined> {
    return this.options.repos.taskRecoveries.get(id);
  }

  start(): void {
    if (this.started || this.closed) return;
    this.started = true;
    void this.track(this.auditStartupInterruptions().catch(error => {
      this.log.warn(`普通会话中断恢复启动审计失败：${error instanceof Error ? error.message : String(error)}`);
    }));
  }

  async flushPending(): Promise<void> {
    while (this.inflight.size > 0) {
      await Promise.allSettled([...this.inflight]);
    }
  }

  async close(): Promise<void> {
    this.closed = true;
    for (const timer of this.timers) clearTimeout(timer);
    this.timers.clear();
    await this.flushPending();
  }

  private isAssistantManagedSession(session: Session): boolean {
    if (session.source === 'assistant-main' || session.source === 'assistant-task') return true;
    return this.options.isAssistantManaged?.(session) ?? false;
  }

  /**
   * 汇总本次冷启动需要审计的中断候选：
   * 1. 优先读取 runtime.initialize() 改写时间戳之前采集的精确快照（保留真实 lastActiveAt 与 previousSessionState）；
   * 2. 兜底扫描库里已标记为 state=interrupted & interruptIntent=daemon_restart 但尚未落账本的会话
   *    （覆盖重启发生在审计前、或外部测试直接写入数据库的场景）。
   */
  private async collectAuditCandidates(): Promise<DaemonRestartInterruptedCandidate[]> {
    const byTaskId = new Map<string, DaemonRestartInterruptedCandidate>();
    for (const candidate of this.options.runtime.getStartupInterruptedTasks?.() ?? []) {
      byTaskId.set(candidate.taskId, candidate);
    }

    const sessions = await this.options.repos.sessions.list();
    const detectedAt = new Date(this.nowMs()).toISOString();
    for (const session of sessions) {
      if (session.archivedAt) continue;
      if (session.state !== 'interrupted' || session.interruptIntent !== 'daemon_restart') continue;
      const persistedTasks = await this.options.repos.tasks.listBySession(session.id);
      const latestExecuted = [...persistedTasks]
        .filter(task => task.status !== 'queued' && task.status !== 'cancelled')
        .sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id))
        .at(-1);
      if (!latestExecuted || latestExecuted.status !== 'interrupted') continue;
      if (byTaskId.has(latestExecuted.id)) continue;
      const existing = await this.options.repos.taskRecoveries.getByInterruptedTaskId(latestExecuted.id);
      if (existing) continue;

      const recentEvents = await this.options.repos.events.listRecent(session.id, 10);
      const lastNonRestartEvent = [...recentEvents].reverse().find(event => {
        if (event.type === 'status' && (event.data as Record<string, unknown> | undefined)?.interruptIntent === 'daemon_restart') return false;
        if (event.type === 'error' && String((event.data as Record<string, unknown> | undefined)?.message ?? '').includes('守护进程重启')) return false;
        return true;
      });
      const lastActiveAt = maxIsoTimestamp([
        lastNonRestartEvent?.timestamp,
        latestExecuted.updatedAt,
        latestExecuted.createdAt,
        session.updatedAt
      ]) ?? detectedAt;

      byTaskId.set(latestExecuted.id, {
        sessionId: session.id,
        taskId: latestExecuted.id,
        prompt: latestExecuted.prompt,
        origin: latestExecuted.origin ?? null,
        previousSessionState: 'interrupted',
        previousInterruptIntent: 'daemon_restart',
        lastActiveAt,
        detectedAt,
        hasQueuedTasks: persistedTasks.some(task => task.status === 'queued')
      });
    }

    return [...byTaskId.values()].sort((left, right) =>
      right.lastActiveAt.localeCompare(left.lastActiveAt) || left.taskId.localeCompare(right.taskId)
    );
  }

  private async resolveChainMeta(candidate: DaemonRestartInterruptedCandidate): Promise<{
    rootTaskId: string;
    priorAttempts: number;
  }> {
    const prior = await this.options.repos.taskRecoveries.getByRecoveryTaskId(candidate.taskId);
    if (prior) {
      return {
        rootTaskId: prior.rootTaskId,
        priorAttempts: Math.max(1, prior.attemptCount)
      };
    }
    if (candidate.origin === TASK_RECOVERY_ORIGIN) {
      return {
        rootTaskId: candidate.taskId,
        priorAttempts: 1
      };
    }
    return {
      rootTaskId: candidate.taskId,
      priorAttempts: 0
    };
  }

  async auditStartupInterruptions(): Promise<TaskRecoveryAuditSummary> {
    if (this.closed) return { scanned: 0, scheduled: 0, pendingConfirm: 0, skipped: 0, records: [] };

    const config = await this.getConfig();
    const candidates = await this.collectAuditCandidates();
    const records: TaskRecoveryRecord[] = [];
    const autoScheduleList: Array<{ record: TaskRecoveryRecord; config: TaskRecoveryConfig }> = [];
    let scheduled = 0;
    let pendingConfirm = 0;
    let skipped = 0;

    for (const candidate of candidates) {
      if (this.closed) break;
      const existing = await this.options.repos.taskRecoveries.getByInterruptedTaskId(candidate.taskId);
      if (existing) continue;

      const session = await this.options.repos.sessions.get(candidate.sessionId);
      const { rootTaskId, priorAttempts } = await this.resolveChainMeta(candidate);
      const stamp = new Date(this.nowMs()).toISOString();

      let skipReason: TaskRecoverySkipReason | undefined;
      if (!session || session.archivedAt || BUSY_OR_TERMINAL_UNRECOVERABLE_STATES.has(session.state)) {
        skipReason = 'session_unavailable';
      } else if (
        candidate.previousSessionState === 'interrupting'
        || candidate.previousInterruptIntent === 'user'
        || candidate.previousInterruptIntent === 'agent_cancelled'
        || (session.state === 'interrupted' && session.interruptIntent && session.interruptIntent !== 'daemon_restart')
      ) {
        skipReason = 'user_stopped';
      } else if (this.isAssistantManagedSession(session)) {
        skipReason = 'assistant_managed';
      } else if (session.source && EPHEMERAL_SESSION_SOURCES.has(session.source)) {
        skipReason = 'ephemeral_session';
      } else if (candidate.origin && SYSTEM_TASK_ORIGINS.has(candidate.origin)) {
        skipReason = 'system_origin';
      } else if (priorAttempts >= config.maxAutoAttempts) {
        skipReason = 'max_attempts';
      } else {
        const lastActiveMs = isValidTimestampMs(candidate.lastActiveAt);
        const ageMs = lastActiveMs !== undefined ? Math.max(0, this.nowMs() - lastActiveMs) : 0;
        if (ageMs > config.windowMinutes * 60_000) {
          skipReason = 'stale';
        } else if (config.mode === 'off') {
          skipReason = 'mode_off';
        }
      }

      const status = skipReason
        ? 'skipped'
        : config.mode === 'auto'
          ? 'scheduled'
          : 'pending_confirm';

      const record: TaskRecoveryRecord = {
        id: makeId('rec'),
        sessionId: candidate.sessionId,
        interruptedTaskId: candidate.taskId,
        rootTaskId,
        originalPrompt: candidate.prompt,
        originalOrigin: candidate.origin ?? null,
        interruptReason: 'daemon_restart',
        interruptedAt: candidate.lastActiveAt,
        detectedAt: candidate.detectedAt || stamp,
        mode: config.mode,
        status,
        skipReason: skipReason ?? null,
        attemptCount: priorAttempts,
        recoveryTaskId: null,
        decidedSource: null,
        decidedBy: null,
        decidedAt: null,
        larkAppId: null,
        larkChatId: null,
        larkMessageId: null,
        larkCardId: null,
        createdAt: stamp,
        updatedAt: stamp
      };

      const inserted = await this.options.repos.taskRecoveries.insertIfAbsent(record);
      if (!inserted) continue;

      records.push(record);
      this.emitChange(record);

      if (status === 'skipped') {
        skipped += 1;
        this.log.info(`普通会话中断恢复跳过 ${record.sessionId}/${record.interruptedTaskId}（原因：${skipReason}）`);
        continue;
      }

      if (status === 'scheduled') {
        scheduled += 1;
        autoScheduleList.push({ record, config });
        continue;
      }

      pendingConfirm += 1;
      await this.deliverLarkConfirmCard(record);
    }

    // 错峰拉起多个自动恢复任务，防止重启瞬间并发打爆模型/进程。
    autoScheduleList.forEach(({ record, config: activeConfig }, index) => {
      const delayMs = this.initialDelayMs + index * activeConfig.staggerSeconds * this.staggerUnitMs;
      this.scheduleAutoResume(record.id, activeConfig, delayMs);
    });

    return {
      scanned: candidates.length,
      scheduled,
      pendingConfirm,
      skipped,
      records
    };
  }

  private scheduleAutoResume(recoveryId: string, config: TaskRecoveryConfig, delayMs: number): void {
    if (this.closed) return;
    const run = () => {
      void this.track(this.executeScheduledAutoResume(recoveryId, config).catch(error => {
        this.log.warn(`自动断点续跑执行失败（${recoveryId}）：${error instanceof Error ? error.message : String(error)}`);
      }));
    };
    if (delayMs <= 0) {
      run();
      return;
    }
    const timer = setTimeout(() => {
      this.timers.delete(timer);
      if (this.closed) return;
      run();
    }, delayMs);
    timer.unref?.();
    this.timers.add(timer);
  }

  private async executeScheduledAutoResume(recoveryId: string, config: TaskRecoveryConfig): Promise<void> {
    if (this.closed) return;
    const current = await this.options.repos.taskRecoveries.get(recoveryId);
    if (!current || current.status !== 'scheduled') return;

    const session = await this.options.repos.sessions.get(current.sessionId);
    if (!session || session.archivedAt || BUSY_OR_TERMINAL_UNRECOVERABLE_STATES.has(session.state)) {
      const skipped = await this.options.repos.taskRecoveries.claimTransition(recoveryId, ['scheduled'], {
        status: 'skipped',
        skipReason: 'session_unavailable',
        updatedAt: new Date(this.nowMs()).toISOString()
      });
      if (skipped) this.emitChange(skipped);
      return;
    }

    // 若在错峰等待期间用户已经主动发了新一轮消息，放弃自动续跑，避免覆盖用户最新意图。
    const tasks = await this.options.runtime.getTasks(current.sessionId);
    const hasNewerUserTurn = tasks.some(task =>
      task.id !== current.interruptedTaskId
      && task.origin !== TASK_RECOVERY_ORIGIN
      && task.status !== 'cancelled'
      && task.createdAt > current.detectedAt
    );
    if (hasNewerUserTurn) {
      const skipped = await this.options.repos.taskRecoveries.claimTransition(recoveryId, ['scheduled'], {
        status: 'skipped',
        skipReason: 'superseded',
        updatedAt: new Date(this.nowMs()).toISOString()
      });
      if (skipped) this.emitChange(skipped);
      return;
    }

    const attemptNumber = current.attemptCount + 1;
    const decidedAt = new Date(this.nowMs()).toISOString();
    const claimed = await this.options.repos.taskRecoveries.claimTransition(recoveryId, ['scheduled'], {
      status: 'resumed',
      attemptCount: attemptNumber,
      decidedSource: 'auto',
      decidedBy: null,
      decidedAt,
      updatedAt: decidedAt
    });
    if (!claimed) return;

    try {
      const visiblePrompt = buildRecoveryVisiblePrompt(claimed.originalPrompt);
      const agentPrompt = buildRecoveryAgentPrompt({
        interruptedTaskId: claimed.interruptedTaskId,
        interruptedAt: claimed.interruptedAt,
        originalPrompt: claimed.originalPrompt,
        originalOrigin: claimed.originalOrigin,
        triggerSource: 'auto',
        attemptNumber,
        maxAutoAttempts: config.maxAutoAttempts
      });
      const dispatched = await this.options.runtime.dispatch(
        claimed.sessionId,
        visiblePrompt,
        'queue',
        agentPrompt,
        undefined,
        TASK_RECOVERY_ORIGIN,
        `recovery:${claimed.id}`
      );
      const finalized: TaskRecoveryRecord = {
        ...claimed,
        recoveryTaskId: dispatched.id,
        updatedAt: new Date(this.nowMs()).toISOString()
      };
      await this.options.repos.taskRecoveries.save(finalized);
      this.emitChange(finalized);
      this.log.info(`已自动断点续跑会话 ${claimed.sessionId}（原任务 ${claimed.interruptedTaskId} → 续跑任务 ${dispatched.id}）`);
    } catch (error) {
      const failed: TaskRecoveryRecord = {
        ...claimed,
        status: 'skipped',
        skipReason: 'dispatch_failed',
        updatedAt: new Date(this.nowMs()).toISOString()
      };
      await this.options.repos.taskRecoveries.save(failed);
      this.emitChange(failed);
      throw error;
    }
  }

  private async deliverLarkConfirmCard(record: TaskRecoveryRecord): Promise<void> {
    if (!this.larkPort) return;
    try {
      const sent = await this.larkPort.sendConfirmCard(record);
      if (!sent) return;
      const latest = (await this.options.repos.taskRecoveries.get(record.id)) ?? record;
      const updated: TaskRecoveryRecord = {
        ...latest,
        larkAppId: sent.appId,
        larkChatId: sent.chatId,
        larkMessageId: sent.messageId,
        larkCardId: sent.cardId,
        updatedAt: new Date(this.nowMs()).toISOString()
      };
      await this.options.repos.taskRecoveries.save(updated);
      this.emitChange(updated);
      // 若在发卡异步期间另一端（Web）已决策，立即把刚发出去的飞书卡片也锁定成结果态。
      if (updated.status !== 'pending_confirm') {
        await this.syncLarkCard(updated);
      }
    } catch (error) {
      this.log.warn(`推送断点恢复飞书确认卡失败（${record.sessionId}）：${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private async syncLarkCard(record: TaskRecoveryRecord): Promise<void> {
    if (!this.larkPort || !record.larkMessageId || !record.larkAppId) return;
    try {
      await this.larkPort.updateCard(record);
    } catch (error) {
      this.log.warn(`同步更新断点恢复飞书卡片失败（${record.id}）：${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * 交互确认卡决策入口（Web 与飞书共用，依赖 SQLite claimTransition 原子双端幂等锁定）：
   * - 首次确认 `resume`：锁定记录为 `resumed`，立即注入断点自检续跑轮次，并同步锁定飞书卡片；
   * - 首次放弃 `dismiss`：锁定记录为 `dismissed`，归档锁定，不驱动 Agent，并同步锁定飞书卡片；
   * - 重复/并发点击：直接返回 `alreadyDecided: true` 与当前最终状态，绝不重复派发。
   */
  async decide(input: {
    recoveryId: string;
    sessionId?: string;
    decision: 'resume' | 'dismiss';
    source: Exclude<TaskRecoveryDecisionSource, 'auto'>;
    decidedBy?: string;
  }): Promise<TaskRecoveryDecisionResult> {
    const existing = await this.options.repos.taskRecoveries.get(input.recoveryId);
    if (!existing) {
      throw new RuntimeError('RECOVERY_NOT_FOUND', '未找到对应的中断恢复记录', 404);
    }
    if (input.sessionId && existing.sessionId !== input.sessionId) {
      throw new RuntimeError('RECOVERY_SESSION_MISMATCH', '中断恢复记录不属于当前会话', 404);
    }
    if (existing.status !== 'pending_confirm') {
      return {
        record: existing,
        alreadyDecided: true,
        ...(existing.recoveryTaskId ? { dispatchedTaskId: existing.recoveryTaskId } : {})
      };
    }

    if (input.decision === 'resume') {
      const session = await this.options.repos.sessions.get(existing.sessionId);
      if (!session) throw new RuntimeError('SESSION_NOT_FOUND', '会话不存在，无法继续执行', 404);
      if (session.archivedAt) throw new RuntimeError('SESSION_ARCHIVED', '会话已归档，无法继续执行', 409);
      if (BUSY_OR_TERMINAL_UNRECOVERABLE_STATES.has(session.state)) {
        throw new RuntimeError('INVALID_STATE', `会话当前处于 ${session.state} 状态，无法继续执行`, 409);
      }
    }

    const decidedAt = new Date(this.nowMs()).toISOString();
    const attemptNumber = input.decision === 'resume' ? existing.attemptCount + 1 : existing.attemptCount;
    const claimed = await this.options.repos.taskRecoveries.claimTransition(existing.id, ['pending_confirm'], {
      status: input.decision === 'resume' ? 'resumed' : 'dismissed',
      attemptCount: attemptNumber,
      decidedSource: input.source,
      decidedBy: input.decidedBy?.trim() || null,
      decidedAt,
      updatedAt: decidedAt
    });

    if (!claimed) {
      const latest = (await this.options.repos.taskRecoveries.get(existing.id)) ?? existing;
      return {
        record: latest,
        alreadyDecided: true,
        ...(latest.recoveryTaskId ? { dispatchedTaskId: latest.recoveryTaskId } : {})
      };
    }

    if (input.decision === 'dismiss') {
      this.emitChange(claimed);
      await this.syncLarkCard(claimed);
      return { record: claimed, alreadyDecided: false };
    }

    const config = await this.getConfig();
    try {
      const visiblePrompt = buildRecoveryVisiblePrompt(claimed.originalPrompt);
      const agentPrompt = buildRecoveryAgentPrompt({
        interruptedTaskId: claimed.interruptedTaskId,
        interruptedAt: claimed.interruptedAt,
        originalPrompt: claimed.originalPrompt,
        originalOrigin: claimed.originalOrigin,
        triggerSource: input.source,
        attemptNumber,
        maxAutoAttempts: config.maxAutoAttempts
      });
      const dispatched = await this.options.runtime.dispatch(
        claimed.sessionId,
        visiblePrompt,
        'queue',
        agentPrompt,
        undefined,
        TASK_RECOVERY_ORIGIN,
        `recovery:${claimed.id}`
      );
      const finalized: TaskRecoveryRecord = {
        ...claimed,
        recoveryTaskId: dispatched.id,
        updatedAt: new Date(this.nowMs()).toISOString()
      };
      await this.options.repos.taskRecoveries.save(finalized);
      this.emitChange(finalized);
      await this.syncLarkCard(finalized);
      return { record: finalized, alreadyDecided: false, dispatchedTaskId: dispatched.id };
    } catch (error) {
      // 若派发失败（例如底层临时故障），回滚到 pending_confirm 允许用户稍后重试。
      const reverted: TaskRecoveryRecord = {
        ...claimed,
        status: 'pending_confirm',
        attemptCount: existing.attemptCount,
        decidedSource: null,
        decidedBy: null,
        decidedAt: null,
        updatedAt: new Date(this.nowMs()).toISOString()
      };
      await this.options.repos.taskRecoveries.save(reverted).catch(() => undefined);
      this.emitChange(reverted);
      throw error;
    }
  }

  /** 处理飞书 Schema 2.0 确认卡按钮点击回调，返回飞书 Toast 文案并原地锁定卡片。 */
  async handleLarkCardAction(input: {
    value: unknown;
    operatorOpenId?: string;
    operatorName?: string;
  }): Promise<{ type: 'success' | 'info' | 'warning' | 'error'; content: string } | undefined> {
    const parsed = parseTaskRecoveryCardAction(input.value);
    if (!parsed) return undefined;
    try {
      const result = await this.decide({
        recoveryId: parsed.recoveryId,
        decision: parsed.decision,
        source: 'lark',
        decidedBy: input.operatorName?.trim() || input.operatorOpenId?.trim() || undefined
      });
      const locale = getActiveServerLocale();
      if (result.alreadyDecided) {
        const statusText = result.record.status === 'resumed'
          ? tShared(locale, 'lark.recovery.toast.resumedStatus')
          : tShared(locale, 'lark.recovery.toast.dismissedStatus');
        const via = result.record.decidedSource === 'web'
          ? tShared(locale, 'lark.recovery.toast.viaWeb')
          : result.record.decidedSource === 'lark'
            ? tShared(locale, 'lark.recovery.toast.viaLark')
            : '';
        await this.syncLarkCard(result.record);
        return { type: 'info', content: tShared(locale, 'lark.recovery.toast.alreadyDecided', { status: statusText, via }) };
      }
      return parsed.decision === 'resume'
        ? { type: 'success', content: tShared(locale, 'lark.recovery.toast.resumedNow') }
        : { type: 'info', content: tShared(locale, 'lark.recovery.toast.dismissedNow') };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { type: 'warning', content: message };
    }
  }
}

export function createTaskRecoveryLarkCardId(): string {
  return `recc_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
}

export { buildTaskRecoveryConfirmCard, buildTaskRecoveryResolvedCard };
