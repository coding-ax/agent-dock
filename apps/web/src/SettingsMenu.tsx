import { useQuery } from '@tanstack/react-query';
import type { Locale } from '@agent-dock/agent-dock-shared';
import { Settings, Smartphone } from 'lucide-react';
import { api, type LarkConfig } from './api';
import { resolveDesktopUpdateBadge, useDesktopUpdate } from './desktop-update';
import { HoverTooltip } from './HoverTooltip';
import { getCurrentLocale, tWeb, useLocale, useT } from './i18n';
import { LarkQuickTriggerButton } from './LarkIcon';
import { Spinner } from './Loaders';
import { SelfUpdateWatcher } from './SelfUpdateNotice';
import {
  resolveServerUpdateBadge,
  SELF_UPDATE_QUERY_KEY,
  SELF_UPDATE_REFETCH_INTERVAL_MS,
  useSelfUpdateClientState,
  type UpdateBadgeState
} from './self-update-progress';
import { QuickThemeToggleButton } from './ThemeToggle';

/** 生成左下角「设置」入口的 Hover Tooltip，同步呈现版本升级状态。 */
export function settingsCenterTooltipLabel(
  updateBadge: UpdateBadgeState | null | undefined,
  locale: Locale = getCurrentLocale()
): string {
  if (updateBadge === 'available') {
    return tWeb('settings.menu.tooltipAvailable', undefined, locale);
  }
  if (updateBadge === 'updating') {
    return tWeb('settings.menu.tooltipUpdating', undefined, locale);
  }
  return tWeb('settings.menu.tooltipDefault', undefined, locale);
}

/**
 * 侧栏底部极简设置入口：
 * - 点击「设置」直达统一「设置中心」模态大窗（不再弹出 15+ 项狭长菜单）；
 * - 同步展示服务端/桌面端更新徽标（「有新版本」/「正在更新…」），并常驻后台升级轮询守卫；
 * - 右侧保留 3 枚高频快捷图标：飞书与协同直达、浅/暗外观速切、手机扫码访问，全量统一 HoverTooltip。
 */
export function SettingsMenu({ webDenied, larkConfig, onOpenSettings, onOpenLark, onShare }: {
  webDenied: boolean;
  larkConfig?: Pick<LarkConfig, 'bots' | 'listeningDisabled'>;
  onOpenSettings(): void;
  onOpenLark(): void;
  onShare(): void;
}) {
  const locale = useLocale();
  const t = useT();
  const desktopUpdate = useDesktopUpdate();
  const selfUpdateClient = useSelfUpdateClientState();
  const update = useQuery({
    queryKey: SELF_UPDATE_QUERY_KEY,
    queryFn: () => api.selfUpdateStatus(),
    enabled: !webDenied && !desktopUpdate.api,
    retry: false,
    refetchInterval: SELF_UPDATE_REFETCH_INTERVAL_MS,
    refetchOnWindowFocus: false
  });
  const updateBadge = desktopUpdate.api
    ? resolveDesktopUpdateBadge(desktopUpdate.state, desktopUpdate.installing)
    : resolveServerUpdateBadge(update.data, selfUpdateClient);
  const settingsTooltip = settingsCenterTooltipLabel(updateBadge, locale);

  return (
    <div
      data-testid="settings-footer-bar"
      className="flex w-full min-w-0 items-center gap-1 border-t border-zinc-200 p-2 md:gap-0.5"
    >
      <SelfUpdateWatcher enabled={!webDenied}/>
      <HoverTooltip content={settingsTooltip} side="top" align="start">
        <button
          type="button"
          data-testid="settings-center-trigger"
          aria-haspopup="dialog"
          onClick={onOpenSettings}
          className="ui-press flex h-9 min-w-0 flex-1 items-center gap-1.5 rounded-lg px-2 text-[13.5px] font-medium text-zinc-600 transition-colors hover:bg-zinc-100 hover:text-zinc-900 md:h-8"
        >
          <Settings size={16} className="shrink-0"/>
          <span className="truncate whitespace-nowrap">{t('settings.menu.label')}</span>
          {updateBadge === 'updating' && (
            <span className="ml-auto flex shrink-0 items-center gap-1 whitespace-nowrap text-[11.5px] font-normal text-zinc-500">
              <Spinner size={12} label={t('settings.menu.updatingAria')} className="text-zinc-500"/>
              <span className="truncate">{t('settings.menu.updating')}</span>
            </span>
          )}
          {updateBadge === 'available' && (
            <span className="ml-auto flex shrink-0 items-center gap-1 whitespace-nowrap text-[11.5px] font-normal text-emerald-600">
              <span className="h-1.5 w-1.5 rounded-full bg-emerald-500 ui-status-pulse"/>
              {t('settings.menu.updateAvailable')}
            </span>
          )}
        </button>
      </HoverTooltip>
      <LarkQuickTriggerButton larkConfig={larkConfig} onClick={onOpenLark} side="top" testId="settings-lark-trigger"/>
      <QuickThemeToggleButton side="top"/>
      <HoverTooltip content={t('settings.menu.shareTooltip')} side="top">
        <button
          type="button"
          data-testid="settings-share-trigger"
          onClick={onShare}
          aria-label={t('settings.menu.shareAria')}
          className="ui-press grid h-9 w-9 shrink-0 place-items-center rounded-lg text-zinc-600 transition-colors hover:bg-zinc-100 hover:text-zinc-900 md:h-8 md:w-8"
        >
          <Smartphone size={16}/>
        </button>
      </HoverTooltip>
    </div>
  );
}
