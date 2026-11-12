import { useSyncExternalStore } from 'react';

/** App 级弹窗。开关状态放在模块里，而不是 App 的 useState： */
export type AppDialogKind = 'lark' | 'lark-avatar' | 'agent' | 'assistant' | 'schedule' | 'handover' | 'system-prompt' | 'archived' | 'import' | 'search' | 'share';

export interface AppDialogState {
  kind: AppDialogKind;
  /** 定时任务可以从某个会话打开：带上会话 id，由 DialogHost 解析成具体 Session。 */
  sessionId?: string;
}

/**
 * 弹窗开关放在 App 之外。
 *
 * 这些状态以前都在 App 里。点「定时任务」会 setState，React 于是重渲染整棵 App
 * （会话列表 + 当前时间线），再挂弹窗——实测打开一个轻量归档弹窗都有 56ms 长帧，
 * 定时任务 83ms。移动端 CPU 更慢，这段时间就是「点了没反应」。
 *
 * 现在入口只改这个 store，订阅它的 DialogHost 单独重渲染；App 的会话树不动。
 * 弹窗内容再用 DeferredMount 分两帧挂载，外壳可以先上屏并可交互。
 */
let active: AppDialogState | null = null;
const listeners = new Set<() => void>();

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
};
const getSnapshot = () => active;

export function openAppDialog(kind: AppDialogKind, options?: { sessionId?: string }) {
  if (active?.kind === kind && active.sessionId === options?.sessionId) return;
  // 每次打开都换新对象；订阅者用 useSyncExternalStore，引用变化即重渲染。
  active = { kind, ...(options?.sessionId ? { sessionId: options.sessionId } : {}) };
  for (const listener of listeners) listener();
}

export function closeAppDialog() {
  if (active === null) return;
  active = null;
  for (const listener of listeners) listener();
}

export function useActiveAppDialog(): AppDialogState | null {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

/** 测试与调试用：读当前打开的弹窗，不订阅。 */
export function getActiveAppDialog(): AppDialogState | null {
  return active;
}
