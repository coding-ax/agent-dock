export const assistantTaskStates = ['running', 'review', 'needs_user', 'closed'] as const;
export type AssistantTaskState = (typeof assistantTaskStates)[number];

export const assistantTaskOutcomes = ['accepted', 'cancelled'] as const;
export type AssistantTaskOutcome = (typeof assistantTaskOutcomes)[number];

export const assistantSignalKinds = ['review', 'needs_you', 'failed', 'interrupted', 'user_stopped'] as const;
export type AssistantSignalKind = (typeof assistantSignalKinds)[number];

/**
 * 侧边轮次结束但没进入验收的原因。`user_stopped` 是用户点停止/中断，
 * 不是失败；其余两类用于区分真实失败与被动中断。
 */
export const assistantStopReasons = ['user_stopped', 'failed', 'interrupted', 'timeout'] as const;
export type AssistantStopReason = (typeof assistantStopReasons)[number];

export const watchModes = ['once', 'repeat'] as const;
export type WatchMode = (typeof watchModes)[number];

export const watchStates = ['active', 'paused', 'fired', 'expired'] as const;
export type WatchState = (typeof watchStates)[number];

export const draftStates = ['pending', 'sent', 'failed', 'discarded'] as const;
export type DraftState = (typeof draftStates)[number];

export interface TaskCheck {
  criterion: string;
  met: boolean;
  evidence?: string;
}

export interface AssistantTask {
  id: string;
  title: string;
  notes: string;
  doneWhen: string[];
  expectMinutes?: number;
  state: AssistantTaskState;
  round: number;
  sessionId?: string;
  agentId?: string;
  cwd?: string;
  /** 派活时选定的模型/思考深度；不填就在开工时继承主会话。 */
  model?: string;
  reasoningEffort?: string;
  /** `plan` 为 true 且 state=review 时表示计划卡还没开工。 */
  plan: boolean;
  outcome?: AssistantTaskOutcome;
  createdAt: string;
  updatedAt: string;
  /** 第一次真正开工的时间；计划卡在开工前没有这个字段。 */
  startedAt?: string;
  /** 当前这一轮开工的时间；返工/续做会重新开始，用来排除验收和等待时间。 */
  runStartedAt?: string;
  /** 最近一次执行结束的时间；之后进入待验收、需要你或关闭都保持不变。 */
  completedAt?: string;
  /** 已经结束的各轮执行时长之和（不含排队、待验收和返工之间的等待）。 */
  activeMs?: number;
  closedAt?: string;
  /** 已关闭便签被折叠进归档区的时间；归档只读、可取出，不删除。 */
  archivedAt?: string;
  archiveBatchId?: string;
  /** 用户亲手从归档区取出的时间：之后的自动折叠（整理轮次、交接）不再收它，手动归档不受限。 */
  restoredAt?: string;
  /** 用户主动停止的累计次数；只统计 user_stopped，用于识别反复停止。 */
  stopCount?: number;
  /** 最近一次非验收结束的原因。 */
  lastStopReason?: AssistantStopReason;
  lastStoppedAt?: string;
  /** 用户明确说「继续」后恢复的时间；早于 lastStoppedAt 时仍视为停止状态。 */
  lastResumedAt?: string;
  /** 恢复时的 stopCount 快照：只有在那之后又发生停止，才重新视为用户停止。 */
  resumedStopCount?: number;
}

export interface TaskReviewRecord {
  id: string;
  taskId: string;
  verdict: 'accepted' | 'rework' | 'needs_user' | 'cancelled';
  checks: TaskCheck[];
  note?: string;
  createdAt: string;
}

export interface WatchRecord {
  id: string;
  ownerSessionId: string;
  name: string;
  command: string;
  cwd?: string;
  intervalSeconds: number;
  timeoutSeconds: number;
  mode: WatchMode;
  cooldownSeconds: number;
  state: WatchState;
  lastRunAt?: string;
  lastExitCode?: number;
  lastOutput?: string;
  failCount: number;
  fireCount: number;
  expiresAt?: string;
  createdAt: string;
  updatedAt: string;
}

export interface DraftRecord {
  id: string;
  taskId?: string;
  channel: 'github_comment' | 'lark_reply';
  target: string;
  body: string;
  /** lark_reply 的发送参数（chat/replyTo/inThread/at）；github_comment 不用。 */
  payload?: Record<string, unknown>;
  state: DraftState;
  idempotencyKey: string;
  attempts: number;
  lastError?: string;
  createdBy?: string;
  createdAt: string;
  sentAt?: string;
}

export interface AssistantSignal {
  kind: AssistantSignalKind;
  title: string;
  detail: string;
  taskId?: string;
  sessionId?: string;
  fingerprint: string;
}

/**
 * 主会话在界面上的形象：用户「认领」回家的那只小猫。
 * 只是展示层的身份（名字、认领时间），不影响派活和督办逻辑。
 */
export interface CompanionProfile {
  name: string;
  adoptedAt: string;
}

export interface NotifyInput {
  text: string;
  ask?: boolean;
  urgent?: boolean;
}
