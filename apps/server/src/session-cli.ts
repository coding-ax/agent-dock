import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createRepositories } from '@agent-dock/agent-dock-storage';
import type { RepositoryBundle, Session, TaskRecord } from '@agent-dock/agent-dock-shared';
import { isDaemonRunning, readDaemonStatus, resolveDaemonDir } from './daemon/daemon.js';
import { formatSessionList, formatTranscript, sessionHeader, writeTranscript } from './session-cli-format.js';

/**
 * 解析 daemon 使用的数据库路径。
 *
 * CLI 可能从会话 cwd（任意目录）被 agent 调起，不能用 './.agentdock' 相对猜路径：
 * 1. 显式 --database / AGENTDOCK_DATABASE_URL 最优先；
 * 2. 否则按 daemon 的同款解析：存活的本地 daemon → last-daemon-dir 指针 → cwd，
 *    daemon 目录是 <root>/.agentdock/daemon，数据库是同级 <root>/.agentdock/agentdock.db。
 */
export function resolveDatabasePath(explicit?: string, cwd = process.cwd()): string {
  if (explicit) return resolve(cwd, explicit);
  if (process.env.AGENTDOCK_DATABASE_URL) return resolve(cwd, process.env.AGENTDOCK_DATABASE_URL);
  const daemonDir = resolveDaemonDir(cwd);
  return join(daemonDir, '..', 'agentdock.db');
}

export interface SessionCliOptions {
  database?: string;
  json?: boolean;
}

export interface SessionControlOptions {
  from?: string;
  mode?: 'queue' | 'interrupt';
  /** 测试时指定独立 daemon 目录；CLI 不暴露。 */
  daemonDir?: string;
}

/** 只允许主会话与它派生的侧边会话互相操作。 */
export function sessionPeerIds(sessions: Session[], sourceId: string): string[] {
  const source = sessions.find(session => session.id === sourceId);
  if (!source) throw new Error(`会话不存在：${sourceId}。可用 agent-dock session list 查看全部会话。`);
  const peers = new Set<string>();
  if (source.source === 'side-chat' && source.sourceId && source.sourceId !== sourceId
    && sessions.some(session => session.id === source.sourceId)) peers.add(source.sourceId);
  for (const session of sessions) {
    if (session.source === 'side-chat' && session.sourceId === sourceId && session.id !== sourceId) peers.add(session.id);
  }
  return [...peers];
}

export function sourceSessionId(explicit?: string): string {
  const id = explicit?.trim() || process.env.agentdock_session_id?.trim();
  if (!id) throw new Error('无法识别当前会话。请在 AgentDock 会话内运行，或指定 --from <session-id>。');
  return id;
}

export async function runSessionPeers(sessionId?: string, options: SessionCliOptions = {}): Promise<string> {
  const filename = resolveDatabasePath(options.database);
  if (!existsSync(filename)) throw new Error(`未找到 AgentDock 数据库：${filename}。daemon 是否启动过？`);
  const repos = createRepositories(filename);
  try {
    const sourceId = sourceSessionId(sessionId);
    const sessions = await repos.sessions.list();
    const ids = sessionPeerIds(sessions, sourceId);
    const peers = ids.map(id => sessions.find(session => session.id === id)!);
    if (options.json) return JSON.stringify({ sessionId: sourceId, peers }, null, 2) + '\n';
    return peers.length
      ? peers.map(peer => `${peer.id}  [${peer.state}]  ${peer.source === 'side-chat' ? '侧边会话' : '主会话'}  cwd=${peer.cwd}`).join('\n') + '\n'
      : '当前会话没有关联的主副会话。\n';
  } finally {
    repos.close();
  }
}

/** 正在运行的 daemon；没起来或未就绪时抛错。 */
export function requireDaemon(daemonDir?: string) {
  const dir = daemonDir ?? resolveDaemonDir();
  const state = readDaemonStatus(dir);
  if (!state?.ready || !isDaemonRunning(dir) || !state.database) throw new Error('AgentDock daemon 未运行或尚未就绪。请先运行 agent-dock status。');
  return { ...state, database: state.database };
}

/** 用 daemon 状态里的本地地址与访问凭证调用 HTTP API，返回 JSON；非 2xx 时把服务端错误信息抛出来。 */
export async function callDaemon<T = Record<string, unknown>>(state: { webConsoleUrl?: string; address?: string }, path: string, method: 'GET' | 'POST' | 'DELETE', body?: object): Promise<T> {
  const entry = state.webConsoleUrl ?? state.address;
  if (!entry) throw new Error('daemon 未提供本地 API 地址。请运行 agent-dock status 检查状态。');
  const base = new URL(entry);
  if (base.protocol !== 'http:' && base.protocol !== 'https:') throw new Error('daemon API 地址必须使用 HTTP 或 HTTPS。');
  const token = base.searchParams.get('t');
  const url = new URL(path, base.origin);
  const response = await fetch(url, {
    method,
    headers: { ...(token ? { cookie: `agentdock_web=${encodeURIComponent(token)}` } : {}), ...(body ? { 'content-type': 'application/json' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(15_000)
  });
  const result = await response.json() as T & { error?: { message?: string; code?: string } };
  if (!response.ok) throw new Error(result.error?.message ?? `daemon 返回 HTTP ${response.status}`);
  return result;
}

/** 只允许操作当前会话的主副会话；`allowSelf` 时当前会话自己也算。返回来源会话 ID。 */
export async function assertPeerTarget(database: string, targetId: string, from?: string, allowSelf = false): Promise<string> {
  const repos = createRepositories(database);
  const fromId = sourceSessionId(from);
  try {
    const sessions = await repos.sessions.list();
    const allowed = sessionPeerIds(sessions, fromId);
    if (allowSelf) allowed.push(fromId);
    if (!allowed.includes(targetId)) throw new Error(`目标 ${targetId} 不是当前会话的主副会话。可用 agent-dock session peers 查看可操作的会话。`);
    const target = sessions.find(session => session.id === targetId)!;
    if (target.archivedAt) throw new Error(`目标会话 ${targetId} 已归档，不能操作。`);
    return fromId;
  } finally {
    repos.close();
  }
}

async function controlPeer(targetId: string, path: string, method: 'POST' | 'DELETE', options: SessionControlOptions, body?: object): Promise<string> {
  const state = requireDaemon(options.daemonDir);
  const fromId = await assertPeerTarget(state.database, targetId, options.from);
  const result = await callDaemon(state, path, method, body);
  return JSON.stringify({ ok: true, from: fromId, to: targetId, ...result }) + '\n';
}

export async function runSessionSend(targetId: string, message: string, options: SessionControlOptions = {}): Promise<string> {
  const prompt = message.trim();
  if (!prompt) throw new Error('消息不能为空。');
  if (options.mode && options.mode !== 'queue' && options.mode !== 'interrupt') throw new Error('发送模式只能是 queue 或 interrupt。');
  return controlPeer(targetId, `/api/sessions/${encodeURIComponent(targetId)}/send`, 'POST', options, { prompt, mode: options.mode ?? 'queue' });
}

export async function runSessionInterrupt(targetId: string, options: SessionControlOptions = {}): Promise<string> {
  return controlPeer(targetId, `/api/sessions/${encodeURIComponent(targetId)}/interrupt`, 'POST', options);
}

export async function runSessionCancel(targetId: string, taskId: string, options: SessionControlOptions = {}): Promise<string> {
  if (!taskId.trim()) throw new Error('请提供要取消的排队任务 ID。');
  return controlPeer(targetId, `/api/sessions/${encodeURIComponent(targetId)}/queue/${encodeURIComponent(taskId)}`, 'DELETE', options);
}

export async function runSessionList(options: SessionCliOptions = {}): Promise<string> {
  const filename = resolveDatabasePath(options.database);
  if (!existsSync(filename)) throw new Error(`未找到 AgentDock 数据库：${filename}。daemon 是否启动过？`);
  const repos = createRepositories(filename);
  try {
    const sessions = await repos.sessions.list();
    if (options.json) return JSON.stringify(sessions, null, 2) + '\n';
    return formatSessionList(sessions.map(({ id, agentId, state, cwd, updatedAt }) => ({ id, agentId, state, cwd, updatedAt })));
  } finally {
    repos.close();
  }
}

/** 找到库 → 找会话 → 取任务列表；两个 show 路径共用这段前置，close 由这里兜底。 */
async function withSessionView<T>(sessionId: string, options: SessionCliOptions, view: (repos: RepositoryBundle, session: Session, tasks: TaskRecord[]) => T): Promise<T> {
  const filename = resolveDatabasePath(options.database);
  if (!existsSync(filename)) throw new Error(`未找到 AgentDock 数据库：${filename}。daemon 是否启动过？`);
  const repos = createRepositories(filename);
  try {
    const session = await repos.sessions.get(sessionId);
    if (!session) throw new Error(`会话不存在：${sessionId}。可用 agent-dock session list 查看全部会话。`);
    return await view(repos, session, await repos.tasks.listBySession(sessionId));
  } finally {
    repos.close();
  }
}

export async function runSessionShow(sessionId: string, options: SessionCliOptions = {}): Promise<string> {
  return withSessionView(sessionId, options, async (repos, session, tasks) => {
    if (!options.json) return sessionHeader(session, tasks) + '\n' + formatTranscript(repos.events.iterate(sessionId));
    // --json 是一次显式导出：调用方要的就是「完整的一份」，内存代价由它自己承担。
    // 别顺手改成流式——那样就不再是一个合法 JSON 文档了。
    return JSON.stringify({ session, tasks, events: await repos.events.list(sessionId) }, null, 2) + '\n';
  });
}

/**
 * 人类可读转录的流式打印。事件是百万行量级的（实测最重会话 145 万行 / 235 MB），
 * 逐行迭代直接写出去，内存占用与历史长度无关；`--json` 不走这里。
 */
export async function streamSessionShow(sessionId: string, options: SessionCliOptions, write: (chunk: string) => void): Promise<void> {
  await withSessionView(sessionId, options, (repos, session, tasks) => {
    write(sessionHeader(session, tasks) + '\n');
    writeTranscript(repos.events.iterate(sessionId), write);
  });
}
