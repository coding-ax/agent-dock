import type { PaneTab } from './store';

/**
 * 会话标签的 id 生成。
 *
 * **格式是硬约定**：`App.tsx` 的 URL 还原（`?pane=<sessionId>`）用的就是这个格式，
 * 而 `openTab` 按 `tab.id` 严格去重（store.ts）。拖拽入口与 URL 还原必须产出一模一样的 id，
 * 否则同一个会话会被开成两个标签、刷新后还会多出一个。所以两侧共用本函数，不各写一遍。
 */
export function sessionPaneTab(primaryId: string, sessionId: string, title?: string): PaneTab {
  return { id: `session:${primaryId}:${sessionId}`, kind: 'session', sessionId, title };
}
