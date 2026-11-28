import { EventEmitter } from 'node:events';
import {
  DEFAULT_LOCALE,
  DEFAULT_LOCALE_PREFERENCE,
  isLocale,
  isLocalePreference,
  now,
  type ConfigRepository,
  type Locale,
  type LocalePreference,
  type LocaleStateSnapshot
} from '@agent-dock/agent-dock-shared';

export const platformLocaleConfigKey = 'platform.locale';

export interface LocaleChangeEvent {
  type: 'locale.updated';
  preference: LocalePreference;
  locale: Locale;
  configured: boolean;
  revision: number;
  updatedAt: string;
}

export interface SetLocaleInput {
  preference?: unknown;
  locale?: unknown;
}

interface StoredLocaleRecord {
  preference: LocalePreference;
  locale: Locale;
  updatedAt: string;
}

let activeLocaleService: LocaleService | undefined;
let testLocaleOverride: Locale | undefined;

export function initServerLocale(service: LocaleService | undefined): void {
  activeLocaleService = service;
}

export function setActiveServerLocaleForTest(locale: Locale | undefined): void {
  testLocaleOverride = locale;
}

/**
 * Read the server's currently active effective locale synchronously.
 * Defaults to `'zh-CN'` when unconfigured or running isolated unit tests, preserving backward compatibility.
 */
export function getActiveServerLocale(): Locale {
  if (testLocaleOverride) return testLocaleOverride;
  return activeLocaleService?.getEffectiveLocale() ?? DEFAULT_LOCALE;
}

export class LocaleService {
  private readonly config: ConfigRepository;
  private readonly emitter = new EventEmitter();
  private state: Required<Pick<LocaleStateSnapshot, 'preference' | 'locale' | 'configured' | 'revision'>> & { updatedAt?: string } = {
    preference: DEFAULT_LOCALE_PREFERENCE,
    locale: DEFAULT_LOCALE,
    configured: false,
    revision: 0
  };
  private loaded = false;

  constructor(options: { config: ConfigRepository }) {
    this.config = options.config;
    this.emitter.setMaxListeners(100);
  }

  getEffectiveLocale(): Locale {
    return this.state.locale;
  }

  async load(): Promise<LocaleStateSnapshot> {
    const raw = await this.config.get(platformLocaleConfigKey);
    if (raw) {
      try {
        const parsed = JSON.parse(raw) as Partial<StoredLocaleRecord>;
        const preference: LocalePreference = isLocalePreference(parsed.preference)
          ? parsed.preference
          : DEFAULT_LOCALE_PREFERENCE;
        const locale: Locale = preference === 'zh-CN' || preference === 'en-US'
          ? preference
          : isLocale(parsed.locale)
            ? parsed.locale
            : DEFAULT_LOCALE;
        this.state = {
          preference,
          locale,
          configured: true,
          revision: this.state.revision,
          ...(typeof parsed.updatedAt === 'string' ? { updatedAt: parsed.updatedAt } : {})
        };
      } catch {
        // Corrupt record falls back cleanly to default zh-CN
      }
    }
    this.loaded = true;
    return this.snapshot();
  }

  async getState(): Promise<LocaleStateSnapshot> {
    if (!this.loaded) await this.load();
    return this.snapshot();
  }

  async setLocale(input: SetLocaleInput): Promise<LocaleStateSnapshot> {
    if (!this.loaded) await this.load();
    if (!isLocalePreference(input.preference)) {
      throw new Error('preference must be one of: system, zh-CN, en-US');
    }
    if (input.locale !== undefined && !isLocale(input.locale)) {
      throw new Error('locale must be one of: zh-CN, en-US');
    }
    const preference = input.preference;
    const locale: Locale = preference === 'zh-CN' || preference === 'en-US'
      ? preference
      : isLocale(input.locale)
        ? input.locale
        : this.state.locale;
    const updatedAt = now();
    const record: StoredLocaleRecord = { preference, locale, updatedAt };
    await this.config.set(platformLocaleConfigKey, JSON.stringify(record));
    this.state = {
      preference,
      locale,
      configured: true,
      revision: this.state.revision + 1,
      updatedAt
    };
    const event: LocaleChangeEvent = {
      type: 'locale.updated',
      preference,
      locale,
      configured: true,
      revision: this.state.revision,
      updatedAt
    };
    this.emitter.emit('locale.updated', event);
    return this.snapshot();
  }

  subscribe(listener: (event: LocaleChangeEvent) => void): () => void {
    this.emitter.on('locale.updated', listener);
    return () => {
      this.emitter.off('locale.updated', listener);
    };
  }

  close(): void {
    this.emitter.removeAllListeners();
    if (activeLocaleService === this) {
      activeLocaleService = undefined;
    }
  }

  private snapshot(): LocaleStateSnapshot {
    return {
      preference: this.state.preference,
      locale: this.state.locale,
      configured: this.state.configured,
      revision: this.state.revision,
      ...(this.state.updatedAt ? { updatedAt: this.state.updatedAt } : {})
    };
  }
}
