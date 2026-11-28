/**
 * Shared type-safe i18n primitives for AgentDock (packages/shared, apps/server, apps/web).
 */

export const SUPPORTED_LOCALES = ['zh-CN', 'en-US'] as const;
export type Locale = (typeof SUPPORTED_LOCALES)[number];

export const LOCALE_PREFERENCES = ['system', 'zh-CN', 'en-US'] as const;
export type LocalePreference = (typeof LOCALE_PREFERENCES)[number];

export const DEFAULT_LOCALE: Locale = 'zh-CN';
export const DEFAULT_LOCALE_PREFERENCE: LocalePreference = 'system';

export interface LocaleStateSnapshot {
  preference: LocalePreference;
  locale: Locale;
  configured?: boolean;
  revision?: number;
  updatedAt?: string;
}

export type TranslationParams = Record<string, string | number | boolean | null | undefined>;

export function isLocale(value: unknown): value is Locale {
  return value === 'zh-CN' || value === 'en-US';
}

export function isLocalePreference(value: unknown): value is LocalePreference {
  return value === 'system' || value === 'zh-CN' || value === 'en-US';
}

/**
 * Normalize an arbitrary BCP-47 tag (e.g. `zh`, `zh-Hans`, `zh-TW`, `en-GB`, `fr-FR`)
 * into a supported AgentDock locale, or `null` if not directly mapped.
 */
export function normalizeLocaleTag(input?: string | null): Locale | null {
  const tag = input?.trim().toLowerCase();
  if (!tag) return null;
  if (tag === 'zh' || tag.startsWith('zh-') || tag.startsWith('zh_')) return 'zh-CN';
  if (tag === 'en' || tag.startsWith('en-') || tag.startsWith('en_')) return 'en-US';
  return null;
}

/**
 * Resolve effective locale from user preference + optional system/browser language list.
 *
 * - Explicit `'zh-CN'` / `'en-US'` always wins.
 * - `'system'` checks `systemLanguages` in priority order:
 *   - First language matching `zh*` -> `'zh-CN'`
 *   - First language matching `en*` -> `'en-US'`
 *   - Any other non-Chinese system language -> `'en-US'`
 *   - Empty / unavailable `systemLanguages` -> `emptyFallback` (defaults to `'en-US'`).
 */
export function resolveLocale(
  preference: LocalePreference | null | undefined,
  systemLanguages?: readonly string[] | string | null,
  emptyFallback: Locale = 'en-US'
): Locale {
  if (preference === 'zh-CN' || preference === 'en-US') return preference;
  const list = typeof systemLanguages === 'string'
    ? [systemLanguages]
    : Array.isArray(systemLanguages)
      ? systemLanguages
      : [];
  const normalized = list
    .map(item => (typeof item === 'string' ? item.trim() : ''))
    .filter(Boolean);
  if (normalized.length === 0) return emptyFallback;
  for (const tag of normalized) {
    const matched = normalizeLocaleTag(tag);
    if (matched) return matched;
  }
  return 'en-US';
}

const PLACEHOLDER_RE = /\{([a-zA-Z0-9_]+)\}/g;

/** Extract sorted unique `{var}` placeholder names from a translation template. */
export function extractPlaceholders(template: string): string[] {
  const set = new Set<string>();
  let match: RegExpExecArray | null;
  PLACEHOLDER_RE.lastIndex = 0;
  while ((match = PLACEHOLDER_RE.exec(template)) !== null) {
    if (match[1]) set.add(match[1]);
  }
  return [...set].sort();
}

/** Interpolate `{var}` placeholders into a message template. */
export function formatMessageTemplate(template: string, params?: TranslationParams): string {
  if (!params) return template;
  return template.replace(PLACEHOLDER_RE, (full, key: string) => {
    if (!(key in params)) return full;
    const val = params[key];
    return val === null || val === undefined ? '' : String(val);
  });
}

export type MessageDictionary<K extends string = string> = Readonly<Record<K, string>>;
export type LocaleCatalog<K extends string = string> = Readonly<Record<Locale, MessageDictionary<K>>>;

/**
 * Create a strictly-typed translator function for a given bilingual catalog.
 */
export function createTranslator<K extends string>(catalog: LocaleCatalog<K>) {
  return function translate(locale: Locale, key: K, params?: TranslationParams): string {
    const table = catalog[locale] ?? catalog[DEFAULT_LOCALE];
    const template = table[key] ?? catalog[DEFAULT_LOCALE][key] ?? key;
    return formatMessageTemplate(template, params);
  };
}
