import { useEffect, useMemo, useRef, useState, type ComponentType, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { useQuery } from '@tanstack/react-query';
import { localizeThemeDisplay } from '@agent-dock/agent-dock-shared';
import {
  AlarmClock,
  Archive,
  ArrowRight,
  BarChart3,
  Bell,
  Bot,
  ChevronRight,
  FolderOpen,
  Globe,
  MessagesSquare,
  MonitorDown,
  Palette,
  PawPrint,
  Plug,
  Puzzle,
  Regex,
  RotateCcw,
  Search,
  Settings,
  SlidersHorizontal,
  Smartphone,
  Sparkles,
  X
} from 'lucide-react';
import { api, type Agent, type Session, type TaskRecoveryMode } from '../api';
import { AgentsManagePanel } from '../AgentConfigDialog';
import { AssistantSettingsDialog } from '../AssistantSettingsDialog';
import { AutostartToggle } from '../AutostartToggle';
import { HoverTooltip } from '../HoverTooltip';
import { LanguageSegmented, useBi, useLocale, useLocalePreference, useT } from '../i18n';
import { KeepAwakeToggle } from '../KeepAwakeToggle';
import { LarkAvatarPanel } from '../LarkAvatarPanel';
import { LarkConfigPanel } from '../LarkConfigPanel';
import { LarkIcon } from '../LarkIcon';
import { LarkRegexTriggerDialog } from '../LarkRegexTriggerDialog';
import { LlmEndpointPanel } from '../LlmEndpointPanel';
import { Spinner } from '../Loaders';
import { NotificationSettingsDialog } from '../NotificationSettingsDialog';
import { OutputPluginsCenterPanel } from '../output-plugins/OutputPluginsCenterPanel';
import { ScheduleDialog } from '../ScheduleDialog';
import { SelfUpdateNotice } from '../SelfUpdateNotice';
import { SideChatConfigPanel } from '../SideChatConfigPanel';
import { TaskRecoverySettingsDialog } from '../TaskRecoverySettingsDialog';
import { ThemeStudioDialog } from '../ThemeStudioDialog';
import { ThemeSegmented } from '../ThemeToggle';
import { useCompanion } from '../companion/useCompanion';
import { resolveDesktopUpdateBadge, useDesktopUpdate } from '../desktop-update';
import { triggerPwaInstall, usePwaInstall } from '../pwa-install';
import {
  resolveServerUpdateBadge,
  SELF_UPDATE_QUERY_KEY,
  SELF_UPDATE_REFETCH_INTERVAL_MS,
  useSelfUpdateClientState
} from '../self-update-progress';
import { useActiveTheme, useThemesState } from '../theme';
import { useModalFocusTrap } from '../useModalFocusTrap';
import {
  getSettingsCategories,
  getSettingsCategoryMap,
  getSuggestedSearchTags,
  normalizeSettingsTarget,
  searchSettingsItems,
  type SettingsCategoryId,
  type SettingsQuickActionId,
  type SettingsSearchItem,
  type SettingsSubTab
} from './settings-registry';

export interface SettingsCenterDialogProps {
  initialCategory?: SettingsCategoryId;
  initialSubTab?: SettingsSubTab;
  webDenied: boolean;
  agents: Agent[];
  sessions: Session[];
  mainSessionId?: string;
  archivedCount: number;
  outputPluginsEnabledCount?: number;
  outputPluginsTotalCount?: number;
  taskRecoveryMode?: TaskRecoveryMode;
  onClose(): void;
  onOpenSession(sessionId: string): void;
  onOpenMain(): void;
  onAdopt(): void;
  onOpenUsage(): void;
  onOpenArchived(): void;
  onOpenImport(): void;
  onOpenShare(): void;
}

type SettingsIconComponent = ComponentType<{ size?: number; className?: string }>;

const CATEGORY_ICON: Record<SettingsCategoryId, SettingsIconComponent> = {
  general: SlidersHorizontal,
  agent: Bot,
  automation: PawPrint,
  lark: LarkIcon,
  notifications: Bell
};

function searchItemIcon(item: SettingsSearchItem): SettingsIconComponent {
  switch (item.id) {
    case 'language-region': return Globe;
    case 'appearance-mode': return SlidersHorizontal;
    case 'theme-studio': return Palette;
    case 'autostart':
    case 'keep-awake': return SlidersHorizontal;
    case 'pwa-install': return MonitorDown;
    case 'version-update': return Sparkles;
    case 'usage-dashboard': return BarChart3;
    case 'archived-sessions': return Archive;
    case 'import-session': return FolderOpen;
    case 'share-mobile': return Smartphone;
    case 'llm-endpoint': return Plug;
    case 'agents-manage': return Bot;
    case 'side-chat': return MessagesSquare;
    case 'output-plugins': return Puzzle;
    case 'schedules': return AlarmClock;
    case 'assistant': return PawPrint;
    case 'task-recovery': return RotateCcw;
    case 'lark-bots': return LarkIcon;
    case 'lark-regex': return Regex;
    case 'lark-avatar': return Bot;
    case 'notifications': return Bell;
    default: return Settings;
  }
}

function subTabIcon(subTab: SettingsSubTab): SettingsIconComponent {
  switch (subTab) {
    case 'overview': return SlidersHorizontal;
    case 'theme-studio': return Palette;
    case 'llm': return Plug;
    case 'agents': return Bot;
    case 'side-chat': return MessagesSquare;
    case 'output-plugins': return Puzzle;
    case 'schedules': return AlarmClock;
    case 'assistant': return PawPrint;
    case 'task-recovery': return RotateCcw;
    case 'bots': return LarkIcon;
    case 'regex': return Regex;
    case 'avatar': return Bot;
    default: return Settings;
  }
}

function GeneralOverviewPanel({
  webDenied,
  archivedCount,
  onOpenThemeStudio,
  onQuickAction
}: {
  webDenied: boolean;
  archivedCount: number;
  onOpenThemeStudio(): void;
  onQuickAction(action: SettingsQuickActionId): void;
}) {
  const locale = useLocale();
  const localePreference = useLocalePreference();
  const t = useT();
  const L = useBi();
  const activeTheme = useActiveTheme();
  const localizedActiveTheme = localizeThemeDisplay(activeTheme, locale);
  const { themes } = useThemesState();
  const desktopUpdate = useDesktopUpdate();
  const pwa = usePwaInstall();
  const [showPwaGuide, setShowPwaGuide] = useState(false);

  const autostartQuery = useQuery({
    queryKey: ['autostart'],
    queryFn: api.autostartStatus,
    enabled: !webDenied,
    retry: false,
    refetchOnWindowFocus: false
  });
  const keepAwakeQuery = useQuery({
    queryKey: ['keep-awake'],
    queryFn: api.keepAwakeStatus,
    enabled: !webDenied,
    retry: false,
    refetchOnWindowFocus: false
  });

  const showPowerSection = Boolean(autostartQuery.data?.supported || keepAwakeQuery.data?.supported);
  const showPwaRow = !desktopUpdate.api && pwa.visible;

  const handlePwaInstall = async () => {
    if (!pwa.canPrompt) {
      setShowPwaGuide(current => !current);
      return;
    }
    const result = await triggerPwaInstall();
    if (result === 'manual') setShowPwaGuide(true);
  };

  const quickTools: Array<{
    id: SettingsQuickActionId;
    title: string;
    description: string;
    icon: typeof BarChart3;
    badge?: string;
  }> = [
    { id: 'usage', title: t('settings.general.tools.usageTitle'), description: t('settings.general.tools.usageDesc'), icon: BarChart3 },
    { id: 'archived', title: t('settings.general.tools.archivedTitle'), description: t('settings.general.tools.archivedDesc'), icon: Archive, badge: String(archivedCount) },
    { id: 'import', title: t('settings.general.tools.importTitle'), description: t('settings.general.tools.importDesc'), icon: FolderOpen },
    { id: 'share', title: t('settings.general.tools.shareTitle'), description: t('settings.general.tools.shareDesc'), icon: Smartphone }
  ];

  const resolvedLocaleLabel = locale === 'en-US' ? t('locale.resolved.en-US') : t('locale.resolved.zh-CN');

  return (
    <div className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden px-4 py-4 pb-[max(1.25rem,env(safe-area-inset-bottom))] sm:px-6 sm:py-5">
      <div className="mx-auto max-w-2xl space-y-4">
        {/* 1. 语言与地区 / Language & Region */}
        <section className="overflow-hidden rounded-2xl border border-zinc-200 bg-white" data-testid="settings-language-section">
          <div className="border-b border-zinc-100 px-4 py-3">
            <h3 className="flex items-center gap-1.5 text-[13.5px] font-semibold text-zinc-900">
              <Globe size={14} className="shrink-0 text-accent"/>
              <span>{t('locale.section.title')}</span>
            </h3>
            <p className="mt-0.5 text-[12px] text-zinc-500">{t('locale.section.subtitle')}</p>
          </div>
          <div className="flex flex-col gap-2.5 px-4 py-3.5 sm:flex-row sm:items-center sm:justify-between">
            <div className="min-w-0">
              <div className="text-[13px] font-medium text-zinc-900">{t('locale.row.title')}</div>
              <div className="mt-0.5 text-[12px] text-zinc-500">
                {localePreference === 'system'
                  ? t('locale.row.descSystem', { resolved: resolvedLocaleLabel })
                  : t('locale.row.descFixed')}
              </div>
            </div>
            <div className="w-full sm:w-[244px] sm:shrink-0">
              <LanguageSegmented/>
            </div>
          </div>
        </section>

        {/* 2. 外观与主题 */}
        <section className="overflow-hidden rounded-2xl border border-zinc-200 bg-white">
          <div className="border-b border-zinc-100 px-4 py-3">
            <h3 className="text-[13.5px] font-semibold text-zinc-900">{t('settings.general.appearance.title')}</h3>
            <p className="mt-0.5 text-[12px] text-zinc-500">{t('settings.general.appearance.desc')}</p>
          </div>
          <div className="divide-y divide-zinc-100">
            <div className="flex flex-col gap-2.5 px-4 py-3.5 sm:flex-row sm:items-center sm:justify-between">
              <div className="min-w-0">
                <div className="text-[13px] font-medium text-zinc-900">{t('settings.general.appearance.modeLabel')}</div>
                <div className="mt-0.5 text-[12px] text-zinc-500">{t('settings.general.appearance.modeDesc')}</div>
              </div>
              <div className="w-full sm:w-[244px] sm:shrink-0">
                <ThemeSegmented/>
              </div>
            </div>

            <div className="flex flex-col gap-3 px-4 py-3.5 sm:flex-row sm:items-center sm:justify-between">
              <div className="flex min-w-0 items-center gap-3">
                <div className="flex shrink-0 items-center gap-1 rounded-xl border border-zinc-200 bg-zinc-50 p-1.5" aria-hidden="true">
                  <span className="h-4 w-4 rounded-md ring-1 ring-zinc-300/80" style={{ backgroundColor: activeTheme.tokens.bgCanvas }}/>
                  <span className="h-4 w-4 rounded-md ring-1 ring-zinc-300/80" style={{ backgroundColor: activeTheme.tokens.bgSidebar }}/>
                  <span className="h-4 w-4 rounded-md ring-1 ring-zinc-300/80" style={{ backgroundColor: activeTheme.tokens.accent }}/>
                </div>
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span className="truncate text-[13px] font-medium text-zinc-900">{localizedActiveTheme.name}</span>
                    <span className="rounded-full border border-zinc-200 bg-zinc-50 px-1.5 py-px text-[10.5px] tabular-nums text-zinc-500">
                      {t('settings.general.appearance.themeCount', { count: themes.length })}
                    </span>
                  </div>
                  <div className="mt-0.5 text-[12px] leading-[1.45] text-zinc-500">
                    {t('settings.general.appearance.studioDesc')}
                  </div>
                </div>
              </div>
              <button
                type="button"
                data-testid="settings-open-theme-studio"
                onClick={onOpenThemeStudio}
                className="ui-press inline-flex h-8 shrink-0 items-center justify-center gap-1.5 whitespace-nowrap rounded-lg border border-zinc-200 bg-white px-3 text-[12px] font-medium text-zinc-700 transition-colors hover:bg-zinc-50 hover:text-zinc-900"
              >
                <Palette size={13} className="text-accent"/>
                <span>{t('settings.general.appearance.openStudio')}</span>
                <ChevronRight size={13} className="text-zinc-400"/>
              </button>
            </div>
          </div>
        </section>

        {/* 3. 系统与电源（仅在支持开机自启或防休眠的平台展示） */}
        {showPowerSection && (
          <section className="overflow-hidden rounded-2xl border border-zinc-200 bg-white" data-testid="settings-power-section">
            <div className="border-b border-zinc-100 px-4 py-3">
              <h3 className="text-[13.5px] font-semibold text-zinc-900">{t('settings.general.power.title')}</h3>
              <p className="mt-0.5 text-[12px] text-zinc-500">{t('settings.general.power.desc')}</p>
            </div>
            <div className="divide-y divide-zinc-100 px-4 py-1 text-[12px] text-zinc-700">
              <AutostartToggle enabled={!webDenied}/>
              <KeepAwakeToggle enabled={!webDenied}/>
            </div>
          </section>
        )}

        {/* 4. 应用安装与版本 */}
        <section className="overflow-hidden rounded-2xl border border-zinc-200 bg-white" data-testid="settings-app-version-section">
          <div className="border-b border-zinc-100 px-4 py-3">
            <h3 className="text-[13.5px] font-semibold text-zinc-900">{t('settings.general.app.title')}</h3>
            <p className="mt-0.5 text-[12px] text-zinc-500">{t('settings.general.app.desc')}</p>
          </div>
          <div className="divide-y divide-zinc-100">
            {showPwaRow && (
              <div className="px-4 py-3" data-testid="settings-pwa-install-row">
                <div className="flex items-center justify-between gap-3">
                  <div className="flex min-w-0 items-center gap-2.5">
                    <span className="grid h-8 w-8 shrink-0 place-items-center rounded-xl border border-zinc-200 bg-zinc-50 text-zinc-600">
                      {pwa.installing
                        ? <Spinner size={14} label={L('正在打开安装弹窗', 'Opening install prompt')} className="text-zinc-500"/>
                        : <MonitorDown size={15}/>}
                    </span>
                    <div className="min-w-0">
                      <div className="flex items-center gap-1.5">
                        <span className="truncate text-[13px] font-medium text-zinc-900">
                          {pwa.installing ? L('等待确认安装…', 'Waiting for install confirmation…') : t('settings.general.app.pwaTitle')}
                        </span>
                        {pwa.canPrompt && (
                          <span className="shrink-0 whitespace-nowrap rounded bg-zinc-100 px-1.5 py-0.5 text-[10.5px] font-medium text-zinc-500">
                            PWA
                          </span>
                        )}
                      </div>
                      <div className="mt-0.5 truncate text-[12px] text-zinc-500">{t('settings.general.app.pwaDesc')}</div>
                    </div>
                  </div>
                  <button
                    type="button"
                    disabled={pwa.installing}
                    onClick={() => void handlePwaInstall()}
                    className="ui-press h-8 shrink-0 whitespace-nowrap rounded-lg border border-zinc-200 bg-white px-3 text-[12px] font-medium text-zinc-700 hover:bg-zinc-50 hover:text-zinc-900 disabled:opacity-50"
                  >
                    {pwa.canPrompt ? t('settings.general.app.pwaInstallBtn') : showPwaGuide ? t('settings.general.app.pwaGuideHide') : t('settings.general.app.pwaGuideBtn')}
                  </button>
                </div>
                {showPwaGuide && !pwa.canPrompt && Boolean(pwa.manualHint) && (
                  <div className="mt-2.5 rounded-xl border border-zinc-200 bg-zinc-50 px-3 py-2 text-[12px] leading-5 text-zinc-600">
                    {pwa.manualHint}
                  </div>
                )}
              </div>
            )}

            <div className="px-4 py-3 text-[12px] text-zinc-500 empty:hidden">
              <SelfUpdateNotice enabled={!webDenied}/>
            </div>
          </div>
        </section>

        {/* 5. 工作区与数据工具 */}
        <section className="overflow-hidden rounded-2xl border border-zinc-200 bg-white" data-testid="settings-workspace-tools">
          <div className="border-b border-zinc-100 px-4 py-3">
            <h3 className="text-[13.5px] font-semibold text-zinc-900">{t('settings.general.tools.title')}</h3>
            <p className="mt-0.5 text-[12px] text-zinc-500">{t('settings.general.tools.desc')}</p>
          </div>
          <div className="grid grid-cols-1 gap-2.5 p-3.5 sm:grid-cols-2">
            {quickTools.map(tool => {
              const Icon = tool.icon;
              return (
                <button
                  key={tool.id}
                  type="button"
                  data-testid={`settings-tool-${tool.id}`}
                  onClick={() => onQuickAction(tool.id)}
                  className="ui-press group flex min-w-0 items-center gap-3 rounded-xl border border-zinc-200/90 bg-white px-3 py-2.5 text-left transition-colors hover:border-zinc-300 hover:bg-zinc-50/80"
                >
                  <span className="grid h-8 w-8 shrink-0 place-items-center rounded-lg border border-zinc-200/80 bg-zinc-50 text-zinc-600 transition-colors group-hover:text-zinc-900">
                    <Icon size={15}/>
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-1.5">
                      <span className="truncate text-[13px] font-medium text-zinc-900">{tool.title}</span>
                      {tool.badge !== undefined && (
                        <span className="shrink-0 rounded-full border border-zinc-200 bg-zinc-50 px-1.5 py-px text-[10.5px] tabular-nums text-zinc-500">
                          {tool.badge}
                        </span>
                      )}
                    </div>
                    <div className="mt-0.5 truncate text-[11.5px] text-zinc-500">{tool.description}</div>
                  </div>
                  <ChevronRight size={14} className="shrink-0 text-zinc-300 transition-transform group-hover:translate-x-0.5 group-hover:text-zinc-500"/>
                </button>
              );
            })}
          </div>
        </section>
      </div>
    </div>
  );
}

/**
 * AgentDock 统一设置中心（方案 A）：
 * 左侧 5 大类导航 + 顶部即时搜索过滤 + 右侧内嵌面板；
 * 桌面（1440×900）与平板横屏（1280×800）采用左右分栏，移动端（390×844）自适应顶部横向分类 Tabs，零横向溢出。
 */
export function SettingsCenterDialog({
  initialCategory = 'general',
  initialSubTab,
  webDenied,
  agents,
  sessions,
  mainSessionId,
  archivedCount,
  outputPluginsEnabledCount,
  outputPluginsTotalCount,
  taskRecoveryMode,
  onClose,
  onOpenSession,
  onOpenMain,
  onAdopt,
  onOpenUsage,
  onOpenArchived,
  onOpenImport,
  onOpenShare
}: SettingsCenterDialogProps) {
  const locale = useLocale();
  const t = useT();
  const L = useBi();
  const categories = useMemo(() => getSettingsCategories(locale), [locale]);
  const categoryMap = useMemo(() => getSettingsCategoryMap(locale), [locale]);
  const suggestedTags = useMemo(() => getSuggestedSearchTags(locale), [locale]);
  const initialTarget = normalizeSettingsTarget(initialCategory, initialSubTab);
  const [category, setCategory] = useState<SettingsCategoryId>(initialTarget.category);
  const [subTabByCategory, setSubTabByCategory] = useState<Record<SettingsCategoryId, SettingsSubTab>>({
    general: initialTarget.category === 'general' ? initialTarget.subTab : 'overview',
    agent: initialTarget.category === 'agent' ? initialTarget.subTab : 'llm',
    automation: initialTarget.category === 'automation' ? initialTarget.subTab : 'assistant',
    lark: initialTarget.category === 'lark' ? initialTarget.subTab : 'bots',
    notifications: 'main'
  });
  const [searchQuery, setSearchQuery] = useState('');
  const [activeResultIdx, setActiveResultIdx] = useState(0);

  const panelRef = useRef<HTMLDivElement>(null);
  const mobileTabsRef = useRef<HTMLDivElement>(null);
  const subTabsRef = useRef<HTMLDivElement>(null);
  const activeTheme = useActiveTheme();
  const companion = useCompanion();
  const desktopUpdate = useDesktopUpdate();
  const pwa = usePwaInstall();
  const selfUpdateClient = useSelfUpdateClientState();
  const updateQuery = useQuery({
    queryKey: SELF_UPDATE_QUERY_KEY,
    queryFn: () => api.selfUpdateStatus(),
    enabled: !webDenied && !desktopUpdate.api,
    retry: false,
    refetchInterval: SELF_UPDATE_REFETCH_INTERVAL_MS,
    refetchOnWindowFocus: false
  });
  const updateBadge = desktopUpdate.api
    ? resolveDesktopUpdateBadge(desktopUpdate.state, desktopUpdate.installing)
    : resolveServerUpdateBadge(updateQuery.data, selfUpdateClient);
  const showPwaInstall = !desktopUpdate.api && pwa.visible;

  // 同步外部深链切换（如通知设置中点击「前往飞书设置」或其他组件打开特定设置子项）
  useEffect(() => {
    const next = normalizeSettingsTarget(initialCategory, initialSubTab);
    setCategory(next.category);
    setSubTabByCategory(prev => ({ ...prev, [next.category]: next.subTab }));
    setSearchQuery('');
  }, [initialCategory, initialSubTab]);

  useModalFocusTrap({
    panel: panelRef,
    initial: panelRef,
    dismissible: true,
    onDismiss: () => {
      if (searchQuery.trim()) {
        setSearchQuery('');
        return;
      }
      onClose();
    }
  });

  const navigate = (nextCategory: SettingsCategoryId, nextSubTab?: SettingsSubTab) => {
    const normalized = normalizeSettingsTarget(nextCategory, nextSubTab ?? subTabByCategory[nextCategory]);
    setCategory(normalized.category);
    setSubTabByCategory(prev => ({ ...prev, [normalized.category]: normalized.subTab }));
    setSearchQuery('');
  };

  const triggerQuickAction = (action: SettingsQuickActionId) => {
    switch (action) {
      case 'usage': onOpenUsage(); break;
      case 'archived': onOpenArchived(); break;
      case 'import': onOpenImport(); break;
      case 'share': onOpenShare(); break;
    }
  };

  const searchResults = useMemo(
    () => searchSettingsItems(searchQuery, { showPwaInstall, locale }),
    [searchQuery, showPwaInstall, locale]
  );

  useEffect(() => {
    setActiveResultIdx(0);
  }, [searchQuery]);

  // 移动端切换分类或经由搜索跳转时，自动将当前激活的分类/子 Tab 滚入可视区，避免选中项卡在边缘
  useEffect(() => {
    const activeMobileTab = mobileTabsRef.current?.querySelector<HTMLElement>('[aria-selected="true"]');
    activeMobileTab?.scrollIntoView?.({ inline: 'nearest', block: 'nearest' });
    const activeSub = subTabsRef.current?.querySelector<HTMLElement>('[aria-selected="true"]');
    activeSub?.scrollIntoView?.({ inline: 'nearest', block: 'nearest' });
  }, [category, subTabByCategory]);

  const handleSelectSearchItem = (item: SettingsSearchItem) => {
    if (item.quickAction) {
      setSearchQuery('');
      triggerQuickAction(item.quickAction);
      return;
    }
    navigate(item.category, item.subTab);
  };

  const handleSearchKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Escape' && searchQuery.trim()) {
      event.preventDefault();
      event.stopPropagation();
      setSearchQuery('');
      return;
    }
    if (!searchResults.length) return;
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setActiveResultIdx(idx => (idx + 1) % searchResults.length);
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      setActiveResultIdx(idx => (idx - 1 + searchResults.length) % searchResults.length);
    } else if (event.key === 'Enter') {
      event.preventDefault();
      const target = searchResults[activeResultIdx] ?? searchResults[0];
      if (target) handleSelectSearchItem(target);
    }
  };

  const activeCategoryMeta = categoryMap[category];
  const activeSubTab = subTabByCategory[category] ?? activeCategoryMeta.defaultSubTab;
  const searching = searchQuery.trim().length > 0;
  const companionAttention = companion.counts.needsUser + companion.counts.planned + companion.pendingDrafts;

  const formatRecoveryBadge = (mode: TaskRecoveryMode) =>
    mode === 'confirm' ? t('recovery.mode.confirm') : mode === 'off' ? t('recovery.mode.off') : t('recovery.mode.auto');
  const formatRecoveryNavBadge = (mode: TaskRecoveryMode) =>
    mode === 'confirm' ? L('确认', 'Confirm') : mode === 'off' ? L('关闭', 'Off') : L('自动', 'Auto');

  const renderCategoryBadge = (id: SettingsCategoryId, active: boolean) => {
    if (id === 'general') {
      if (updateBadge === 'available') {
        return <span className="h-2 w-2 shrink-0 rounded-full bg-emerald-500 ui-status-pulse" aria-label={t('settings.menu.updateAvailable')}/>;
      }
      if (updateBadge === 'updating') {
        return <Spinner size={11} label={t('settings.menu.updatingAria')} className="shrink-0 text-zinc-500"/>;
      }
      return (
        <span
          aria-hidden="true"
          className="h-2 w-2 shrink-0 rounded-full ring-1 ring-zinc-300"
          style={{ backgroundColor: activeTheme.tokens.accent }}
        />
      );
    }
    if (id === 'agent' && outputPluginsTotalCount !== undefined && outputPluginsTotalCount > 0) {
      return (
        <span className={`shrink-0 rounded-full px-1.5 py-px text-[10.5px] font-normal tabular-nums ${
          active
            ? 'border border-zinc-200 bg-zinc-50 text-zinc-600'
            : 'bg-zinc-200/70 text-zinc-500'
        }`}>
          {outputPluginsEnabledCount ?? 0}/{outputPluginsTotalCount}
        </span>
      );
    }
    if (id === 'automation') {
      if (companionAttention > 0) {
        return (
          <span className="shrink-0 rounded-full bg-amber-100 px-1.5 py-px text-[10.5px] font-medium tabular-nums text-amber-800">
            {companionAttention}
          </span>
        );
      }
      if (taskRecoveryMode) {
        return (
          <span className="hidden shrink-0 whitespace-nowrap rounded-full border border-zinc-200 bg-zinc-50 px-1.5 py-px text-[10px] font-normal text-zinc-500 lg:inline">
            {formatRecoveryNavBadge(taskRecoveryMode)}
          </span>
        );
      }
    }
    if (id === 'lark') {
      return (
        <span className="hidden shrink-0 whitespace-nowrap rounded-full border border-zinc-200/80 bg-zinc-50 px-1.5 py-px text-[10px] font-normal text-zinc-500 lg:inline">
          {L('3合1', '3-in-1')}
        </span>
      );
    }
    return null;
  };

  const renderSubTabBadge = (subTab: SettingsSubTab) => {
    if (subTab === 'theme-studio') {
      return (
        <span
          aria-hidden="true"
          className="h-2 w-2 shrink-0 rounded-full ring-1 ring-zinc-300"
          style={{ backgroundColor: activeTheme.tokens.accent }}
        />
      );
    }
    if (subTab === 'output-plugins' && outputPluginsTotalCount !== undefined && outputPluginsTotalCount > 0) {
      return (
        <span className="rounded-full border border-zinc-200 bg-zinc-50 px-1.5 py-px text-[10.5px] font-normal tabular-nums text-zinc-500">
          {outputPluginsEnabledCount ?? 0}/{outputPluginsTotalCount}
        </span>
      );
    }
    if (subTab === 'task-recovery' && taskRecoveryMode) {
      return (
        <span className="rounded-full border border-zinc-200 bg-zinc-50 px-1.5 py-px text-[10.5px] font-normal text-zinc-500">
          {formatRecoveryBadge(taskRecoveryMode)}
        </span>
      );
    }
    if (subTab === 'assistant' && companionAttention > 0) {
      return (
        <span className="rounded-full bg-amber-100 px-1.5 py-px text-[10.5px] font-medium tabular-nums text-amber-800">
          {companionAttention}
        </span>
      );
    }
    return null;
  };

  const renderActivePanel = () => {
    if (category === 'general') {
      if (activeSubTab === 'theme-studio') {
        return (
          <ThemeStudioDialog
            embedded
            onClose={onClose}
            onOpenLlmSettings={() => navigate('agent', 'llm')}
          />
        );
      }
      return (
        <GeneralOverviewPanel
          webDenied={webDenied}
          archivedCount={archivedCount}
          onOpenThemeStudio={() => navigate('general', 'theme-studio')}
          onQuickAction={triggerQuickAction}
        />
      );
    }

    if (category === 'agent') {
      if (activeSubTab === 'agents') {
        return <AgentsManagePanel embedded onClose={onClose}/>;
      }
      if (activeSubTab === 'side-chat') {
        return <SideChatConfigPanel/>;
      }
      if (activeSubTab === 'output-plugins') {
        return <OutputPluginsCenterPanel/>;
      }
      if (activeSubTab === 'schedules') {
        return (
          <ScheduleDialog
            embedded
            sessions={sessions}
            {...(mainSessionId ? { mainSessionId } : {})}
            onClose={onClose}
            onOpenSession={onOpenSession}
          />
        );
      }
      return <LlmEndpointPanel/>;
    }

    if (category === 'automation') {
      if (activeSubTab === 'task-recovery') {
        return (
          <TaskRecoverySettingsDialog
            embedded
            onClose={onClose}
            onOpenSession={id => { onClose(); onOpenSession(id); }}
          />
        );
      }
      return (
        <AssistantSettingsDialog
          embedded
          onClose={onClose}
          onOpenMain={onOpenMain}
          onAdopt={onAdopt}
          onOpenSession={id => { onClose(); onOpenSession(id); }}
        />
      );
    }

    if (category === 'lark') {
      if (activeSubTab === 'regex') {
        return (
          <LarkRegexTriggerDialog
            embedded
            onClose={onClose}
            onOpenSession={id => { onClose(); onOpenSession(id); }}
            onOpenLarkSettings={() => navigate('lark', 'bots')}
            onOpenLlmSettings={() => navigate('agent', 'llm')}
          />
        );
      }
      if (activeSubTab === 'avatar') {
        return (
          <div className="min-h-0 flex-1 overflow-hidden">
            <LarkAvatarPanel/>
          </div>
        );
      }
      return (
        <LarkConfigPanel
          embedded
          agents={agents}
          onClose={onClose}
          onOpenRegexTriggers={() => navigate('lark', 'regex')}
        />
      );
    }

    return (
      <NotificationSettingsDialog
        embedded
        onClose={onClose}
        onOpenLarkSettings={() => navigate('lark', 'bots')}
      />
    );
  };

  return (
    <div
      className="ui-overlay ui-overlay-sheet fixed inset-0 z-[60] grid place-items-center bg-zinc-950/35 p-0 md:p-4"
      onMouseDown={event => { if (event.currentTarget === event.target) onClose(); }}
    >
      <div
        ref={panelRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-labelledby="settings-center-title"
        data-testid="settings-center-dialog"
        className="ui-dialog flex h-[100dvh] w-full max-w-none flex-col overflow-hidden rounded-none border-0 border-zinc-200 bg-white text-zinc-900 shadow-[0_28px_90px_rgba(0,0,0,.28)] outline-none md:h-[min(800px,calc(100dvh-2rem))] md:w-[min(1140px,calc(100vw-2rem))] md:flex-row md:rounded-2xl md:border"
      >
        {/* ==================== 桌面 / 平板横屏：左侧导航栏 ==================== */}
        <aside
          aria-label={L('设置导航', 'Settings Navigation')}
          className="hidden w-[256px] shrink-0 flex-col border-r border-zinc-200/80 bg-rail md:flex lg:w-[292px]"
        >
          <div className="flex items-center gap-2.5 px-4 pb-3 pt-4">
            <span className="grid h-8 w-8 shrink-0 place-items-center rounded-xl bg-accent-soft text-accent ring-1 ring-inset ring-zinc-200/70">
              <Settings size={16}/>
            </span>
            <div className="min-w-0">
              <h2 id="settings-center-title" className="truncate text-[15px] font-semibold tracking-[-.01em] text-zinc-900">
                {t('settings.center.title')}
              </h2>
              <p className="truncate text-[11px] text-zinc-500">{L('5 大分类 · 全局配置', '5 Categories · Global Config')}</p>
            </div>
          </div>

          {/* 顶部关键字搜索 */}
          <div className="px-3 pb-3">
            <div className="ui-field-within relative flex h-8 items-center rounded-lg border border-zinc-200/90 bg-white px-2.5">
              <Search size={13} className="shrink-0 text-zinc-400"/>
              <input
                type="text"
                data-testid="settings-search-input"
                value={searchQuery}
                onChange={event => setSearchQuery(event.target.value)}
                onKeyDown={handleSearchKeyDown}
                placeholder={t('settings.center.searchPlaceholder')}
                aria-label={t('settings.center.searchAria')}
                className="min-w-0 flex-1 bg-transparent pl-2 pr-1 text-[12px] text-zinc-900 placeholder:text-zinc-400"
              />
              {searchQuery && (
                <HoverTooltip content={t('settings.center.clearSearchAria')}>
                  <button
                    type="button"
                    aria-label={t('settings.center.clearSearchAria')}
                    onClick={() => setSearchQuery('')}
                    className="grid h-5 w-5 shrink-0 place-items-center rounded text-zinc-400 hover:bg-zinc-100 hover:text-zinc-700"
                  >
                    <X size={11}/>
                  </button>
                </HoverTooltip>
              )}
            </div>
          </div>

          {/* 5 大类主导航 */}
          <nav
            role="tablist"
            aria-label={t('settings.center.navAria')}
            aria-orientation="vertical"
            className="min-h-0 flex-1 space-y-1 overflow-y-auto px-2.5 pb-3"
          >
            {categories.map(cat => {
              const Icon = CATEGORY_ICON[cat.id];
              const active = !searching && category === cat.id;
              return (
                <button
                  key={cat.id}
                  type="button"
                  role="tab"
                  aria-selected={active}
                  data-testid={`settings-nav-${cat.id}`}
                  onClick={() => navigate(cat.id)}
                  className={`ui-press relative flex h-10 w-full min-w-0 items-center gap-2 rounded-xl px-2.5 text-left text-[12.5px] transition-colors ${
                    active
                      ? 'bg-white font-semibold text-zinc-900 shadow-[0_1px_2px_rgba(0,0,0,.05)] ring-1 ring-zinc-200/90'
                      : 'font-medium text-zinc-600 hover:bg-white/70 hover:text-zinc-900'
                  }`}
                >
                  {active && (
                    <span
                      aria-hidden="true"
                      className="absolute left-1 top-1/2 h-4 w-[3px] -translate-y-1/2 rounded-full bg-accent"
                    />
                  )}
                  <Icon size={15} className={`shrink-0 ${active ? 'text-accent' : 'text-zinc-400'}`}/>
                  <span className="min-w-0 flex-1 truncate">{cat.label}</span>
                  {renderCategoryBadge(cat.id, active)}
                </button>
              );
            })}
          </nav>

          {/* 侧栏底部快捷工具 */}
          <div className="mt-auto border-t border-zinc-200/75 px-3 py-2.5">
            <div className="grid grid-cols-2 gap-1.5">
              <HoverTooltip content={t('settings.center.footer.usageTooltip')} side="top">
                <button
                  type="button"
                  data-testid="settings-footer-usage"
                  onClick={() => triggerQuickAction('usage')}
                  className="ui-press flex h-8 min-w-0 items-center justify-center gap-1.5 rounded-lg border border-zinc-200/80 bg-white px-2 text-[11.5px] font-medium text-zinc-600 transition-colors hover:bg-zinc-50 hover:text-zinc-900"
                >
                  <BarChart3 size={13} className="shrink-0 text-zinc-400"/>
                  <span className="truncate">{t('settings.center.footer.usage')}</span>
                </button>
              </HoverTooltip>
              <HoverTooltip content={archivedCount > 0 ? t('settings.center.footer.archivedTooltip', { count: archivedCount }) : L('归档会话（查看或找回已归档对话）', 'Archived Sessions (Browse or restore archived chats)')} side="top">
                <button
                  type="button"
                  data-testid="settings-footer-archived"
                  onClick={() => triggerQuickAction('archived')}
                  className="ui-press flex h-8 min-w-0 items-center justify-center gap-1.5 rounded-lg border border-zinc-200/80 bg-white px-2 text-[11.5px] font-medium text-zinc-600 transition-colors hover:bg-zinc-50 hover:text-zinc-900"
                >
                  <Archive size={13} className="shrink-0 text-zinc-400"/>
                  <span className="truncate">{t('settings.center.footer.archived')}</span>
                  {archivedCount > 0 && (
                    <span className="shrink-0 text-[10.5px] tabular-nums text-zinc-400">{archivedCount}</span>
                  )}
                </button>
              </HoverTooltip>
            </div>
          </div>
        </aside>

        {/* ==================== 移动端：顶部标题 + 搜索 + 横向分类 Tabs ==================== */}
        <div className="flex shrink-0 flex-col border-b border-zinc-200/80 bg-rail pt-[env(safe-area-inset-top,0px)] md:hidden">
          <div className="flex items-center justify-between gap-2 px-3.5 pb-2 pt-2.5">
            <div className="flex min-w-0 items-center gap-2">
              <span className="grid h-7 w-7 shrink-0 place-items-center rounded-lg bg-accent-soft text-accent">
                <Settings size={14}/>
              </span>
              <h2 className="truncate text-[15px] font-semibold text-zinc-900">{t('settings.center.title')}</h2>
            </div>
            <HoverTooltip content={L('关闭设置中心（Esc）', 'Close Settings Center (Esc)')} side="bottom" align="end" hoverOnly>
              <button
                type="button"
                onClick={onClose}
                aria-label={t('settings.center.closeAria')}
                className="ui-press grid h-8 w-8 shrink-0 place-items-center rounded-lg text-zinc-500 hover:bg-zinc-100 hover:text-zinc-900"
              >
                <X size={16}/>
              </button>
            </HoverTooltip>
          </div>

          <div className="px-3 pb-2">
            <div className="ui-field-within relative flex h-9 items-center rounded-lg border border-zinc-200 bg-white px-2.5">
              <Search size={13} className="shrink-0 text-zinc-400"/>
              <input
                type="text"
                data-testid="settings-search-input-mobile"
                value={searchQuery}
                onChange={event => setSearchQuery(event.target.value)}
                onKeyDown={handleSearchKeyDown}
                placeholder={t('settings.center.searchMobilePlaceholder')}
                aria-label={t('settings.center.searchAria')}
                className="min-w-0 flex-1 bg-transparent pl-2 pr-1 text-[12.5px] text-zinc-900 placeholder:text-zinc-400"
              />
              {searchQuery && (
                <HoverTooltip content={t('settings.center.clearSearchAria')} side="bottom">
                  <button
                    type="button"
                    aria-label={t('settings.center.clearSearchAria')}
                    onClick={() => setSearchQuery('')}
                    className="grid h-5 w-5 shrink-0 place-items-center rounded text-zinc-400 hover:bg-zinc-100 hover:text-zinc-700"
                  >
                    <X size={12}/>
                  </button>
                </HoverTooltip>
              )}
            </div>
          </div>

          <div
            ref={mobileTabsRef}
            role="tablist"
            aria-label={t('settings.center.navAria')}
            className="flex min-w-0 max-w-full items-center gap-1 overflow-x-auto px-3 pb-2 no-scrollbar"
          >
            {categories.map(cat => {
              const Icon = CATEGORY_ICON[cat.id];
              const active = !searching && category === cat.id;
              return (
                <button
                  key={cat.id}
                  type="button"
                  role="tab"
                  aria-selected={active}
                  data-testid={`settings-mobile-nav-${cat.id}`}
                  onClick={() => navigate(cat.id)}
                  className={`ui-press flex h-8 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-lg px-2.5 text-[12px] transition-colors ${
                    active
                      ? 'bg-accent font-medium text-accent-fg shadow-sm'
                      : 'border border-zinc-200/80 bg-white text-zinc-600'
                  }`}
                >
                  <Icon size={13} className="shrink-0"/>
                  <span>{cat.mobileLabel}</span>
                </button>
              );
            })}
          </div>
        </div>

        {/* ==================== 右侧内容区 ==================== */}
        <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-white">
          {/* 桌面 / 平板横屏内容顶栏 */}
          <header className="hidden shrink-0 items-center justify-between gap-3 border-b border-zinc-100 px-5 py-3 md:flex">
            <div className="min-w-0 flex-1">
              {searching ? (
                <>
                  <h3 className="truncate text-[15px] font-semibold text-zinc-900">
                    {L(`搜索结果：${searchQuery.trim()}`, `Search Results: ${searchQuery.trim()}`)}
                  </h3>
                  <p className="mt-0.5 truncate text-[12px] text-zinc-500">
                    {L(`找到 ${searchResults.length} 项匹配设置，回车或点击直达对应面板`, `Found ${searchResults.length} matching setting(s) — press Enter or click to jump`)}
                  </p>
                </>
              ) : (
                <>
                  <h3 className="truncate text-[15px] font-semibold text-zinc-900">
                    {activeCategoryMeta.label}
                  </h3>
                  <p className="mt-0.5 truncate text-[12px] text-zinc-500">
                    {activeCategoryMeta.description}
                  </p>
                </>
              )}
            </div>
            <HoverTooltip content={L('关闭设置中心（Esc）', 'Close Settings Center (Esc)')} hoverOnly>
              <button
                type="button"
                onClick={onClose}
                aria-label={t('settings.center.closeAria')}
                className="ui-press grid h-8 w-8 shrink-0 place-items-center rounded-lg text-zinc-400 transition-colors hover:bg-zinc-100 hover:text-zinc-900"
              >
                <X size={16}/>
              </button>
            </HoverTooltip>
          </header>

          {/* 分类内子 Tab 条（非搜索态且包含多个子面板时展示） */}
          {!searching && activeCategoryMeta.subTabs.length > 1 && (
            <div
              ref={subTabsRef}
              role="tablist"
              aria-label={L(`${activeCategoryMeta.label}子分类`, `${activeCategoryMeta.label} sub-tabs`)}
              data-testid={`settings-subtabs-${category}`}
              className="flex min-w-0 max-w-full shrink-0 items-center gap-1 overflow-x-auto border-b border-zinc-100 bg-zinc-50/65 px-3 py-2 no-scrollbar md:px-5"
            >
              {activeCategoryMeta.subTabs.map(tab => {
                const Icon = subTabIcon(tab.id);
                const active = activeSubTab === tab.id;
                return (
                  <button
                    key={tab.id}
                    type="button"
                    role="tab"
                    aria-selected={active}
                    data-testid={`settings-subtab-${tab.id}`}
                    onClick={() => navigate(category, tab.id)}
                    className={`ui-press flex h-8 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-lg px-2.5 text-[12px] font-medium transition-all md:px-3 md:text-[12.5px] ${
                      active
                        ? 'bg-white text-zinc-900 shadow-[0_1px_2px_rgba(0,0,0,.06)] ring-1 ring-zinc-200/90'
                        : 'text-zinc-500 hover:bg-white/65 hover:text-zinc-800'
                    }`}
                  >
                    <Icon size={13} className={`shrink-0 ${active ? 'text-accent' : 'text-zinc-400'}`}/>
                    <span className="sm:hidden">{tab.mobileLabel ?? tab.label}</span>
                    <span className="hidden sm:inline">{tab.label}</span>
                    {renderSubTabBadge(tab.id)}
                  </button>
                );
              })}
            </div>
          )}

          {/* 主面板区域：搜索结果 OR 对应分类内嵌面板 */}
          {searching ? (
            <div
              data-testid="settings-search-results"
              className="ui-view-fade min-h-0 flex-1 overflow-y-auto overflow-x-hidden px-4 py-4 pb-[max(1.25rem,env(safe-area-inset-bottom))] sm:px-6"
            >
              <div className="mx-auto max-w-2xl">
                <div className="mb-3 flex items-center justify-between gap-2 md:hidden">
                  <span className="text-[12px] font-medium text-zinc-500">
                    {L(`找到 ${searchResults.length} 项匹配设置`, `Found ${searchResults.length} matching setting(s)`)}
                  </span>
                  <button
                    type="button"
                    onClick={() => setSearchQuery('')}
                    className="text-[12px] font-medium text-accent hover:underline"
                  >
                    {t('settings.center.clearSearchAria')}
                  </button>
                </div>
                {searchResults.length > 0 ? (
                  <div className="space-y-2">
                    {searchResults.map((item, idx) => {
                      const Icon = searchItemIcon(item);
                      const catMeta = categoryMap[item.category];
                      const highlighted = idx === activeResultIdx;
                      return (
                        <button
                          key={item.id}
                          type="button"
                          data-testid={`settings-search-result-${item.id}`}
                          onMouseEnter={() => setActiveResultIdx(idx)}
                          onClick={() => handleSelectSearchItem(item)}
                          className={`ui-press flex w-full min-w-0 items-center gap-3 rounded-xl border px-3.5 py-3 text-left transition-colors ${
                            highlighted
                              ? 'border-accent/60 bg-accent-soft/45 ring-1 ring-accent/25'
                              : 'border-zinc-200 bg-white hover:border-zinc-300 hover:bg-zinc-50/80'
                          }`}
                        >
                          <span className={`grid h-9 w-9 shrink-0 place-items-center rounded-xl border ${
                            highlighted
                              ? 'border-accent/30 bg-white text-accent'
                              : 'border-zinc-200/80 bg-zinc-50 text-zinc-600'
                          }`}>
                            <Icon size={16}/>
                          </span>
                          <div className="min-w-0 flex-1">
                            <div className="flex flex-wrap items-center gap-1.5">
                              <span className="truncate text-[13.5px] font-semibold text-zinc-900">{item.title}</span>
                              <span className="shrink-0 rounded-full border border-zinc-200 bg-zinc-50 px-2 py-px text-[10.5px] font-medium text-zinc-500">
                                {catMeta.label}
                              </span>
                            </div>
                            <p className="mt-0.5 truncate text-[12px] text-zinc-500">{item.description}</p>
                          </div>
                          <ArrowRight size={14} className={`shrink-0 transition-transform ${highlighted ? 'translate-x-0.5 text-accent' : 'text-zinc-400'}`}/>
                        </button>
                      );
                    })}
                  </div>
                ) : (
                  <div className="flex flex-col items-center justify-center rounded-2xl border border-dashed border-zinc-200 bg-zinc-50/50 px-6 py-12 text-center">
                    <span className="grid h-11 w-11 place-items-center rounded-2xl bg-zinc-100 text-zinc-400">
                      <Search size={18}/>
                    </span>
                    <div className="mt-3 text-[13.5px] font-semibold text-zinc-800">{t('settings.center.searchEmptyTitle', { query: searchQuery.trim() })}</div>
                    <p className="mt-1 max-w-sm text-[12px] leading-5 text-zinc-500">
                      {t('settings.center.searchEmptyHint')}
                    </p>
                    <div className="mt-4 flex flex-wrap justify-center gap-1.5">
                      {suggestedTags.map(tag => (
                        <button
                          key={tag}
                          type="button"
                          onClick={() => setSearchQuery(tag)}
                          className="ui-press rounded-full border border-zinc-200 bg-white px-2.5 py-1 text-[11.5px] font-medium text-zinc-600 hover:border-zinc-300 hover:bg-zinc-50 hover:text-zinc-900"
                        >
                          {tag}
                        </button>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            </div>
          ) : (
            <div key={`${category}:${activeSubTab}`} className="ui-view-fade flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
              {renderActivePanel()}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
