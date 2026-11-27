import { Monitor, Moon, Palette, Sun } from 'lucide-react';
import { BUILTIN_DARK_THEME_ID, BUILTIN_LIGHT_THEME_ID } from '@agent-dock/agent-dock-shared';
import { HoverTooltip } from './HoverTooltip';
import { setThemeMode, useActiveTheme, useThemeMode, type ThemeMode } from './theme';

const options: Array<{ mode: ThemeMode; label: string; icon: typeof Sun }> = [
  { mode: 'light', label: '浅色', icon: Sun },
  { mode: 'system', label: '跟随系统', icon: Monitor },
  { mode: 'dark', label: '深色', icon: Moon }
];

/** 设置菜单里的三档主题切换，旁附轻巧调色盘快捷入口直达「主题工坊」。 */
export function ThemeSegmented({ onOpenStudio }: { onOpenStudio?(): void }) {
  const mode = useThemeMode();
  const activeTheme = useActiveTheme();
  const index = Math.max(0, options.findIndex(option => option.mode === mode));
  const isCustomOrCurated = activeTheme.id !== BUILTIN_LIGHT_THEME_ID && activeTheme.id !== BUILTIN_DARK_THEME_ID;

  return (
    <div className="flex items-center gap-1.5">
      <div role="radiogroup" aria-label="主题" className="relative grid flex-1 grid-cols-3 rounded-lg bg-zinc-100 p-0.5">
        <span
          aria-hidden="true"
          className="ui-segmented-thumb absolute inset-y-0.5 left-0.5 w-[calc((100%-4px)/3)] rounded-md bg-white shadow-sm ring-1 ring-zinc-200"
          style={{ transform: `translateX(${index * 100}%)` }}
        />
        {options.map(({ mode: value, label, icon: Icon }) => (
          <button
            key={value}
            type="button"
            role="radio"
            aria-checked={mode === value}
            aria-label={label}
            onClick={() => setThemeMode(value)}
            className={`relative z-10 flex h-7 items-center justify-center gap-1 rounded-md text-[12px] transition-colors active:scale-[.98] ${mode === value ? 'text-zinc-900' : 'text-zinc-400 hover:text-zinc-600'}`}
          >
            <Icon size={13}/>{label}
          </button>
        ))}
      </div>
      {onOpenStudio && (
        <HoverTooltip content={`打开主题工坊（当前：${activeTheme.name}）`} side="top">
          <button
            type="button"
            aria-label="打开主题工坊"
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
