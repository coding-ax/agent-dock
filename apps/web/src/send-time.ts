const pad = (value: number) => String(value).padStart(2, '0');

/** 按本机时区的日历日比较，不能用 24 小时差：跨 DST / 夏令时的「昨天」会算错。 */
function calendarDayOffset(date: Date, reference: Date): number {
  const day = Date.UTC(date.getFullYear(), date.getMonth(), date.getDate());
  const base = Date.UTC(reference.getFullYear(), reference.getMonth(), reference.getDate());
  return Math.round((day - base) / 86_400_000);
}

/**
 * 片段的发送时间。用本机时区（与服务端事件里的本地呈现一致，不写死 UTC）：
 * 今天只给 HH:mm，跨天补日期，跨年再补年份——一眼能判断「是不是今天的」。
 *
 * 只做格式化，不在悬停时重新取时间或算相对时长：值全部来自落库的 ISO 时间戳。
 */
export function formatSendTime(timestamp: string | undefined, reference: Date = new Date()): string {
  if (!timestamp) return '';
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return '';
  const clock = `${pad(date.getHours())}:${pad(date.getMinutes())}`;
  if (date.getFullYear() === reference.getFullYear() && date.getMonth() === reference.getMonth() && date.getDate() === reference.getDate()) return clock;
  if (date.getFullYear() === reference.getFullYear()) return `${date.getMonth() + 1}月${date.getDate()}日 ${clock}`;
  return `${date.getFullYear()}年${date.getMonth() + 1}月${date.getDate()}日 ${clock}`;
}

/**
 * 用户气泡旁的发送时间：始终可见，并给出足够的日期信息。
 *
 * - 今天 / 昨天用相对日，短且一眼能判断；
 * - 更早的同年消息补月日；
 * - 跨年（包括 1 月 1 日看前一年 12 月 31 日）一律写出年份，避免「昨天」掩盖年份。
 *
 * 时间戳来自事件本身，reference 只用于判断「今天/昨天」，不会用渲染时刻代替发送时刻。
 */
export function formatUserMessageTime(timestamp: string | undefined, reference: Date = new Date()): string {
  if (!timestamp) return '';
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return '';
  const clock = `${pad(date.getHours())}:${pad(date.getMinutes())}`;
  const dayOffset = calendarDayOffset(date, reference);
  if (dayOffset === 0) return `今天 ${clock}`;
  if (dayOffset === -1 && date.getFullYear() === reference.getFullYear()) return `昨天 ${clock}`;
  if (date.getFullYear() === reference.getFullYear()) return `${date.getMonth() + 1}月${date.getDate()}日 ${clock}`;
  return `${date.getFullYear()}年${date.getMonth() + 1}月${date.getDate()}日 ${clock}`;
}

/** 悬停提示用的完整时间；与 formatSendTime 同一时区口径。 */
export function formatSendTimeTitle(timestamp: string | undefined): string {
  if (!timestamp) return '';
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return '';
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}
