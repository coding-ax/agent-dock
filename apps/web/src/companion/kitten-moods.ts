import type { AssistantTask, LifeStage } from '../api';

/**
 * Companion 小猫多状态体系：状态枚举、精灵资源映射、文案/提示元数据、状态推导优先级与防抖平滑。
 *
 * 独立于具体 UI 组件，全部为纯函数与静态表：
 * - 15 张主题一致的像素立绘（7 张既有 + 8 张新增），每张均配套 .webp（动效）与 .png（降级/静态）；
 * - 向后兼容所有既有 KittenMood（含 alert / sad / curious / busy / happy / sleepy / idle）；
 * - 兼容小猫生命阶段（kitten / adult / senior / elder）的节奏差异，不破坏现有交接与老化逻辑；
 * - 防抖平滑（stabilizeKittenMood）消除轮询/流式状态在 thinking ↔ busy / idle 间的高频闪烁。
 */

export const KITTEN_SPRITE_KEYS = [
  'idle',
  'curious',
  'thinking',
  'busy',
  'delegating',
  'search',
  'waiting',
  'happy',
  'celebrating',
  'error',
  'sad',
  'tidying',
  'night',
  'sleepy',
  'sparkle',
] as const;

export type KittenSpriteKey = (typeof KITTEN_SPRITE_KEYS)[number];

export const KITTEN_MOODS = [
  'idle',
  'curious',
  'thinking',
  'busy',
  'delegating',
  'reviewing',
  'waiting',
  'alert',
  'happy',
  'celebrating',
  'error',
  'sad',
  'tidying',
  'night',
  'sleepy',
] as const;

export type KittenMood = (typeof KITTEN_MOODS)[number];

export type KittenMoodTone = 'neutral' | 'info' | 'active' | 'warning' | 'success' | 'danger' | 'cozy';

/**
 * 防抖优先级档位：
 * - 4：即时阻断/异常/身份态（waiting / alert / error / sad / curious），零延迟切换
 * - 3：即时正向反馈（celebrating / happy），零延迟切入
 * - 2：活跃工作态（thinking / busy / delegating / reviewing / tidying），从休息态切入零延迟，工作态之间/回落休息态按最小停留窗防抖
 * - 1：静息陪伴态（idle / night / sleepy）
 */
export type KittenMoodTier = 1 | 2 | 3 | 4;

export type KittenMoodMeta = {
  sprite: KittenSpriteKey;
  label: string;
  hint: string;
  tier: KittenMoodTier;
  tone: KittenMoodTone;
};

export const KITTEN_MOOD_META: Record<KittenMood, KittenMoodMeta> = {
  idle: {
    sprite: 'idle',
    label: '随时待命',
    hint: '安静守在工位上，随时准备接活',
    tier: 1,
    tone: 'neutral',
  },
  curious: {
    sprite: 'curious',
    label: '好奇探头',
    hint: '歪着脑袋打量，等你带它开工',
    tier: 4,
    tone: 'info',
  },
  thinking: {
    sprite: 'thinking',
    label: '思考推演',
    hint: '托腮琢磨思路与拆解方案',
    tier: 2,
    tone: 'active',
  },
  busy: {
    sprite: 'busy',
    label: '专注干活',
    hint: '敲着键盘调用工具执行中',
    tier: 2,
    tone: 'active',
  },
  delegating: {
    sprite: 'delegating',
    label: '派活调度',
    hint: '正在派发便签或并行盯着多项任务',
    tier: 2,
    tone: 'info',
  },
  reviewing: {
    sprite: 'search',
    label: '验收审查',
    hint: '举着放大镜逐条核对交付结果',
    tier: 2,
    tone: 'info',
  },
  waiting: {
    sprite: 'waiting',
    label: '等你拍板',
    hint: '轻轻招手，等你授权、确认计划或做决定',
    tier: 4,
    tone: 'warning',
  },
  alert: {
    sprite: 'waiting',
    label: '需要你处理',
    hint: '有卡住的事项或授权在等你拍板',
    tier: 4,
    tone: 'warning',
  },
  happy: {
    sprite: 'happy',
    label: '开心摇尾巴',
    hint: '心情很好，眯起眼睛摇尾巴',
    tier: 3,
    tone: 'success',
  },
  celebrating: {
    sprite: 'celebrating',
    label: '交付庆祝',
    hint: '任务验收通过或阶段完成，举爪撒花中',
    tier: 3,
    tone: 'success',
  },
  error: {
    sprite: 'error',
    label: '排查出错',
    hint: '遇到报错或任务异常，小紧张排查中',
    tier: 4,
    tone: 'danger',
  },
  sad: {
    sprite: 'sad',
    label: '有点失落',
    hint: '耳朵耷拉下来，有点委屈或暂时冻结',
    tier: 4,
    tone: 'neutral',
  },
  tidying: {
    sprite: 'tidying',
    label: '整理记忆',
    hint: '正在打扫归档已完成便签、梳理上下文记忆',
    tier: 2,
    tone: 'info',
  },
  night: {
    sprite: 'night',
    label: '深夜陪伴',
    hint: '夜深了，点着小月光陪你守在屏幕旁',
    tier: 1,
    tone: 'cozy',
  },
  sleepy: {
    sprite: 'sleepy',
    label: '空闲打盹',
    hint: '暂时清闲，先趴下眯一会儿，喊一声就醒',
    tier: 1,
    tone: 'cozy',
  },
};

export const KITTEN_SPRITE_PNG: Record<KittenSpriteKey, string> = Object.fromEntries(
  KITTEN_SPRITE_KEYS.map(key => [key, `/companion/cat-${key}.png`])
) as Record<KittenSpriteKey, string>;

export const KITTEN_SPRITE_WEBP: Record<KittenSpriteKey, string> = Object.fromEntries(
  KITTEN_SPRITE_KEYS.map(key => [key, `/companion/cat-${key}.webp`])
) as Record<KittenSpriteKey, string>;

export const FALLBACK_KITTEN_SPRITE = KITTEN_SPRITE_PNG.idle;

export function kittenSpriteKey(mood: KittenMood | undefined, sparkling = false): KittenSpriteKey {
  if (sparkling) return 'sparkle';
  return (mood && KITTEN_MOOD_META[mood]?.sprite) || 'idle';
}

export function kittenSpritePng(mood: KittenMood | undefined, sparkling = false): string {
  return KITTEN_SPRITE_PNG[kittenSpriteKey(mood, sparkling)] ?? FALLBACK_KITTEN_SPRITE;
}

export function kittenSpriteWebp(mood: KittenMood | undefined, sparkling = false): string {
  return KITTEN_SPRITE_WEBP[kittenSpriteKey(mood, sparkling)] ?? KITTEN_SPRITE_WEBP.idle;
}

export function kittenMoodMeta(mood: KittenMood | undefined): KittenMoodMeta {
  return (mood && KITTEN_MOOD_META[mood]) || KITTEN_MOOD_META.idle;
}

/* ---------- 状态推导规则与阈值 ---------- */

/** 小猫最近一次值得表态的事：便签变化、生命周期里程碑，或 cheer（认领/改名）。 */
export type KittenRecentKind =
  | 'dispatched'
  | 'planned'
  | 'started'
  | 'review'
  | 'needs_user'
  | 'accepted'
  | 'cancelled'
  | 'rework'
  | 'cheer'
  | 'maintenance_finished'
  | 'handoff_done'
  | 'handoff_rolled_back';

export type KittenMoodInput = {
  /** 主会话自己的运行状态；没有主会话时为空。 */
  mainState?: string;
  /** 主会话最近一次轮次错误（runtime 轮次失败会回收为 state='idle' 并挂 error）。 */
  mainError?: string | null;
  /** 主会话已被归档冻结。 */
  archived?: boolean;
  tasks: AssistantTask[];
  /** 待用户确认发送的草稿数量（GitHub 评论、飞书回复）。 */
  pendingDrafts?: number;
  /** 生命周期整理轮次正在运行。 */
  maintenanceRunning?: boolean;
  /** 小猫生命阶段：柔和影响打盹阈值，兼容成长/老化逻辑。 */
  stage?: LifeStage;
  /** 最近一次值得表态的事件（例如刚验收通过），几秒内影响心情。 */
  recent?: { kind: KittenRecentKind; at: number };
  /** 最后一次有动静的时间（主会话或任务变化、用户互动）。 */
  lastActiveAt: number;
  now: number;
  /** 本地小时（0–23）。仅传入时启用深夜陪伴态，确保纯函数单测跨时区确定。 */
  localHour?: number;
};

export const RECENT_WINDOW_MS = 6_000;
export const DEFAULT_SLEEPY_AFTER_MS = 3 * 60_000;
export const MIN_MOOD_HOLD_MS = 1_200;
export const LATE_NIGHT_START_HOUR = 23;
export const LATE_NIGHT_END_HOUR = 5;

const WORKING_MAIN_STATES = new Set(['starting', 'running_tool', 'interrupting']);

export function isLateNightHour(hour: number | undefined): boolean {
  if (hour === undefined || !Number.isFinite(hour)) return false;
  const normalized = ((Math.floor(hour) % 24) + 24) % 24;
  return normalized >= LATE_NIGHT_START_HOUR || normalized < LATE_NIGHT_END_HOUR;
}

/**
 * 犯困阈值随生命阶段微调：
 * - 幼猫精力更足（4 分钟）；成年沿用 3 分钟基线；资深 2.5 分钟；老年 2 分钟更容易小憩。
 */
export function sleepyThresholdMs(stage?: LifeStage): number {
  switch (stage) {
    case 'kitten': return 4 * 60_000;
    case 'senior': return 150_000;
    case 'elder': return 2 * 60_000;
    case 'adult':
    default:
      return DEFAULT_SLEEPY_AFTER_MS;
  }
}

export function hasFailedNeedsUserTask(tasks: AssistantTask[]): boolean {
  return tasks.some(
    task => task.state === 'needs_user' && (task.lastStopReason === 'failed' || task.lastStopReason === 'timeout')
  );
}

/**
 * 状态推导优先级（从高到低）：
 * 1. 未认领（!mainState）→ curious
 * 2. 主会话被归档（archived）→ sad
 * 3. 主会话等待权限授权（waiting_for_permission）→ waiting
 * 4. 异常/报错态（mainState=failed、idle+mainError、或 needs_user 侧边任务失败/超时）→ error
 * 5. 等待用户拍板（needs_user 事项）→ waiting
 * 6. 近期即时反应（6 秒窗内）：
 *    - accepted / maintenance_finished / handoff_done → celebrating
 *    - cheer → happy
 *    - handoff_rolled_back → sad
 *    - dispatched / started / planned → delegating
 *    - review → reviewing
 *    - rework → thinking
 * 7. 主会话实时运行态：
 *    - thinking → thinking
 *    - running_tool / starting / interrupting → busy
 * 8. 生命周期整理轮次进行中 → tidying
 * 9. 后台便签与草稿态势（主会话空闲时）：
 *    - 有待验收便签（非计划卡的 review）→ reviewing
 *    - ≥2 张便签并行运行 → delegating
 *    - 1 张便签运行中 → idle（保持清醒盯进度，不打盹）
 *    - 有待点头计划卡或待确认草稿 → waiting（柔和招手等待，不报红）
 * 10. 静息与昼夜陪伴：
 *    - 超过按年龄缩放的空闲阈值 → sleepy
 *    - 深夜时段（23:00–04:59）静默待命 → night
 *    - 其余 → idle
 */
export function deriveKittenMood(input: KittenMoodInput): KittenMood {
  const {
    mainState,
    mainError,
    archived,
    tasks,
    pendingDrafts = 0,
    maintenanceRunning = false,
    stage,
    recent,
    lastActiveAt,
    now,
    localHour,
  } = input;

  if (!mainState) return 'curious';
  if (archived) return 'sad';
  if (mainState === 'waiting_for_permission') return 'waiting';
  if (mainState === 'failed' || (mainState === 'idle' && Boolean(mainError))) return 'error';
  if (hasFailedNeedsUserTask(tasks)) return 'error';
  if (tasks.some(task => task.state === 'needs_user')) return 'waiting';

  // useMoodClock 仅在窗口边界触发刷新，刚写入 store 的 recent.at 可能略大于缓存的 now；
  // 不能加 `now - recent.at >= 0`，否则刚验收通过或改名的瞬间会被误判为无效。
  if (recent && now - recent.at < RECENT_WINDOW_MS) {
    if (recent.kind === 'accepted' || recent.kind === 'maintenance_finished' || recent.kind === 'handoff_done') return 'celebrating';
    if (recent.kind === 'cheer') return 'happy';
    if (recent.kind === 'handoff_rolled_back') return 'sad';
    if (recent.kind === 'dispatched' || recent.kind === 'started' || recent.kind === 'planned') return 'delegating';
    if (recent.kind === 'review') return 'reviewing';
    if (recent.kind === 'rework') return 'thinking';
  }

  if (mainState === 'thinking') return 'thinking';
  if (WORKING_MAIN_STATES.has(mainState)) return 'busy';
  if (maintenanceRunning) return 'tidying';

  let running = 0;
  let review = 0;
  let planned = 0;
  for (const task of tasks) {
    if (task.state === 'closed') continue;
    if (task.plan) { planned += 1; continue; }
    if (task.state === 'review') review += 1;
    else if (task.state === 'running') running += 1;
  }

  if (review > 0) return 'reviewing';
  if (running >= 2) return 'delegating';
  if (running === 1) return 'idle';
  if (planned > 0 || pendingDrafts > 0) return 'waiting';

  if (now - lastActiveAt > sleepyThresholdMs(stage)) return 'sleepy';
  if (isLateNightHour(localHour)) return 'night';
  return 'idle';
}

/* ---------- 防频繁抖动平滑 ---------- */

export type MoodStabilizerState = {
  mood: KittenMood;
  changedAt: number;
};

export type MoodStabilizeResult = {
  mood: KittenMood;
  changedAt: number;
  /** 若因防抖暂缓切换，返回距允许切换的剩余毫秒数；0 或 undefined 表示已就位。 */
  pendingDelayMs?: number;
};

/**
 * 防抖平滑状态切换：
 * - 紧急/高优态（tier 4）或优先级升高（如 idle → thinking、busy → celebrating/error）立即切换；
 * - 同级工作态抖动（如 thinking ↔ busy）或向低优态回落（如 busy → idle）至少停留 MIN_MOOD_HOLD_MS，
 *   避免 2 秒轮询与流式事件交替导致小猫头像高频闪烁。
 */
export function stabilizeKittenMood(
  previous: MoodStabilizerState | undefined,
  nextMood: KittenMood,
  now: number,
  minHoldMs: number = MIN_MOOD_HOLD_MS
): MoodStabilizeResult {
  if (!previous) return { mood: nextMood, changedAt: now };
  if (previous.mood === nextMood) return { mood: previous.mood, changedAt: previous.changedAt };

  const prevTier = kittenMoodMeta(previous.mood).tier;
  const nextTier = kittenMoodMeta(nextMood).tier;
  if (nextTier === 4 || nextTier > prevTier) {
    return { mood: nextMood, changedAt: now };
  }

  const elapsed = now - previous.changedAt;
  if (elapsed >= minHoldMs) {
    return { mood: nextMood, changedAt: now };
  }

  return {
    mood: previous.mood,
    changedAt: previous.changedAt,
    pendingDelayMs: Math.max(0, minHoldMs - elapsed),
  };
}
