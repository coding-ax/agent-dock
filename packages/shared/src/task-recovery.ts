import type { SessionInterruptIntent, SessionState } from './index.js';

/** 断点续跑轮次的专用任务来源标识（用于时间线专属渲染、飞书全轮次同步徽标与防死循环判定）。 */
export const TASK_RECOVERY_ORIGIN = 'recovery';

/** 持久化在 configs 表中的全局普通会话任务恢复配置键。 */
export const TASK_RECOVERY_CONFIG_KEY = 'task.recovery';

export const taskRecoveryModes = ['auto', 'confirm', 'off'] as const;
export type TaskRecoveryMode = (typeof taskRecoveryModes)[number];

export const taskRecoveryStatuses = ['pending_confirm', 'scheduled', 'resumed', 'dismissed', 'skipped'] as const;
export type TaskRecoveryStatus = (typeof taskRecoveryStatuses)[number];

export const taskRecoverySkipReasons = [
  'mode_off',
  'user_stopped',
  'assistant_managed',
  'ephemeral_session',
  'system_origin',
  'stale',
  'max_attempts',
  'already_recovered',
  'session_unavailable',
  'superseded',
  'dispatch_failed'
] as const;
export type TaskRecoverySkipReason = (typeof taskRecoverySkipReasons)[number];

export const taskRecoveryDecisionSources = ['auto', 'web', 'lark'] as const;
export type TaskRecoveryDecisionSource = (typeof taskRecoveryDecisionSources)[number];

export interface TaskRecoveryConfig {
  /**
   * 普通会话任务因守护进程重启中断后的恢复策略：
   * - `auto`（默认）：安全自动断点续跑（满足护栏条件后错峰拉起断点自检续跑）
   * - `confirm`：在 Web 时间线与绑定飞书群/私聊投放交互确认卡，点击确认后再续跑
   * - `off`：关闭自动恢复（仅标记服务重启中断）
   */
  mode: TaskRecoveryMode;
  /** 仅恢复距离中断未超过该时间窗口（分钟）的任务，默认 15 分钟。 */
  windowMinutes: number;
  /** 单条任务链最多自动恢复次数（防崩溃死循环 / 重启风暴），默认 1 次。 */
  maxAutoAttempts: number;
  /** 多任务同时满足恢复条件时的错峰启动间隔（秒），默认 3 秒。 */
  staggerSeconds: number;
}

export interface TaskRecoveryConfigInput {
  mode?: TaskRecoveryMode;
  windowMinutes?: number;
  maxAutoAttempts?: number;
  staggerSeconds?: number;
}

export const TASK_RECOVERY_MIN_WINDOW_MINUTES = 1;
export const TASK_RECOVERY_MAX_WINDOW_MINUTES = 1440;
export const TASK_RECOVERY_MIN_MAX_AUTO_ATTEMPTS = 1;
export const TASK_RECOVERY_MAX_AUTO_ATTEMPTS = 3;
export const TASK_RECOVERY_MIN_STAGGER_SECONDS = 0;
export const TASK_RECOVERY_MAX_STAGGER_SECONDS = 60;

export const DEFAULT_TASK_RECOVERY_CONFIG: TaskRecoveryConfig = {
  mode: 'auto',
  windowMinutes: 15,
  maxAutoAttempts: 1,
  staggerSeconds: 3
};

function clampInt(value: unknown, fallback: number, min: number, max: number): number {
  const num = typeof value === 'number' ? value : typeof value === 'string' && value.trim() ? Number(value) : Number.NaN;
  if (!Number.isFinite(num)) return fallback;
  return Math.min(max, Math.max(min, Math.round(num)));
}

export function normalizeTaskRecoveryConfig(
  input?: TaskRecoveryConfigInput | null,
  fallback: TaskRecoveryConfig = DEFAULT_TASK_RECOVERY_CONFIG
): TaskRecoveryConfig {
  const baseMode: TaskRecoveryMode = taskRecoveryModes.includes(fallback.mode) ? fallback.mode : DEFAULT_TASK_RECOVERY_CONFIG.mode;
  const base: TaskRecoveryConfig = {
    mode: baseMode,
    windowMinutes: clampInt(fallback.windowMinutes, DEFAULT_TASK_RECOVERY_CONFIG.windowMinutes, TASK_RECOVERY_MIN_WINDOW_MINUTES, TASK_RECOVERY_MAX_WINDOW_MINUTES),
    maxAutoAttempts: clampInt(fallback.maxAutoAttempts, DEFAULT_TASK_RECOVERY_CONFIG.maxAutoAttempts, TASK_RECOVERY_MIN_MAX_AUTO_ATTEMPTS, TASK_RECOVERY_MAX_AUTO_ATTEMPTS),
    staggerSeconds: clampInt(fallback.staggerSeconds, DEFAULT_TASK_RECOVERY_CONFIG.staggerSeconds, TASK_RECOVERY_MIN_STAGGER_SECONDS, TASK_RECOVERY_MAX_STAGGER_SECONDS)
  };
  if (!input || typeof input !== 'object') return base;
  const mode = typeof input.mode === 'string' && (taskRecoveryModes as readonly string[]).includes(input.mode)
    ? (input.mode as TaskRecoveryMode)
    : base.mode;
  return {
    mode,
    windowMinutes: input.windowMinutes !== undefined
      ? clampInt(input.windowMinutes, base.windowMinutes, TASK_RECOVERY_MIN_WINDOW_MINUTES, TASK_RECOVERY_MAX_WINDOW_MINUTES)
      : base.windowMinutes,
    maxAutoAttempts: input.maxAutoAttempts !== undefined
      ? clampInt(input.maxAutoAttempts, base.maxAutoAttempts, TASK_RECOVERY_MIN_MAX_AUTO_ATTEMPTS, TASK_RECOVERY_MAX_AUTO_ATTEMPTS)
      : base.maxAutoAttempts,
    staggerSeconds: input.staggerSeconds !== undefined
      ? clampInt(input.staggerSeconds, base.staggerSeconds, TASK_RECOVERY_MIN_STAGGER_SECONDS, TASK_RECOVERY_MAX_STAGGER_SECONDS)
      : base.staggerSeconds
  };
}

/**
 * runtime.initialize() 在将残留运行任务置为 interrupted 之前采集的原始中断上下文，
 * 用于在修改 updatedAt 之前保留真实的最后活动时间与中断前会话状态。
 */
export interface DaemonRestartInterruptedCandidate {
  sessionId: string;
  taskId: string;
  prompt: string;
  origin?: string | null;
  previousSessionState: SessionState;
  previousInterruptIntent?: SessionInterruptIntent;
  lastActiveAt: string;
  detectedAt: string;
  hasQueuedTasks: boolean;
}

export interface TaskRecoveryRecord {
  id: string;
  sessionId: string;
  interruptedTaskId: string;
  /** 连续中断恢复链路的根任务 ID，用于防止多轮重启陷入死循环。 */
  rootTaskId: string;
  originalPrompt: string;
  originalOrigin?: string | null;
  interruptReason: 'daemon_restart';
  /** 中断前最后一次有效活动时间（用于时间窗口护栏判定）。 */
  interruptedAt: string;
  /** 本次 daemon 冷启动审计识别到该中断的时间。 */
  detectedAt: string;
  /** 识别时生效的恢复策略。 */
  mode: TaskRecoveryMode;
  status: TaskRecoveryStatus;
  skipReason?: TaskRecoverySkipReason | null;
  /** 该任务链累计已执行的恢复次数（首次中断尚未恢复为 0，恢复一次后为 1）。 */
  attemptCount: number;
  /** 触发续跑后创建的 runtime task ID。 */
  recoveryTaskId?: string | null;
  decidedSource?: TaskRecoveryDecisionSource | null;
  decidedBy?: string | null;
  decidedAt?: string | null;
  larkAppId?: string | null;
  larkChatId?: string | null;
  larkMessageId?: string | null;
  larkCardId?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface TaskRecoveryListFilter {
  sessionId?: string;
  status?: TaskRecoveryStatus;
  limit?: number;
}

export interface TaskRecoveryRepository {
  list(filter?: TaskRecoveryListFilter): Promise<TaskRecoveryRecord[]>;
  get(id: string): Promise<TaskRecoveryRecord | undefined>;
  getByInterruptedTaskId(interruptedTaskId: string): Promise<TaskRecoveryRecord | undefined>;
  getByRecoveryTaskId(recoveryTaskId: string): Promise<TaskRecoveryRecord | undefined>;
  getByLarkCardId(larkCardId: string): Promise<TaskRecoveryRecord | undefined>;
  listBySession(sessionId: string): Promise<TaskRecoveryRecord[]>;
  save(record: TaskRecoveryRecord): Promise<void>;
  /** 按 interruptedTaskId 原子插入（存在则忽略返回 false），避免重复审计或重复投递确认卡。 */
  insertIfAbsent(record: TaskRecoveryRecord): Promise<boolean>;
  /** 原子状态迁移（Web / 飞书双端幂等锁核心）：仅当前状态命中 expectedStatuses 时更新并返回最新记录。 */
  claimTransition(
    id: string,
    expectedStatuses: readonly TaskRecoveryStatus[],
    patch: Partial<Omit<TaskRecoveryRecord, 'id' | 'sessionId' | 'interruptedTaskId' | 'rootTaskId'>>
  ): Promise<TaskRecoveryRecord | undefined>;
}

const VISIBLE_RECOVERY_PREFIX_RE = /^🔄\s*断点续跑(?:\s*[·:：-]\s*)?/;

export function stripRecoveryVisiblePrefix(prompt: string | null | undefined): string {
  return (prompt ?? '').trim().replace(VISIBLE_RECOVERY_PREFIX_RE, '').trim();
}

export function buildRecoveryVisiblePrompt(originalPrompt: string | null | undefined): string {
  const cleaned = stripRecoveryVisiblePrefix(originalPrompt).replace(/\s+/g, ' ').trim();
  if (!cleaned) return '🔄 断点续跑 · 续接因服务重启中断的任务';
  const excerpt = cleaned.length > 72 ? `${cleaned.slice(0, 71)}…` : cleaned;
  return `🔄 断点续跑：${excerpt}`;
}

export function buildRecoveryAgentPrompt(input: {
  interruptedTaskId: string;
  interruptedAt: string;
  originalPrompt: string;
  originalOrigin?: string | null;
  triggerSource: TaskRecoveryDecisionSource;
  attemptNumber: number;
  maxAutoAttempts: number;
}): string {
  const cleanedOriginal = stripRecoveryVisiblePrefix(input.originalPrompt);
  const triggerLabel = input.triggerSource === 'auto'
    ? '自动安全断点续跑'
    : input.triggerSource === 'lark'
      ? '用户在飞书确认卡点击「继续执行」'
      : '用户在 Web 确认卡点击「继续执行」';
  return [
    '[AgentDock 系统断点续跑指令]',
    `上一轮任务（${input.interruptedTaskId}）在 ${input.interruptedAt} 左右因 AgentDock 守护进程重启而被动中断（非用户主动停止）。`,
    `触发方式：${triggerLabel}（本次为第 ${input.attemptNumber} 次断点恢复；自动上限 ${input.maxAutoAttempts} 次）。`,
    '',
    '【安全护栏 — 先核对现状，再决定续做】',
    '1. 请先检查当前工作区状态、相关文件改动、git diff/status、命令输出或会话上下文，确认中断前已完成哪些步骤以及停在何处。',
    '2. 严禁重复执行已完成且带有外部副作用的操作，包括但不限于：重复发送飞书/群消息/通知邮件、重复发版或 npm publish、重复 git push、重复删除或覆写文件、重复调用写入型外部 API。',
    '3. 若核对发现原任务的核心目标实际上已经完成，请直接汇报当前现状与核对依据，不要重复执行。',
    '4. 若原任务仍有剩余步骤，请从断点继续完成剩余部分；若某步是否已执行过外部副作用无法确认，请先说明现状并向用户确认后再执行。',
    '',
    '【中断前的原始请求】',
    cleanedOriginal || '（原始请求内容为空，请结合本会话最近上下文核对并汇报现状）'
  ].join('\n');
}

export function parseRecoveryTriggerSourceFromPrompt(detail: string | null | undefined): TaskRecoveryDecisionSource | undefined {
  if (!detail) return undefined;
  if (detail.includes('用户在飞书确认卡点击')) return 'lark';
  if (detail.includes('用户在 Web 确认卡点击')) return 'web';
  if (detail.includes('自动安全断点续跑')) return 'auto';
  return undefined;
}
