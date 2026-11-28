import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BUILTIN_THEMES } from '@agent-dock/agent-dock-shared';
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
    })),
    autostartStatus: vi.fn(async () => ({ supported: false, enabled: false })),
    keepAwakeStatus: vi.fn(async () => ({ supported: false, enabled: false, keepDisplay: false }))
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
vi.mock('./SelfUpdateNotice', () => ({ SelfUpdateNotice: () => null, SelfUpdateWatcher: () => null }));
vi.mock('./AutostartToggle', () => ({ AutostartToggle: () => null }));
vi.mock('./KeepAwakeToggle', () => ({ KeepAwakeToggle: () => null }));
vi.mock('./ThemeToggle', () => ({ ThemeSegmented: () => null, QuickThemeToggleButton: () => null }));
vi.mock('./useModalFocusTrap', () => ({ useModalFocusTrap: () => undefined }));
vi.mock('./theme', () => ({
  useThemeMode: () => 'system',
  useResolvedTheme: () => 'light',
  useActiveTheme: () => BUILTIN_THEMES[0]!,
  useThemesState: () => ({
    themes: BUILTIN_THEMES,
    preferences: { modePreference: 'system', activeThemeId: BUILTIN_THEMES[0]!.id, activeLightThemeId: BUILTIN_THEMES[0]!.id, activeDarkThemeId: BUILTIN_THEMES[1]!.id },
    activeTheme: BUILTIN_THEMES[0]!,
    previewTheme: null
  }),
  setThemeMode: () => undefined
}));
vi.mock('./companion/useCompanion', () => ({
  useCompanion: () => ({
    adopted: false,
    name: '小A同学',
    mainSession: null,
    companion: null,
    counts: { needsUser: 0, planned: 0, pendingDrafts: 0, open: 0 },
    status: '',
    mood: 'curious',
    stage: 'kitten'
  })
}));

import { SettingsCenterDialog } from './settings/SettingsCenterDialog';
import { TooltipProvider } from './HoverTooltip';

const noop = () => undefined;
const baseProps = {
  webDenied: false,
  agents: [],
  sessions: [],
  archivedCount: 0,
  onClose: noop,
  onOpenSession: noop,
  onOpenMain: noop,
  onAdopt: noop,
  onOpenUsage: noop,
  onOpenArchived: noop,
  onOpenImport: noop,
  onOpenShare: noop
};

function renderSettingsCenter() {
  vi.stubGlobal('document', { body: {} });
  const queryClient = new QueryClient();
  return renderToStaticMarkup(
    createElement(QueryClientProvider, { client: queryClient },
      createElement(TooltipProvider, null, createElement(SettingsCenterDialog, baseProps))
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

describe('SettingsCenterDialog PWA install visibility', () => {
  it('shows PWA install entry in normal desktop Chrome/Edge Web browsers', () => {
    const html = renderSettingsCenter();
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
    const html = renderSettingsCenter();
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
    const html = renderSettingsCenter();
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
    const html = renderSettingsCenter();
    expect(html).not.toContain('安装为桌面应用');
    expect(html).not.toContain('>PWA<');
    expect(html).not.toContain('Chrome');
  });
});
