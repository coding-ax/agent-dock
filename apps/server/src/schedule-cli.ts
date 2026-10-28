import type { ScheduleRecord, ScheduleRunRecord } from '@agent-dock/agent-dock-shared';
import { assertPeerTarget, callDaemon, requireDaemon, sourceSessionId } from './session-cli.js';

export interface ScheduleAddOptions {
  cron?: string;
  every?: string;
  at?: string;
  tz?: string;
  name?: string;
  delivery?: string;
  session?: string;
  from?: string;
  json?: boolean;
  /** 测试时指定独立 daemon 目录；CLI 不暴露。 */
  daemonDir?: string;
}
export interface ScheduleListOptions { all?: boolean; session?: string; json?: boolean; daemonDir?: string }
export interface ScheduleControlOptions { json?: boolean; daemonDir?: string }

const deliveryLabel: Record<string, string> = { new_session: '每次新开会话', append: '追加到会话' };

function localTime(iso?: string | null, timezone?: string) {
  if (!iso) return '—';
  return new Date(iso).toLocaleString('zh-CN', { hour12: false, ...(timezone ? { timeZone: timezone } : {}) });
}

/** 绑了会话显示会话 ID；Web 上直接选 Agent/目录创建的独立任务显示模板。 */
function scheduleWhere(item: ScheduleRecord) {
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

/**
 * 注册定时任务。目标会话默认是当前会话（agentdock_session_id）；指定 --session 时只能是当前会话或它的主副会话，
 * 边界与 session send 一致，避免 Agent 往任意会话塞定时消息。
 */
export async function runScheduleAdd(prompt: string, options: ScheduleAddOptions = {}): Promise<string> {
  const text = prompt.trim();
  if (!text) throw new Error('定时任务内容不能为空。');
  if ([options.cron, options.at, options.every].filter(Boolean).length !== 1) throw new Error('必须且只能指定 --cron、--every、--at 中的一个。');
  if (options.delivery && options.delivery !== 'new_session' && options.delivery !== 'append') throw new Error('--delivery 只能是 new_session 或 append。');
  const state = requireDaemon(options.daemonDir);
  const fromId = sourceSessionId(options.from);
  const sessionId = options.session?.trim() || fromId;
  if (sessionId !== fromId) await assertPeerTarget(state.database, sessionId, fromId, true);
  const created = await callDaemon<ScheduleRecord>(state, '/api/schedules', 'POST', {
    sessionId, prompt: text, createdBySessionId: fromId,
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
  let sessionId = options.session?.trim();
  if (!options.all && !sessionId) {
    try { sessionId = sourceSessionId(); } catch { /* 不在会话内时列出全部 */ }
  }
  const items = await callDaemon<ScheduleRecord[]>(state, `/api/schedules${sessionId ? `?sessionId=${encodeURIComponent(sessionId)}` : ''}`, 'GET');
  if (options.json) return JSON.stringify(items, null, 2) + '\n';
  if (!items.length) return sessionId ? `会话 ${sessionId} 没有定时任务。用 --all 查看全部。\n` : '没有定时任务。\n';
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
