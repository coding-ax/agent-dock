import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BUILTIN_THEMES } from '@agent-dock/agent-dock-shared';
import type { ThemeMode } from '../theme';
import type { PwaInstallSnapshot } from '../pwa-install';
import { resolvePwaInstallSnapshot } from '../pwa-install';

const chromeDesktopUa = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';
const electronDefaultUa = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) AgentDock/0.3.29 Chrome/134.0.0.0 Electron/45.3.0 Safari/537.36';

let mockedMode: ThemeMode = 'system';
let mockedDesktopUpdateApi: unknown = undefined;
let mockedPwaSnapshot: PwaInstallSnapshot = resolvePwaInstallSnapshot({
  hasElectronDesktop: false,
  standalone: false,
  userAgent: chromeDesktopUa,
  hasDeferredPrompt: true
});

const queryValues = new Map<string, unknown>([
  ['autostart', { supported: true, enabled: true, plistPath: '/Users/me/Library/LaunchAgents/dev.agentdock.plist' }],
  ['keep-awake', { supported: true, enabled: true, keepDisplay: false }]
]);

vi.mock('../theme', () => ({
  useThemeMode: () => mockedMode,
  useResolvedTheme: () => (mockedMode === 'dark' ? 'dark' : 'light'),
  useActiveTheme: () => (mockedMode === 'dark' ? BUILTIN_THEMES[1]! : BUILTIN_THEMES[0]!),
  useThemesState: () => ({
    themes: BUILTIN_THEMES,
    preferences: {
      modePreference: mockedMode,
      activeThemeId: BUILTIN_THEMES[0]!.id,
      activeLightThemeId: BUILTIN_THEMES[0]!.id,
      activeDarkThemeId: BUILTIN_THEMES[1]!.id
    },
    activeTheme: mockedMode === 'dark' ? BUILTIN_THEMES[1]! : BUILTIN_THEMES[0]!,
    previewTheme: null
  }),
  setThemeMode: (mode: ThemeMode) => { mockedMode = mode; }
}));

vi.mock('../DeferredMount', () => ({
  DeferredMount: ({ children }: { children: unknown }) => children,
  DeferredSkeleton: () => null
}));

vi.mock('../useModalFocusTrap', () => ({
  useModalFocusTrap: () => undefined
}));

vi.mock('../desktop-update', async importOriginal => ({
  ...(await importOriginal<typeof import('../desktop-update')>()),
  desktopUpdateApi: () => mockedDesktopUpdateApi,
  useDesktopUpdate: () => ({
    api: mockedDesktopUpdateApi,
    state: undefined,
    installing: false,
    check: vi.fn(),
    download: vi.fn(),
    install: vi.fn()
  })
}));

vi.mock('../pwa-install', async importOriginal => ({
  ...(await importOriginal<typeof import('../pwa-install')>()),
  usePwaInstall: () => mockedPwaSnapshot
}));

vi.mock('../SelfUpdateNotice', () => ({
  SelfUpdateNotice: () => createElement('div', { 'data-testid': 'mock-self-update' }, 'AgentDock 0.3.29'),
  SelfUpdateWatcher: () => null
}));

vi.mock('../LlmEndpointPanel', () => ({
  LlmEndpointPanel: () => createElement('div', { 'data-testid': 'mock-llm-panel' }, '模型端点与 AI 文本辅助')
}));
vi.mock('../SideChatConfigPanel', () => ({
  SideChatConfigPanel: () => createElement('div', { 'data-testid': 'mock-side-chat-panel' }, '侧边对话设置')
}));
vi.mock('../output-plugins/OutputPluginsCenterPanel', () => ({
  OutputPluginsCenterPanel: () => createElement('div', { 'data-testid': 'mock-output-plugins-panel' }, '全局交互插件中心')
}));
vi.mock('../LarkConfigPanel', () => ({
  LarkConfigPanel: () => createElement('div', { 'data-testid': 'mock-lark-bots-panel' }, '飞书机器人面板')
}));
vi.mock('../LarkRegexTriggerDialog', () => ({
  LarkRegexTriggerDialog: () => createElement('div', { 'data-testid': 'mock-lark-regex-panel' }, '群聊正则唤起面板')
}));
vi.mock('../LarkAvatarPanel', () => ({
  LarkAvatarPanel: () => createElement('div', { 'data-testid': 'mock-lark-avatar-panel' }, 'AI 飞书替身面板')
}));
vi.mock('../NotificationSettingsDialog', () => ({
  NotificationSettingsDialog: () => createElement('div', { 'data-testid': 'mock-notifications-panel' }, '通知渠道面板')
}));
vi.mock('../ScheduleDialog', () => ({
  ScheduleDialog: () => createElement('div', { 'data-testid': 'mock-schedule-panel' }, '定时任务面板')
}));
vi.mock('../AssistantSettingsDialog', () => ({
  AssistantSettingsDialog: () => createElement('div', { 'data-testid': 'mock-assistant-panel' }, '小猫与督办面板')
}));
vi.mock('../TaskRecoverySettingsDialog', () => ({
  TaskRecoverySettingsDialog: () => createElement('div', { 'data-testid': 'mock-recovery-panel' }, '中断自动恢复面板'),
  taskRecoveryModeShortLabel: (mode?: string) => (mode === 'confirm' ? '确认卡' : mode === 'off' ? '已关闭' : '自动续跑')
}));
vi.mock('../ThemeStudioDialog', () => ({
  ThemeStudioDialog: () => createElement('div', { 'data-testid': 'mock-theme-studio-panel' }, '主题工坊面板')
}));
vi.mock('../AgentConfigDialog', () => ({
  AgentsManagePanel: () => createElement('div', { 'data-testid': 'mock-agents-panel' }, 'Agent 管理面板')
}));
vi.mock('../companion/useCompanion', () => ({
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
vi.mock('@tanstack/react-query', async importOriginal => ({
  ...(await importOriginal<typeof import('@tanstack/react-query')>()),
  useQuery: (opts: { queryKey?: unknown[] }) => {
    const key = Array.isArray(opts.queryKey) ? String(opts.queryKey[0]) : '';
    return { data: queryValues.get(key), refetch: vi.fn(), isPending: false };
  }
}));

import { TooltipProvider } from '../HoverTooltip';
import { I18nProvider } from '../i18n';
import { SettingsCenterDialog, type SettingsCenterDialogProps } from './SettingsCenterDialog';
import {
  normalizeSettingsTarget,
  resolveDialogKindToSettingsTarget,
  searchSettingsItems,
  SETTINGS_CATEGORIES
} from './settings-registry';

const noop = () => undefined;

const baseProps: SettingsCenterDialogProps = {
  webDenied: false,
  agents: [],
  sessions: [],
  archivedCount: 4,
  outputPluginsEnabledCount: 2,
  outputPluginsTotalCount: 3,
  taskRecoveryMode: 'auto',
  onClose: noop,
  onOpenSession: noop,
  onOpenMain: noop,
  onAdopt: noop,
  onOpenUsage: noop,
  onOpenArchived: noop,
  onOpenImport: noop,
  onOpenShare: noop
};

function renderDialog(overrides: Partial<SettingsCenterDialogProps> = {}) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return renderToStaticMarkup(
    createElement(
      QueryClientProvider,
      { client: qc },
      createElement(
        TooltipProvider,
        null,
        createElement(SettingsCenterDialog, { ...baseProps, ...overrides })
      )
    )
  );
}

afterEach(() => {
  mockedMode = 'system';
  mockedDesktopUpdateApi = undefined;
  mockedPwaSnapshot = resolvePwaInstallSnapshot({
    hasElectronDesktop: false,
    standalone: false,
    userAgent: chromeDesktopUa,
    hasDeferredPrompt: true
  });
});

describe('settings-registry navigation, routing, and search', () => {
  it('converges all settings into exactly 5 clear top-level categories with merged 3-in-1 Lark tabs', () => {
    expect(SETTINGS_CATEGORIES.map(c => c.id)).toEqual([
      'general',
      'agent',
      'automation',
      'lark',
      'notifications'
    ]);
    expect(SETTINGS_CATEGORIES.map(c => c.label)).toEqual([
      '通用与外观',
      'Agent 与能力',
      '小猫与自动化',
      '飞书与协同',
      '通知渠道'
    ]);

    const lark = SETTINGS_CATEGORIES.find(c => c.id === 'lark')!;
    expect(lark.subTabs.map(t => t.id)).toEqual(['bots', 'regex', 'avatar']);
    expect(lark.subTabs.map(t => t.label)).toEqual(['飞书机器人', '群聊正则唤起', 'AI 飞书替身']);

    const agent = SETTINGS_CATEGORIES.find(c => c.id === 'agent')!;
    expect(agent.subTabs.map(t => t.id)).toEqual(['llm', 'agents', 'side-chat', 'output-plugins', 'schedules']);
  });

  it('routes every legacy global settings dialog kind to its exact SettingsCenter category & subTab without regressions', () => {
    expect(resolveDialogKindToSettingsTarget('settings')).toEqual({ category: 'general', subTab: 'overview' });
    expect(resolveDialogKindToSettingsTarget('settings', { settingsCategory: 'lark', settingsSubTab: 'avatar' })).toEqual({
      category: 'lark',
      subTab: 'avatar'
    });
    expect(resolveDialogKindToSettingsTarget('theme-studio')).toEqual({ category: 'general', subTab: 'theme-studio' });
    expect(resolveDialogKindToSettingsTarget('agent')).toEqual({ category: 'agent', subTab: 'llm' });
    expect(resolveDialogKindToSettingsTarget('side-chat')).toEqual({ category: 'agent', subTab: 'side-chat' });
    expect(resolveDialogKindToSettingsTarget('output-plugins')).toEqual({ category: 'agent', subTab: 'output-plugins' });
    expect(resolveDialogKindToSettingsTarget('schedule')).toEqual({ category: 'agent', subTab: 'schedules' });
    // 会话级定时任务与会话级交互插件弹窗必须保持独立，不劫持进全局设置中心
    expect(resolveDialogKindToSettingsTarget('schedule', { sessionId: 'ses_123' })).toBeNull();
    expect(resolveDialogKindToSettingsTarget('session-output-plugins', { sessionId: 'ses_123' })).toBeNull();
    expect(resolveDialogKindToSettingsTarget('assistant')).toEqual({ category: 'automation', subTab: 'assistant' });
    expect(resolveDialogKindToSettingsTarget('task-recovery')).toEqual({ category: 'automation', subTab: 'task-recovery' });
    expect(resolveDialogKindToSettingsTarget('lark')).toEqual({ category: 'lark', subTab: 'bots' });
    expect(resolveDialogKindToSettingsTarget('lark-regex')).toEqual({ category: 'lark', subTab: 'regex' });
    expect(resolveDialogKindToSettingsTarget('lark-avatar')).toEqual({ category: 'lark', subTab: 'avatar' });
    expect(resolveDialogKindToSettingsTarget('notifications')).toEqual({ category: 'notifications', subTab: 'main' });
    // 独立工作区工具弹窗不走 SettingsCenter
    expect(resolveDialogKindToSettingsTarget('usage')).toBeNull();
    expect(resolveDialogKindToSettingsTarget('archived')).toBeNull();
    expect(resolveDialogKindToSettingsTarget('import')).toBeNull();
    expect(resolveDialogKindToSettingsTarget('share')).toBeNull();
  });

  it('normalizes unknown subTabs gracefully back to category default', () => {
    expect(normalizeSettingsTarget('lark', 'unknown' as never)).toEqual({ category: 'lark', subTab: 'bots' });
    expect(normalizeSettingsTarget('notifications', 'bots')).toEqual({ category: 'notifications', subTab: 'main' });
  });

  it('filters settings across Chinese, English, and multi-token queries and ranks title matches first', () => {
    expect(searchSettingsItems('')).toEqual([]);
    expect(searchSettingsItems('   ')).toEqual([]);

    const regexHits = searchSettingsItems('飞书 正则');
    expect(regexHits[0]?.id).toBe('lark-regex');
    expect(regexHits[0]?.category).toBe('lark');
    expect(regexHits[0]?.subTab).toBe('regex');

    const themeHits = searchSettingsItems('主题工坊');
    expect(themeHits[0]?.id).toBe('theme-studio');

    const wakeHits = searchSettingsItems('屏幕常亮');
    expect(wakeHits[0]?.id).toBe('keep-awake');

    const pluginHits = searchSettingsItems('AskUserQuestion');
    expect(pluginHits[0]?.id).toBe('output-plugins');

    const webhookHits = searchSettingsItems('webhook');
    expect(webhookHits[0]?.id).toBe('notifications');

    const archiveHits = searchSettingsItems('归档');
    expect(archiveHits[0]?.id).toBe('archived-sessions');
    expect(archiveHits[0]?.quickAction).toBe('archived');

    // Electron 桌面壳隐藏 PWA 安装项后，搜索也不再泄露该入口
    expect(searchSettingsItems('PWA', { showPwaInstall: true }).some(item => item.id === 'pwa-install')).toBe(true);
    expect(searchSettingsItems('PWA', { showPwaInstall: false }).some(item => item.id === 'pwa-install')).toBe(false);
  });

  it('supports full-pinyin and pinyin-initial keyword search across all categories', () => {
    expect(searchSettingsItems('zhuti')[0]?.id).toBe('theme-studio');
    expect(searchSettingsItems('xiumian')[0]?.id).toBe('keep-awake');
    expect(searchSettingsItems('chajian')[0]?.id).toBe('output-plugins');
    expect(searchSettingsItems('huifu')[0]?.id).toBe('task-recovery');
    expect(searchSettingsItems('dingshi')[0]?.id).toBe('schedules');
    expect(searchSettingsItems('tishen')[0]?.id).toBe('lark-avatar');
    expect(searchSettingsItems('zhengze')[0]?.id).toBe('lark-regex');
    expect(searchSettingsItems('feishu zhengze')[0]?.id).toBe('lark-regex');
    expect(searchSettingsItems('tongzhi')[0]?.id).toBe('notifications');
    expect(searchSettingsItems('xiaomao')[0]?.id).toBe('assistant');
    expect(searchSettingsItems('kj')[0]?.id).toBe('autostart');
  });
});

describe('SettingsCenterDialog rendering across categories & viewports', () => {
  it('renders 5-category navigation, search inputs (desktop + mobile), power toggles, and workspace quick tools in General', () => {
    const html = renderDialog();
    expect(html).toContain('data-testid="settings-center-dialog"');
    expect(html).toContain('设置中心');
    expect(html).toContain('data-testid="settings-search-input"');
    expect(html).toContain('data-testid="settings-search-input-mobile"');

    // 5 大类导航（桌面左侧 + 移动端顶部横向 tabs）
    for (const id of ['general', 'agent', 'automation', 'lark', 'notifications']) {
      expect(html).toContain(`data-testid="settings-nav-${id}"`);
      expect(html).toContain(`data-testid="settings-mobile-nav-${id}"`);
    }

    // 通用与外观核心项：外观模式、主题工坊入口、开机自启、永不休眠/屏幕常亮、PWA、版本更新、工作区工具
    expect(html).toContain('浅色');
    expect(html).toContain('跟随系统');
    expect(html).toContain('深色');
    expect(html).toContain('data-testid="settings-open-theme-studio"');
    expect(html).toContain('开机自启');
    expect(html).toContain('永不休眠');
    expect(html).toContain('屏幕常亮');
    expect(html).toContain('安装为桌面应用');
    expect(html).toContain('AgentDock 0.3.29');
    expect(html).toContain('data-testid="settings-tool-usage"');
    expect(html).toContain('data-testid="settings-tool-archived"');
    expect(html).toContain('data-testid="settings-tool-import"');
    expect(html).toContain('data-testid="settings-tool-share"');
    expect(html).toContain('2/3');
  });

  it('embeds Theme Studio cleanly inside General -> theme-studio tab', () => {
    const html = renderDialog({ initialCategory: 'general', initialSubTab: 'theme-studio' });
    expect(html).toContain('data-testid="mock-theme-studio-panel"');
  });

  it('embeds all 5 Agent & Capabilities panels with sub-tab navigation', () => {
    expect(renderDialog({ initialCategory: 'agent', initialSubTab: 'llm' })).toContain('data-testid="mock-llm-panel"');
    expect(renderDialog({ initialCategory: 'agent', initialSubTab: 'agents' })).toContain('data-testid="mock-agents-panel"');
    expect(renderDialog({ initialCategory: 'agent', initialSubTab: 'side-chat' })).toContain('data-testid="mock-side-chat-panel"');
    expect(renderDialog({ initialCategory: 'agent', initialSubTab: 'output-plugins' })).toContain('data-testid="mock-output-plugins-panel"');
    expect(renderDialog({ initialCategory: 'agent', initialSubTab: 'schedules' })).toContain('data-testid="mock-schedule-panel"');
  });

  it('embeds Kitten & Automation panels (Assistant + Task Recovery)', () => {
    expect(renderDialog({ initialCategory: 'automation', initialSubTab: 'assistant' })).toContain('data-testid="mock-assistant-panel"');
    expect(renderDialog({ initialCategory: 'automation', initialSubTab: 'task-recovery' })).toContain('data-testid="mock-recovery-panel"');
  });

  it('merges all 3 Lark entries into a unified 3-in-1 Lark & Collaboration category', () => {
    const botsHtml = renderDialog({ initialCategory: 'lark', initialSubTab: 'bots' });
    expect(botsHtml).toContain('data-testid="settings-subtab-bots"');
    expect(botsHtml).toContain('data-testid="settings-subtab-regex"');
    expect(botsHtml).toContain('data-testid="settings-subtab-avatar"');
    expect(botsHtml).toContain('data-testid="mock-lark-bots-panel"');

    expect(renderDialog({ initialCategory: 'lark', initialSubTab: 'regex' })).toContain('data-testid="mock-lark-regex-panel"');
    expect(renderDialog({ initialCategory: 'lark', initialSubTab: 'avatar' })).toContain('data-testid="mock-lark-avatar-panel"');
  });

  it('embeds Notifications panel directly in category 5', () => {
    const html = renderDialog({ initialCategory: 'notifications' });
    expect(html).toContain('data-testid="mock-notifications-panel"');
    expect(html).not.toContain('data-testid="settings-subtabs-notifications"');
  });

  it('double-locks PWA install row off in Electron desktop shell', () => {
    mockedDesktopUpdateApi = { getState: vi.fn() };
    mockedPwaSnapshot = resolvePwaInstallSnapshot({
      hasElectronDesktop: true,
      standalone: false,
      userAgent: electronDefaultUa,
      hasDeferredPrompt: true
    });
    const html = renderDialog();
    expect(html).not.toContain('settings-pwa-install-row');
    expect(html).not.toContain('安装为桌面应用');
  });

  it('renders Language & Region switcher in General and switches SettingsCenter chrome cleanly to en-US', () => {
    const zhHtml = renderDialog();
    expect(zhHtml).toContain('data-testid="settings-language-section"');
    expect(zhHtml).toContain('data-testid="language-segmented"');
    expect(zhHtml).toContain('语言与地区');
    expect(zhHtml).toContain('简体中文');
    expect(zhHtml).toContain('English');

    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const enHtml = renderToStaticMarkup(
      createElement(
        QueryClientProvider,
        { client: qc },
        createElement(
          I18nProvider,
          { locale: 'en-US' },
          createElement(
            TooltipProvider,
            null,
            createElement(SettingsCenterDialog, baseProps)
          )
        )
      )
    );
    expect(enHtml).toContain('Settings Center');
    expect(enHtml).toContain('Language &amp; Region');
    expect(enHtml).toContain('General &amp; Appearance');
    expect(enHtml).toContain('Agents &amp; Capabilities');
    expect(enHtml).toContain('Companion &amp; Automation');
    expect(enHtml).toContain('Lark &amp; Collaboration');
    expect(enHtml).toContain('Notifications');
    expect(enHtml).toContain('Open Theme Studio');
    // Only native language name "简体中文" should appear in English SettingsCenter shell
    const withoutNativeZh = enHtml.replaceAll('简体中文', '');
    expect(/[\u4e00-\u9fff]/.test(withoutNativeZh)).toBe(false);
  });
});
