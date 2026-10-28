import { describe, expect, it, beforeEach } from 'vitest';
import { useDockStore, type PaneTab } from './store.js';
import { sessionPaneTab } from './pane-tab.js';

const tab = (id: string, kind: PaneTab['kind'] = 'session', sessionId = id): PaneTab => ({ id, kind, sessionId });

const state = () => useDockStore.getState();

beforeEach(() => {
  useDockStore.setState({ primarySessionId: 'main', tabs: [], paneViews: {}, activeTabId: undefined, paneOpen: false });
});

describe('openTab', () => {
  it('开新标签并激活它', () => {
    state().openTab(tab('ses_a'));
    expect(state().tabs.map(item => item.id)).toEqual(['ses_a']);
    expect(state().activeTabId).toBe('ses_a');
    expect(state().paneOpen).toBe(true);
  });

  it('同 id 再开只激活，不重复堆标签', () => {
    state().openTab(tab('ses_a'));
    state().openTab(tab('ses_b'));
    state().openTab(tab('ses_a'));
    expect(state().tabs.map(item => item.id)).toEqual(['ses_a', 'ses_b']);
    expect(state().activeTabId).toBe('ses_a');
  });

  it('同一会话可以同时开「会话」和「终端」两个标签——标签身份与会话解耦', () => {
    state().openTab(tab('session:t1', 'session', 'ses_a'));
    state().openTab({ id: 'terminal:t1', kind: 'terminal', anchorSessionId: 'ses_a' });
    expect(state().tabs).toHaveLength(2);
  });
});

describe('closeTab', () => {
  it('关掉活跃标签后接上右边相邻的一个', () => {
    state().openTab(tab('a')); state().openTab(tab('b')); state().openTab(tab('c'));
    state().activateTab('b');
    state().closeTab('b');
    expect(state().tabs.map(item => item.id)).toEqual(['a', 'c']);
    expect(state().activeTabId).toBe('c');
  });

  it('关掉最右的活跃标签就接左边一个', () => {
    state().openTab(tab('a')); state().openTab(tab('b'));
    state().activateTab('b');
    state().closeTab('b');
    expect(state().activeTabId).toBe('a');
  });

  it('关掉非活跃标签不动当前活跃项', () => {
    state().openTab(tab('a')); state().openTab(tab('b'));
    state().activateTab('b');
    state().closeTab('a');
    expect(state().activeTabId).toBe('b');
  });

  it('关掉最后一个标签后保留空副屏，供用户直接选下一种面板', () => {
    state().openTab(tab('a'));
    state().closeTab('a');
    expect(state().tabs).toEqual([]);
    expect(state().activeTabId).toBeUndefined();
    expect(state().paneOpen).toBe(true);
  });

  it('关一个不存在的 id 是空操作', () => {
    state().openTab(tab('a'));
    state().closeTab('nope');
    expect(state().tabs.map(item => item.id)).toEqual(['a']);
    expect(state().activeTabId).toBe('a');
  });
});

describe('activateTab', () => {
  it('只激活存在的标签', () => {
    state().openTab(tab('a'));
    state().activateTab('nope');
    expect(state().activeTabId).toBe('a');
  });
});

describe('closeAllTabs', () => {
  it('清空标签与活跃项', () => {
    state().openTab(tab('a')); state().openTab(tab('b'));
    state().closeAllTabs();
    expect(state().tabs).toEqual([]);
    expect(state().activeTabId).toBeUndefined();
    expect(state().paneOpen).toBe(false);
  });
});

describe('togglePane', () => {
  it('空副屏可直接打开和隐藏', () => {
    state().togglePane();
    expect(state().paneOpen).toBe(true);
    expect(state().tabs).toEqual([]);
    state().togglePane();
    expect(state().paneOpen).toBe(false);
  });

  it('隐藏副屏保留标签，重新显示仍是原标签', () => {
    state().openTab({ id: 'terminal:main', kind: 'terminal', anchorSessionId: 'main' });
    state().togglePane();
    expect(state().paneOpen).toBe(false);
    expect(state().tabs).toHaveLength(1);
    state().togglePane();
    expect(state().activeTabId).toBe('terminal:main');
  });
});

describe('主会话的副屏状态', () => {
  it('切换会话时只显示各自的标签和开关状态，切回来恢复', () => {
    state().openTab({ id: 'files:main', kind: 'files', anchorSessionId: 'main' });
    state().setSession('other');
    expect(state().tabs.filter(item => item.ownerSessionId === 'other')).toEqual([]);
    expect(state().paneOpen).toBe(false);
    expect(state().activeTabId).toBeUndefined();

    state().openTab({ id: 'terminal:other', kind: 'terminal', anchorSessionId: 'other' });
    state().togglePane();
    state().setSession('main');
    expect(state().paneOpen).toBe(true);
    expect(state().activeTabId).toBe('files:main');
    state().setSession('other');
    expect(state().paneOpen).toBe(false);
    expect(state().activeTabId).toBe('terminal:other');
    expect(state().tabs).toHaveLength(2);
  });

  it('异步创建的侧边聊天归原会话，不把当前会话的副屏弹开', () => {
    state().setSession('other');
    state().openTab({ id: 'side-chat:child', kind: 'side-chat', sessionId: 'child' }, 'main');
    expect(state().paneOpen).toBe(false);
    expect(state().tabs[0]?.ownerSessionId).toBe('main');
    state().setSession('main');
    expect(state().activeTabId).toBe('side-chat:child');
    expect(state().paneOpen).toBe(true);
  });

  it('地址栏导航只调整目标会话，保留其他会话已挂载的标签', () => {
    state().openTab({ id: 'files:main', kind: 'files', anchorSessionId: 'main' });
    state().restoreFromUrl('other', { id: 'raw:other', kind: 'raw', anchorSessionId: 'other' });
    expect(state().activeTabId).toBe('raw:other');
    state().restoreFromUrl('main');
    expect(state().paneOpen).toBe(false);
    expect(state().tabs.map(item => item.id)).toEqual(['files:main', 'raw:other']);
    state().setSession('other');
    expect(state().paneOpen).toBe(true);
  });
});

describe('把已有会话拖进副屏', () => {
  it('用会话标签打开，挂在当前主会话下', () => {
    state().openTab(sessionPaneTab('main', 'ses_side', '侧边会话'), 'main');
    expect(state().tabs).toEqual([{ id: 'session:main:ses_side', kind: 'session', sessionId: 'ses_side', title: '侧边会话', ownerSessionId: 'main' }]);
    expect(state().paneOpen).toBe(true);
    expect(state().activeTabId).toBe('session:main:ses_side');
  });

  // 拖拽入口与 URL 还原必须产出同一个 id：否则同一个会话会被开成两个标签，
  // 刷新后还会多出一个。这条是拖拽能安全接上 ?pane= 的全部理由。
  it('与地址栏还原的标签是同一个，不会重复开', () => {
    state().openTab(sessionPaneTab('main', 'ses_side', '侧边会话'), 'main');
    state().restoreFromUrl('main', { id: 'session:main:ses_side', kind: 'session', sessionId: 'ses_side', title: 'ses_side' });
    expect(state().tabs).toHaveLength(1);
  });
});

describe('renameTab', () => {
  it('按 id 回填标题，保留其他字段', () => {
    state().openTab(sessionPaneTab('main', 'ses_side', 'ses_side'), 'main');
    state().renameTab('session:main:ses_side', '侧边会话');
    expect(state().tabs[0]).toEqual({ id: 'session:main:ses_side', kind: 'session', sessionId: 'ses_side', title: '侧边会话', ownerSessionId: 'main' });
  });

  it('未知 id 不动', () => {
    state().openTab(sessionPaneTab('main', 'ses_side', 'a'), 'main');
    const before = state().tabs;
    state().renameTab('nope', 'b');
    expect(state().tabs).toBe(before);
  });

  // 回填的 effect 依赖 tabs；同值时换新数组会让它自己触发自己。
  it('标题没变时保持数组引用不变', () => {
    state().openTab(sessionPaneTab('main', 'ses_side', '侧边会话'), 'main');
    const before = state().tabs;
    state().renameTab('session:main:ses_side', '侧边会话');
    expect(state().tabs).toBe(before);
  });
});
