import type { Locale } from '@agent-dock/agent-dock-shared';
import type { Session } from './api';
import { bi, getCurrentLocale } from './i18n';
import { isScheduledSession } from './schedule-view';
import { sessionStateLabel, stateTone } from './session-states';

/**
 * 会话行 hover 卡片的数据来源。
 *
 * 全是纯函数，不依赖 React：卡片的排版在 SessionHoverCard.tsx，文案一律从这儿取。
 * 之前这些格式化散在 session-groups.ts 里，那个文件本职是「分组与搜索」，时间/来源/状态
 * 这些展示口径混进去会让它变成杂物间。
 */

const pad2 = (n: number) => String(n).padStart(2, '0');
const EN_MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'] as const;

/**
 * 过去时刻的口语化写法，与 `describeRunTime`（recurrence.ts，未来向）配成一对。
 *
 * 一小时以内给相对时间（这才是人想知道的「多久之前」），再往前给「今天/昨天 + 时刻」，
 * 跨年才带年份。`now` 从外面传进来，不读全局时钟——否则单测会跟着运行日期漂。
 */
export function describeActivityTime(iso: string, now: Date, locale: Locale = getCurrentLocale()): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return iso;
  const minutes = Math.floor((now.getTime() - at.getTime()) / 60_000);
  if (minutes < 1) return bi('刚刚', 'Just now', locale);
  if (minutes < 60) return bi(`${minutes} 分钟前`, `${minutes}m ago`, locale);
  const time = `${pad2(at.getHours())}:${pad2(at.getMinutes())}`;
  const day = (date: Date) => new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
  const diff = Math.round((day(now) - day(at)) / 86_400_000);
  if (locale === 'en-US') {
    if (diff === 0) return `Today ${time}`;
    if (diff === 1) return `Yesterday ${time}`;
    const monthDay = `${EN_MONTHS[at.getMonth()]} ${at.getDate()}`;
    return at.getFullYear() === now.getFullYear() ? `${monthDay}, ${time}` : `${monthDay}, ${at.getFullYear()} ${time}`;
  }
  const date = `${at.getMonth() + 1}月${at.getDate()}日`;
  // 用「日期差」而不是「距今多少小时」判断今天：凌晨 1 点看昨晚 23 点的事，
  // 说「2 小时前」不如说「昨天 23:00」——后者才和日历对得上。
  if (diff === 0) return `今天 ${time}`;
  if (diff === 1) return `昨天 ${time}`;
  return `${at.getFullYear() === now.getFullYear() ? '' : `${at.getFullYear()}年`}${date} ${time}`;
}

/** `YYYY-MM-DD HH:mm`，本地时区。作为不随「多久之前」漂移的绝对刻度。 */
export function absoluteActivityTime(iso: string): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return iso;
  return `${at.getFullYear()}-${pad2(at.getMonth() + 1)}-${pad2(at.getDate())} ${pad2(at.getHours())}:${pad2(at.getMinutes())}`;
}

/**
 * 卡片里「最后一次对话」那一行。
 *
 * 口径必须和 `sessionActivityTime`（也就是侧栏排序键）对齐，否则用户会看着卡片怀疑排序错了：
 * 有 `lastMessageAt` 才叫「最后一次对话」，没有就是没有——这类行本来就是靠 updatedAt 排的，
 * 直说「还没有对话记录」比硬凑一个时间诚实。
 */
export function sessionActivityRow(session: Pick<Session, 'lastMessageAt' | 'updatedAt' | 'createdAt'>, now: Date, locale: Locale = getCurrentLocale()): { label: string; value: string } {
  if (session.lastMessageAt) {
    const abs = absoluteActivityTime(session.lastMessageAt);
    const rel = describeActivityTime(session.lastMessageAt, now, locale);
    return {
      label: bi('最后一次对话', 'Last message', locale),
      value: bi(`${abs}（${rel}）`, `${abs} (${rel})`, locale)
    };
  }
  const fallback = session.updatedAt ?? session.createdAt;
  const abs = absoluteActivityTime(fallback);
  const rel = describeActivityTime(fallback, now, locale);
  return {
    label: bi('还没有对话记录', 'No messages yet', locale),
    value: bi(`最后活动 ${abs}（${rel}）`, `Last activity ${abs} (${rel})`, locale)
  };
}

/**
 * 会话的来源。行上只看得出「有个飞书标签」或「缩进了一格」，缩进那条尤其看不出从哪来。
 *
 * 定时任务会话也是 `side-chat`（服务端就是这么建的），所以要优先判 systemPrompt 种子，
 * 否则定时任务会被说成「派生自某个会话」。
 */
export function sessionSourceLabel(session: Pick<Session, 'source' | 'systemPrompt'>, labels: { botName?: string; parentLabel?: string } = {}, locale: Locale = getCurrentLocale()): string {
  if (session.source === 'lark') return labels.botName ? bi(`飞书 · ${labels.botName}`, `Lark · ${labels.botName}`, locale) : bi('飞书', 'Lark', locale);
  if (session.source === 'import') return bi('导入的外部会话', 'Imported session', locale);
  if (session.source === 'side-chat') {
    if (isScheduledSession(session)) return bi('定时任务', 'Scheduled task', locale);
    // 父会话被归档或不在当前筛选里时拿不到名字，降级成不带出处，而不是显示 undefined。
    return labels.parentLabel ? bi(`侧边会话 · 派生自「${labels.parentLabel}」`, `Side session · from "${labels.parentLabel}"`, locale) : bi('侧边会话', 'Side session', locale);
  }
  return bi('本地', 'Local', locale);
}

/** 名字是谁起的；prompt 是默认来源，不再额外标注。 */
export function sessionTitleSourceLabel(session: Pick<Session, 'titleSource'>, locale: Locale = getCurrentLocale()): string | undefined {
  if (session.titleSource === 'user') return bi('你起的名字', 'Custom title', locale);
  if (session.titleSource === 'agent') return bi('Agent 起的名字', 'Named by Agent', locale);
  return undefined;
}

/** 状态文案与色点。已归档压过 state——归档行是只读的，再说「思考中」会误导。 */
export function sessionStatusLabel(session: Pick<Session, 'state' | 'archivedAt'> & { interruptIntent?: Session['interruptIntent'] }, locale: Locale = getCurrentLocale()): { text: string; tone: string } {
  if (session.archivedAt) return { text: bi('已归档', 'Archived', locale), tone: 'bg-zinc-400' };
  return { text: sessionStateLabel(session.state, session.interruptIntent, locale), tone: stateTone[session.state] ?? 'bg-zinc-400' };
}
