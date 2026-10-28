import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { ClientSideConnection, ndJsonStream, PROTOCOL_VERSION } from '@agentclientprotocol/sdk';
import type { Client, ListSessionsResponse, SessionInfo } from '@agentclientprotocol/sdk';
import type { AgentConfig } from '@agent-dock/agent-dock-shared';

/** 外部 Agent 自己记录的一条会话（不落 AgentDock 库，仅用于导入面板展示）。 */
export interface ExternalSessionInfo {
  sessionId: string;
  cwd: string;
  title?: string;
  updatedAt?: string;
}

export interface ExternalSessionListResult {
  /** Agent 是否实现了 ACP `session/list`；false 时 sessions 必为空。 */
  supported: boolean;
  sessions: ExternalSessionInfo[];
  nextCursor?: string;
}

export interface ListExternalSessionsOptions {
  /** 上一页返回的 nextCursor。 */
  cursor?: string;
  /** 只列这个工作目录下的会话（绝对路径）。 */
  filterCwd?: string;
  /** 需要排除的会话 id（通常是 AgentDock 自己创建的 ACP 后端会话）。 */
  excludeSessionIds?: Iterable<string>;
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 20_000;

/**
 * 通过 ACP `session/list` 读取某个 Agent 自己记录的会话。
 *
 * 直接用 SDK 拉一条临时 ACP 连接，不复用 AgentDock 运行时：
 * 这里只是只读列举，不应把外部会话注册成 AgentDock 会话，也不该占用持久 session key。
 *
 * 返回 `supported: false` 表示该 Agent 没实现 session/list（老版本适配器），不是错误。
 */
export async function listExternalSessions(agent: AgentConfig, options: ListExternalSessionsOptions = {}): Promise<ExternalSessionListResult> {
  if (agent.protocol !== 'auto' && agent.protocol !== 'acp') return { supported: false, sessions: [] };
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const child = spawn(agent.command, agent.args, {
    cwd: agent.cwd ?? process.cwd(),
    env: { ...process.env, ...agent.env },
    stdio: ['pipe', 'pipe', 'pipe']
  });
  const stderr: string[] = [];
  child.stderr.on('data', chunk => { if (stderr.length < 20) stderr.push(String(chunk)); });
  const stream = ndJsonStream(
    new WritableStream<Uint8Array>({ write: chunk => { child.stdin.write(chunk); } }),
    new ReadableStream<Uint8Array>({
      start(controller) {
        child.stdout.on('data', (chunk: Buffer) => controller.enqueue(new Uint8Array(chunk)));
        child.stdout.on('end', () => { try { controller.close(); } catch { /* already closed */ } });
        child.stdout.on('error', error => controller.error(error));
      },
      cancel() { child.stdout.destroy(); }
    })
  );
  const connection = new ClientSideConnection((): Client => ({
    // 只读列举不会触发权限请求；真发生就给 cancelled，绝不代用户授权。
    requestPermission: () => ({ outcome: { outcome: 'cancelled' as const } }),
    sessionUpdate: () => undefined
  }), stream);
  const timer = new Promise<never>((_resolve, reject) => {
    setTimeout(() => reject(new Error(`读取 ${agent.name} 会话列表超时（${timeoutMs}ms）`)), timeoutMs).unref();
  });
  try {
    return await Promise.race([collect(connection, options), timer]);
  } catch (error) {
    const detail = stderr.join('').trim();
    if (detail && error instanceof Error && !error.message.includes(detail)) error.message = `${error.message}：${detail.slice(0, 400)}`;
    throw error;
  } finally {
    await terminateExternalChild(child);
  }
}

async function collect(connection: ClientSideConnection, options: ListExternalSessionsOptions): Promise<ExternalSessionListResult> {
  const initialized = await connection.initialize({
    protocolVersion: PROTOCOL_VERSION,
    clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
    clientInfo: { name: 'agent-dock', version: '0.1.0' }
  });
  if (!initialized.agentCapabilities?.sessionCapabilities?.list) return { supported: false, sessions: [] };
  const excluded = new Set(options.excludeSessionIds ?? []);
  let cursor = options.cursor;
  // 排除项可能整页命中（导入过/探测过很多次时很常见）。只过滤一页会让列表看起来空了，
  // 所以空页继续向后取，最多补 5 页，避免无限翻。
  for (let attempt = 0; attempt < 5; attempt++) {
    const response: ListSessionsResponse = await connection.listSessions({
      ...(cursor ? { cursor } : {}),
      ...(options.filterCwd ? { cwd: options.filterCwd } : {})
    });
    const sessions = response.sessions.map(toExternalSessionInfo).filter(session => !excluded.has(session.sessionId));
    if (sessions.length || !response.nextCursor) {
      return { supported: true, sessions, ...(response.nextCursor ? { nextCursor: response.nextCursor } : {}) };
    }
    cursor = response.nextCursor;
  }
  return { supported: true, sessions: [] };
}

function toExternalSessionInfo(info: SessionInfo): ExternalSessionInfo {
  return {
    sessionId: info.sessionId,
    cwd: info.cwd,
    ...(info.title ? { title: info.title } : {}),
    ...(info.updatedAt ? { updatedAt: info.updatedAt } : {})
  };
}

/** 导入历史时归一化后的一轮：用户提问 + 该轮事件 + 最终回复。 */
export interface ExternalTranscriptTurn {
  prompt: string;
  finalText?: string;
  events: Array<{ type: 'text' | 'thinking' | 'tool_call' | 'tool_result'; data: Record<string, unknown> }>;
}

export interface LoadExternalSessionResult {
  /** ACP session/load 回调是否真的重放了历史。 */
  replayed: boolean;
  turns: ExternalTranscriptTurn[];
}

/**
 * 读取一个外部 ACP 会话的完整历史。
 *
 * ACP 的 `session/load` 会把历史以 `session/update` 通知的形式重放给客户端，这是拿到
 * 外部会话转录的唯一标准通道；这里用一条临时连接把它收下来并归一化成「轮」。
 * 只读：不复用 AgentDock 运行时、不建会话、不占用持久 session key。
 */
export async function loadExternalSessionTranscript(agent: AgentConfig, sessionId: string, cwd: string, options: { timeoutMs?: number } = {}): Promise<LoadExternalSessionResult> {
  if (agent.protocol !== 'auto' && agent.protocol !== 'acp') return { replayed: false, turns: [] };
  const timeoutMs = options.timeoutMs ?? 60_000;
  const updates: unknown[] = [];
  const child = spawn(agent.command, agent.args, {
    cwd: agent.cwd ?? process.cwd(),
    env: { ...process.env, ...agent.env },
    stdio: ['pipe', 'pipe', 'pipe']
  });
  const stderr: string[] = [];
  child.stderr.on('data', chunk => { if (stderr.length < 20) stderr.push(String(chunk)); });
  const stream = ndJsonStream(
    new WritableStream<Uint8Array>({ write: chunk => { child.stdin.write(chunk); } }),
    new ReadableStream<Uint8Array>({
      start(controller) {
        child.stdout.on('data', (chunk: Buffer) => controller.enqueue(new Uint8Array(chunk)));
        child.stdout.on('end', () => { try { controller.close(); } catch { /* already closed */ } });
        child.stdout.on('error', error => controller.error(error));
      },
      cancel() { child.stdout.destroy(); }
    })
  );
  const connection = new ClientSideConnection((): Client => ({
    requestPermission: () => ({ outcome: { outcome: 'cancelled' as const } }),
    sessionUpdate: notification => { updates.push(notification); }
  }), stream);
  const timer = new Promise<never>((_resolve, reject) => {
    setTimeout(() => reject(new Error(`读取 ${agent.name} 会话历史超时（${timeoutMs}ms）`)), timeoutMs).unref();
  });
  let canClose = false;
  // initialize 也要计入超时：adapter 卡在握手且进程不退出时，不能让导入请求无限挂起。
  const replay = async (): Promise<LoadExternalSessionResult> => {
    const initialize = await connection.initialize({
      protocolVersion: PROTOCOL_VERSION,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
      clientInfo: { name: 'agent-dock', version: '0.1.0' }
    });
    if (!initialize.agentCapabilities?.loadSession) return { replayed: false, turns: [] };
    canClose = Boolean(initialize.agentCapabilities?.sessionCapabilities?.close);
    await connection.loadSession({ sessionId, cwd, mcpServers: [] });
    return { replayed: true, turns: turnsFromUpdates(updates) };
  };
  try {
    return await Promise.race([replay(), timer]);
  } catch (error) {
    const detail = stderr.join('').trim();
    const reason = describeAcpError(error);
    const message = detail && !reason.includes(detail) ? `${reason}：${detail.slice(0, 400)}` : reason;
    throw new Error(message, { cause: error });
  } finally {
    // 读完历史必须显式关闭这个临时连接持有的会话，再等子进程退出：
    // 只 kill 进程时，Codex 之类的 adapter 仍会把 thread 标成 "already has an active writer"，
    // 导致紧接着接管上下文（resume）失败。close 由 Agent 的 session/close 能力提供，没有就跳过。
    if (canClose) await connection.closeSession({ sessionId }).catch(() => undefined);
    await terminateExternalChild(child);
  }
}

/** 把 ACP 重放的 `session/update` 通知折叠成「轮」。只处理能对应到 AgentDock 事件类型的分支，其余忽略。 */
export function turnsFromUpdates(updates: unknown[]): ExternalTranscriptTurn[] {
  const turns: ExternalTranscriptTurn[] = [];
  let current: ExternalTranscriptTurn | undefined;
  const ensureTurn = (prompt: string) => {
    current = { prompt, events: [] };
    turns.push(current);
    return current;
  };
  for (const raw of updates) {
    const update = (raw as { update?: Record<string, any> } | undefined)?.update;
    const kind = update?.sessionUpdate ?? (raw as Record<string, any> | undefined)?.sessionUpdate;
    if (!kind) continue;
    if (kind === 'user_message_chunk' || kind === 'user_message') {
      const text = String(update?.content?.text ?? update?.text ?? '').trim();
      if (!text) continue;
      // Codex 之类会先重放 thought/tool 再给 user 文本：此时先建的空 prompt 轮次要在此处补上，
      // 不能退化成占位标题。连续的用户分片合并成一问；已有正文的用户消息开启新一轮。
      if (current && !current.prompt) current.prompt = text;
      else if (current && !current.events.length) current.prompt = `${current.prompt}${text}`;
      else ensureTurn(text);
      continue;
    }
    if (!current) current = ensureTurn('');
    if (kind === 'agent_message_chunk' || kind === 'agent_message') {
      const text = String(update?.content?.text ?? update?.text ?? '');
      if (!text) continue;
      current.finalText = `${current.finalText ?? ''}${text}`;
      current.events.push({ type: 'text', data: { text } });
    } else if (kind === 'agent_thought_chunk' || kind === 'agent_thought') {
      const text = String(update?.content?.text ?? update?.text ?? '');
      if (text) current.events.push({ type: 'thinking', data: { text } });
    } else if (kind === 'tool_call' || kind === 'tool_call_update' || kind === 'tool_result') {
      const status = String(update?.status ?? (kind === 'tool_result' ? 'completed' : 'running'));
      const id = update?.toolCallId ?? update?.id;
      const data: Record<string, unknown> = {
        id,
        name: update?.title ?? update?.name ?? 'tool',
        input: update?.rawInput ?? update?.input,
        output: update?.rawOutput ?? update?.output,
        status: status === 'completed' || status === 'failed' ? status : 'running'
      };
      current.events.push({ type: data.status === 'running' ? 'tool_call' : 'tool_result', data });
    }
  }
  return turns.filter(turn => turn.prompt.trim() || turn.events.length);
}

/**
 * 把 ACP / JSON-RPC 错误翻译成能给人看的文本。
 *
 * JSON-RPC 的顶层 message 常常只是 "Internal error"，真正的原因在 `error.data.details`
 * （例如 Codex 的 "thread xxx already has an active writer"）。这里沿 cause 链优先取 details，
 * 再退到非泛化的 message（"Internal error" / "Internal Server Error" 视为无信息）。
 */
export function describeAcpError(error: unknown): string {
  for (let current: unknown = error, depth = 0; current && depth < 6; depth++) {
    const record = current as { data?: unknown; message?: unknown; cause?: unknown };
    const data = record.data;
    if (data && typeof data === 'object') {
      const candidate = (data as { details?: unknown; message?: unknown }).details ?? (data as { message?: unknown }).message;
      if (typeof candidate === 'string' && candidate.trim()) return candidate.trim();
    }
    if (current instanceof Error && current.message && !/^internal( server)? error$/i.test(current.message.trim())) return current.message;
    current = record.cause;
  }
  return error instanceof Error && error.message ? error.message : String(error);
}

/** 结束一个临时 ACP 连接：先 SIGTERM，等它真的退出再返回，避免外部会话的 writer 锁没释放就去做下一步。 */
async function terminateExternalChild(child: ChildProcessWithoutNullStreams, graceMs = 5_000): Promise<void> {
  try { child.stdin.end(); } catch { /* stdin already closed */ }
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>(resolve => {
    const done = () => { clearTimeout(timer); resolve(); };
    const timer = setTimeout(() => { if (child.exitCode === null) child.kill('SIGKILL'); }, graceMs);
    child.once('exit', done);
    if (child.exitCode === null) child.kill('SIGTERM');
  });
}
