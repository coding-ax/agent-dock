import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { TooltipProvider } from './HoverTooltip';
import { resolvePwaInstallSnapshot, type PwaInstallSnapshot } from './pwa-install';
import {
  pwaInstallTooltipLabel,
  runSidebarPwaInstallAction,
  SidebarPwaInstallButton
} from './SidebarPwaInstallButton';

const desktopChromeUa = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';
const desktopEdgeUa = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 Edg/130.0.0.0';
const electronDefaultUa = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) AgentDock/0.3.25 Chrome/134.0.0.0 Electron/45.3.0 Safari/537.36';
const sourceDir = dirname(fileURLToPath(import.meta.url));

function renderButton(pwa: PwaInstallSnapshot) {
  return renderToStaticMarkup(
    createElement(TooltipProvider, null, createElement(SidebarPwaInstallButton, { pwa }))
  );
}

describe('SidebarPwaInstallButton', () => {
  it('renders a restrained 28x28 desktop-only icon button on desktop Chrome and Edge Web browsers', () => {
    for (const userAgent of [desktopChromeUa, desktopEdgeUa]) {
      const pwa = resolvePwaInstallSnapshot({
        hasElectronDesktop: false,
        standalone: false,
        userAgent,
        hasDeferredPrompt: false
      });
      const html = renderButton(pwa);

      expect(html).toContain('data-pwa-install-shortcut="sidebar-header"');
      expect(html).toContain('aria-label="安装为桌面应用"');
      expect(html).toContain('h-7 w-7');
      expect(html).toContain('hidden');
      expect(html).toContain('md:grid');
      expect(html).toContain('<svg');
      expect(html).not.toContain('title=');
      expect(html).not.toContain('disabled=""');
    }
  });

  it('hides completely on Electron desktop (bridge without Electron UA, Electron UA, process, brands), standalone, installed, and mobile', () => {
    const hiddenCases = [
      // Electron preload 桥接对象存在、UA 已被改写成纯 Chrome
      resolvePwaInstallSnapshot({ hasElectronDesktop: true, standalone: false, userAgent: desktopChromeUa, hasDeferredPrompt: true }),
      // Electron 默认 UA（即使 preload 未注入）
      resolvePwaInstallSnapshot({ hasElectronDesktop: false, standalone: false, userAgent: electronDefaultUa, hasDeferredPrompt: true }),
      // AgentDock 桌面壳 UA（即使去掉 Electron 字样且无 bridge）
      resolvePwaInstallSnapshot({ hasElectronDesktop: false, standalone: false, userAgent: 'Mozilla/5.0 AgentDock/0.3.25 Chrome/134.0.0.0 Safari/537.36', hasDeferredPrompt: true }),
      // process.versions.electron 信号
      resolvePwaInstallSnapshot({ hasElectronDesktop: false, hasProcessElectron: true, standalone: false, userAgent: desktopChromeUa, hasDeferredPrompt: true }),
      // userAgentData.brands 信号
      resolvePwaInstallSnapshot({ hasElectronDesktop: false, userAgentBrands: ['Chromium', 'Electron'], standalone: false, userAgent: desktopChromeUa, hasDeferredPrompt: true }),
      // 已 standalone / 已安装 / 移动端
      resolvePwaInstallSnapshot({ hasElectronDesktop: false, standalone: true, userAgent: desktopChromeUa, hasDeferredPrompt: true }),
      resolvePwaInstallSnapshot({ hasElectronDesktop: false, standalone: false, userAgent: desktopChromeUa, hasDeferredPrompt: true, installed: true }),
      resolvePwaInstallSnapshot({ hasElectronDesktop: false, standalone: false, userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) Mobile/15E148', hasDeferredPrompt: true }),
      resolvePwaInstallSnapshot({ hasElectronDesktop: false, standalone: false, userAgent: 'Mozilla/5.0 (Linux; Android 14) Mobile', hasDeferredPrompt: true })
    ];

    for (const pwa of hiddenCases) {
      expect(pwa.visible).toBe(false);
      // 同时确保收起侧栏入口（pwa.visible && pwa.canPrompt）在这些场景下也 100% 隐藏
      expect(pwa.visible && pwa.canPrompt).toBe(false);
      expect(renderButton(pwa)).toBe('');
    }
  });

  it('shows loading spinner, disabled state, and installing tooltip label while waiting for confirmation', () => {
    const pwa = resolvePwaInstallSnapshot({
      hasElectronDesktop: false,
      standalone: false,
      userAgent: desktopChromeUa,
      hasDeferredPrompt: true,
      installing: true
    });
    const html = renderButton(pwa);

    expect(pwaInstallTooltipLabel({ installing: false })).toBe('安装为桌面应用');
    expect(pwaInstallTooltipLabel({ installing: true })).toBe('等待确认安装…');
    expect(html).toContain('aria-label="等待确认安装…"');
    expect(html).toContain('disabled=""');
    expect(html).toContain('role="status"');
    expect(html).toContain('aria-label="正在打开安装弹窗"');
  });

  it('triggers native prompt when available and falls back to toggling manual guide otherwise', async () => {
    const trigger = vi.fn<() => Promise<'accepted' | 'dismissed' | 'manual'>>();

    await expect(runSidebarPwaInstallAction({ canPrompt: false, installing: false }, false, trigger))
      .resolves.toEqual({ nextGuideOpen: true });
    await expect(runSidebarPwaInstallAction({ canPrompt: false, installing: false }, true, trigger))
      .resolves.toEqual({ nextGuideOpen: false });
    expect(trigger).not.toHaveBeenCalled();

    trigger.mockResolvedValueOnce('accepted');
    await expect(runSidebarPwaInstallAction({ canPrompt: true, installing: false }, false, trigger))
      .resolves.toEqual({ nextGuideOpen: false, outcome: 'accepted' });

    trigger.mockResolvedValueOnce('dismissed');
    await expect(runSidebarPwaInstallAction({ canPrompt: true, installing: false }, false, trigger))
      .resolves.toEqual({ nextGuideOpen: false, outcome: 'dismissed' });

    trigger.mockResolvedValueOnce('manual');
    await expect(runSidebarPwaInstallAction({ canPrompt: true, installing: false }, false, trigger))
      .resolves.toEqual({ nextGuideOpen: true, outcome: 'manual' });

    expect(trigger).toHaveBeenCalledTimes(3);

    await expect(runSidebarPwaInstallAction({ canPrompt: true, installing: true }, false, trigger))
      .resolves.toEqual({ nextGuideOpen: false });
    expect(trigger).toHaveBeenCalledTimes(3);
  });

  it('mounts alongside BrandLogo in App.tsx while keeping SettingsMenu and collapsed-strip PWA entries guarded', () => {
    const appSource = readFileSync(join(sourceDir, 'App.tsx'), 'utf8');
    const settingsSource = readFileSync(join(sourceDir, 'SettingsMenu.tsx'), 'utf8');
    const buttonSource = readFileSync(join(sourceDir, 'SidebarPwaInstallButton.tsx'), 'utf8');

    expect(appSource).toContain('<BrandLogo iconSize={28} wordmarkHeight={14}/>');
    expect(appSource).toContain('<SidebarPwaInstallButton pwa={pwa}/>');
    expect(appSource).toContain('pwa.visible && pwa.canPrompt');
    expect(settingsSource).toContain('!desktopUpdate.api && pwa.visible');
    expect(settingsSource).toContain('安装为桌面应用');
    expect(buttonSource).toContain("import { HoverTooltip } from './HoverTooltip'");
    expect(buttonSource).not.toMatch(/\btitle="/);
  });
});
