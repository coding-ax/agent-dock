import { useSyncExternalStore } from 'react';

/** 与 AgentDock 控制台同一思路：<html data-theme>，没手动选过就跟随系统。 */
export type Theme = 'light' | 'dark';

const storageKey = 'agentdock-site:theme';
const listeners = new Set<() => void>();
const media = typeof window !== 'undefined' ? window.matchMedia('(prefers-color-scheme: dark)') : undefined;

function stored(): Theme | null {
  try {
    const value = localStorage.getItem(storageKey);
    return value === 'light' || value === 'dark' ? value : null;
  } catch { return null; }
}

function apply(theme: Theme) {
  const root = document.documentElement;
  if (root.dataset.theme === theme) return;
  // 切换瞬间关掉过渡，避免几百个元素同时渐变造成的拖影。
  root.classList.add('theme-switching');
  root.dataset.theme = theme;
  window.setTimeout(() => root.classList.remove('theme-switching'), 60);
  listeners.forEach(listener => listener());
}

export function setTheme(theme: Theme) {
  try { localStorage.setItem(storageKey, theme); } catch { /* 隐私模式只在本次生效 */ }
  apply(theme);
}

media?.addEventListener('change', event => { if (!stored()) apply(event.matches ? 'dark' : 'light'); });

const read = (): Theme => (document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light');
const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };

export const useTheme = () => useSyncExternalStore(subscribe, read, () => 'light' as Theme);
