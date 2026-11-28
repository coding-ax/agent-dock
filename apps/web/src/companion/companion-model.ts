import type { Locale } from '@agent-dock/agent-dock-shared';
import type { AssistantTask } from '../api';
import { bi, getCurrentLocale } from '../i18n';
import {
  deriveKittenMood,
  hasFailedNeedsUserTask,
  type KittenMood,
  type KittenMoodInput,
  type KittenRecentKind,
} from './kitten-moods';

/**
 * 主会话小猫的纯逻辑：心情、状态文案、便签分组、任务变化 → 小猫的反应。
 * 全部是纯函数，组件只负责把结果画出来；单测见 companion-model.test.ts 与 kitten-moods.test.ts。
 */

export {
  DEFAULT_SLEEPY_AFTER_MS,
  FALLBACK_KITTEN_SPRITE,
  KITTEN_MOODS,
  KITTEN_MOOD_META,
  KITTEN_SPRITE_KEYS,
  KITTEN_SPRITE_PNG,
  KITTEN_SPRITE_WEBP,
  LATE_NIGHT_END_HOUR,
  LATE_NIGHT_START_HOUR,
  MIN_MOOD_HOLD_MS,
  RECENT_WINDOW_MS,
  deriveKittenMood,
  hasFailedNeedsUserTask,
  isLateNightHour,
  kittenMoodMeta,
  kittenSpriteKey,
  kittenSpritePng,
  kittenSpriteWebp,
  sleepyThresholdMs,
  stabilizeKittenMood,
  type KittenMood,
  type KittenMoodInput,
  type KittenMoodMeta,
  type KittenMoodTier,
  type KittenMoodTone,
  type KittenRecentKind,
  type KittenSpriteKey,
  type MoodStabilizeResult,
  type MoodStabilizerState,
} from './kitten-moods';
export type NoteFilter = 'all' | 'needs_user' | 'review' | 'running' | 'closed';
/** planned 不是独立筛选项：计划卡在服务端是 review，但用户要点头才开工，和「需要你」放同一栏。 */
export type NoteSectionKey = Exclude<NoteFilter, 'all'> | 'planned';
/** 便签的纸色。plan = 还没开工的计划卡，铅笔草稿感；其余与事项状态一一对应。 */
export type NoteTone = 'running' | 'review' | 'needs' | 'plan' | 'done' | 'cancelled' | 'interrupted';

export const KITTEN_NAMES = ['小A同学', '年糕', '芝麻', '布丁', '栗子', '可乐', '小满', '豆包', '麻薯', '橘子', '汤圆', '奶盖'];
export const KITTEN_NAMES_EN = ['Mochi', 'Sesame', 'Pudding', 'Chestnut', 'Cola', 'Pixel', 'Biscuit', 'Miso', 'Tangerine', 'Dumpling', 'Latte', 'Clover'];

function liveLabels<K extends string>(table: Record<K, { zh: string; en: string }>): Record<K, string> {
  const out = {} as Record<K, string>;
  for (const key of Object.keys(table) as K[]) {
    Object.defineProperty(out, key, {
      enumerable: true,
      get: () => bi(table[key].zh, table[key].en),
    });
  }
  return out;
}

const BUSY_MAIN_STATES = new Set(['starting', 'thinking', 'running_tool', 'interrupting']);

export function noteTone(task: Pick<AssistantTask, 'state' | 'plan' | 'outcome'>): NoteTone {
  if (task.state === 'closed') return task.outcome === 'cancelled' ? 'cancelled' : 'done';
  if (task.plan) return 'plan';
  if (task.state === 'needs_user') return 'needs';
  if (task.state === 'review') return 'review';
  return 'running';
}

const NOTE_TONE_LABELS: Record<NoteTone, { zh: string; en: string }> = {
  running: { zh: '进行中', en: 'Running' },
  review: { zh: '待验收', en: 'In Review' },
  needs: { zh: '需要你', en: 'Needs You' },
  plan: { zh: '计划待开工', en: 'Planned' },
  done: { zh: '已验收', en: 'Accepted' },
  cancelled: { zh: '已取消', en: 'Cancelled' },
  interrupted: { zh: '已打断', en: 'Interrupted' },
};

export function getNoteToneLabel(tone: NoteTone, locale: Locale = getCurrentLocale()): string {
  const entry = NOTE_TONE_LABELS[tone];
  return bi(entry.zh, entry.en, locale);
}

export const noteToneLabel: Record<NoteTone, string> = liveLabels(NOTE_TONE_LABELS);

export function noteSectionOf(task: Pick<AssistantTask, 'state' | 'plan'>): NoteSectionKey {
  if (task.state === 'closed') return 'closed';
  // 计划卡在服务端是 review（等用户确认后才 start），但对用户来说只是「等你点头」，
  // 不能混进待验收，否则侧栏/抽屉会把还没开工的计划说成做完待验。
  if (task.plan) return 'planned';
  if (task.state === 'needs_user') return 'needs_user';
  if (task.state === 'review') return 'review';
  return 'running';
}

const NOTE_SECTION_LABELS: Record<NoteSectionKey, { zh: string; en: string }> = {
  needs_user: { zh: '需要你', en: 'Needs You' },
  planned: { zh: '等你点头', en: 'Awaiting Approval' },
  review: { zh: '待验收', en: 'In Review' },
  running: { zh: '进行中', en: 'Running' },
  closed: { zh: '已完成', en: 'Done' },
};

export function getNoteSectionLabel(key: NoteSectionKey, locale: Locale = getCurrentLocale()): string {
  const entry = NOTE_SECTION_LABELS[key];
  return bi(entry.zh, entry.en, locale);
}

export const noteSectionLabel: Record<NoteSectionKey, string> = liveLabels(NOTE_SECTION_LABELS);

/** 「需要你」「等你点头」最该先看，其次是等验收的，再是还在跑的；收尾的沉底。 */
export const NOTE_SECTION_ORDER: NoteSectionKey[] = ['needs_user', 'planned', 'review', 'running', 'closed'];

export type NoteCounts = { running: number; review: number; planned: number; needsUser: number; closed: number; open: number; attention: number };

export function countNotes(tasks: AssistantTask[]): NoteCounts {
  const counts: NoteCounts = { running: 0, review: 0, planned: 0, needsUser: 0, closed: 0, open: 0, attention: 0 };
  for (const task of tasks) {
    const section = noteSectionOf(task);
    if (section === 'closed') { counts.closed += 1; continue; }
    counts.open += 1;
    if (section === 'running') counts.running += 1;
    else if (section === 'review') counts.review += 1;
    else if (section === 'planned') counts.planned += 1;
    else counts.needsUser += 1;
  }
  // 计划只需用户点个头，不报红、不参与「警觉」心情。
  counts.attention = counts.review + counts.needsUser;
  return counts;
}

export type NoteSection = { key: NoteSectionKey; label: string; tasks: AssistantTask[] };

const sortTime = (task: AssistantTask) => (task.state === 'closed' ? task.closedAt ?? task.updatedAt : task.updatedAt);

/**
 * 按状态分区；分区内最近动过的在前。
 * 「需要你」筛选也带上计划卡（同一栏、不报警），所以它对应两个分区；其余筛选只返回一个分区。
 */
export function groupNotes(tasks: AssistantTask[], filter: NoteFilter = 'all', locale: Locale = getCurrentLocale()): NoteSection[] {
  const buckets = new Map<NoteSectionKey, AssistantTask[]>();
  for (const task of tasks) {
    const key = noteSectionOf(task);
    buckets.set(key, [...(buckets.get(key) ?? []), task]);
  }
  const keys: NoteSectionKey[] = filter === 'all'
    ? NOTE_SECTION_ORDER
    : filter === 'needs_user' ? ['needs_user', 'planned'] : [filter];
  const dropEmpty = filter === 'all' || filter === 'needs_user';
  return keys
    .map(key => ({ key, label: getNoteSectionLabel(key, locale), tasks: [...(buckets.get(key) ?? [])].sort((left, right) => sortTime(right).localeCompare(sortTime(left))) }))
    .filter(section => !dropEmpty || section.tasks.length > 0);
}

/* ---------- 任务变化 → 小猫的反应 ---------- */

export type CompanionEventKind = 'dispatched' | 'planned' | 'started' | 'review' | 'needs_user' | 'accepted' | 'cancelled' | 'rework';
export type CompanionEvent = { kind: CompanionEventKind; task: AssistantTask };
export type TaskSnapshot = Pick<AssistantTask, 'state' | 'plan' | 'outcome' | 'round'>;

export function snapshotTasks(tasks: AssistantTask[]): Map<string, TaskSnapshot> {
  return new Map(tasks.map(task => [task.id, { state: task.state, plan: task.plan, outcome: task.outcome, round: task.round }]));
}

/**
 * 对比两次轮询之间的事项，得到小猫该做出的反应。第一次拿到数据（previous 为空）
 * 只建立基线、不产生事件：刷新页面不该把所有历史便签重新「派」一遍。
 */
export function diffTasks(previous: Map<string, TaskSnapshot> | undefined, next: AssistantTask[]): CompanionEvent[] {
  if (!previous) return [];
  const events: CompanionEvent[] = [];
  // 按创建时间从旧到新播报，连着派出几张时气泡顺序和派活顺序一致。
  const ordered = [...next].sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  for (const task of ordered) {
    const before = previous.get(task.id);
    if (!before) {
      if (task.state !== 'closed') events.push({ kind: task.plan ? 'planned' : 'dispatched', task });
      continue;
    }
    if (before.state === task.state && before.plan === task.plan) {
      // 同为 running 但返工轮次加了：主会话打回去又开始干了。
      if (task.state === 'running' && task.round > before.round) events.push({ kind: 'rework', task });
      continue;
    }
    if (task.state === 'closed') { events.push({ kind: task.outcome === 'cancelled' ? 'cancelled' : 'accepted', task }); continue; }
    if (task.state === 'needs_user') { events.push({ kind: 'needs_user', task }); continue; }
    if (before.plan && !task.plan && task.state === 'running') { events.push({ kind: 'started', task }); continue; }
    if (task.state === 'review' && before.state === 'running') { events.push({ kind: 'review', task }); continue; }
    if (task.state === 'running' && (before.state === 'review' || before.state === 'needs_user')) events.push({ kind: 'rework', task });
  }
  return events;
}

export type BubbleTone = 'info' | 'success' | 'alert' | 'muted';

export function companionBubble(event: CompanionEvent, locale: Locale = getCurrentLocale()): { text: string; tone: BubbleTone } {
  const title = event.task.title;
  switch (event.kind) {
    case 'dispatched': return { text: bi(`派出一张便签：${title}`, `Dispatched note: ${title}`, locale), tone: 'info' };
    case 'planned': return { text: bi(`写了张计划便签「${title}」，你点头就开工`, `Planned "${title}" — approve to start`, locale), tone: 'info' };
    case 'started': return { text: bi(`便签「${title}」开工啦`, `Started note "${title}"`, locale), tone: 'info' };
    case 'review': return { text: bi(`「${title}」做完了，我去验收`, `"${title}" finished — reviewing now`, locale), tone: 'info' };
    case 'needs_user': return { text: bi(`「${title}」需要你拍板`, `"${title}" needs your decision`, locale), tone: 'alert' };
    case 'accepted': return { text: bi(`验收通过：${title}`, `Accepted: ${title}`, locale), tone: 'success' };
    case 'cancelled': return { text: bi(`撕掉了便签：${title}`, `Cancelled note: ${title}`, locale), tone: 'muted' };
    case 'rework': return { text: bi(`「${title}」打回去返工了`, `Sent "${title}" back for rework`, locale), tone: 'info' };
  }
}

/* ---------- 心情与状态 ---------- */

/** 小猫最近一次值得表态的事：便签上的变化、生命周期里程碑，或者 cheer（刚被认领、刚换了名字，单纯开心）。 */
export type RecentKind = KittenRecentKind;
export type MoodInput = KittenMoodInput;

export function deriveMood(input: MoodInput): KittenMood {
  return deriveKittenMood(input);
}

export function companionStatus(input: {
  mainState?: string;
  mainError?: string | null;
  archived?: boolean;
  counts: NoteCounts;
  pendingDrafts?: number;
  maintenanceRunning?: boolean;
  hasFailedNeedsUser?: boolean;
  mood: KittenMood;
  recent?: RecentKind;
}, locale: Locale = getCurrentLocale()): string {
  const { mainState, mainError, archived, counts, pendingDrafts = 0, maintenanceRunning = false, hasFailedNeedsUser = false, mood, recent } = input;
  if (!mainState) return bi('等你来认领', 'Ready to adopt', locale);
  // 旧版本允许直接归档主会话：这里必须先说清楚主会话已冻结，否则只显示「打盹中」会误导。
  if (archived) return bi('被归档了，需要恢复', 'Archived — restore', locale);
  if (mainState === 'starting') return bi('醒来中…', 'Waking up…', locale);
  if (mainState === 'waiting_for_permission') return bi('在等你授权', 'Needs approval', locale);
  if (mainState === 'failed' || (mainState === 'idle' && Boolean(mainError))) return bi('出了点状况', 'Hit an issue', locale);
  if (counts.needsUser > 0) {
    return hasFailedNeedsUser
      ? bi(`${counts.needsUser} 件事出错待排查`, `${counts.needsUser} failed to check`, locale)
      : bi(`${counts.needsUser} 件事等你拍板`, `${counts.needsUser} need${counts.needsUser > 1 ? '' : 's'} you`, locale);
  }
  if (counts.planned > 0) return bi(`${counts.planned} 张计划等你点头`, `${counts.planned} plan${counts.planned > 1 ? '' : 's'} to OK`, locale);
  if (pendingDrafts > 0) return bi(`${pendingDrafts} 份草稿等你确认`, `${pendingDrafts} draft${pendingDrafts > 1 ? '' : 's'} to send`, locale);
  if (mainState === 'thinking') return bi('正在思考…', 'Thinking…', locale);
  if (mainState === 'running_tool') return bi('正在忙活…', 'Working…', locale);
  if (mainState === 'interrupting') return bi('停下手头的事…', 'Stopping…', locale);
  if (maintenanceRunning || mood === 'tidying') return bi('在收拾便签和记忆', 'Tidying notes', locale);
  if (mood === 'celebrating') {
    if (recent === 'maintenance_finished') return bi('便签和记忆收拾好啦', 'Notes tidied!', locale);
    if (recent === 'handoff_done') return bi('交接完成啦', 'Handoff complete!', locale);
    return bi('验收通过啦', 'Accepted!', locale);
  }
  if (mood === 'happy') return recent === 'cheer' ? bi('开心地摇尾巴', 'Purring happily', locale) : bi('验收通过啦', 'Accepted!', locale);
  if (counts.review > 0) return bi(`${counts.review} 张便签待验收`, `${counts.review} in review`, locale);
  if (counts.running >= 2) return bi(`并行盯着 ${counts.running} 张便签`, `Tracking ${counts.running} notes`, locale);
  if (counts.running > 0) return bi(`在盯着 ${counts.running} 张便签`, `Tracking ${counts.running} note`, locale);
  if (mood === 'delegating') return bi('刚派出新便签', 'Dispatched note', locale);
  if (mood === 'error') return bi('出了点状况', 'Hit an issue', locale);
  if (mood === 'night') return bi('深夜陪你待命', 'Late-night standby', locale);
  if (mood === 'sleepy') return bi('打盹中', 'Napping', locale);
  return bi('随时待命', 'Standing by', locale);
}

export { hasFailedNeedsUserTask as isFailedNeedsUserList };

export const isMainBusy = (state?: string) => Boolean(state && BUSY_MAIN_STATES.has(state));

/** 本机时间的问候语（用户在新加坡，浏览器时区即 UTC+8）。 */
export function greeting(date: Date = new Date(), locale: Locale = getCurrentLocale()): string {
  const hour = date.getHours();
  if (hour < 5) return bi('夜深了', 'Late night', locale);
  if (hour < 11) return bi('早上好', 'Good morning', locale);
  if (hour < 13) return bi('中午好', 'Good day', locale);
  if (hour < 18) return bi('下午好', 'Good afternoon', locale);
  return bi('晚上好', 'Good evening', locale);
}

/* ---------- 便签的手作感：稳定的随机倾斜 ---------- */

function hashString(value: string): number {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index++) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

/** 便签的倾斜角，-1.6°～1.6°。按 id 算，同一张便签每次渲染都歪得一样。 */
export function noteTilt(id: string): number {
  return Math.round(((hashString(id) % 1000) / 1000 * 3.2 - 1.6) * 100) / 100;
}

/** 胶带的倾斜角，-5°～5°。 */
export function tapeTilt(id: string): number {
  return Math.round(((hashString(`${id}:tape`) % 1000) / 1000 * 10 - 5) * 100) / 100;
}

export function pickKittenName(current?: string, random: () => number = Math.random, locale: Locale = getCurrentLocale()): string {
  const list = locale === 'en-US' ? KITTEN_NAMES_EN : KITTEN_NAMES;
  const pool = list.filter(name => name !== current);
  return pool[Math.floor(random() * pool.length) % pool.length] ?? list[0]!;
}

/** 「12 分钟前」这类相对时间；不到一分钟说「刚刚」。 */
export function sinceLabel(iso: string | undefined, now: number = Date.now(), locale: Locale = getCurrentLocale()): string {
  if (!iso) return '';
  const time = Date.parse(iso);
  if (!Number.isFinite(time)) return '';
  const minutes = Math.max(0, Math.floor((now - time) / 60_000));
  if (minutes < 1) return bi('刚刚', 'just now', locale);
  if (minutes < 60) return bi(`${minutes} 分钟前`, `${minutes}m ago`, locale);
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return bi(`${hours} 小时前`, `${hours}h ago`, locale);
  const days = Math.floor(hours / 24);
  return bi(`${days} 天前`, `${days}d ago`, locale);
}

/* ---------- 督办注入 → 便签小卡 ---------- */

export type SupervisionItem = { kind: string; title: string; detail: string; taskId?: string };

/**
 * 解析 daemon 注入主会话的督办全文（见 AssistantService.flushSignals）：
 * 每条形如 `- [review] 标题：说明（atask_xxx）`。标题里也可能有全角冒号，
 * 所以优先用事项 id 回查真实标题，这里只做尽力而为的切分。
 */
export function parseSupervisionDetail(detail: string): SupervisionItem[] {
  const items: SupervisionItem[] = [];
  for (const raw of detail.split('\n')) {
    const match = raw.trim().match(/^- \[([\w-]+)\]\s*(.+)$/);
    if (!match) continue;
    let body = match[2]!.trim();
    let taskId: string | undefined;
    const idMatch = body.match(/（(atask_[^）]+)）$/);
    if (idMatch) {
      taskId = idMatch[1];
      body = body.slice(0, idMatch.index).trim();
    }
    const colon = body.indexOf('：');
    const title = colon > 0 ? body.slice(0, colon).trim() : body;
    const rest = colon > 0 ? body.slice(colon + 1).trim() : '';
    items.push({ kind: match[1]!, title, detail: rest, ...(taskId ? { taskId } : {}) });
  }
  return items;
}

const SUPERVISION_KIND_LABELS: Record<string, { zh: string; en: string }> = {
  review: { zh: '待验收', en: 'In Review' },
  needs_you: { zh: '需要你', en: 'Needs You' },
  failed: { zh: '出错了', en: 'Failed' },
  interrupted: { zh: '已打断', en: 'Interrupted' },
  user_stopped: { zh: '用户停止', en: 'Stopped by User' },
};

export function getSupervisionKindLabel(kind: string, locale: Locale = getCurrentLocale()): string {
  const entry = SUPERVISION_KIND_LABELS[kind];
  return entry ? bi(entry.zh, entry.en, locale) : kind;
}

export const supervisionKindLabel: Record<string, string> = liveLabels(SUPERVISION_KIND_LABELS);

export const supervisionKindTone: Record<string, NoteTone> = {
  review: 'review', needs_you: 'needs', failed: 'needs', interrupted: 'interrupted', user_stopped: 'cancelled'
};

/**
 * 督办小卡的纸色。事项本身处于 needs_user（被打断后确实需要主会话处理）时，
 * 不能因此把 interrupted 信号画成 failed 的红色；主动打断始终用中性琥珀色。
 */
export function supervisionChipTone(kind: string, taskTone?: NoteTone): NoteTone {
  if (kind === 'interrupted') return 'interrupted';
  if (kind === 'user_stopped') return 'cancelled';
  return taskTone ?? supervisionKindTone[kind] ?? 'plan';
}

/** 全是用户停止信号时是普通通知，不是验收督办。 */
export function supervisionNoticeMode(kinds: string[]): 'supervision' | 'notice' {
  return kinds.length > 0 && kinds.every(kind => kind === 'user_stopped') ? 'notice' : 'supervision';
}
