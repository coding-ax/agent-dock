/**
 * 「友好的周期」↔ cron / 固定间隔。表单里只让用户点选，cron 由这里生成；反向解析用于列表里的人话描述。
 * 只覆盖常见形态，其余表达式走「自定义 cron」，合法性仍由服务端 croner 判定。
 */

export type RecurrenceKind = 'daily' | 'weekdays' | 'weekly' | 'hourly' | 'interval' | 'custom';

export type Recurrence = {
  kind: RecurrenceKind;
  /** HH:mm；daily / weekdays / weekly 使用。 */
  time: string;
  /** 0=周日 … 6=周六；weekly 使用，可多选。 */
  weekdays: number[];
  /** 整点后第几分钟；hourly 使用。 */
  minute: number;
  /** 每隔多久；interval 使用，数值 + 单位。服务端按分钟存。 */
  every: number;
  everyUnit: IntervalUnit;
  /** kind=custom 时的原始表达式。 */
  cron: string;
};

export const recurrenceKinds: Array<{ kind: RecurrenceKind; label: string }> = [
  { kind: 'daily', label: '每天' },
  { kind: 'weekdays', label: '工作日' },
  { kind: 'weekly', label: '每周' },
  { kind: 'hourly', label: '每小时' },
  { kind: 'interval', label: '固定间隔' },
  { kind: 'custom', label: '自定义' }
];

export const weekdayLabels = ['日', '一', '二', '三', '四', '五', '六'];
/** 周一在前：中文习惯。 */
export const weekdayOrder = [1, 2, 3, 4, 5, 6, 0];
export type IntervalUnit = 'minute' | 'hour' | 'day';
export const intervalUnits: Array<{ unit: IntervalUnit; label: string; minutes: number }> = [
  { unit: 'minute', label: '分钟', minutes: 1 },
  { unit: 'hour', label: '小时', minutes: 60 },
  { unit: 'day', label: '天', minutes: 1440 }
];
/** 与服务端 MIN/MAX_INTERVAL_MINUTES 一致。 */
export const MAX_INTERVAL_MINUTES = 30 * 24 * 60;

export const defaultRecurrence: Recurrence = { kind: 'daily', time: '09:00', weekdays: [1], minute: 0, every: 30, everyUnit: 'minute', cron: '0 9 * * *' };

export type Trigger = { cron: string; intervalMinutes?: undefined } | { intervalMinutes: number; cron?: undefined };

const pad = (n: number) => String(n).padStart(2, '0');

function parseTime(time: string): { hour: number; minute: number } | undefined {
  const match = /^(\d{1,2}):(\d{2})$/.exec(time.trim());
  if (!match) return undefined;
  const hour = Number(match[1]); const minute = Number(match[2]);
  return hour < 24 && minute < 60 ? { hour, minute } : undefined;
}

/**
 * 生成触发规则；输入不完整时返回 error，不生成半截表达式。
 * 「每隔一段时间」不走 cron：`*\/7` 在整点处会变成 4 分钟，90 分钟写不出来；服务端按固定间隔排。
 */
export function recurrenceToTrigger(value: Recurrence): { trigger?: Trigger; error?: string } {
  if (value.kind === 'interval') {
    const minutes = intervalMinutes(value);
    if (!minutes) return { error: '间隔需要是大于 0 的整数。' };
    if (minutes > MAX_INTERVAL_MINUTES) return { error: '间隔最长 30 天；更长的用自定义 cron 或单次。' };
    return { trigger: { intervalMinutes: minutes } };
  }
  const built = recurrenceToCron(value);
  return built.cron ? { trigger: { cron: built.cron } } : { error: built.error ?? '周期未填完整。' };
}

export function intervalMinutes(value: Pick<Recurrence, 'every' | 'everyUnit'>): number | undefined {
  const factor = intervalUnits.find(item => item.unit === value.everyUnit)?.minutes ?? 1;
  return Number.isInteger(value.every) && value.every > 0 ? value.every * factor : undefined;
}

/** 间隔的人话：能整除就用大单位。 */
export function describeInterval(minutes: number): string {
  if (minutes % 1440 === 0) return `每 ${minutes / 1440} 天`;
  if (minutes % 60 === 0) return `每 ${minutes / 60} 小时`;
  return minutes > 60 ? `每 ${Math.floor(minutes / 60)} 小时 ${minutes % 60} 分钟` : `每 ${minutes} 分钟`;
}

/** 固定间隔的预览：注册时从现在起算。 */
export function nextIntervalRuns(minutes: number, from: Date, count = 3): Date[] {
  return Array.from({ length: count }, (_, index) => new Date(from.getTime() + (index + 1) * minutes * 60_000));
}

/** 生成 cron；输入不完整时返回 error，不生成半截表达式。interval 不在这里处理。 */
export function recurrenceToCron(value: Recurrence): { cron?: string; error?: string } {
  if (value.kind === 'custom') {
    const cron = value.cron.trim().replace(/\s+/g, ' ');
    const parts = cron ? cron.split(' ').length : 0;
    return parts >= 5 && parts <= 7 ? { cron } : { error: '自定义 cron 需要 5 段，例如「0 9 * * 1-5」。' };
  }
  if (value.kind === 'hourly') {
    return Number.isInteger(value.minute) && value.minute >= 0 && value.minute < 60 ? { cron: `${value.minute} * * * *` } : { error: '分钟需要在 0–59 之间。' };
  }
  if (value.kind === 'interval') return { error: '固定间隔不生成 cron。' };
  const time = parseTime(value.time);
  if (!time) return { error: '请选择触发时间。' };
  const head = `${time.minute} ${time.hour}`;
  if (value.kind === 'daily') return { cron: `${head} * * *` };
  if (value.kind === 'weekdays') return { cron: `${head} * * 1-5` };
  const days = [...new Set(value.weekdays)].filter(day => day >= 0 && day <= 6).sort((a, b) => a - b);
  return days.length ? { cron: `${head} * * ${days.join(',')}` } : { error: '至少选一天。' };
}

/** 反向解析成人话；识别不了就原样显示 cron。 */
export function describeCron(cron: string): string {
  const parts = cron.trim().split(/\s+/);
  if (parts.length !== 5) return `cron ${cron}`;
  const [minute, hour, dom, month, dow] = parts as [string, string, string, string, string];
  const fixedMinute = /^\d{1,2}$/.test(minute) ? Number(minute) : undefined;
  const fixedHour = /^\d{1,2}$/.test(hour) ? Number(hour) : undefined;
  if (dom !== '*' || month !== '*') return `cron ${cron}`;
  const interval = /^\*\/(\d+)$/.exec(minute);
  if (interval && hour === '*' && dow === '*') return `每 ${interval[1]} 分钟`;
  if (fixedMinute !== undefined && hour === '*' && dow === '*') return fixedMinute === 0 ? '每小时整点' : `每小时第 ${fixedMinute} 分`;
  if (fixedMinute === undefined || fixedHour === undefined) return `cron ${cron}`;
  const at = `${pad(fixedHour)}:${pad(fixedMinute)}`;
  if (dow === '*') return `每天 ${at}`;
  if (dow === '1-5') return `工作日 ${at}`;
  if (/^[0-7](,[0-7])*$/.test(dow)) {
    const days = [...new Set(dow.split(',').map(day => Number(day) % 7))];
    return `每周${weekdayOrder.filter(day => days.includes(day)).map(day => weekdayLabels[day]).join('、')} ${at}`;
  }
  return `cron ${cron}`;
}

/** 单段 cron 字段 → 允许的取值集合；支持 *、*\/n、a、a-b、a-b/n 与逗号列表。解析不了返回 undefined。 */
function cronField(field: string, min: number, max: number): Set<number> | undefined {
  const values = new Set<number>();
  for (const part of field.split(',')) {
    const match = /^(\*|(\d+)(?:-(\d+))?)(?:\/(\d+))?$/.exec(part);
    if (!match) return undefined;
    const step = match[4] ? Number(match[4]) : 1;
    const start = match[1] === '*' ? min : Number(match[2]);
    const end = match[1] === '*' ? max : match[3] !== undefined ? Number(match[3]) : match[4] ? max : start;
    if (step < 1 || start < min || end > max || start > end) return undefined;
    for (let value = start; value <= end; value += step) values.add(value);
  }
  return values;
}

/**
 * 预览接下来几次触发时间（本机时区），只用来给用户「心里有数」，以服务端 croner 为准。
 * 逐分钟扫描，最多看 `withinDays` 天；扫不到就返回空数组（例如很稀疏的自定义表达式）。
 */
export function nextCronRuns(cron: string, from: Date, count = 3, withinDays = 14): Date[] {
  const parts = cron.trim().split(/\s+/);
  if (parts.length !== 5) return [];
  const minutes = cronField(parts[0]!, 0, 59); const hours = cronField(parts[1]!, 0, 23);
  const doms = cronField(parts[2]!, 1, 31); const months = cronField(parts[3]!, 1, 12);
  const dows = cronField(parts[4]!.replace(/(^|,|-)7(?=$|,|-)/g, '$10'), 0, 6);
  if (!minutes || !hours || !doms || !months || !dows) return [];
  // 标准 cron：日和周都受限时满足其一即可。
  const domRestricted = parts[2] !== '*'; const dowRestricted = parts[4] !== '*';
  const cursor = new Date(from); cursor.setSeconds(0, 0); cursor.setMinutes(cursor.getMinutes() + 1);
  const result: Date[] = [];
  for (let i = 0; i < withinDays * 1440 && result.length < count; i++, cursor.setMinutes(cursor.getMinutes() + 1)) {
    if (!minutes.has(cursor.getMinutes()) || !hours.has(cursor.getHours()) || !months.has(cursor.getMonth() + 1)) continue;
    const domOk = doms.has(cursor.getDate()); const dowOk = dows.has(cursor.getDay());
    if (domRestricted && dowRestricted ? domOk || dowOk : domOk && dowOk) result.push(new Date(cursor));
  }
  return result;
}

/** 触发时间的口语化写法：今天/明天/周几 + 时刻，跨年才带年份。 */
export function describeRunTime(at: Date, now: Date): string {
  const time = `${pad(at.getHours())}:${pad(at.getMinutes())}`;
  const day = (date: Date) => new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
  const diff = Math.round((day(at) - day(now)) / 86_400_000);
  if (diff === 0) return `今天 ${time}`;
  if (diff === 1) return `明天 ${time}`;
  if (diff === 2) return `后天 ${time}`;
  const date = `${at.getMonth() + 1}月${at.getDate()}日`;
  if (diff > 0 && diff < 7) return `周${weekdayLabels[at.getDay()]}（${date}）${time}`;
  return `${at.getFullYear() === now.getFullYear() ? '' : `${at.getFullYear()}年`}${date} ${time}`;
}

/** 单次任务的快捷时间。返回 datetime-local 需要的本地时间字符串。 */
export function toLocalInput(date: Date): string {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function oncePresets(now: Date): Array<{ label: string; value: string }> {
  const at = (days: number, hour: number, minute = 0) => { const date = new Date(now); date.setDate(date.getDate() + days); date.setHours(hour, minute, 0, 0); return date; };
  const inMinutes = (minutes: number) => { const date = new Date(now.getTime() + minutes * 60_000); date.setSeconds(0, 0); return date; };
  const tonight = at(0, 20);
  return [
    { label: '30 分钟后', value: toLocalInput(inMinutes(30)) },
    { label: '1 小时后', value: toLocalInput(inMinutes(60)) },
    ...(tonight.getTime() > now.getTime() + 10 * 60_000 ? [{ label: '今晚 20:00', value: toLocalInput(tonight) }] : []),
    { label: '明早 09:00', value: toLocalInput(at(1, 9)) }
  ];
}
