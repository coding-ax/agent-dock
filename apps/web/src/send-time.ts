const pad = (value: number) => String(value).padStart(2, '0');

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

/** 悬停提示用的完整时间；与 formatSendTime 同一时区口径。 */
export function formatSendTimeTitle(timestamp: string | undefined): string {
  if (!timestamp) return '';
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return '';
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}
