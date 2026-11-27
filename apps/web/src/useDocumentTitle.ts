import { useEffect } from 'react';

const BASE_TITLE = 'AgentDock';

export interface DocumentTitleUnreadOptions {
  unreadCount?: number;
  hasUrgent?: boolean;
  flashEnabled?: boolean;
}

/**
 * 把浏览器标签页标题跟着当前会话走：`<会话名> - AgentDock`，没有选中会话时回到 `AgentDock`。
 *
 * 当存在未读完成/待审批会话且启用了页签提醒时：
 * - 页面在后台时显示 `(N) <会话名> - AgentDock`，并在未开启减少动效时温和交替提示；
 * - 回到前台或清空未读后立刻恢复原标题，绝不残留闪烁。
 */
export function useDocumentTitle(sessionLabel?: string, unread?: DocumentTitleUnreadOptions) {
  const unreadCount = unread?.unreadCount ?? 0;
  const hasUrgent = unread?.hasUrgent === true;
  const flashEnabled = unread?.flashEnabled === true;

  useEffect(() => {
    const base = sessionLabel ? `${sessionLabel} - ${BASE_TITLE}` : BASE_TITLE;
    if (!flashEnabled || unreadCount <= 0) {
      document.title = base;
      return;
    }

    const withCount = `(${unreadCount}) ${base}`;
    const alertBanner = hasUrgent
      ? `(${unreadCount}) 需要你处理 - ${BASE_TITLE}`
      : `(${unreadCount}) 任务已完成 - ${BASE_TITLE}`;
    const reducedMotion = typeof window !== 'undefined'
      && typeof window.matchMedia === 'function'
      && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    let showBanner = false;
    let timer: number | undefined;

    const sync = () => {
      const hidden = typeof document !== 'undefined' && document.visibilityState === 'hidden';
      if (!hidden) {
        if (timer !== undefined) { window.clearInterval(timer); timer = undefined; }
        document.title = withCount;
        return;
      }
      document.title = showBanner ? alertBanner : withCount;
      if (!reducedMotion && timer === undefined) {
        timer = window.setInterval(() => {
          showBanner = !showBanner;
          document.title = showBanner ? alertBanner : withCount;
        }, 1_600);
      }
    };

    sync();
    document.addEventListener('visibilitychange', sync);
    return () => {
      document.removeEventListener('visibilitychange', sync);
      if (timer !== undefined) window.clearInterval(timer);
      document.title = base;
    };
  }, [sessionLabel, unreadCount, hasUrgent, flashEnabled]);
}
