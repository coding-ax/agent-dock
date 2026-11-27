import { useEffect, useRef } from 'react';
import { useMemoizedFn } from 'ahooks';
import { api, type NotificationStreamPayload } from './api';
import {
  claimNotificationDelivery,
  desktopNotificationsApi,
  detectBrowserNotificationEnv,
  evaluateLocalDelivery,
  formatClientNotificationText,
  playNotificationSound,
  readLocalNotificationPrefs,
  useUnreadNotificationsStore
} from './notifications-local';

const CLIENT_ID_KEY = 'agentdock:notify-client-id';

function getOrCreateClientId(): string {
  try {
    const existing = window.sessionStorage.getItem(CLIENT_ID_KEY);
    if (existing) return existing;
    const next = `cli_${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36)}`;
    window.sessionStorage.setItem(CLIENT_ID_KEY, next);
    return next;
  } catch {
    return `cli_${Math.random().toString(36).slice(2, 10)}`;
  }
}

/**
 * 全局通知消费中心（挂载在 App 根部）：
 * 1. 订阅轻量 SSE `/api/notifications/stream`；
 * 2. 结合 Electron / 浏览器窗口焦点与当前阅读会话执行防打扰抑制；
 * 3. 自动互斥：桌面客户端走 Electron 原生 Notification，浏览器走 Web Notification + 提示音；
 * 4. 点击通知拉起窗口并精准切换到对应会话；
 * 5. 向服务端上报聚焦心跳，支撑「仅离开电脑时再推飞书 / Webhook」。
 */
export function useNotificationCenter(options: {
  enabled: boolean;
  primarySessionId?: string;
  secondaryActiveSessionId?: string;
  onNavigateSession(sessionId: string): void;
}) {
  const { enabled, primarySessionId, secondaryActiveSessionId, onNavigateSession } = options;
  const navigate = useMemoizedFn(onNavigateSession);
  const desktopFocusedRef = useRef<boolean | undefined>(undefined);
  const viewRef = useRef({ primarySessionId, secondaryActiveSessionId });
  viewRef.current = { primarySessionId, secondaryActiveSessionId };

  // 查看会话或回到窗口时，立刻清除该会话的未读红点与 Dock 角标
  useEffect(() => {
    const clearVisible = () => {
      const visible = typeof document !== 'undefined' && document.visibilityState === 'visible' && document.hasFocus();
      const desktopFocused = desktopFocusedRef.current;
      if (desktopFocused === false || (!desktopFocused && !visible)) return;
      const store = useUnreadNotificationsStore.getState();
      if (viewRef.current.primarySessionId) store.clearSession(viewRef.current.primarySessionId);
      if (viewRef.current.secondaryActiveSessionId) store.clearSession(viewRef.current.secondaryActiveSessionId);
      const remaining = Object.keys(useUnreadNotificationsStore.getState().unreadBySession).length;
      void desktopNotificationsApi()?.setBadge(remaining).catch(() => undefined);
    };
    clearVisible();
    window.addEventListener('focus', clearVisible);
    document.addEventListener('visibilitychange', clearVisible);
    return () => {
      window.removeEventListener('focus', clearVisible);
      document.removeEventListener('visibilitychange', clearVisible);
    };
  }, [primarySessionId, secondaryActiveSessionId]);

  // 订阅 Electron 通知点击与焦点事件、Service Worker 通知点击
  useEffect(() => {
    const desktop = desktopNotificationsApi();
    let clickId: number | undefined;
    let focusId: number | undefined;
    if (desktop) {
      void desktop.isWindowFocused().then(focused => { desktopFocusedRef.current = focused; }).catch(() => undefined);
      clickId = desktop.onClick(payload => {
        if (payload.sessionId) {
          useUnreadNotificationsStore.getState().clearSession(payload.sessionId);
          navigate(payload.sessionId);
        }
      });
      focusId = desktop.onFocusChange(payload => {
        desktopFocusedRef.current = payload.focused;
        if (payload.focused) {
          const store = useUnreadNotificationsStore.getState();
          if (viewRef.current.primarySessionId) store.clearSession(viewRef.current.primarySessionId);
          if (viewRef.current.secondaryActiveSessionId) store.clearSession(viewRef.current.secondaryActiveSessionId);
          const remaining = Object.keys(useUnreadNotificationsStore.getState().unreadBySession).length;
          void desktop.setBadge(remaining).catch(() => undefined);
        }
      });
    }

    const onSwMessage = (event: MessageEvent) => {
      if (event.data?.type === 'agentdock:notification-click' && typeof event.data.sessionId === 'string') {
        useUnreadNotificationsStore.getState().clearSession(event.data.sessionId);
        navigate(event.data.sessionId);
      }
    };
    navigator.serviceWorker?.addEventListener('message', onSwMessage);

    return () => {
      if (desktop && clickId !== undefined) desktop.offClick(clickId);
      if (desktop && focusId !== undefined) desktop.offFocusChange(focusId);
      navigator.serviceWorker?.removeEventListener('message', onSwMessage);
    };
  }, [navigate]);

  // 周期性上报活跃心跳（供服务端「仅离开电脑时推远程」使用）
  useEffect(() => {
    if (!enabled) return;
    const clientId = getOrCreateClientId();
    const report = (focusedOverride?: boolean) => {
      const focused = focusedOverride ?? (
        desktopFocusedRef.current ?? (document.visibilityState === 'visible' && document.hasFocus())
      );
      void api.reportNotificationPresence({
        clientId,
        focused,
        ...(viewRef.current.primarySessionId ? { activeSessionId: viewRef.current.primarySessionId } : {})
      });
    };
    report();
    const timer = window.setInterval(() => report(), 15_000);
    const onFocus = () => report(true);
    const onBlur = () => report(false);
    const onVisibility = () => report(document.visibilityState === 'visible' && document.hasFocus());
    window.addEventListener('focus', onFocus);
    window.addEventListener('blur', onBlur);
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener('focus', onFocus);
      window.removeEventListener('blur', onBlur);
      document.removeEventListener('visibilitychange', onVisibility);
      report(false);
    };
  }, [enabled]);

  // 订阅轻量全局通知 SSE
  useEffect(() => {
    if (!enabled || typeof EventSource === 'undefined') return;
    const stream = new EventSource('/api/notifications/stream');
    const closeOnDenied = () => stream.close();
    window.addEventListener('agentdock:web-access-denied', closeOnDenied);

    const handleNotification = async (rawEvent: MessageEvent<string>) => {
      if (typeof rawEvent.data !== 'string' || !rawEvent.data) return;
      let payload: NotificationStreamPayload;
      try { payload = JSON.parse(rawEvent.data) as NotificationStreamPayload; }
      catch { return; }

      const prefs = readLocalNotificationPrefs();
      const desktop = desktopNotificationsApi();
      const windowFocused = desktop
        ? await desktop.isWindowFocused().catch(() => document.visibilityState === 'visible' && document.hasFocus())
        : (document.visibilityState === 'visible' && document.hasFocus());
      const viewingSession = Boolean(payload.sessionId)
        && (viewRef.current.primarySessionId === payload.sessionId || viewRef.current.secondaryActiveSessionId === payload.sessionId);

      const env = detectBrowserNotificationEnv();
      const canShowPopup = env.status === 'desktop' || env.status === 'granted';
      const decision = evaluateLocalDelivery({ windowFocused, viewingSession, prefs, canShowPopup });

      if (decision.markUnread && payload.sessionId) {
        useUnreadNotificationsStore.getState().markUnread({
          sessionId: payload.sessionId,
          kind: payload.kind,
          at: payload.timestamp,
          title: payload.sessionTitle,
          summary: payload.error || payload.summary
        });
      }

      const unreadCount = Object.keys(useUnreadNotificationsStore.getState().unreadBySession).length;
      if (desktop && prefs.desktopBounceAndBadge && !windowFocused) {
        void desktop.setBadge(unreadCount).catch(() => undefined);
      }

      // 跨标签防重：多个浏览器标签页打开时只允许一个标签页发声和弹窗
      if (!claimNotificationDelivery(payload.id)) return;

      if (decision.playSound) {
        void playNotificationSound(prefs.soundTheme, payload.kind, prefs.soundVolume);
      }

      if (decision.showPopup) {
        const { title, body } = formatClientNotificationText(payload);
        if (desktop) {
          void desktop.show({
            id: payload.id,
            sessionId: payload.sessionId,
            title,
            body,
            urgency: payload.kind === 'waiting_approval' || payload.kind === 'failed' ? 'critical' : 'normal',
            // 已经由 Web Audio 播放自定义提示音时，系统弹窗保持静默避免双重响声
            silent: decision.playSound,
            badgeCount: prefs.desktopBounceAndBadge ? unreadCount : undefined,
            bounce: prefs.desktopBounceAndBadge
          }).catch(() => undefined);
        } else if (env.status === 'granted' && typeof window.Notification === 'function') {
          try {
            const notification = new window.Notification(title, {
              body,
              icon: '/pwa-192.png',
              tag: payload.sessionId ? `agentdock:${payload.sessionId}` : payload.id,
              silent: decision.playSound
            });
            notification.onclick = () => {
              window.focus();
              notification.close();
              if (payload.sessionId) {
                useUnreadNotificationsStore.getState().clearSession(payload.sessionId);
                navigate(payload.sessionId);
              }
            };
          } catch { /* 部分移动浏览器禁止页面直接 new Notification，降级静默 */ }
        }
      }
    };

    stream.addEventListener('notification', handleNotification as unknown as EventListener);
    return () => {
      window.removeEventListener('agentdock:web-access-denied', closeOnDenied);
      stream.removeEventListener('notification', handleNotification as unknown as EventListener);
      stream.close();
    };
  }, [enabled, navigate]);
}
