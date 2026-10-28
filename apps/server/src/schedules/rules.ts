import { Cron } from 'croner';
import { RuntimeError, type ScheduleRecord } from '@agent-dock/agent-dock-shared';

/**
 * 定时任务的时间规则：纯函数，不碰数据库与 runtime，方便单测。
 *
 * 约定：
 * - 周期任务（cron）每次触发后，下一次从「触发时刻之后」算起，而不是从「现在」算起：
 *   daemon 停机一晚上，起来时只补最近一次，然后从现在往后排，不会一口气补发一串。
 * - 单次任务（runAt）触发一次后 nextRunAt 置空，表示已完成。
 */

/** 本机时区；Intl 拿不到时退回 UTC。 */
export function localTimezone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
}

export function assertValidTimezone(timezone: string) {
  try { new Intl.DateTimeFormat('en-US', { timeZone: timezone }); }
  catch { throw new RuntimeError('INVALID_SCHEDULE', `无法识别的时区：${timezone}`, 400); }
}

/** cron 在 timezone 下严格晚于 after 的下一次触发时间；表达式非法时抛 400。 */
export function nextCronRun(cron: string, timezone: string, after: Date): Date | undefined {
  let job: Cron;
  try { job = new Cron(cron, { timezone, paused: true }); }
  catch (error) { throw new RuntimeError('INVALID_SCHEDULE', `cron 表达式无效：${cron}（${error instanceof Error ? error.message : String(error)}）`, 400); }
  try { return job.nextRun(after) ?? undefined; }
  finally { job.stop(); }
}

/**
 * 新建或恢复时的首次触发时间。
 * - cron：严格晚于 now 的下一次。
 * - runAt：原样返回；已经过去的单次任务视为无效输入，避免一注册就立刻触发。
 */
/** 固定间隔的上下限：扫描周期是 15 秒，低于 1 分钟没意义；超过 30 天应该用 cron 或单次。 */
export const MIN_INTERVAL_MINUTES = 1;
export const MAX_INTERVAL_MINUTES = 30 * 24 * 60;

export function assertValidInterval(minutes: number) {
  if (!Number.isInteger(minutes) || minutes < MIN_INTERVAL_MINUTES || minutes > MAX_INTERVAL_MINUTES) {
    throw new RuntimeError('INVALID_SCHEDULE', `间隔需要是 ${MIN_INTERVAL_MINUTES}–${MAX_INTERVAL_MINUTES} 之间的整数分钟：${minutes}`, 400);
  }
}

export type ScheduleTrigger = Pick<ScheduleRecord, 'cron' | 'runAt' | 'timezone'> & { intervalMinutes?: number | null };

/** 是否周期任务（cron 或固定间隔）；单次任务触发后即结束。 */
export function isRecurring(schedule: Pick<ScheduleTrigger, 'cron' | 'intervalMinutes'>) {
  return Boolean(schedule.cron || schedule.intervalMinutes);
}

export function initialNextRun(input: ScheduleTrigger, now: Date): string {
  if ([input.cron, input.runAt, input.intervalMinutes].filter(Boolean).length > 1) throw new RuntimeError('INVALID_SCHEDULE', 'cron、间隔与单次时间只能三选一', 400);
  if (input.intervalMinutes) {
    assertValidInterval(input.intervalMinutes);
    return new Date(now.getTime() + input.intervalMinutes * 60_000).toISOString();
  }
  if (input.cron) {
    const next = nextCronRun(input.cron, input.timezone, now);
    if (!next) throw new RuntimeError('INVALID_SCHEDULE', `cron 表达式不会再触发：${input.cron}`, 400);
    return next.toISOString();
  }
  if (input.runAt) {
    const at = new Date(input.runAt);
    if (Number.isNaN(at.getTime())) throw new RuntimeError('INVALID_SCHEDULE', `无法解析的触发时间：${input.runAt}`, 400);
    if (at.getTime() <= now.getTime()) throw new RuntimeError('INVALID_SCHEDULE', `触发时间已经过去：${at.toISOString()}`, 400);
    return at.toISOString();
  }
  throw new RuntimeError('INVALID_SCHEDULE', '必须指定 cron、间隔或单次时间', 400);
}

/**
 * 一次触发被抢占后的下一次时间。周期任务从 max(本次触发, now) 往后算，
 * 所以停机期间错过的多次触发只会补这一次；单次任务返回 null 表示结束。
 */
export function followingRun(schedule: Pick<ScheduleTrigger, 'cron' | 'timezone' | 'intervalMinutes'>, fireAt: Date, now: Date): string | null {
  const from = fireAt.getTime() > now.getTime() ? fireAt : now;
  // 固定间隔沿着计划时刻往后排，保持相位不漂；停机错过的只补这一次，直接跳到 now 之后的第一个点。
  if (schedule.intervalMinutes) {
    const step = schedule.intervalMinutes * 60_000;
    const behind = Math.max(0, Math.floor((now.getTime() - fireAt.getTime()) / step));
    return new Date(fireAt.getTime() + (behind + 1) * step).toISOString();
  }
  if (!schedule.cron) return null;
  return nextCronRun(schedule.cron, schedule.timezone, from)?.toISOString() ?? null;
}

/** 上一次投递的任务还没结束（排队中/执行中）时本次跳过，避免会话里越积越多。 */
export const unfinishedTaskStatuses = new Set(['queued', 'running']);

/** 会话正忙的状态：此时 append 模式跳过本次。与 web 的 busyStates 一致。 */
export const busySessionStates = new Set(['starting', 'thinking', 'running_tool', 'waiting_for_permission', 'interrupting']);

/** 发给 Agent 的正文带上来源前缀，让它分清这是定时触发，不是用户刚刚发的。 */
export function schedulePrompt(schedule: Pick<ScheduleRecord, 'id' | 'name' | 'prompt'>, ordinal: number): string {
  return `[AgentDock 定时任务 ${schedule.id} · ${schedule.name} · 第 ${ordinal} 次触发]\n${schedule.prompt}`;
}
