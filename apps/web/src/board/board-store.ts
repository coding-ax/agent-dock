import { create } from 'zustand';
import type { KittenMood } from '../companion/kitten-moods';
import type { MentionedBoardCard } from './board-utils';

const ACTIVE_BOARD_STORAGE_KEY = 'agentdock:last-active-board-id';
const MOBILE_COLUMN_STORAGE_KEY = 'agentdock:board-mobile-col';

function readStoredBoardId(): string | undefined {
  try {
    const val = window.localStorage.getItem(ACTIVE_BOARD_STORAGE_KEY)?.trim();
    return val || undefined;
  } catch {
    return undefined;
  }
}

function writeStoredBoardId(id?: string) {
  try {
    if (id) window.localStorage.setItem(ACTIVE_BOARD_STORAGE_KEY, id);
    else window.localStorage.removeItem(ACTIVE_BOARD_STORAGE_KEY);
  } catch {
    /* ignore */
  }
}

function readStoredMobileColumns(): Record<string, string> {
  try {
    const raw = window.localStorage.getItem(MOBILE_COLUMN_STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function writeStoredMobileColumns(map: Record<string, string>) {
  try {
    window.localStorage.setItem(MOBILE_COLUMN_STORAGE_KEY, JSON.stringify(map));
  } catch {
    /* ignore */
  }
}

export interface TransientKittenState {
  mood: KittenMood;
  message?: string;
  expiresAt: number;
}

interface BoardStoreState {
  /** 本地记忆的上次打开的看板 ID（与服务端 default 双向同步，保证刷新/重开秒级切回） */
  lastActiveBoardId?: string;
  /** 移动端每个看板上次停留在哪一列 */
  mobileColumnByBoard: Record<string, string>;
  /** 批量选中的卡片 ID（支持批量 @小猫 或批量移列） */
  selectedCardIds: string[];
  /** 已投喂进主小猫指令 Dock 的卡片芯片 */
  dockMentionCards: MentionedBoardCard[];
  /** 当前右侧滑出详情抽屉正在查看的卡片 ID */
  drawerCardId?: string;
  /** 看板内并排展开的主小猫对话面板 */
  kittenChatOpen: boolean;
  /** 小猫瞬态反应（拖卡投喂 / CLI 整理看板 / 验收庆祝等） */
  transientKitten: TransientKittenState | null;
  /** 递增触发小猫庆祝跳动 + 爱心特效 */
  celebrateNonce: number;
  /** 刚落位的卡片 ID（触发柔和落位光晕） */
  recentlyLandedId?: string;
  /** 最近一次小猫/CLI 后台整理提示条 */
  tidyBanner?: { text: string; at: number };
  /** 本客户端刚发出的 mutationId，防止 SSE 回声重复拉取 */
  ownMutationIds: string[];

  setLastActiveBoardId(id?: string): void;
  setMobileColumn(boardId: string, columnId: string): void;
  toggleCardSelected(cardId: string): void;
  clearSelectedCards(): void;
  addDockMentionCard(card: MentionedBoardCard): void;
  setDockMentionCards(cards: MentionedBoardCard[]): void;
  removeDockMentionCard(cardId: string): void;
  clearDockMentionCards(): void;
  openDrawerCard(cardId?: string): void;
  setKittenChatOpen(open: boolean): void;
  toggleKittenChat(): void;
  flashKitten(mood: KittenMood, message?: string, durationMs?: number): void;
  triggerCelebrate(message?: string): void;
  markCardLanded(cardId: string): void;
  showTidyBanner(text: string): void;
  recordOwnMutation(id: string): void;
  consumeOwnMutation(id?: string): boolean;
}

let landedTimer: number | undefined;
let tidyTimer: number | undefined;
let kittenTimer: number | undefined;

export const useBoardStore = create<BoardStoreState>((set, get) => ({
  lastActiveBoardId: readStoredBoardId(),
  mobileColumnByBoard: readStoredMobileColumns(),
  selectedCardIds: [],
  dockMentionCards: [],
  drawerCardId: undefined,
  kittenChatOpen: false,
  transientKitten: null,
  celebrateNonce: 0,
  recentlyLandedId: undefined,
  tidyBanner: undefined,
  ownMutationIds: [],

  setLastActiveBoardId: id => {
    writeStoredBoardId(id);
    set({ lastActiveBoardId: id });
  },

  setMobileColumn: (boardId, columnId) => set(state => {
    const next = { ...state.mobileColumnByBoard, [boardId]: columnId };
    writeStoredMobileColumns(next);
    return { mobileColumnByBoard: next };
  }),

  toggleCardSelected: cardId => set(state => {
    const exists = state.selectedCardIds.includes(cardId);
    return {
      selectedCardIds: exists
        ? state.selectedCardIds.filter(id => id !== cardId)
        : [...state.selectedCardIds, cardId]
    };
  }),

  clearSelectedCards: () => set({ selectedCardIds: [] }),

  addDockMentionCard: card => set(state => {
    if (state.dockMentionCards.some(item => item.id === card.id)) return state;
    return { dockMentionCards: [...state.dockMentionCards, card] };
  }),

  setDockMentionCards: cards => set({ dockMentionCards: cards }),

  removeDockMentionCard: cardId => set(state => ({
    dockMentionCards: state.dockMentionCards.filter(item => item.id !== cardId)
  })),

  clearDockMentionCards: () => set({ dockMentionCards: [] }),

  openDrawerCard: cardId => set({ drawerCardId: cardId }),

  setKittenChatOpen: open => set({ kittenChatOpen: open }),

  toggleKittenChat: () => set(state => ({ kittenChatOpen: !state.kittenChatOpen })),

  flashKitten: (mood, message, durationMs = 3_600) => {
    window.clearTimeout(kittenTimer);
    const expiresAt = Date.now() + durationMs;
    set({ transientKitten: { mood, ...(message ? { message } : {}), expiresAt } });
    kittenTimer = window.setTimeout(() => {
      const cur = get().transientKitten;
      if (cur && cur.expiresAt <= Date.now()) set({ transientKitten: null });
    }, durationMs + 50);
  },

  triggerCelebrate: message => {
    window.clearTimeout(kittenTimer);
    const expiresAt = Date.now() + 4_200;
    set(state => ({
      celebrateNonce: state.celebrateNonce + 1,
      transientKitten: { mood: 'celebrating', ...(message ? { message } : {}), expiresAt }
    }));
    kittenTimer = window.setTimeout(() => {
      const cur = get().transientKitten;
      if (cur && cur.expiresAt <= Date.now()) set({ transientKitten: null });
    }, 4_250);
  },

  markCardLanded: cardId => {
    window.clearTimeout(landedTimer);
    set({ recentlyLandedId: cardId });
    landedTimer = window.setTimeout(() => {
      if (get().recentlyLandedId === cardId) set({ recentlyLandedId: undefined });
    }, 900);
  },

  showTidyBanner: text => {
    window.clearTimeout(tidyTimer);
    const at = Date.now();
    set({ tidyBanner: { text, at } });
    tidyTimer = window.setTimeout(() => {
      if (get().tidyBanner?.at === at) set({ tidyBanner: undefined });
    }, 4_000);
  },

  recordOwnMutation: id => set(state => ({
    ownMutationIds: [...state.ownMutationIds.slice(-30), id]
  })),

  consumeOwnMutation: id => {
    if (!id) return false;
    const list = get().ownMutationIds;
    if (!list.includes(id)) return false;
    set({ ownMutationIds: list.filter(item => item !== id) });
    return true;
  }
}));

export function nextClientMutationId(): string {
  const id = `mut_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  useBoardStore.getState().recordOwnMutation(id);
  return id;
}
