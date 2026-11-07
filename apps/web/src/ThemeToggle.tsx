import { Monitor, Moon, Sun } from 'lucide-react';
import { setThemeMode, useThemeMode, type ThemeMode } from './theme';

const options: Array<{ mode: ThemeMode; label: string; icon: typeof Sun }> = [
  { mode: 'light', label: '浅色', icon: Sun },
  { mode: 'system', label: '跟随系统', icon: Monitor },
  { mode: 'dark', label: '深色', icon: Moon }
];

/** 设置菜单里的三档主题切换。选中块用 CSS 滑动，是「推过去」而不是各自变色。 */
export function ThemeSegmented() {
  const mode = useThemeMode();
  const index = options.findIndex(option => option.mode === mode);
  return <div role="radiogroup" aria-label="主题" className="relative grid grid-cols-3 rounded-lg bg-zinc-100 p-0.5">
    <span aria-hidden="true" className="absolute inset-y-0.5 left-0.5 w-[calc((100%-4px)/3)] rounded-md bg-white shadow-sm ring-1 ring-zinc-200 transition-transform duration-200 ease-[cubic-bezier(.2,0,0,1)]" style={{ transform: `translateX(${index * 100}%)` }}/>
    {options.map(({ mode: value, label, icon: Icon }) => <button key={value} type="button" role="radio" aria-checked={mode === value} aria-label={label} title={label} onClick={() => setThemeMode(value)} className={`relative z-10 flex h-7 items-center justify-center gap-1 rounded-md text-[12px] transition-colors ${mode === value ? 'text-zinc-900' : 'text-zinc-400 hover:text-zinc-600'}`}><Icon size={13}/>{label}</button>)}
  </div>;
}
