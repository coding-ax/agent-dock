import { useEffect, useSyncExternalStore } from 'react';
import {
  BUILTIN_DARK_THEME_ID,
  BUILTIN_LIGHT_THEME_ID,
  BUILTIN_THEMES,
  DEFAULT_THEME_PREFERENCES,
  resolveActiveTheme,
  themeToCssVariables,
  type CustomTheme,
  type CustomThemeMode,
  type ThemePreferenceMode,
  type ThemePreferences,
  type ThemesStateSnapshot
} from '@agent-dock/agent-dock-shared';
import { api } from './api';

export type ThemeMode = ThemePreferenceMode;
export type ResolvedTheme = CustomThemeMode;

const LEGACY_STORAGE_KEY = 'agentdock:theme';
const CACHE_STORAGE_KEY = 'agentdock:theme-cache';

interface CachedThemeState {
  themeId: string;
  mode: CustomThemeMode;
  modePreference: ThemePreferenceMode;
  activeLightThemeId: string;
  activeDarkThemeId: string;
  bgCanvas: string;
  vars: Record<string, string>;
}

interface ThemeStoreSnapshot {
  themes: CustomTheme[];
  preferences: ThemePreferences;
  activeTheme: CustomTheme;
  effectiveTheme: CustomTheme;
  resolvedMode: CustomThemeMode;
  previewTheme: CustomTheme | null;
  revision: number;
  loaded: boolean;
}

const listeners = new Set<() => void>();
const media = typeof window !== 'undefined' && typeof window.matchMedia === 'function'
  ? window.matchMedia('(prefers-color-scheme: dark)')
  : undefined;

let themesList: CustomTheme[] = [...BUILTIN_THEMES];
let preferencesState: ThemePreferences = readInitialPreferences();
let previewThemeState: CustomTheme | null = null;
let revisionState = 0;
let loadedState = false;
let appliedVarKeys: string[] = [];
let cachedSnapshot: ThemeStoreSnapshot | null = null;

function systemPolarity(): CustomThemeMode {
  return media?.matches ? 'dark' : 'light';
}

function readCachedState(): CachedThemeState | null {
  try {
    if (typeof localStorage === 'undefined') return null;
    const raw = localStorage.getItem(CACHE_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<CachedThemeState>;
    if (!parsed || typeof parsed !== 'object') return null;
    if (parsed.mode !== 'light' && parsed.mode !== 'dark') return null;
    return parsed as CachedThemeState;
  } catch {
    return null;
  }
}

function readLegacyMode(): ThemePreferenceMode {
  try {
    if (typeof localStorage === 'undefined') return 'system';
    const raw = localStorage.getItem(LEGACY_STORAGE_KEY);
    return raw === 'light' || raw === 'dark' ? raw : 'system';
  } catch {
    return 'system';
  }
}

function readInitialPreferences(): ThemePreferences {
  const cached = readCachedState();
  if (cached) {
    const modePreference: ThemePreferenceMode =
      cached.modePreference === 'light' || cached.modePreference === 'dark' || cached.modePreference === 'system'
        ? cached.modePreference
        : readLegacyMode();
    return {
      modePreference,
      activeThemeId: cached.themeId || BUILTIN_LIGHT_THEME_ID,
      activeLightThemeId: cached.activeLightThemeId || BUILTIN_LIGHT_THEME_ID,
      activeDarkThemeId: cached.activeDarkThemeId || BUILTIN_DARK_THEME_ID
    };
  }
  const legacy = readLegacyMode();
  return {
    ...DEFAULT_THEME_PREFERENCES,
    modePreference: legacy,
    activeThemeId: legacy === 'dark' ? BUILTIN_DARK_THEME_ID : BUILTIN_LIGHT_THEME_ID
  };
}

function writeThemeCache(theme: CustomTheme, preferences: ThemePreferences, vars: Record<string, string>): void {
  try {
    if (typeof localStorage === 'undefined') return;
    if (preferences.modePreference === 'system') {
      localStorage.removeItem(LEGACY_STORAGE_KEY);
    } else {
      localStorage.setItem(LEGACY_STORAGE_KEY, preferences.modePreference);
    }
    const payload: CachedThemeState = {
      themeId: theme.id,
      mode: theme.mode,
      modePreference: preferences.modePreference,
      activeLightThemeId: preferences.activeLightThemeId,
      activeDarkThemeId: preferences.activeDarkThemeId,
      bgCanvas: theme.tokens.bgCanvas,
      vars
    };
    localStorage.setItem(CACHE_STORAGE_KEY, JSON.stringify(payload));
  } catch {
    /* 隐私模式或存储受限时静默忽略，仅本次会话生效 */
  }
}

function buildSnapshot(): ThemeStoreSnapshot {
  const activeTheme = resolveActiveTheme(themesList, preferencesState, systemPolarity());
  const effectiveTheme = previewThemeState ?? activeTheme;
  return {
    themes: themesList,
    preferences: preferencesState,
    activeTheme,
    effectiveTheme,
    resolvedMode: effectiveTheme.mode,
    previewTheme: previewThemeState,
    revision: revisionState,
    loaded: loadedState
  };
}

function notify(): void {
  cachedSnapshot = buildSnapshot();
  for (const listener of listeners) listener();
}

/** 将指定主题的全套语义化 CSS 变量与亮暗属性注入到 :root。 */
export function applyThemeToDocument(theme: CustomTheme, options: { persistCache?: boolean } = {}): void {
  const vars = themeToCssVariables(theme);
  if (typeof document !== 'undefined') {
    const root = document.documentElement;
    const prevThemeId = root.dataset.themeId;
    const modeOrThemeChanged = Boolean(prevThemeId && prevThemeId !== theme.id);
    if (modeOrThemeChanged) {
      root.classList.add('ui-theme-switching');
    }
    root.dataset.theme = theme.mode;
    root.dataset.themeId = theme.id;
    root.style.colorScheme = theme.mode;

    const nextKeys = Object.keys(vars);
    for (const oldKey of appliedVarKeys) {
      if (!(oldKey in vars)) root.style.removeProperty(oldKey);
    }
    for (const [key, value] of Object.entries(vars)) {
      root.style.setProperty(key, value);
    }
    appliedVarKeys = nextKeys;

    if (modeOrThemeChanged) {
      // 强制同步一次样式计算，确保整站所有控件在同一帧原子切色，再解除过渡抑制
      void root.offsetHeight;
      if (typeof requestAnimationFrame === 'function') {
        requestAnimationFrame(() => root.classList.remove('ui-theme-switching'));
      } else {
        root.classList.remove('ui-theme-switching');
      }
    }

    document.querySelector('meta[name="theme-color"]')?.setAttribute('content', theme.tokens.bgCanvas);
  }
  if (options.persistCache !== false && !previewThemeState) {
    writeThemeCache(theme, preferencesState, vars);
  }
}

/** 按当前偏好与系统亮暗立即应用外观到文档并通知订阅者。 */
export function applyAppearance(): void {
  const active = resolveActiveTheme(themesList, preferencesState, systemPolarity());
  const effective = previewThemeState ?? active;
  applyThemeToDocument(effective, { persistCache: !previewThemeState });
  notify();
}

/** 同步来自服务端 GET /api/themes、写接口响应或 SSE 推送的最新主题快照。 */
export function syncThemesSnapshot(snapshot: ThemesStateSnapshot): void {
  if (!snapshot || !Array.isArray(snapshot.themes) || !snapshot.preferences) return;
  themesList = snapshot.themes.length > 0 ? snapshot.themes : [...BUILTIN_THEMES];
  preferencesState = snapshot.preferences;
  revisionState = snapshot.revision ?? revisionState + 1;
  loadedState = true;
  applyAppearance();
}

/** 开启/关闭全站实时预览（调色器、AI 生成、VS Code 导入预览用；关闭弹窗自动回退）。 */
export function setPreviewTheme(theme: CustomTheme | null): void {
  if (previewThemeState === theme) return;
  previewThemeState = theme;
  applyAppearance();
}

/** 读取当前亮暗模式偏好（system / light / dark）。 */
export function readThemeMode(): ThemeMode {
  return preferencesState.modePreference;
}

export function resolveTheme(mode: ThemeMode): ResolvedTheme {
  return mode === 'system' ? systemPolarity() : mode;
}

/** 切换浅色 / 跟随系统 / 深色，记住各模式上次偏好的主题并异步持久化到后端。 */
export function setThemeMode(mode: ThemeMode): void {
  const nextActive = mode === 'light'
    ? preferencesState.activeLightThemeId
    : mode === 'dark'
      ? preferencesState.activeDarkThemeId
      : resolveActiveTheme(themesList, { ...preferencesState, modePreference: 'system' }, systemPolarity()).id;
  preferencesState = {
    ...preferencesState,
    modePreference: mode,
    activeThemeId: nextActive
  };
  applyAppearance();
  if (typeof window !== 'undefined' && typeof fetch === 'function') {
    void api.activateTheme({ modePreference: mode }).then(syncThemesSnapshot).catch(() => undefined);
  }
}

/** 直接激活指定主题（本地乐观切换 + 服务端持久化 + SSE 同步其他标签页）。 */
export async function activateThemeById(themeId: string): Promise<ThemesStateSnapshot> {
  const target = themesList.find(theme => theme.id === themeId);
  if (target) {
    previewThemeState = null;
    preferencesState = {
      ...preferencesState,
      modePreference: target.mode,
      activeThemeId: target.id,
      ...(target.mode === 'light' ? { activeLightThemeId: target.id } : { activeDarkThemeId: target.id })
    };
    applyAppearance();
  }
  const snapshot = await api.activateTheme({ themeId });
  syncThemesSnapshot(snapshot);
  return snapshot;
}

/** 恢复默认主题偏好（跟随系统 + 默认浅色 / 默认深色）。 */
export async function resetThemePreferences(): Promise<ThemesStateSnapshot> {
  previewThemeState = null;
  preferencesState = { ...DEFAULT_THEME_PREFERENCES };
  applyAppearance();
  const snapshot = await api.activateTheme({ reset: true });
  syncThemesSnapshot(snapshot);
  return snapshot;
}

media?.addEventListener('change', () => {
  if (preferencesState.modePreference === 'system') applyAppearance();
});

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
};

const getSnapshot = (): ThemeStoreSnapshot => {
  if (!cachedSnapshot) cachedSnapshot = buildSnapshot();
  return cachedSnapshot;
};

const SERVER_SNAPSHOT: ThemeStoreSnapshot = {
  themes: [...BUILTIN_THEMES],
  preferences: DEFAULT_THEME_PREFERENCES,
  activeTheme: BUILTIN_THEMES[0]!,
  effectiveTheme: BUILTIN_THEMES[0]!,
  resolvedMode: 'light',
  previewTheme: null,
  revision: 0,
  loaded: false
};

export const useThemesState = () => useSyncExternalStore(subscribe, getSnapshot, () => SERVER_SNAPSHOT);
export const useActiveTheme = () => useThemesState().effectiveTheme;
export const useThemeMode = (): ThemeMode => useThemesState().preferences.modePreference;
export const useResolvedTheme = (): ResolvedTheme => useThemesState().resolvedMode;

/**
 * 挂载在 App 根部：首屏拉取服务端持久化主题并订阅 `/api/themes/stream` SSE，
 * 确保 CLI（`agent-dock theme create/import-vscode/apply`）或其他标签页改主题时零刷新瞬时热切换。
 */
export function useThemeSync(options: { enabled?: boolean } = {}): void {
  const enabled = options.enabled !== false;

  useEffect(() => {
    if (!enabled) return;
    let disposed = false;

    const refresh = () => {
      void api.themes().then(snapshot => {
        if (!disposed) syncThemesSnapshot(snapshot);
      }).catch(() => undefined);
    };
    refresh();

    let stream: EventSource | null = null;
    const closeStream = () => {
      stream?.close();
      stream = null;
    };

    if (typeof EventSource !== 'undefined') {
      stream = new EventSource('/api/themes/stream');
      const onThemeUpdated = (event: MessageEvent<string>) => {
        if (disposed || typeof event.data !== 'string' || !event.data) return;
        try {
          const payload = JSON.parse(event.data) as {
            themes?: CustomTheme[];
            preferences?: ThemePreferences;
            revision?: number;
            timestamp?: string;
          };
          if (Array.isArray(payload.themes) && payload.preferences) {
            // 外部 SSE 推来新主题切换时结束临时预览，立刻展示真实生效主题
            previewThemeState = null;
            syncThemesSnapshot({
              themes: payload.themes,
              preferences: payload.preferences,
              revision: payload.revision ?? revisionState + 1,
              updatedAt: payload.timestamp ?? new Date().toISOString()
            });
          } else {
            refresh();
          }
        } catch {
          refresh();
        }
      };
      stream.addEventListener('theme.updated', onThemeUpdated as unknown as EventListener);
      window.addEventListener('agentdock:web-access-denied', closeStream);
      window.addEventListener('focus', refresh);
      return () => {
        disposed = true;
        window.removeEventListener('agentdock:web-access-denied', closeStream);
        window.removeEventListener('focus', refresh);
        stream?.removeEventListener('theme.updated', onThemeUpdated as unknown as EventListener);
        closeStream();
      };
    }

    window.addEventListener('focus', refresh);
    return () => {
      disposed = true;
      window.removeEventListener('focus', refresh);
    };
  }, [enabled]);
}
