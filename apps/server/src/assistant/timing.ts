import { now } from '@agent-dock/agent-dock-shared';
import type { AssistantTask } from './types.js';

type RunTiming = Pick<AssistantTask, 'activeMs' | 'completedAt' | 'runStartedAt' | 'startedAt'>;

const timestamp = (value?: string) => {
  if (!value) return undefined;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
};

/** 开始一轮执行。返工/续做会重置本轮起点，但保留第一次开工时间和已累计时长。 */
export function beginTaskRun(task: RunTiming, at: string = now()) {
  task.startedAt ??= at;
  task.runStartedAt = at;
  task.completedAt = undefined;
  task.activeMs ??= 0;
}

/**
 * 结束当前一轮执行。
 *
 * 只结算 runStartedAt 存在的那一轮：验收、等待用户拍板期间再次关闭事项时，
 * completedAt 和 activeMs 保持不变，避免把等待时间算进执行耗时。
 */
export function finishTaskRun(task: RunTiming, at: string = now()) {
  const end = timestamp(at);
  const start = timestamp(task.runStartedAt);
  if (end === undefined || start === undefined) return;
  // 服务器时间回拨或旧记录时间戳异常时不能让耗时变成负数。
  task.activeMs = Math.max(0, task.activeMs ?? 0) + Math.max(0, end - start);
  task.completedAt = at;
  task.runStartedAt = undefined;
}
