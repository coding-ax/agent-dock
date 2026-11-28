import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useSyncExternalStore,
  type ReactNode
} from 'react';
import dayjs from 'dayjs';
import 'dayjs/locale/zh-cn';
import 'dayjs/locale/en';
import {
  createTranslator,
  DEFAULT_LOCALE,
  DEFAULT_LOCALE_PREFERENCE,
  isLocale,
  isLocalePreference,
  resolveLocale,
  type Locale,
  type LocalePreference,
  type LocaleStateSnapshot,
  type TranslationParams
} from '@agent-dock/agent-dock-shared';
import { api } from '../api';
import { webMessages, type WebMessageKey } from './messages';

export const LOCALE_PREF_STORAGE_KEY = 'agentdock:locale';
export const LOCALE_RESOLVED_STORAGE_KEY = 'agentdock:locale-resolved';
const BROADCAST_CHANNEL_NAME = 'agentdock:locale';

interface LocaleStoreSnapshot {
  preference: LocalePreference;
  locale: Locale;
  revision: number;
  loaded: boolean;
}

const listeners = new Set<() => void>();
const translateWeb = createTranslator(webMessages);

function readBrowserLanguages(): readonly string[] | undefined {
  if (typeof window === 'undefined' || typeof navigator === 'undefined') return undefined;
  const langs: string[] = [];
  if (Array.isArray(navigator.languages)) {
    for (const item of navigator.languages) {
      if (typeof item === 'string' && item.trim()) langs.push(item.trim());
    }
  }
  if (typeof navigator.language === 'string' && navigator.language.trim() && !langs.includes(navigator.language.trim())) {
    langs.push(navigator.language.trim());
  }
  return langs.length > 0 ? langs : undefined;
}

function readStoredPreference(): LocalePreference | null {
  try {
    if (typeof localStorage === 'undefined') return null;
    const raw = localStorage.getItem(LOCALE_PREF_STORAGE_KEY);
    return isLocalePreference(raw) ? raw : null;
  } catch {
    return null;
  }
}

function computeEffectiveLocale(preference: LocalePreference): Locale {
  const browserLangs = readBrowserLanguages();
  // In Node/SSR tests (`window === undefined`), keep zh-CN fallback for backward compatibility;
  // in real browsers with non-Chinese system language, resolveLocale('system', browserLangs) returns 'en-US'.
  return resolveLocale(preference, browserLangs, DEFAULT_LOCALE);
}

let preferenceState: LocalePreference = readStoredPreference() ?? DEFAULT_LOCALE_PREFERENCE;
let localeState: Locale = computeEffectiveLocale(preferenceState);
let revisionState = 0;
let loadedState = false;
let localMutationEpoch = 0;
let pendingLocalSaves = 0;
let lastServerRevision = -1;
let cachedSnapshot: LocaleStoreSnapshot | null = null;
let broadcastChannel: BroadcastChannel | null = null;

function applyLocaleToEnvironment(locale: Locale, preference: LocalePreference, options: { persist?: boolean; broadcast?: boolean } = {}): void {
  if (typeof document !== 'undefined') {
    document.documentElement.lang = locale;
  }
  dayjs.locale(locale === 'en-US' ? 'en' : 'zh-cn');
  if (options.persist !== false) {
    try {
      if (typeof localStorage !== 'undefined') {
        localStorage.setItem(LOCALE_PREF_STORAGE_KEY, preference);
        localStorage.setItem(LOCALE_RESOLVED_STORAGE_KEY, locale);
      }
    } catch {
      /* ignore storage errors in private mode */
    }
  }
  if (options.broadcast && typeof BroadcastChannel !== 'undefined') {
    try {
      broadcastChannel ??= new BroadcastChannel(BROADCAST_CHANNEL_NAME);
      broadcastChannel.postMessage({ preference, locale, revision: revisionState });
    } catch {
      /* ignore */
    }
  }
}

function buildSnapshot(): LocaleStoreSnapshot {
  return {
    preference: preferenceState,
    locale: localeState,
    revision: revisionState,
    loaded: loadedState
  };
}

function notify(): void {
  cachedSnapshot = buildSnapshot();
  for (const listener of listeners) listener();
}

// Initialize document lang & dayjs locale once in browser environments.
if (typeof window !== 'undefined') {
  applyLocaleToEnvironment(localeState, preferenceState, { persist: false, broadcast: false });

  window.addEventListener('languagechange', () => {
    if (preferenceState !== 'system') return;
    const next = computeEffectiveLocale('system');
    if (next !== localeState) {
      localeState = next;
      revisionState += 1;
      applyLocaleToEnvironment(localeState, preferenceState, { persist: true, broadcast: true });
      notify();
      if (typeof fetch === 'function') {
        void api.setSystemLocale({ preference: 'system', locale: next }).catch(() => undefined);
      }
    }
  });

  window.addEventListener('storage', event => {
    if (event.key !== LOCALE_PREF_STORAGE_KEY) return;
    const nextPref = isLocalePreference(event.newValue) ? event.newValue : DEFAULT_LOCALE_PREFERENCE;
    const nextLocale = computeEffectiveLocale(nextPref);
    if (nextPref !== preferenceState || nextLocale !== localeState) {
      preferenceState = nextPref;
      localeState = nextLocale;
      revisionState += 1;
      applyLocaleToEnvironment(localeState, preferenceState, { persist: false, broadcast: false });
      notify();
    }
  });

  if (typeof BroadcastChannel !== 'undefined') {
    try {
      broadcastChannel = new BroadcastChannel(BROADCAST_CHANNEL_NAME);
      broadcastChannel.addEventListener('message', event => {
        const data = event.data as { preference?: unknown; locale?: unknown } | null;
        if (!data || !isLocalePreference(data.preference)) return;
        const nextPref = data.preference;
        const nextLocale = nextPref === 'system'
          ? computeEffectiveLocale('system')
          : nextPref;
        if (nextPref !== preferenceState || nextLocale !== localeState) {
          preferenceState = nextPref;
          localeState = nextLocale;
          revisionState += 1;
          applyLocaleToEnvironment(localeState, preferenceState, { persist: true, broadcast: false });
          notify();
        }
      });
    } catch {
      /* ignore BroadcastChannel unsupported environments */
    }
  }
} else {
  dayjs.locale(localeState === 'en-US' ? 'en' : 'zh-cn');
}

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
};

const getSnapshot = (): LocaleStoreSnapshot => {
  if (!cachedSnapshot) cachedSnapshot = buildSnapshot();
  return cachedSnapshot;
};

const SERVER_SNAPSHOT: LocaleStoreSnapshot = {
  preference: DEFAULT_LOCALE_PREFERENCE,
  locale: DEFAULT_LOCALE,
  revision: 0,
  loaded: false
};

/** Synchronous accessor for current effective locale (for pure helpers, toasts, and formatters). */
export function getCurrentLocale(): Locale {
  return localeState;
}

/** Synchronous accessor for current user preference (`system | zh-CN | en-US`). */
export function getCurrentLocalePreference(): LocalePreference {
  return preferenceState;
}

/** Apply snapshot received from server (`GET /api/system/locale`, `PUT`, or SSE). */
export function syncLocaleSnapshot(
  snapshot: LocaleStateSnapshot,
  options: { requestEpoch?: number; source?: 'initial' | 'focus' | 'sse' } = {}
): void {
  if (!snapshot || !isLocalePreference(snapshot.preference)) return;
  // Never let a stale in-flight GET/SSE response clobber a newer user-initiated switch.
  if (pendingLocalSaves > 0) return;
  if (options.requestEpoch !== undefined && options.requestEpoch < localMutationEpoch) return;
  if (
    typeof snapshot.revision === 'number'
    && lastServerRevision >= 0
    && snapshot.revision < lastServerRevision
  ) {
    return;
  }
  loadedState = true;
  if (typeof snapshot.revision === 'number') {
    lastServerRevision = Math.max(lastServerRevision, snapshot.revision);
  }
  if (snapshot.configured === false) {
    // Server has no explicit preference yet: keep local preference if user set one,
    // otherwise keep browser-resolved system preference.
    const localPref = readStoredPreference();
    if (localPref) {
      const nextLocale = computeEffectiveLocale(localPref);
      preferenceState = localPref;
      localeState = nextLocale;
      applyLocaleToEnvironment(localeState, preferenceState, { persist: true, broadcast: false });
      notify();
      return;
    }
    const nextLocale = computeEffectiveLocale('system');
    preferenceState = 'system';
    localeState = nextLocale;
    applyLocaleToEnvironment(localeState, preferenceState, { persist: false, broadcast: false });
    notify();
    return;
  }

  const nextPref = snapshot.preference;
  const nextLocale = nextPref === 'system'
    ? (typeof window !== 'undefined' ? computeEffectiveLocale('system') : (isLocale(snapshot.locale) ? snapshot.locale : DEFAULT_LOCALE))
    : nextPref;
  const changed = nextPref !== preferenceState || nextLocale !== localeState;
  preferenceState = nextPref;
  localeState = nextLocale;
  revisionState = snapshot.revision ?? revisionState + 1;
  applyLocaleToEnvironment(localeState, preferenceState, { persist: true, broadcast: false });
  if (changed) notify();
}

/**
 * Switch language preference immediately with zero reload:
 * updates store, `<html lang>`, `dayjs.locale`, `localStorage`, other tabs, and persists to backend.
 */
export function setLocalePreference(
  preference: LocalePreference,
  options: { syncServer?: boolean } = {}
): Locale {
  const nextLocale = computeEffectiveLocale(preference);
  const changed = preference !== preferenceState || nextLocale !== localeState;
  preferenceState = preference;
  localeState = nextLocale;
  revisionState += 1;
  const myEpoch = ++localMutationEpoch;
  applyLocaleToEnvironment(localeState, preferenceState, { persist: true, broadcast: true });
  if (changed) notify();
  if (options.syncServer !== false && typeof window !== 'undefined' && typeof fetch === 'function') {
    pendingLocalSaves += 1;
    void api.setSystemLocale({ preference, locale: nextLocale })
      .then(snapshot => {
        if (myEpoch === localMutationEpoch) {
          loadedState = true;
          if (typeof snapshot.revision === 'number') {
            lastServerRevision = Math.max(lastServerRevision, snapshot.revision);
            revisionState = Math.max(revisionState, snapshot.revision);
          }
        }
      })
      .catch(() => undefined)
      .finally(() => {
        pendingLocalSaves = Math.max(0, pendingLocalSaves - 1);
      });
  }
  return nextLocale;
}

/** Reset locale store cleanly for isolated tests. */
export function resetLocaleForTest(preference: LocalePreference = DEFAULT_LOCALE_PREFERENCE, forcedLocale?: Locale): void {
  preferenceState = preference;
  localeState = forcedLocale ?? computeEffectiveLocale(preference);
  revisionState += 1;
  loadedState = false;
  localMutationEpoch = 0;
  pendingLocalSaves = 0;
  lastServerRevision = -1;
  applyLocaleToEnvironment(localeState, preferenceState, { persist: false, broadcast: false });
  notify();
}

/** Translate a typed Web UI message key synchronously. */
export function tWeb(key: WebMessageKey, params?: TranslationParams, locale: Locale = localeState): string {
  return translateWeb(locale, key, params);
}

/** Bilingual text helper for domain copy alongside the typed message catalog. */
export function bi(zh: string, en: string, locale: Locale = localeState): string {
  return locale === 'en-US' ? en : zh;
}

/**
 * Dynamic locale-reactive dictionary proxy for exported Record<K, string> maps
 * so existing property lookups (`labels[key]`) always reflect the active locale
 * without freezing at module import time.
 */
export function localizedRecord<K extends string>(
  zh: Readonly<Record<K, string>>,
  en: Readonly<Record<K, string>>
): Record<K, string> {
  return new Proxy({} as Record<K, string>, {
    get(_target, prop) {
      if (typeof prop !== 'string') return undefined;
      return localeState === 'en-US' ? en[prop as K] : zh[prop as K];
    },
    ownKeys() {
      return Object.keys(zh);
    },
    getOwnPropertyDescriptor(_target, prop) {
      if (typeof prop !== 'string' || !(prop in zh)) return undefined;
      return {
        enumerable: true,
        configurable: true,
        value: localeState === 'en-US' ? en[prop as K] : zh[prop as K]
      };
    },
    has(_target, prop) {
      return typeof prop === 'string' && prop in zh;
    }
  });
}

const LocaleOverrideContext = createContext<Locale | null>(null);

export interface I18nProviderProps {
  children?: ReactNode;
  /** Optional forced locale override (useful for isolated tests or previews). */
  locale?: Locale;
}

export function I18nProvider({ children, locale: override }: I18nProviderProps) {
  const snapshot = useSyncExternalStore(subscribe, getSnapshot, () => SERVER_SNAPSHOT);
  const activeLocale = override ?? snapshot.locale;

  useEffect(() => {
    if (typeof document !== 'undefined') {
      document.documentElement.lang = activeLocale;
    }
    dayjs.locale(activeLocale === 'en-US' ? 'en' : 'zh-cn');
  }, [activeLocale]);

  return (
    <LocaleOverrideContext.Provider value={override ?? null}>
      {children}
    </LocaleOverrideContext.Provider>
  );
}

export function useLocale(): Locale {
  const override = useContext(LocaleOverrideContext);
  const snapshot = useSyncExternalStore(subscribe, getSnapshot, () => SERVER_SNAPSHOT);
  return override ?? snapshot.locale;
}

export function useLocalePreference(): LocalePreference {
  const snapshot = useSyncExternalStore(subscribe, getSnapshot, () => SERVER_SNAPSHOT);
  return snapshot.preference;
}

export function useT() {
  const locale = useLocale();
  return useCallback(
    (key: WebMessageKey, params?: TranslationParams) => translateWeb(locale, key, params),
    [locale]
  );
}

export function useBi() {
  const locale = useLocale();
  return useCallback((zh: string, en: string) => (locale === 'en-US' ? en : zh), [locale]);
}

export function useI18n() {
  const locale = useLocale();
  const preference = useLocalePreference();
  const t = useT();
  const L = useBi();
  return useMemo(() => ({
    locale,
    preference,
    isEn: locale === 'en-US',
    isZh: locale === 'zh-CN',
    t,
    L,
    setPreference: (next: LocalePreference) => setLocalePreference(next)
  }), [locale, preference, t, L]);
}

/**
 * Mount in App root: fetches persisted server locale and subscribes to `/api/system/locale/stream`
 * so multi-tab / remote switches propagate seamlessly.
 */
export function useLocaleSync(options: { enabled?: boolean } = {}): void {
  const enabled = options.enabled !== false;

  useEffect(() => {
    if (!enabled) return;
    let disposed = false;

    const refresh = (source: 'initial' | 'focus' = 'initial') => {
      const requestEpoch = localMutationEpoch;
      void api.systemLocale().then(snapshot => {
        if (!disposed) syncLocaleSnapshot(snapshot, { requestEpoch, source });
      }).catch(() => undefined);
    };
    const onFocus = () => refresh('focus');
    refresh('initial');

    let stream: EventSource | null = null;
    const closeStream = () => {
      stream?.close();
      stream = null;
    };

    if (typeof EventSource !== 'undefined') {
      stream = new EventSource('/api/system/locale/stream');
      const onLocaleUpdated = (event: MessageEvent<string>) => {
        if (disposed || typeof event.data !== 'string' || !event.data) return;
        try {
          const payload = JSON.parse(event.data) as LocaleStateSnapshot;
          syncLocaleSnapshot(payload, { source: 'sse' });
        } catch {
          refresh('focus');
        }
      };
      stream.addEventListener('locale.updated', onLocaleUpdated as unknown as EventListener);
      window.addEventListener('agentdock:web-access-denied', closeStream);
      window.addEventListener('focus', onFocus);
      return () => {
        disposed = true;
        window.removeEventListener('agentdock:web-access-denied', closeStream);
        window.removeEventListener('focus', onFocus);
        stream?.removeEventListener('locale.updated', onLocaleUpdated as unknown as EventListener);
        closeStream();
      };
    }

    window.addEventListener('focus', onFocus);
    return () => {
      disposed = true;
      window.removeEventListener('focus', onFocus);
    };
  }, [enabled]);
}

/** Format an ISO/Date timestamp using Intl.DateTimeFormat synced to active locale. */
export function formatLocalizedDateTime(
  value: string | number | Date | null | undefined,
  options: Intl.DateTimeFormatOptions = { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' },
  locale: Locale = localeState
): string {
  if (!value) return '';
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return typeof value === 'string' ? value : '';
  try {
    return new Intl.DateTimeFormat(locale, options).format(date);
  } catch {
    return date.toISOString();
  }
}

/** Format relative time (e.g., "Just now", "3m ago", "2 hours ago") synced to active locale. */
export function formatLocalizedRelativeTime(
  value: string | number | Date | null | undefined,
  nowMs: number = Date.now(),
  locale: Locale = localeState
): string {
  if (!value) return '';
  const ts = value instanceof Date ? value.getTime() : typeof value === 'number' ? value : Date.parse(value);
  if (!Number.isFinite(ts)) return typeof value === 'string' ? value : '';
  const diffSec = Math.round((nowMs - ts) / 1000);
  if (Math.abs(diffSec) < 45) return translateWeb(locale, 'time.justNow');
  if (typeof Intl !== 'undefined' && typeof Intl.RelativeTimeFormat === 'function') {
    const rtf = new Intl.RelativeTimeFormat(locale, { numeric: 'auto', style: 'short' });
    if (Math.abs(diffSec) < 3600) return rtf.format(-Math.round(diffSec / 60), 'minute');
    if (Math.abs(diffSec) < 86_400) return rtf.format(-Math.round(diffSec / 3600), 'hour');
    if (Math.abs(diffSec) < 86_400 * 30) return rtf.format(-Math.round(diffSec / 86_400), 'day');
  }
  const absSec = Math.abs(diffSec);
  if (absSec < 3600) return translateWeb(locale, 'time.minutesAgo', { n: Math.max(1, Math.round(absSec / 60)) });
  if (absSec < 86_400) return translateWeb(locale, 'time.hoursAgo', { n: Math.max(1, Math.round(absSec / 3600)) });
  return translateWeb(locale, 'time.daysAgo', { n: Math.max(1, Math.round(absSec / 86_400)) });
}
