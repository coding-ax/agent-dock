import type { AssistantTask } from '../api';

/**
 * 主会话小猫的纯逻辑：心情、状态文案、便签分组、任务变化 → 小猫的反应。
 * 全部是纯函数，组件只负责把结果画出来；单测见 companion-model.test.ts。
 */

export type KittenMood = 'idle' | 'curious' | 'sleepy' | 'busy' | 'alert' | 'happy' | 'sad';
export type NoteFilter = 'all' | 'needs_user' | 'review' | 'running' | 'closed';
/** planned 不是独立筛选项：计划卡在服务端是 review，但用户要点头才开工，和「需要你」放同一栏。 */
export type NoteSectionKey = Exclude<NoteFilter, 'all'> | 'planned';
/** 便签的纸色。plan = 还没开工的计划卡，铅笔草稿感；其余与事项状态一一对应。 */
export type NoteTone = 'running' | 'review' | 'needs' | 'plan' | 'done' | 'cancelled';

export const KITTEN_NAMES = ['小A同学', '年糕', '芝麻', '布丁', '栗子', '可乐', '小满', '豆包', '麻薯', '橘子', '汤圆', '奶盖'];

const BUSY_MAIN_STATES = new Set(['starting', 'thinking', 'running_tool', 'interrupting']);

export function noteTone(task: Pick<AssistantTask, 'state' | 'plan' | 'outcome'>): NoteTone {
  if (task.state === 'closed') return task.outcome === 'cancelled' ? 'cancelled' : 'done';
  if (task.plan) return 'plan';
  if (task.state === 'needs_user') return 'needs';
  if (task.state === 'review') return 'review';
  return 'running';
}

export const noteToneLabel: Record<NoteTone, string> = {
  running: '进行中', review: '待验收', needs: '需要你', plan: '计划待开工', done: '已验收', cancelled: '已取消'
};

export function noteSectionOf(task: Pick<AssistantTask, 'state' | 'plan'>): NoteSectionKey {
  if (task.state === 'closed') return 'closed';
  // 计划卡在服务端是 review（等用户确认后才 start），但对用户来说只是「等你点头」，
  // 不能混进待验收，否则侧栏/抽屉会把还没开工的计划说成做完待验。
  if (task.plan) return 'planned';
  if (task.state === 'needs_user') return 'needs_user';
  if (task.state === 'review') return 'review';
  return 'running';
}

export const noteSectionLabel: Record<NoteSectionKey, string> = {
  needs_user: '需要你', planned: '等你点头', review: '待验收', running: '进行中', closed: '已完成'
};

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
export function groupNotes(tasks: AssistantTask[], filter: NoteFilter = 'all'): NoteSection[] {
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
    .map(key => ({ key, label: noteSectionLabel[key], tasks: [...(buckets.get(key) ?? [])].sort((left, right) => sortTime(right).localeCompare(sortTime(left))) }))
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

export function companionBubble(event: CompanionEvent): { text: string; tone: BubbleTone } {
  const title = event.task.title;
  switch (event.kind) {
    case 'dispatched': return { text: `派出一张便签：${title}`, tone: 'info' };
    case 'planned': return { text: `写了张计划便签「${title}」，你点头就开工`, tone: 'info' };
    case 'started': return { text: `便签「${title}」开工啦`, tone: 'info' };
    case 'review': return { text: `「${title}」做完了，我去验收`, tone: 'info' };
    case 'needs_user': return { text: `「${title}」需要你拍板`, tone: 'alert' };
    case 'accepted': return { text: `验收通过：${title}`, tone: 'success' };
    case 'cancelled': return { text: `撕掉了便签：${title}`, tone: 'muted' };
    case 'rework': return { text: `「${title}」打回去返工了`, tone: 'info' };
  }
}

/* ---------- 心情与状态 ---------- */

/** 小猫最近一次值得表态的事：便签上的变化，或者 cheer（刚被认领、刚换了名字，单纯开心）。 */
export type RecentKind = CompanionEventKind | 'cheer';

export type MoodInput = {
  /** 主会话自己的运行状态；没有主会话时为空。 */
  mainState?: string;
  tasks: AssistantTask[];
  /** 最近一次值得表态的事件（例如刚验收通过），几秒内影响心情。 */
  recent?: { kind: RecentKind; at: number };
  /** 最后一次有动静的时间（主会话或任务变化、用户互动）。 */
  lastActiveAt: number;
  now: number;
};

const RECENT_WINDOW_MS = 6_000;
const SLEEPY_AFTER_MS = 3 * 60_000;

export function deriveMood(input: MoodInput): KittenMood {
  const { mainState, tasks, recent, lastActiveAt, now } = input;
  if (!mainState) return 'curious';
  if (mainState === 'waiting_for_permission' || tasks.some(task => task.state === 'needs_user')) return 'alert';
  if (recent && now - recent.at < RECENT_WINDOW_MS) {
    if (recent.kind === 'accepted' || recent.kind === 'cheer') return 'happy';
    if (recent.kind === 'dispatched' || recent.kind === 'started') return 'busy';
  }
  if (BUSY_MAIN_STATES.has(mainState)) return 'busy';
  if (mainState === 'failed') return 'sad';
  // 还有便签在跑：醒着盯进度，不打盹。
  if (tasks.some(task => task.state === 'running' || task.state === 'review')) return 'idle';
  if (now - lastActiveAt > SLEEPY_AFTER_MS) return 'sleepy';
  return 'idle';
}

export function companionStatus(input: { mainState?: string; counts: NoteCounts; mood: KittenMood; recent?: RecentKind }): string {
  const { mainState, counts, mood, recent } = input;
  if (!mainState) return '等你来认领';
  if (mainState === 'starting') return '醒来中…';
  if (mainState === 'waiting_for_permission') return '在等你授权';
  if (counts.needsUser > 0) return `${counts.needsUser} 件事等你拍板`;
  if (counts.planned > 0) return `${counts.planned} 张计划等你点头`;
  if (mainState === 'thinking') return '正在思考…';
  if (mainState === 'running_tool') return '正在忙活…';
  if (mainState === 'interrupting') return '停下手头的事…';
  if (mood === 'happy') return recent === 'cheer' ? '开心地摇尾巴' : '验收通过啦';
  if (counts.review > 0) return `${counts.review} 张便签待验收`;
  if (counts.running > 0) return `在盯着 ${counts.running} 张便签`;
  if (mainState === 'failed') return '出了点状况';
  if (mood === 'sleepy') return '打盹中';
  return '随时待命';
}

export const isMainBusy = (state?: string) => Boolean(state && BUSY_MAIN_STATES.has(state));

/** 本机时间的问候语（用户在新加坡，浏览器时区即 UTC+8）。 */
export function greeting(date: Date = new Date()): string {
  const hour = date.getHours();
  if (hour < 5) return '夜深了';
  if (hour < 11) return '早上好';
  if (hour < 13) return '中午好';
  if (hour < 18) return '下午好';
  return '晚上好';
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

export function pickKittenName(current?: string, random: () => number = Math.random): string {
  const pool = KITTEN_NAMES.filter(name => name !== current);
  return pool[Math.floor(random() * pool.length) % pool.length] ?? KITTEN_NAMES[0]!;
}

/** 「12 分钟前」这类相对时间；不到一分钟说「刚刚」。 */
export function sinceLabel(iso: string | undefined, now: number = Date.now()): string {
  if (!iso) return '';
  const time = Date.parse(iso);
  if (!Number.isFinite(time)) return '';
  const minutes = Math.max(0, Math.floor((now - time) / 60_000));
  if (minutes < 1) return '刚刚';
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时前`;
  return `${Math.floor(hours / 24)} 天前`;
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

export const supervisionKindTone: Record<string, NoteTone> = { review: 'review', needs_you: 'needs', failed: 'needs' };
