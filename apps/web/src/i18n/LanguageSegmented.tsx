import type { LocalePreference } from '@agent-dock/agent-dock-shared';
import { setLocalePreference, useLocalePreference, useT } from './store';

const OPTIONS: readonly LocalePreference[] = ['zh-CN', 'en-US', 'system'] as const;

const THUMB_METRICS = [
  { left: 'calc(2px + (100% - 4px) * 0)', width: 'calc((100% - 4px) / 3)' },
  { left: 'calc(2px + (100% - 4px) / 3)', width: 'calc((100% - 4px) / 3)' },
  { left: 'calc(2px + (100% - 4px) * 2 / 3)', width: 'calc((100% - 4px) / 3)' }
] as const;

/**
 * 3-segment Language Switcher (简体中文 / English / 跟随系统|System).
 * Single-line whitespace-nowrap with equal 3-column grid so both zh-CN and en-US fit cleanly with zero overflow.
 */
export function LanguageSegmented() {
  const preference = useLocalePreference();
  const t = useT();
  const index = Math.max(0, OPTIONS.indexOf(preference));
  const thumb = THUMB_METRICS[index] ?? THUMB_METRICS[2];

  const labels: Record<LocalePreference, string> = {
    'zh-CN': t('locale.option.zh'),
    'en-US': t('locale.option.en'),
    system: t('locale.option.system')
  };

  return (
    <div
      role="radiogroup"
      aria-label={t('locale.ariaGroup')}
      data-testid="language-segmented"
      className="relative grid min-w-0 w-full grid-cols-3 rounded-lg bg-zinc-100 p-0.5 dark:bg-canvas"
    >
      <span
        aria-hidden="true"
        className="pointer-events-none absolute inset-y-0.5 rounded-md bg-white shadow-sm ring-1 ring-zinc-200 transition-[left,width] duration-[180ms] ease-[var(--ease-out-expo)] dark:bg-elevated dark:ring-zinc-300/70"
        style={{ left: thumb.left, width: thumb.width }}
      />
      {OPTIONS.map(value => {
        const label = labels[value];
        const active = preference === value;
        return (
          <button
            key={value}
            type="button"
            role="radio"
            data-testid={`language-option-${value}`}
            aria-checked={active}
            aria-label={label}
            onClick={() => setLocalePreference(value)}
            className={`relative z-10 flex h-7 min-w-0 items-center justify-center whitespace-nowrap rounded-md px-1 text-[12px] leading-none transition-colors active:scale-[.98] ${
              active ? 'font-medium text-zinc-900' : 'text-zinc-500 hover:text-zinc-800'
            }`}
          >
            <span className="truncate">{label}</span>
          </button>
        );
      })}
    </div>
  );
}
