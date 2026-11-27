import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PwaInstallSnapshot } from './pwa-install';
import { resolvePwaInstallSnapshot } from './pwa-install';

const chromeDesktopUa = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';
const electronDefaultUa = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) AgentDock/0.3.25 Chrome/134.0.0.0 Electron/45.3.0 Safari/537.36';

let mockedDesktopUpdateApi: unknown = undefined;
let mockedPwaSnapshot: PwaInstallSnapshot = resolvePwaInstallSnapshot({
  hasElectronDesktop: false,
  standalone: false,
  userAgent: chromeDesktopUa,
  hasDeferredPrompt: true
});

vi.mock('./api', () => ({
  api: {
    selfUpdateStatus: vi.fn(async () => ({
      currentVersion: '0.3.25',
      distTag: 'latest',
      latestVersion: '0.3.25',
      updateAvailable: false,
      canUpdate: false,
      updating: false,
      runtime: 'daemon'
    }))
  }
}));
vi.mock('@tanstack/react-query', async importOriginal => ({
  ...(await importOriginal<typeof import('@tanstack/react-query')>()),
  useQuery: () => ({ data: undefined, refetch: vi.fn(), isPending: false })
}));
vi.mock('./desktop-update', async importOriginal => ({
  ...(await importOriginal<typeof import('./desktop-update')>()),
  desktopUpdateApi: () => mockedDesktopUpdateApi,
  useDesktopUpdate: () => ({ api: mockedDesktopUpdateApi, state: undefined, installing: false, check: vi.fn(), download: vi.fn(), install: vi.fn() })
}));
vi.mock('./pwa-install', async importOriginal => ({
  ...(await importOriginal<typeof import('./pwa-install')>()),
  usePwaInstall: () => mockedPwaSnapshot
}));
vi.mock('./SelfUpdateNotice', () => ({ SelfUpdateNotice: () => null }));
vi.mock('./AutostartToggle', () => ({ AutostartToggle: () => null }));
vi.mock('./KeepAwakeToggle', () => ({ KeepAwakeToggle: () => null }));
vi.mock('./ThemeToggle', () => ({ ThemeSegmented: () => null }));

import { SettingsMenu } from './SettingsMenu';
import { TooltipProvider } from './HoverTooltip';

const noop = () => undefined;
const baseProps = {
  webDenied: false,
  archivedCount: 0,
  onUsage: noop,
  onSchedule: noop,
  onArchived: noop,
  onImport: noop,
  onAgentConfig: noop,
  onSideChatConfig: noop,
  onAssistant: noop,
  onLark: noop,
  onLarkAvatar: noop,
  onShare: noop
};

function renderSettingsMenu() {
  vi.stubGlobal('document', { body: {} });
  const queryClient = new QueryClient();
  return renderToStaticMarkup(
    createElement(QueryClientProvider, { client: queryClient },
      createElement(TooltipProvider, null, createElement(SettingsMenu, baseProps))
    )
  );
}

afterEach(() => {
  mockedDesktopUpdateApi = undefined;
  mockedPwaSnapshot = resolvePwaInstallSnapshot({
    hasElectronDesktop: false,
    standalone: false,
    userAgent: chromeDesktopUa,
    hasDeferredPrompt: true
  });
});

describe('SettingsMenu PWA install visibility', () => {
  it('shows PWA install entry in normal desktop Chrome/Edge Web browsers', () => {
    const html = renderSettingsMenu();
    expect(html).toContain('安装为桌面应用');
    expect(html).toContain('>PWA<');
  });

  it('completely hides PWA / Chrome install entry when Electron preload bridge is present (even if UA has no Electron)', () => {
    mockedDesktopUpdateApi = { getState: vi.fn() };
    mockedPwaSnapshot = resolvePwaInstallSnapshot({
      hasElectronDesktop: true,
      standalone: false,
      userAgent: chromeDesktopUa,
      hasDeferredPrompt: true
    });
    const html = renderSettingsMenu();
    expect(html).not.toContain('安装为桌面应用');
    expect(html).not.toContain('>PWA<');
    expect(html).not.toContain('Chrome');
  });

  it('completely hides PWA / Chrome install entry when Electron UA is detected even without preload bridge', () => {
    mockedDesktopUpdateApi = undefined;
    mockedPwaSnapshot = resolvePwaInstallSnapshot({
      hasElectronDesktop: false,
      standalone: false,
      userAgent: electronDefaultUa,
      hasDeferredPrompt: true
    });
    const html = renderSettingsMenu();
    expect(html).not.toContain('安装为桌面应用');
    expect(html).not.toContain('>PWA<');
    expect(html).not.toContain('Chrome');
  });

  it('double-locks PWA entry off when desktopUpdate.api exists even if pwa snapshot were forced visible', () => {
    mockedDesktopUpdateApi = { getState: vi.fn() };
    mockedPwaSnapshot = {
      visible: true,
      canPrompt: true,
      installing: false,
      installed: false,
      manualHint: 'Chrome'
    };
    const html = renderSettingsMenu();
    expect(html).not.toContain('安装为桌面应用');
    expect(html).not.toContain('>PWA<');
    expect(html).not.toContain('Chrome');
  });
});
