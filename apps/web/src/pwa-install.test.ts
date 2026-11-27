import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  __resetPwaInstallForTest,
  getManualInstallHint,
  getPwaInstallSnapshot,
  initPwaInstall,
  isDesktopClientEnv,
  isElectronDesktopRuntime,
  isElectronUserAgent,
  isMobileUserAgent,
  registerPwaServiceWorker,
  resolvePwaInstallSnapshot,
  triggerPwaInstall,
  type BeforeInstallPromptEvent
} from './pwa-install';

const originalWindow = globalThis.window;
const originalDocument = globalThis.document;
const chromeDesktopUa = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';
const edgeDesktopUa = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 Edg/130.0.0.0';
const electronDefaultUa = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) AgentDock/0.3.25 Chrome/134.0.0.0 Electron/45.3.0 Safari/537.36';

function createFakeWindow(options: {
  userAgent?: string;
  userAgentBrands?: Array<{ brand: string }>;
  agentdockDesktop?: unknown;
  processElectron?: string;
  standalone?: boolean;
  serviceWorkerRegister?: ReturnType<typeof vi.fn>;
} = {}) {
  const fakeWindow = new EventTarget() as EventTarget & {
    matchMedia: (query: string) => { matches: boolean; addEventListener: () => void; removeEventListener: () => void };
    navigator: {
      userAgent: string;
      standalone?: boolean;
      userAgentData?: { brands: Array<{ brand: string }> };
      serviceWorker?: { register: ReturnType<typeof vi.fn> };
    };
    location: { protocol: string; hostname: string };
    isSecureContext: boolean;
    agentdockDesktop?: unknown;
    process?: { versions?: { electron?: string } };
  };
  fakeWindow.matchMedia = () => ({ matches: Boolean(options.standalone), addEventListener: () => {}, removeEventListener: () => {} });
  fakeWindow.navigator = {
    userAgent: options.userAgent ?? chromeDesktopUa,
    ...(options.userAgentBrands ? { userAgentData: { brands: options.userAgentBrands } } : {}),
    ...(options.serviceWorkerRegister ? { serviceWorker: { register: options.serviceWorkerRegister } } : {})
  };
  fakeWindow.location = { protocol: 'http:', hostname: '127.0.0.1' };
  fakeWindow.isSecureContext = true;
  if (options.agentdockDesktop !== undefined) fakeWindow.agentdockDesktop = options.agentdockDesktop;
  if (options.processElectron) fakeWindow.process = { versions: { electron: options.processElectron } };
  return fakeWindow;
}

afterEach(() => {
  __resetPwaInstallForTest();
  if (originalWindow === undefined) delete (globalThis as { window?: unknown }).window;
  else (globalThis as { window?: unknown }).window = originalWindow;
  if (originalDocument === undefined) delete (globalThis as { document?: unknown }).document;
  else (globalThis as { document?: unknown }).document = originalDocument;
});

describe('pwa-install helpers', () => {
  it('hides install entry on Electron desktop (bridge, UA, brands, process), standalone mode, installed state, and mobile', () => {
    const chromeSnap = resolvePwaInstallSnapshot({ hasElectronDesktop: false, standalone: false, userAgent: chromeDesktopUa, hasDeferredPrompt: false });
    expect(chromeSnap.visible).toBe(true);
    expect(chromeSnap.manualHint).toContain('Chrome');

    const edgeSnap = resolvePwaInstallSnapshot({ hasElectronDesktop: false, standalone: false, userAgent: edgeDesktopUa, hasDeferredPrompt: true });
    expect(edgeSnap.visible).toBe(true);
    expect(edgeSnap.canPrompt).toBe(true);
    expect(edgeSnap.manualHint).toContain('Edge');

    // Electron 客户端（即使 UA 不含 Electron 字样，只要 preload 桥接对象存在就彻底隐藏）
    const electronBridgeSnap = resolvePwaInstallSnapshot({ hasElectronDesktop: true, standalone: false, userAgent: chromeDesktopUa, hasDeferredPrompt: true, installing: true });
    expect(electronBridgeSnap.visible).toBe(false);
    expect(electronBridgeSnap.canPrompt).toBe(false);
    expect(electronBridgeSnap.installing).toBe(false);
    expect(electronBridgeSnap.manualHint).toBe('');

    // Electron 客户端（即使 preload 未注入，只要 UA 含 Electron 或 AgentDock/ 就彻底隐藏）
    const electronUaSnap = resolvePwaInstallSnapshot({ hasElectronDesktop: false, standalone: false, userAgent: electronDefaultUa, hasDeferredPrompt: true });
    expect(electronUaSnap.visible).toBe(false);
    expect(electronUaSnap.canPrompt).toBe(false);
    expect(electronUaSnap.manualHint).toBe('');

    const customAgentDockUaSnap = resolvePwaInstallSnapshot({
      hasElectronDesktop: false,
      standalone: false,
      userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 AgentDock/0.3.25 Chrome/134.0.0.0 Safari/537.36',
      hasDeferredPrompt: true
    });
    expect(customAgentDockUaSnap.visible).toBe(false);
    expect(customAgentDockUaSnap.manualHint).toBe('');

    // process.versions.electron 或 userAgentData.brands 含 Electron 也彻底隐藏
    expect(resolvePwaInstallSnapshot({ hasElectronDesktop: false, hasProcessElectron: true, standalone: false, userAgent: chromeDesktopUa, hasDeferredPrompt: true }).visible).toBe(false);
    expect(resolvePwaInstallSnapshot({ hasElectronDesktop: false, userAgentBrands: ['Chromium', 'Electron'], standalone: false, userAgent: chromeDesktopUa, hasDeferredPrompt: true }).visible).toBe(false);

    // 已安装 / standalone / 移动端隐藏
    expect(resolvePwaInstallSnapshot({ hasElectronDesktop: false, standalone: true, userAgent: chromeDesktopUa, hasDeferredPrompt: true }).visible).toBe(false);
    expect(resolvePwaInstallSnapshot({ hasElectronDesktop: false, standalone: false, userAgent: chromeDesktopUa, hasDeferredPrompt: true, installed: true }).visible).toBe(false);
    expect(resolvePwaInstallSnapshot({ hasElectronDesktop: false, standalone: false, userAgent: chromeDesktopUa, hasDeferredPrompt: true, installing: true }).installing).toBe(true);
    expect(resolvePwaInstallSnapshot({ hasElectronDesktop: false, standalone: false, userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) Mobile/15E148', hasDeferredPrompt: true }).visible).toBe(false);
    expect(resolvePwaInstallSnapshot({ hasElectronDesktop: false, standalone: false, userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Mobile Safari/537.36', hasDeferredPrompt: true }).visible).toBe(false);
  });

  it('detects mobile and Electron user agents and omits Chrome install hint in Electron', () => {
    expect(isMobileUserAgent('Mozilla/5.0 (Linux; Android 14) Mobile')).toBe(true);
    expect(isMobileUserAgent(chromeDesktopUa)).toBe(false);
    expect(isElectronUserAgent(electronDefaultUa)).toBe(true);
    expect(isElectronUserAgent('Mozilla/5.0 Electron/45.3.0 Safari/537.36')).toBe(true);
    expect(isElectronUserAgent(chromeDesktopUa)).toBe(false);
    expect(isDesktopClientEnv({ hasElectronDesktop: false, userAgent: chromeDesktopUa })).toBe(false);
    expect(isDesktopClientEnv({ hasElectronDesktop: true, userAgent: chromeDesktopUa })).toBe(true);
    expect(isDesktopClientEnv({ hasElectronDesktop: false, userAgent: electronDefaultUa })).toBe(true);
    expect(getManualInstallHint(electronDefaultUa)).toBe('');
    expect(getManualInstallHint(chromeDesktopUa)).toContain('Chrome');
    expect(getManualInstallHint(edgeDesktopUa)).toContain('Edge');
    expect(getManualInstallHint('Mozilla/5.0 (Macintosh) Version/18.0 Safari/605.1.15')).toContain('Safari');
  });

  it('captures beforeinstallprompt, triggers native prompt, and resets after acceptance or appinstalled on desktop Web', async () => {
    const fakeWindow = createFakeWindow({ userAgent: chromeDesktopUa });
    (globalThis as { window?: unknown }).window = fakeWindow;

    initPwaInstall();
    expect(isElectronDesktopRuntime()).toBe(false);
    expect(getPwaInstallSnapshot().visible).toBe(true);
    await expect(triggerPwaInstall()).resolves.toBe('manual');

    const prompt = vi.fn(async () => {});
    const event = new Event('beforeinstallprompt', { cancelable: true }) as BeforeInstallPromptEvent;
    Object.defineProperty(event, 'prompt', { value: prompt });
    Object.defineProperty(event, 'userChoice', { value: Promise.resolve({ outcome: 'accepted', platform: 'web' }) });

    fakeWindow.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
    expect(getPwaInstallSnapshot().canPrompt).toBe(true);

    await expect(triggerPwaInstall()).resolves.toBe('accepted');
    expect(prompt).toHaveBeenCalledTimes(1);
    expect(getPwaInstallSnapshot().visible).toBe(false);
    await expect(triggerPwaInstall()).resolves.toBe('manual');

    fakeWindow.dispatchEvent(new Event('appinstalled'));
    expect(getPwaInstallSnapshot().visible).toBe(false);
  });

  it('blocks PWA install state, beforeinstallprompt, triggerPwaInstall, and SW registration in Electron runtime', async () => {
    const scenarios = [
      // 真实 Electron preload 桥接对象存在，但 UA 不含 Electron 字样
      { name: 'preload bridge without Electron UA', opts: { userAgent: chromeDesktopUa, agentdockDesktop: { update: {}, network: {}, projects: {}, notifications: {} } } },
      // UA 含 Electron（无 preload 桥接对象）
      { name: 'Electron UA without bridge', opts: { userAgent: electronDefaultUa } },
      // process.versions.electron 存在（纯 Chrome UA 且无 bridge）
      { name: 'process.versions.electron without bridge', opts: { userAgent: chromeDesktopUa, processElectron: '45.3.0' } },
      // userAgentData.brands 含 Electron（纯 Chrome UA 且无 bridge）
      { name: 'userAgentData Electron brand', opts: { userAgent: chromeDesktopUa, userAgentBrands: [{ brand: 'Chromium' }, { brand: 'Electron' }] } }
    ];

    for (const scenario of scenarios) {
      __resetPwaInstallForTest();
      const swRegister = vi.fn(async () => ({}));
      const fakeWindow = createFakeWindow({ ...scenario.opts, serviceWorkerRegister: swRegister });
      (globalThis as { window?: unknown }).window = fakeWindow;
      (globalThis as { document?: unknown }).document = { readyState: 'complete' };

      initPwaInstall();
      expect(isElectronDesktopRuntime(), scenario.name).toBe(true);
      const snap = getPwaInstallSnapshot();
      expect(snap.visible, scenario.name).toBe(false);
      expect(snap.canPrompt, scenario.name).toBe(false);
      expect(snap.manualHint, scenario.name).toBe('');

      const prompt = vi.fn(async () => {});
      const event = new Event('beforeinstallprompt', { cancelable: true }) as BeforeInstallPromptEvent;
      Object.defineProperty(event, 'prompt', { value: prompt });
      Object.defineProperty(event, 'userChoice', { value: Promise.resolve({ outcome: 'accepted', platform: 'web' }) });
      fakeWindow.dispatchEvent(event);

      expect(event.defaultPrevented, scenario.name).toBe(false);
      expect(getPwaInstallSnapshot().visible, scenario.name).toBe(false);
      expect(getPwaInstallSnapshot().canPrompt, scenario.name).toBe(false);
      await expect(triggerPwaInstall(), scenario.name).resolves.toBe('dismissed');
      expect(prompt, scenario.name).not.toHaveBeenCalled();

      registerPwaServiceWorker();
      expect(swRegister, scenario.name).not.toHaveBeenCalled();
    }
  });

  it('matches the actual global bridge key exposed by apps/desktop/src/preload.cjs', () => {
    const preloadPath = resolve(dirname(fileURLToPath(import.meta.url)), '../../desktop/src/preload.cjs');
    const preload = readFileSync(preloadPath, 'utf8');
    expect(preload).toContain("contextBridge.exposeInMainWorld('agentdockDesktop'");
  });
});
