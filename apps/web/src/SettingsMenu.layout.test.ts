import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, expect, it, vi } from 'vitest';

import { BUILTIN_THEMES } from '@agent-dock/agent-dock-shared';
import type { LarkBotConfig } from './api';
import { DEFAULT_LARK_TURN_SYNC } from './lark-config-form';
import type { ThemeMode } from './theme';

let mockedMode: ThemeMode = 'system';

const queryValues = new Map<string, unknown>([
  ['autostart', { supported: true, enabled: true, plistPath: '/Users/me/Library/LaunchAgents/dev.agentdock.plist' }],
  ['keep-awake', { supported: true, enabled: true, keepDisplay: false }]
]);

vi.mock('./theme', () => ({
  useThemeMode: () => mockedMode,
  useResolvedTheme: () => (mockedMode === 'dark' ? 'dark' : 'light'),
  useActiveTheme: () => (mockedMode === 'dark' ? BUILTIN_THEMES[1]! : BUILTIN_THEMES[0]!),
  setThemeMode: (mode: ThemeMode) => { mockedMode = mode; }
}));

vi.mock('./api', () => ({
  api: {
    selfUpdateStatus: vi.fn(async () => ({
      currentVersion: '0.4.60',
      distTag: 'latest',
      latestVersion: '0.4.60',
      updateAvailable: false,
      canUpdate: false,
      updating: false,
      runtime: 'daemon'
    })),
    autostartStatus: vi.fn(async () => queryValues.get('autostart')),
    setAutostart: vi.fn(async () => queryValues.get('autostart')),
    keepAwakeStatus: vi.fn(async () => queryValues.get('keep-awake')),
    setKeepAwake: vi.fn(async () => queryValues.get('keep-awake'))
  }
}));

vi.mock('@tanstack/react-query', async importOriginal => ({
  ...(await importOriginal<typeof import('@tanstack/react-query')>()),
  useQuery: (opts: { queryKey?: unknown[] }) => {
    const key = Array.isArray(opts.queryKey) ? String(opts.queryKey[0]) : '';
    return { data: queryValues.get(key), refetch: vi.fn(), isPending: false };
  }
}));

vi.mock('./desktop-update', async importOriginal => ({
  ...(await importOriginal<typeof import('./desktop-update')>()),
  desktopUpdateApi: () => undefined,
  useDesktopUpdate: () => ({ api: undefined, state: undefined, installing: false, check: vi.fn(), download: vi.fn(), install: vi.fn() })
}));

vi.mock('./SelfUpdateNotice', () => ({
  SelfUpdateNotice: () => null,
  SelfUpdateWatcher: () => null
}));
vi.mock('./Toast', () => ({ useToast: () => ({ toast: null, show: () => undefined }) }));

import { AutostartToggle } from './AutostartToggle';
import { TooltipProvider } from './HoverTooltip';
import { KeepAwakeToggle } from './KeepAwakeToggle';
import { LarkQuickTriggerButton, summarizeLarkQuickEntry } from './LarkIcon';
import { SettingsMenu, settingsCenterTooltipLabel } from './SettingsMenu';
import { QuickThemeToggleButton, quickThemeTooltipLabel, ThemeSegmented } from './ThemeToggle';
import { resolveDialogKindToSettingsTarget } from './settings/settings-registry';
import { setThemeMode } from './theme';

const sourceDir = dirname(fileURLToPath(import.meta.url));
const noop = () => undefined;

function fakeBot(overrides: Partial<LarkBotConfig> = {}): LarkBotConfig {
  return {
    configured: true,
    appId: 'cli_test_bot',
    name: '测试机器人',
    tabLabel: '测试机器人',
    setupComplete: true,
    preInjectPrompt: '',
    listening: true,
    activeListening: true,
    groupToolsEnabled: false,
    groupToolsAllowSend: false,
    groupSessionScope: 'chat',
    pushIntervalMs: 1500,
    hideTraceOnComplete: false,
    quietReply: false,
    turnSync: DEFAULT_LARK_TURN_SYNC,
    allowedUsers: [],
    allowedEmails: [],
    allowedBots: [],
    peerBotsAllowed: false,
    highRiskAllowedUsers: [],
    highRiskAllowedEmails: [],
    highRiskPattern: '',
    gateEnabled: false,
    softGateEnabled: false,
    hardGateEnabled: false,
    hookTrustConfirmed: false,
    ...overrides
  };
}

function render(node: ReturnType<typeof createElement>) {
  const queryClient = new QueryClient();
  return renderToStaticMarkup(
    createElement(
      QueryClientProvider,
      { client: queryClient },
      createElement(TooltipProvider, null, node)
    )
  );
}

describe('SettingsMenu, Lark quick shortcut & Tooltip alignment', () => {
  it('renders ThemeSegmented single-line with proportional 2:3:2 columns and whitespace-nowrap across all modes', () => {
    setThemeMode('light');
    const lightHtml = render(createElement(ThemeSegmented));
    expect(lightHtml).toContain('calc(2px + (100% - 4px) * 0)');
    expect(lightHtml).toContain('calc((100% - 4px) * 2 / 7)');

    setThemeMode('system');
    const systemHtml = render(createElement(ThemeSegmented));
    expect(systemHtml).toContain('grid-cols-[minmax(0,2fr)_minmax(0,3fr)_minmax(0,2fr)]');
    expect(systemHtml).toContain('whitespace-nowrap');
    expect(systemHtml).toContain('calc(2px + (100% - 4px) * 2 / 7)');
    expect(systemHtml).toContain('calc((100% - 4px) * 3 / 7)');
    expect(systemHtml).toContain('浅色');
    expect(systemHtml).toContain('跟随系统');
    expect(systemHtml).toContain('深色');
    expect(systemHtml).not.toContain('theme-studio-quick-trigger');

    setThemeMode('dark');
    const darkHtml = render(createElement(ThemeSegmented));
    expect(darkHtml).toContain('calc(2px + (100% - 4px) * 5 / 7)');
    expect(darkHtml).toContain('calc((100% - 4px) * 2 / 7)');

    setThemeMode('system');
  });

  it('replaces the crowded 15+ item popover with Settings trigger + dedicated Lark shortcut + theme toggle + share button', () => {
    const html = render(
      createElement(SettingsMenu, {
        webDenied: false,
        larkConfig: { bots: [fakeBot()], listeningDisabled: false },
        onOpenSettings: noop,
        onOpenLark: noop,
        onShare: noop
      })
    );

    expect(html).toContain('data-testid="settings-footer-bar"');
    expect(html).toContain('data-testid="settings-center-trigger"');
    expect(html).toContain('data-testid="settings-lark-trigger"');
    expect(html).toContain('data-lark-status="online"');
    expect(html).toContain('aria-label="飞书与协同设置"');
    expect(html).toContain('bg-emerald-500');
    expect(html).toContain('aria-haspopup="dialog"');
    expect(html).toContain('data-testid="quick-theme-toggle"');
    expect(html).toContain('data-testid="settings-share-trigger"');
    expect(html).toContain('aria-label="在手机上打开"');
    expect(html).toContain('w-full min-w-0');
    expect(html).toContain('md:h-8 md:w-8');
    expect(html).not.toContain('min-w-[268px]');
    expect(html).not.toContain('title=');
    // 守卫：不再在侧栏左下角渲染 15+ 项拥挤的 role="menu" 弹出层
    expect(html).not.toContain('role="menu"');
    expect(html).not.toContain('role="menuitem"');
  });

  it('summarizes Lark quick-entry tooltip and dark-mode-safe status indicator across all bot states', () => {
    const none = summarizeLarkQuickEntry({ bots: [], listeningDisabled: false });
    expect(none.statusTone).toBe('none');
    expect(none.dotClass).toBeUndefined();
    expect(none.tooltip).toBe('飞书与协同设置（机器人、群聊正则唤起、AI 飞书替身）');

    const allOnline = summarizeLarkQuickEntry({
      bots: [fakeBot({ appId: 'cli_1', activeListening: true }), fakeBot({ appId: 'cli_2', activeListening: true })],
      listeningDisabled: false
    });
    expect(allOnline.statusTone).toBe('online');
    expect(allOnline.dotClass).toBe('bg-emerald-500');
    expect(allOnline.tooltip).toContain('2 个机器人在线');
    expect(allOnline.tooltip).toContain('群聊正则唤起');

    const partialOnline = summarizeLarkQuickEntry({
      bots: [fakeBot({ appId: 'cli_1', activeListening: true }), fakeBot({ appId: 'cli_2', activeListening: false })],
      listeningDisabled: false
    });
    expect(partialOnline.statusTone).toBe('online');
    expect(partialOnline.tooltip).toContain('1/2 个机器人在线');

    const paused = summarizeLarkQuickEntry({
      bots: [fakeBot({ appId: 'cli_1', activeListening: false })],
      listeningDisabled: true
    });
    expect(paused.statusTone).toBe('paused');
    expect(paused.dotClass).toBe('bg-amber-500');
    expect(paused.tooltip).toContain('已配置 1 个机器人，监听已暂停');

    const standby = summarizeLarkQuickEntry({
      bots: [fakeBot({ appId: 'cli_1', activeListening: false })],
      listeningDisabled: false
    });
    expect(standby.statusTone).toBe('configured');
    expect(standby.dotClass).toBe('bg-sky-500');
    expect(standby.tooltip).toContain('已配置 1 个机器人');

    // 未配置机器人时不展示多余指示点，保持视觉清爽；收起态 compact 模式保持 32x32 按钮尺寸
    const unconfiguredHtml = render(createElement(LarkQuickTriggerButton, {
      compact: true,
      side: 'right',
      testId: 'collapsed-lark-trigger',
      larkConfig: { bots: [], listeningDisabled: false },
      onClick: noop
    }));
    expect(unconfiguredHtml).toContain('data-testid="collapsed-lark-trigger"');
    expect(unconfiguredHtml).toContain('data-lark-status="none"');
    expect(unconfiguredHtml).toContain('h-8 w-8');
    expect(unconfiguredHtml).not.toContain('bg-emerald-500');
    expect(unconfiguredHtml).not.toContain('title=');
  });

  it('produces clear, descriptive HoverTooltip labels for Settings, Theme toggle, and Share controls', () => {
    expect(settingsCenterTooltipLabel(null)).toBe('打开设置中心（外观、Agent、小猫、飞书、通知）');
    expect(settingsCenterTooltipLabel('available')).toContain('有新版本可升级');
    expect(settingsCenterTooltipLabel('updating')).toContain('正在升级中');

    expect(quickThemeTooltipLabel('light', 'light', '默认浅色')).toBe('外观：默认浅色 · 点击切换深色');
    expect(quickThemeTooltipLabel('dark', 'dark', '默认深色')).toBe('外观：默认深色 · 点击切换浅色');
    expect(quickThemeTooltipLabel('system', 'light', '默认浅色')).toBe('外观：跟随系统（当前默认浅色） · 点击切换深色');
    expect(quickThemeTooltipLabel('dark', 'dark', 'Tokyo Night')).toBe('外观：Tokyo Night · 点击切换浅色');

    setThemeMode('light');
    const lightBtn = render(createElement(QuickThemeToggleButton));
    expect(lightBtn).toContain('aria-label="切换为深色模式"');
    expect(lightBtn).not.toContain('title=');

    setThemeMode('dark');
    const darkBtn = render(createElement(QuickThemeToggleButton));
    expect(darkBtn).toContain('aria-label="切换为浅色模式"');
    expect(darkBtn).not.toContain('title=');

    setThemeMode('system');
  });

  it('wires both expanded footer and collapsed strip Lark triggers straight to SettingsCenter lark category with full HoverTooltip coverage', () => {
    const appSource = readFileSync(join(sourceDir, 'App.tsx'), 'utf8');
    const settingsMenuSource = readFileSync(join(sourceDir, 'SettingsMenu.tsx'), 'utf8');
    const settingsDialogSource = readFileSync(join(sourceDir, 'settings', 'SettingsCenterDialog.tsx'), 'utf8');

    // 展开态与收起态均直达 openAppDialog('lark') -> SettingsCenterDialog('lark', 'bots')
    expect(appSource).toContain("onOpenLark={() => { setSidebarOpen(false); openAppDialog('lark'); }}");
    expect(appSource).toContain("onClick={() => openAppDialog('lark')} testId=\"collapsed-lark-trigger\"");
    expect(resolveDialogKindToSettingsTarget('lark')).toEqual({ category: 'lark', subTab: 'bots' });

    // 底栏全部控件包裹 HoverTooltip 且文案走 i18n 词条
    expect(settingsMenuSource).toContain('<HoverTooltip content={settingsTooltip}');
    expect(settingsMenuSource).toContain('<LarkQuickTriggerButton');
    expect(settingsMenuSource).toContain('<QuickThemeToggleButton');
    expect(settingsMenuSource).toContain("t('settings.menu.shareTooltip')");

    // 收起态细条全部右侧 HoverTooltip
    expect(appSource).toContain('data-testid="collapsed-sidebar-strip"');
    expect(appSource).toContain('<QuickThemeToggleButton compact side="right"/>');
    expect(appSource).toContain("t('settings.menu.tooltipDefault')");

    // 设置中心底部「消耗看板 / 归档」同样包裹 HoverTooltip
    expect(settingsDialogSource).toContain('data-testid="settings-footer-usage"');
    expect(settingsDialogSource).toContain('data-testid="settings-footer-archived"');
    expect(settingsDialogSource).toContain("t('settings.center.footer.usageTooltip')");
  });

  it('keeps 开机自启, 永不休眠, and 屏幕常亮 flush-left aligned with no extra left padding on 屏幕常亮', () => {
    const autostartHtml = render(createElement(AutostartToggle, { enabled: true }));
    const keepAwakeHtml = render(createElement(KeepAwakeToggle, { enabled: true }));

    expect(autostartHtml).toContain('开机自启');
    expect(keepAwakeHtml).toContain('永不休眠');
    expect(keepAwakeHtml).toContain('屏幕常亮');
    expect(keepAwakeHtml).not.toContain('pl-4');
    expect(keepAwakeHtml).not.toMatch(/\b(?:pl|ml)-[1-9]/);

    // Keep disabled opacity feedback when 永不休眠 is off, still with zero left indentation
    queryValues.set('keep-awake', { supported: true, enabled: false, keepDisplay: false });
    const offHtml = render(createElement(KeepAwakeToggle, { enabled: true }));
    expect(offHtml).toContain('opacity-50');
    expect(offHtml).not.toContain('pl-4');
    queryValues.set('keep-awake', { supported: true, enabled: true, keepDisplay: false });
  });
});
