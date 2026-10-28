import { EventEmitter } from 'node:events';
import type { AgentConfig, AgentEvent, EventType, ImportedTurn, PermissionMode, PermissionRequestData, RepositoryBundle, Session, StartSessionInput, TaskRecord, ToolCallData, ToolRiskPolicy } from '@agent-dock/agent-dock-shared';
import { agentConfigSchema, makeId, now, pickFinalAssistantText, RuntimeError, unresolvedToolCallsAfterAnswer } from '@agent-dock/agent-dock-shared';
export type { AgentConfig };
import { AcpxAdapter, describeAcpError, type NormalizedDriverEvent } from '@agent-dock/agent-dock-acp-client';
import { JsonlTransport, PipeTransport, probeAgent, PtyTransport, type ProbeMatrix } from '@agent-dock/agent-dock-transports';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { SESSION_TITLE_MAX_CHARS, resolveSessionTitle } from './session-title.js';
export { SESSION_TITLE_MAX_CHARS } from './session-title.js';

export function selectProtocol(probes: ProbeMatrix): 'acp' | 'jsonl' | 'pipe' | 'pty' {
  if (probes.acp) return 'acp';
  if (probes.jsonl) return 'jsonl';
  if (probes.pipe) return 'pipe';
  return 'pty';
}

/**
 * 启动发现集与库内已编辑行的合并语义：
 * 用户在面板对内置 agent 的编辑重启不丢；version 永远用新探测值；
 * disabled 以库内为准（删内置 = 置 disabled，重启不复活）；permissionMode 固定完全访问。
 */
export function mergeDiscoveredAgent(stored: AgentConfig | undefined, discovered: AgentConfig): AgentConfig {
  if (!stored) return { ...discovered, permissionMode: 'full-trust', disabled: discovered.disabled ?? false };
  return { ...discovered, ...stored, version: discovered.version, permissionMode: 'full-trust', builtin: true, disabled: stored.disabled ?? false };
}

export function correlateToolCalls(events: Array<NormalizedDriverEvent | undefined>) {
  const calls = new Map<string, ToolCallData>();
  for (const event of events) {
    if (!event || (event.type !== 'tool_call' && event.type !== 'tool_result')) continue;
    const data = event.data;
    const previous = calls.get(data.id);
    calls.set(data.id, { id: data.id, name: data.name ?? previous?.name ?? 'tool', input: data.input ?? previous?.input, output: data.output ?? previous?.output, status: data.status, startedAt: previous?.startedAt ?? now(), completedAt: data.status === 'completed' || data.status === 'failed' ? now() : undefined });
  }
  return calls;
}

export interface AgentDriver {
  start(): Promise<void>;
  send(prompt: string): Promise<void>;
  interrupt(): Promise<void>;
  resume(): Promise<void>;
  stop(options?: { discardSession?: boolean }): Promise<void>;
  resolvePermission?(id: string, approved: boolean): Promise<boolean>;
  setModel?(model: string): Promise<void>;
  setReasoningEffort?(reasoningEffort: string): Promise<void>;
  setRiskPolicy?(policy?: ToolRiskPolicy): void;
  setPermissionMode?(mode: PermissionMode): void;
}

type DriverFactory = (agent: AgentConfig, protocol: 'acp' | 'jsonl' | 'pipe' | 'pty', onEvent: (e: NormalizedDriverEvent) => void, onExit: (code: number | null) => void, sessionId: string, options?: { resumeSessionId?: string }) => AgentDriver;

export interface RuntimeOptions {
  acpxCommand?: string;
  driverFactory?: DriverFactory;
  probe?: typeof probeAgent;
  driverIdleTimeoutMs?: number;
  cleanupIntervalMs?: number;
  sessionEnvironment?: (session: Session) => Record<string, string>;
  /** 创建会话时确定一次，并作为持久 ACP session 的 system prompt 保存。 */
  createSystemPrompt?: (session: Session) => string | undefined;
  sessionPrompt?: (session: Session, prompt: string) => string | Promise<string>;
}

/** `runOnce` 的入参：借哪个 Agent、问什么、最多等多久。 */
export interface RunOnceInput {
  agentId: string;
  /** 记进会话用户消息的原始诉求。 */
  prompt: string;
  /** 实际发给 Agent 的提示词；省略时与 prompt 相同（例如平台要在原诉求外再包一层指令）。 */
  agentPrompt?: string;
  cwd?: string;
  model?: string;
  reasoningEffort?: string;
  /** 超过这个时长就中断本轮并返回 timeout。省略表示不设上限。 */
  timeoutMs?: number;
  source?: string;
  sourceId?: string;
  /** 结束后是否归档会话，默认 true。 */
  archiveWhenDone?: boolean;
}

export type RunOnceStatus = 'completed' | 'failed' | 'interrupted' | 'timeout';

export interface RunOnceResult {
  sessionId: string;
  taskId: string;
  status: RunOnceStatus;
  /** 最终输出文本；没有最终输出（含失败 / 超时）时是空串。 */
  text: string;
  error?: string;
}

// 早期导入会给第一轮加「（外部会话）」前缀，库里还留着这样的任务；对齐时去掉，否则这些会话永远对不上。
const normalizePrompt = (text: string | null | undefined) => (text ?? '').replace(/^\s*（外部会话）/, '').replace(/\s+/g, ' ').trim();

/**
 * 外部历史与本地任务按子序列对齐，返回最后一个对上的本地轮次之后的外部轮次。
 *
 * 导入会话与外部客户端（如 Codex 桌面端）续写的是同一条外部线程，外部历史天然包含本地
 * 全部轮次，只是可能夹着在外部客户端里发、还没同步过来的轮次（两边交替聊）。这些夹在中间
 * 的轮次放不进时间线中间，只计数到 skipped 交给调用方提示；本地已完成的轮次在外部完全
 * 找不到时（被重新导入、外部历史被改写）才判定为无法合并，返回 undefined。
 *
 * 本地一轮可能以 prompt（用户原话）或 sentPrompt（注入了会话工具说明等的实际发送文本）
 * 出现在外部历史里，两者任一对上即算同一轮。没发出去的任务（排队、取消、发送前就失败）不参与对齐；
 * 中断或失败的任务外部可能没记下，找不到时跳过而不判失败。
 */
export function alignImportedTurns(tasks: TaskRecord[], external: ImportedTurn[]): { turns: ImportedTurn[]; skipped: number } | undefined {
  const local = [...tasks]
    .filter(task => task.status !== 'queued' && task.status !== 'cancelled')
    // 非完成且没有 sentPrompt 的任务从没发到 Agent（如重连失败），参与对齐会抢走后面同名重发那一轮的位置。
    .filter(task => task.status === 'completed' || Boolean(task.sentPrompt))
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  const prompts = external.map(turn => normalizePrompt(turn.prompt));
  let cursor = 0;
  let skipped = 0;
  for (const task of local) {
    const candidates = [normalizePrompt(task.prompt), normalizePrompt(task.sentPrompt)].filter(Boolean);
    let index = cursor;
    while (index < prompts.length && !candidates.includes(prompts[index]!)) index++;
    if (index < prompts.length) { skipped += index - cursor; cursor = index + 1; continue; }
    if (task.status !== 'completed') continue;
    return undefined;
  }
  return { turns: external.slice(cursor), skipped };
}

/** 沿 cause 链找 Codex 的 writer 锁冲突：适配层会把它包成「无法设置权限模式」等外层错误。 */
function mentionsActiveWriter(error: unknown) {
  for (let current: unknown = error, depth = 0; current && depth < 6; depth++) {
    if (/active writer/i.test(describeAcpError(current))) return true;
    current = current instanceof Error ? current.cause : undefined;
  }
  return false;
}

export class AgentDockRuntime {
  private readonly emitter = new EventEmitter();
  private readonly drivers = new Map<string, AgentDriver>();
  private readonly activeTurns = new Set<string>();
  private readonly activeTasks = new Map<string, TaskRecord>();
  private readonly interruptedTurns = new Set<string>();
  private readonly hardInterrupts = new Set<string>();
  private readonly turnWaiters = new Map<string, Set<() => void>>();
  private readonly queues = new Map<string, TaskRecord[]>();
  private readonly queuedAgentPrompts = new Map<string, string>();
  private readonly queuedRiskPolicies = new Map<string, ToolRiskPolicy>();
  private readonly queueRuns = new Map<string, Promise<void>>();
  private readonly syncingSessions = new Set<string>();
  private readonly sequences = new Map<string, number>();
  // taskId → 本轮提问锚点的序号。runTask 写锚点时就记下来，判终态时不必再扫一遍该会话的锚点。
  // 只是几个数字，随手留着比重新扫一次 145 万行便宜得多。
  private readonly turnAnchors = new Map<string, number>();
  private readonly permissions = new Map<string, PermissionRequestData>();
  private readonly driverEventChains = new Map<string, Promise<void>>();
  private readonly driverEventErrors = new Map<string, unknown>();
  private readonly driverStopReasons = new Map<string, string>();
  private readonly factory: DriverFactory;
  private readonly lastActivity = new Map<string, number>();
  private readonly cleanupTimer?: NodeJS.Timeout;
  private cleanupRun?: Promise<void>;

  constructor(private readonly repos: RepositoryBundle, private readonly options: RuntimeOptions = {}) {
    this.factory = options.driverFactory ?? ((agent, protocol, onEvent, onExit, sessionId, driverOptions) => {
      if (protocol === 'acp') return new AcpxAdapter({ ...agent, env: { ...agent.env, agentdock_session_id: sessionId } }, { sessionKey: sessionId, onEvent, ...(driverOptions?.resumeSessionId ? { resumeSessionId: driverOptions.resumeSessionId } : {}) });
      if (protocol === 'pty') return new PtyTransport(agent, { onEvent, onExit });
      if (protocol === 'pipe') return new PipeTransport(agent, { onEvent, onExit });
      return new JsonlTransport(agent, { onEvent, onExit });
    });
    const interval = options.cleanupIntervalMs ?? 5 * 60_000;
    if ((options.driverIdleTimeoutMs ?? 6 * 60 * 60_000) > 0 && interval > 0) {
      // 定时清理是后台任务：任何未预期的异常都不能变成 unhandledRejection 打挂进程。
      this.cleanupTimer = setInterval(() => void this.cleanupIdleDrivers().catch(() => undefined), interval);
      this.cleanupTimer.unref();
    }
  }

  private touch(sessionId: string) { this.lastActivity.set(sessionId, Date.now()); }
  private permissionKey(sessionId: string, permissionId: string) { return `${sessionId}:${permissionId}`; }
  private enqueueDriverEvent(session: Session, event: NormalizedDriverEvent) {
    const previous = this.driverEventChains.get(session.id) ?? Promise.resolve();
    const next = previous.then(() => this.consume(session, event)).catch(error => {
      if (!this.driverEventErrors.has(session.id)) this.driverEventErrors.set(session.id, error);
    });
    this.driverEventChains.set(session.id, next);
    void next.finally(() => {
      if (this.driverEventChains.get(session.id) === next) this.driverEventChains.delete(session.id);
    });
  }
  private async flushDriverEvents(sessionId: string) {
    while (true) {
      const pending = this.driverEventChains.get(sessionId);
      if (!pending) break;
      await pending;
      if (this.driverEventChains.get(sessionId) === pending) break;
    }
    const error = this.driverEventErrors.get(sessionId);
    this.driverEventErrors.delete(sessionId);
    if (error) throw error;
  }
  private static isTruncatedStopReason(reason?: string) {
    return reason === 'max_tokens' || reason === 'truncated';
  }
  // 终态规则（工具是否未返回结果、哪条文本算最终输出）已收敛到 shared —— runtime 判 task 成败、
  // Web 时间线挑最终输出、飞书卡片挑最终回复必须给出同一个答案，规则见
  // packages/shared/src/turn-outcome.ts。
  /**
   * 取出本轮（该 taskId 的提问锚点之后）的事件。终态判定必须看全一整轮，所以这里按锚点定出
   * 的区间读，**绝不回退全量**：认不出锚点就是认不出这一轮，宁可返回空，也不能把别的轮次
   * （或整个会话）的文本当成它的最终输出——那等于把别人的回答当成本轮结果交给用户。
   *
   * `anchor` 是调用方手里已有的锚点序号（runTask 刚写的那个），带上它可以省掉一次锚点扫描；
   * 没有就按 taskId 精确查一次边界。
   */
  private async turnEventsFor(sessionId: string, taskId: string, anchor?: number): Promise<AgentEvent[]> {
    if (anchor !== undefined) {
      // 这个锚点是本进程刚为「当前这一轮」写的：同一会话同时只跑一轮（activeTurns 守卫），
      // 所以这一轮就是最后一轮，上界取该会话最大序号 +1 即可。
      return this.repos.events.listRange(sessionId, { after: anchor, before: (await this.repos.events.maxSequence(sessionId)) + 1 });
    }
    const range = await this.repos.events.turnRange(sessionId, taskId);
    return range ? this.repos.events.listRange(sessionId, { after: range.startSequence, before: range.endSequence }) : [];
  }
  private async resolveTaskOutcome(session: Session, task: TaskRecord): Promise<{ status: 'completed' | 'failed' | 'interrupted'; stopReason?: string; message?: string; finalText?: string }> {
    const stopReason = this.driverStopReasons.get(session.id);
    if (this.interruptedTurns.has(session.id) || stopReason === 'cancelled') return { status: 'interrupted', stopReason };
    if (AgentDockRuntime.isTruncatedStopReason(stopReason)) {
      return { status: 'failed', stopReason, message: `输出因达到 token 上限被截断（stopReason: ${stopReason}），未产生完整最终输出` };
    }
    // 终态判定只读一次事件：unresolvedToolCallsAfterAnswer 与 pickFinalAssistantText 共用同一份切片。
    // 切片由本轮锚点定界，不再「先全量读整个会话再切」——重会话上那一次是几百 MB 的读取。
    const turnEvents = await this.turnEventsFor(session.id, task.id, this.turnAnchors.get(task.id));
    // 顺便把这段文本带出去落库（调用方写进 task.finalText）：判「有没有最终输出」用的就是它，
    // 不再让轨迹面板为了显示每轮输出重新扫一遍事件——重会话上一轮就是全量扫描。
    const finalText = pickFinalAssistantText(turnEvents);
    // 只有「卡在最终输出之后的工具调用」才算这一轮没结束：Agent 停在等工具上。最终输出之前
    // 就没收口的调用，说明 Agent 已经越过它继续作答（见 shared/turn-outcome.ts 的实测说明）。
    if (unresolvedToolCallsAfterAnswer(turnEvents).length) {
      return { status: 'failed', stopReason, message: 'Agent 存在未返回结果的工具调用，本轮任务未正常结束', finalText };
    }
    // 判「有没有最终输出」必须与取文本用同一条规则：ACP 按 chunk 推送正文，只看有没有
    // 最后一条 assistant text 会把「只剩 Agent 自己告警」的轮次判成 completed 却给不出正文。
    if (!finalText) {
      return { status: 'failed', stopReason, message: 'Agent 未返回最终输出', finalText };
    }
    return { status: 'completed', stopReason, finalText };
  }
  private onDriverEvent(session: Session) {
    return (event: NormalizedDriverEvent) => this.enqueueDriverEvent(session, event);
  }
  private configureAgentForSession(agent: AgentConfig, session: Session): AgentConfig {
    return {
      ...agent,
      cwd: session.cwd,
      model: session.model,
      reasoningEffort: session.reasoningEffort,
      systemPrompt: session.systemPrompt ?? agent.systemPrompt,
      permissionMode: session.permissionMode ?? agent.permissionMode,
      env: { ...agent.env, ...this.options.sessionEnvironment?.(session) }
    };
  }

  async initialize(agents: AgentConfig[]) {
    // Configuration is the source of truth on every boot and removes built-ins
    // that are no longer discovered from the ACPX registry. Panel edits to
    // built-ins survive via stored-row merge (see mergeDiscoveredAgent).
    const configuredIds = new Set(agents.map(agent => agent.id));
    const existingRows = await this.repos.agents.list();
    for (const existing of existingRows) if (existing.builtin && !configuredIds.has(existing.id)) await this.repos.agents.delete(existing.id);
    const storedById = new Map(existingRows.map(row => [row.id, row]));
    for (const agent of agents) await this.repos.agents.save(mergeDiscoveredAgent(storedById.get(agent.id), agent));
    for (const session of await this.repos.sessions.list()) {
      if (session.permissionMode !== 'full-trust') {
        session.permissionMode = 'full-trust';
        session.updatedAt = now();
        await this.repos.sessions.save(session);
      }
      if (session.archivedAt) continue;
      const persistedTasks = await this.repos.tasks.listBySession(session.id);
      if (!persistedTasks.length && ['created', 'starting', 'failed'].includes(session.state)) {
        const message = session.error ?? 'AgentDock 守护进程重启，未完成启动的会话已回收';
        session.state = 'failed';
        session.error = message;
        session.archivedAt = now();
        session.updatedAt = session.archivedAt;
        await this.repos.sessions.save(session);
        continue;
      }
      const orphaned = persistedTasks.filter(task => task.status === 'running');
      if (orphaned.length) {
        const message = 'AgentDock 守护进程重启，正在进行的任务已中断';
        for (const task of orphaned) {
          await this.saveTask(task, 'interrupted');
          await this.repos.artifacts.saveError(session.id, message);
          await this.emit(session.id, 'error', { message });
        }
        await this.saveState(session, 'interrupted', message);
      }
      const queued = persistedTasks.filter(task => task.status === 'queued').sort((left, right) => left.createdAt.localeCompare(right.createdAt));
      if (queued.length) {
        this.queues.set(session.id, queued);
        if (!['stopped', 'failed'].includes(session.state)) this.scheduleQueue(session.id);
      }
    }
  }
  async listAgents(includeDisabled = false) {
    const agents = await this.repos.agents.list();
    return includeDisabled ? agents : agents.filter(agent => !agent.disabled);
  }
  /** 面板创建自定义 agent：id 冲突 409，内置 id 禁止占用。 */
  async createAgent(input: unknown): Promise<AgentConfig> {
    const parsed = agentConfigSchema.parse(input);
    if (['claude', 'codex', 'gemini'].includes(parsed.id)) throw new RuntimeError('AGENT_ID_RESERVED', `内置 Agent ID 不可占用：${parsed.id}`, 409);
    if (await this.repos.agents.get(parsed.id)) throw new RuntimeError('AGENT_EXISTS', `Agent 已存在：${parsed.id}`, 409);
    const agent: AgentConfig = { ...parsed, builtin: false, disabled: false, permissionMode: 'full-trust' };
    await this.repos.agents.save(agent);
    return agent;
  }
  /** 面板全量更新；builtin 标记与 disabled 不接受此接口修改（删除走 deleteAgent）。 */
  async updateAgent(id: string, input: unknown): Promise<AgentConfig> {
    const existing = await this.repos.agents.get(id);
    if (!existing) throw new RuntimeError('AGENT_NOT_FOUND', `Unknown agent: ${id}`, 404);
    const parsed = agentConfigSchema.parse(input);
    if (parsed.id !== id) throw new RuntimeError('AGENT_ID_IMMUTABLE', 'Agent ID 不可修改', 409);
    const agent: AgentConfig = { ...parsed, builtin: existing.builtin, disabled: existing.disabled, permissionMode: 'full-trust' };
    await this.repos.agents.save(agent);
    return agent;
  }
  /**
   * 启用/停用 Agent。停用是「保留配置但不让新建会话选它」——store 里存的，不是真删。
   *
   * 单独开一个入口而不是塞进 updateAgent：后者的契约是「面板全量更新，builtin 与 disabled
   * 一律以库内为准」，正是为了让表单提交不能把人锁在外面。启用必须能绕过那条规则，
   * 否则内置 Agent 一旦停用就再也回不来。
   */
  async setAgentDisabled(id: string, disabled: boolean): Promise<AgentConfig> {
    const existing = await this.repos.agents.get(id);
    if (!existing) throw new RuntimeError('AGENT_NOT_FOUND', `Unknown agent: ${id}`, 404);
    const agent: AgentConfig = { ...existing, disabled };
    await this.repos.agents.save(agent);
    return agent;
  }
  /** 删自定义 agent 为物理删除；删内置 agent 只置 disabled（启动 GC 会复活真删除）。 */
  async deleteAgent(id: string): Promise<{ disabled: boolean }> {
    const existing = await this.repos.agents.get(id);
    if (!existing) throw new RuntimeError('AGENT_NOT_FOUND', `Unknown agent: ${id}`, 404);
    if (existing.builtin) {
      await this.repos.agents.save({ ...existing, disabled: true });
      return { disabled: true };
    }
    await this.repos.agents.delete(id);
    return { disabled: false };
  }
  // 列表标题按「用户手改的 > Agent 推来的 > 首条 prompt 摘要」三级回退；三者都没有的会话
  // title 缺省（渲染层再退到 Agent 名 / agentId）。composeSessionTitle 是唯一的口径，
  // getSession / listSessions / 事件回调都走它，否则同一会话在不同接口里会显示成两个名字。
  private composeSessionTitle(session: Session, firstPrompt?: string | null) {
    return resolveSessionTitle({ customTitle: session.customTitle, agentTitle: session.agentTitle, firstPrompt });
  }
  async listSessions() {
    const list = await this.repos.sessions.list();
    const firstPrompts = await this.repos.tasks.firstPromptBySessions(list.map(session => session.id));
    return list.map(session => this.withTitle(session, firstPrompts[session.id]));
  }
  /**
   * `getSession()` 以前只返回裸行、不带标题，于是 `GET /api/sessions/:id` 和列表页
   * 对不上（同一个会话，列表有名字、详情没有）。现在两条路都补上标题，只是详情
   * 需要多查一次该会话的首条 prompt——列表那次是批量查，这里只有一条会话，代价相同量级。
   */
  async getSessionWithTitle(id: string) {
    const session = await this.repos.sessions.get(id);
    if (!session) return undefined;
    const firstPrompts = await this.repos.tasks.firstPromptBySessions([id]);
    return this.withTitle(session, firstPrompts[id]);
  }
  getSession(id: string) { return this.repos.sessions.get(id); }
  /**
   * 把算好的标题贴到会话上。三级全空时**不加字段**，而不是加一个空串——
   * `sessionLabel()` 判的是真值，空串和缺字段在渲染层等价，但空串会污染 JSON 输出。
   */
  private withTitle(session: Session, firstPrompt?: string | null): Session {
    const resolved = this.composeSessionTitle(session, firstPrompt);
    return resolved ? { ...session, title: resolved.title, titleSource: resolved.source } : session;
  }
  /** 变更会话名后要回给调用方与 SSE 的那一份，字段集必须和 listSessions 一致。 */
  private async titledSession(session: Session): Promise<Session> {
    const firstPrompts = await this.repos.tasks.firstPromptBySessions([session.id]);
    return this.withTitle(session, firstPrompts[session.id]);
  }
  getEvents(id: string, after = 0) { return this.repos.events.list(id, after); }
  /**
   * 逐行惰性迭代原始事件。**服务端流式回放不要用它**：daemon 只有一条 SQLite 连接，
   * 迭代器跨 await 存活期间任何写入都会抛 "database connection is busy"，见 getEventPage。
   * 它留给「自己持有独立连接、且中间不 await」的场景（如 CLI 转录）。
   */
  iterateEvents(id: string, after = 0) { return this.repos.events.iterate(id, after); }
  /**
   * 有界前向分页读原始事件。服务端流式回放（SSE / `/events`）必须走它，不能走 `iterateEvents`：
   * 那条路径会在 await 背压期间把 better-sqlite3 的 statement 挂着，同连接上任何写入都抛
   * "database connection is busy"，把正在跑的轮次判失败。
   */
  getEventPage(id: string, after: number, limit: number) { return this.repos.events.listPage(id, { after, limit }); }
  getCompactedEvents(id: string, after = 0) { return this.repos.events.listCompacted(id, after); }
  getRecentEvents(id: string, limit: number, beforeSequence?: number) { return this.repos.events.listRecent(id, limit, beforeSequence); }
  /** 事件总行数，只给「被截断的读取」标总量用，不读行内容。 */
  countEvents(id: string) { return this.repos.events.countBySession(id); }
  /**
   * 该会话当前最大事件序号（空会话为 0）。全量回放要用它当快照上界：
   * 分页读每次都是新查询，不加上界就会一直追新事件，JSON 响应收不了尾。
   */
  maxEventSequence(id: string) { return this.repos.events.maxSequence(id); }
  /**
   * 按轮次锚点切分会话：每轮的起止序号与过程条数。整个面板只请求一次——
   * 锚点扫描要读该会话的全部 text 事件（重会话实测 184 ms），不能按轮算。
   */
  getTurns(id: string) { return this.repos.events.listTurns(id); }
  /** 取一轮的事件，已合并连续分片（含正文），两端排他且带条数与字节预算。 */
  getTurnEvents(id: string, range: { after: number; before: number; limit: number; maxBytes?: number }) { return this.repos.events.listCompactedRange(id, range); }
  getTasks(id: string) { return this.repos.tasks.listBySession(id); }
  /**
   * 取某一轮任务的最终输出文本：该 taskId 的 user prompt 之后、最后一次活动（思考 / 工具调用）
   * 之后的最后一条 assistant 文本；严格规则取不到时退化为该轮最后一条 assistant 文本。
   * 整轮没有任何 assistant 文本时返回空串。
   *
   * 判定规则与 task 成败、Web 时间线、飞书卡片共用同一实现（packages/shared/src/turn-outcome.ts）——
   * 否则「平台借 Agent 跑任务」拿到的文本会和界面上标着「最终输出」的那条对不上。
   */
  async getTurnText(sessionId: string, taskId: string): Promise<string> {
    return (await this.readTurnResult(sessionId, taskId)).text;
  }

  /**
   * 读一轮的最终输出与失败原因。两者共用同一份事件切片，避免每轮把整个会话的事件读两遍。
   *
   * 失败原因取自本轮最后一条 error 事件——那是 runTask 判定 task 失败时落库的同一句话
   * （`Agent 未返回最终输出` / `Agent 存在未返回结果的工具调用…`）。调用方需要知道
   * 「为什么没拿到结果」，只回一个 failed 等于让人去翻事件。
   */
  private async readTurnResult(sessionId: string, taskId: string): Promise<{ text: string; error?: string }> {
    const turnEvents = await this.turnEventsFor(sessionId, taskId, this.turnAnchors.get(taskId));
    // 取文本要用 pickFinalAssistantText 而不是自己看最后一条：ACP 按 chunk 推送正文，
    // 这里拿到的是原始事件流，没有经过 Web 时间线 / 飞书卡片那种 compact 折叠。
    const text = pickFinalAssistantText(turnEvents);
    // 倒着扫最后一条 error：findLast 要 ES2023 lib，tsconfig 目标停在 ES2022。
    let message = '';
    for (let index = turnEvents.length - 1; index >= 0 && !message; index--) {
      const event = turnEvents[index]!;
      if (event.type !== 'error') continue;
      const value = (event.data as Record<string, unknown> | undefined)?.message;
      if (typeof value === 'string') message = value;
    }
    return { text, ...(message ? { error: message } : {}) };
  }

  private async saveState(session: Session, state: Session['state'], error?: string) {
    this.touch(session.id);
    session.state = state; session.updatedAt = now(); session.error = error;
    await this.repos.sessions.save(session);
    await this.emit(session.id, 'status', { state, ...(error ? { error } : {}) });
  }

  // A task-level failure (e.g. no final output, a capped turn, or a transient
  // driver error) must not permanently poison a shared session: it should keep
  // accepting future turns and draining its queue. Only hard failures (agent
  // start failure, process exit, explicit stop) leave a session in the
  // `failed` terminal state. When a task fails we return the session to a
  // reusable `idle` state while surfacing the last task error for the UI.
  private async recoverSessionAfterTask(session: Session, error: string) {
    if (session.archivedAt || ['stopped', 'failed'].includes(session.state)) return;
    this.touch(session.id);
    session.state = 'idle'; session.updatedAt = now(); session.error = error;
    await this.repos.sessions.save(session);
    await this.emit(session.id, 'status', { state: 'idle', error });
  }

  /** 导入会话的 resume 参数：只有 source='import' 的会话才需要（重）恢复外部 ACP 会话。 */
  private resumeOptions(session: Session): { resumeSessionId?: string } | undefined {
    return session.source === 'import' && session.sourceId ? { resumeSessionId: session.sourceId } : undefined;
  }

  /**
   * 把导入的外部历史落成 AgentDock 的轮次：一轮用户提问 + 该轮过程事件 + 一个 completed。
   * 形状与真实轮次对齐（task + role=user 的 text 锚点 + completed），时间线分组、轮次边界、
   * 标题提取都按既有逻辑工作，不需要为导入单开渲染路径。
   */
  private async seedImportedTurns(session: Session, turns: ImportedTurn[]) {
    for (const turn of turns) {
      const stamp = now();
      const task: TaskRecord = { id: makeId('task'), sessionId: session.id, prompt: turn.prompt, finalText: turn.finalText ?? null, status: 'completed', createdAt: stamp, updatedAt: stamp };
      await this.repos.tasks.save(task);
      await this.emit(session.id, 'task', { task });
      await this.emit(session.id, 'text', { text: turn.prompt, role: 'user', taskId: task.id });
      for (const event of turn.events) await this.emit(session.id, event.type, { ...event.data, taskId: task.id });
      await this.emit(session.id, 'completed', { stopReason: 'end_turn' });
    }
    if (turns.length) session.lastMessageAt = now();
  }

  /**
   * 把外部 Agent（如 Codex 桌面端）在导入之后新产生的轮次补进导入会话。
   *
   * 先收掉本会话自己的 driver：它持有外部会话的 writer 锁，不放掉临时连接读不到历史。
   * driver 之后按 resumeOptions 惰性重连，不需要在这里恢复。读到的外部轮次与本地任务按序对齐，
   * 只追加尾部多出来的部分；对不上说明两边各自续写过，合并必然错位，直接拒绝。
   */
  async syncImportedSession(id: string, load: (agent: AgentConfig, session: Session) => Promise<{ replayed: boolean; turns: ImportedTurn[] }>) {
    const { session, driver } = await this.active(id);
    if (session.source !== 'import' || !session.sourceId) throw new RuntimeError('NOT_IMPORTED_SESSION', '只有从外部 Agent 导入的会话才能同步新消息', 409);
    const agent = await this.repos.agents.get(session.agentId);
    if (!agent) throw new RuntimeError('AGENT_NOT_FOUND', `Unknown agent: ${session.agentId}`, 404);
    const busy = () => this.activeTurns.has(id) || Boolean(this.queues.get(id)?.length) || this.syncingSessions.has(id);
    if (busy()) throw new RuntimeError('SESSION_BUSY', '会话还有任务在执行，等它结束后再同步', 409);
    this.syncingSessions.add(id);
    try {
      if (driver) {
        try { await driver.stop(); }
        catch { /* 与空闲回收同理：记录文件已被回收即视为已停止。 */ }
        finally { this.releaseSessionMemory(id); }
      }
      const transcript = await load(agent, session);
      if (!transcript.replayed) throw new RuntimeError('IMPORT_UNSUPPORTED', `Agent ${agent.name} 不支持读取历史（ACP session/load），无法同步`, 422);
      // 读历史期间可能有人发了新消息：那一轮已经走 driver 续写外部会话，这份快照就过时了。
      if (this.activeTurns.has(id) || this.queues.get(id)?.length) throw new RuntimeError('SESSION_BUSY', '同步期间会话有新任务开始执行，等它结束后再同步', 409);
      const aligned = alignImportedTurns(await this.repos.tasks.listBySession(id), transcript.turns);
      if (!aligned) throw new RuntimeError('IMPORT_DIVERGED', '外部 Agent 的历史里找不到本会话的部分轮次，无法合并；建议重新导入成新会话', 409);
      const latest = (await this.repos.sessions.get(id)) ?? session;
      await this.seedImportedTurns(latest, aligned.turns);
      if (aligned.turns.length) { latest.updatedAt = now(); await this.repos.sessions.save(latest); }
      return { added: aligned.turns.length, skipped: aligned.skipped };
    } finally {
      this.syncingSessions.delete(id);
    }
  }

  private async emit(sessionId: string, type: EventType, data: any, raw?: string) {
    const sequence = (this.sequences.get(sessionId) ?? (await this.repos.events.listRecent(sessionId, 1)).at(-1)?.sequence ?? 0) + 1;
    this.sequences.set(sessionId, sequence);
    const event: AgentEvent = { id: makeId('evt'), sessionId, sequence, type, timestamp: now(), data, ...(raw ? { raw } : {}) };
    await this.repos.events.append(event);
    this.emitter.emit(`session:${sessionId}`, event);
    return event;
  }

  private async saveTask(task: TaskRecord, status = task.status) {
    task.status = status; task.updatedAt = now();
    await this.repos.tasks.save(task);
    await this.emit(task.sessionId, 'task', { task: { ...task } });
  }

  subscribe(sessionId: string, listener: (event: AgentEvent) => void) {
    const name = `session:${sessionId}`; this.emitter.on(name, listener);
    return () => this.emitter.off(name, listener);
  }

  private async consume(session: Session, event: NormalizedDriverEvent) {
    this.touch(session.id);
    // Driver completion closes its stream; Runtime emits the single canonical
    // completed event after task persistence succeeds. Capture the real ACP
    // stopReason here so runTask can distinguish cancelled / truncated turns
    // from clean end_turn completions.
    if (event.type === 'completed') {
      if (typeof event.data?.stopReason === 'string') this.driverStopReasons.set(session.id, event.data.stopReason);
      return;
    }
    // 会话名变更只更新会话字段，不进时间线：它是元数据，不是对话内容，
    // 在轨迹里留一条「标题更新」只会干扰阅读。因此这里提前返回，不走下面的 emit。
    if (event.type === 'session_title') {
      await this.setAgentTitle(session, typeof event.data?.title === 'string' ? event.data.title : undefined);
      return;
    }
    let data = event.data;
    if (event.type === 'tool_call' || event.type === 'tool_result') {
      const completed = data.status === 'completed' || data.status === 'failed';
      data = { ...data, startedAt: data.startedAt ?? now(), ...(completed ? { completedAt: data.completedAt ?? now() } : {}) };
      await this.repos.artifacts.saveToolCall(session.id, data);
      await this.saveState(session, completed ? 'thinking' : 'running_tool');
    } else if (event.type === 'thinking' && session.state !== 'thinking') await this.saveState(session, 'thinking');
    else if (event.type === 'permission_request') {
      data = { ...data, status: data.status ?? 'pending' };
      if (data.status === 'pending') { this.permissions.set(this.permissionKey(session.id, data.id), data); await this.saveState(session, 'waiting_for_permission'); }
      await this.repos.artifacts.savePermission(session.id, data);
    } else if (event.type === 'error') {
      await this.repos.artifacts.saveError(session.id, data.message, data.detail);
      // Error events emitted during a turn describe that task. runTask owns the
      // terminal task outcome and returns a reusable shared Session to idle.
      // Outside an active turn the same event is a driver-level hard failure.
      if (!this.activeTurns.has(session.id)) await this.saveState(session, 'failed', data.message);
    }
    await this.emit(session.id, event.type, data, event.raw);
  }

  async start(input: StartSessionInput): Promise<Session> {
    const agent = await this.repos.agents.get(input.agentId);
    if (!agent) throw new RuntimeError('AGENT_NOT_FOUND', `Unknown agent: ${input.agentId}`, 404);
    if (agent.disabled) throw new RuntimeError('AGENT_DISABLED', `Agent 已停用：${input.agentId}`, 409);
    // systemPrompt 允许按会话覆盖：注入的上下文走 ACP system prompt，不落成用户消息。
    const configured = { ...agent, cwd: input.cwd ?? agent.cwd ?? process.cwd(), model: input.model ?? agent.model, reasoningEffort: input.reasoningEffort ?? agent.reasoningEffort, systemPrompt: input.systemPrompt ?? agent.systemPrompt, permissionMode: 'full-trust' as const };
    const capability = (this.options.probe ?? probeAgent)(configured, this.options.acpxCommand);
    if (!capability.available) throw new RuntimeError('AGENT_UNAVAILABLE', capability.detail ?? 'Agent unavailable', 503);
    const session: Session = { id: makeId('ses'), agentId: agent.id, state: 'created', cwd: configured.cwd!, model: configured.model, reasoningEffort: configured.reasoningEffort, permissionMode: configured.permissionMode, source: input.source, sourceId: input.sourceId, protocol: capability.protocol, runId: makeId('run'), createdAt: now(), updatedAt: now(), systemPrompt: configured.systemPrompt };
    if (this.options.createSystemPrompt) session.systemPrompt = this.options.createSystemPrompt(session);
    await this.repos.artifacts.ensureLocalProject(session.cwd);
    await this.repos.sessions.save(session);
    // 导入历史必须先于任何状态事件落库：时间线按 sequence 排序，先写历史才能让「过去」
    // 出现在「正在启动」之前。这里不 emit status，交给下面正常的启动流程。
    if (input.importTurns?.length) await this.seedImportedTurns(session, input.importTurns);
    await this.saveState(session, 'starting');
    const driver = this.factory(this.configureAgentForSession(configured, session), capability.protocol, this.onDriverEvent(session), code => { if (code && session.state !== 'stopped' && !this.interruptedTurns.has(session.id) && !this.hardInterrupts.has(session.id)) void this.saveState(session, 'failed', `Agent exited with code ${code}`).then(() => this.emit(session.id, 'error', { message: `Agent exited with code ${code}` })); }, session.id, input.resumeSessionId ? { resumeSessionId: input.resumeSessionId } : undefined);
    this.drivers.set(session.id, driver);
    try { await driver.start(); this.touch(session.id); await this.saveState(session, 'idle'); return session; }
    catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.hardInterrupts.add(session.id);
      try { await driver.stop({ discardSession: true }); } catch { /* Preserve the startup error. */ }
      await this.repos.artifacts.saveError(session.id, message);
      session.archivedAt = now();
      await this.saveState(session, 'failed', message);
      await this.emit(session.id, 'error', { message });
      this.releaseSessionMemory(session.id);
      // 保留原始错误为 cause：ACP/JSON-RPC 的真因常在 error.data.details（如 Codex 的
      // "thread ... already has an active writer"），只有顶层 message 会退化成 "Internal error"。
      // 调用方（导入接口）沿 cause 链取 details，才能给用户可读的原因。
      const wrapped = new RuntimeError('START_FAILED', message, 503);
      (wrapped as { cause?: unknown }).cause = error;
      throw wrapped;
    }
  }

  private async active(id: string) {
    const session = await this.repos.sessions.get(id);
    if (!session) throw new RuntimeError('SESSION_NOT_FOUND', `Unknown session: ${id}`, 404);
    if (session.archivedAt) throw new RuntimeError('SESSION_ARCHIVED', 'Archived sessions are read-only', 409);
    const driver = this.drivers.get(id);
    return { session, driver };
  }

  /**
   * 导入会话重连时，刚用完该外部会话的临时连接（同步、导入读历史）释放 writer 锁有延迟，
   * Codex 会报 active writer；短暂退避重试几次，避免「同步完马上发消息」直接失败。
   */
  private async startDriver(session: Session, driver: AgentDriver) {
    for (let attempt = 1; ; attempt++) {
      try { return await driver.start(); }
      catch (error) {
        if (!this.resumeOptions(session) || attempt >= 4 || !mentionsActiveWriter(error)) throw error;
        await new Promise(resolve => setTimeout(resolve, 1_500));
      }
    }
  }

  private async reconnect(session: Session) {
    const existing = this.drivers.get(session.id);
    if (existing) return existing;
    const agent = await this.repos.agents.get(session.agentId);
    if (!agent) throw new RuntimeError('AGENT_NOT_FOUND', `Unknown agent: ${session.agentId}`, 404);
    const configured = this.configureAgentForSession(agent, session);
    const driver = this.factory(configured, session.protocol!, this.onDriverEvent(session), code => {
      if (code && session.state !== 'stopped' && !this.interruptedTurns.has(session.id) && !this.hardInterrupts.has(session.id)) void this.saveState(session, 'failed', `Agent exited with code ${code}`).then(() => this.emit(session.id, 'error', { message: `Agent exited with code ${code}` }));
    }, session.id, this.resumeOptions(session));
    this.drivers.set(session.id, driver);
    try { await this.startDriver(session, driver); this.touch(session.id); return driver; }
    catch (error) { this.drivers.delete(session.id); throw error; }
  }

  private async applyRiskPolicy(session: Session, driver: AgentDriver | undefined, policy?: ToolRiskPolicy) {
    driver?.setRiskPolicy?.(policy);
    const directory = join(session.cwd, '.agentdock', 'security', 'sessions');
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, `${session.id}.json`), JSON.stringify(policy ?? { enabled: false }), { mode: 0o600 });
  }

  private async runTask(id: string, task: TaskRecord, agentPrompt = task.prompt, riskPolicy?: ToolRiskPolicy) {
    const { session } = await this.active(id);
    if (['stopped', 'failed'].includes(session.state)) throw new RuntimeError('INVALID_STATE', `Cannot send while session is ${session.state}`, 409);
    if (this.activeTurns.has(id)) throw new RuntimeError('TURN_IN_PROGRESS', 'Wait for the current response to finish', 409);
    this.activeTurns.add(id);
    this.activeTasks.set(id, task);
    this.touch(id);
    let driver: AgentDriver;
    try { driver = await this.reconnect(session); }
    catch (error) {
      this.activeTurns.delete(id); this.activeTasks.delete(id);
      await this.saveTask(task, 'failed');
      // 队列里的任务走 drainQueue，异常会被吞掉；不记一条 error，用户只能看到一个没有原因的失败。
      const message = `连接 Agent 失败：${describeAcpError(error)}`;
      await this.repos.artifacts.saveError(id, message).catch(() => undefined);
      await this.emit(id, 'error', { message, taskId: task.id });
      throw error;
    }
    if (riskPolicy) await this.applyRiskPolicy(session, driver, riskPolicy);
    await this.saveTask(task, 'running');
    // 这一条就是轮次锚点：它是本会话唯一可靠的「这一轮从哪开始」的标记，
    // 判终态、面板切轮、按轮取事件全靠它，所以序号要留一份在手上。
    const anchor = await this.emit(id, 'text', { text: task.prompt, role: 'user', taskId: task.id });
    this.turnAnchors.set(task.id, anchor.sequence);
    // 用户这一轮提问就是一次对话事件，蹭下面的 saveState 一起落盘，不额外多写一次库。
    session.lastMessageAt = now();
    await this.saveState(session, 'thinking');
    try {
      const resolvedAgentPrompt = await this.options.sessionPrompt?.(session, agentPrompt) ?? agentPrompt;
      task.sentPrompt = resolvedAgentPrompt;
      await this.repos.tasks.save(task);
      this.driverStopReasons.delete(id);
      await driver.send(resolvedAgentPrompt);
      await this.flushDriverEvents(id);
      const outcome = await this.resolveTaskOutcome(session, task);
      task.finalText = outcome.finalText;
      // 收尾也算一次对话事件（长轮次结束时该浮上来），同样蹭终端态的 saveState 落盘。
      session.lastMessageAt = now();
      if (outcome.status === 'interrupted') { await this.saveTask(task, 'interrupted'); await this.saveState(session, 'interrupted'); }
      else if (outcome.status === 'failed') {
        await this.saveTask(task, 'failed');
        if (outcome.message) { await this.repos.artifacts.saveError(id, outcome.message); await this.emit(id, 'error', { message: outcome.message }); await this.recoverSessionAfterTask(session, outcome.message); }
      } else { await this.saveTask(task, 'completed'); await this.saveState(session, 'completed'); await this.emit(id, 'completed', { stopReason: outcome.stopReason ?? 'end_turn' }); }
    } catch (error) {
      try { await this.flushDriverEvents(id); }
      catch { /* Preserve the driver error while ensuring preceding events finish first. */ }
      if (this.interruptedTurns.has(id) || this.driverStopReasons.get(id) === 'cancelled') await this.saveTask(task, 'interrupted');
      else { const message = error instanceof Error ? error.message : String(error); await this.saveTask(task, 'failed'); await this.repos.artifacts.saveError(id, message); await this.emit(id, 'error', { message }); await this.recoverSessionAfterTask(session, message); throw error; }
    } finally {
      const hardInterrupted = this.hardInterrupts.has(id);
      // 锚点只在本轮存续期间有效：`anchor` 那条捷径的上界是「会话当前最大序号 +1」，
      // 只因为「本轮就是最后一轮」才成立。留到下一轮开始之后，同一个 taskId 再被问到
      // （getTurnText 会被飞书对账之类的晚到调用重新用到）就会把后面几轮的文本算成本轮的。
      // 删掉只是让晚到的调用退回按锚点精确查边界——多一次扫描，但答案不会错。
      this.turnAnchors.delete(task.id);
      this.interruptedTurns.delete(id); this.activeTurns.delete(id); this.activeTasks.delete(id); this.touch(id);
      for (const resolve of this.turnWaiters.get(id) ?? []) resolve();
      this.turnWaiters.delete(id);
      if (!hardInterrupted) this.scheduleQueue(id);
    }
    return task;
  }

  async send(id: string, prompt: string, agentPrompt = prompt) {
    const task = { id: makeId('task'), sessionId: id, prompt, status: 'running', createdAt: now(), updatedAt: now() };
    return this.runTask(id, task, agentPrompt);
  }

  /**
   * 「借一个已配置的 Agent 跑一次任务，把最终输出文本拿回来」的一次性通道。
   *
   * 每次调用都新建会话（冷启动），任务结束即归档并把驱动收掉，会话记录留在库里可查。
   * 平台侧的 AI 能力（自动写描述、扩写、生成配置等）本身没有任何模型通道，只能借 Agent，
   * 所以入口收成一个方法，免得每个调用方各写一遍「起会话 → 订阅 → 等轮次 → 按序号水位
   * 合并落库事件 → 套终态规则」。
   *
   * 只有「会话根本起不来」才抛（AGENT_NOT_FOUND / AGENT_DISABLED / AGENT_UNAVAILABLE /
   * START_FAILED）——那时没有 sessionId / taskId 可报，返回值形状本身就是假的。轮次内部的
   * 失败一律落到 result.status / result.error。
   */
  async runOnce(input: RunOnceInput): Promise<RunOnceResult> {
    const session = await this.start({ agentId: input.agentId, cwd: input.cwd, model: input.model, reasoningEffort: input.reasoningEffort, source: input.source, sourceId: input.sourceId });
    const task: TaskRecord = { id: makeId('task'), sessionId: session.id, prompt: input.prompt, status: 'running', createdAt: now(), updatedAt: now() };
    let status: RunOnceStatus = 'failed';
    let error: string | undefined;
    let turnError: unknown;
    try {
      // runTask 在 driver 级错误时会抛。等待中的这一支必须自己接住 reject，否则超时把它
      // 抛在 race 之外时会变成 unhandledRejection，直接崩掉进程。
      const turn = this.runTask(session.id, task, input.agentPrompt ?? input.prompt)
        .then(() => undefined, (thrown: unknown) => { turnError = thrown; });
      const timedOut = await this.raceTimeout(turn, input.timeoutMs);
      if (timedOut) {
        // 超时必须真的把这一轮停掉：借来的 Agent 还在跑工具、还在烧 token，
        // 只是不等它了。stop 会置中断标记，runTask 随即把 task 落成 interrupted 而不是 failed。
        status = 'timeout';
        error = `等待 Agent 响应超过 ${input.timeoutMs}ms，本轮任务已中断`;
        await this.stop(session.id).catch(() => undefined);
        await turn;
      } else if (turnError) {
        error = turnError instanceof Error ? turnError.message : String(turnError);
      } else {
        status = task.status === 'completed' ? 'completed' : task.status === 'interrupted' ? 'interrupted' : 'failed';
      }
      const result = await this.readTurnResult(session.id, task.id);
      // 轮次内的失败原因（未返回最终输出 / 工具调用未返回结果）由 runTask 落成 error 事件，
      // 不带异常，所以只能从这一轮的事件里取；driver 级异常抛上来的话以异常文本为准。
      if (!error && status === 'failed') error = result.error;
      return { sessionId: session.id, taskId: task.id, status, text: result.text, ...(error ? { error } : {}) };
    } finally {
      // 平台借来的会话不该混进默认会话列表；归档后仍在库里，出问题能翻事件复盘。
      if (input.archiveWhenDone ?? true) await this.archive(session.id).catch(() => undefined);
    }
  }

  /** 等待 turn 结束，或到点返回 true。timeoutMs 缺省/非正数表示不设超时。 */
  private async raceTimeout(turn: Promise<unknown>, timeoutMs?: number): Promise<boolean> {
    if (!timeoutMs || timeoutMs <= 0) { await turn; return false; }
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await new Promise<boolean>(resolve => {
        timer = setTimeout(() => resolve(true), timeoutMs);
        void turn.then(() => resolve(false));
      });
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  async dispatch(id: string, prompt: string, mode: 'queue' | 'interrupt' = 'queue', agentPrompt = prompt, riskPolicy?: ToolRiskPolicy) {
    const { session } = await this.active(id);
    if (['stopped', 'failed'].includes(session.state)) throw new RuntimeError('INVALID_STATE', `Cannot send while session is ${session.state}`, 409);
    const task = { id: makeId('task'), sessionId: id, prompt, status: 'queued', createdAt: now(), updatedAt: now() };
    const queue = this.queues.get(id) ?? [];
    const queuedAhead = queue.length + (this.activeTurns.has(id) ? 1 : 0);
    if (mode === 'interrupt') queue.unshift(task); else queue.push(task);
    this.queues.set(id, queue);
    if (agentPrompt !== prompt) this.queuedAgentPrompts.set(task.id, agentPrompt);
    if (riskPolicy) this.queuedRiskPolicies.set(task.id, riskPolicy);
    await this.saveTask(task, 'queued');
    if (mode === 'interrupt' && this.activeTurns.has(id)) await this.terminateCurrentTurn(id);
    this.scheduleQueue(id);
    return { ...task, queuedAhead };
  }

  private scheduleQueue(id: string) {
    if (this.queueRuns.has(id) || this.activeTurns.has(id)) return;
    const run = this.drainQueue(id); this.queueRuns.set(id, run);
    void run.finally(() => { if (this.queueRuns.get(id) === run) this.queueRuns.delete(id); });
  }

  private async drainQueue(id: string) {
    while (!this.activeTurns.has(id)) {
      const queue = this.queues.get(id);
      const task = queue?.shift();
      if (!task) { this.queues.delete(id); return; }
      if (!queue?.length) this.queues.delete(id);
      const agentPrompt = this.queuedAgentPrompts.get(task.id) ?? task.prompt;
      const riskPolicy = this.queuedRiskPolicies.get(task.id);
      this.queuedAgentPrompts.delete(task.id);
      this.queuedRiskPolicies.delete(task.id);
      try { await this.runTask(id, task, agentPrompt, riskPolicy); }
      catch {
        // A prompt/SDK failure only fails the current task. recoverSessionAfterTask
        // restores a reusable shared session to idle, so later queued work must
        // still get its own attempt instead of being failed without execution.
        const session = await this.repos.sessions.get(id);
        if (session && !session.archivedAt && session.state === 'idle') continue;
        await this.failRemainingQueue(id);
        return;
      }
    }
  }

  // If one queued task cannot run (e.g. the session entered a hard `failed`
  // state), the rest of the in-memory queue can never drain. Persist them as
  // `failed` instead of leaving them dangling in `queued` (which previously
  // produced "Unknown queued task" on cancel and stuck records in storage).
  private async failRemainingQueue(id: string) {
    const remaining = this.queues.get(id) ?? [];
    this.queues.delete(id);
    for (const task of remaining) {
      this.queuedAgentPrompts.delete(task.id);
      this.queuedRiskPolicies.delete(task.id);
      try { await this.saveTask(task, 'failed'); } catch { /* best-effort */ }
    }
  }

  async cancelQueued(id: string, taskId: string) {
    const queue = this.queues.get(id) ?? [];
    const index = queue.findIndex(task => task.id === taskId);
    if (index < 0) throw new RuntimeError('QUEUED_TASK_NOT_FOUND', `Unknown queued task: ${taskId}`, 404);
    const [task] = queue.splice(index, 1);
    if (!queue.length) this.queues.delete(id);
    this.queuedAgentPrompts.delete(taskId);
    this.queuedRiskPolicies.delete(taskId);
    await this.saveTask(task!, 'cancelled');
    return task;
  }

  async steerQueued(id: string, taskId: string) {
    await this.active(id);
    const queue = this.queues.get(id) ?? [];
    const index = queue.findIndex(task => task.id === taskId);
    if (index < 0) throw new RuntimeError('QUEUED_TASK_NOT_FOUND', `Unknown queued task: ${taskId}`, 404);
    const [task] = queue.splice(index, 1);
    queue.unshift(task!);
    this.queues.set(id, queue);
    if (this.activeTurns.has(id)) await this.terminateCurrentTurn(id);
    this.scheduleQueue(id);
    return task!;
  }

  async updateQueued(id: string, taskId: string, prompt: string) {
    const normalized = prompt.trim();
    if (!normalized) throw new RuntimeError('INVALID_PROMPT', 'Prompt must not be empty', 400);
    const queue = this.queues.get(id) ?? [];
    const task = queue.find(item => item.id === taskId);
    if (!task) throw new RuntimeError('QUEUED_TASK_NOT_FOUND', `Unknown queued task: ${taskId}`, 404);
    task.prompt = normalized;
    task.updatedAt = now();
    // 若存在单独的 agentPrompt（如群聊场景），同步更新；否则保持与 prompt 一致。
    if (this.queuedAgentPrompts.has(taskId)) this.queuedAgentPrompts.set(taskId, normalized);
    await this.saveTask(task, 'queued');
    return task;
  }

  private async cancelSessionQueue(id: string) {
    const queue = this.queues.get(id) ?? [];
    this.queues.delete(id);
    await Promise.all(queue.map(task => { this.queuedAgentPrompts.delete(task.id); this.queuedRiskPolicies.delete(task.id); return this.saveTask(task, 'cancelled'); }));
  }

  async interrupt(id: string) { const { session, driver } = await this.active(id); if (!driver) throw new RuntimeError('SESSION_DISCONNECTED', 'Session is disconnected', 409); if (this.activeTurns.has(id)) this.interruptedTurns.add(id); await this.saveState(session, 'interrupting'); await driver.interrupt(); await this.saveState(session, 'interrupted'); }
  async setRiskPolicy(id: string, policy?: ToolRiskPolicy) {
    const { session, driver } = await this.active(id);
    await this.applyRiskPolicy(session, driver, policy);
  }
  async setModel(id: string, model: string) {
    const normalized = model.trim();
    if (!normalized) throw new RuntimeError('INVALID_MODEL', 'Model must not be empty', 400);
    const { session } = await this.active(id);
    const driver = await this.reconnect(session);
    if (!driver.setModel) throw new RuntimeError('MODEL_SWITCH_UNSUPPORTED', `Agent ${session.agentId} does not support runtime model switching`, 422);
    try { await driver.setModel(normalized); }
    catch (error) { throw new RuntimeError('MODEL_SWITCH_FAILED', error instanceof Error ? error.message : String(error), 422); }
    session.model = normalized;
    session.updatedAt = now();
    await this.repos.sessions.save(session);
    await this.emit(id, 'status', { state: session.state, model: normalized });
    return session;
  }
  /**
   * Agent 推来的会话名。**不覆盖用户手改的名字**：`customTitle` 一旦存在就锁定，
   * 这里只把 `agentTitle` 落库，等用户清空自定义名后自然回退到它。
   *
   * 刻意**不发事件**（与 `setModel` 不同）：改配置是用户的一次明确操作，值得在轨迹里
   * 留一行；Agent 推标题是自动发生的元数据变更，往时间线里塞「会话名更新」只是噪声。
   * 列表侧靠 2s 轮询拿到新名字，已经连上 SSE 的页面最多晚 2 秒，不值得为它污染轨迹。
   */
  async setAgentTitle(session: Session, title: string | undefined) {
    const normalized = title ?? '';
    if ((session.agentTitle ?? '') === normalized) return this.titledSession(session);
    // 走 saveTitles 而不是 save：这里的 session 是 driver 注册时绑定的那份，
    // 本轮收尾的整行 save 用的是另一次 active() 读出来的新快照，用 save 会被覆盖回 null。
    await this.repos.sessions.saveTitles(session.id, { agentTitle: normalized || null });
    session.agentTitle = normalized || null;
    return this.titledSession(session);
  }
  /**
   * 用户手动改名。空串/null 表示「恢复自动命名」（清掉 `customTitle`，回落到 Agent 名 / 首条 prompt），
   * 而不是存一个空标题——否则侧栏会出现一行没有名字的会话。
   */
  async setSessionTitle(id: string, title: string | null | undefined) {
    const normalized = (title ?? '').replace(/\s+/g, ' ').trim();
    if (normalized.length > SESSION_TITLE_MAX_CHARS) throw new RuntimeError('INVALID_SESSION_TITLE', `标题不能超过 ${SESSION_TITLE_MAX_CHARS} 个字符`, 400);
    const session = await this.repos.sessions.get(id);
    if (!session) throw new RuntimeError('SESSION_NOT_FOUND', `Unknown session: ${id}`, 404);
    // 同上：整行 save 不写这两列，会话名一律走 saveTitles。
    await this.repos.sessions.saveTitles(id, { customTitle: normalized || null, updatedAt: now() });
    session.customTitle = normalized || null;
    const titled = await this.titledSession(session);
    await this.emit(id, 'status', { state: session.state, title: titled.title ?? null, titleSource: titled.titleSource ?? null });
    return titled;
  }
  async setReasoningEffort(id: string, reasoningEffort: string) {
    const normalized = reasoningEffort.trim();
    if (!normalized) throw new RuntimeError('INVALID_REASONING_EFFORT', 'Reasoning effort must not be empty', 400);
    const { session } = await this.active(id);
    const driver = await this.reconnect(session);
    if (!driver.setReasoningEffort) throw new RuntimeError('REASONING_SWITCH_UNSUPPORTED', `Agent ${session.agentId} does not support runtime reasoning effort switching`, 422);
    try { await driver.setReasoningEffort(normalized); }
    catch (error) { throw new RuntimeError('REASONING_SWITCH_FAILED', error instanceof Error ? error.message : String(error), 422); }
    session.reasoningEffort = normalized;
    session.updatedAt = now();
    await this.repos.sessions.save(session);
    await this.emit(id, 'status', { state: session.state, reasoningEffort: normalized });
    return session;
  }
  private waitForTurn(id: string) {
    if (!this.activeTurns.has(id)) return Promise.resolve();
    return new Promise<void>(resolve => { const waiters = this.turnWaiters.get(id) ?? new Set(); waiters.add(resolve); this.turnWaiters.set(id, waiters); });
  }
  private async terminateCurrentTurn(id: string) {
    const { session, driver } = await this.active(id);
    if (!driver) return;
    this.interruptedTurns.add(id); this.hardInterrupts.add(id);
    await this.saveState(session, 'interrupting');
    await driver.stop({ discardSession: true });
    await this.waitForTurn(id);
    if (this.drivers.get(id) === driver) this.drivers.delete(id);
    await this.saveState(session, 'interrupted');
    this.hardInterrupts.delete(id);
  }
  async pause(id: string) { const { session } = await this.active(id); const agent = await this.repos.agents.get(session.agentId); if (!agent?.capabilities.pause) throw new RuntimeError('UNSUPPORTED_CAPABILITY', `Agent ${agent?.name ?? session.agentId} does not support pause/resume`, 422); await this.interrupt(id); }
  async resume(id: string) { const { session } = await this.active(id); const agent = await this.repos.agents.get(session.agentId); if (!agent?.capabilities.resume) throw new RuntimeError('UNSUPPORTED_CAPABILITY', `Agent ${agent?.name ?? session.agentId} does not support resume`, 422); let driver = this.drivers.get(id); if (!driver) { const configured = this.configureAgentForSession(agent, session); driver = this.factory(configured, session.protocol!, this.onDriverEvent(session), code => { if (code) void this.saveState(session, 'failed', `Agent exited with code ${code}`); }, session.id, this.resumeOptions(session)); this.drivers.set(id, driver); } await driver.resume(); await this.saveState(session, 'idle'); }
  async stop(id: string) {
    const { session, driver } = await this.active(id);
    this.hardInterrupts.add(id);
    if (this.activeTurns.has(id)) this.interruptedTurns.add(id);
    await driver?.stop();
    await this.waitForTurn(id);
    await this.cancelSessionQueue(id);
    this.releaseSessionMemory(id);
    await this.saveState(session, 'stopped');
  }
  async archive(id: string) {
    const session = await this.repos.sessions.get(id);
    if (!session) throw new RuntimeError('SESSION_NOT_FOUND', `Unknown session: ${id}`, 404);
    if (session.archivedAt) return session;
    await this.stop(id);
    const stopped = (await this.repos.sessions.get(id)) ?? session;
    stopped.archivedAt = now();
    stopped.updatedAt = stopped.archivedAt;
    await this.repos.sessions.save(stopped);
    return stopped;
  }
  async restart(id: string) { const { session } = await this.active(id); await this.stop(id); const agent = await this.repos.agents.get(session.agentId); if (!agent) throw new RuntimeError('AGENT_NOT_FOUND', 'Agent config was removed', 404); session.runId = makeId('run'); session.error = undefined; const configured = this.configureAgentForSession(agent, session); const driver = this.factory(configured, session.protocol!, this.onDriverEvent(session), code => { if (code) void this.saveState(session, 'failed', `Agent exited with code ${code}`); }, session.id, this.resumeOptions(session)); this.drivers.set(id, driver); await this.saveState(session, 'starting'); await driver.start(); await this.saveState(session, 'idle'); return session; }
  async setPermissionMode(id: string, mode: PermissionMode) { const { session, driver } = await this.active(id); session.permissionMode = mode; session.updatedAt = now(); driver?.setPermissionMode?.(mode); await this.repos.sessions.save(session); return session; }
  async resolvePermission(sessionId: string, permissionId: string, approved: boolean) { const { session, driver } = await this.active(sessionId); const key = this.permissionKey(sessionId, permissionId); const request = this.permissions.get(key); if (!request) throw new RuntimeError('PERMISSION_NOT_FOUND', `Unknown permission request: ${permissionId}`, 404); const resolved = await driver?.resolvePermission?.(permissionId, approved); if (driver?.resolvePermission && !resolved) throw new RuntimeError('PERMISSION_EXPIRED', `Permission request is no longer active: ${permissionId}`, 409); request.status = approved ? 'approved' : 'rejected'; this.permissions.delete(key); this.touch(sessionId); await this.repos.artifacts.savePermission(sessionId, request); await this.emit(sessionId, 'permission_request', request); await this.saveState(session, 'thinking'); return request; }

  private releaseSessionMemory(sessionId: string) {
    this.drivers.delete(sessionId);
    this.sequences.delete(sessionId);
    this.lastActivity.delete(sessionId);
    this.activeTasks.delete(sessionId);
    this.interruptedTurns.delete(sessionId);
    this.hardInterrupts.delete(sessionId);
    this.driverStopReasons.delete(sessionId);
    this.driverEventChains.delete(sessionId);
    this.driverEventErrors.delete(sessionId);
    this.queues.delete(sessionId);
    this.queuedAgentPrompts.delete(sessionId);
    this.queuedRiskPolicies.delete(sessionId);
    this.queueRuns.delete(sessionId);
    for (const resolve of this.turnWaiters.get(sessionId) ?? []) resolve();
    this.turnWaiters.delete(sessionId);
    for (const key of this.permissions.keys()) if (key.startsWith(`${sessionId}:`)) this.permissions.delete(key);
  }

  private async cleanupIdleDriversOnce(at: number) {
    const timeout = this.options.driverIdleTimeoutMs ?? 6 * 60 * 60_000;
    if (timeout <= 0) return;
    for (const [sessionId, driver] of this.drivers) {
      if (this.activeTurns.has(sessionId) || at - (this.lastActivity.get(sessionId) ?? at) < timeout) continue;
      const session = await this.repos.sessions.get(sessionId);
      if (!session || !['idle', 'completed', 'interrupted'].includes(session.state)) continue;
      // driver.stop() 可能因为 ACP session 记录文件已被 acpx 的 prune 回收而抛
      // "ACP session not found"：会话早已 close，记录文件被删，但 driver 仍留在内存 map 里。
      // 这属于「已经停了」，不是故障；旧代码用 try/finally 不吞异常，它会冒泡到
      // setInterval 回调的 void promise，变成 unhandledRejection 直接打挂整个进程。
      try { await driver.stop(); }
      catch { /* 记录文件已被回收即视为已停止，继续释放内存。 */ }
      finally { this.releaseSessionMemory(sessionId); }
    }
  }

  async cleanupIdleDrivers(at = Date.now()) {
    if (this.cleanupRun) return this.cleanupRun;
    const run = this.cleanupIdleDriversOnce(at); this.cleanupRun = run;
    try { await run; } finally { if (this.cleanupRun === run) this.cleanupRun = undefined; }
  }

  async shutdown() {
    if (this.cleanupTimer) clearInterval(this.cleanupTimer);
    await this.cleanupRun;
    const drivers = [...this.drivers.values()];
    this.drivers.clear();
    await Promise.allSettled(drivers.map(driver => driver.stop()));
    await Promise.allSettled(this.queueRuns.values());
    await Promise.allSettled(this.driverEventChains.values());
    this.sequences.clear(); this.permissions.clear(); this.lastActivity.clear(); this.activeTurns.clear(); this.activeTasks.clear(); this.interruptedTurns.clear(); this.hardInterrupts.clear(); this.driverEventChains.clear(); this.driverEventErrors.clear();
    for (const waiters of this.turnWaiters.values()) for (const resolve of waiters) resolve();
    this.turnWaiters.clear(); this.queues.clear(); this.queuedAgentPrompts.clear(); this.queuedRiskPolicies.clear(); this.queueRuns.clear(); this.emitter.removeAllListeners();
  }
}
