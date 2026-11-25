import { isMainSessionScheduleTarget, SCHEDULE_MAIN_SESSION_ID, type ScheduleRecord, type ScheduleRunRecord } from '@agent-dock/agent-dock-shared';
import { createRepositories } from '@agent-dock/agent-dock-storage';
import { assertPeerTarget, callDaemon, requireDaemon, sourceSessionId } from './session-cli.js';

export interface ScheduleAddOptions {
  cron?: string;
  every?: string;
  at?: string;
  tz?: string;
  name?: string;
  delivery?: string;
  session?: string;
  main?: boolean;
  from?: string;
  json?: boolean;
  /** 测试时指定独立 daemon 目录；CLI 不暴露。 */
  daemonDir?: string;
}
export interface ScheduleUpdateOptions {
  prompt?: string;
  cron?: string;
  every?: string;
  at?: string;
  tz?: string;
  name?: string;
  delivery?: string;
  session?: string;
  main?: boolean;
  from?: string;
  json?: boolean;
  /** 测试时指定独立 daemon 目录；CLI 不暴露。 */
  daemonDir?: string;
}
export interface ScheduleListOptions { all?: boolean; session?: string; main?: boolean; json?: boolean; daemonDir?: string }
export interface ScheduleControlOptions { json?: boolean; daemonDir?: string }

const deliveryLabel: Record<string, string> = { new_session: '每次新开会话', append: '追加到会话' };

function localTime(iso?: string | null, timezone?: string) {
  if (!iso) return '—';
  return new Date(iso).toLocaleString('zh-CN', { hour12: false, ...(timezone ? { timeZone: timezone } : {}) });
}

/** 绑了会话显示会话 ID；跟随主会话显示动态提示；Web 上直接选 Agent/目录创建的独立任务显示模板。 */
function scheduleWhere(item: ScheduleRecord) {
  if (isMainSessionScheduleTarget(item.sessionId)) return '跟随当前主会话（换代自动跟随）';
  if (item.sessionId) return `会话 ${item.sessionId}`;
  try {
    const template = JSON.parse(item.sessionTemplate ?? '') as { agentId?: string; cwd?: string };
    return `独立会话 agent=${template.agentId ?? '?'} cwd=${template.cwd ?? '?'}`;
  } catch { return '独立会话'; }
}

function scheduleLine(item: ScheduleRecord) {
  const when = item.cron ? `cron "${item.cron}"` : item.intervalMinutes ? `每 ${describeEvery(item.intervalMinutes)}` : `单次 ${localTime(item.runAt, item.timezone)}`;
  const state = item.enabled ? `下次 ${localTime(item.nextRunAt, item.timezone)}` : '已停用';
  return `${item.id}  ${item.name}\n  ${when}（${item.timezone}）· ${deliveryLabel[item.delivery] ?? item.delivery} · ${state} · 已触发 ${item.runCount} 次${item.lastStatus ? ` · 上次 ${item.lastStatus}` : ''}\n  ${scheduleWhere(item)}`;
}

function runLine(run: ScheduleRunRecord) {
  return `${localTime(run.fireAt)}  ${run.status}${run.reason ? `（${run.reason}）` : ''}${run.sessionId ? `  session=${run.sessionId}` : ''}${run.taskId ? `  task=${run.taskId}` : ''}`;
}

function resolveMainOption(options: { session?: string; main?: boolean }): { session?: string; followMain: boolean } {
  const raw = options.session?.trim();
  if (options.main && raw && !isMainSessionScheduleTarget(raw)) {
    throw new Error('--main 不能与 --session 同时指定不同的会话。');
  }
  if (options.main || isMainSessionScheduleTarget(raw)) {
    return { session: SCHEDULE_MAIN_SESSION_ID, followMain: true };
  }
  return { ...(raw ? { session: raw } : {}), followMain: false };
}

/** 当会话内 Agent 指定跟随主会话时，校验该会话与当前活跃主会话有主副关联（避免任意无关会话往主会话塞定时消息）。 */
async function assertMainPeerIfApplicable(database: string, fromId: string) {
  const repos = createRepositories(database);
  let mainId: string | undefined;
  try {
    mainId = (await repos.config.get('assistant.main'))?.trim() || undefined;
  } finally {
    repos.close();
  }
  if (mainId && mainId !== fromId) {
    await assertPeerTarget(database, mainId, fromId, true);
  }
}

/**
 * 注册定时任务。目标会话默认是当前会话（agentdock_session_id）；
 * 指定 --main 或 --session main 时动态跟随当前活跃主会话（主会话换代自动跟随）；
 * 指定其他 --session 时只能是当前会话或它的主副会话，边界与 session send 一致。
 */
export async function runScheduleAdd(prompt: string, options: ScheduleAddOptions = {}): Promise<string> {
  const text = prompt.trim();
  if (!text) throw new Error('定时任务内容不能为空。');
  if ([options.cron, options.at, options.every].filter(Boolean).length !== 1) throw new Error('必须且只能指定 --cron、--every、--at 中的一个。');
  if (options.delivery && options.delivery !== 'new_session' && options.delivery !== 'append') throw new Error('--delivery 只能是 new_session 或 append。');
  const { session: explicitSession, followMain } = resolveMainOption(options);
  const state = requireDaemon(options.daemonDir);
  let fromId: string | undefined;
  let sessionId: string;
  if (followMain) {
    try { fromId = sourceSessionId(options.from); } catch { /* 终端直接创建跟随主会话的任务允许不在会话内 */ }
    if (fromId) await assertMainPeerIfApplicable(state.database, fromId);
    sessionId = SCHEDULE_MAIN_SESSION_ID;
  } else {
    fromId = sourceSessionId(options.from);
    sessionId = explicitSession || fromId;
    if (sessionId !== fromId) await assertPeerTarget(state.database, sessionId, fromId, true);
  }
  const created = await callDaemon<ScheduleRecord>(state, '/api/schedules', 'POST', {
    sessionId, prompt: text,
    ...(fromId ? { createdBySessionId: fromId } : {}),
    ...(options.cron ? { cron: options.cron } : {}),
    ...(options.every ? { intervalMinutes: parseEvery(options.every) } : {}),
    ...(options.at ? { runAt: parseAt(options.at) } : {}),
    ...(options.tz ? { timezone: options.tz } : {}),
    ...(options.name ? { name: options.name } : {}),
    ...(options.delivery ? { delivery: options.delivery } : {})
  });
  if (options.json) return JSON.stringify(created, null, 2) + '\n';
  return `已注册定时任务：\n${scheduleLine(created)}\n`;
}

/** 更新已有定时任务（名称、内容、触发时间、投递方式或目标会话，支持 --main / --session main）。 */
export async function runScheduleUpdate(id: string, options: ScheduleUpdateOptions = {}): Promise<string> {
  const timingCount = [options.cron, options.at, options.every].filter(Boolean).length;
  if (timingCount > 1) throw new Error('--cron、--every、--at 最多只能指定一个。');
  if (options.delivery && options.delivery !== 'new_session' && options.delivery !== 'append') throw new Error('--delivery 只能是 new_session 或 append。');
  const { session: explicitSession, followMain } = resolveMainOption(options);
  const state = requireDaemon(options.daemonDir);
  if (followMain) {
    let fromId: string | undefined;
    try { fromId = sourceSessionId(options.from); } catch { /* 终端直接更新允许不在会话内 */ }
    if (fromId) await assertMainPeerIfApplicable(state.database, fromId);
  } else if (explicitSession) {
    let fromId: string | undefined;
    try { fromId = sourceSessionId(options.from); } catch { /* 终端直接更新允许不在会话内 */ }
    if (fromId && explicitSession !== fromId) await assertPeerTarget(state.database, explicitSession, fromId, true);
  }
  const body: Record<string, unknown> = {};
  if (options.prompt !== undefined) {
    const text = options.prompt.trim();
    if (!text) throw new Error('定时任务内容不能为空。');
    body.prompt = text;
  }
  if (options.name !== undefined) body.name = options.name;
  if (options.delivery !== undefined) body.delivery = options.delivery;
  if (explicitSession !== undefined) body.sessionId = explicitSession;
  if (options.tz !== undefined) body.timezone = options.tz;
  if (options.cron !== undefined) { body.cron = options.cron; body.intervalMinutes = null; body.runAt = null; }
  if (options.every !== undefined) { body.intervalMinutes = parseEvery(options.every); body.cron = null; body.runAt = null; }
  if (options.at !== undefined) { body.runAt = parseAt(options.at); body.cron = null; body.intervalMinutes = null; }
  if (!Object.keys(body).length) throw new Error('请至少指定一个要更新的字段（如 --prompt、--name、--cron、--every、--at、--delivery、--session、--main）。');
  const updated = await callDaemon<ScheduleRecord>(state, `/api/schedules/${encodeURIComponent(id)}`, 'PATCH', body);
  if (options.json) return JSON.stringify(updated, null, 2) + '\n';
  return `已更新定时任务：\n${scheduleLine(updated)}\n`;
}

/** --every 接受 90m / 2h / 1d / 1h30m，纯数字按分钟。 */
export function parseEvery(value: string): number {
  const text = value.trim().toLowerCase();
  if (/^\d+$/.test(text)) return Number(text);
  const units: Record<string, number> = { m: 1, min: 1, h: 60, d: 1440 };
  let total = 0; let rest = text;
  for (const match of text.matchAll(/(\d+)\s*(min|m|h|d)/g)) { total += Number(match[1]) * units[match[2]!]!; rest = rest.replace(match[0], ''); }
  if (!total || rest.trim()) throw new Error(`无法解析的间隔：${value}。示例：45m、2h、1h30m、1d`);
  return total;
}

export function describeEvery(minutes: number): string {
  if (minutes % 1440 === 0) return `${minutes / 1440} 天`;
  if (minutes % 60 === 0) return `${minutes / 60} 小时`;
  return minutes > 60 ? `${Math.floor(minutes / 60)} 小时 ${minutes % 60} 分钟` : `${minutes} 分钟`;
}

/** --at 接受 ISO 时间，也接受不带时区的本地时间（如 2026-10-14 18:00），后者按本机时区解释。 */
export function parseAt(value: string): string {
  const date = new Date(value.trim().replace(' ', 'T'));
  if (Number.isNaN(date.getTime())) throw new Error(`无法解析的触发时间：${value}。示例：2026-10-14 18:00 或 2026-10-14T10:00:00Z`);
  return date.toISOString();
}

export async function runScheduleList(options: ScheduleListOptions = {}): Promise<string> {
  const state = requireDaemon(options.daemonDir);
  const { session: explicitSession } = resolveMainOption(options);
  let sessionId = explicitSession;
  if (!options.all && !sessionId) {
    try { sessionId = sourceSessionId(); } catch { /* 不在会话内时列出全部 */ }
  }
  const items = await callDaemon<ScheduleRecord[]>(state, `/api/schedules${sessionId ? `?sessionId=${encodeURIComponent(sessionId)}` : ''}`, 'GET');
  if (options.json) return JSON.stringify(items, null, 2) + '\n';
  if (!items.length) {
    if (isMainSessionScheduleTarget(sessionId)) return '没有跟随当前主会话的定时任务。用 --all 查看全部。\n';
    return sessionId ? `会话 ${sessionId} 没有定时任务。用 --all 查看全部。\n` : '没有定时任务。\n';
  }
  return items.map(scheduleLine).join('\n\n') + '\n';
}

export async function runScheduleShow(id: string, options: ScheduleControlOptions = {}): Promise<string> {
  const state = requireDaemon(options.daemonDir);
  const path = `/api/schedules/${encodeURIComponent(id)}`;
  const [schedule, runs] = await Promise.all([callDaemon<ScheduleRecord>(state, path, 'GET'), callDaemon<ScheduleRunRecord[]>(state, `${path}/runs?limit=20`, 'GET')]);
  if (options.json) return JSON.stringify({ schedule, runs }, null, 2) + '\n';
  return `${scheduleLine(schedule)}\n\n内容：\n${schedule.prompt}\n\n最近执行：\n${runs.length ? runs.map(runLine).join('\n') : '（暂无）'}\n`;
}

async function control(id: string, action: 'pause' | 'resume' | 'run' | 'remove', options: ScheduleControlOptions) {
  const state = requireDaemon(options.daemonDir);
  const path = `/api/schedules/${encodeURIComponent(id)}`;
  const result = action === 'remove' ? await callDaemon(state, path, 'DELETE') : await callDaemon(state, `${path}/${action}`, 'POST');
  if (options.json) return JSON.stringify(result, null, 2) + '\n';
  if (action === 'remove') return `已删除定时任务 ${id}。\n`;
  if (action === 'run') return `已手动触发：${runLine(result as unknown as ScheduleRunRecord)}\n`;
  return `${scheduleLine(result as unknown as ScheduleRecord)}\n`;
}

export const runSchedulePause = (id: string, options: ScheduleControlOptions = {}) => control(id, 'pause', options);
export const runScheduleResume = (id: string, options: ScheduleControlOptions = {}) => control(id, 'resume', options);
export const runScheduleRun = (id: string, options: ScheduleControlOptions = {}) => control(id, 'run', options);
export const runScheduleRemove = (id: string, options: ScheduleControlOptions = {}) => control(id, 'remove', options);
