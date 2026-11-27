import type {
  BoardColumnColor,
  BoardColumnRule,
  BoardEntityKind,
  BoardVisualState,
  HydratedBoard,
  HydratedBoardColumn,
  HydratedBoardItem
} from '../api';
import type { KittenMood } from '../companion/kitten-moods';

export interface ColumnColorStyle {
  dot: string;
  bar: string;
  badge: string;
  ring: string;
  label: string;
}

export const BOARD_COLUMN_COLOR_OPTIONS: Array<{ value: BoardColumnColor; label: string; swatch: string }> = [
  { value: 'zinc', label: '沉静灰', swatch: 'bg-zinc-400' },
  { value: 'blue', label: '运行蓝', swatch: 'bg-blue-500' },
  { value: 'sky', label: '验收天蓝', swatch: 'bg-sky-500' },
  { value: 'amber', label: '待定琥珀', swatch: 'bg-amber-500' },
  { value: 'orange', label: '醒目橙', swatch: 'bg-orange-500' },
  { value: 'emerald', label: '完成翡翠', swatch: 'bg-emerald-500' },
  { value: 'red', label: '告警红', swatch: 'bg-red-500' }
];

export const COLUMN_COLOR_STYLES: Record<BoardColumnColor, ColumnColorStyle> = {
  zinc: {
    dot: 'bg-zinc-400',
    bar: 'bg-zinc-400',
    badge: 'bg-zinc-200/70 text-zinc-600',
    ring: 'ring-zinc-400/35',
    label: '灰'
  },
  blue: {
    dot: 'bg-blue-500',
    bar: 'bg-blue-500',
    badge: 'bg-blue-100 text-blue-700',
    ring: 'ring-blue-400/40',
    label: '蓝'
  },
  sky: {
    dot: 'bg-sky-500',
    bar: 'bg-sky-500',
    badge: 'bg-sky-100 text-sky-700',
    ring: 'ring-sky-400/40',
    label: '天蓝'
  },
  amber: {
    dot: 'bg-amber-500',
    bar: 'bg-amber-500',
    badge: 'bg-amber-100 text-amber-800',
    ring: 'ring-amber-400/45',
    label: '琥珀'
  },
  orange: {
    dot: 'bg-orange-500',
    bar: 'bg-orange-500',
    badge: 'bg-orange-100 text-orange-800',
    ring: 'ring-orange-400/45',
    label: '橙'
  },
  emerald: {
    dot: 'bg-emerald-500',
    bar: 'bg-emerald-500',
    badge: 'bg-emerald-100 text-emerald-700',
    ring: 'ring-emerald-400/40',
    label: '翡翠'
  },
  red: {
    dot: 'bg-red-500',
    bar: 'bg-red-500',
    badge: 'bg-red-100 text-red-700',
    ring: 'ring-red-400/45',
    label: '红'
  }
};

export interface VisualStateStyle {
  label: string;
  barClass: string;
  dotClass: string;
  textClass: string;
  pulse?: 'running' | 'alert';
}

export const VISUAL_STATE_META: Record<BoardVisualState, VisualStateStyle> = {
  running: {
    label: '进行中',
    barClass: 'bg-blue-500 ui-board-bar-pulse',
    dotClass: 'bg-blue-500 ui-board-dot-pulse',
    textClass: 'text-blue-600',
    pulse: 'running'
  },
  thinking: {
    label: '思考中',
    barClass: 'bg-sky-500 ui-board-bar-pulse',
    dotClass: 'bg-sky-500 ui-board-dot-pulse',
    textClass: 'text-sky-600',
    pulse: 'running'
  },
  waiting_approval: {
    label: '待授权',
    barClass: 'bg-amber-500 ui-board-bar-breathe',
    dotClass: 'bg-amber-500 ui-board-dot-pulse',
    textClass: 'text-amber-700',
    pulse: 'alert'
  },
  needs_user: {
    label: '需要你',
    barClass: 'bg-orange-500 ui-board-bar-breathe',
    dotClass: 'bg-orange-500 ui-board-dot-pulse',
    textClass: 'text-orange-700',
    pulse: 'alert'
  },
  review: {
    label: '待验收',
    barClass: 'bg-sky-500',
    dotClass: 'bg-sky-500',
    textClass: 'text-sky-700'
  },
  plan: {
    label: '计划中',
    barClass: 'bg-amber-400',
    dotClass: 'bg-amber-400',
    textClass: 'text-amber-700'
  },
  idle: {
    label: '待命',
    barClass: 'bg-zinc-300',
    dotClass: 'bg-zinc-400',
    textClass: 'text-zinc-500'
  },
  user_stopped: {
    label: '已停止',
    barClass: 'bg-zinc-400',
    dotClass: 'bg-zinc-400',
    textClass: 'text-zinc-500'
  },
  done: {
    label: '已完成',
    barClass: 'bg-emerald-500',
    dotClass: 'bg-emerald-500',
    textClass: 'text-emerald-700'
  },
  failed: {
    label: '出错',
    barClass: 'bg-red-500 ui-board-bar-breathe',
    dotClass: 'bg-red-500',
    textClass: 'text-red-600',
    pulse: 'alert'
  },
  note: {
    label: '便签',
    barClass: 'bg-zinc-400',
    dotClass: 'bg-zinc-400',
    textClass: 'text-zinc-500'
  }
};

export interface BoardFilterState {
  query: string;
  agentId: string;
  visualState: BoardVisualState | 'all';
}

export function isFilterActive(filter: BoardFilterState): boolean {
  return Boolean(filter.query.trim()) || filter.agentId !== 'all' || filter.visualState !== 'all';
}

export function filterBoardColumns(columns: HydratedBoardColumn[], filter: BoardFilterState): HydratedBoardColumn[] {
  if (!isFilterActive(filter)) return columns;
  const q = filter.query.trim().toLowerCase();
  return columns.map(column => ({
    ...column,
    items: column.items.filter(item => {
      if (filter.agentId !== 'all' && item.live.agentId !== filter.agentId) return false;
      if (filter.visualState !== 'all' && item.live.visualState !== filter.visualState) return false;
      if (!q) return true;
      const hay = [
        item.live.title,
        item.live.activity ?? '',
        item.userNote ?? '',
        item.kittenNote ?? '',
        item.live.cwd ?? '',
        item.live.agentId ?? '',
        item.tags.join(' ')
      ].join(' ').toLowerCase();
      return hay.includes(q);
    })
  }));
}

export function formatBoardElapsed(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms) || ms < 0) return '';
  const totalSec = Math.floor(ms / 1000);
  if (totalSec < 60) return `${totalSec}s`;
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  if (m < 60) return `${m}m${s < 10 ? `0${s}` : s}s`;
  const h = Math.floor(m / 60);
  const remM = m % 60;
  return `${h}h${remM < 10 ? `0${remM}` : remM}m`;
}

export function formatRelativeBrief(iso: string | undefined | null, now = Date.now()): string {
  if (!iso) return '';
  const ts = Date.parse(iso);
  if (!Number.isFinite(ts)) return '';
  const diffSec = Math.max(0, Math.floor((now - ts) / 1000));
  if (diffSec < 45) return '刚刚';
  if (diffSec < 3600) return `${Math.floor(diffSec / 60)}m前`;
  if (diffSec < 86400) return `${Math.floor(diffSec / 3600)}h前`;
  return `${Math.floor(diffSec / 86400)}d前`;
}

export function projectBasename(cwd: string | undefined | null): string {
  if (!cwd) return '';
  const normalized = cwd.replace(/\/+$/, '');
  return normalized.split('/').pop() || normalized;
}

export interface MentionedBoardCard {
  id: string;
  title: string;
  visualState: BoardVisualState;
  entityKind: BoardEntityKind;
  entityId: string;
  sessionId?: string;
}

export function toMentionedCard(item: HydratedBoardItem): MentionedBoardCard {
  return {
    id: item.id,
    title: item.live.title,
    visualState: item.live.visualState,
    entityKind: item.entityKind,
    entityId: item.entityId,
    ...(item.live.sessionId ? { sessionId: item.live.sessionId } : {})
  };
}

export type QuickKittenActionKey = 'supervise' | 'review' | 'rework' | 'organize' | 'summary';

export interface QuickKittenAction {
  key: QuickKittenActionKey;
  label: string;
  prompt(cards: MentionedBoardCard[]): string;
  needsCards?: boolean;
}

export const QUICK_KITTEN_ACTIONS: QuickKittenAction[] = [
  {
    key: 'supervise',
    label: '督办进展',
    needsCards: true,
    prompt: cards => cards.length === 1
      ? `请帮我检查「${cards[0]!.title}」的最新进展，如有阻塞或等待点直接帮我推进，并在卡片上写一条简短的督办批注。`
      : `请帮我逐一巡检这 ${cards.length} 张卡片的最新进展与阻塞点，给每张卡补一条简短督办批注，并向我汇报需要优先拍板的事项。`
  },
  {
    key: 'review',
    label: '立刻验收',
    needsCards: true,
    prompt: cards => cards.length === 1
      ? `请立刻核对「${cards[0]!.title}」的验收标准和实际产物；全部达标就验收通过并更新卡片批注，否则指出具体缺口。`
      : `请逐条验收这 ${cards.length} 张卡片的交付结果，达标的直接放行，未达标的说明缺口并写批注。`
  },
  {
    key: 'rework',
    label: '打回返工',
    needsCards: true,
    prompt: cards => `请检查这 ${cards.length} 张卡片的当前实现，找出问题并打回返工，给出明确的修改清单。`
  },
  {
    key: 'summary',
    label: '汇总进度',
    prompt: cards => cards.length
      ? `请用简洁要点帮我汇总这 ${cards.length} 张卡片的当前进度、耗时和下一步建议。`
      : '请帮我汇总当前看板所有活跃任务的整体进度、最值得关注的阻塞项，以及建议的下一步动作。'
  },
  {
    key: 'organize',
    label: '帮我理看板',
    prompt: cards => cards.length
      ? `请结合这 ${cards.length} 张卡片的优先级与状态，用 agent-dock board 命令帮我整理列排布、置顶最关键的任务并写上简短批注。`
      : '请检视当前看板所有卡片，用 agent-dock board 命令帮我置顶最紧急或卡住的任务、归类杂乱卡片并补充简短督办批注。'
  }
];

export interface BoardKittenMoodInput {
  baseMood: KittenMood;
  adopted: boolean;
  isDraggingCard: boolean;
  isOverKittenDock: boolean;
  transientMood?: { mood: KittenMood; expiresAt: number } | null;
  hydrated?: HydratedBoard;
  now: number;
}

/**
 * 看板内主小猫实时表情推导：
 * 1. 拖卡悬停到小猫 Dock → curious（探头期待接卡）
 * 2. 临时瞬态反应（刚验收庆祝 / 刚整理看板 / 刚投喂成功）→ transientMood
 * 3. 未认领 → curious
 * 4. 看板内高优先级态势与主会话基础心情融合：报错 → error、待拍板/待授权 → waiting、待验收 → reviewing、多任务并行 → delegating
 */
export function deriveBoardKittenMood(input: BoardKittenMoodInput): KittenMood {
  const { baseMood, adopted, isDraggingCard, isOverKittenDock, transientMood, hydrated, now } = input;
  if (isDraggingCard && isOverKittenDock) return 'curious';
  if (transientMood && transientMood.expiresAt > now) return transientMood.mood;
  if (!adopted) return 'curious';
  if (isDraggingCard) return 'curious';

  if (baseMood === 'error' || baseMood === 'waiting' || baseMood === 'thinking' || baseMood === 'busy' || baseMood === 'celebrating' || baseMood === 'tidying') {
    return baseMood;
  }

  const summary = hydrated?.summary;
  const hasFailed = hydrated?.columns.some(col => col.items.some(i => i.live.visualState === 'failed')) ?? false;
  if (hasFailed) return 'error';
  if (summary) {
    if (summary.needsAttention > 0) return 'waiting';
    if (summary.review > 0) return 'reviewing';
    if (summary.running >= 2) return 'delegating';
  }
  return baseMood;
}

export function describeColumnRule(rule: BoardColumnRule | null | undefined): string | null {
  if (!rule) return null;
  const parts: string[] = [];
  if (rule.taskStates?.length) {
    const map: Record<string, string> = {
      running: '进行中便签',
      review: '待验收便签',
      needs_user: '需要你便签',
      plan: '计划中便签',
      closed: '已完成便签'
    };
    parts.push(rule.taskStates.map(s => map[s] ?? s).join('/'));
  }
  if (rule.sessionStates?.length) {
    parts.push(`会话:${rule.sessionStates.join('/')}`);
  }
  if (rule.agentIds?.length) parts.push(`Agent:${rule.agentIds.join('/')}`);
  if (rule.cwdContains) parts.push(`目录:${projectBasename(rule.cwdContains)}`);
  if (rule.maxItems) parts.push(`最多${rule.maxItems}条`);
  return parts.length ? parts.join(' · ') : '智能规则';
}

export const RULE_PRESETS: Array<{ id: string; label: string; desc: string; rule: BoardColumnRule | null; color: BoardColumnColor }> = [
  { id: 'manual', label: '纯手动自由列', desc: '只放你手动拖入或添加的卡片，不自动吸纳', rule: null, color: 'zinc' },
  {
    id: 'needs_user',
    label: '需要你 / 待授权',
    desc: '自动汇聚等待审批、计划待拍板和报错任务',
    rule: { entityKinds: ['task', 'session'], taskStates: ['needs_user', 'plan'], sessionStates: ['waiting_for_permission', 'failed'] },
    color: 'orange'
  },
  {
    id: 'running',
    label: '进行中（实时运行）',
    desc: '自动汇聚运行中的便签与活跃执行中的会话',
    rule: { entityKinds: ['task', 'session'], taskStates: ['running'], sessionStates: ['starting', 'thinking', 'running_tool', 'interrupting'] },
    color: 'blue'
  },
  {
    id: 'review',
    label: '待验收',
    desc: '自动汇聚已交付等待主小猫或你验收的便签',
    rule: { entityKinds: ['task'], taskStates: ['review'] },
    color: 'sky'
  },
  {
    id: 'completed',
    label: '近期完成（最近 20 条）',
    desc: '自动展示近期完成的任务与会话',
    rule: { entityKinds: ['task', 'session'], taskStates: ['closed'], sessionStates: ['completed'], maxItems: 20 },
    color: 'emerald'
  }
];
