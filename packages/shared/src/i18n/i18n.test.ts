import { describe, expect, it } from 'vitest';
import { BUILTIN_THEMES } from '../themes.js';
import { larkReactionEmojiOptions } from '../lark-reaction-emoji.js';
import {
  extractPlaceholders,
  formatInteractionSourceBadge,
  formatMessageTemplate,
  localizeLarkReactionEmojiLabel,
  localizeThemeDisplay,
  normalizeLocaleTag,
  resolveLocale,
  sharedEnUS,
  sharedZhCN,
  tShared,
  type SharedMessageKey
} from './index.js';

const CJK_RE = /[\u4e00-\u9fff]/;
const EN_CJK_ALLOWLIST = new Set<SharedMessageKey>(['locale.zh-CN']);

describe('shared i18n engine & catalog integrity', () => {
  it('resolves explicit and system locales deterministically with en-US fallback for non-Chinese systems', () => {
    expect(resolveLocale('zh-CN', ['en-US'])).toBe('zh-CN');
    expect(resolveLocale('en-US', ['zh-CN'])).toBe('en-US');
    expect(resolveLocale('system', ['zh-CN', 'en-US'])).toBe('zh-CN');
    expect(resolveLocale('system', ['zh-TW'])).toBe('zh-CN');
    expect(resolveLocale('system', ['zh-Hans-SG'])).toBe('zh-CN');
    expect(resolveLocale('system', ['en-US', 'zh-CN'])).toBe('en-US');
    expect(resolveLocale('system', ['en-GB'])).toBe('en-US');
    expect(resolveLocale('system', ['ja-JP', 'fr-FR'])).toBe('en-US');
    expect(resolveLocale('system', [], 'zh-CN')).toBe('zh-CN');
    expect(resolveLocale('system', undefined, 'en-US')).toBe('en-US');

    expect(normalizeLocaleTag('zh_CN')).toBe('zh-CN');
    expect(normalizeLocaleTag('EN-au')).toBe('en-US');
    expect(normalizeLocaleTag('de-DE')).toBeNull();
  });

  it('keeps 100% key parity and {placeholder} parity between zh-CN and en-US shared catalogs', () => {
    const zhKeys = Object.keys(sharedZhCN).sort();
    const enKeys = Object.keys(sharedEnUS).sort();
    expect(enKeys).toEqual(zhKeys);

    for (const key of zhKeys as SharedMessageKey[]) {
      const zhVal = sharedZhCN[key];
      const enVal = sharedEnUS[key];
      expect(zhVal.trim().length, `zh-CN key "${key}" must be non-empty`).toBeGreaterThan(0);
      expect(enVal.trim().length, `en-US key "${key}" must be non-empty`).toBeGreaterThan(0);

      expect(
        extractPlaceholders(enVal),
        `Placeholder mismatch for key "${key}"`
      ).toEqual(extractPlaceholders(zhVal));

      if (!EN_CJK_ALLOWLIST.has(key)) {
        expect(CJK_RE.test(enVal), `en-US key "${key}" contains stray CJK: "${enVal}"`).toBe(false);
      }
    }
  });

  it('interpolates template variables cleanly and preserves unknown placeholders', () => {
    expect(formatMessageTemplate('Hello {name}, {count} items', { name: 'Ada', count: 3 })).toBe('Hello Ada, 3 items');
    expect(tShared('en-US', 'lark.card.footer.taskElapsed', { taskId: '42', elapsed: '1m 5s' }))
      .toBe('Task #42 · Elapsed 1m 5s');
    expect(tShared('zh-CN', 'lark.card.footer.taskElapsed', { taskId: '42', elapsed: '1m 5s' }))
      .toBe('任务 #42 · 已用时 1m 5s');
  });

  it('localizes all 20 built-in themes and all 34 Lark reaction emojis without stray CJK in en-US', () => {
    expect(BUILTIN_THEMES.length).toBe(20);
    for (const theme of BUILTIN_THEMES) {
      const zh = localizeThemeDisplay(theme, 'zh-CN');
      const en = localizeThemeDisplay(theme, 'en-US');
      expect(zh.name.length).toBeGreaterThan(0);
      expect(en.name.length).toBeGreaterThan(0);
      expect(CJK_RE.test(en.name), `Theme ${theme.id} en-US name contains CJK: ${en.name}`).toBe(false);
      expect(en.description && !CJK_RE.test(en.description), `Theme ${theme.id} en-US description invalid`).toBe(true);
    }

    for (const emoji of larkReactionEmojiOptions) {
      const enLabel = localizeLarkReactionEmojiLabel(emoji.code, emoji.label, 'en-US');
      expect(enLabel.length).toBeGreaterThan(0);
      expect(CJK_RE.test(enLabel), `Emoji ${emoji.code} en-US label contains CJK: ${enLabel}`).toBe(false);
    }
  });

  it('formats Web and Lark interaction source badges cleanly in both languages', () => {
    expect(formatInteractionSourceBadge('assistant', 'zh-CN')).toBe('🐾 小猫代答');
    expect(formatInteractionSourceBadge('assistant', 'en-US')).toBe('🐾 Kitten Reply');
    expect(formatInteractionSourceBadge('assistant', 'en-US', { variant: 'lark' })).toBe('🐾 Kitten Answered');
    expect(formatInteractionSourceBadge('assistant', 'en-US', { responderName: 'Milo', variant: 'lark' })).toBe('🐾 Milo Answered');
    expect(formatInteractionSourceBadge('web', 'zh-CN')).toBe('网页端');
    expect(formatInteractionSourceBadge('web', 'en-US')).toBe('Web');
    expect(formatInteractionSourceBadge('lark', 'zh-CN')).toBe('飞书');
    expect(formatInteractionSourceBadge('lark', 'en-US')).toBe('Lark');
  });
});
