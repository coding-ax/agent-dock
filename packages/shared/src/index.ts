import { z } from 'zod';
import safeRegex from 'safe-regex2';

export * from './turn-outcome.js';
export * from './chat-name.js';

export const highRiskPatternMaxLength = 4_096;
export type RegexPatternValidation = { valid: true } | { valid: false; error: string };

export function validateHighRiskPattern(pattern: string): RegexPatternValidation {
  if (!pattern.trim()) return { valid: false, error: '请输入高危操作正则表达式' };
  if (pattern.length > highRiskPatternMaxLength) return { valid: false, error: `正则表达式不能超过 ${highRiskPatternMaxLength} 个字符` };
  try { new RegExp(pattern, 'i'); }
  catch (error) { return { valid: false, error: `正则表达式语法错误：${error instanceof Error ? error.message : String(error)}` }; }
  if (!safeRegex(pattern)) return { valid: false, error: '正则表达式可能造成灾难性回溯，请移除嵌套量词或拆分复杂表达式' };
  return { valid: true };
}

export const protocols = ['auto', 'acp', 'jsonl', 'pipe', 'pty'] as const;
export type Protocol = (typeof protocols)[number];
export const permissionModes = ['ask', 'approve-reads', 'deny-all', 'full-trust'] as const;
export type PermissionMode = (typeof permissionModes)[number];
export const sessionStates = ['created', 'starting', 'idle', 'thinking', 'running_tool', 'waiting_for_permission', 'interrupting', 'interrupted', 'completed', 'failed', 'stopped'] as const;
export type SessionState = (typeof sessionStates)[number];
export const eventTypes = ['text', 'thinking', 'tool_call', 'tool_result', 'permission_request', 'status', 'error', 'completed', 'task', 'raw_terminal'] as const;
export type EventType = (typeof eventTypes)[number];

export const agentConfigSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  command: z.string().min(1),
  args: z.array(z.string()).default([]),
  protocol: z.enum(protocols).default('auto'),
  model: z.string().optional(),
  extraModels: z.array(z.string()).optional(),
  reasoningEffort: z.string().optional(),
  version: z.string().optional(),
  cwd: z.string().optional(),
  env: z.record(z.string()).default({}),
  systemPrompt: z.string().optional(),
  permissionMode: z.enum(permissionModes).default('full-trust'),
  timeout: z.number().positive().default(600),
  capabilities: z.object({ pause: z.boolean().default(false), resume: z.boolean().default(true) }).default({ pause: false, resume: true }),
  builtin: z.boolean().default(false),
  // 可选以保持既有 AgentConfig 字面量与行 JSON 兼容；读取方一律按 undefined === false 处理。
  disabled: z.boolean().optional()
});
export type AgentConfig = z.infer<typeof agentConfigSchema>;

export interface ToolCallData {
  id: string;
  name: string;
  input?: unknown;
  output?: unknown;
  status: 'pending' | 'running' | 'completed' | 'failed';
  startedAt: string;
  completedAt?: string;
}

export interface PermissionRequestData {
  id: string;
  toolCallId?: string;
  title: string;
  options?: Array<{ id: string; label: string; kind?: string }>;
  status: 'pending' | 'approved' | 'rejected';
}

export interface ToolRiskPolicy {
  enabled: boolean;
  authorized: boolean;
  pattern: string;
  actorEmail?: string;
  reason?: string;
}

export interface AgentEvent<T = unknown> {
  id: string;
  sessionId: string;
  sequence: number;
  type: EventType;
  timestamp: string;
  data: T;
  raw?: string;
}

/**
 * 会话展示名的来源档位。
 *
 * - `user`：用户手改过，锁定，Agent 再推也不覆盖；清空输入框即回到自动。
 * - `agent`：Agent 通过 ACP `session_info_update` 推来的标题。
 * - `prompt`：都没有，退回第一条用户 prompt 的摘要。
 *
 * 只有 `user` 和 `agent` 会落库；`prompt` 是 list 时现算的兜底。
 */
export const sessionTitleSources = ['user', 'agent', 'prompt'] as const;
export type SessionTitleSource = (typeof sessionTitleSources)[number];

export interface Session {
  id: string;
  agentId: string;
  state: SessionState;
  cwd: string;
  model?: string;
  reasoningEffort?: string;
  permissionMode?: PermissionMode;
  source?: string;
  sourceId?: string;
  archivedAt?: string;
  protocol?: Exclude<Protocol, 'auto'>;
  runId: string;
  createdAt: string;
  updatedAt: string;
  /**
   * 最后一次**对话**时间：只在「用户发出这一轮」和「这一轮收尾」时刷新。
   * 与 updatedAt 的区别是它不记录状态切换（工具调用、等授权、归档、打断），
   * 所以按它排序才是「最近聊过的排前面」，而不是「最近动过的排前面」。
   * 旧数据 / 从未对话的会话为空，调用方需回退 updatedAt。
   */
  lastMessageAt?: string | null;
  error?: string;
  systemPrompt?: string;
  /**
   * 列表展示用标题。三级回退：用户手改的 `customTitle` > Agent 推来的 `agentTitle`
   * > 该会话第一条用户 prompt 的摘要。只有最后一档是现算的，前两档持久化在 sessions 表。
   */
  title?: string;
  /** `title` 当前来自哪一档。界面靠它区分「这个名字是你起的」还是「Agent 起的」。 */
  titleSource?: SessionTitleSource;
  /**
   * 用户手改的名字。有值即锁定：Agent 后续再推标题只更新 `agentTitle`，不改显示名。
   * 界面编辑框用它预填——用 `title` 预填的话，用户在 Agent 给的名字上改会以为那是自己写的。
   */
  customTitle?: string | null;
  /** Agent 通过 ACP `session_info_update` 推来的名字。原样留着，供清除自定义名后回退。 */
  agentTitle?: string | null;
}

/**
 * 从外部 ACP 会话导入历史时的一轮：一轮用户提问 + 它之后的事件。
 * 只服务于「导入外部会话」，正常运行的任务不经过这个结构。
 */
export interface ImportedTurn {
  prompt: string;
  /** 该轮最终 assistant 文本；没有则为空。 */
  finalText?: string;
  events: Array<{ type: AgentEvent['type']; data: Record<string, unknown> }>;
}

export interface StartSessionInput {
  agentId: string;
  cwd?: string;
  model?: string;
  reasoningEffort?: string;
  permissionMode?: PermissionMode;
  source?: string;
  sourceId?: string;
  /** 从外部 ACP 会话接管上下文：acpx 用 session/resume 或 session/load 恢复它。 */
  resumeSessionId?: string;
  /** 导入历史：在 Agent 启动前先把这些轮次落成事件，时间线才会排在新会话状态之前。 */
  importTurns?: ImportedTurn[];
  /**
   * 会话级系统提示词，覆盖 Agent 自身的。走 ACP session/new 送到 Agent，
   * 不产生任何用户消息——需要「注入上下文但不出现在转录里」时用这个（侧边会话即如此）。
   */
  systemPrompt?: string;
}
export interface SendInput { prompt: string }
export interface AgentCapabilities { protocol: Exclude<Protocol, 'auto'>; available: boolean; detail?: string; pause: boolean; resume: boolean }

export class RuntimeError extends Error {
  constructor(public readonly code: string, message: string, public readonly statusCode = 400) { super(message); this.name = 'RuntimeError'; }
}

export interface AgentRepository {
  list(): Promise<AgentConfig[]>;
  get(id: string): Promise<AgentConfig | undefined>;
  save(agent: AgentConfig): Promise<void>;
  delete(id: string): Promise<void>;
}
export interface SessionRepository {
  list(): Promise<Session[]>;
  get(id: string): Promise<Session | undefined>;
  /**
   * 整行 upsert。按约定**不写 `customTitle` / `agentTitle`**：入参是可能过期的内存快照，
   * 用它写会话名会被后续任意一次整行 save 覆盖回旧值。会话名只走 `saveTitles()`。
   */
  save(session: Session): Promise<void>;
  /** 会话名的唯一写入口。按列定向更新，未传的档位保持原值。 */
  saveTitles(id: string, patch: { customTitle?: string | null; agentTitle?: string | null; updatedAt?: string }): Promise<void>;
}
export interface TaskRecord { id: string; sessionId: string; prompt: string; /** 实际提交给 ACP Agent 的本轮文本；旧任务或未执行任务为空。 */ sentPrompt?: string | null; /** 本轮最终输出（该轮最后一条 assistant 文本）；未跑完判定流程的轮次为空。 */ finalText?: string | null; status: string; createdAt: string; updatedAt: string }
export interface TaskRepository { save(task: TaskRecord): Promise<void>; listBySession(sessionId: string): Promise<TaskRecord[]>; firstPromptBySessions(sessionIds: string[]): Promise<Record<string, string>> }
/**
 * 一轮的边界与体积。`segments` 是这一轮锚点之后的事件条数（原始行数，未压缩）——
 * 只用来判断「有没有过程可展开」和大致多大，精确内容按 `startSequence`/`endSequence` 再取。
 * 两端都排他：范围是 `(startSequence, endSequence)`，所以相邻两轮既不重叠也不漏。
 */
export interface TurnRange { taskId: string; startSequence: number; endSequence: number; segments: number }
export interface EventRepository {
  append(event: AgentEvent): Promise<void>;
  list(sessionId: string, afterSequence?: number): Promise<AgentEvent[]>;
  /**
   * 逐行迭代原始事件（惰性）。全量回放走它，内存占用与历史长度解耦——
   * 一次性物化整段历史会把 daemon 拖到 OOM。同步迭代器：底层是 better-sqlite3。
   */
  iterate(sessionId: string, afterSequence?: number): Iterable<AgentEvent>;
  listCompacted(sessionId: string, afterSequence?: number): Promise<AgentEvent[]>;
  /** 按序号区间取事件并合并连续分片（含正文），两端排他，且必须有 limit 与字节预算。 */
  listCompactedRange(sessionId: string, range: { after: number; before: number; limit: number; maxBytes?: number }): Promise<AgentEvent[]>;
  /**
   * 原始事件（不合并）的区间读，两端排他，**无行数与字节上限**。
   * 只给「必须看全一整轮」的终态判定用：范围上界来自锚点，所以无上限也只覆盖一轮。
   */
  listRange(sessionId: string, range: { after: number; before: number }): Promise<AgentEvent[]>;
  /**
   * 有界前向分页读，两端只有下标下界（`sequence > after`），升序、最多 limit 行。
   * 流式回放必须走它，而不是 `iterate`：`iterate` 的 statement 会跨 await 保持打开，
   * 同一条连接上任何写入都会抛 "database connection is busy"，能把正在跑的轮次判失败。
   * 分页读一次同步读完并 finalize，内存占用同样与历史长度解耦。
   */
  listPage(sessionId: string, range: { after: number; limit: number }): Promise<AgentEvent[]>;
  listRecent(sessionId: string, limit: number, beforeSequence?: number): Promise<AgentEvent[]>;
  countBySession(sessionId: string): Promise<number>;
  maxSequence(sessionId: string): Promise<number>;
  /** 按轮次锚点切分会话，返回每轮的边界与过程条数。 */
  listTurns(sessionId: string): Promise<TurnRange[]>;
  /** 单个 taskId 的轮次边界；没有锚点（历史数据）时为 undefined。 */
  turnRange(sessionId: string, taskId: string): Promise<{ startSequence: number; endSequence: number } | undefined>;
}
export interface ConfigRepository {
  get(key: string): Promise<string | undefined>;
  set(key: string, value: string): Promise<void>;
  /** 原子条件写入；expected 为 undefined 时仅允许首次插入。 */
  compareAndSet?(key: string, expected: string | undefined, value: string): Promise<boolean>;
}
export interface ChannelMapping { id: string; channel: string; externalId: string; sessionId: string; extra?: string | null; createdAt: string }
export interface ChannelMappingRepository {
  get(channel: string, externalId: string): Promise<ChannelMapping | undefined>;
  list(channel: string): Promise<ChannelMapping[]>;
  save(mapping: ChannelMapping): Promise<void>;
}
/**
 * 定时任务：到点把 prompt 投递到会话。
 * - `append`：追加到 `sessionId` 这个会话，上下文连续。
 * - `new_session`：每次按 `sessionTemplate` 新建一个会话；有 `sessionId`（来源会话）时挂在它下面作为侧边会话，
 *   没有时（Web 上直接选 Agent/目录创建）就是独立会话。
 * 只有 `cron` 与 `runAt` 之一：前者周期、后者单次。待触发时 `nextRunAt` 非空，完成/停用后为空。
 */
export type ScheduleDelivery = 'append' | 'new_session';
export interface ScheduleSessionTemplate { agentId: string; cwd: string; model?: string; reasoningEffort?: string }
export interface ScheduleRecord {
  id: string;
  name: string;
  /** append 必填；new_session 可空。 */
  sessionId?: string | null;
  delivery: ScheduleDelivery;
  /** JSON 序列化的 ScheduleSessionTemplate；仅 new_session 使用。 */
  sessionTemplate?: string | null;
  cron?: string | null;
  runAt?: string | null;
  /** 固定间隔（分钟）；从上一次触发往后排，不受 cron 「需整除 60」的限制。 */
  intervalMinutes?: number | null;
  timezone: string;
  prompt: string;
  enabled: boolean;
  nextRunAt?: string | null;
  lastRunAt?: string | null;
  lastStatus?: string | null;
  runCount: number;
  createdBySessionId?: string | null;
  /** 业务自有扩展字段，JSON 字符串。 */
  extra?: string | null;
  createdAt: string;
  updatedAt: string;
}
export type ScheduleRunStatus = 'delivered' | 'skipped' | 'failed';
export interface ScheduleRunRecord { id: string; scheduleId: string; fireAt: string; status: ScheduleRunStatus; reason?: string | null; sessionId?: string | null; taskId?: string | null; createdAt: string }
export interface ScheduleRepository {
  list(): Promise<ScheduleRecord[]>;
  get(id: string): Promise<ScheduleRecord | undefined>;
  save(schedule: ScheduleRecord): Promise<void>;
  delete(id: string): Promise<void>;
  /** 到期（nextRunAt <= at）且启用的任务。 */
  listDue(at: string): Promise<ScheduleRecord[]>;
  /**
   * 条件抢占一次触发：仅当 nextRunAt 仍是 expected 时改成 next 并返回 true。
   * 多个进程或重启后的重复扫描只有一方能抢到，是「不重复触发」的核心。
   */
  claim(id: string, expected: string, next: string | null, at: string): Promise<boolean>;
  /** 写入一条执行记录；(scheduleId, fireAt) 已存在时返回 false，不覆盖。 */
  addRun(run: ScheduleRunRecord): Promise<boolean>;
  updateRun(run: ScheduleRunRecord): Promise<void>;
  listRuns(scheduleId: string, limit?: number): Promise<ScheduleRunRecord[]>;
  /** 跨任务的最近执行记录，按触发时间倒序；给 scheduleIds 时只看这些任务。 */
  listRecentRuns(limit: number, scheduleIds?: string[]): Promise<ScheduleRunRecord[]>;
}
export interface ArtifactRepository {
  ensureLocalProject(cwd: string): Promise<void>;
  saveToolCall(sessionId: string, data: ToolCallData): Promise<void>;
  savePermission(sessionId: string, data: PermissionRequestData): Promise<void>;
  saveError(sessionId: string, message: string, details?: unknown): Promise<void>;
}

export interface RepositoryBundle {
  agents: AgentRepository;
  sessions: SessionRepository;
  tasks: TaskRepository;
  events: EventRepository;
  config: ConfigRepository;
  channelMappings: ChannelMappingRepository;
  schedules: ScheduleRepository;
  artifacts: ArtifactRepository;
  close(): void;
}

export const now = () => new Date().toISOString();
export const makeId = (prefix: string) => `${prefix}_${crypto.randomUUID()}`;

/** 飞书卡片默认保留的执行阶段数量。 */
export const defaultLarkTraceLimit = 50;
