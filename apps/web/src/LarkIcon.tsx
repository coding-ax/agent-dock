import type { Locale } from '@agent-dock/agent-dock-shared';
import type { LarkConfig } from './api';
import { HoverTooltip, type TooltipSide } from './HoverTooltip';
import { getCurrentLocale, tWeb, useLocale, useT } from './i18n';

/**
 * 飞书（Lark）极简线性双翼图标：
 * - 统一使用 `currentColor` + 1.8px 描边，与 Lucide 图标（Settings / Sun / Moon / Smartphone）保持一致的光学重量；
 * - 完美适配亮色、暗色及全部 20 套自定义主题。
 */
export function LarkIcon({ size = 16, className = '' }: { size?: number; className?: string }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      data-lark-icon=""
      className={`shrink-0 ${className}`}
    >
      <path d="M4.2 4.6 13.8 10.1 20.1 8.7c-1.3 6.5-4.7 10.5-8.5 10.5-4.4 0-7-5.9-7.4-14.6Z"/>
      <path d="M13.8 10.1c-2.3 1.9-3.7 4.7-4.1 8.7"/>
    </svg>
  );
}

export interface LarkQuickEntrySummary {
  tooltip: string;
  statusTone: 'online' | 'paused' | 'configured' | 'none';
  statusLabel?: string;
  dotClass?: string;
}

/**
 * 汇总飞书快捷入口的 Hover Tooltip 文案与轻巧状态指示点样式。
 * 指示点全部选用暗色模式已映射的语义色（emerald / amber / sky）。
 */
export function summarizeLarkQuickEntry(
  config?: Pick<LarkConfig, 'bots' | 'listeningDisabled'>,
  locale: Locale = getCurrentLocale()
): LarkQuickEntrySummary {
  const hint = tWeb('lark.quick.hint', undefined, locale);
  const bots = config?.bots ?? [];
  const totalBots = bots.length;
  if (totalBots === 0) {
    return {
      tooltip: tWeb('lark.quick.tooltipEmpty', { hint }, locale),
      statusTone: 'none'
    };
  }

  const activeBots = bots.filter(bot => bot.activeListening).length;
  if (config?.listeningDisabled) {
    return {
      tooltip: tWeb('lark.quick.tooltipPaused', { total: totalBots, hint }, locale),
      statusTone: 'paused',
      statusLabel: tWeb('lark.quick.statusPaused', undefined, locale),
      dotClass: 'bg-amber-500'
    };
  }

  if (activeBots > 0) {
    const onlinePart = activeBots === totalBots
      ? tWeb('lark.quick.onlineAll', { total: totalBots }, locale)
      : tWeb('lark.quick.onlinePartial', { active: activeBots, total: totalBots }, locale);
    return {
      tooltip: tWeb('lark.quick.tooltipOnline', { online: onlinePart, hint }, locale),
      statusTone: 'online',
      statusLabel: onlinePart,
      dotClass: 'bg-emerald-500'
    };
  }

  return {
    tooltip: tWeb('lark.quick.tooltipConfigured', { total: totalBots, hint }, locale),
    statusTone: 'configured',
    statusLabel: tWeb('lark.quick.statusConfigured', { total: totalBots }, locale),
    dotClass: 'bg-sky-500'
  };
}

/**
 * 飞书快捷设置图标按钮：同时服务于侧栏展开态左下角底栏与收起态细条。
 * 点击直达统一设置中心的「飞书与协同」分类。
 */
export function LarkQuickTriggerButton({
  larkConfig,
  onClick,
  compact = false,
  side = 'top',
  testId = 'settings-lark-trigger'
}: {
  larkConfig?: Pick<LarkConfig, 'bots' | 'listeningDisabled'>;
  onClick(): void;
  compact?: boolean;
  side?: TooltipSide;
  testId?: string;
}) {
  const locale = useLocale();
  const t = useT();
  const summary = summarizeLarkQuickEntry(larkConfig, locale);

  return (
    <HoverTooltip content={summary.tooltip} side={side}>
      <button
        type="button"
        data-testid={testId}
        data-lark-status={summary.statusTone}
        aria-label={t('lark.quick.aria')}
        aria-haspopup="dialog"
        onClick={onClick}
        className={`ui-press relative grid shrink-0 place-items-center rounded-lg transition-colors ${
          compact
            ? 'h-8 w-8 text-zinc-500 hover:bg-white hover:text-zinc-900'
            : 'h-9 w-9 text-zinc-600 hover:bg-zinc-100 hover:text-zinc-900 md:h-8 md:w-8'
        }`}
      >
        <LarkIcon size={compact ? 15 : 16}/>
        {summary.dotClass && (
          <span
            aria-hidden="true"
            className={`pointer-events-none absolute right-1.5 top-1.5 h-1.5 w-1.5 rounded-full ring-[1.5px] ring-rail ${summary.dotClass}`}
          />
        )}
      </button>
    </HoverTooltip>
  );
}
