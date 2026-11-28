import { Monitor, Moon, Palette, Sun } from 'lucide-react';
import { BUILTIN_DARK_THEME_ID, BUILTIN_LIGHT_THEME_ID, localizeThemeDisplay, type Locale } from '@agent-dock/agent-dock-shared';
import { HoverTooltip, type TooltipSide } from './HoverTooltip';
import { getCurrentLocale, tWeb, useLocale, useT } from './i18n';
import { setThemeMode, useActiveTheme, useResolvedTheme, useThemeMode, type ThemeMode } from './theme';

const optionModes: Array<{ mode: ThemeMode; labelKey: 'theme.mode.light' | 'theme.mode.system' | 'theme.mode.dark'; icon: typeof Sun }> = [
  { mode: 'light', labelKey: 'theme.mode.light', icon: Sun },
  { mode: 'system', labelKey: 'theme.mode.system', icon: Monitor },
  { mode: 'dark', labelKey: 'theme.mode.dark', icon: Moon }
];

// 按 2:3:2（共 7 份）分配三列宽度，给四字的「跟随系统」/ "System" 充足空间；
// 即使在 220px 窄侧栏下三项也能单行舒展、左右视觉留白均衡，绝不折行。
const THUMB_METRICS = [
  { left: 'calc(2px + (100% - 4px) * 0)', width: 'calc((100% - 4px) * 2 / 7)' },
  { left: 'calc(2px + (100% - 4px) * 2 / 7)', width: 'calc((100% - 4px) * 3 / 7)' },
  { left: 'calc(2px + (100% - 4px) * 5 / 7)', width: 'calc((100% - 4px) * 2 / 7)' }
] as const;

/** 设置菜单里的三档主题切换；独立使用时可选附带调色盘快捷入口直达「主题工坊」。 */
export function ThemeSegmented({ onOpenStudio }: { onOpenStudio?(): void }) {
  const mode = useThemeMode();
  const activeTheme = useActiveTheme();
  const locale = useLocale();
  const t = useT();
  const localizedActiveTheme = localizeThemeDisplay(activeTheme, locale);
  const index = Math.max(0, optionModes.findIndex(option => option.mode === mode));
  const thumb = THUMB_METRICS[index] ?? THUMB_METRICS[0];
  const isCustomOrCurated = activeTheme.id !== BUILTIN_LIGHT_THEME_ID && activeTheme.id !== BUILTIN_DARK_THEME_ID;

  return (
    <div className="flex min-w-0 items-center gap-1.5">
      <div
        role="radiogroup"
        aria-label={t('theme.ariaGroup')}
        className="relative grid min-w-0 flex-1 grid-cols-[minmax(0,2fr)_minmax(0,3fr)_minmax(0,2fr)] rounded-lg bg-zinc-100 p-0.5 dark:bg-canvas"
      >
        <span
          aria-hidden="true"
          className="pointer-events-none absolute inset-y-0.5 rounded-md bg-white shadow-sm ring-1 ring-zinc-200 transition-[left,width] duration-[180ms] ease-[var(--ease-out-expo)] dark:bg-elevated dark:ring-zinc-300/70"
          style={{ left: thumb.left, width: thumb.width }}
        />
        {optionModes.map(({ mode: value, labelKey, icon: Icon }) => {
          const label = t(labelKey);
          return (
            <button
              key={value}
              type="button"
              role="radio"
              aria-checked={mode === value}
              aria-label={label}
              onClick={() => setThemeMode(value)}
              className={`relative z-10 flex h-7 min-w-0 items-center justify-center gap-[3px] whitespace-nowrap rounded-md px-0.5 text-[12px] leading-none transition-colors active:scale-[.98] ${mode === value ? 'font-medium text-zinc-900' : 'text-zinc-500 hover:text-zinc-800'}`}
            >
              <Icon size={12} className="shrink-0"/>
              <span>{label}</span>
            </button>
          );
        })}
      </div>
      {onOpenStudio && (
        <HoverTooltip content={t('theme.studio.openTooltip', { name: localizedActiveTheme.name })} side="top">
          <button
            type="button"
            aria-label={t('theme.studio.openAria')}
            data-testid="theme-studio-quick-trigger"
            onClick={onOpenStudio}
            className="ui-press relative grid h-8 w-8 shrink-0 place-items-center rounded-lg border border-zinc-200 bg-white text-zinc-600 hover:bg-zinc-100 hover:text-zinc-900"
          >
            <Palette size={14}/>
            {isCustomOrCurated && (
              <span
                aria-hidden="true"
                className="pointer-events-none absolute right-1 top-1 h-1.5 w-1.5 rounded-full ring-1 ring-white"
                style={{ backgroundColor: activeTheme.tokens.accent }}
              />
            )}
          </button>
        </HoverTooltip>
      )}
    </div>
  );
}

/** 生成主题速切按钮的清晰 Hover Tooltip：标明当前主题状态与点击切换目标。 */
export function quickThemeTooltipLabel(
  mode: ThemeMode,
  resolved: 'light' | 'dark',
  activeThemeName: string,
  locale: Locale = getCurrentLocale()
): string {
  const nextLabel = resolved === 'dark' ? tWeb('theme.mode.light', undefined, locale) : tWeb('theme.mode.dark', undefined, locale);
  if (mode === 'system') {
    return tWeb('theme.quick.tooltipSystem', { name: activeThemeName, next: nextLabel }, locale);
  }
  return tWeb('theme.quick.tooltipFixed', { name: activeThemeName, next: nextLabel }, locale);
}

/** 极简浅/暗一键切换图标按钮：用于侧栏左下角与收起态细条，不占多余空间。 */
export function QuickThemeToggleButton({ compact = false, side = 'top' }: { compact?: boolean; side?: TooltipSide }) {
  const mode = useThemeMode();
  const resolved = useResolvedTheme();
  const activeTheme = useActiveTheme();
  const locale = useLocale();
  const t = useT();
  const localizedName = localizeThemeDisplay(activeTheme, locale).name;
  const nextMode: ThemeMode = resolved === 'dark' ? 'light' : 'dark';
  const tooltip = quickThemeTooltipLabel(mode, resolved, localizedName, locale);
  const ariaLabel = nextMode === 'dark' ? t('theme.quick.ariaDark') : t('theme.quick.ariaLight');

  return (
    <HoverTooltip content={tooltip} side={side}>
      <button
        type="button"
        data-testid="quick-theme-toggle"
        aria-label={ariaLabel}
        onClick={() => setThemeMode(nextMode)}
        className={`ui-press grid shrink-0 place-items-center rounded-lg transition-colors ${
          compact
            ? 'h-8 w-8 text-zinc-500 hover:bg-white hover:text-zinc-900'
            : 'h-9 w-9 text-zinc-600 hover:bg-zinc-100 hover:text-zinc-900 md:h-8 md:w-8'
        }`}
      >
        {resolved === 'dark' ? <Sun size={compact ? 15 : 16}/> : <Moon size={compact ? 15 : 16}/>}
      </button>
    </HoverTooltip>
  );
}
