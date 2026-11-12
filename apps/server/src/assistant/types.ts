export const assistantTaskStates = ['running', 'review', 'needs_user', 'closed'] as const;
export type AssistantTaskState = (typeof assistantTaskStates)[number];

export const assistantTaskOutcomes = ['accepted', 'cancelled'] as const;
export type AssistantTaskOutcome = (typeof assistantTaskOutcomes)[number];

export const assistantSignalKinds = ['review', 'needs_you', 'failed', 'interrupted'] as const;
export type AssistantSignalKind = (typeof assistantSignalKinds)[number];

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
  closedAt?: string;
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

export interface QuietHours {
  enabled: boolean;
  /** `HH:MM`，本机时区。 */
  start: string;
  /** `HH:MM`，本机时区。 */
  end: string;
}

export interface NotifyInput {
  text: string;
  ask?: boolean;
  urgent?: boolean;
}
