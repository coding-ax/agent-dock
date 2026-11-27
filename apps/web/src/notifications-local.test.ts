import { beforeEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  defaultLocalNotificationPrefs,
  detectBrowserNotificationEnv,
  evaluateLocalDelivery,
  formatClientNotificationText,
  LOCAL_NOTIFICATION_PREFS_KEY,
  normalizeLocalNotificationPrefs,
  readLocalNotificationPrefs,
  resetLocalNotificationPrefsCache,
  updateLocalNotificationPrefs,
  useUnreadNotificationsStore
} from './notifications-local';

function createMemoryStorage(): Storage {
  const map = new Map<string, string>();
  return {
    get length() { return map.size; },
    clear() { map.clear(); },
    getItem(key: string) { return map.get(key) ?? null; },
    key(index: number) { return [...map.keys()][index] ?? null; },
    removeItem(key: string) { map.delete(key); },
    setItem(key: string, value: string) { map.set(key, String(value)); }
  };
}

describe('notifications-local: 本机偏好、降级检测与防打扰矩阵', () => {
  beforeEach(() => {
    resetLocalNotificationPrefsCache();
    useUnreadNotificationsStore.getState().clearAll();
  });

  it('正确读写与归一化 localStorage 偏好，损坏 JSON 安全回退默认值', () => {
    const storage = createMemoryStorage();
    expect(readLocalNotificationPrefs(storage)).toEqual(defaultLocalNotificationPrefs(false));

    storage.setItem(LOCAL_NOTIFICATION_PREFS_KEY, '{broken');
    expect(readLocalNotificationPrefs(storage)).toEqual(defaultLocalNotificationPrefs(false));

    const updated = updateLocalNotificationPrefs({
      systemPopup: true,
      soundTheme: 'crystal',
      soundVolume: 1.8, // 应被夹紧到 1
      popupWhen: 'background_only'
    }, storage);
    expect(updated.soundVolume).toBe(1);
    expect(updated.soundTheme).toBe('crystal');
    expect(updated.popupWhen).toBe('background_only');

    resetLocalNotificationPrefsCache();
    const reloaded = readLocalNotificationPrefs(storage);
    expect(reloaded.soundTheme).toBe('crystal');
    expect(reloaded.soundVolume).toBe(1);
    expect(reloaded.popupWhen).toBe('background_only');
  });

  it('准确识别桌面原生、HTTPS 浏览器权限与非 HTTPS 局域网降级场景', () => {
    expect(detectBrowserNotificationEnv({ hasDesktop: true, isSecureContext: false }).status).toBe('desktop');
    expect(detectBrowserNotificationEnv({ hasDesktop: false, isSecureContext: false, origin: 'http://192.168.1.20:4310' }).status).toBe('insecure_http');
    expect(detectBrowserNotificationEnv({ hasDesktop: false, isSecureContext: true, hasNotificationApi: false }).status).toBe('unsupported');
    expect(detectBrowserNotificationEnv({ hasDesktop: false, isSecureContext: true, hasNotificationApi: true, permission: 'granted' }).status).toBe('granted');
    expect(detectBrowserNotificationEnv({ hasDesktop: false, isSecureContext: true, hasNotificationApi: true, permission: 'default' }).status).toBe('default');
    expect(detectBrowserNotificationEnv({ hasDesktop: false, isSecureContext: true, hasNotificationApi: true, permission: 'denied' }).status).toBe('denied');
  });

  it('前台活跃查看当前会话时全静默；后台或切到其他会话时按配置精准触发', () => {
    const prefs = normalizeLocalNotificationPrefs({
      systemPopup: true,
      popupWhen: 'inactive_session',
      soundEnabled: true,
      soundVolume: 0.5,
      tabTitleBadge: true,
      sidebarUnreadDot: true
    });

    // 正在前台看着当前会话 → 全静默
    expect(evaluateLocalDelivery({
      windowFocused: true,
      viewingSession: true,
      prefs,
      canShowPopup: true
    })).toEqual({ markUnread: false, playSound: false, showPopup: false, updateTabTitle: false });

    // 前台但在看别的会话 → 未读点 + 声音 + 弹窗（inactive_session 模式）
    expect(evaluateLocalDelivery({
      windowFocused: true,
      viewingSession: false,
      prefs,
      canShowPopup: true
    })).toEqual({ markUnread: true, playSound: true, showPopup: true, updateTabTitle: false });

    // 切到 background_only → 前台看别的会话时不弹窗，保留未读点与声音
    expect(evaluateLocalDelivery({
      windowFocused: true,
      viewingSession: false,
      prefs: { ...prefs, popupWhen: 'background_only' },
      canShowPopup: true
    })).toEqual({ markUnread: true, playSound: true, showPopup: false, updateTabTitle: false });

    // 窗口在后台 → 全套提醒（弹窗 + 声音 + 页签闪烁 + 未读点）
    expect(evaluateLocalDelivery({
      windowFocused: false,
      viewingSession: true,
      prefs: { ...prefs, popupWhen: 'background_only' },
      canShowPopup: true
    })).toEqual({ markUnread: true, playSound: true, showPopup: true, updateTabTitle: true });
  });

  it('未读状态存储与通知文案格式化正确工作', () => {
    const store = useUnreadNotificationsStore.getState();
    store.markUnread({ sessionId: 's1', kind: 'completed', at: '2026-11-27T00:00:00.000Z' });
    store.markUnread({ sessionId: 's2', kind: 'waiting_approval', at: '2026-11-27T00:00:01.000Z' });
    expect(Object.keys(useUnreadNotificationsStore.getState().unreadBySession)).toEqual(['s1', 's2']);
    store.clearSession('s1');
    expect(Object.keys(useUnreadNotificationsStore.getState().unreadBySession)).toEqual(['s2']);

    const formatted = formatClientNotificationText({
      id: 'n1',
      kind: 'waiting_approval',
      sessionId: 's2',
      agentId: 'claude',
      sessionTitle: '生产部署',
      summary: '请求执行 git push',
      ask: true,
      durationMs: 12_000,
      timestamp: '2026-11-27T00:00:01.000Z'
    });
    expect(formatted.title).toContain('生产部署');
    expect(formatted.title).toContain('请你拍板');
    expect(formatted.body).toContain('12s');
  });

  it('NotificationSettingsDialog 遵守提示一致性（图标按钮不挂原生 title）', () => {
    const dir = dirname(fileURLToPath(import.meta.url));
    const source = readFileSync(join(dir, 'NotificationSettingsDialog.tsx'), 'utf8');
    const buttonTitlePattern = /<(?:button|span)[^>]*\b(?:role="button"|aria-label=)[^>]*\btitle="/g;
    expect([...source.matchAll(buttonTitlePattern)]).toEqual([]);
  });
});
