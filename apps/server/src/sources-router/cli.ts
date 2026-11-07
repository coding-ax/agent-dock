import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createRepositories } from '@agent-dock/agent-dock-storage';
import { isDaemonRunning, readDaemonStatus, resolveDaemonDir } from '../daemon/daemon.js';
import { resolveDatabasePath } from '../session-cli.js';
import { routerPausedStateKey } from './constants.js';
import { callDaemonSync } from './daemon-call.js';
import { SourceRouterStore, sourceRouterDatabasePath } from './store.js';
import { publicSource } from './types.js';

export interface SourceRouterCliOptions { database?: string; json?: boolean }
export interface SourceAddCliOptions extends SourceRouterCliOptions { kind?: string; config?: string; secretRef?: string[]; secretEnv?: string[]; enabled?: boolean }
export interface SourceUpdateCliOptions extends SourceRouterCliOptions { name?: string; config?: string; secretRef?: string[]; secretEnv?: string[] }
export interface SourceTestCliOptions extends SourceRouterCliOptions {}
export interface CaseListCliOptions extends SourceRouterCliOptions { source?: string; status?: string }
export interface CaseCloseCliOptions extends SourceRouterCliOptions { reason?: string }

const stamp = () => new Date().toISOString();
const output = (value: unknown, json?: boolean) => json ? `${JSON.stringify(value, null, 2)}\n` : `${typeof value === 'string' ? value : JSON.stringify(value, null, 2)}\n`;
const parseConfig = (value?: string) => {
  if (!value) return {};
  try { return JSON.parse(value) as Record<string, unknown>; }
  catch { throw new Error('config 必须是合法 JSON'); }
};
const secretMap = (options: { secretEnv?: string[] }) => Object.fromEntries((options.secretEnv ?? []).map(entry => {
  const [key, value] = entry.split('=', 2);
  if (!key || !value) throw new Error('secretEnv 格式应为 NAME=value');
  return [key, value];
}));

function openStore(options: SourceRouterCliOptions): { store: SourceRouterStore; close: () => void } {
  const state = readDaemonStatus(resolveDaemonDir());
  const daemonDatabase = state?.ready && isDaemonRunning(resolveDaemonDir()) ? state.database : undefined;
  const database = resolveDatabasePath(options.database ?? process.env.AGENTDOCK_DATABASE_URL ?? daemonDatabase);
  const repos = createRepositories(database);
  const store = new SourceRouterStore(sourceRouterDatabasePath(database));
  return { store, close: () => { store.close(); repos.close(); } };
}

function source(store: SourceRouterStore, id: string) {
  const found = store.getSource(id);
  if (!found) throw new Error(`消息源不存在：${id}`);
  return found;
}

function sourceId(prefix: string) { return `${prefix}_${crypto.randomUUID()}`; }

function createSourceRecord(options: SourceAddCliOptions, name: string) {
  const now = stamp();
  const secrets = secretMap(options);
  return {
    id: sourceId('src'), name, kind: (options.kind ?? 'webhook') as 'webhook' | 'poll' | 'stream' | 'worker',
    enabled: options.enabled ?? true,
    config: { correlation: { mode: 'object' as const }, actions: ['comment'], ...parseConfig(options.config) },
    secretRefs: options.secretRef ?? [], secrets, status: 'created' as const,
    traceId: sourceId('trace'), createdAt: now, updatedAt: now
  };
}

export function runSourceAdd(name: string, options: SourceAddCliOptions): string {
  const { store, close } = openStore(options);
  try {
    const record = createSourceRecord(options, name);
    if (!record.name.trim()) throw new Error('消息源名称不能为空');
    if (!['webhook', 'poll', 'stream', 'worker'].includes(record.kind)) throw new Error(`未知消息源类型：${record.kind}`);
    store.saveSource(record);
    const result = publicSource(record);
    return options.json ? output(result, true) : `已创建消息源 ${result.id}（${result.name}）\n`;
  } finally { close(); }
}

export function runSourceList(options: SourceRouterCliOptions): string {
  const { store, close } = openStore(options);
  try {
    const sources = store.listSources().map(publicSource);
    if (options.json) return output(sources, true);
    return sources.length
      ? sources.map(item => `${item.id}  ${item.enabled ? '启用' : '禁用'}  ${item.status}  ${item.name}  最近事件=${item.lastEventAt ?? '-'}`).join('\n') + '\n'
      : '暂无消息源。\n';
  } finally { close(); }
}

export function runSourceShow(id: string, options: SourceRouterCliOptions): string {
  const { store, close } = openStore(options);
  try {
    const result = publicSource(source(store, id));
    return output(result, options.json);
  } finally { close(); }
}

export function runSourceUpdate(id: string, options: SourceUpdateCliOptions): string {
  const { store, close } = openStore(options);
  try {
    const current = source(store, id);
    const updated = {
      ...current,
      ...(options.name !== undefined ? { name: options.name.trim() || current.name } : {}),
      ...(options.config !== undefined ? { config: { ...current.config, ...parseConfig(options.config) } } : {}),
      ...(options.secretRef !== undefined ? { secretRefs: options.secretRef } : {}),
      ...(options.secretEnv?.length ? { secrets: { ...current.secrets, ...secretMap(options) } } : {}),
      updatedAt: stamp()
    };
    store.saveSource(updated);
    const result = publicSource(updated);
    return options.json ? output(result, true) : `已更新消息源 ${id}。\n`;
  } finally { close(); }
}

export function runSourceEnable(id: string, enabled: boolean, options: SourceRouterCliOptions): string {
  const { store, close } = openStore(options);
  try {
    const updated = publicSource({ ...source(store, id), enabled, status: enabled ? 'running' : 'stopped', updatedAt: stamp() });
    store.saveSource({ ...source(store, id), enabled, status: enabled ? 'running' : 'stopped', updatedAt: updated.updatedAt });
    return options.json ? output(updated, true) : `消息源 ${id} 已${enabled ? '启用' : '禁用'}。\n`;
  } finally { close(); }
}

export function runSourceLogs(id: string, options: SourceRouterCliOptions & { limit?: string }): string {
  const { store, close } = openStore(options);
  try {
    source(store, id);
    const limit = Number(options.limit ?? 20);
    const events = store.listEvents(id, Number.isInteger(limit) ? limit : 20).map(item => ({
      eventId: item.id, eventType: item.eventType, dedupeKey: item.dedupeKey, status: item.status,
      traceId: item.traceId, receivedAt: item.receivedAt
    }));
    if (options.json) return output(events, true);
    return events.length ? events.map(item => `${item.receivedAt}  ${item.status}  ${item.eventType}  ${item.eventId}`).join('\n') + '\n' : '暂无事件日志。\n';
  } finally { close(); }
}

export function runSourceTest(id: string, fixture: string | undefined, options: SourceTestCliOptions): string {
  const raw = readFixture(fixture);
  const event = parseFixture(raw);
  const result = dryRunViaDaemon(id, event);
  return output({ sourceId: id, ...result, persisted: false, createdCase: false, createdSession: false, sentAction: false }, options.json);
}

export function runCaseList(options: CaseListCliOptions): string {
  const { store, close } = openStore(options);
  try {
    const status = options.status && ['open', 'waiting', 'closed'].includes(options.status) ? options.status as 'open' | 'waiting' | 'closed' : undefined;
    if (options.status && !status) throw new Error(`未知 Case 状态：${options.status}`);
    const cases = store.listCases({ ...(options.source ? { sourceId: options.source } : {}), ...(status ? { status } : {}) });
    if (options.json) return output(cases, true);
    return cases.length ? cases.map(item => `${item.id}  ${item.status}  ${item.title}  ${item.correlationKey}  ${item.updatedAt}`).join('\n') + '\n' : '暂无 Case。\n';
  } finally { close(); }
}

export function runCaseShow(id: string, options: SourceRouterCliOptions): string {
  const { store, close } = openStore(options);
  try {
    const found = store.case(id);
    if (!found) throw new Error(`Case 不存在：${id}`);
    const result = {
      ...found, object: JSON.parse(found.object), events: store.caseEvents(id),
      sessions: store.caseSessions(id), watches: store.watchesForCase(id), actions: store.actionsForCase(id)
    };
    if (options.json) return output(result, true);
    const lines = [`Case ${found.id}  ${found.status}  ${found.title}`, `关联键 ${found.correlationKey}`, ...store.caseEvents(id).map(item => `${item.createdAt}  ${item.kind}  ${item.summary}`)];
    return lines.join('\n') + '\n';
  } finally { close(); }
}

export function runCaseEvents(id: string, options: SourceRouterCliOptions): string {
  const { store, close } = openStore(options);
  try {
    const events = store.caseEvents(id);
    if (options.json) return output(events, true);
    return events.length ? events.map(item => `${item.createdAt}  ${item.kind}  ${item.summary}`).join('\n') + '\n' : '暂无 Case 事件。\n';
  } finally { close(); }
}

export function runCaseClose(id: string, options: CaseCloseCliOptions): string {
  const { store, close } = openStore(options);
  try {
    const found = store.case(id);
    if (!found) throw new Error(`Case 不存在：${id}`);
    if (found.status !== 'closed') {
      const now = stamp();
      store.saveCase({ ...found, status: 'closed', openKey: null, closedAt: now, closeReason: options.reason ?? 'CLI 手动关闭', updatedAt: now });
      store.appendCaseEvent({ caseId: id, kind: 'case.closed', summary: `Case 已关闭：${options.reason ?? 'CLI 手动关闭'}`, data: JSON.stringify({ reason: options.reason ?? 'CLI 手动关闭' }), createdAt: now });
    }
    return options.json ? output(store.case(id), true) : `Case ${id} 已关闭。\n`;
  } finally { close(); }
}

export function runRouterStatus(options: SourceRouterCliOptions): string {
  const { store, close } = openStore(options);
  try {
    const sources = store.listSources().map(publicSource);
    const sessionId = sources.find(item => item.routerSessionId)?.routerSessionId;
    // 持久化的暂停状态优先于环境变量默认值：用户从控制台恢复后，CLI 不能还报「已暂停」。
    const persistedPause = store.state(routerPausedStateKey)?.value;
    const paused = persistedPause === undefined ? process.env.AGENTDOCK_ROUTER_PAUSED === 'true' : persistedPause === 'true';
    const result = { ...(sessionId ? { sessionId } : {}), paused, inbox: store.listInbox(sessionId ?? 'router_uninitialized'), sources, cases: store.listCases(), audits: store.audits(20) };
    if (options.json) return output(result, true);
    return [`Router Session ${sessionId ?? '尚未创建'}`, `待处理 Inbox ${result.inbox.filter(item => item.status === 'pending').length}`, `消息源 ${sources.length}`, `Case ${result.cases.length}`].join('\n') + '\n';
  } finally { close(); }
}

export function runRouterOpen(options: SourceRouterCliOptions): string {
  const result = callDaemonSync<{ sessionId: string; created: boolean }>('/api/router/open', 'POST', {});
  return options.json ? output(result, true) : `Router Session ${result.sessionId} 已${result.created ? '创建' : '复用'}。\n`;
}

export function runRouterDryRun(fixture: string | undefined, options: SourceRouterCliOptions & { source?: string }): string {
  const raw = readFixture(fixture);
  const event = parseFixture(raw);
  const sourceId = String(options.source ?? event.sourceId ?? '');
  if (!sourceId) throw new Error('请用 --source <id> 或 fixture 的 sourceId 指定消息源');
  const result = dryRunViaDaemon(sourceId, event);
  return output({ sourceId, ...result, persisted: false, createdCase: false, createdSession: false, sentAction: false }, options.json);
}

function readFixture(fixture: string | undefined): string {
  return fixture ? readFileSync(resolve(fixture), 'utf8') : readFileSync(0, 'utf8');
}

function parseFixture(raw: string): Record<string, unknown> {
  try { return JSON.parse(raw) as Record<string, unknown>; }
  catch { throw new Error('fixture 不是合法 JSON'); }
}

function dryRunViaDaemon(sourceId: string, event: Record<string, unknown>): Record<string, unknown> {
  return callDaemonSync<Record<string, unknown>>('/api/router/dry-run', 'POST', { sourceId, event });
}
