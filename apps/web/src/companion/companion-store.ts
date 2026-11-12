import { create } from 'zustand';
import type { BubbleTone, CompanionEventKind, NoteFilter, RecentKind } from './companion-model';

/** 气泡被点时去哪：打开某张便签，或者回到主会话。 */
export type BubbleAction = { kind: 'note'; taskId: string } | { kind: 'main' };

export type CompanionBubble = { id: number; text: string; tone: BubbleTone; action?: BubbleAction };

/** 首页输入框发给谁：开一个新对话，还是交给小猫（主会话）。 */
export type HomeTarget = 'new' | 'companion';

const INVITE_KEY = 'agentdock:companion-invite-dismissed';
const TARGET_KEY = 'agentdock:home-target';

function readStorage(key: string): string | null {
  try { return window.localStorage.getItem(key); } catch { return null; }
}
function writeStorage(key: string, value: string | null) {
  try {
    if (value === null) window.localStorage.removeItem(key);
    else window.localStorage.setItem(key, value);
  } catch { /* 隐私模式等写不进去时只在本页生效 */ }
}

type CompanionUiStore = {
  drawerOpen: boolean;
  /** 每打开一次抽屉加一：抽屉内容按它重新挂载，便签每次都重新「落」一遍。 */
  drawerNonce: number;
  filter: NoteFilter;
  /** 打开抽屉时要闪一下的便签；nonce 让同一张便签可以被反复定位。 */
  highlight?: { taskId: string; nonce: number };
  bubble?: CompanionBubble;
  queue: CompanionBubble[];
  /** 最近一次值得表态的事件，几秒内影响小猫心情（见 deriveMood）。 */
  recent?: { kind: RecentKind; at: number };
  /** 最后一次有动静的时间：超过几分钟没动静，小猫开始打盹。 */
  lastActiveAt: number;
  /** 便签上的「问问它」：预填到主会话输入框，由主会话面板消费。 */
  mainDraft?: { text: string; nonce: number };
  /**
   * 有人请求认领（侧栏「认领一只小猫」、右缘探头的小猫、设置弹窗）：首页挂载或已在首页时
   * 展开认领卡片并消费掉。用布尔挂起而不是计数，首页可能在请求之后才挂载。
   */
  adoptPending: boolean;
  /** 认领成功的庆祝：首页小猫跳一下、冒爱心。 */
  celebrateNonce: number;
  /** 用户点过「先不了」：首页不再主动邀请，侧栏和右缘也不再探头（设置里仍可认领）。 */
  inviteDismissed: boolean;
  homeTarget: HomeTarget;
  openDrawer(options?: { filter?: NoteFilter; highlight?: string }): void;
  closeDrawer(): void;
  toggleDrawer(): void;
  setFilter(filter: NoteFilter): void;
  say(text: string, tone?: BubbleTone, action?: BubbleAction): void;
  nextBubble(): void;
  markRecent(kind: CompanionEventKind): void;
  touch(): void;
  draftForMain(text: string): void;
  consumeMainDraft(): void;
  requestAdoption(): void;
  consumeAdoption(): void;
  celebrate(): void;
  dismissInvite(dismissed?: boolean): void;
  setHomeTarget(target: HomeTarget): void;
};

let bubbleSeq = 0;
/** 排队的气泡最多留几条：一口气来十个状态变化时只播最新的，不刷屏。 */
const MAX_QUEUE = 3;

export const useCompanionStore = create<CompanionUiStore>(set => ({
  drawerOpen: false,
  drawerNonce: 0,
  filter: 'all',
  queue: [],
  lastActiveAt: Date.now(),
  adoptPending: false,
  celebrateNonce: 0,
  inviteDismissed: readStorage(INVITE_KEY) === '1',
  homeTarget: readStorage(TARGET_KEY) === 'companion' ? 'companion' : 'new',
  openDrawer: options => set(state => ({
    drawerOpen: true,
    drawerNonce: state.drawerOpen ? state.drawerNonce : state.drawerNonce + 1,
    filter: options?.filter ?? (options?.highlight ? 'all' : state.filter),
    ...(options?.highlight ? { highlight: { taskId: options.highlight, nonce: (state.highlight?.nonce ?? 0) + 1 } } : {}),
    // 抽屉打开时便签就摆在眼前，气泡没有必要再播。
    bubble: undefined,
    queue: [],
    lastActiveAt: Date.now()
  })),
  closeDrawer: () => set({ drawerOpen: false }),
  toggleDrawer: () => set(state => state.drawerOpen
    ? { drawerOpen: false }
    : { drawerOpen: true, drawerNonce: state.drawerNonce + 1, bubble: undefined, queue: [], lastActiveAt: Date.now() }),
  setFilter: filter => set({ filter }),
  say: (text, tone = 'info', action) => set(state => {
    if (state.drawerOpen) return {};
    const bubble: CompanionBubble = { id: ++bubbleSeq, text, tone, ...(action ? { action } : {}) };
    if (!state.bubble) return { bubble };
    return { queue: [...state.queue, bubble].slice(-MAX_QUEUE) };
  }),
  nextBubble: () => set(state => ({ bubble: state.queue[0], queue: state.queue.slice(1) })),
  markRecent: kind => set({ recent: { kind, at: Date.now() }, lastActiveAt: Date.now() }),
  touch: () => set({ lastActiveAt: Date.now() }),
  draftForMain: text => set(state => ({ mainDraft: { text, nonce: (state.mainDraft?.nonce ?? 0) + 1 } })),
  consumeMainDraft: () => set({ mainDraft: undefined }),
  requestAdoption: () => set({ adoptPending: true, drawerOpen: false }),
  consumeAdoption: () => set({ adoptPending: false }),
  celebrate: () => set(state => ({ celebrateNonce: state.celebrateNonce + 1, recent: { kind: 'cheer', at: Date.now() }, lastActiveAt: Date.now() })),
  dismissInvite: (dismissed = true) => {
    writeStorage(INVITE_KEY, dismissed ? '1' : null);
    set({ inviteDismissed: dismissed });
  },
  setHomeTarget: target => {
    writeStorage(TARGET_KEY, target);
    set({ homeTarget: target });
  }
}));
