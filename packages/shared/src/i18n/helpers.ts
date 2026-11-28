import {
  BUILTIN_ASK_USER_QUESTION_PLUGIN_ID,
  BUILTIN_CONFIRM_ACTION_PLUGIN_ID,
  BUILTIN_RICH_BLOCKS_PLUGIN_ID,
  normalizeOutputPluginId
} from '../output-plugins/types.js';
import type { CustomTheme } from '../themes.js';
import type { OutputPluginInteractionSource } from '../output-plugins/types.js';
import { createTranslator, type Locale, type LocaleCatalog } from './types.js';
import { sharedEnUS } from './messages/en-US.js';
import { sharedZhCN, type SharedMessageKey } from './messages/zh-CN.js';

export const sharedMessages: LocaleCatalog<SharedMessageKey> = {
  'zh-CN': sharedZhCN,
  'en-US': sharedEnUS
};

/** Strictly typed shared translator (`packages/shared`, `apps/server`, `apps/web`). */
export const tShared = createTranslator(sharedMessages);

/**
 * Resolve localized name and description for a theme.
 * Built-in themes (20 presets) translate seamlessly; user-created/imported themes preserve their custom copy.
 */
export function localizeThemeDisplay(
  theme: Pick<CustomTheme, 'id' | 'name' | 'description' | 'source'>,
  locale: Locale
): { name: string; description?: string } {
  const nameKey = `theme.${theme.id}.name` as SharedMessageKey;
  const descKey = `theme.${theme.id}.description` as SharedMessageKey;
  const table = sharedMessages[locale] ?? sharedMessages['zh-CN'];
  if (nameKey in table) {
    return {
      name: table[nameKey],
      description: descKey in table ? table[descKey] : theme.description
    };
  }
  return { name: theme.name, description: theme.description };
}

/** Resolve localized label for a Lark reaction emoji code. */
export function localizeLarkReactionEmojiLabel(code: string, fallbackLabel: string, locale: Locale): string {
  const key = `emoji.${code}` as SharedMessageKey;
  const table = sharedMessages[locale] ?? sharedMessages['zh-CN'];
  return key in table ? table[key] : fallbackLabel;
}

/** Resolve localized name and description for built-in output plugins (custom plugins keep user text). */
export function localizeOutputPluginDisplay(
  plugin: { id: string; name: string; description?: string },
  locale: Locale
): { name: string; description?: string } {
  const canonical = normalizeOutputPluginId(plugin.id);
  if (canonical === BUILTIN_ASK_USER_QUESTION_PLUGIN_ID) {
    return {
      name: tShared(locale, 'plugin.askUserQuestion.name'),
      description: tShared(locale, 'plugin.askUserQuestion.description')
    };
  }
  if (canonical === BUILTIN_CONFIRM_ACTION_PLUGIN_ID) {
    return {
      name: tShared(locale, 'plugin.confirmAction.name'),
      description: tShared(locale, 'plugin.confirmAction.description')
    };
  }
  if (canonical === BUILTIN_RICH_BLOCKS_PLUGIN_ID) {
    return {
      name: tShared(locale, 'plugin.richBlocks.name'),
      description: tShared(locale, 'plugin.richBlocks.description')
    };
  }
  return { name: plugin.name, description: plugin.description };
}

/**
 * Format an interaction response source badge (Web UI & Lark cards).
 * - Web UI: `🐾 小猫代答` / `🐾 Kitten Reply`, `网页端` / `Web`, `飞书` / `Lark`
 * - Lark card answered header: `🐾 小猫代答` / `🐾 Kitten Answered`, `网页端` / `Web`, `飞书` / `Lark`
 */
export function formatInteractionSourceBadge(
  source: OutputPluginInteractionSource,
  locale: Locale,
  options: { responderName?: string | null; variant?: 'web' | 'lark' } = {}
): string {
  const responder = options.responderName?.trim();
  if (source === 'assistant') {
    if (locale === 'en-US') {
      if (options.variant === 'lark') {
        return responder ? `🐾 ${responder} Answered` : '🐾 Kitten Answered';
      }
      return responder ? `🐾 ${responder} Reply` : '🐾 Kitten Reply';
    }
    return responder
      ? tShared(locale, 'source.assistant.named', { name: responder })
      : tShared(locale, 'source.assistant.default');
  }
  return source === 'web' ? tShared(locale, 'source.web') : tShared(locale, 'source.lark');
}
