import { useSyncExternalStore } from 'react';

export interface BeforeInstallPromptEvent extends Event {
  readonly platforms?: string[];
  readonly userChoice: Promise<{ outcome: 'accepted' | 'dismissed'; platform: string }>;
  prompt(): Promise<void>;
}

export interface PwaInstallSnapshot {
  /** 是否在桌面端普通浏览器中展示「安装为桌面应用」入口（Electron 壳、已 standalone 运行态、移动端均隐藏）。 */
  visible: boolean;
  /** 浏览器已触发 beforeinstallprompt，可直接弹出原生安装弹窗。 */
  canPrompt: boolean;
  /** 原生安装弹窗正处于等待用户确认状态。 */
  installing: boolean;
  /** 已通过当前会话安装完成。 */
  installed: boolean;
  /** 不支持自动弹窗时的简明手工安装指引。 */
  manualHint: string;
}

export interface PwaEnvLike {
  hasElectronDesktop: boolean;
  standalone: boolean;
  userAgent: string;
  hasDeferredPrompt: boolean;
  installing?: boolean;
  installed?: boolean;
}

export function isMobileUserAgent(userAgent: string): boolean {
  return /android|iphone|ipad|ipod|mobile/i.test(userAgent);
}

export function getManualInstallHint(userAgent: string): string {
  const ua = userAgent || '';
  const isEdge = /\bEdg\//i.test(ua);
  const isChrome = /\bChrome\//i.test(ua) && !isEdge;
  const isSafari = /\bSafari\//i.test(ua) && !/\bChrome\//i.test(ua) && !/\bChromium\//i.test(ua);
  if (isChrome) return '点击 Chrome 地址栏右侧的安装图标，或打开右上角菜单 →「投放、保存和分享」→「将网页安装为应用…」。';
  if (isEdge) return '点击 Edge 地址栏右侧的应用安装图标，或打开右上角菜单 →「应用」→「将此站点安装为应用」。';
  if (isSafari) return '在 Safari 顶部菜单栏点击「文件」→「添加到程序坞…」，即可作为独立桌面应用打开。';
  return '使用 Chrome 或 Edge 打开当前页面，点击地址栏右侧的安装图标即可安装为桌面应用。';
}

export function resolvePwaInstallSnapshot(env: PwaEnvLike): PwaInstallSnapshot {
  const installed = Boolean(env.installed);
  const visible = !env.hasElectronDesktop && !env.standalone && !installed && !isMobileUserAgent(env.userAgent);
  return {
    visible,
    canPrompt: visible && env.hasDeferredPrompt,
    installing: Boolean(env.installing),
    installed,
    manualHint: getManualInstallHint(env.userAgent)
  };
}

function readStandalone(): boolean {
  if (typeof window === 'undefined') return false;
  const mediaStandalone = typeof window.matchMedia === 'function'
    && (window.matchMedia('(display-mode: standalone)').matches || window.matchMedia('(display-mode: window-controls-overlay)').matches);
  const navStandalone = Boolean((window.navigator as Navigator & { standalone?: boolean } | undefined)?.standalone);
  return mediaStandalone || navStandalone;
}

function readElectronDesktop(): boolean {
  if (typeof window === 'undefined') return false;
  return Boolean((window as Window & { agentdockDesktop?: unknown }).agentdockDesktop);
}

let deferredPrompt: BeforeInstallPromptEvent | null = null;
let installing = false;
let installed = false;
let initialized = false;
let cleanupListeners: (() => void) | undefined;
let cachedSnapshot: PwaInstallSnapshot | undefined;
const listeners = new Set<() => void>();

function computeSnapshot(): PwaInstallSnapshot {
  const userAgent = typeof navigator === 'undefined' ? '' : (navigator.userAgent ?? '');
  return resolvePwaInstallSnapshot({
    hasElectronDesktop: readElectronDesktop(),
    standalone: readStandalone(),
    userAgent,
    hasDeferredPrompt: deferredPrompt !== null,
    installing,
    installed
  });
}

function sameSnapshot(a: PwaInstallSnapshot | undefined, b: PwaInstallSnapshot): boolean {
  return Boolean(a)
    && a!.visible === b.visible
    && a!.canPrompt === b.canPrompt
    && a!.installing === b.installing
    && a!.installed === b.installed
    && a!.manualHint === b.manualHint;
}

function notify() {
  const next = computeSnapshot();
  if (sameSnapshot(cachedSnapshot, next)) return;
  cachedSnapshot = next;
  for (const listener of listeners) listener();
}

function getSnapshot(): PwaInstallSnapshot {
  const next = computeSnapshot();
  if (!sameSnapshot(cachedSnapshot, next)) cachedSnapshot = next;
  return cachedSnapshot!;
}

const serverSnapshot: PwaInstallSnapshot = {
  visible: false,
  canPrompt: false,
  installing: false,
  installed: false,
  manualHint: getManualInstallHint('')
};

export function initPwaInstall(): void {
  if (initialized || typeof window === 'undefined') return;
  initialized = true;

  const onBeforeInstallPrompt = (event: Event) => {
    const promptEvent = event as BeforeInstallPromptEvent;
    if (typeof promptEvent.prompt !== 'function') return;
    promptEvent.preventDefault();
    deferredPrompt = promptEvent;
    notify();
  };

  const onAppInstalled = () => {
    deferredPrompt = null;
    installing = false;
    installed = true;
    notify();
  };

  const media = typeof window.matchMedia === 'function' ? window.matchMedia('(display-mode: standalone)') : undefined;
  const onDisplayModeChange = () => notify();

  window.addEventListener('beforeinstallprompt', onBeforeInstallPrompt);
  window.addEventListener('appinstalled', onAppInstalled);
  media?.addEventListener?.('change', onDisplayModeChange);

  cleanupListeners = () => {
    window.removeEventListener('beforeinstallprompt', onBeforeInstallPrompt);
    window.removeEventListener('appinstalled', onAppInstalled);
    media?.removeEventListener?.('change', onDisplayModeChange);
  };
  notify();
}

export async function triggerPwaInstall(): Promise<'accepted' | 'dismissed' | 'manual'> {
  if (!deferredPrompt) return 'manual';
  const promptEvent = deferredPrompt;
  installing = true;
  notify();
  try {
    await promptEvent.prompt();
    const choice = await promptEvent.userChoice;
    deferredPrompt = null;
    if (choice.outcome === 'accepted') installed = true;
    return choice.outcome;
  } catch {
    deferredPrompt = null;
    return 'dismissed';
  } finally {
    installing = false;
    notify();
  }
}

export function registerPwaServiceWorker(): void {
  if (typeof window === 'undefined' || typeof navigator === 'undefined') return;
  if (readElectronDesktop()) return;
  if (!('serviceWorker' in navigator)) return;
  const protocol = window.location.protocol;
  const host = window.location.hostname;
  const secureContext = window.isSecureContext || protocol === 'https:' || host === 'localhost' || host === '127.0.0.1';
  if (!secureContext) return;

  const register = () => {
    navigator.serviceWorker.register('/sw.js', { scope: '/' }).catch(() => {
      // Service Worker 注册失败（如自签证书或隐私模式）不影响主界面使用。
    });
  };
  if (document.readyState === 'complete') register();
  else window.addEventListener('load', register, { once: true });
}

export function usePwaInstall(): PwaInstallSnapshot {
  initPwaInstall();
  return useSyncExternalStore(
    listener => {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    getSnapshot,
    () => serverSnapshot
  );
}

/** 仅单测用：清理模块状态与事件监听。 */
export function __resetPwaInstallForTest(): void {
  cleanupListeners?.();
  cleanupListeners = undefined;
  initialized = false;
  deferredPrompt = null;
  installing = false;
  installed = false;
  cachedSnapshot = undefined;
  listeners.clear();
}
