/**
 * 轻量主题外观兼容出口：桥接到完整语义化主题引擎（./themes.ts），
 * 保持既有 useThemeMode / useResolvedTheme / setThemeMode / applyAppearance 契约不变。
 */
export {
  applyAppearance,
  readThemeMode,
  resolveTheme,
  setThemeMode,
  useActiveTheme,
  useResolvedTheme,
  useThemeMode,
  useThemesState,
  useThemeSync,
  type ResolvedTheme,
  type ThemeMode
} from './themes';
