import type { Locale } from '@agent-dock/agent-dock-shared';
import { getCurrentLocale } from './i18n';

/**
 * 任务/会话耗时的唯一口径。
 *
 * 时间字段来自服务端（字符串 ISO），浏览器只负责相减和格式化；这样刷新、重连、
 * 换时区都不会把耗时算丢。旧记录缺 startedAt 时退化为 createdAt，并标「约」。
 */

export type ElapsedPhase = 'queued' | 'running' | 'finished';

export type ElapsedInput = {
  state: string;
  /** 计划卡还没开工：服务端状态是 review，但对用户展示为排队。 */
  plan?: boolean;
  createdAt?: string;
  startedAt?: string;
  runStartedAt?: string;
  completedAt?: string;
  closedAt?: string;
  updatedAt?: string;
  /** 已结束各轮执行时长之和；有它时不再把验收等待算进去。 */
  activeMs?: number;
};

export type Elapsed = {
  phase: ElapsedPhase;
  ms?: number;
  /** 缺少 startedAt，只能用 createdAt 或 updatedAt 兜底。 */
  approximate: boolean;
  /** 是否应每秒刷新（排队和进行中都算）。 */
  live: boolean;
};

const timestamp = (value?: string) => {
  if (!value) return undefined;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
};

const span = (end: number | undefined, start: number | undefined) => {
  if (end === undefined || start === undefined) return undefined;
  // 服务器与浏览器时钟偏差、历史脏数据都可能让 end < start；只归零，不显示负数。
  return Math.max(0, end - start);
};

const isRunningState = (state: string) => state === 'running' || state === 'thinking' || state === 'running_tool' || state === 'waiting_for_permission' || state === 'interrupting' || state === 'starting';
const isQueuedState = (state: string) => state === 'queued' || state === 'created';

export function resolveElapsed(input: ElapsedInput, now = Date.now()): Elapsed {
  const created = timestamp(input.createdAt);
  const queued = isQueuedState(input.state) || (Boolean(input.plan) && input.state !== 'closed');
  if (queued) {
    return {
      phase: 'queued',
      ms: span(now, created),
      approximate: created === undefined,
      live: true
    };
  }

  if (isRunningState(input.state)) {
    const runStart = timestamp(input.runStartedAt);
    const firstStart = timestamp(input.startedAt);
    const fallbackStart = runStart ?? firstStart ?? created;
    const base = Number.isFinite(input.activeMs) ? Math.max(0, input.activeMs!) : 0;
    // 有累计时长却没有本轮起点（异常/旧数据）时只展示已结算部分，避免把上一轮重复算进来。
    const current = runStart !== undefined ? span(now, runStart) : base > 0 ? 0 : span(now, fallbackStart);
    return {
      phase: 'running',
      ms: current === undefined ? undefined : base + current,
      approximate: runStart === undefined,
      live: true
    };
  }

  const completed = timestamp(input.completedAt) ?? timestamp(input.closedAt) ?? timestamp(input.updatedAt);
  const firstStart = timestamp(input.startedAt);
  const fallbackStart = firstStart ?? created;
  const recorded = Number.isFinite(input.activeMs) ? Math.max(0, input.activeMs!) : undefined;
  return {
    phase: 'finished',
    ms: recorded ?? span(completed, fallbackStart),
    approximate: firstStart === undefined,
    live: false
  };
}

/**
 * 与过程行共用的耗时格式：不足一秒给毫秒（工具调用常用），一分钟以上带分秒。
 * 超过一小时补小时/天，跨夜任务也不会显示成「1500 分钟」。
 */
export function formatElapsed(milliseconds?: number) {
  if (milliseconds === undefined || !Number.isFinite(milliseconds)) return;
  if (milliseconds < 1_000) return `${Math.max(1, Math.round(milliseconds))} 毫秒`;
  const totalSeconds = Math.round(milliseconds / 1_000);
  if (totalSeconds < 60) return `${totalSeconds} 秒`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes < 60) return seconds ? `${minutes} 分 ${seconds} 秒` : `${minutes} 分钟`;
  const hours = Math.floor(minutes / 60);
  const restMinutes = minutes % 60;
  if (hours < 24) return restMinutes ? `${hours} 小时 ${restMinutes} 分` : `${hours} 小时`;
  const days = Math.floor(hours / 24);
  const restHours = hours % 24;
  return restHours ? `${days} 天 ${restHours} 小时` : `${days} 天`;
}

/** 任务卡用：刚开始不足一秒时别显示「1 毫秒」。 */
export function formatTaskElapsed(milliseconds?: number) {
  if (milliseconds === undefined || !Number.isFinite(milliseconds)) return;
  return milliseconds < 1_000 ? '不足 1 秒' : formatElapsed(milliseconds);
}

/** 「排队 3 分」「已用时 3 分 12 秒」「用时 8 分」；缺 startedAt 时加「约」。 */
export function elapsedText(elapsed: Elapsed) {
  const value = formatTaskElapsed(elapsed.ms);
  if (!value) return;
  const prefix = elapsed.phase === 'queued' ? '排队' : elapsed.phase === 'running' ? '已用时' : '用时';
  return elapsed.approximate ? `${prefix}约 ${value}` : `${prefix} ${value}`;
}

/** 旧接口保留：结束早于开始时返回 undefined，供时间线隐藏异常值。 */
export function elapsedMilliseconds(startedAt?: string, completedAt?: string, now = Date.now()) {
  if (!startedAt) return;
  const start = Date.parse(startedAt);
  const end = completedAt ? Date.parse(completedAt) : now;
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return;
  return end - start;
}
