import { describe, expect, it } from 'vitest';
import {
  BUILTIN_DARK_THEME_ID,
  BUILTIN_LIGHT_THEME_ID,
  BUILTIN_THEMES,
  customThemeTokenKeys,
  DEFAULT_THEME_PREFERENCES,
  compositeColorOver,
  contrastRatio,
  ensureReadableThemeTokens,
  evaluateThemeContrast,
  normalizeHexColor,
  relativeLuminance,
  resolveActiveTheme,
  themeToCssVariables
} from './themes.js';

describe('semantic theme token engine & WCAG contrast guard', () => {
  it('ships 20 balanced builtin presets with unique ids, complete tokens, and WCAG AA/AAA compliance', () => {
    expect(BUILTIN_THEMES.length).toBe(20);
    expect(BUILTIN_THEMES[0]!.id).toBe(BUILTIN_LIGHT_THEME_ID);
    expect(BUILTIN_THEMES[1]!.id).toBe(BUILTIN_DARK_THEME_ID);

    const lightCount = BUILTIN_THEMES.filter(theme => theme.mode === 'light').length;
    const darkCount = BUILTIN_THEMES.filter(theme => theme.mode === 'dark').length;
    expect(lightCount).toBe(10);
    expect(darkCount).toBe(10);

    const ids = new Set(BUILTIN_THEMES.map(theme => theme.id));
    const names = new Set(BUILTIN_THEMES.map(theme => theme.name));
    expect(ids.size).toBe(BUILTIN_THEMES.length);
    expect(names.size).toBe(BUILTIN_THEMES.length);

    // 确认用户参考图主题与主流高口碑经典主题均已内置
    for (const requiredId of [
      'builtin-aurora-pine',
      'builtin-sakura-obsidian',
      'builtin-sakura-dawn',
      'builtin-one-dark-pro',
      'builtin-dracula',
      'builtin-github-dark-dimmed',
      'builtin-gruvbox-dark',
      'builtin-catppuccin-latte',
      'builtin-github-light',
      'builtin-solarized-light',
      'builtin-nord-snow',
      'builtin-everforest-light'
    ]) {
      expect(ids.has(requiredId), `Missing expected builtin theme: ${requiredId}`).toBe(true);
    }

    for (const theme of BUILTIN_THEMES) {
      expect(theme.source).toBe('builtin');
      expect(theme.description?.trim().length ?? 0).toBeGreaterThan(0);
      for (const key of customThemeTokenKeys) {
        expect(theme.tokens[key], `Preset ${theme.id} token ${key}`).toMatch(/^#[0-9a-f]{6}$/);
      }
      const report = evaluateThemeContrast(theme.tokens);
      expect(report.allPassed, `Preset ${theme.id} (${theme.name}) failed contrast check: ${JSON.stringify(report)}`).toBe(true);
      expect(report.grade, `Preset ${theme.id} grade`).not.toBe('A');
      expect(report.textOnCanvas.ratio, `Preset ${theme.id} textOnCanvas`).toBeGreaterThanOrEqual(4.5);
      expect(report.textOnSurface.ratio, `Preset ${theme.id} textOnSurface`).toBeGreaterThanOrEqual(4.5);
      expect(report.textSecondaryOnCanvas.ratio, `Preset ${theme.id} textSecondaryOnCanvas`).toBeGreaterThanOrEqual(4.5);
      expect(report.textMutedOnCanvas.ratio, `Preset ${theme.id} textMutedOnCanvas`).toBeGreaterThanOrEqual(3.0);
      expect(report.accentForegroundOnAccent.ratio, `Preset ${theme.id} accentForegroundOnAccent`).toBeGreaterThanOrEqual(4.5);
      expect(report.accentOnSurface.ratio, `Preset ${theme.id} accentOnSurface`).toBeGreaterThanOrEqual(3.0);
    }
  });

  it('normalizes 3/4/6/8-digit hex and rgb/rgba strings and composites alpha over backdrop', () => {
    expect(normalizeHexColor('#abc')).toBe('#aabbcc');
    expect(normalizeHexColor('#1A1B26')).toBe('#1a1b26');
    expect(normalizeHexColor('rgb(33, 33, 33)')).toBe('#212121');
    expect(normalizeHexColor('rgba(255, 255, 255, 0.5)', '#000000')).toBe('#808080');
    expect(compositeColorOver('#7aa2f733', '#1a1b26')).toBe('#2d3650');
    expect(normalizeHexColor('not-a-color')).toBeNull();
  });

  it('auto-heals unreadable dark-on-dark and light-on-light themes to WCAG AA+', () => {
    // 极端奇葩深色主题：深灰字写在黑底上，亮黄按钮配白字，画布却传成纯白
    const darkHealed = ensureReadableThemeTokens({
      bgCanvas: '#ffffff',
      bgSurface: '#121218',
      textPrimary: '#22222b',
      textSecondary: '#2a2a36',
      textMuted: '#1f1f27',
      accent: '#fff59d',
      accentForeground: '#ffffff'
    }, 'dark');

    expect(relativeLuminance(darkHealed.tokens.bgCanvas)).toBeLessThan(0.35);
    expect(darkHealed.report.allPassed).toBe(true);
    expect(darkHealed.report.textOnCanvas.ratio).toBeGreaterThanOrEqual(4.5);
    expect(darkHealed.report.textSecondaryOnCanvas.ratio).toBeGreaterThanOrEqual(4.5);
    expect(darkHealed.report.accentForegroundOnAccent.ratio).toBeGreaterThanOrEqual(4.5);
    expect(darkHealed.adjustments.length).toBeGreaterThan(0);

    // 极端奇葩浅色主题：浅灰字写在白底上，浅色强调色配纯白字
    const lightHealed = ensureReadableThemeTokens({
      bgCanvas: '#0f0f10',
      bgSurface: '#ffffff',
      textPrimary: '#e5e5e5',
      textSecondary: '#cccccc',
      accent: '#e0f2fe',
      accentForeground: '#ffffff'
    }, 'light');

    expect(relativeLuminance(lightHealed.tokens.bgCanvas)).toBeGreaterThan(0.5);
    expect(lightHealed.report.allPassed).toBe(true);
    expect(contrastRatio(lightHealed.tokens.textPrimary, lightHealed.tokens.bgCanvas)).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(lightHealed.tokens.accentForeground, lightHealed.tokens.accent)).toBeGreaterThanOrEqual(4.5);

    // 中亮度“对比度死区”强调色（如 #c64c78，相对亮度 ~0.185，纯白/深墨都险些低于 4.5:1）
    const midRoseLight = ensureReadableThemeTokens({
      bgCanvas: '#fff7fa',
      bgSurface: '#ffffff',
      accent: '#c64c78',
      accentForeground: '#ffffff'
    }, 'light');
    expect(midRoseLight.report.allPassed).toBe(true);
    expect(midRoseLight.report.accentForegroundOnAccent.ratio).toBeGreaterThanOrEqual(4.5);
    expect(midRoseLight.report.grade).not.toBe('A');

    const midRoseDark = ensureReadableThemeTokens({
      bgCanvas: '#191522',
      bgSurface: '#211c2d',
      accent: '#c64c78',
      accentForeground: '#ffffff'
    }, 'dark');
    expect(midRoseDark.report.allPassed).toBe(true);
    expect(midRoseDark.report.accentForegroundOnAccent.ratio).toBeGreaterThanOrEqual(4.5);
    expect(midRoseDark.report.grade).not.toBe('A');
  });

  it('generates full CSS custom property bridge including Tailwind RGB triplets and board variables', () => {
    const tokyo = BUILTIN_THEMES.find(theme => theme.id === 'builtin-tokyo-night')!;
    const vars = themeToCssVariables(tokyo);
    expect(vars['--bg']).toBe('26 27 38');
    expect(vars['--rail']).toBe('22 22 30');
    expect(vars['--accent']).toBe('122 162 247');
    expect(vars['--link']).toBe('122 162 247');
    expect(vars['--board-card']).toBe(tokyo.tokens.bgSurface);
    expect(vars['--theme-accent']).toBe('#7aa2f7');

    // 默认浅色/深色保持中性单色 accent，而 --link 仍沿用 info 蓝
    const defaultLightVars = themeToCssVariables(BUILTIN_THEMES[0]!);
    expect(defaultLightVars['--accent']).toBe('13 13 13');
    expect(defaultLightVars['--link']).toBe('37 99 235');
  });

  it('resolves active theme across system polarity and explicit light/dark memory', () => {
    const prefs = {
      ...DEFAULT_THEME_PREFERENCES,
      modePreference: 'system' as const,
      activeLightThemeId: 'builtin-kyoto-matcha',
      activeDarkThemeId: 'builtin-tokyo-night'
    };

    expect(resolveActiveTheme(BUILTIN_THEMES, prefs, 'light').id).toBe('builtin-kyoto-matcha');
    expect(resolveActiveTheme(BUILTIN_THEMES, prefs, 'dark').id).toBe('builtin-tokyo-night');

    expect(resolveActiveTheme(BUILTIN_THEMES, {
      ...prefs,
      modePreference: 'dark',
      activeThemeId: 'builtin-nord-frost'
    }, 'light').id).toBe('builtin-nord-frost');

    // 缺失主题安全回退至对应极性默认主题
    expect(resolveActiveTheme(BUILTIN_THEMES, {
      modePreference: 'light',
      activeThemeId: 'deleted-id',
      activeLightThemeId: 'deleted-id',
      activeDarkThemeId: BUILTIN_DARK_THEME_ID
    }, 'dark').id).toBe(BUILTIN_LIGHT_THEME_ID);
  });
});
