import { z } from 'zod';

/**
 * AgentDock 全站语义化主题配色引擎与 WCAG 对比度守护。
 *
 * 供 packages/shared、apps/server（持久化/AI 生成/VS Code 映射/CLI）与
 * apps/web（CSS 自定义属性注入/AntD ConfigProvider/主题工坊实时调色）共享同一份契约与算法。
 */

export const customThemeModes = ['light', 'dark'] as const;
export type CustomThemeMode = (typeof customThemeModes)[number];

export const customThemeSources = ['builtin', 'custom', 'ai', 'vscode'] as const;
export type CustomThemeSource = (typeof customThemeSources)[number];

export const themePreferenceModes = ['system', 'light', 'dark'] as const;
export type ThemePreferenceMode = (typeof themePreferenceModes)[number];

export const customThemeTokenKeys = [
  'bgCanvas',
  'bgSidebar',
  'bgSurface',
  'bgSurfaceHover',
  'bgElevated',
  'bgBubbleUser',
  'bgCode',
  'textPrimary',
  'textSecondary',
  'textMuted',
  'textInverse',
  'borderSubtle',
  'borderStrong',
  'accent',
  'accentSoft',
  'accentForeground',
  'success',
  'warning',
  'danger',
  'info'
] as const;
export type CustomThemeTokenKey = (typeof customThemeTokenKeys)[number];

export interface CustomThemeTokens {
  bgCanvas: string;
  bgSidebar: string;
  bgSurface: string;
  bgSurfaceHover: string;
  bgElevated: string;
  bgBubbleUser: string;
  bgCode: string;
  textPrimary: string;
  textSecondary: string;
  textMuted: string;
  textInverse: string;
  borderSubtle: string;
  borderStrong: string;
  accent: string;
  accentSoft: string;
  accentForeground: string;
  success: string;
  warning: string;
  danger: string;
  info: string;
}

export interface VsCodeThemeMeta {
  extensionId?: string;
  extensionName?: string;
  publisher?: string;
  version?: string;
  variantLabel?: string;
  uiTheme?: string;
  sourcePath?: string;
  marketplaceUrl?: string;
}

export interface CustomTheme {
  id: string;
  name: string;
  description?: string;
  mode: CustomThemeMode;
  source: CustomThemeSource;
  vscodeMeta?: VsCodeThemeMeta;
  tokens: CustomThemeTokens;
  createdAt?: string;
  updatedAt?: string;
}

export interface ThemePreferences {
  modePreference: ThemePreferenceMode;
  activeThemeId: string;
  activeLightThemeId: string;
  activeDarkThemeId: string;
}

export interface ThemesStateSnapshot {
  themes: CustomTheme[];
  preferences: ThemePreferences;
  revision: number;
  updatedAt: string;
}

export interface ThemeContrastAdjustment {
  token: CustomThemeTokenKey;
  from: string;
  to: string;
  reason: string;
}

export interface ThemeContrastCheck {
  ratio: number;
  target: number;
  pass: boolean;
}

export interface ThemeContrastReport {
  textOnCanvas: ThemeContrastCheck;
  textOnSurface: ThemeContrastCheck;
  textSecondaryOnCanvas: ThemeContrastCheck;
  textMutedOnCanvas: ThemeContrastCheck;
  accentForegroundOnAccent: ThemeContrastCheck;
  accentOnSurface: ThemeContrastCheck;
  allPassed: boolean;
  minRatio: number;
  grade: 'AAA' | 'AA' | 'A';
}

export interface EnsureReadableThemeResult {
  tokens: CustomThemeTokens;
  adjustments: ThemeContrastAdjustment[];
  report: ThemeContrastReport;
}

export const BUILTIN_LIGHT_THEME_ID = 'builtin-light';
export const BUILTIN_DARK_THEME_ID = 'builtin-dark';

export const DEFAULT_THEME_PREFERENCES: ThemePreferences = {
  modePreference: 'system',
  activeThemeId: BUILTIN_LIGHT_THEME_ID,
  activeLightThemeId: BUILTIN_LIGHT_THEME_ID,
  activeDarkThemeId: BUILTIN_DARK_THEME_ID
};

export const hexColorSchema = z.string().trim().refine(value => normalizeHexColor(value) !== null, {
  message: '必须是合法的十六进制或 RGB 颜色值（如 #1a1b26）'
});

export const customThemeTokensSchema = z.object({
  bgCanvas: hexColorSchema,
  bgSidebar: hexColorSchema,
  bgSurface: hexColorSchema,
  bgSurfaceHover: hexColorSchema,
  bgElevated: hexColorSchema,
  bgBubbleUser: hexColorSchema,
  bgCode: hexColorSchema,
  textPrimary: hexColorSchema,
  textSecondary: hexColorSchema,
  textMuted: hexColorSchema,
  textInverse: hexColorSchema,
  borderSubtle: hexColorSchema,
  borderStrong: hexColorSchema,
  accent: hexColorSchema,
  accentSoft: hexColorSchema,
  accentForeground: hexColorSchema,
  success: hexColorSchema,
  warning: hexColorSchema,
  danger: hexColorSchema,
  info: hexColorSchema
});

export const partialCustomThemeTokensSchema = customThemeTokensSchema.partial();

export const vsCodeThemeMetaSchema = z.object({
  extensionId: z.string().max(200).optional(),
  extensionName: z.string().max(200).optional(),
  publisher: z.string().max(120).optional(),
  version: z.string().max(60).optional(),
  variantLabel: z.string().max(200).optional(),
  uiTheme: z.string().max(40).optional(),
  sourcePath: z.string().max(500).optional(),
  marketplaceUrl: z.string().max(500).optional()
});

export const customThemeSchema = z.object({
  id: z.string().trim().min(1).max(120),
  name: z.string().trim().min(1).max(80),
  description: z.string().trim().max(300).optional(),
  mode: z.enum(customThemeModes),
  source: z.enum(customThemeSources),
  vscodeMeta: vsCodeThemeMetaSchema.optional(),
  tokens: customThemeTokensSchema,
  createdAt: z.string().optional(),
  updatedAt: z.string().optional()
});

export const themePreferencesSchema = z.object({
  modePreference: z.enum(themePreferenceModes).default('system'),
  activeThemeId: z.string().trim().min(1).default(BUILTIN_LIGHT_THEME_ID),
  activeLightThemeId: z.string().trim().min(1).default(BUILTIN_LIGHT_THEME_ID),
  activeDarkThemeId: z.string().trim().min(1).default(BUILTIN_DARK_THEME_ID)
});

/* ============================================================================
 * 颜色数学与 WCAG 2.1 对比度计算（零依赖）
 * ============================================================================ */

export type RgbTuple = [number, number, number];
export interface RgbaColor {
  r: number;
  g: number;
  b: number;
  a: number;
}
export interface HslColor {
  h: number; // 0..360
  s: number; // 0..1
  l: number; // 0..1
}

const clampByte = (value: number) => Math.max(0, Math.min(255, Math.round(value)));
const clampUnit = (value: number) => Math.max(0, Math.min(1, value));

export function rgbToHex(r: number, g: number, b: number): string {
  const toHex = (n: number) => clampByte(n).toString(16).padStart(2, '0');
  return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
}

/** 解析 #RGB / #RGBA / #RRGGBB / #RRGGBBAA / rgb() / rgba()，返回含 alpha 的 RGBA。 */
export function parseCssColor(raw: string): RgbaColor | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;

  if (trimmed.startsWith('#')) {
    const body = trimmed.slice(1);
    if (/^[0-9a-f]{3}$/i.test(body)) {
      return {
        r: parseInt(body[0]! + body[0]!, 16),
        g: parseInt(body[1]! + body[1]!, 16),
        b: parseInt(body[2]! + body[2]!, 16),
        a: 1
      };
    }
    if (/^[0-9a-f]{4}$/i.test(body)) {
      return {
        r: parseInt(body[0]! + body[0]!, 16),
        g: parseInt(body[1]! + body[1]!, 16),
        b: parseInt(body[2]! + body[2]!, 16),
        a: parseInt(body[3]! + body[3]!, 16) / 255
      };
    }
    if (/^[0-9a-f]{6}$/i.test(body)) {
      return {
        r: parseInt(body.slice(0, 2), 16),
        g: parseInt(body.slice(2, 4), 16),
        b: parseInt(body.slice(4, 6), 16),
        a: 1
      };
    }
    if (/^[0-9a-f]{8}$/i.test(body)) {
      return {
        r: parseInt(body.slice(0, 2), 16),
        g: parseInt(body.slice(2, 4), 16),
        b: parseInt(body.slice(4, 6), 16),
        a: parseInt(body.slice(6, 8), 16) / 255
      };
    }
    return null;
  }

  const rgbMatch = /^rgba?\(\s*([0-9.]+)\s*[,\s]\s*([0-9.]+)\s*[,\s]\s*([0-9.]+)(?:\s*[,/]\s*([0-9.]+%?))?\s*\)$/i.exec(trimmed);
  if (rgbMatch) {
    const r = Number(rgbMatch[1]);
    const g = Number(rgbMatch[2]);
    const b = Number(rgbMatch[3]);
    let a = 1;
    if (rgbMatch[4] !== undefined) {
      a = rgbMatch[4].endsWith('%') ? Number(rgbMatch[4].slice(0, -1)) / 100 : Number(rgbMatch[4]);
    }
    if (![r, g, b, a].every(Number.isFinite)) return null;
    return { r: clampByte(r), g: clampByte(g), b: clampByte(b), a: clampUnit(a) };
  }

  return null;
}

/** 归一化为标准小写 6 位 #rrggbb；若带透明通道可指定底色做 alpha 合成。 */
export function normalizeHexColor(raw: string, backdropHex?: string): string | null {
  const parsed = parseCssColor(raw);
  if (!parsed) return null;
  if (parsed.a < 1 && backdropHex) {
    const bg = parseCssColor(backdropHex);
    if (bg) {
      const a = parsed.a;
      return rgbToHex(
        parsed.r * a + bg.r * (1 - a),
        parsed.g * a + bg.g * (1 - a),
        parsed.b * a + bg.b * (1 - a)
      );
    }
  }
  return rgbToHex(parsed.r, parsed.g, parsed.b);
}

/** 将带可选透明通道的前景色合成到背景色上（VS Code 主题大量使用 #rrggbbaa）。 */
export function compositeColorOver(fgRaw: string, bgHex: string): string | null {
  const fg = parseCssColor(fgRaw);
  if (!fg) return null;
  if (fg.a <= 0.01) return null;
  if (fg.a >= 0.995) return rgbToHex(fg.r, fg.g, fg.b);
  const bg = parseCssColor(bgHex);
  if (!bg) return rgbToHex(fg.r, fg.g, fg.b);
  const a = fg.a;
  return rgbToHex(
    fg.r * a + bg.r * (1 - a),
    fg.g * a + bg.g * (1 - a),
    fg.b * a + bg.b * (1 - a)
  );
}

export function hexToRgb(hex: string): RgbTuple {
  const parsed = parseCssColor(hex);
  if (!parsed) return [0, 0, 0];
  return [parsed.r, parsed.g, parsed.b];
}

export function hexToRgbTriplet(hex: string): string {
  const [r, g, b] = hexToRgb(hex);
  return `${r} ${g} ${b}`;
}

export function mixHex(hexA: string, hexB: string, weightB: number): string {
  const t = clampUnit(weightB);
  const [ar, ag, ab] = hexToRgb(hexA);
  const [br, bg, bb] = hexToRgb(hexB);
  return rgbToHex(
    ar + (br - ar) * t,
    ag + (bg - ag) * t,
    ab + (bb - ab) * t
  );
}

export function rgbToHsl(r: number, g: number, b: number): HslColor {
  const rn = clampByte(r) / 255;
  const gn = clampByte(g) / 255;
  const bn = clampByte(b) / 255;
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const l = (max + min) / 2;
  if (max === min) return { h: 0, s: 0, l };
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h = 0;
  if (max === rn) h = ((gn - bn) / d + (gn < bn ? 6 : 0)) * 60;
  else if (max === gn) h = ((bn - rn) / d + 2) * 60;
  else h = ((rn - gn) / d + 4) * 60;
  return { h, s, l };
}

export function hslToRgb(h: number, s: number, l: number): RgbTuple {
  const hn = ((h % 360) + 360) % 360;
  const sn = clampUnit(s);
  const ln = clampUnit(l);
  if (sn === 0) {
    const v = clampByte(ln * 255);
    return [v, v, v];
  }
  const c = (1 - Math.abs(2 * ln - 1)) * sn;
  const x = c * (1 - Math.abs(((hn / 60) % 2) - 1));
  const m = ln - c / 2;
  let r1 = 0; let g1 = 0; let b1 = 0;
  if (hn < 60) [r1, g1, b1] = [c, x, 0];
  else if (hn < 120) [r1, g1, b1] = [x, c, 0];
  else if (hn < 180) [r1, g1, b1] = [0, c, x];
  else if (hn < 240) [r1, g1, b1] = [0, x, c];
  else if (hn < 300) [r1, g1, b1] = [x, 0, c];
  else [r1, g1, b1] = [c, 0, x];
  return [clampByte((r1 + m) * 255), clampByte((g1 + m) * 255), clampByte((b1 + m) * 255)];
}

export function hexToHsl(hex: string): HslColor {
  const [r, g, b] = hexToRgb(hex);
  return rgbToHsl(r, g, b);
}

export function hslToHex(h: number, s: number, l: number): string {
  const [r, g, b] = hslToRgb(h, s, l);
  return rgbToHex(r, g, b);
}

/** WCAG 2.1 相对亮度（0 = 纯黑，1 = 纯白）。 */
export function relativeLuminance(hex: string): number {
  const [r, g, b] = hexToRgb(hex);
  const linear = (channel: number) => {
    const s = channel / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b);
}

/** WCAG 2.1 对比度（1.0 ~ 21.0）。 */
export function contrastRatio(hexA: string, hexB: string): number {
  const l1 = relativeLuminance(hexA);
  const l2 = relativeLuminance(hexB);
  const lighter = Math.max(l1, l2);
  const darker = Math.min(l1, l2);
  return (lighter + 0.05) / (darker + 0.05);
}

const roundRatio = (ratio: number) => Math.round(ratio * 100) / 100;

/** 判断颜色是否为中性低饱和度灰阶（默认浅/深主题的黑白强调色需要链接回退到 info）。 */
export function isAchromatic(hex: string): boolean {
  const { s } = hexToHsl(hex);
  return s < 0.09;
}

/**
 * 保留色相（Hue）的前提下，沿着明度轴向目标方向二分搜索满足全部背景对比度阈值的最近颜色。
 * 这样既保证 WCAG 清晰可读，又最大程度保留用户 / AI / VS Code 原主题的色调性格。
 */
function adjustColorForContrast(
  hex: string,
  backgrounds: string[],
  minRatio: number,
  preferDirection?: 'lighter' | 'darker'
): string {
  const minCurrent = Math.min(...backgrounds.map(bg => contrastRatio(hex, bg)));
  if (minCurrent >= minRatio) return hex;

  const hsl = hexToHsl(hex);
  const avgBgLum = backgrounds.reduce((sum, bg) => sum + relativeLuminance(bg), 0) / backgrounds.length;
  const primaryDir: 'lighter' | 'darker' = preferDirection ?? (avgBgLum > 0.42 ? 'darker' : 'lighter');
  const fallbackDir: 'lighter' | 'darker' = primaryDir === 'lighter' ? 'darker' : 'lighter';

  const searchDirection = (dir: 'lighter' | 'darker'): { hex: string; ratio: number } | null => {
    const extremeL = dir === 'lighter' ? 0.985 : 0.04;
    const satScale = dir === 'lighter' ? Math.min(hsl.s, 0.85) : Math.min(hsl.s, 0.9);
    const extremeHex = hslToHex(hsl.h, satScale, extremeL);
    const extremeRatio = Math.min(...backgrounds.map(bg => contrastRatio(extremeHex, bg)));
    if (extremeRatio < minRatio) {
      // 若纯保持饱和度仍达不到阈值，尝试降饱和直奔极端白/黑
      const pureExtreme = dir === 'lighter' ? '#ffffff' : '#0b0d12';
      const pureRatio = Math.min(...backgrounds.map(bg => contrastRatio(pureExtreme, bg)));
      if (pureRatio < minRatio) return null;
      // 在 hex 和 pureExtreme 之间线性混合找最近达标点
      let lo = 0; let hi = 1; let best = pureExtreme;
      for (let i = 0; i < 16; i++) {
        const mid = (lo + hi) / 2;
        const candidate = mixHex(hex, pureExtreme, mid);
        const r = Math.min(...backgrounds.map(bg => contrastRatio(candidate, bg)));
        if (r >= minRatio) { best = candidate; hi = mid; }
        else { lo = mid; }
      }
      return { hex: best, ratio: Math.min(...backgrounds.map(bg => contrastRatio(best, bg))) };
    }
    let lo = 0; let hi = 1; let best = extremeHex;
    for (let i = 0; i < 18; i++) {
      const mid = (lo + hi) / 2;
      const candL = hsl.l + (extremeL - hsl.l) * mid;
      const candS = hsl.s + (satScale - hsl.s) * mid * 0.35;
      const candidate = hslToHex(hsl.h, candS, candL);
      const r = Math.min(...backgrounds.map(bg => contrastRatio(candidate, bg)));
      if (r >= minRatio) { best = candidate; hi = mid; }
      else { lo = mid; }
    }
    return { hex: best, ratio: Math.min(...backgrounds.map(bg => contrastRatio(best, bg))) };
  };

  const primary = searchDirection(primaryDir);
  if (primary) return primary.hex;
  const fallback = searchDirection(fallbackDir);
  if (fallback) return fallback.hex;

  const whiteRatio = Math.min(...backgrounds.map(bg => contrastRatio('#ffffff', bg)));
  const blackRatio = Math.min(...backgrounds.map(bg => contrastRatio('#0d0f14', bg)));
  return whiteRatio >= blackRatio ? '#ffffff' : '#0d0f14';
}

function clampSurfacePolarity(hex: string, mode: CustomThemeMode, maxLumDark: number, minLumLight: number): string {
  const lum = relativeLuminance(hex);
  const hsl = hexToHsl(hex);
  if (mode === 'dark' && lum > maxLumDark) {
    // 保持色相和低饱和微染，把过亮底色压回到深色舒适区间
    const targetL = Math.min(0.24, Math.max(0.08, hsl.l * 0.22));
    return hslToHex(hsl.h, Math.min(hsl.s, 0.42), targetL);
  }
  if (mode === 'light' && lum < minLumLight) {
    const targetL = Math.max(0.91, Math.min(0.985, 1 - (1 - hsl.l) * 0.12));
    return hslToHex(hsl.h, Math.min(hsl.s, 0.38), targetL);
  }
  return hex;
}

/* ============================================================================
 * 20 套精选内置主题预设（10 浅 + 10 深，全部通过 WCAG AA/AAA 对比度校验）
 * ============================================================================ */

export const BUILTIN_THEMES: readonly CustomTheme[] = [
  {
    id: BUILTIN_LIGHT_THEME_ID,
    name: '默认浅色',
    description: 'AgentDock 经典克制极简浅色，纯净白画布与清透浅灰侧栏',
    mode: 'light',
    source: 'builtin',
    tokens: {
      bgCanvas: '#ffffff',
      bgSidebar: '#f9f9f9',
      bgSurface: '#ffffff',
      bgSurfaceHover: '#ececec',
      bgElevated: '#ffffff',
      bgBubbleUser: '#f4f4f4',
      bgCode: '#f7f7f7',
      textPrimary: '#0d0d0d',
      textSecondary: '#525252',
      textMuted: '#6b6b6b',
      textInverse: '#ffffff',
      borderSubtle: '#ececec',
      borderStrong: '#d4d4d4',
      accent: '#0d0d0d',
      accentSoft: '#ececec',
      accentForeground: '#ffffff',
      success: '#059669',
      warning: '#d97706',
      danger: '#dc2626',
      info: '#2563eb'
    }
  },
  {
    id: BUILTIN_DARK_THEME_ID,
    name: '默认深色',
    description: 'AgentDock 经典石墨深色，沉稳低眩光层次与高可读文字',
    mode: 'dark',
    source: 'builtin',
    tokens: {
      bgCanvas: '#212121',
      bgSidebar: '#171717',
      bgSurface: '#2a2a2a',
      bgSurfaceHover: '#333333',
      bgElevated: '#2f2f2f',
      bgBubbleUser: '#2f2f2f',
      bgCode: '#1a1a1a',
      textPrimary: '#ececec',
      textSecondary: '#b4b4b4',
      textMuted: '#9b9b9b',
      textInverse: '#171717',
      borderSubtle: '#363636',
      borderStrong: '#4b4b4b',
      accent: '#ececec',
      accentSoft: '#353535',
      accentForeground: '#171717',
      success: '#34d399',
      warning: '#fbbf24',
      danger: '#f87171',
      info: '#7aa7ff'
    }
  },
  {
    id: 'builtin-aurora-pine',
    name: '极光青松',
    description: '北境极光深青松林，沉静松黛夜幕与清透薄荷青高亮',
    mode: 'dark',
    source: 'builtin',
    tokens: {
      bgCanvas: '#0f1d1c',
      bgSidebar: '#0a1514',
      bgSurface: '#152726',
      bgSurfaceHover: '#1d3533',
      bgElevated: '#1a2f2e',
      bgBubbleUser: '#1b3331',
      bgCode: '#081211',
      textPrimary: '#dff5f0',
      textSecondary: '#9cc2b9',
      textMuted: '#7ea39b',
      textInverse: '#081412',
      borderSubtle: '#233b39',
      borderStrong: '#345451',
      accent: '#2dd4bf',
      accentSoft: '#163d39',
      accentForeground: '#071a18',
      success: '#34d399',
      warning: '#fbbf24',
      danger: '#f87171',
      info: '#60a5fa'
    }
  },
  {
    id: 'builtin-sakura-obsidian',
    name: '樱夜黑曜 · Sakura Obsidian',
    description: '黑曜紫檀夜幕与樱花柔粉点缀，温润浪漫的高可读暗色',
    mode: 'dark',
    source: 'builtin',
    tokens: {
      bgCanvas: '#191522',
      bgSidebar: '#13101a',
      bgSurface: '#221c2e',
      bgSurfaceHover: '#2e263d',
      bgElevated: '#262034',
      bgBubbleUser: '#342334',
      bgCode: '#110e17',
      textPrimary: '#f0e8f8',
      textSecondary: '#b5a8cc',
      textMuted: '#9285ab',
      textInverse: '#130e19',
      borderSubtle: '#322a44',
      borderStrong: '#473c60',
      accent: '#f28cb1',
      accentSoft: '#3d2538',
      accentForeground: '#190e1a',
      success: '#7ee0a8',
      warning: '#f4c974',
      danger: '#f47998',
      info: '#93c5fd'
    }
  },
  {
    id: 'builtin-sakura-dawn',
    name: '樱雾晨晓 · Sakura Dawn',
    description: '淡樱初绽晨雾纸色，柔粉微晕与深玫红点缀的轻盈浅色',
    mode: 'light',
    source: 'builtin',
    tokens: {
      bgCanvas: '#fff7fa',
      bgSidebar: '#f9eef3',
      bgSurface: '#ffffff',
      bgSurfaceHover: '#f3e3eb',
      bgElevated: '#ffffff',
      bgBubbleUser: '#f7e6ee',
      bgCode: '#faf0f5',
      textPrimary: '#341f2d',
      textSecondary: '#664a5d',
      textMuted: '#7d6073',
      textInverse: '#fff7fa',
      borderSubtle: '#ecdce5',
      borderStrong: '#d8bfce',
      accent: '#bd3f6d',
      accentSoft: '#fbe9f0',
      accentForeground: '#ffffff',
      success: '#247a52',
      warning: '#a8690f',
      danger: '#c23a57',
      info: '#2b6cb0'
    }
  },
  {
    id: 'builtin-tokyo-night',
    name: 'Tokyo Night',
    description: '东京深夜霓虹靛蓝，通透夜空层次与电光蓝交互点缀',
    mode: 'dark',
    source: 'builtin',
    tokens: {
      bgCanvas: '#1a1b26',
      bgSidebar: '#16161e',
      bgSurface: '#222536',
      bgSurfaceHover: '#2b3047',
      bgElevated: '#262a3d',
      bgBubbleUser: '#282d44',
      bgCode: '#141620',
      textPrimary: '#c0caf5',
      textSecondary: '#9aa5ce',
      textMuted: '#7a84ab',
      textInverse: '#131521',
      borderSubtle: '#2f354d',
      borderStrong: '#414868',
      accent: '#7aa2f7',
      accentSoft: '#253252',
      accentForeground: '#0f1424',
      success: '#9ece6a',
      warning: '#e0af68',
      danger: '#f7768e',
      info: '#7dcfff'
    }
  },
  {
    id: 'builtin-catppuccin-mocha',
    name: 'Catppuccin Mocha',
    description: '天鹅绒摩卡可可暗色，柔和薰衣草紫与糖霜粉彩语义色',
    mode: 'dark',
    source: 'builtin',
    tokens: {
      bgCanvas: '#1e1e2e',
      bgSidebar: '#181825',
      bgSurface: '#262637',
      bgSurfaceHover: '#313244',
      bgElevated: '#2a2b3d',
      bgBubbleUser: '#2e2f42',
      bgCode: '#161622',
      textPrimary: '#cdd6f4',
      textSecondary: '#a6adc8',
      textMuted: '#8890ad',
      textInverse: '#161622',
      borderSubtle: '#35374b',
      borderStrong: '#4c4f69',
      accent: '#cba6f7',
      accentSoft: '#352c4a',
      accentForeground: '#181526',
      success: '#a6e3a1',
      warning: '#f9e2af',
      danger: '#f38ba8',
      info: '#89b4fa'
    }
  },
  {
    id: 'builtin-nord-frost',
    name: 'Nord Frost',
    description: '北欧极地冷灰岩与冰川青，理性克制的长时间编码暗色',
    mode: 'dark',
    source: 'builtin',
    tokens: {
      bgCanvas: '#2e3440',
      bgSidebar: '#262b35',
      bgSurface: '#353c4a',
      bgSurfaceHover: '#414a5c',
      bgElevated: '#3b4252',
      bgBubbleUser: '#3c4456',
      bgCode: '#242933',
      textPrimary: '#eceff4',
      textSecondary: '#c7d0e0',
      textMuted: '#99a5bb',
      textInverse: '#1f242d',
      borderSubtle: '#434c5e',
      borderStrong: '#566178',
      accent: '#88c0d0',
      accentSoft: '#334857',
      accentForeground: '#1a222b',
      success: '#a3be8c',
      warning: '#ebcb8b',
      danger: '#df7b84',
      info: '#81a1c1'
    }
  },
  {
    id: 'builtin-kyoto-matcha',
    name: '京都抹茶浅色',
    description: '宇治抹茶和纸淡青浅色，温润护眼的东方静谧书桌质感',
    mode: 'light',
    source: 'builtin',
    tokens: {
      bgCanvas: '#f6f8f3',
      bgSidebar: '#edf2e7',
      bgSurface: '#ffffff',
      bgSurfaceHover: '#e5ece0',
      bgElevated: '#ffffff',
      bgBubbleUser: '#e8efe2',
      bgCode: '#eff4ea',
      textPrimary: '#1f2e24',
      textSecondary: '#475c4d',
      textMuted: '#5f7365',
      textInverse: '#f6f8f3',
      borderSubtle: '#dce5d6',
      borderStrong: '#becdb6',
      accent: '#3b7549',
      accentSoft: '#e4f0e6',
      accentForeground: '#ffffff',
      success: '#2c7a4b',
      warning: '#a86910',
      danger: '#c44545',
      info: '#2b6a8a'
    }
  },
  {
    id: 'builtin-rose-pine-dawn',
    name: 'Rosé Pine Dawn',
    description: '蔷薇松木晨曦宣纸浅色，紫檀墨字与松青玫瑰点缀',
    mode: 'light',
    source: 'builtin',
    tokens: {
      bgCanvas: '#faf4ed',
      bgSidebar: '#f2e9e1',
      bgSurface: '#fffaf3',
      bgSurfaceHover: '#ebe0d6',
      bgElevated: '#fffdf9',
      bgBubbleUser: '#f1e7dd',
      bgCode: '#f3eae0',
      textPrimary: '#453f64',
      textSecondary: '#655f82',
      textMuted: '#766f91',
      textInverse: '#fffaf3',
      borderSubtle: '#e4d8cd',
      borderStrong: '#cbbdb1',
      accent: '#9f4c64',
      accentSoft: '#f4e2e6',
      accentForeground: '#fffaf3',
      success: '#2d7a7e',
      warning: '#b06d14',
      danger: '#b44862',
      info: '#286983'
    }
  },
  {
    id: 'builtin-warm-paper',
    name: '暖纸晨光',
    description: '象牙棉纸与陶土赤褐，温和防蓝光的编辑部阅读浅色',
    mode: 'light',
    source: 'builtin',
    tokens: {
      bgCanvas: '#fbf8f1',
      bgSidebar: '#f3ede1',
      bgSurface: '#fffdf8',
      bgSurfaceHover: '#eae1d2',
      bgElevated: '#fffefb',
      bgBubbleUser: '#efe7d8',
      bgCode: '#f4eee2',
      textPrimary: '#292118',
      textSecondary: '#584b3c',
      textMuted: '#6f6150',
      textInverse: '#fffdf8',
      borderSubtle: '#e5dac8',
      borderStrong: '#cbbba4',
      accent: '#b65422',
      accentSoft: '#f6e6da',
      accentForeground: '#fffdf8',
      success: '#2c764e',
      warning: '#a8690f',
      danger: '#be3f37',
      info: '#2b648f'
    }
  },
  {
    id: 'builtin-one-dark-pro',
    name: 'One Dark Pro',
    description: '经典 Atom / VS Code 炭灰冷蓝，平衡克制的开发者常青暗色',
    mode: 'dark',
    source: 'builtin',
    tokens: {
      bgCanvas: '#282c34',
      bgSidebar: '#21252b',
      bgSurface: '#2f343f',
      bgSurfaceHover: '#383e4b',
      bgElevated: '#333945',
      bgBubbleUser: '#353b48',
      bgCode: '#1e2228',
      textPrimary: '#d7dce5',
      textSecondary: '#a3acb9',
      textMuted: '#848d9d',
      textInverse: '#181b21',
      borderSubtle: '#3a414e',
      borderStrong: '#4f5869',
      accent: '#61afef',
      accentSoft: '#25384b',
      accentForeground: '#0f1722',
      success: '#98c379',
      warning: '#e5c07b',
      danger: '#e06c75',
      info: '#56b6c2'
    }
  },
  {
    id: 'builtin-dracula',
    name: 'Dracula',
    description: '标志性哥特暗紫与霓虹紫罗兰，鲜明锐利的高对比暗色美学',
    mode: 'dark',
    source: 'builtin',
    tokens: {
      bgCanvas: '#282a36',
      bgSidebar: '#21222c',
      bgSurface: '#303342',
      bgSurfaceHover: '#3b3f52',
      bgElevated: '#353848',
      bgBubbleUser: '#393c4f',
      bgCode: '#1d1f28',
      textPrimary: '#f8f8f2',
      textSecondary: '#c4c7df',
      textMuted: '#949bc0',
      textInverse: '#1a1b24',
      borderSubtle: '#3e4257',
      borderStrong: '#555a75',
      accent: '#bd93f9',
      accentSoft: '#392f54',
      accentForeground: '#1b1429',
      success: '#50fa7b',
      warning: '#f1fa8c',
      danger: '#ff6e6e',
      info: '#8be9fd'
    }
  },
  {
    id: 'builtin-github-dark-dimmed',
    name: 'GitHub Dark Dimmed',
    description: '柔光灰蓝低眩光工程暗色，通透清朗且长时间阅读不累眼',
    mode: 'dark',
    source: 'builtin',
    tokens: {
      bgCanvas: '#22272e',
      bgSidebar: '#1c2128',
      bgSurface: '#2a3039',
      bgSurfaceHover: '#333b46',
      bgElevated: '#2e353f',
      bgBubbleUser: '#303844',
      bgCode: '#191e24',
      textPrimary: '#dce3ec',
      textSecondary: '#9aa5b4',
      textMuted: '#7f8b9b',
      textInverse: '#141920',
      borderSubtle: '#373e47',
      borderStrong: '#4c5561',
      accent: '#539bf5',
      accentSoft: '#22364f',
      accentForeground: '#0c1828',
      success: '#57ab5a',
      warning: '#d4a72c',
      danger: '#f47067',
      info: '#6cb6ff'
    }
  },
  {
    id: 'builtin-gruvbox-dark',
    name: 'Gruvbox Dark',
    description: '复古暖调浓咖黑与秋日琥珀橙，极具怀旧胶片温度的暗色',
    mode: 'dark',
    source: 'builtin',
    tokens: {
      bgCanvas: '#282828',
      bgSidebar: '#1d2021',
      bgSurface: '#32302f',
      bgSurfaceHover: '#3c3836',
      bgElevated: '#363331',
      bgBubbleUser: '#3b3734',
      bgCode: '#1c1e1f',
      textPrimary: '#ebdbb2',
      textSecondary: '#cbbba0',
      textMuted: '#a39582',
      textInverse: '#1d2021',
      borderSubtle: '#423d3a',
      borderStrong: '#5a524c',
      accent: '#fe8019',
      accentSoft: '#453121',
      accentForeground: '#1f1408',
      success: '#b8bb26',
      warning: '#fabd2f',
      danger: '#fb6350',
      info: '#83a598'
    }
  },
  {
    id: 'builtin-catppuccin-latte',
    name: 'Catppuccin Latte',
    description: '柔滑燕麦拿铁浅灰蓝，薰衣草紫点缀的清新糖霜浅色',
    mode: 'light',
    source: 'builtin',
    tokens: {
      bgCanvas: '#eff1f5',
      bgSidebar: '#e6e9ef',
      bgSurface: '#ffffff',
      bgSurfaceHover: '#e1e5ed',
      bgElevated: '#ffffff',
      bgBubbleUser: '#e6e9f2',
      bgCode: '#e9ecf2',
      textPrimary: '#3b3e57',
      textSecondary: '#5a5e7a',
      textMuted: '#6e738f',
      textInverse: '#ffffff',
      borderSubtle: '#d6dbe6',
      borderStrong: '#bcc3d4',
      accent: '#6e3fd4',
      accentSoft: '#ede7fb',
      accentForeground: '#ffffff',
      success: '#28823c',
      warning: '#a8650a',
      danger: '#c92a49',
      info: '#1d63db'
    }
  },
  {
    id: 'builtin-github-light',
    name: 'GitHub Light',
    description: '清爽明净的现代工程白底与经典科技蓝，干练高效不拖泥带水',
    mode: 'light',
    source: 'builtin',
    tokens: {
      bgCanvas: '#ffffff',
      bgSidebar: '#f6f8fa',
      bgSurface: '#ffffff',
      bgSurfaceHover: '#eaeef2',
      bgElevated: '#ffffff',
      bgBubbleUser: '#eef4fb',
      bgCode: '#f6f8fa',
      textPrimary: '#1f2328',
      textSecondary: '#505964',
      textMuted: '#656d76',
      textInverse: '#ffffff',
      borderSubtle: '#e1e6ec',
      borderStrong: '#c9d1d9',
      accent: '#0969da',
      accentSoft: '#ddf4ff',
      accentForeground: '#ffffff',
      success: '#1a7f37',
      warning: '#9a6700',
      danger: '#cf222e',
      info: '#0969da'
    }
  },
  {
    id: 'builtin-solarized-light',
    name: 'Solarized Light',
    description: '殿堂级护眼暖羊皮浅黄与深海蔚蓝，专为长时阅读打磨',
    mode: 'light',
    source: 'builtin',
    tokens: {
      bgCanvas: '#fdf6e3',
      bgSidebar: '#eee8d5',
      bgSurface: '#fffcf2',
      bgSurfaceHover: '#eae3ce',
      bgElevated: '#fffdf5',
      bgBubbleUser: '#f1ead5',
      bgCode: '#f3ecd8',
      textPrimary: '#26434c',
      textSecondary: '#4c666e',
      textMuted: '#627980',
      textInverse: '#fdf6e3',
      borderSubtle: '#e3dbc4',
      borderStrong: '#cbc1a5',
      accent: '#1c71b8',
      accentSoft: '#e4eef5',
      accentForeground: '#ffffff',
      success: '#5c7a00',
      warning: '#9e6d00',
      danger: '#c92c29',
      info: '#1b7e78'
    }
  },
  {
    id: 'builtin-nord-snow',
    name: 'Nord Snow',
    description: '北欧雪原冰川雾蓝浅色，清冽峡湾蓝调与通透层次',
    mode: 'light',
    source: 'builtin',
    tokens: {
      bgCanvas: '#f3f6fa',
      bgSidebar: '#e8eef5',
      bgSurface: '#ffffff',
      bgSurfaceHover: '#dfe7f0',
      bgElevated: '#ffffff',
      bgBubbleUser: '#e6edf6',
      bgCode: '#ecf1f7',
      textPrimary: '#262d3b',
      textSecondary: '#4b566b',
      textMuted: '#637087',
      textInverse: '#f8fafc',
      borderSubtle: '#d7e0eb',
      borderStrong: '#bac7d8',
      accent: '#2f6b99',
      accentSoft: '#e2edf7',
      accentForeground: '#ffffff',
      success: '#3c7a4e',
      warning: '#a36c14',
      danger: '#b8404b',
      info: '#2f6b99'
    }
  },
  {
    id: 'builtin-everforest-light',
    name: 'Everforest Light',
    description: '温润森系原木亚麻与苍翠松苔，柔和护眼的自然系浅色',
    mode: 'light',
    source: 'builtin',
    tokens: {
      bgCanvas: '#f5f1e2',
      bgSidebar: '#ebe5d1',
      bgSurface: '#fcfaf0',
      bgSurfaceHover: '#e6dfc9',
      bgElevated: '#fdfbf2',
      bgBubbleUser: '#ece6d4',
      bgCode: '#efe9d7',
      textPrimary: '#36423d',
      textSecondary: '#55645d',
      textMuted: '#6b7a73',
      textInverse: '#fcfaf0',
      borderSubtle: '#dfd8c2',
      borderStrong: '#c5bca1',
      accent: '#4d7832',
      accentSoft: '#e5eedc',
      accentForeground: '#ffffff',
      success: '#3b7a52',
      warning: '#a66a12',
      danger: '#c24242',
      info: '#2c6f82'
    }
  }
];

export function isBuiltinThemeId(id: string): boolean {
  return BUILTIN_THEMES.some(theme => theme.id === id);
}

export function getBuiltinTheme(id: string): CustomTheme | undefined {
  return BUILTIN_THEMES.find(theme => theme.id === id);
}

export function getDefaultThemeForMode(mode: CustomThemeMode): CustomTheme {
  return mode === 'dark' ? BUILTIN_THEMES[1]! : BUILTIN_THEMES[0]!;
}

/** 计算给定色板的 WCAG 对比度体检报告（不修改色值）。 */
export function evaluateThemeContrast(tokens: CustomThemeTokens): ThemeContrastReport {
  const check = (fg: string, bg: string, target: number): ThemeContrastCheck => {
    const ratio = roundRatio(contrastRatio(fg, bg));
    return { ratio, target, pass: ratio >= target };
  };
  const textOnCanvas = check(tokens.textPrimary, tokens.bgCanvas, 4.5);
  const textOnSurface = check(tokens.textPrimary, tokens.bgSurface, 4.5);
  const textSecondaryOnCanvas = check(tokens.textSecondary, tokens.bgCanvas, 4.5);
  const textMutedOnCanvas = check(tokens.textMuted, tokens.bgCanvas, 3.0);
  const accentForegroundOnAccent = check(tokens.accentForeground, tokens.accent, 4.5);
  const accentOnSurface = check(tokens.accent, tokens.bgSurface, 3.0);

  const checks = [
    textOnCanvas,
    textOnSurface,
    textSecondaryOnCanvas,
    textMutedOnCanvas,
    accentForegroundOnAccent,
    accentOnSurface
  ];
  const allPassed = checks.every(item => item.pass);
  const minRatio = roundRatio(Math.min(...checks.map(item => item.ratio)));
  const isAAA = textOnCanvas.ratio >= 7 && textOnSurface.ratio >= 7 && accentForegroundOnAccent.ratio >= 4.5 && allPassed;
  const grade: 'AAA' | 'AA' | 'A' = isAAA ? 'AAA' : allPassed ? 'AA' : 'A';

  return {
    textOnCanvas,
    textOnSurface,
    textSecondaryOnCanvas,
    textMutedOnCanvas,
    accentForegroundOnAccent,
    accentOnSurface,
    allPassed,
    minRatio,
    grade
  };
}

/**
 * WCAG 对比度守护与安全修正算法。
 *
 * 无论输入来自手调、AI 生成还是奇葩 VS Code 主题：
 * 1. 自动补全缺失或非法色值（按画布/模式协调派生，而非生硬拼接）；
 * 2. 守住明暗极性边界（深色模式绝不出现刺眼白底，浅色模式绝不出现黑块背景）；
 * 3. 确保正文 / 次文 / 弱文 / 反色字 / 强调按钮字 / 状态色全部满足清晰的 WCAG 对比度；
 * 4. 返回调整清单与最终对比度体检报告。
 */
export function ensureReadableThemeTokens(
  rawTokens: Partial<Record<CustomThemeTokenKey, string | undefined>>,
  mode: CustomThemeMode
): EnsureReadableThemeResult {
  const base = getDefaultThemeForMode(mode).tokens;
  const adjustments: ThemeContrastAdjustment[] = [];

  const readOrFallback = (key: CustomThemeTokenKey, fallback: string, backdrop?: string): string => {
    const raw = rawTokens[key];
    if (typeof raw === 'string' && raw.trim()) {
      const normalized = normalizeHexColor(raw, backdrop);
      if (normalized) return normalized;
    }
    return fallback;
  };

  // 1. 先确定画布与各层底色，保证明暗极性一致
  const rawCanvas = readOrFallback('bgCanvas', base.bgCanvas);
  const bgCanvas = clampSurfacePolarity(rawCanvas, mode, 0.34, 0.52);
  if (bgCanvas !== rawCanvas) {
    adjustments.push({ token: 'bgCanvas', from: rawCanvas, to: bgCanvas, reason: mode === 'dark' ? '深色模式画布过亮，已调暗至舒适夜色区间' : '浅色模式画布过暗，已提亮至清爽浅底区间' });
  }

  const derivedSidebar = mode === 'dark' ? mixHex(bgCanvas, '#000000', 0.2) : mixHex(bgCanvas, '#000000', 0.035);
  const rawSidebar = readOrFallback('bgSidebar', derivedSidebar, bgCanvas);
  const bgSidebar = clampSurfacePolarity(rawSidebar, mode, 0.32, 0.48);
  if (bgSidebar !== rawSidebar) {
    adjustments.push({ token: 'bgSidebar', from: rawSidebar, to: bgSidebar, reason: '侧栏底色与主题明暗极性冲突，已安全校准' });
  }

  const derivedSurface = mode === 'dark' ? mixHex(bgCanvas, '#ffffff', 0.05) : mixHex(bgCanvas, '#ffffff', 0.65);
  const rawSurface = readOrFallback('bgSurface', derivedSurface, bgCanvas);
  const bgSurface = clampSurfacePolarity(rawSurface, mode, 0.38, 0.56);
  if (bgSurface !== rawSurface) {
    adjustments.push({ token: 'bgSurface', from: rawSurface, to: bgSurface, reason: '卡片表面色与主题明暗极性冲突，已安全校准' });
  }

  const derivedSurfaceHover = mode === 'dark' ? mixHex(bgSurface, '#ffffff', 0.08) : mixHex(bgSurface, '#000000', 0.06);
  const rawSurfaceHover = readOrFallback('bgSurfaceHover', derivedSurfaceHover, bgSurface);
  const bgSurfaceHover = clampSurfacePolarity(rawSurfaceHover, mode, 0.44, 0.48);
  if (bgSurfaceHover !== rawSurfaceHover) {
    adjustments.push({ token: 'bgSurfaceHover', from: rawSurfaceHover, to: bgSurfaceHover, reason: '悬停底色与主题明暗极性冲突，已安全校准' });
  }

  const derivedElevated = mode === 'dark' ? mixHex(bgSurface, '#ffffff', 0.04) : mixHex(bgSurface, '#ffffff', 0.85);
  const rawElevated = readOrFallback('bgElevated', derivedElevated, bgSurface);
  const bgElevated = clampSurfacePolarity(rawElevated, mode, 0.4, 0.56);
  if (bgElevated !== rawElevated) {
    adjustments.push({ token: 'bgElevated', from: rawElevated, to: bgElevated, reason: '浮层底色与主题明暗极性冲突，已安全校准' });
  }

  const derivedBubble = mode === 'dark' ? mixHex(bgCanvas, '#ffffff', 0.08) : mixHex(bgCanvas, '#000000', 0.045);
  const rawBubble = readOrFallback('bgBubbleUser', derivedBubble, bgCanvas);
  const bgBubbleUser = clampSurfacePolarity(rawBubble, mode, 0.4, 0.48);
  if (bgBubbleUser !== rawBubble) {
    adjustments.push({ token: 'bgBubbleUser', from: rawBubble, to: bgBubbleUser, reason: '用户气泡底色与主题明暗极性冲突，已安全校准' });
  }

  const derivedCode = mode === 'dark' ? mixHex(bgCanvas, '#000000', 0.24) : mixHex(bgCanvas, '#000000', 0.032);
  const rawCode = readOrFallback('bgCode', derivedCode, bgCanvas);
  const bgCode = clampSurfacePolarity(rawCode, mode, 0.34, 0.48);
  if (bgCode !== rawCode) {
    adjustments.push({ token: 'bgCode', from: rawCode, to: bgCode, reason: '代码块底色与主题明暗极性冲突，已安全校准' });
  }

  const primarySurfaces = [bgCanvas, bgSurface, bgSidebar, bgBubbleUser, bgElevated];

  // 2. 正文 / 次文 / 弱文 / 反色字 WCAG 对比度校验与修正
  const rawTextPrimary = readOrFallback('textPrimary', base.textPrimary, bgCanvas);
  const textPrimary = adjustColorForContrast(rawTextPrimary, primarySurfaces, 7.0, mode === 'dark' ? 'lighter' : 'darker');
  if (textPrimary !== rawTextPrimary) {
    adjustments.push({ token: 'textPrimary', from: rawTextPrimary, to: textPrimary, reason: '提升主正文与背景的 WCAG 对比度以保证清晰阅读' });
  }

  const derivedTextSecondary = mixHex(textPrimary, bgCanvas, 0.24);
  const rawTextSecondary = readOrFallback('textSecondary', derivedTextSecondary, bgCanvas);
  const textSecondary = adjustColorForContrast(rawTextSecondary, [bgCanvas, bgSurface, bgSidebar], 4.6, mode === 'dark' ? 'lighter' : 'darker');
  if (textSecondary !== rawTextSecondary) {
    adjustments.push({ token: 'textSecondary', from: rawTextSecondary, to: textSecondary, reason: '提升次要正文对比度至 WCAG AA (>= 4.5:1)' });
  }

  const derivedTextMuted = mixHex(textPrimary, bgCanvas, 0.44);
  const rawTextMuted = readOrFallback('textMuted', derivedTextMuted, bgCanvas);
  const textMuted = adjustColorForContrast(rawTextMuted, [bgCanvas, bgSurface, bgSidebar], 3.2, mode === 'dark' ? 'lighter' : 'darker');
  if (textMuted !== rawTextMuted) {
    adjustments.push({ token: 'textMuted', from: rawTextMuted, to: textMuted, reason: '提升辅助/弱文字对比度至清晰可辨水平 (>= 3.0:1)' });
  }

  const derivedTextInverse = contrastRatio('#ffffff', textPrimary) >= contrastRatio('#121318', textPrimary) ? '#ffffff' : '#121318';
  const rawTextInverse = readOrFallback('textInverse', derivedTextInverse);
  const textInverse = adjustColorForContrast(rawTextInverse, [textPrimary], 7.0);
  if (textInverse !== rawTextInverse) {
    adjustments.push({ token: 'textInverse', from: rawTextInverse, to: textInverse, reason: '提升反色文字在深色实心容器上的对比度' });
  }

  // 3. 强调色、强调按钮文字与淡底强调色
  const rawAccent = readOrFallback('accent', base.accent, bgSurface);
  let accent = adjustColorForContrast(rawAccent, [bgSurface, bgCanvas], 3.2, mode === 'dark' ? 'lighter' : 'darker');
  // 避开中亮度“对比度死区”（约 L∈[0.16, 0.21] 时无论纯白还是深墨按钮字都可能略低于 4.5:1）：
  // 浅色主题微调加深以保证白字 >= 4.65:1，深色主题微调提亮以保证深字 >= 4.65:1，同时进一步增强强调色在背景上的辨识度。
  if (Math.max(contrastRatio('#ffffff', accent), contrastRatio('#10131a', accent)) < 4.6) {
    accent = mode === 'light'
      ? adjustColorForContrast(accent, ['#ffffff'], 4.65, 'darker')
      : adjustColorForContrast(accent, ['#10131a'], 4.65, 'lighter');
  }
  if (accent !== rawAccent) {
    adjustments.push({ token: 'accent', from: rawAccent, to: accent, reason: '校准强调色明度，兼顾背景辨识度 (>= 3.0:1) 与按钮文字 WCAG AA 可读性' });
  }

  const autoAccentFg = contrastRatio('#ffffff', accent) >= contrastRatio('#10131a', accent) ? '#ffffff' : '#10131a';
  const rawAccentFg = readOrFallback('accentForeground', autoAccentFg);
  const accentForeground = contrastRatio(rawAccentFg, accent) >= 4.5
    ? rawAccentFg
    : adjustColorForContrast(autoAccentFg, [accent], 4.6);
  if (accentForeground !== rawAccentFg) {
    adjustments.push({ token: 'accentForeground', from: rawAccentFg, to: accentForeground, reason: '确保强调按钮文字满足 WCAG AA (>= 4.5:1) 对比度' });
  }

  const derivedAccentSoft = mixHex(bgSurface, accent, mode === 'dark' ? 0.2 : 0.12);
  const rawAccentSoft = readOrFallback('accentSoft', derivedAccentSoft, bgSurface);
  let accentSoft = clampSurfacePolarity(rawAccentSoft, mode, 0.44, 0.5);
  if (contrastRatio(textPrimary, accentSoft) < 4.5) {
    accentSoft = derivedAccentSoft;
  }
  if (accentSoft !== rawAccentSoft) {
    adjustments.push({ token: 'accentSoft', from: rawAccentSoft, to: accentSoft, reason: '柔化强调浅底以确保叠加正文清晰可读' });
  }

  // 4. 边框层次（避免隐形或过于刺眼）
  const derivedBorderSubtle = mixHex(bgSurface, textPrimary, mode === 'dark' ? 0.12 : 0.1);
  const rawBorderSubtle = readOrFallback('borderSubtle', derivedBorderSubtle, bgSurface);
  let borderSubtle = rawBorderSubtle;
  const subtleRatio = contrastRatio(borderSubtle, bgSurface);
  if (subtleRatio < 1.12 || subtleRatio > 3.2) {
    borderSubtle = derivedBorderSubtle;
    adjustments.push({ token: 'borderSubtle', from: rawBorderSubtle, to: borderSubtle, reason: '校准细边框层次感，避免不可见或过重割裂' });
  }

  const derivedBorderStrong = mixHex(borderSubtle, textPrimary, mode === 'dark' ? 0.18 : 0.16);
  const rawBorderStrong = readOrFallback('borderStrong', derivedBorderStrong, bgSurface);
  let borderStrong = rawBorderStrong;
  if (contrastRatio(borderStrong, bgSurface) < 1.28) {
    borderStrong = derivedBorderStrong;
    adjustments.push({ token: 'borderStrong', from: rawBorderStrong, to: borderStrong, reason: '校准强调边框的清晰度' });
  }

  // 5. 四类语义状态色（success / warning / danger / info）
  const fixSemantic = (key: 'success' | 'warning' | 'danger' | 'info', fallback: string): string => {
    const raw = readOrFallback(key, fallback, bgSurface);
    const fixed = adjustColorForContrast(raw, [bgSurface, bgCanvas], 3.4, mode === 'dark' ? 'lighter' : 'darker');
    if (fixed !== raw) {
      adjustments.push({ token: key, from: raw, to: fixed, reason: `提升语义状态色 ${key} 在背景上的可读对比度` });
    }
    return fixed;
  };

  const tokens: CustomThemeTokens = {
    bgCanvas,
    bgSidebar,
    bgSurface,
    bgSurfaceHover,
    bgElevated,
    bgBubbleUser,
    bgCode,
    textPrimary,
    textSecondary,
    textMuted,
    textInverse,
    borderSubtle,
    borderStrong,
    accent,
    accentSoft,
    accentForeground,
    success: fixSemantic('success', base.success),
    warning: fixSemantic('warning', base.warning),
    danger: fixSemantic('danger', base.danger),
    info: fixSemantic('info', base.info)
  };

  return {
    tokens,
    adjustments,
    report: evaluateThemeContrast(tokens)
  };
}

/* ============================================================================
 * 主题解析与全站 CSS 变量桥接
 * ============================================================================ */

export function resolveActiveTheme(
  themes: readonly CustomTheme[],
  preferences: ThemePreferences,
  systemMode: CustomThemeMode = 'light'
): CustomTheme {
  const byId = new Map(themes.map(theme => [theme.id, theme]));
  const fallbackLight = byId.get(BUILTIN_LIGHT_THEME_ID) ?? BUILTIN_THEMES[0]!;
  const fallbackDark = byId.get(BUILTIN_DARK_THEME_ID) ?? BUILTIN_THEMES[1]!;

  if (preferences.modePreference === 'system') {
    const targetId = systemMode === 'dark' ? preferences.activeDarkThemeId : preferences.activeLightThemeId;
    const candidate = byId.get(targetId);
    if (candidate && candidate.mode === systemMode) return candidate;
    return systemMode === 'dark' ? fallbackDark : fallbackLight;
  }

  const explicit = byId.get(preferences.activeThemeId);
  if (explicit && explicit.mode === preferences.modePreference) return explicit;

  const rememberedId = preferences.modePreference === 'dark'
    ? preferences.activeDarkThemeId
    : preferences.activeLightThemeId;
  const remembered = byId.get(rememberedId);
  if (remembered && remembered.mode === preferences.modePreference) return remembered;

  return preferences.modePreference === 'dark' ? fallbackDark : fallbackLight;
}

/**
 * 将 CustomTheme 映射为可直接注入 :root 的完整 CSS 变量字典：
 * - `--bg` / `--rail` / `--surface` / `--elevated` / `--bubble` / `--code-bg` / `--ink`
 * - `--accent` / `--accent-soft` / `--accent-fg` / `--link`
 * - `--zinc-50` .. `--zinc-950`（按当前主题单调平滑插值，无缝驱动全站 Tailwind 类）
 * - `--red/amber/orange/emerald/sky/blue-50/100/200`（按语义状态色与底色柔和混色）
 * - `--board-*`（同步驱动自由拖拽看板画布/列槽/卡片/小猫 Dock）
 * - `--theme-*`（保留语义化原值，便于组件与插件直接消费）
 */
export function themeToCssVariables(theme: CustomTheme): Record<string, string> {
  const t = theme.tokens;
  const dark = theme.mode === 'dark';

  // 默认黑白单色强调时，链接色仍使用 info 蓝；彩色自定义/精选主题直接用其标志性 accent 作为链接与焦点强调色
  const linkColor = isAchromatic(t.accent) ? t.info : t.accent;

  const zinc50 = dark ? mixHex(t.bgCanvas, t.bgSurface, 0.55) : mixHex(t.bgCanvas, t.bgSurfaceHover, 0.35);
  const zinc100 = t.bgSurfaceHover;
  const zinc200 = t.borderSubtle;
  const zinc300 = t.borderStrong;
  const zinc400 = t.textMuted;
  const zinc500 = mixHex(t.textMuted, t.textSecondary, 0.52);
  const zinc600 = t.textSecondary;
  const zinc700 = mixHex(t.textSecondary, t.textPrimary, 0.45);
  const zinc800 = mixHex(t.textSecondary, t.textPrimary, 0.8);
  const zinc900 = t.textPrimary;
  const zinc950 = dark ? mixHex(t.textPrimary, '#ffffff', 0.35) : mixHex(t.textPrimary, '#000000', 0.45);

  const tintScale = (semanticHex: string) => ({
    s50: mixHex(t.bgSurface, semanticHex, dark ? 0.16 : 0.08),
    s100: mixHex(t.bgSurface, semanticHex, dark ? 0.24 : 0.16),
    s200: mixHex(t.bgSurface, semanticHex, dark ? 0.36 : 0.28)
  });

  const red = tintScale(t.danger);
  const amber = tintScale(t.warning);
  const orange = tintScale(mixHex(t.warning, t.danger, 0.42));
  const emerald = tintScale(t.success);
  const sky = tintScale(t.info);
  const blue = tintScale(mixHex(t.info, linkColor, 0.35));

  const [elevR, elevG, elevB] = hexToRgb(t.bgElevated);
  const [borderR, borderG, borderB] = hexToRgb(t.borderStrong);

  const boardCanvas = dark ? mixHex(t.bgSidebar, t.bgCanvas, 0.35) : mixHex(t.bgSidebar, t.bgCanvas, 0.35);
  const boardLane = dark ? mixHex(t.bgCanvas, t.bgSurface, 0.25) : mixHex(t.bgSidebar, t.bgSurfaceHover, 0.45);
  const boardLaneHover = dark ? mixHex(t.bgSurface, t.bgSurfaceHover, 0.6) : mixHex(t.bgSurfaceHover, t.borderSubtle, 0.5);

  return {
    // 核心 AgentDock / Tailwind RGB 三元组
    '--bg': hexToRgbTriplet(t.bgCanvas),
    '--rail': hexToRgbTriplet(t.bgSidebar),
    '--ink': hexToRgbTriplet(t.textInverse),
    '--surface': hexToRgbTriplet(t.bgSurface),
    '--elevated': hexToRgbTriplet(t.bgElevated),
    '--bubble': hexToRgbTriplet(t.bgBubbleUser),
    '--code-bg': hexToRgbTriplet(t.bgCode),
    '--accent': hexToRgbTriplet(t.accent),
    '--accent-soft': hexToRgbTriplet(t.accentSoft),
    '--accent-fg': hexToRgbTriplet(t.accentForeground),
    '--link': hexToRgbTriplet(linkColor),

    // zinc 11 阶单调中性色
    '--zinc-50': hexToRgbTriplet(zinc50),
    '--zinc-100': hexToRgbTriplet(zinc100),
    '--zinc-200': hexToRgbTriplet(zinc200),
    '--zinc-300': hexToRgbTriplet(zinc300),
    '--zinc-400': hexToRgbTriplet(zinc400),
    '--zinc-500': hexToRgbTriplet(zinc500),
    '--zinc-600': hexToRgbTriplet(zinc600),
    '--zinc-700': hexToRgbTriplet(zinc700),
    '--zinc-800': hexToRgbTriplet(zinc800),
    '--zinc-900': hexToRgbTriplet(zinc900),
    '--zinc-950': hexToRgbTriplet(zinc950),

    // 语义状态淡底阶
    '--red-50': hexToRgbTriplet(red.s50),
    '--red-100': hexToRgbTriplet(red.s100),
    '--red-200': hexToRgbTriplet(red.s200),
    '--amber-50': hexToRgbTriplet(amber.s50),
    '--amber-100': hexToRgbTriplet(amber.s100),
    '--amber-200': hexToRgbTriplet(amber.s200),
    '--orange-50': hexToRgbTriplet(orange.s50),
    '--orange-100': hexToRgbTriplet(orange.s100),
    '--orange-200': hexToRgbTriplet(orange.s200),
    '--emerald-50': hexToRgbTriplet(emerald.s50),
    '--emerald-100': hexToRgbTriplet(emerald.s100),
    '--emerald-200': hexToRgbTriplet(emerald.s200),
    '--sky-50': hexToRgbTriplet(sky.s50),
    '--sky-100': hexToRgbTriplet(sky.s100),
    '--sky-200': hexToRgbTriplet(sky.s200),
    '--blue-50': hexToRgbTriplet(blue.s50),
    '--blue-100': hexToRgbTriplet(blue.s100),
    '--blue-200': hexToRgbTriplet(blue.s200),

    // 语义化完整令牌（hex）
    '--theme-bg-canvas': t.bgCanvas,
    '--theme-bg-sidebar': t.bgSidebar,
    '--theme-bg-surface': t.bgSurface,
    '--theme-bg-surface-hover': t.bgSurfaceHover,
    '--theme-bg-elevated': t.bgElevated,
    '--theme-bg-bubble-user': t.bgBubbleUser,
    '--theme-bg-code': t.bgCode,
    '--theme-text-primary': t.textPrimary,
    '--theme-text-secondary': t.textSecondary,
    '--theme-text-muted': t.textMuted,
    '--theme-text-inverse': t.textInverse,
    '--theme-border-subtle': t.borderSubtle,
    '--theme-border-strong': t.borderStrong,
    '--theme-accent': t.accent,
    '--theme-accent-soft': t.accentSoft,
    '--theme-accent-foreground': t.accentForeground,
    '--theme-success': t.success,
    '--theme-warning': t.warning,
    '--theme-danger': t.danger,
    '--theme-info': t.info,

    // 看板变量联动
    '--board-canvas': boardCanvas,
    '--board-lane': boardLane,
    '--board-lane-hover': boardLaneHover,
    '--board-card': t.bgSurface,
    '--board-card-border': `rgba(${borderR}, ${borderG}, ${borderB}, ${dark ? 0.38 : 0.42})`,
    '--board-dock-bg': `rgba(${elevR}, ${elevG}, ${elevB}, 0.88)`,
    '--board-dock-border': `rgba(${borderR}, ${borderG}, ${borderB}, ${dark ? 0.5 : 0.52})`
  };
}

export function slugifyThemeId(name: string, prefix = 'theme'): string {
  const ascii = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 36);
  const rand = crypto.randomUUID().slice(0, 8);
  return ascii ? `${prefix}-${ascii}-${rand}` : `${prefix}-${rand}`;
}
