import { dirname, join } from 'node:path';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createAcpRuntime, createAgentRegistry, createRuntimeStore, type AcpPermissionDecision, type AcpRuntime, type AcpRuntimeEvent, type AcpRuntimeHandle, type AcpRuntimeTurn, type AcpSessionStore } from 'acpx/runtime';
import { isAgentStreamErrorText, type AgentConfig, type EventType, type PermissionMode, type ToolRiskPolicy } from '@agent-dock/agent-dock-shared';
import { testRegexWithTimeout } from './regex-timeout.js';

export * from './external-sessions.js';

/**
 * `type` 除了共享的事件词汇，还有一条 acpx 适配层私有的 `session_title`：
 * 它描述的是会话元数据（Agent 给这个会话起的名字），不是对话内容。
 * runtime 会拦截它、只落库不进时间线，所以它**不会**出现在 events 表或前端轨迹里，
 * 也就不该混进 `EventType`（那个联合是前端要逐个渲染的）。
 */
export interface NormalizedDriverEvent { type: EventType | 'session_title'; data: any; raw?: string }
export interface AcpxBuiltinAgent { id: string; argv: string[] }

function agentLauncherPath(name: string) {
  const moduleDirectory = dirname(fileURLToPath(import.meta.url));
  const adjacent = join(moduleDirectory, 'agents', `${name}-acp.mjs`);
  return existsSync(adjacent) ? adjacent : join(moduleDirectory, '..', 'agents', `${name}-acp.mjs`);
}

const flattenRiskText = (value: unknown, output: string[] = []): string[] => {
  if (typeof value === 'string') output.push(value);
  else if (Array.isArray(value)) for (const item of value) flattenRiskText(item, output);
  else if (value && typeof value === 'object') for (const item of Object.values(value)) flattenRiskText(item, output);
  return output;
};
export function listAcpxBuiltinAgents(): AcpxBuiltinAgent[] {
  const registry = createAgentRegistry();
  return registry.list().map(id => {
    const command = registry.resolve(id);
    if (id === 'claude') return { id, argv: [process.execPath, agentLauncherPath('claude')] };
    const argv = typeof command === 'string' ? [command] : [...command];
    if (id === 'codex') return { id, argv: [process.execPath, agentLauncherPath('codex')] };
    return { id, argv };
  });
}
const statusMap: Record<string, 'pending' | 'running' | 'completed' | 'failed'> = { pending: 'pending', in_progress: 'running', running: 'running', completed: 'completed', failed: 'failed' };

// claude-agent-acp 在上下文压缩时把进度横幅伪装成 agent_message_chunk 文本（"Compacting..." /
// "\n\nCompacting completed." / "\n\nCompacting failed: ..."）。这些不是 Agent 的回复内容，
// 归一化为 status 事件——Web 时间线与飞书卡片均跳过 status，避免把压缩进度渲染成一条消息。
const compactionPhase = (text: unknown): 'start' | 'completed' | 'failed' | undefined => {
  if (typeof text !== 'string') return undefined;
  if (text === 'Compacting...') return 'start';
  if (text === '\n\nCompacting completed.') return 'completed';
  if (text.startsWith('\n\nCompacting failed')) return 'failed';
  return undefined;
};

export function normalizeAcpxEvent(input: unknown): NormalizedDriverEvent | undefined {
  if (typeof input === 'string') { try { return normalizeAcpxEvent(JSON.parse(input)); } catch { return { type: 'raw_terminal', data: { text: input }, raw: input }; } }
  if (!input || typeof input !== 'object') return;
  const event = input as Record<string, any>; const update = event.params?.update ?? event.update ?? event.data?.update ?? event; const kind = update.sessionUpdate ?? event.tag ?? event.type;
  if (kind === 'text_delta') return { type: event.stream === 'thought' ? 'thinking' : 'text', data: { text: event.text ?? '' } };
  if (kind === 'agent_message_chunk') {
    const text = update.content?.text ?? event.text ?? event.message ?? '';
    const phase = compactionPhase(text);
    if (phase) return { type: 'status', data: { state: 'compaction', phase, ...(phase === 'failed' ? { detail: String(text).slice('\n\nCompacting failed'.length).replace(/^[:\s]+/, '').trim() || undefined } : {}) } };
    // cursor-agent 把内部流错误当成正文 chunk 推出来，且 turn 仍报 end_turn。
    // 收成 status：飞书卡片和 Web 时间线都会跳过 status，避免染红或并进最终回复。
    if (typeof text === 'string' && isAgentStreamErrorText(text)) return { type: 'status', data: { state: 'agent_stream_error', detail: text.trim() } };
    return { type: 'text', data: { text } };
  }
  if (kind === 'text') return { type: 'text', data: { text: update.content?.text ?? event.text ?? event.message ?? '' } };
  if (kind === 'agent_thought_chunk' || kind === 'thinking') return { type: 'thinking', data: { text: update.content?.text ?? event.text ?? '' } };
  if (kind === 'tool_call' || kind === 'tool_call_update' || kind === 'tool_result') { const complete = statusMap[update.status] ?? (kind === 'tool_result' ? 'completed' : 'running'); return { type: complete === 'completed' || complete === 'failed' ? 'tool_result' : 'tool_call', data: { id: update.toolCallId ?? event.toolCallId ?? event.id, name: update.title ?? event.title ?? event.name ?? 'tool', input: update.rawInput ?? event.rawInput ?? event.input, output: update.rawOutput ?? event.rawOutput ?? event.output, status: complete } }; }
  if (kind === 'permission_request' || kind === 'permission_escalation') return { type: 'permission_request', data: { id: event.requestId ?? event.id ?? update.toolCallId, toolCallId: update.toolCallId, title: update.title ?? event.toolTitle ?? 'Permission required', options: update.options ?? [], status: 'pending' } };
  if (kind === 'usage_update') return { type: 'status', data: { state: 'usage', used: event.used, size: event.size, breakdown: event.breakdown, cost: event.cost } };
  if (kind === 'available_commands_update') return { type: 'status', data: { state: 'commands', availableCommands: event.availableCommands ?? update.availableCommands ?? [] } };
  if (kind === 'error') return { type: 'error', data: { message: event.message ?? event.error?.message ?? 'Agent error', detail: event } };
  if (kind === 'done' || kind === 'completed' || kind === 'result' || event.result?.stopReason) return { type: 'completed', data: { stopReason: event.stopReason ?? event.result?.stopReason ?? 'end_turn' } };
  if (kind === 'status') return { type: 'status', data: { state: event.text ?? event.state ?? 'running', ...event } };
  return { type: 'raw_terminal', data: { text: JSON.stringify(input) }, raw: JSON.stringify(input) };
}

function shellQuote(value: string) { return `'${value.replaceAll("'", "'\\''")}'`; }
export function renderAgentCommand(agent: AgentConfig) { return [agent.command, ...agent.args].map(shellQuote).join(' '); }
function isCodexAgent(agent: AgentConfig) { return agent.id === 'codex' || agent.args.includes(agentLauncherPath('codex')); }
export function buildAcpxSessionOptions(agent: AgentConfig) {
  return {
    ...(agent.model ? { model: agent.model } : {}),
    ...(agent.systemPrompt ? { systemPrompt: agent.systemPrompt } : {}),
    // Seed the managed Codex launcher before session/new. A gateway model may
    // not appear in Codex's built-in catalog until it is the configured model.
    // Keep this per session instead of rewriting a shared CODEX_HOME/config.toml.
    env: isCodexAgent(agent) && agent.model ? { ...agent.env, agentdock_codex_model: agent.model } : agent.env
  };
}

export interface AcpxAdapterOptions { sessionKey?: string; onEvent(event: NormalizedDriverEvent): void; onExit?(code: number | null, signal: NodeJS.Signals | null): void; /** 接管外部 ACP 会话：首次 ensureSession 时用 session/resume 或 session/load 恢复它。 */ resumeSessionId?: string }
type SessionAgentConfig = AgentConfig & { reasoningEffort?: string };

// 存在未完成工具调用时的空闲超时下限。工具执行期间 Agent 只是在等待结果，
// 不应按普通空闲超时误杀；30 分钟足以覆盖绝大多数长耗时工具。
const TOOL_CALL_IDLE_TIMEOUT_MS = 30 * 60 * 1_000;

/**
 * 计算本轮的两档空闲超时（毫秒）。
 * - idle：无未完成工具调用时的“无活动”超时，等于 agent.timeout。
 * - toolCall：存在未完成工具调用时的超时下限，取 max(idle, 30 分钟)。
 *
 * 取 max 而非乘法：乘法会让 timeout 配小的 agent 反而获得更长的卡死窗口
 * （timeout=600 时 600s*30 = 5 小时），与“配小超时以求更快失败”的意图相反。
 */
export function resolveTurnTimeouts(timeoutSeconds: number) {
  const idle = Math.max(0, timeoutSeconds) * 1_000;
  return { idle, toolCall: Math.max(idle, TOOL_CALL_IDLE_TIMEOUT_MS) };
}

export class AgentIdleTimeoutError extends Error {
  constructor(readonly timeoutMs: number) {
    super(`Agent 连续 ${Math.ceil(timeoutMs / 1_000)} 秒无任何活动，已取消本轮任务`);
    this.name = 'AgentIdleTimeoutError';
  }
}

export class AcpxAdapter {
  private readonly runtime: AcpRuntime;
  private readonly sessionStore: AcpSessionStore;
  private handle?: AcpRuntimeHandle;
  private turn?: AcpRuntimeTurn;
  private readonly pendingPermissions = new Map<string, (decision: AcpPermissionDecision) => void>();
  private readonly sessionKey: string;
  private reportedTitle?: string;
  private riskPolicy?: ToolRiskPolicy;
  private permissionMode: PermissionMode;

  constructor(readonly agent: SessionAgentConfig, private readonly options: AcpxAdapterOptions) {
    const cwd = agent.cwd ?? process.cwd(); this.sessionKey = options.sessionKey ?? `agentdock-${agent.id}`;
    this.permissionMode = agent.permissionMode;
    this.sessionStore = createRuntimeStore({ stateDir: join(cwd, '.agentdock', 'acpx') });
    this.runtime = createAcpRuntime({
      cwd,
      sessionStore: this.sessionStore,
      agentRegistry: createAgentRegistry({ overrides: { [agent.id]: [agent.command, ...agent.args] } }),
      permissionMode: agent.permissionMode === 'full-trust' ? 'approve-all' : agent.permissionMode === 'deny-all' ? 'deny-all' : 'approve-reads',
      nonInteractivePermissions: 'fail', timeoutMs: agent.timeout * 1000,
      onPermissionRequest: async request => {
        const raw = request.raw as any; const id = raw.toolCall?.toolCallId ?? `permission-${Date.now()}`;
        const candidate = flattenRiskText({ title: raw.toolCall?.title, input: raw.toolCall?.rawInput ?? raw.toolCall?.input ?? raw }).join('\n');
        if (this.riskPolicy?.enabled && !this.riskPolicy.authorized) {
          try {
            if (await testRegexWithTimeout(this.riskPolicy.pattern, candidate)) {
              this.options.onEvent({ type: 'permission_request', data: { id, toolCallId: raw.toolCall?.toolCallId, title: `高危操作已被 AgentDock 拦截：${raw.toolCall?.title ?? 'tool'}`, options: [], status: 'rejected' } });
              return { outcome: 'reject_once' };
            }
          } catch (error) {
            this.options.onEvent({ type: 'permission_request', data: { id, toolCallId: raw.toolCall?.toolCallId, title: `安全正则匹配异常，已拒绝操作：${error instanceof Error ? error.message : String(error)}`, options: [], status: 'rejected' } });
            return { outcome: 'reject_once' };
          }
        }
        if (this.permissionMode === 'full-trust') return { outcome: 'allow_once' };
        if (this.permissionMode === 'deny-all') return { outcome: 'reject_once' };
        if (this.permissionMode === 'approve-reads' && /read|search|fetch/i.test(String(request.inferredKind ?? ''))) return { outcome: 'allow_once' };
        this.options.onEvent({ type: 'permission_request', data: { id, toolCallId: raw.toolCall?.toolCallId, title: raw.toolCall?.title ?? 'Permission required', options: raw.options ?? [], status: 'pending' } });
        return new Promise<AcpPermissionDecision>(resolve => this.pendingPermissions.set(id, resolve));
      }
    });
  }

  private sessionInput() { return { sessionKey: this.sessionKey, agent: this.agent.id, mode: 'persistent' as const, cwd: this.agent.cwd, ...(this.options.resumeSessionId ? { resumeSessionId: this.options.resumeSessionId } : {}), sessionOptions: buildAcpxSessionOptions(this.agent) }; }
  private isMissingPersistentSession(error: unknown): boolean {
    for (let current: unknown = error, depth = 0; current && depth < 5; depth++) {
      const message = current instanceof Error ? current.message : String(current);
      if (/could not be resumed|resource not found/i.test(message)) return true;
      current = current instanceof Error ? current.cause : undefined;
    }
    return false;
  }
  private async resetPersistentState() {
    const record = await this.sessionStore.load(this.sessionKey);
    if (!record) return;
    record.acpx = { ...record.acpx, reset_on_next_ensure: true };
    await this.sessionStore.save(record);
  }
  private async resetWhenScopedEnvironmentChanged() {
    const desired = buildAcpxSessionOptions(this.agent).env ?? {};
    const scopedKeys = ['agentdock_group_tools_url', 'agentdock_group_tools_token'] as const;
    if (!scopedKeys.some(key => desired[key])) return;
    const record = await this.sessionStore.load(this.sessionKey);
    if (!record) return;
    const stored = record.acpx?.session_options?.env ?? {};
    if (scopedKeys.every(key => stored[key] === desired[key])) return;
    record.acpx = { ...record.acpx, reset_on_next_ensure: true };
    await this.sessionStore.save(record);
  }
  /**
   * 启动阶段应用配置里的思考深度。与模型同理：一个过期/不被当前模型支持的
   * reasoningEffort 不应让整个 Session 起不来（用户会被锁死在改不了配置的状态），
   * 因此这里降级为提示并继续，用 Agent 默认深度。
   * 注意：运行时通过 setReasoningEffort 显式切换仍会抛错——那是用户的即时操作，需要明确反馈。
   */
  private async applyReasoningEffort() {
    if (!this.handle || !this.agent.reasoningEffort) return;
    const requested = this.agent.reasoningEffort;
    const status = await this.runtime.getStatus?.({ handle: this.handle });
    const options = Array.isArray(status?.details?.configOptions) ? status.details.configOptions as Array<Record<string, any>> : [];
    const reasoning = options.find(option => option.category === 'thought_level' || option.id === 'reasoning_effort' || option.id === 'effort');
    const unsupported = !reasoning || typeof reasoning.id !== 'string'
      ? `Agent ${this.agent.id} 不支持配置思考深度`
      : (Array.isArray(reasoning.options) && !reasoning.options.some((option: any) => option?.value === requested))
        ? `模型 ${this.agent.model ?? '(默认)'} 不支持思考深度 ${requested}`
        : undefined;
    if (unsupported) {
      this.agent.reasoningEffort = undefined;
      this.options.onEvent({
        type: 'status',
        data: { state: 'reasoning_effort_fallback', rejectedReasoningEffort: requested, detail: unsupported, message: `已忽略无法使用的思考深度「${requested}」，本次改用 Agent 默认深度。${unsupported}。` }
      });
      return;
    }
    await this.runtime.setConfigOption?.({ handle: this.handle, key: reasoning!.id, value: requested });
  }
  private isUnadvertisedModelError(error: unknown): boolean {
    for (let current: unknown = error, depth = 0; current && depth < 5; depth++) {
      const reason = (current as { reason?: unknown }).reason;
      if (reason === 'unadvertised-model' || reason === 'missing-capability') return true;
      const message = current instanceof Error ? current.message : String(current);
      if (/did not advertise (that model|model support)/i.test(message)) return true;
      current = current instanceof Error ? current.cause : undefined;
    }
    return false;
  }
  private async applyCodexPermissionMode() {
    if (!this.handle || !isCodexAgent(this.agent)) return;
    // ACP 客户端自动批准与 Codex 自身的审批/沙箱模式是两层配置。
    // 每次发送前重申模式，恢复旧会话或收回 full-trust 后也不能沿用旧授权。
    const mode = this.permissionMode === 'full-trust' ? 'agent-full-access' : 'read-only';
    if (!this.runtime.setMode) throw new Error('当前 ACPX 不支持配置 Codex 权限模式，已停止执行。');
    try { await this.runtime.setMode({ handle: this.handle, mode }); }
    catch (cause) { throw new Error(`无法将 Codex 权限模式设为 ${mode}，已停止执行。`, { cause }); }
  }
  async start() {
    await this.resetWhenScopedEnvironmentChanged();
    try { this.handle = await this.runtime.ensureSession(this.sessionInput()); }
    catch (error) {
      // 配置里存了一个该 Agent 并不支持的模型时，acpx 会直接拒绝建会话，整个 Session
      // 起不来——而模型列表本身也要靠这个 Agent 才能查，用户会被锁死在「改不了配置」里。
      // 一个过期或写错的模型配置不应让机器人彻底不可用：丢掉 model 退回 Agent 默认模型重试，
      // 并通过 warning 事件把原因和修复方式告诉用户。
      if (!this.isUnadvertisedModelError(error) || !this.agent.model || isCodexAgent(this.agent)) throw error;
      const rejected = this.agent.model;
      const detail = error instanceof Error ? error.message : String(error);
      // 用 status 事件而非 error：本轮并未失败（已退回默认模型继续跑），
      // 发 error 会把飞书卡片染红、也会让 Web 时间线显示成运行失败。
      this.options.onEvent({
        type: 'status',
        data: { state: 'model_fallback', rejectedModel: rejected, detail, message: `已忽略无法使用的默认模型「${rejected}」，本次改用 Agent 默认模型。请在配置里改为该 Agent 实际支持的模型 ID。` }
      });
      this.agent.model = undefined;
      this.handle = await this.runtime.ensureSession(this.sessionInput());
    }
    try {
      await this.applyCodexPermissionMode();
      await this.applyReasoningEffort();
    } catch (error) {
      await this.stop().catch(() => undefined);
      throw error;
    }
    // 老会话的标题回填：新建的会话这里记录里还是 null，读了等于没读；
    // 之前跑过、Agent 推过标题的会话，这一次打开就能把名字补上。
    await this.reportAgentTitle();
  }
  /**
   * 上报 Agent 给这个会话起的名字。
   *
   * 为什么要从 acpx 的会话记录里读，而不是等事件：acpx 会把 ACP 的
   * `session_info_update.title` 落进记录（`applySessionInfoUpdate`），但**不把它放进
   * 运行时事件**——`sessionInfoStatusText` 只取 `payload.summary || payload.message`，
   * 事件里只剩一句 "session updated"。所以只能自己读记录。
   *
   * 读的是 `AcpSessionStore`（`createRuntimeStore` 的正经出口），不是扒 JSON 文件；
   * `sessionKey` 在 agent-runtime 里就是 AgentDock 的 sessionId，一一对应。
   *
   * 时机上有个硬约束：acpx 是在**整轮跑完**才 `saveRecord`（save 调用在 `options.run()`
   * 之后），所以只能在轮次结束后读；收到 `session_info_update` 事件的那一刻读会读到旧值。
   * 调用点因此只有 `start()` 之后和 `sendTurn()` 收尾处两处，都不做轮询。
   *
   * 读失败一律当作「Agent 没给名字」：标题是锦上添花，不能因为它把一轮跑挂。
   */
  private async reportAgentTitle() {
    let raw: unknown;
    try { raw = (await this.sessionStore.load(this.sessionKey))?.title; }
    catch { return; }
    const title = typeof raw === 'string' && raw.trim() ? raw : undefined;
    // 不能每轮都推一条：Agent 每轮都可能重发同一个名字，去重后上层才不必反复落库。
    if (title === this.reportedTitle) return;
    this.reportedTitle = title;
    this.options.onEvent({ type: 'session_title', data: { title } });
  }
  private async sendTurn(prompt: string) {
    if (!this.handle) await this.start();
    await this.applyCodexPermissionMode();
    const requestId = `req-${crypto.randomUUID()}`;
    // ACPX 的 timeoutMs 是整轮墙钟超时，流式事件和工具调用都不会续期。
    // 禁用它，在 AgentDock 边界按每个 ACP 事件重置“无活动”计时，避免正常长任务被固定时长误杀。
    // 工具调用执行期间 Agent 处于等待工具结果的状态，不属于“无活动”，因此用更长的一档。
    const { idle: idleTimeoutMs, toolCall: toolCallTimeoutMs } = resolveTurnTimeouts(this.agent.timeout);
    const turn = this.runtime.startTurn({ handle: this.handle!, text: prompt, mode: 'prompt', requestId, timeoutMs: 0 });
    this.turn = turn;
    try {
      const iterator = turn.events[Symbol.asyncIterator]();
      // 按 toolCallId 去重跟踪未完成的工具调用：tool_call_update 会对同一调用重复推送，
      // 用计数器会漂移（多次 +1、一次 -1），导致空闲超时被永久钉在 30 分钟档。
      const activeToolCallIds = new Set<string>();
      while (true) {
        let timer: NodeJS.Timeout | undefined;
        // 有未完成工具调用时使用更长超时；否则使用正常空闲超时。
        const effectiveTimeout = activeToolCallIds.size > 0 ? toolCallTimeoutMs : idleTimeoutMs;
        const idle = new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(new AgentIdleTimeoutError(effectiveTimeout)), effectiveTimeout);
        });
        let next: IteratorResult<AcpRuntimeEvent>;
        try { next = await Promise.race([iterator.next(), idle]); }
        catch (error) {
          if (error instanceof AgentIdleTimeoutError) {
            await turn.cancel({ reason: error.message }).catch(() => undefined);
            // The event iterator won the race, so this caller no longer awaits the
            // result promise. Observe it explicitly to avoid a late rejection.
            void turn.result.catch(() => undefined);
          }
          throw error;
        } finally { if (timer) clearTimeout(timer); }
        if (next.done) break;
        const normalized = normalizeAcpxEvent(next.value);
        if (normalized) {
          // 按 toolCallId 维护未完成工具调用集合，用于决定空闲超时策略。
          const toolCallId = typeof normalized.data?.id === 'string' ? normalized.data.id : undefined;
          if (normalized.type === 'tool_call') { if (toolCallId) activeToolCallIds.add(toolCallId); }
          else if (normalized.type === 'tool_result') { if (toolCallId) activeToolCallIds.delete(toolCallId); else activeToolCallIds.clear(); }
          this.options.onEvent(normalized);
        }
      }
      const result = await turn.result;
      if (result.status === 'failed') throw new Error(result.error.message);
      // 先报标题再报 completed：驱动事件在 runtime 侧是按会话串行消费的，这样能保证
      // 「标题已落库」发生在本轮收尾记账之前，列表页不会看到一轮已完成却还挂着旧名字。
      await this.reportAgentTitle();
      this.options.onEvent({ type: 'completed', data: { stopReason: result.stopReason ?? result.status } });
    } finally {
      if (this.turn === turn) this.turn = undefined;
    }
  }
  async send(prompt: string) {
    try { await this.sendTurn(prompt); }
    catch (error) {
      if (!this.isMissingPersistentSession(error)) throw error;
      await this.resetPersistentState();
      this.handle = await this.runtime.ensureSession(this.sessionInput());
      await this.applyReasoningEffort();
      await this.sendTurn(prompt);
    }
  }
  async interrupt() { if (this.turn) await this.turn.cancel({ reason: 'AgentDock interrupt' }); else if (this.handle) await this.runtime.cancel({ handle: this.handle, reason: 'AgentDock interrupt' }); }
  async resume() { await this.start(); }
  async stop(options: { discardSession?: boolean } = {}) {
    for (const resolve of this.pendingPermissions.values()) resolve({ outcome: 'reject_once' });
    this.pendingPermissions.clear();
    const turn = this.turn;
    if (turn) {
      try { await turn.cancel({ reason: 'AgentDock stop' }); }
      finally { if (this.turn === turn) this.turn = undefined; }
    }
    // handle 必须无条件清空：ACP session 记录文件可能已被 acpx 的 prune 回收，
    // 此时 close 会抛 "ACP session not found"。会话本就已经关闭，重复 stop 应当是幂等的，
    // 若把 handle 留在原地，下一次 stop 会再抛一次同样的错。
    const handle = this.handle;
    this.handle = undefined;
    if (handle) await this.runtime.close({ handle, reason: 'AgentDock stop' });
    if (options.discardSession) await this.resetPersistentState();
  }
  async resolvePermission(id: string, approved: boolean) { const resolve = this.pendingPermissions.get(id); if (!resolve) return false; this.pendingPermissions.delete(id); resolve({ outcome: approved ? 'allow_once' : 'reject_once' }); return true; }
  async setModel(model: string) {
    if (!this.handle) await this.start();
    const status = await this.runtime.getStatus?.({ handle: this.handle! });
    const options = Array.isArray(status?.details?.configOptions) ? status.details.configOptions as Array<Record<string, any>> : [];
    const modelOption = options.find(option => option.id === 'model' || option.category === 'model');
    if (!modelOption || typeof modelOption.id !== 'string') throw new Error(`Agent ${this.agent.id} does not support runtime model switching`);
    // getStatus reads the persisted option snapshot. A long-lived session can
    // have an older model catalog than the fresh ACP connection used by
    // setConfigOption; let the agent validate the requested value there.
    await this.runtime.setConfigOption?.({ handle: this.handle!, key: modelOption.id, value: model });
    this.agent.model = model;
  }
  async setReasoningEffort(reasoningEffort: string) {
    if (!this.handle) await this.start();
    const status = await this.runtime.getStatus?.({ handle: this.handle! });
    const options = Array.isArray(status?.details?.configOptions) ? status.details.configOptions as Array<Record<string, any>> : [];
    const reasoning = options.find(option => option.category === 'thought_level' || option.id === 'reasoning_effort' || option.id === 'effort');
    if (!reasoning || typeof reasoning.id !== 'string') throw new Error(`Agent ${this.agent.id} does not support runtime reasoning effort switching`);
    const allowed = Array.isArray(reasoning.options) ? reasoning.options.some((option: any) => option?.value === reasoningEffort) : true;
    if (!allowed) throw new Error(`Reasoning effort ${reasoningEffort} is not supported by model ${this.agent.model ?? '(default)'}`);
    await this.runtime.setConfigOption?.({ handle: this.handle!, key: reasoning.id, value: reasoningEffort });
    this.agent.reasoningEffort = reasoningEffort;
  }
  setRiskPolicy(policy?: ToolRiskPolicy) { this.riskPolicy = policy; }
  setPermissionMode(mode: PermissionMode) { this.permissionMode = mode; }
  killActive() { void this.interrupt(); }
}
