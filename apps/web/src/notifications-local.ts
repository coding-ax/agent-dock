import { useSyncExternalStore } from 'react';
import { create } from 'zustand';
import type { NotificationEventKind, NotificationServerConfig, NotificationStreamPayload, WebhookPreset } from './api';
import { bi } from './i18n';

export const LOCAL_NOTIFICATION_PREFS_KEY = 'agentdock:notifications-local';
export const MASKED_SECRET_SENTINEL = '__AGENTDOCK_KEEP_SECRET__';

export type NotificationSoundTheme = 'chime' | 'soft' | 'crystal';
export type NotificationPopupWhen = 'background_only' | 'inactive_session';

export interface NotificationLocalPrefs {
  systemPopup: boolean;
  popupWhen: NotificationPopupWhen;
  soundEnabled: boolean;
  soundTheme: NotificationSoundTheme;
  soundVolume: number;
  tabTitleBadge: boolean;
  sidebarUnreadDot: boolean;
  desktopBounceAndBadge: boolean;
}

export interface DesktopNotificationCapabilities {
  supported: boolean;
  platform: string;
  appId?: string;
}

export interface DesktopNotificationsApi {
  getCapabilities(): Promise<DesktopNotificationCapabilities>;
  isWindowFocused(): Promise<boolean>;
  show(payload: {
    id?: string;
    sessionId?: string;
    title: string;
    body: string;
    urgency?: 'low' | 'normal' | 'critical';
    silent?: boolean;
    badgeCount?: number;
    bounce?: boolean;
  }): Promise<{ shown: boolean; id?: string; reason?: string }>;
  setBadge(count: number): Promise<{ count: number }>;
  onClick(listener: (payload: { id?: string; sessionId?: string }) => void): number;
  offClick(id: number): void;
  onFocusChange(listener: (payload: { focused: boolean }) => void): number;
  offFocusChange(id: number): void;
}

export function desktopNotificationsApi(): DesktopNotificationsApi | undefined {
  return typeof window === 'undefined' ? undefined : window.agentdockDesktop?.notifications;
}

export const DEFAULT_SERVER_NOTIFICATION_CONFIG: NotificationServerConfig = {
  enabled: true,
  events: {
    completed: true,
    failed: true,
    waitingApproval: true
  },
  antiSpam: {
    minDurationSec: 10,
    coalesceWindowMs: 3000,
    remoteOnlyWhenAway: false,
    awayAfterSec: 30
  },
  scopes: {
    normalSessions: true,
    assistantSubtasks: false,
    scheduledSessions: 'failed_only'
  },
  lark: {
    enabled: false,
    mode: 'auto_handover_then_fallback',
    fallbackReceiveIdType: 'open_id',
    skipOriginalLarkChat: true,
    includeSummary: true
  },
  webhooks: [],
  commandHook: {
    enabled: false,
    command: '',
    timeoutSec: 10,
    trustConfirmed: false
  }
};

export function defaultLocalNotificationPrefs(isDesktop = Boolean(desktopNotificationsApi())): NotificationLocalPrefs {
  const browserGranted = typeof Notification !== 'undefined' && Notification.permission === 'granted';
  return {
    systemPopup: isDesktop || browserGranted,
    popupWhen: 'inactive_session',
    soundEnabled: true,
    soundTheme: 'chime',
    soundVolume: 0.45,
    tabTitleBadge: true,
    sidebarUnreadDot: true,
    desktopBounceAndBadge: true
  };
}

export function normalizeLocalNotificationPrefs(
  raw: unknown,
  isDesktop = Boolean(desktopNotificationsApi())
): NotificationLocalPrefs {
  const fallback = defaultLocalNotificationPrefs(isDesktop);
  if (!raw || typeof raw !== 'object') return fallback;
  const record = raw as Partial<NotificationLocalPrefs>;
  const soundTheme: NotificationSoundTheme = record.soundTheme === 'soft' || record.soundTheme === 'crystal' ? record.soundTheme : 'chime';
  const popupWhen: NotificationPopupWhen = record.popupWhen === 'background_only' ? 'background_only' : 'inactive_session';
  const rawVolume = Number(record.soundVolume);
  const soundVolume = Number.isFinite(rawVolume) ? Math.max(0, Math.min(1, rawVolume)) : fallback.soundVolume;
  return {
    systemPopup: typeof record.systemPopup === 'boolean' ? record.systemPopup : fallback.systemPopup,
    popupWhen,
    soundEnabled: typeof record.soundEnabled === 'boolean' ? record.soundEnabled : fallback.soundEnabled,
    soundTheme,
    soundVolume,
    tabTitleBadge: typeof record.tabTitleBadge === 'boolean' ? record.tabTitleBadge : fallback.tabTitleBadge,
    sidebarUnreadDot: typeof record.sidebarUnreadDot === 'boolean' ? record.sidebarUnreadDot : fallback.sidebarUnreadDot,
    desktopBounceAndBadge: typeof record.desktopBounceAndBadge === 'boolean' ? record.desktopBounceAndBadge : fallback.desktopBounceAndBadge
  };
}

export function readLocalNotificationPrefs(storage?: Storage | null): NotificationLocalPrefs {
  const target = storage === undefined ? (typeof window !== 'undefined' ? window.localStorage : null) : storage;
  if (!target) return defaultLocalNotificationPrefs();
  try {
    const raw = target.getItem(LOCAL_NOTIFICATION_PREFS_KEY);
    if (!raw) return defaultLocalNotificationPrefs();
    return normalizeLocalNotificationPrefs(JSON.parse(raw));
  } catch {
    return defaultLocalNotificationPrefs();
  }
}

let cachedPrefs: NotificationLocalPrefs | undefined;
const prefsListeners = new Set<() => void>();

function getPrefsSnapshot(): NotificationLocalPrefs {
  cachedPrefs ??= readLocalNotificationPrefs();
  return cachedPrefs;
}

export function updateLocalNotificationPrefs(
  patch: Partial<NotificationLocalPrefs>,
  storage?: Storage | null
): NotificationLocalPrefs {
  const next = normalizeLocalNotificationPrefs({ ...getPrefsSnapshot(), ...patch });
  cachedPrefs = next;
  const target = storage === undefined ? (typeof window !== 'undefined' ? window.localStorage : null) : storage;
  try {
    target?.setItem(LOCAL_NOTIFICATION_PREFS_KEY, JSON.stringify(next));
  } catch { /* 隐私模式忽略写入失败 */ }
  for (const listener of prefsListeners) listener();
  return next;
}

export function resetLocalNotificationPrefsCache(): void {
  cachedPrefs = undefined;
}

function subscribePrefs(listener: () => void): () => void {
  prefsListeners.add(listener);
  return () => { prefsListeners.delete(listener); };
}

export function useLocalNotificationPrefs(): [NotificationLocalPrefs, (patch: Partial<NotificationLocalPrefs>) => void] {
  const prefs = useSyncExternalStore(subscribePrefs, getPrefsSnapshot, getPrefsSnapshot);
  return [prefs, patch => { updateLocalNotificationPrefs(patch); }];
}

export type BrowserNotificationEnvStatus =
  | 'desktop'
  | 'granted'
  | 'default'
  | 'denied'
  | 'insecure_http'
  | 'unsupported';

export interface BrowserNotificationEnv {
  status: BrowserNotificationEnvStatus;
  isDesktop: boolean;
  isSecureContext: boolean;
  hasNotificationApi: boolean;
  permission?: NotificationPermission;
  origin?: string;
}

export function detectBrowserNotificationEnv(input?: {
  hasDesktop?: boolean;
  isSecureContext?: boolean;
  hasNotificationApi?: boolean;
  permission?: NotificationPermission;
  origin?: string;
}): BrowserNotificationEnv {
  const isDesktop = input?.hasDesktop ?? Boolean(desktopNotificationsApi());
  const isSecureContext = input?.isSecureContext ?? (typeof window === 'undefined' ? true : window.isSecureContext !== false);
  const hasNotificationApi = input?.hasNotificationApi ?? (typeof window !== 'undefined' && typeof window.Notification === 'function');
  const origin = input?.origin ?? (typeof window !== 'undefined' ? window.location.origin : undefined);

  if (isDesktop) {
    return { status: 'desktop', isDesktop: true, isSecureContext, hasNotificationApi, origin };
  }
  if (!isSecureContext) {
    return { status: 'insecure_http', isDesktop: false, isSecureContext: false, hasNotificationApi, origin };
  }
  if (!hasNotificationApi) {
    return { status: 'unsupported', isDesktop: false, isSecureContext: true, hasNotificationApi: false, origin };
  }
  const permission = input?.permission ?? window.Notification.permission;
  const status: BrowserNotificationEnvStatus = permission === 'granted' ? 'granted' : permission === 'denied' ? 'denied' : 'default';
  return { status, isDesktop: false, isSecureContext: true, hasNotificationApi: true, permission, origin };
}

export async function requestBrowserNotificationPermission(): Promise<NotificationPermission | 'unsupported'> {
  if (typeof window === 'undefined' || typeof window.Notification !== 'function' || !window.isSecureContext) {
    return 'unsupported';
  }
  try {
    return await window.Notification.requestPermission();
  } catch {
    return window.Notification.permission;
  }
}

export interface LocalDeliveryDecision {
  markUnread: boolean;
  playSound: boolean;
  showPopup: boolean;
  updateTabTitle: boolean;
}

/**
 * 客户端本机防打扰决策：
 * - 窗口聚焦 且 正在查看该会话 → 全静默（不弹窗、不响铃、不留未读点）
 * - 窗口聚焦 但 正在看别的会话 → 留未读点 + 按 popupWhen 决定是否弹窗 + 可响提示音
 * - 窗口在后台 / 最小化 → 全套提醒（弹窗 + 声音 + 页签闪烁 + 未读点）
 */
export function evaluateLocalDelivery(input: {
  windowFocused: boolean;
  viewingSession: boolean;
  prefs: NotificationLocalPrefs;
  canShowPopup: boolean;
}): LocalDeliveryDecision {
  const activelyReading = input.windowFocused && input.viewingSession;
  if (activelyReading) {
    return { markUnread: false, playSound: false, showPopup: false, updateTabTitle: false };
  }
  const popupAllowedByTiming = input.prefs.popupWhen === 'inactive_session'
    ? !activelyReading
    : !input.windowFocused;
  return {
    markUnread: input.prefs.sidebarUnreadDot,
    playSound: input.prefs.soundEnabled && input.prefs.soundVolume > 0,
    showPopup: input.prefs.systemPopup && input.canShowPopup && popupAllowedByTiming,
    updateTabTitle: input.prefs.tabTitleBadge && !input.windowFocused
  };
}

/**
 * 轻柔克制的 Web Audio API 合成提示音（零外部音频资源依赖）。
 * 区分完成（明快上行）、失败（低沉双拍）、待审批（三音轻敲），音量温和不刺耳。
 */
let sharedAudioContext: AudioContext | null = null;

function resolveAudioContext(): AudioContext | null {
  if (typeof window === 'undefined') return null;
  const Ctor = window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Ctor) return null;
  if (!sharedAudioContext || sharedAudioContext.state === 'closed') {
    sharedAudioContext = new Ctor();
  }
  return sharedAudioContext;
}

export async function playNotificationSound(
  theme: NotificationSoundTheme,
  kind: NotificationEventKind = 'completed',
  volume = 0.45
): Promise<boolean> {
  const ctx = resolveAudioContext();
  if (!ctx) return false;
  try {
    if (ctx.state === 'suspended') await ctx.resume();
    const clampedVol = Math.max(0.02, Math.min(1, volume)) * 0.16;
    const baseTime = ctx.currentTime + 0.01;

    type Note = { freq: number; offset: number; duration: number; type: OscillatorType; gainScale?: number };
    const oscType: OscillatorType = theme === 'soft' ? 'triangle' : 'sine';

    let notes: Note[];
    if (kind === 'failed') {
      notes = theme === 'crystal'
        ? [
            { freq: 523.25, offset: 0, duration: 0.14, type: 'sine' },
            { freq: 392.0, offset: 0.12, duration: 0.24, type: 'triangle' }
          ]
        : [
            { freq: 440, offset: 0, duration: 0.14, type: oscType },
            { freq: 349.23, offset: 0.13, duration: 0.24, type: oscType }
          ];
    } else if (kind === 'waiting_approval') {
      notes = [
        { freq: 587.33, offset: 0, duration: 0.12, type: oscType },
        { freq: 783.99, offset: 0.11, duration: 0.14, type: oscType },
        { freq: 987.77, offset: 0.22, duration: 0.24, type: oscType, gainScale: 0.85 }
      ];
    } else if (theme === 'soft') {
      notes = [
        { freq: 523.25, offset: 0, duration: 0.16, type: 'triangle' },
        { freq: 659.25, offset: 0.11, duration: 0.28, type: 'triangle', gainScale: 0.9 }
      ];
    } else if (theme === 'crystal') {
      notes = [
        { freq: 880, offset: 0, duration: 0.15, type: 'sine', gainScale: 0.75 },
        { freq: 1318.5, offset: 0.09, duration: 0.32, type: 'sine', gainScale: 0.6 }
      ];
    } else {
      // chime：清脆温润的双音阶
      notes = [
        { freq: 659.25, offset: 0, duration: 0.15, type: 'sine' },
        { freq: 987.77, offset: 0.1, duration: 0.28, type: 'sine', gainScale: 0.85 }
      ];
    }

    for (const note of notes) {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = note.type;
      osc.frequency.setValueAtTime(note.freq, baseTime + note.offset);
      const peak = clampedVol * (note.gainScale ?? 1);
      gain.gain.setValueAtTime(0.0001, baseTime + note.offset);
      gain.gain.exponentialRampToValueAtTime(peak, baseTime + note.offset + 0.015);
      gain.gain.exponentialRampToValueAtTime(0.0001, baseTime + note.offset + note.duration);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(baseTime + note.offset);
      osc.stop(baseTime + note.offset + note.duration + 0.02);
    }
    return true;
  } catch {
    return false;
  }
}

/** 跨标签页防重：多个浏览器标签同时打开时，确保同一条通知只弹一次窗、只响一次声。 */
const CLAIM_PREFIX = 'agentdock:ntf-claim:';
const seenLocalEventIds = new Set<string>();
let dedupeChannel: BroadcastChannel | null = null;

function ensureDedupeChannel(): BroadcastChannel | null {
  if (typeof window === 'undefined' || typeof BroadcastChannel === 'undefined') return null;
  if (!dedupeChannel) {
    try {
      dedupeChannel = new BroadcastChannel('agentdock:notifications-dedupe');
      dedupeChannel.onmessage = event => {
        const id = typeof event.data?.id === 'string' ? event.data.id : '';
        if (id) seenLocalEventIds.add(id);
      };
    } catch {
      return null;
    }
  }
  return dedupeChannel;
}

export function claimNotificationDelivery(eventId: string): boolean {
  if (!eventId) return true;
  if (seenLocalEventIds.has(eventId)) return false;
  seenLocalEventIds.add(eventId);
  if (seenLocalEventIds.size > 300) {
    const first = seenLocalEventIds.values().next().value;
    if (first) seenLocalEventIds.delete(first);
  }

  // localStorage 原子抢占（同源多标签）
  try {
    if (typeof window !== 'undefined' && window.localStorage) {
      const key = `${CLAIM_PREFIX}${eventId}`;
      if (window.localStorage.getItem(key)) return false;
      window.localStorage.setItem(key, String(Date.now()));
      // 延时清理防膨胀
      window.setTimeout(() => {
        try { window.localStorage.removeItem(key); } catch { /* ignore */ }
      }, 30_000);
    }
  } catch { /* ignore */ }

  try {
    ensureDedupeChannel()?.postMessage({ id: eventId });
  } catch { /* ignore */ }
  return true;
}

export interface UnreadSessionNotification {
  sessionId: string;
  kind: NotificationEventKind;
  at: string;
  title?: string;
  summary?: string;
}

interface UnreadStore {
  unreadBySession: Record<string, UnreadSessionNotification>;
  markUnread(item: UnreadSessionNotification): void;
  clearSession(sessionId: string): void;
  clearAll(): void;
}

export const useUnreadNotificationsStore = create<UnreadStore>(set => ({
  unreadBySession: {},
  markUnread: item => set(state => ({
    unreadBySession: { ...state.unreadBySession, [item.sessionId]: item }
  })),
  clearSession: sessionId => set(state => {
    if (!(sessionId in state.unreadBySession)) return {};
    const next = { ...state.unreadBySession };
    delete next[sessionId];
    return { unreadBySession: next };
  }),
  clearAll: () => set({ unreadBySession: {} })
}));

export function formatClientNotificationText(payload: NotificationStreamPayload): { title: string; body: string } {
  const kindLabel = payload.kind === 'waiting_approval'
    ? (payload.ask ? bi('请你拍板', 'Needs Input') : bi('等待授权', 'Approval Needed'))
    : payload.kind === 'failed'
      ? bi('运行失败', 'Failed')
      : payload.kind === 'notify'
        ? bi('发来提醒', 'Notification')
        : bi('已完成', 'Completed');
  const title = payload.batchCount && payload.batchCount > 1
    ? bi(`AgentDock · ${payload.batchCount} 项任务${kindLabel}`, `AgentDock · ${payload.batchCount} tasks ${kindLabel}`)
    : `${payload.sessionTitle || 'AgentDock'} · ${kindLabel}`;
  const dur = payload.durationMs && payload.durationMs >= 1000
    ? (payload.durationMs < 60_000 ? `${Math.round(payload.durationMs / 1000)}s` : `${Math.floor(payload.durationMs / 60_000)}m ${Math.round((payload.durationMs % 60_000) / 1000)}s`)
    : '';
  const elapsed = dur ? bi(`（用时 ${dur}）`, ` (${dur})`) : '';
  const content = payload.error || payload.summary || bi(`${payload.agentId} 本轮已结束`, `${payload.agentId} finished this turn`);
  return {
    title,
    body: `${content}${elapsed}`
  };
}

interface RawWebhookPresetMeta {
  label: string;
  labelEn: string;
  shortLabel: string;
  shortLabelEn: string;
  placeholderUrl: string;
  hint: string;
  hintEn: string;
}

const RAW_WEBHOOK_PRESET_META: Record<WebhookPreset, RawWebhookPresetMeta> = {
  generic: {
    label: '自定义 JSON',
    labelEn: 'Custom JSON',
    shortLabel: 'JSON',
    shortLabelEn: 'JSON',
    placeholderUrl: 'https://example.com/hooks/agentdock',
    hint: '发送标准 JSON（含 event、sessionId、sessionTitle、summary、durationMs、sessionUrl）。',
    hintEn: 'Sends standard JSON (event, sessionId, sessionTitle, summary, durationMs, sessionUrl).'
  },
  lark_webhook: {
    label: '飞书群机器人',
    labelEn: 'Lark Group Bot',
    shortLabel: '飞书 Webhook',
    shortLabelEn: 'Lark Webhook',
    placeholderUrl: 'https://open.feishu.cn/open-apis/bot/v2/hook/xxxxxxxx',
    hint: '无需自建应用，在飞书群设置中添加「自定义机器人」复制 Webhook 地址即可。',
    hintEn: 'No app setup required: add a Custom Bot in Lark group settings and paste its webhook URL.'
  },
  dingtalk: {
    label: '钉钉群机器人',
    labelEn: 'DingTalk Bot',
    shortLabel: '钉钉',
    shortLabelEn: 'DingTalk',
    placeholderUrl: 'https://oapi.dingtalk.com/robot/send?access_token=xxxx',
    hint: '发送 Markdown 格式卡片；若群机器人配置了关键词安全设置，请包含「AgentDock」。',
    hintEn: 'Sends Markdown cards; include "AgentDock" if keyword verification is enabled.'
  },
  wecom: {
    label: '企业微信机器人',
    labelEn: 'WeCom Bot',
    shortLabel: '企微',
    shortLabelEn: 'WeCom',
    placeholderUrl: 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=xxxx',
    hint: '在企业微信群添加群机器人后粘贴 Webhook 地址，自动发送 Markdown 摘要。',
    hintEn: 'Add a group bot in WeCom and paste the webhook URL to receive Markdown summaries.'
  },
  bark: {
    label: 'Bark (iOS)',
    labelEn: 'Bark (iOS)',
    shortLabel: 'Bark',
    shortLabelEn: 'Bark',
    placeholderUrl: 'https://api.day.app/<your-device-key>',
    hint: '直接推送到 iPhone / iPad，点击通知可跳转至 AgentDock 会话链接。',
    hintEn: 'Push directly to iPhone/iPad with a clickable link to the AgentDock session.'
  },
  ntfy: {
    label: 'ntfy',
    labelEn: 'ntfy',
    shortLabel: 'ntfy',
    shortLabelEn: 'ntfy',
    placeholderUrl: 'https://ntfy.sh/<your-topic>',
    hint: '支持自建或官方 ntfy 服务，按事件紧急度自动设置 Priority 与图标标签。',
    hintEn: 'Works with official or self-hosted ntfy; sets priority and tags automatically.'
  },
  slack: {
    label: 'Slack',
    labelEn: 'Slack',
    shortLabel: 'Slack',
    shortLabelEn: 'Slack',
    placeholderUrl: 'https://hooks.slack.com/services/T000/B000/XXXX',
    hint: '发送 Slack Incoming Webhook Block Kit 消息卡片。',
    hintEn: 'Sends Slack Incoming Webhook Block Kit cards.'
  },
  discord: {
    label: 'Discord',
    labelEn: 'Discord',
    shortLabel: 'Discord',
    shortLabelEn: 'Discord',
    placeholderUrl: 'https://discord.com/api/webhooks/000000/xxxxxx',
    hint: '发送带状态色条与耗时角标的 Discord Embed 卡片。',
    hintEn: 'Sends Discord Embed cards with status color bars and duration badges.'
  }
};

export const WEBHOOK_PRESET_META: Record<WebhookPreset, {
  label: string;
  shortLabel: string;
  placeholderUrl: string;
  hint: string;
}> = Object.fromEntries(
  (Object.entries(RAW_WEBHOOK_PRESET_META) as Array<[WebhookPreset, RawWebhookPresetMeta]>).map(([key, item]) => [
    key,
    {
      placeholderUrl: item.placeholderUrl,
      get label() { return bi(item.label, item.labelEn); },
      get shortLabel() { return bi(item.shortLabel, item.shortLabelEn); },
      get hint() { return bi(item.hint, item.hintEn); }
    }
  ])
) as Record<WebhookPreset, { label: string; shortLabel: string; placeholderUrl: string; hint: string }>;
