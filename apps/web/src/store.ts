import { create } from 'zustand';

export type PaneKind = 'primary' | 'secondary';

/**
 * 右栏面板的标签类型。
 *
 * 终端与文件都**不是**会话——但服务端把它们划成了会话的子资源
 * （终端 WS 路径是 /api/sessions/:id/terminal、pty 的 cwd 取自会话；fs 路由同样挂在
 * /api/sessions/:id/fs 下并用会话 cwd 做 realpath 收敛，见 fs-paths.ts）。
 * 所以这两种标签靠 anchorSessionId 锚定一个会话，自己不持有会话。
 */
export type PaneTabKind = 'session' | 'terminal' | 'side-chat' | 'files' | 'raw';

export interface PaneTab {
  /** 标签自身身份，与 sessionId 解耦——同一个会话可以同时开「会话」和「终端」两个标签。 */
  id: string;
  kind: PaneTabKind;
  /** 这个标签所属的主会话；切换主会话时只显示该会话自己的标签。 */
  ownerSessionId?: string;
  /** session / side-chat 的会话 id。 */
  sessionId?: string;
  /** terminal / files 锚定的会话 id（服务端按会话划授权面，见上）。 */
  anchorSessionId?: string;
  /** 标签上显示的名字。 */
  title?: string;
  /** Markdown link target for a file preview tab. */
  filePath?: string;
}

interface PaneView {
  paneOpen: boolean;
  activeTabId?: string;
}

const paneKey = (id?: string) => id ?? '';
const emptyPane: PaneView = { paneOpen: false };

type Store = {
  primarySessionId?: string;
  /** 所有会话的右栏标签，保留挂载以维持终端连接。 */
  tabs: PaneTab[];
  paneViews: Record<string, PaneView>;
  /** 副屏显示状态与标签生命周期分离：隐藏时保留终端等已挂载内容。 */
  paneOpen: boolean;
  activeTabId?: string;
  setSession(id?: string): void;
  /** 开一个标签并激活它。同 id 已存在时只激活，不重复开。 */
  openTab(tab: PaneTab, ownerSessionId?: string): void;
  closeTab(id: string): void;
  activateTab(id: string): void;
  /**
   * 回填会话类标签的标题。会话标签的标题应该来自会话本身，但 URL 还原时会话数据还没到，
   * 只能先拿会话 id 兜底；数据到位后由调用方回填。
   * 注意是原地替换数组里的对象：调用方按 `tabs.filter` 派生视图，换新对象会破坏对象同一性。
   */
  renameTab(id: string, title: string): void;
  closeAllTabs(): void;
  togglePane(): void;
  /** 地址栏导航只覆盖目标会话的显示状态，不清空其他会话的标签。 */
  restoreFromUrl(id?: string, tab?: PaneTab): void;
};

export const useDockStore = create<Store>(set => ({
  primarySessionId: undefined,
  tabs: [],
  paneViews: {},
  paneOpen: false,
  activeTabId: undefined,
  setSession: id => set(state => {
    const view = state.paneViews[paneKey(id)] ?? emptyPane;
    return { primarySessionId: id, paneOpen: view.paneOpen, activeTabId: view.activeTabId };
  }),
  openTab: (tab, ownerSessionId) => set(state => {
    const owner = ownerSessionId ?? tab.ownerSessionId ?? state.primarySessionId;
    const key = paneKey(owner);
    const ownedTab = { ...tab, ownerSessionId: owner };
    const tabs = state.tabs.some(item => item.id === tab.id) ? state.tabs : [...state.tabs, ownedTab];
    const view: PaneView = { paneOpen: true, activeTabId: tab.id };
    return { tabs, paneViews: { ...state.paneViews, [key]: view }, ...(owner === state.primarySessionId ? view : {}) };
  }),
  closeTab: id => set(state => {
    const tab = state.tabs.find(item => item.id === id);
    if (!tab) return {};
    const owner = tab.ownerSessionId;
    const ownedTabs = state.tabs.filter(item => item.ownerSessionId === owner);
    const index = ownedTabs.findIndex(item => item.id === id);
    const siblings = ownedTabs.filter(item => item.id !== id);
    const tabs = state.tabs.filter(item => item.id !== id);
    const previous = state.paneViews[paneKey(owner)] ?? emptyPane;
    // 关掉活跃标签后接上相邻的一个（优先右边，没有就左边），否则右栏会空着但标签还在。
    const view = { ...previous, activeTabId: previous.activeTabId === id ? (siblings[index] ?? siblings[index - 1])?.id : previous.activeTabId };
    return { tabs, paneViews: { ...state.paneViews, [paneKey(owner)]: view }, ...(owner === state.primarySessionId ? view : {}) };
  }),
  activateTab: id => set(state => {
    if (!state.tabs.some(tab => tab.id === id && tab.ownerSessionId === state.primarySessionId)) return {};
    const view = { ...(state.paneViews[paneKey(state.primarySessionId)] ?? emptyPane), activeTabId: id };
    return { activeTabId: id, paneViews: { ...state.paneViews, [paneKey(state.primarySessionId)]: view } };
  }),
  renameTab: (id, title) => set(state => {
    const index = state.tabs.findIndex(tab => tab.id === id);
    // 同值直接返回空 patch：调用方的 effect 依赖 tabs，无谓的新数组会来回触发。
    if (index < 0 || state.tabs[index]!.title === title) return {};
    const tabs = [...state.tabs];
    tabs[index] = { ...tabs[index]!, title };
    return { tabs };
  }),
  closeAllTabs: () => set(state => {
    const view = emptyPane;
    return { tabs: state.tabs.filter(tab => tab.ownerSessionId !== state.primarySessionId), ...view, activeTabId: undefined, paneViews: { ...state.paneViews, [paneKey(state.primarySessionId)]: view } };
  }),
  togglePane: () => set(state => {
    const view = { ...(state.paneViews[paneKey(state.primarySessionId)] ?? emptyPane), paneOpen: !state.paneOpen };
    return { paneOpen: view.paneOpen, paneViews: { ...state.paneViews, [paneKey(state.primarySessionId)]: view } };
  }),
  restoreFromUrl: (id, tab) => set(state => {
    const key = paneKey(id);
    const tabs = tab && !state.tabs.some(item => item.id === tab.id) ? [...state.tabs, { ...tab, ownerSessionId: id }] : state.tabs;
    const view: PaneView = { paneOpen: Boolean(tab), activeTabId: tab?.id ?? state.paneViews[key]?.activeTabId };
    return { primarySessionId: id, tabs, paneViews: { ...state.paneViews, [key]: view }, paneOpen: view.paneOpen, activeTabId: view.activeTabId };
  })
}));
