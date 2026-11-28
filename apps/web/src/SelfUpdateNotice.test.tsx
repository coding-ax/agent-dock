import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SelfUpdateStatus } from './api';

let currentStatus: SelfUpdateStatus = {
  currentVersion: '0.3.9',
  distTag: 'latest',
  latestVersion: '0.3.10',
  updateAvailable: true,
  canUpdate: true,
  updating: false,
  runtime: 'daemon'
};

vi.mock('./api', () => ({
  api: {
    selfUpdateStatus: vi.fn(async () => currentStatus),
    startSelfUpdate: vi.fn(async () => currentStatus)
  }
}));
// SSR 不跑 effects，直接给组件一份当前测试状态。
vi.mock('@tanstack/react-query', async importOriginal => ({
  ...(await importOriginal<typeof import('@tanstack/react-query')>()),
  useQuery: () => ({ data: currentStatus, refetch: vi.fn(), isPending: false })
}));
// 服务端渲染不支持 portal，测试里把弹窗内容直接渲染在内联位置。
vi.mock('react-dom', async importOriginal => ({
  ...(await importOriginal<typeof import('react-dom')>()),
  createPortal: (node: unknown) => node
}));
vi.mock('./Toast', () => ({
  useToast: () => ({ toast: null, show: () => undefined })
}));
vi.mock('./desktop-update', async importOriginal => ({
  ...(await importOriginal<typeof import('./desktop-update')>()),
  desktopUpdateApi: () => undefined,
  useDesktopUpdate: () => ({ api: undefined, state: undefined, installing: false, check: vi.fn(), download: vi.fn(), install: vi.fn() })
}));
vi.mock('./DesktopUpdateNotice', () => ({ DesktopUpdateNotice: () => null }));
vi.mock('./AutostartToggle', () => ({ AutostartToggle: () => null }));
vi.mock('./KeepAwakeToggle', () => ({ KeepAwakeToggle: () => null }));
vi.mock('./ThemeToggle', () => ({ ThemeSegmented: () => null, QuickThemeToggleButton: () => null }));

import { SelfUpdateNotice } from './SelfUpdateNotice';
import { SettingsMenu } from './SettingsMenu';
import { TooltipProvider } from './HoverTooltip';
import { resetSelfUpdateClientState, setSelfUpdateStarting, setSelfUpdateWatch } from './self-update-progress';

const noop = () => undefined;

function renderWithProviders(element: ReturnType<typeof createElement>) {
  vi.stubGlobal('document', { body: {} });
  const queryClient = new QueryClient();
  return renderToStaticMarkup(createElement(QueryClientProvider, { client: queryClient },
    createElement(TooltipProvider, null, element)
  ));
}

afterEach(() => {
  resetSelfUpdateClientState();
  currentStatus = {
    currentVersion: '0.3.9',
    distTag: 'latest',
    latestVersion: '0.3.10',
    updateAvailable: true,
    canUpdate: true,
    updating: false,
    runtime: 'daemon'
  };
});

describe('SelfUpdateNotice', () => {
  it('keeps the manual re-check available while an outdated update banner is visible', () => {
    const html = renderWithProviders(createElement(SelfUpdateNotice, { enabled: true }));

    expect(html).toContain('新版本');
    expect(html).toContain('0.3.10');
    // 服务端缓存可能比 npm 落后：横幅出现时也必须能手动再查一次。
    expect(html).toContain('aria-label="检查更新"');
  });

  it('switches to loading, hides upgrade button, and disables re-check while updating', () => {
    setSelfUpdateWatch({ fromVersion: '0.3.9', targetVersion: '0.3.10', startedAt: Date.now() });
    const html = renderWithProviders(createElement(SelfUpdateNotice, { enabled: true }));

    expect(html).toContain('正在升级，完成后自动刷新');
    expect(html).toContain('role="status"');
    expect(html).not.toContain('>升级</button>');
    expect(html).toContain('aria-label="检查更新" disabled=""');
  });
});

describe('SettingsMenu outer update badge sync', () => {
  const settingsProps = {
    webDenied: false,
    onOpenSettings: noop,
    onOpenLark: noop,
    onShare: noop
  };

  it('shows 有新版本 on outer trigger when an update is available and idle', () => {
    const html = renderWithProviders(createElement(SettingsMenu, settingsProps));

    expect(html).toContain('有新版本');
    expect(html).not.toContain('正在更新…');
  });

  it('syncs outer trigger to loading when client starts or watches an update, and recovers when cleared', () => {
    setSelfUpdateStarting(true);
    const startingHtml = renderWithProviders(createElement(SettingsMenu, settingsProps));
    expect(startingHtml).toContain('正在更新…');
    expect(startingHtml).toContain('aria-label="正在更新"');
    expect(startingHtml).not.toContain('有新版本');

    setSelfUpdateStarting(false);
    setSelfUpdateWatch({ fromVersion: '0.3.9', targetVersion: '0.3.10', startedAt: Date.now() });
    const watchingHtml = renderWithProviders(createElement(SettingsMenu, settingsProps));
    expect(watchingHtml).toContain('正在更新…');
    expect(watchingHtml).not.toContain('有新版本');

    // 失败或结束清除 watch 后，外层恢复到「有新版本」
    setSelfUpdateWatch(undefined);
    const recoveredHtml = renderWithProviders(createElement(SettingsMenu, settingsProps));
    expect(recoveredHtml).toContain('有新版本');
    expect(recoveredHtml).not.toContain('正在更新…');
  });

  it('syncs outer trigger to loading when server status already reports updating=true', () => {
    currentStatus = { ...currentStatus, updating: true };
    const html = renderWithProviders(createElement(SettingsMenu, settingsProps));

    expect(html).toContain('正在更新…');
    expect(html).toContain('aria-label="正在更新"');
    expect(html).not.toContain('有新版本');
  });
});
