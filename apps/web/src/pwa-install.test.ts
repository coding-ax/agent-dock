import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  __resetPwaInstallForTest,
  getManualInstallHint,
  initPwaInstall,
  isMobileUserAgent,
  resolvePwaInstallSnapshot,
  triggerPwaInstall,
  type BeforeInstallPromptEvent
} from './pwa-install';

const originalWindow = globalThis.window;

afterEach(() => {
  __resetPwaInstallForTest();
  if (originalWindow === undefined) delete (globalThis as { window?: unknown }).window;
  else (globalThis as { window?: unknown }).window = originalWindow;
});

describe('pwa-install helpers', () => {
  it('hides install entry on Electron desktop, standalone mode, installed state, and mobile', () => {
    const chromeDesktopUa = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';
    expect(resolvePwaInstallSnapshot({ hasElectronDesktop: false, standalone: false, userAgent: chromeDesktopUa, hasDeferredPrompt: false }).visible).toBe(true);
    expect(resolvePwaInstallSnapshot({ hasElectronDesktop: false, standalone: false, userAgent: chromeDesktopUa, hasDeferredPrompt: true }).canPrompt).toBe(true);
    expect(resolvePwaInstallSnapshot({ hasElectronDesktop: true, standalone: false, userAgent: chromeDesktopUa, hasDeferredPrompt: true }).visible).toBe(false);
    expect(resolvePwaInstallSnapshot({ hasElectronDesktop: false, standalone: true, userAgent: chromeDesktopUa, hasDeferredPrompt: true }).visible).toBe(false);
    expect(resolvePwaInstallSnapshot({ hasElectronDesktop: false, standalone: false, userAgent: chromeDesktopUa, hasDeferredPrompt: true, installed: true }).visible).toBe(false);
    expect(resolvePwaInstallSnapshot({ hasElectronDesktop: false, standalone: false, userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) Mobile/15E148', hasDeferredPrompt: true }).visible).toBe(false);
  });

  it('detects mobile user agents and returns browser-appropriate manual hints', () => {
    expect(isMobileUserAgent('Mozilla/5.0 (Linux; Android 14) Mobile')).toBe(true);
    expect(isMobileUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Chrome/130.0')).toBe(false);
    expect(getManualInstallHint('Mozilla/5.0 Chrome/130.0.0.0 Safari/537.36')).toContain('Chrome');
    expect(getManualInstallHint('Mozilla/5.0 Chrome/130.0.0.0 Safari/537.36 Edg/130.0.0.0')).toContain('Edge');
    expect(getManualInstallHint('Mozilla/5.0 (Macintosh) Version/18.0 Safari/605.1.15')).toContain('Safari');
  });

  it('captures beforeinstallprompt, triggers native prompt, and resets after acceptance or appinstalled', async () => {
    const fakeWindow = new EventTarget() as EventTarget & { matchMedia: () => { matches: boolean; addEventListener: () => void; removeEventListener: () => void } };
    fakeWindow.matchMedia = () => ({ matches: false, addEventListener: () => {}, removeEventListener: () => {} });
    (globalThis as { window?: unknown }).window = fakeWindow;

    initPwaInstall();
    await expect(triggerPwaInstall()).resolves.toBe('manual');

    const prompt = vi.fn(async () => {});
    const event = new Event('beforeinstallprompt', { cancelable: true }) as BeforeInstallPromptEvent;
    Object.defineProperty(event, 'prompt', { value: prompt });
    Object.defineProperty(event, 'userChoice', { value: Promise.resolve({ outcome: 'accepted', platform: 'web' }) });

    fakeWindow.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);

    await expect(triggerPwaInstall()).resolves.toBe('accepted');
    expect(prompt).toHaveBeenCalledTimes(1);
    await expect(triggerPwaInstall()).resolves.toBe('manual');

    fakeWindow.dispatchEvent(new Event('appinstalled'));
    await expect(triggerPwaInstall()).resolves.toBe('manual');
  });
});
