import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import ts from 'typescript';
import { afterEach, describe, expect, it, vi } from 'vitest';
import dayjs from 'dayjs';
import { BUILTIN_THEMES, extractPlaceholders, localizeOutputPluginDisplay, localizeThemeDisplay } from '@agent-dock/agent-dock-shared';
import {
  formatLocalizedRelativeTime,
  getCurrentLocale,
  I18nProvider,
  LanguageSegmented,
  resetLocaleForTest,
  setLocalePreference,
  syncLocaleSnapshot,
  tWeb,
  webEnUS,
  webZhCN,
  type WebMessageKey
} from './index';
import { AntdScope } from '../AntdScope';
import { TooltipProvider } from '../HoverTooltip';
import {
  getSettingsCategories,
  searchSettingsItems
} from '../settings/settings-registry';
import { quickThemeTooltipLabel, ThemeSegmented } from '../ThemeToggle';
import { settingsCenterTooltipLabel } from '../SettingsMenu';
import { summarizeLarkQuickEntry } from '../LarkIcon';

const CJK_RE = /[\u4e00-\u9fff]/;
const EN_CJK_ALLOWLIST = new Set<WebMessageKey>([
  'locale.option.zh',
  'locale.resolved.zh-CN',
  'settings.search.language.title'
]);

afterEach(() => {
  resetLocaleForTest('system', 'zh-CN');
});

describe('Web i18n catalog integrity, AntD/dayjs sync & bilingual Settings search', () => {
  it('enforces 100% key parity, placeholder parity, and CJK-free en-US entries', () => {
    const zhKeys = Object.keys(webZhCN).sort();
    const enKeys = Object.keys(webEnUS).sort();
    expect(enKeys).toEqual(zhKeys);

    for (const key of zhKeys as WebMessageKey[]) {
      const zhVal = webZhCN[key];
      const enVal = webEnUS[key];
      expect(zhVal.trim().length, `zh-CN key "${key}" must be non-empty`).toBeGreaterThan(0);
      expect(enVal.trim().length, `en-US key "${key}" must be non-empty`).toBeGreaterThan(0);
      expect(
        extractPlaceholders(enVal),
        `Placeholder mismatch for web key "${key}"`
      ).toEqual(extractPlaceholders(zhVal));
      if (!EN_CJK_ALLOWLIST.has(key)) {
        expect(CJK_RE.test(enVal), `en-US key "${key}" contains stray CJK: "${enVal}"`).toBe(false);
      }
    }
  });

  it('switches locale immediately, syncs dayjs locale, and updates <html lang> when document exists', () => {
    const fakeDoc = { documentElement: { lang: 'zh-CN' } };
    vi.stubGlobal('document', fakeDoc);
    try {
      expect(getCurrentLocale()).toBe('zh-CN');
      setLocalePreference('en-US', { syncServer: false });
      expect(getCurrentLocale()).toBe('en-US');
      expect(fakeDoc.documentElement.lang).toBe('en-US');
      expect(dayjs.locale()).toBe('en');

      setLocalePreference('zh-CN', { syncServer: false });
      expect(getCurrentLocale()).toBe('zh-CN');
      expect(fakeDoc.documentElement.lang).toBe('zh-CN');
      expect(dayjs.locale()).toBe('zh-cn');

      // Stale initial GET response (requestEpoch 0) or older server revision must never clobber a newer local switch
      setLocalePreference('en-US', { syncServer: false });
      syncLocaleSnapshot({ preference: 'zh-CN', locale: 'zh-CN', configured: true, revision: 0 }, { requestEpoch: 0, source: 'initial' });
      expect(getCurrentLocale()).toBe('en-US');
      expect(fakeDoc.documentElement.lang).toBe('en-US');

      // Newer server revision from another tab / SSE applies cleanly
      syncLocaleSnapshot({ preference: 'zh-CN', locale: 'zh-CN', configured: true, revision: 2 }, { source: 'sse' });
      expect(getCurrentLocale()).toBe('zh-CN');
      // Older revision (1 < 2) is ignored
      syncLocaleSnapshot({ preference: 'en-US', locale: 'en-US', configured: true, revision: 1 }, { source: 'sse' });
      expect(getCurrentLocale()).toBe('zh-CN');
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('binds AntdScope ConfigProvider locale dynamically to active i18n locale', () => {
    const enHtml = renderToStaticMarkup(
      createElement(
        I18nProvider,
        { locale: 'en-US' },
        createElement(AntdScope, null, createElement(LanguageSegmented))
      )
    );
    expect(enHtml).toContain('data-testid="language-segmented"');
    expect(enHtml).toContain('简体中文');
    expect(enHtml).toContain('English');
    expect(enHtml).toContain('System');
    expect(enHtml).toContain('whitespace-nowrap');

    const zhHtml = renderToStaticMarkup(
      createElement(
        I18nProvider,
        { locale: 'zh-CN' },
        createElement(AntdScope, null, createElement(LanguageSegmented))
      )
    );
    expect(zhHtml).toContain('跟随系统');
  });

  it('supports bilingual Settings Center search across Chinese, English, and Pinyin in both display modes', () => {
    // Searching Chinese keywords while UI is in English
    const zhInEnLang = searchSettingsItems('语言', { locale: 'en-US' });
    expect(zhInEnLang[0]?.id).toBe('language-region');
    expect(zhInEnLang[0]?.title).toContain('Language & Region');

    const zhInEnLark = searchSettingsItems('飞书', { locale: 'en-US' });
    expect(zhInEnLark.some(item => item.id === 'lark-bots')).toBe(true);
    expect(zhInEnLark[0]?.title).not.toMatch(CJK_RE);

    const zhInEnTheme = searchSettingsItems('主题', { locale: 'en-US' });
    expect(zhInEnTheme.some(item => item.id === 'theme-studio')).toBe(true);

    const zhInEnPlugin = searchSettingsItems('插件', { locale: 'en-US' });
    expect(zhInEnPlugin[0]?.id).toBe('output-plugins');
    expect(zhInEnPlugin[0]?.title).toBe('Output Plugins Center');

    // Searching English keywords while UI is in Chinese
    const enInZhLang = searchSettingsItems('language', { locale: 'zh-CN' });
    expect(enInZhLang[0]?.id).toBe('language-region');
    expect(enInZhLang[0]?.title).toContain('语言与地区');

    const enInZhEnglish = searchSettingsItems('english', { locale: 'zh-CN' });
    expect(enInZhEnglish[0]?.id).toBe('language-region');

    const enInZhFeishu = searchSettingsItems('feishu', { locale: 'zh-CN' });
    expect(enInZhFeishu.some(item => item.id === 'lark-bots')).toBe(true);

    const enInZhLark = searchSettingsItems('lark', { locale: 'zh-CN' });
    expect(enInZhLark.some(item => item.id === 'lark-bots')).toBe(true);

    // Categories localized completely in en-US
    const enCats = getSettingsCategories('en-US');
    expect(enCats.map(c => c.label)).toEqual([
      'General & Appearance',
      'Agents & Capabilities',
      'Companion & Automation',
      'Lark & Collaboration',
      'Notifications'
    ]);
    for (const cat of enCats) {
      expect(CJK_RE.test(cat.label)).toBe(false);
      expect(CJK_RE.test(cat.mobileLabel)).toBe(false);
      expect(CJK_RE.test(cat.description)).toBe(false);
      for (const sub of cat.subTabs) {
        expect(CJK_RE.test(sub.label)).toBe(false);
        expect(sub.mobileLabel && CJK_RE.test(sub.mobileLabel)).toBe(false);
      }
    }
  });

  it('renders core chrome controls & tooltips with zero CJK in en-US mode', () => {
    const qc = new QueryClient();
    const themeHtml = renderToStaticMarkup(
      createElement(
        QueryClientProvider,
        { client: qc },
        createElement(
          I18nProvider,
          { locale: 'en-US' },
          createElement(TooltipProvider, null, createElement(ThemeSegmented))
        )
      )
    );
    expect(themeHtml).toContain('Light');
    expect(themeHtml).toContain('System');
    expect(themeHtml).toContain('Dark');
    expect(CJK_RE.test(themeHtml)).toBe(false);

    expect(CJK_RE.test(settingsCenterTooltipLabel(null, 'en-US'))).toBe(false);
    expect(CJK_RE.test(settingsCenterTooltipLabel('available', 'en-US'))).toBe(false);
    expect(CJK_RE.test(quickThemeTooltipLabel('system', 'light', 'Default Light', 'en-US'))).toBe(false);
    expect(CJK_RE.test(summarizeLarkQuickEntry({ bots: [], listeningDisabled: false }, 'en-US').tooltip)).toBe(false);

    // Relative time formatting
    const now = Date.parse('2026-11-28T12:00:00Z');
    expect(formatLocalizedRelativeTime('2026-11-28T11:59:50Z', now, 'en-US')).toBe('Just now');
    expect(formatLocalizedRelativeTime('2026-11-28T11:59:50Z', now, 'zh-CN')).toBe('刚刚');
    expect(CJK_RE.test(formatLocalizedRelativeTime('2026-11-28T11:50:00Z', now, 'en-US'))).toBe(false);
    expect(tWeb('settings.general.appearance.themeCount', { count: BUILTIN_THEMES.length }, 'en-US')).toBe('20 themes');
  });

  it('localizes all 20 built-in themes and built-in output plugins cleanly in en-US', () => {
    for (const theme of BUILTIN_THEMES) {
      const en = localizeThemeDisplay(theme, 'en-US');
      expect(en.name.trim().length).toBeGreaterThan(0);
      expect(CJK_RE.test(en.name), `Built-in theme "${theme.id}" en-US name leaked CJK: ${en.name}`).toBe(false);
      expect(CJK_RE.test(en.description ?? ''), `Built-in theme "${theme.id}" en-US desc leaked CJK: ${en.description}`).toBe(false);
    }
    const askEn = localizeOutputPluginDisplay({ id: 'builtin:ask-user-question', name: '询问卡片', description: '中文描述' }, 'en-US');
    const confirmEn = localizeOutputPluginDisplay({ id: 'builtin:confirm-action', name: '操作确认卡', description: '中文描述' }, 'en-US');
    expect(CJK_RE.test(askEn.name)).toBe(false);
    expect(CJK_RE.test(askEn.description ?? '')).toBe(false);
    expect(CJK_RE.test(confirmEn.name)).toBe(false);
    expect(CJK_RE.test(confirmEn.description ?? '')).toBe(false);
  });

  it('guards core UI entry files against raw untranslated JSX Chinese regressions', () => {
    const coreFiles = [
      'App.tsx',
      'SettingsMenu.tsx',
      'ThemeToggle.tsx',
      'KeepAwakeToggle.tsx',
      'AutostartToggle.tsx',
      'SessionPane.tsx',
      'Composer.tsx',
      'DraftComposer.tsx',
      'PromptTemplates.tsx',
      'TimelineItems.tsx',
      'SystemPromptDialog.tsx',
      'ThemeStudioDialog.tsx',
      'LarkConfigPanel.tsx',
      'settings/SettingsCenterDialog.tsx',
      'board/BoardWorkspace.tsx',
      'board/BoardCard.tsx',
      'board/BoardColumn.tsx',
      'output-plugins/OutputPluginsCenterPanel.tsx',
      'output-plugins/SessionOutputPluginsDialog.tsx'
    ];
    const webSrc = resolve(__dirname, '..');
    const violations: string[] = [];
    for (const rel of coreFiles) {
      const fullPath = resolve(webSrc, rel);
      const src = readFileSync(fullPath, 'utf8');
      const sf = ts.createSourceFile(fullPath, src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
      const visit = (node: ts.Node) => {
        if (ts.isJsxText(node)) {
          const text = node.text.trim();
          if (text && text !== '简体中文' && CJK_RE.test(text)) {
            const line = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
            violations.push(`${rel}:${line}: ${text}`);
          }
        }
        ts.forEachChild(node, visit);
      };
      visit(sf);
    }
    expect(violations, `Found raw untranslated JSX CJK text:\n${violations.join('\n')}`).toEqual([]);
  });
});
