import { useSyncExternalStore } from 'react';

export type ThemeMode = 'system' | 'light' | 'dark';
export type ResolvedTheme = 'light' | 'dark';

const storageKey = 'agentdock:theme';
const listeners = new Set<() => void>();
const media = typeof window !== 'undefined' ? window.matchMedia('(prefers-color-scheme: dark)') : undefined;

export function readThemeMode(): ThemeMode {
  try {
    const value = localStorage.getItem(storageKey);
    return value === 'light' || value === 'dark' ? value : 'system';
  } catch { return 'system'; }
}

export const resolveTheme = (mode: ThemeMode): ResolvedTheme => mode === 'system' ? (media?.matches ? 'dark' : 'light') : mode;

/**
 * 把主题写到 <html data-theme>。全站只用这一套主题变量（见 index.css），
 * 不再支持自定义强调色 / 背景——旧的存储键在启动时清理。
 */
export function applyAppearance() {
  const resolved = resolveTheme(readThemeMode());
  document.documentElement.dataset.theme = resolved;
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', resolved === 'dark' ? '#212121' : '#ffffff');
  listeners.forEach(listener => listener());
}

export function setThemeMode(mode: ThemeMode) {
  try { if (mode === 'system') localStorage.removeItem(storageKey); else localStorage.setItem(storageKey, mode); } catch { /* 隐私模式下不持久化，仅本次生效 */ }
  applyAppearance();
}

media?.addEventListener('change', () => { if (readThemeMode() === 'system') applyAppearance(); });

const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
export const useThemeMode = () => useSyncExternalStore(subscribe, readThemeMode, () => 'system' as ThemeMode);
export const useResolvedTheme = () => useSyncExternalStore(subscribe, () => resolveTheme(readThemeMode()), () => 'light' as ResolvedTheme);
