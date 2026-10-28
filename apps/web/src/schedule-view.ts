import type { CreateScheduleInput, Schedule, ScheduleDelivery, ScheduleRun } from './api';
import { defaultRecurrence, describeCron, describeInterval, recurrenceToTrigger, type Recurrence } from './recurrence';

/**
 * 定时任务面板的展示与表单规则。纯函数，不依赖 React，组件只管渲染。
 * cron 本身的合法性由服务端（croner）判定，这里只拦明显不对的输入，避免两套解析规则打架。
 */

export const deliveryLabels: Record<ScheduleDelivery, string> = { new_session: '每次新开会话', append: '追加到已有会话' };
export const deliveryHints: Record<ScheduleDelivery, string> = {
  new_session: '每次触发用下面的 Agent 和目录新建一个会话，互不干扰。适合巡检、汇总、提醒。',
  append: '接着在选定的会话里发，上下文连续。会话正忙时本次跳过。'
};

export const runStatusLabels: Record<ScheduleRun['status'], string> = { delivered: '已投递', skipped: '已跳过', failed: '失败' };

const pad = (n: number) => String(n).padStart(2, '0');

export function formatScheduleTime(iso?: string | null): string {
  if (!iso) return '—';
  const time = new Date(iso);
  if (Number.isNaN(time.getTime())) return iso;
  return `${time.getFullYear()}-${pad(time.getMonth() + 1)}-${pad(time.getDate())} ${pad(time.getHours())}:${pad(time.getMinutes())}`;
}

/** 「触发规则」一列：常见周期用人话，其余原样显示 cron。 */
export function describeTrigger(schedule: Pick<Schedule, 'cron' | 'runAt' | 'intervalMinutes'>): string {
  if (schedule.cron) return describeCron(schedule.cron);
  if (schedule.intervalMinutes) return describeInterval(schedule.intervalMinutes);
  return `单次 ${formatScheduleTime(schedule.runAt)}`;
}

/** 距离下次触发还有多久，给列表右侧的小字用。 */
export function describeCountdown(at: Date, now: Date): string {
  const minutes = Math.round((at.getTime() - now.getTime()) / 60_000);
  if (minutes <= 0) return '即将触发';
  if (minutes < 60) return `${minutes} 分钟后`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return minutes % 60 ? `${hours} 小时 ${minutes % 60} 分后` : `${hours} 小时后`;
  return `${Math.round(hours / 24)} 天后`;
}

export type ScheduleSummary = { active: number; inactive: number; dueToday: number; ran24h: number; failed24h: number; next?: Schedule };

/** 顶部概览：启用数、今天还要触发几个、最近 24 小时执行与失败次数、最近一个要触发的任务。 */
export function summarizeSchedules(schedules: Schedule[], runs: ScheduleRun[], now: Date): ScheduleSummary {
  const endOfDay = new Date(now); endOfDay.setHours(23, 59, 59, 999);
  const active = schedules.filter(item => item.enabled);
  const upcoming = active.filter(item => item.nextRunAt).sort((a, b) => a.nextRunAt!.localeCompare(b.nextRunAt!));
  const since = now.getTime() - 86_400_000;
  const recent = runs.filter(run => new Date(run.fireAt).getTime() >= since);
  return {
    active: active.length,
    inactive: schedules.length - active.length,
    dueToday: upcoming.filter(item => new Date(item.nextRunAt!).getTime() <= endOfDay.getTime()).length,
    ran24h: recent.filter(run => run.status === 'delivered').length,
    failed24h: recent.filter(run => run.status === 'failed').length,
    ...(upcoming[0] ? { next: upcoming[0] } : {})
  };
}

/** 状态徽标：启用中看下次时间；停用时区分「单次已执行」和「已暂停」。 */
export function scheduleState(schedule: Pick<Schedule, 'enabled' | 'cron' | 'intervalMinutes' | 'lastRunAt' | 'lastStatus'>): { label: string; tone: 'active' | 'paused' | 'done' | 'failed' } {
  if (schedule.enabled) return { label: '启用中', tone: 'active' };
  if (!isRecurringSchedule(schedule) && schedule.lastRunAt) return { label: '已执行', tone: 'done' };
  if (schedule.lastStatus === 'failed') return { label: '已停用', tone: 'failed' };
  return { label: '已暂停', tone: 'paused' };
}

/** 只有周期任务、或还没执行过的单次任务能恢复；与服务端 resume 的规则一致。 */
export function canResume(schedule: Pick<Schedule, 'enabled' | 'cron' | 'intervalMinutes' | 'lastRunAt'>): boolean {
  return !schedule.enabled && (isRecurringSchedule(schedule) || !schedule.lastRunAt);
}

export function isRecurringSchedule(schedule: Pick<Schedule, 'cron' | 'intervalMinutes'>): boolean {
  return Boolean(schedule.cron || schedule.intervalMinutes);
}

/**
 * 表单状态。投递目标按方式分开：
 * - new_session：直接选 Agent / 目录 / 模型；
 * - append：选一个已有会话。
 * 会话标题栏入口由调用方把本会话的配置预填进来，并传 `parentSessionId` 把新会话挂在它下面。
 */
export type ScheduleFormState = {
  name: string;
  prompt: string;
  kind: 'recurring' | 'once';
  recurrence: Recurrence;
  runAt: string;
  delivery: ScheduleDelivery;
  agentId: string;
  cwd: string;
  model: string;
  appendSessionId: string;
};

export const emptyScheduleForm: ScheduleFormState = { name: '', prompt: '', kind: 'recurring', recurrence: defaultRecurrence, runAt: '', delivery: 'new_session', agentId: '', cwd: '', model: '', appendSessionId: '' };

/**
 * 表单 → 请求体。返回 error 时不发请求。
 * `runAt` 来自 <input type="datetime-local">，没有时区，按浏览器本地时间解释后转成 ISO。
 */
export function scheduleFormToInput(form: ScheduleFormState, options: { parentSessionId?: string; now?: Date } = {}): { input?: CreateScheduleInput; error?: string } {
  const prompt = form.prompt.trim();
  if (!prompt) return { error: '请填写到点要发给 Agent 的内容。' };
  let target: Pick<CreateScheduleInput, 'sessionId' | 'template'>;
  if (form.delivery === 'append') {
    if (!form.appendSessionId) return { error: '请选择要追加到的会话。' };
    target = { sessionId: form.appendSessionId };
  } else {
    if (!form.agentId) return { error: '请选择 Agent。' };
    if (!form.cwd.trim()) return { error: '请选择工作目录。' };
    target = { template: { agentId: form.agentId, cwd: form.cwd.trim(), ...(form.model ? { model: form.model } : {}) }, ...(options.parentSessionId ? { sessionId: options.parentSessionId } : {}) };
  }
  const base = { ...target, prompt, delivery: form.delivery, ...(form.name.trim() ? { name: form.name.trim() } : {}) };
  if (form.kind === 'recurring') {
    const built = recurrenceToTrigger(form.recurrence);
    if (!built.trigger) return { error: built.error };
    return { input: { ...base, ...built.trigger, timezone: Intl.DateTimeFormat().resolvedOptions().timeZone } };
  }
  const at = new Date(form.runAt);
  if (!form.runAt || Number.isNaN(at.getTime())) return { error: '请选择触发时间。' };
  if (at.getTime() <= (options.now ?? new Date()).getTime()) return { error: '触发时间已经过去。' };
  return { input: { ...base, runAt: at.toISOString() } };
}

/**
 * 「追加到已有会话」可选的会话：未归档（服务端会拒绝归档会话），且不是定时任务自己生出来的——
 * 那些会话会被自动归档，绑上去过几天任务就停了。按最近对话时间倒序。
 */
export function bindableSessions<T extends { archivedAt?: string | null; systemPrompt?: string; lastMessageAt?: string | null; updatedAt: string }>(sessions: T[]): T[] {
  return sessions
    .filter(session => !session.archivedAt && !isScheduledSession(session))
    .sort((a, b) => (b.lastMessageAt ?? b.updatedAt).localeCompare(a.lastMessageAt ?? a.updatedAt));
}

/** 最近用过的工作目录（去重），给目录下拉当候选。 */
export function recentWorkspaces(sessions: Array<{ cwd: string; archivedAt?: string | null; lastMessageAt?: string | null; updatedAt: string }>, extra: Array<string | undefined> = []): string[] {
  const ordered = [...sessions].sort((a, b) => (b.lastMessageAt ?? b.updatedAt).localeCompare(a.lastMessageAt ?? a.updatedAt));
  return [...new Set([...extra, ...ordered.map(session => session.cwd)].filter((path): path is string => Boolean(path)))].slice(0, 30);
}

export function parseScheduleTemplate(raw?: string | null): { agentId: string; cwd: string; model?: string } | undefined {
  try {
    const value = JSON.parse(raw ?? '') as { agentId?: unknown; cwd?: unknown; model?: unknown };
    return typeof value.agentId === 'string' && typeof value.cwd === 'string' ? { agentId: value.agentId, cwd: value.cwd, ...(typeof value.model === 'string' ? { model: value.model } : {}) } : undefined;
  } catch { return undefined; }
}

/** 由定时任务新建的会话。依据是它的 systemPrompt 种子（见 server 的 buildScheduleSessionSeed），不加表列。 */
export function isScheduledSession(session: { systemPrompt?: string }): boolean {
  return /^你是定时任务 sch_/.test(session.systemPrompt ?? '');
}
