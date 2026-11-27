import { EventEmitter } from 'node:events';
import {
  BUILTIN_DARK_THEME_ID,
  BUILTIN_LIGHT_THEME_ID,
  BUILTIN_THEMES,
  DEFAULT_THEME_PREFERENCES,
  RuntimeError,
  customThemeModes,
  customThemeSources,
  customThemeTokenKeys,
  customThemeSchema,
  ensureReadableThemeTokens,
  isBuiltinThemeId,
  now,
  slugifyThemeId,
  themePreferenceModes,
  themePreferencesSchema,
  type ConfigRepository,
  type CustomTheme,
  type CustomThemeMode,
  type CustomThemeSource,
  type CustomThemeTokenKey,
  type ThemeContrastAdjustment,
  type ThemeContrastReport,
  type ThemePreferenceMode,
  type ThemePreferences,
  type ThemesStateSnapshot,
  type VsCodeThemeMeta
} from '@agent-dock/agent-dock-shared';
import type { LlmEndpointService } from '../llm/service.js';
import {
  parseJsonc,
  parseVsCodeThemeSource,
  type ParsedVsCodeThemeVariant
} from './vscode-importer.js';

export const customThemesConfigKey = 'platform.themes.custom';
export const themePreferencesConfigKey = 'platform.themes.preferences';

export type ThemeChangeReason =
  | 'create'
  | 'update'
  | 'delete'
  | 'activate'
  | 'preferences'
  | 'import'
  | 'reset';

export interface ThemeChangeEvent {
  type: 'theme.updated';
  revision: number;
  reason: ThemeChangeReason;
  activeThemeId: string;
  changedThemeId?: string;
  preferences: ThemePreferences;
  themes: CustomTheme[];
  timestamp: string;
}

export interface SaveThemeInput {
  id?: string;
  name: string;
  description?: string;
  mode: CustomThemeMode;
  source?: Exclude<CustomThemeSource, 'builtin'>;
  vscodeMeta?: VsCodeThemeMeta;
  tokens: Partial<Record<CustomThemeTokenKey, string>>;
  apply?: boolean;
}

export interface PatchThemeInput {
  name?: string;
  description?: string;
  mode?: CustomThemeMode;
  tokens?: Partial<Record<CustomThemeTokenKey, string>>;
  apply?: boolean;
}

export interface ActivateThemeInput {
  themeId?: string;
  modePreference?: ThemePreferenceMode;
  preserveModePreference?: boolean;
  reset?: boolean;
}

export interface GenerateThemeInput {
  prompt: string;
  mode?: 'auto' | CustomThemeMode;
  save?: boolean;
  apply?: boolean;
  timeoutMs?: number;
}

export interface GenerateThemeResult {
  theme: CustomTheme;
  adjustments: ThemeContrastAdjustment[];
  report: ThemeContrastReport;
  saved: boolean;
  applied: boolean;
  model: string;
  state: ThemesStateSnapshot;
}

export interface ImportVsCodeInput {
  source?: string;
  fileBase64?: string;
  fileBuffer?: Buffer;
  fileName?: string;
  jsonText?: string;
  variant?: string;
  all?: boolean;
  previewOnly?: boolean;
  apply?: boolean;
}

export interface ImportVsCodeResult {
  sourceLabel: string;
  extensionId?: string;
  extensionName?: string;
  publisher?: string;
  version?: string;
  marketplaceUrl?: string;
  variants: ParsedVsCodeThemeVariant[];
  imported: CustomTheme[];
  appliedTheme?: CustomTheme;
  state: ThemesStateSnapshot;
}

export interface ThemeServiceOptions {
  config: ConfigRepository;
  llm?: LlmEndpointService;
  fetcher?: typeof globalThis.fetch;
}

const AI_THEME_SYSTEM_PROMPT = [
  '你是顶级界面配色设计师（Linear / Arc / Raycast / Catppuccin 水准），负责为 AgentDock AI 开发工作台生成克制、高级、久看不累的语义化配色主题。',
  '',
  '【输出协议（严格遵守）】',
  '1. 只输出一个纯 JSON 对象，不要任何解释、Markdown 围栏或前后缀文字。',
  '2. JSON 字段结构：',
  '{',
  '  "name": "简短优雅的中文或英文主题名（<=20字）",',
  '  "description": "一句凝练的视觉氛围描述（<=60字）",',
  '  "mode": "light" 或 "dark",',
  '  "tokens": {',
  '    "bgCanvas": "#rrggbb",        // 主对话画布底色',
  '    "bgSidebar": "#rrggbb",       // 左侧栏底色（与画布保持微妙层次差）',
  '    "bgSurface": "#rrggbb",       // 卡片/输入框/弹窗表面底色',
  '    "bgSurfaceHover": "#rrggbb",  // 悬停/次级控件底色',
  '    "bgElevated": "#rrggbb",      // 浮层/下拉菜单底色',
  '    "bgBubbleUser": "#rrggbb",    // 用户消息气泡底色（柔和克制）',
  '    "bgCode": "#rrggbb",          // 代码块底色（略深于画布）',
  '    "textPrimary": "#rrggbb",     // 主正文（对比度 >= 7:1）',
  '    "textSecondary": "#rrggbb",   // 次正文（对比度 >= 4.5:1）',
  '    "textMuted": "#rrggbb",       // 弱文字/占位符（对比度 >= 3.2:1）',
  '    "textInverse": "#rrggbb",     // 反色文字',
  '    "borderSubtle": "#rrggbb",    // 细腻分割线',
  '    "borderStrong": "#rrggbb",    // 清晰控件边框',
  '    "accent": "#rrggbb",          // 标志性交互强调色（按钮/链接/聚焦环）',
  '    "accentSoft": "#rrggbb",      // 强调色柔和浅底',
  '    "accentForeground": "#rrggbb",// 强调色按钮上的文字（对比度 >= 4.5:1）',
  '    "success": "#rrggbb",         // 成功绿',
  '    "warning": "#rrggbb",         // 警告琥珀',
  '    "danger": "#rrggbb",          // 危险红',
  '    "info": "#rrggbb"             // 信息蓝',
  '  }',
  '}',
  '',
  '【美学红线】',
  '- 严禁刺眼高饱和荧光底色；画布、侧栏、卡片保持低饱和协调色温与细腻明暗台阶。',
  '- 所有颜色必须为 6 位 #rrggbb 十六进制格式，保证极高可读性与层次感。'
].join('\n');

function extractJsonObject(raw: string): Record<string, unknown> {
  const trimmed = raw.trim();
  const fenced = /```(?:jsonc?|javascript)?\s*([\s\S]*?)```/i.exec(trimmed);
  const candidate = fenced?.[1]?.trim() ?? trimmed;
  const firstBrace = candidate.indexOf('{');
  const lastBrace = candidate.lastIndexOf('}');
  const slice = firstBrace >= 0 && lastBrace > firstBrace ? candidate.slice(firstBrace, lastBrace + 1) : candidate;
  const parsed = parseJsonc<unknown>(slice, 'AI 主题 JSON');
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new RuntimeError('AI_THEME_INVALID_OUTPUT', '模型未返回有效的主题 JSON 对象，请重试或换一个描述', 502);
  }
  return parsed as Record<string, unknown>;
}

function normalizePreferences(prefs: Partial<ThemePreferences> | undefined, allThemes: readonly CustomTheme[]): ThemePreferences {
  const parsed = themePreferencesSchema.safeParse(prefs ?? {});
  const base: ThemePreferences = parsed.success ? parsed.data : { ...DEFAULT_THEME_PREFERENCES };
  const byId = new Map(allThemes.map(theme => [theme.id, theme]));

  const validLight = byId.get(base.activeLightThemeId)?.mode === 'light'
    ? base.activeLightThemeId
    : BUILTIN_LIGHT_THEME_ID;
  const validDark = byId.get(base.activeDarkThemeId)?.mode === 'dark'
    ? base.activeDarkThemeId
    : BUILTIN_DARK_THEME_ID;
  const validActive = byId.has(base.activeThemeId)
    ? base.activeThemeId
    : (base.modePreference === 'dark' ? validDark : validLight);

  return {
    modePreference: base.modePreference,
    activeThemeId: validActive,
    activeLightThemeId: validLight,
    activeDarkThemeId: validDark
  };
}

function sanitizeTokenMap(raw: unknown): Partial<Record<CustomThemeTokenKey, string>> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new RuntimeError('INVALID_THEME_TOKENS', 'tokens 必须是颜色键值对对象', 400);
  }
  const input = raw as Record<string, unknown>;
  const result: Partial<Record<CustomThemeTokenKey, string>> = {};
  for (const key of customThemeTokenKeys) {
    const val = input[key];
    if (typeof val === 'string' && val.trim()) {
      result[key] = val.trim();
    }
  }
  return result;
}

export class ThemeService {
  private readonly emitter = new EventEmitter();
  private revision = 1;
  private updatedAt = now();

  constructor(private readonly options: ThemeServiceOptions) {
    this.emitter.setMaxListeners(100);
  }

  subscribe(listener: (event: ThemeChangeEvent) => void): () => void {
    this.emitter.on('theme.updated', listener);
    return () => this.emitter.off('theme.updated', listener);
  }

  close(): void {
    this.emitter.removeAllListeners();
  }

  private async readCustomThemes(): Promise<CustomTheme[]> {
    const raw = await this.options.config.get(customThemesConfigKey);
    if (!raw) return [];
    try {
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) return [];
      const valid: CustomTheme[] = [];
      for (const item of parsed) {
        const res = customThemeSchema.safeParse(item);
        if (res.success && !isBuiltinThemeId(res.data.id)) {
          valid.push(res.data);
        }
      }
      return valid;
    } catch {
      return [];
    }
  }

  private async writeCustomThemes(customThemes: CustomTheme[]): Promise<void> {
    await this.options.config.set(customThemesConfigKey, JSON.stringify(customThemes));
  }

  private async readPreferences(allThemes: readonly CustomTheme[]): Promise<ThemePreferences> {
    const raw = await this.options.config.get(themePreferencesConfigKey);
    if (!raw) return normalizePreferences(undefined, allThemes);
    try {
      return normalizePreferences(JSON.parse(raw) as Partial<ThemePreferences>, allThemes);
    } catch {
      return normalizePreferences(undefined, allThemes);
    }
  }

  private async writePreferences(preferences: ThemePreferences): Promise<void> {
    await this.options.config.set(themePreferencesConfigKey, JSON.stringify(preferences));
  }

  private buildSnapshot(customThemes: CustomTheme[], preferences: ThemePreferences): ThemesStateSnapshot {
    const themes = [...BUILTIN_THEMES, ...customThemes];
    return {
      themes,
      preferences: normalizePreferences(preferences, themes),
      revision: this.revision,
      updatedAt: this.updatedAt
    };
  }

  private broadcast(reason: ThemeChangeReason, snapshot: ThemesStateSnapshot, changedThemeId?: string): void {
    this.revision += 1;
    this.updatedAt = now();
    const updatedSnapshot: ThemesStateSnapshot = {
      ...snapshot,
      revision: this.revision,
      updatedAt: this.updatedAt
    };
    const event: ThemeChangeEvent = {
      type: 'theme.updated',
      revision: updatedSnapshot.revision,
      reason,
      activeThemeId: updatedSnapshot.preferences.activeThemeId,
      ...(changedThemeId ? { changedThemeId } : {}),
      preferences: updatedSnapshot.preferences,
      themes: updatedSnapshot.themes,
      timestamp: updatedSnapshot.updatedAt
    };
    this.emitter.emit('theme.updated', event);
  }

  async getState(): Promise<ThemesStateSnapshot> {
    const customThemes = await this.readCustomThemes();
    const allThemes = [...BUILTIN_THEMES, ...customThemes];
    const preferences = await this.readPreferences(allThemes);
    return this.buildSnapshot(customThemes, preferences);
  }

  async findTheme(idOrName: string): Promise<CustomTheme | undefined> {
    const query = idOrName.trim();
    if (!query) return undefined;
    const state = await this.getState();
    const exactId = state.themes.find(theme => theme.id === query);
    if (exactId) return exactId;
    const lower = query.toLowerCase();
    return state.themes.find(theme => theme.name.toLowerCase() === lower)
      ?? state.themes.find(theme => theme.id.toLowerCase() === lower);
  }

  async upsertTheme(input: SaveThemeInput, options: { reason?: ThemeChangeReason } = {}): Promise<{
    theme: CustomTheme;
    adjustments: ThemeContrastAdjustment[];
    report: ThemeContrastReport;
    state: ThemesStateSnapshot;
  }> {
    const name = typeof input?.name === 'string' ? input.name.trim() : '';
    if (!name) throw new RuntimeError('INVALID_THEME_NAME', '主题名称不能为空', 400);
    if (name.length > 80) throw new RuntimeError('INVALID_THEME_NAME', '主题名称不能超过 80 个字符', 400);
    if (!customThemeModes.includes(input?.mode)) {
      throw new RuntimeError('INVALID_THEME_MODE', 'mode 必须是 light 或 dark', 400);
    }

    const rawSource = input.source as string | undefined;
    const source: Exclude<CustomThemeSource, 'builtin'> =
      rawSource === 'ai' || rawSource === 'vscode' || rawSource === 'custom'
        ? rawSource
        : 'custom';
    const rawTokens = sanitizeTokenMap(input.tokens);
    const ensured = ensureReadableThemeTokens(rawTokens, input.mode);

    const customThemes = await this.readCustomThemes();
    const timestamp = now();
    const requestedId = input.id?.trim();
    if (requestedId && isBuiltinThemeId(requestedId)) {
      throw new RuntimeError('CANNOT_MODIFY_BUILTIN_THEME', '内置预设主题不可直接覆盖，请另存为新主题', 400);
    }

    const existingIndex = requestedId ? customThemes.findIndex(item => item.id === requestedId) : -1;
    const id = existingIndex >= 0
      ? customThemes[existingIndex]!.id
      : (requestedId || slugifyThemeId(name, source === 'vscode' ? 'vscode' : source === 'ai' ? 'ai' : 'theme'));

    const theme: CustomTheme = {
      id,
      name,
      ...(input.description?.trim() ? { description: input.description.trim().slice(0, 300) } : {}),
      mode: input.mode,
      source,
      ...(input.vscodeMeta ? { vscodeMeta: input.vscodeMeta } : {}),
      tokens: ensured.tokens,
      createdAt: existingIndex >= 0 ? customThemes[existingIndex]!.createdAt ?? timestamp : timestamp,
      updatedAt: timestamp
    };

    if (existingIndex >= 0) {
      customThemes[existingIndex] = theme;
    } else {
      customThemes.unshift(theme);
    }
    await this.writeCustomThemes(customThemes);

    const allThemes = [...BUILTIN_THEMES, ...customThemes];
    let preferences = await this.readPreferences(allThemes);
    if (input.apply) {
      preferences = {
        ...preferences,
        modePreference: theme.mode,
        activeThemeId: theme.id,
        ...(theme.mode === 'light' ? { activeLightThemeId: theme.id } : { activeDarkThemeId: theme.id })
      };
      await this.writePreferences(preferences);
    }

    const snapshot = this.buildSnapshot(customThemes, preferences);
    this.broadcast(options.reason ?? (existingIndex >= 0 ? 'update' : 'create'), snapshot, theme.id);
    return {
      theme,
      adjustments: ensured.adjustments,
      report: ensured.report,
      state: { ...snapshot, revision: this.revision, updatedAt: this.updatedAt }
    };
  }

  async patchTheme(id: string, patch: PatchThemeInput): Promise<{
    theme: CustomTheme;
    adjustments: ThemeContrastAdjustment[];
    report: ThemeContrastReport;
    state: ThemesStateSnapshot;
  }> {
    const trimmedId = id.trim();
    if (!trimmedId) throw new RuntimeError('THEME_NOT_FOUND', '主题 ID 不能为空', 400);
    if (isBuiltinThemeId(trimmedId)) {
      throw new RuntimeError('CANNOT_MODIFY_BUILTIN_THEME', '内置预设主题不可修改，请基于它另存为自定义主题', 400);
    }
    const customThemes = await this.readCustomThemes();
    const index = customThemes.findIndex(item => item.id === trimmedId);
    if (index < 0) {
      throw new RuntimeError('THEME_NOT_FOUND', `未找到自定义主题：${trimmedId}`, 404);
    }
    const existing = customThemes[index]!;
    const mode = patch.mode ?? existing.mode;
    if (!customThemeModes.includes(mode)) {
      throw new RuntimeError('INVALID_THEME_MODE', 'mode 必须是 light 或 dark', 400);
    }
    const name = patch.name !== undefined ? patch.name.trim() : existing.name;
    if (!name) throw new RuntimeError('INVALID_THEME_NAME', '主题名称不能为空', 400);

    const mergedRawTokens = {
      ...existing.tokens,
      ...(patch.tokens ? sanitizeTokenMap(patch.tokens) : {})
    };
    const ensured = ensureReadableThemeTokens(mergedRawTokens, mode);

    const updated: CustomTheme = {
      ...existing,
      name: name.slice(0, 80),
      ...(patch.description !== undefined
        ? (patch.description.trim() ? { description: patch.description.trim().slice(0, 300) } : { description: undefined })
        : {}),
      mode,
      tokens: ensured.tokens,
      updatedAt: now()
    };
    if (updated.description === undefined) delete updated.description;

    customThemes[index] = updated;
    await this.writeCustomThemes(customThemes);

    const allThemes = [...BUILTIN_THEMES, ...customThemes];
    let preferences = await this.readPreferences(allThemes);
    if (patch.apply) {
      preferences = {
        ...preferences,
        modePreference: updated.mode,
        activeThemeId: updated.id,
        ...(updated.mode === 'light' ? { activeLightThemeId: updated.id } : { activeDarkThemeId: updated.id })
      };
      await this.writePreferences(preferences);
    } else if (preferences.activeThemeId === updated.id && updated.mode !== existing.mode) {
      preferences = {
        ...preferences,
        modePreference: updated.mode,
        ...(updated.mode === 'light' ? { activeLightThemeId: updated.id } : { activeDarkThemeId: updated.id })
      };
      await this.writePreferences(preferences);
    }

    const snapshot = this.buildSnapshot(customThemes, preferences);
    this.broadcast('update', snapshot, updated.id);
    return {
      theme: updated,
      adjustments: ensured.adjustments,
      report: ensured.report,
      state: { ...snapshot, revision: this.revision, updatedAt: this.updatedAt }
    };
  }

  async deleteTheme(id: string): Promise<{ deleted: true; id: string; state: ThemesStateSnapshot }> {
    const trimmedId = id.trim();
    if (!trimmedId) throw new RuntimeError('THEME_NOT_FOUND', '主题 ID 不能为空', 400);
    if (isBuiltinThemeId(trimmedId)) {
      throw new RuntimeError('CANNOT_DELETE_BUILTIN_THEME', '内置精选主题不可删除', 400);
    }
    const customThemes = await this.readCustomThemes();
    const index = customThemes.findIndex(item => item.id === trimmedId);
    if (index < 0) {
      throw new RuntimeError('THEME_NOT_FOUND', `未找到自定义主题：${trimmedId}`, 404);
    }
    const [removed] = customThemes.splice(index, 1);
    await this.writeCustomThemes(customThemes);

    const allThemes = [...BUILTIN_THEMES, ...customThemes];
    let preferences = await this.readPreferences(allThemes);
    let prefsChanged = false;
    if (preferences.activeLightThemeId === trimmedId) {
      preferences.activeLightThemeId = BUILTIN_LIGHT_THEME_ID;
      prefsChanged = true;
    }
    if (preferences.activeDarkThemeId === trimmedId) {
      preferences.activeDarkThemeId = BUILTIN_DARK_THEME_ID;
      prefsChanged = true;
    }
    if (preferences.activeThemeId === trimmedId) {
      preferences.activeThemeId = removed?.mode === 'dark' ? preferences.activeDarkThemeId : preferences.activeLightThemeId;
      prefsChanged = true;
    }
    if (prefsChanged) {
      await this.writePreferences(preferences);
    }

    const snapshot = this.buildSnapshot(customThemes, preferences);
    this.broadcast('delete', snapshot, trimmedId);
    return {
      deleted: true,
      id: trimmedId,
      state: { ...snapshot, revision: this.revision, updatedAt: this.updatedAt }
    };
  }

  async activate(input: ActivateThemeInput): Promise<ThemesStateSnapshot> {
    const customThemes = await this.readCustomThemes();
    const allThemes = [...BUILTIN_THEMES, ...customThemes];
    let preferences = await this.readPreferences(allThemes);

    if (input.reset) {
      preferences = { ...DEFAULT_THEME_PREFERENCES };
      await this.writePreferences(preferences);
      const snapshot = this.buildSnapshot(customThemes, preferences);
      this.broadcast('reset', snapshot, preferences.activeThemeId);
      return { ...snapshot, revision: this.revision, updatedAt: this.updatedAt };
    }

    let changedThemeId: string | undefined;
    let reason: ThemeChangeReason = 'activate';

    if (input.themeId?.trim()) {
      const query = input.themeId.trim();
      const lower = query.toLowerCase();
      const target = allThemes.find(theme => theme.id === query)
        ?? allThemes.find(theme => theme.name.toLowerCase() === lower)
        ?? allThemes.find(theme => theme.id.toLowerCase() === lower);
      if (!target) {
        throw new RuntimeError('THEME_NOT_FOUND', `未找到主题：${query}`, 404);
      }
      preferences = {
        ...preferences,
        activeThemeId: target.id,
        ...(target.mode === 'light' ? { activeLightThemeId: target.id } : { activeDarkThemeId: target.id }),
        ...(input.preserveModePreference ? {} : { modePreference: target.mode })
      };
      changedThemeId = target.id;
    }

    if (input.modePreference !== undefined) {
      if (!(themePreferenceModes as readonly string[]).includes(input.modePreference)) {
        throw new RuntimeError('INVALID_MODE_PREFERENCE', 'modePreference 必须是 system、light 或 dark', 400);
      }
      const nextActive = input.themeId?.trim()
        ? preferences.activeThemeId
        : input.modePreference === 'light'
          ? preferences.activeLightThemeId
          : input.modePreference === 'dark'
            ? preferences.activeDarkThemeId
            : preferences.activeThemeId;
      preferences = {
        ...preferences,
        modePreference: input.modePreference,
        activeThemeId: nextActive
      };
      if (!changedThemeId) {
        reason = 'preferences';
        changedThemeId = nextActive;
      }
    }

    if (!input.themeId?.trim() && input.modePreference === undefined) {
      throw new RuntimeError('INVALID_THEME_ACTIVATION', '请提供 themeId、modePreference 或 reset', 400);
    }

    await this.writePreferences(preferences);
    const snapshot = this.buildSnapshot(customThemes, preferences);
    this.broadcast(reason, snapshot, changedThemeId);
    return { ...snapshot, revision: this.revision, updatedAt: this.updatedAt };
  }

  async generateTheme(input: GenerateThemeInput): Promise<GenerateThemeResult> {
    if (!this.options.llm) {
      throw new RuntimeError('LLM_NOT_CONFIGURED', '当前服务未启用模型端点，无法使用 AI 生成主题', 409);
    }
    const prompt = typeof input?.prompt === 'string' ? input.prompt.trim() : '';
    if (!prompt) {
      throw new RuntimeError('INVALID_THEME_PROMPT', '请描述你想要的配色氛围、风格或参考主题', 400);
    }
    if (prompt.length > 2_000) {
      throw new RuntimeError('INVALID_THEME_PROMPT', '主题描述不能超过 2000 个字符', 400);
    }

    const requestedMode = input.mode === 'light' || input.mode === 'dark' ? input.mode : 'auto';
    const userPrompt = [
      `用户配色诉求：${prompt}`,
      requestedMode === 'auto'
        ? '极性要求：请根据用户诉求的氛围自行判断最适合使用 "light" 还是 "dark"。'
        : `极性要求：必须生成 "${requestedMode}" 模式主题（mode 字段严格为 "${requestedMode}"）。`,
      '请直接输出符合协议的完整 JSON 对象。'
    ].join('\n');

    const llmResult = await this.options.llm.run({
      systemPrompt: AI_THEME_SYSTEM_PROMPT,
      prompt: userPrompt,
      temperature: 0.72,
      maxTokens: 1_200,
      timeoutMs: Math.min(Math.max(input.timeoutMs ?? 60_000, 5_000), 120_000)
    });

    const parsed = extractJsonObject(llmResult.text);
    const mode: CustomThemeMode = requestedMode !== 'auto'
      ? requestedMode
      : (parsed.mode === 'light' || parsed.mode === 'dark' ? parsed.mode : 'dark');
    const rawTokens = sanitizeTokenMap(parsed.tokens ?? parsed);
    const ensured = ensureReadableThemeTokens(rawTokens, mode);

    const rawName = typeof parsed.name === 'string' ? parsed.name.trim() : '';
    const name = (rawName || `AI 主题 · ${prompt.slice(0, 12)}`).slice(0, 80);
    const description = (typeof parsed.description === 'string' && parsed.description.trim()
      ? parsed.description.trim()
      : `AI 根据「${prompt.slice(0, 48)}」定制的${mode === 'dark' ? '深色' : '浅色'}配色`).slice(0, 300);

    const shouldApply = Boolean(input.apply);
    const shouldSave = shouldApply || Boolean(input.save);

    if (shouldSave) {
      const saved = await this.upsertTheme({
        name,
        description,
        mode,
        source: 'ai',
        tokens: ensured.tokens,
        apply: shouldApply
      });
      return {
        theme: saved.theme,
        adjustments: ensured.adjustments,
        report: saved.report,
        saved: true,
        applied: shouldApply,
        model: llmResult.model,
        state: saved.state
      };
    }

    const previewTheme: CustomTheme = {
      id: slugifyThemeId(name, 'ai'),
      name,
      description,
      mode,
      source: 'ai',
      tokens: ensured.tokens,
      createdAt: now(),
      updatedAt: now()
    };

    return {
      theme: previewTheme,
      adjustments: ensured.adjustments,
      report: ensured.report,
      saved: false,
      applied: false,
      model: llmResult.model,
      state: await this.getState()
    };
  }

  async importVsCode(input: ImportVsCodeInput): Promise<ImportVsCodeResult> {
    const bundle = await parseVsCodeThemeSource({
      source: input.source,
      fileBase64: input.fileBase64,
      fileBuffer: input.fileBuffer,
      fileName: input.fileName,
      jsonText: input.jsonText,
      fetcher: this.options.fetcher
    });

    if (input.previewOnly) {
      return {
        sourceLabel: bundle.sourceLabel,
        ...(bundle.extensionId ? { extensionId: bundle.extensionId } : {}),
        ...(bundle.extensionName ? { extensionName: bundle.extensionName } : {}),
        ...(bundle.publisher ? { publisher: bundle.publisher } : {}),
        ...(bundle.version ? { version: bundle.version } : {}),
        ...(bundle.marketplaceUrl ? { marketplaceUrl: bundle.marketplaceUrl } : {}),
        variants: bundle.variants,
        imported: [],
        state: await this.getState()
      };
    }

    // 选择待导入变体：--all 导入全部；--variant 精确/模糊/序号匹配；默认导入第一个变体
    let selectedVariants: ParsedVsCodeThemeVariant[];
    if (input.all) {
      selectedVariants = bundle.variants;
    } else if (input.variant?.trim()) {
      const q = input.variant.trim();
      const lower = q.toLowerCase();
      const byIndex = /^\d+$/.test(q) ? bundle.variants[Number(q) - 1] : undefined;
      const matched = bundle.variants.find(item => item.label.toLowerCase() === lower)
        ?? bundle.variants.find(item => item.label.toLowerCase().includes(lower))
        ?? byIndex;
      if (!matched) {
        const names = bundle.variants.map((item, idx) => `${idx + 1}. ${item.label}`).join(' / ');
        throw new RuntimeError('VSCODE_VARIANT_NOT_FOUND', `未找到变体「${q}」，可选变体：${names}`, 404);
      }
      selectedVariants = [matched];
    } else {
      selectedVariants = [bundle.variants[0]!];
    }

    const customThemes = await this.readCustomThemes();
    const timestamp = now();
    const imported: CustomTheme[] = [];

    for (const variant of selectedVariants) {
      // 同扩展同变体名重复导入时原地更新，避免刷出重复卡片
      const existingIndex = customThemes.findIndex(item => (
        item.source === 'vscode'
        && (
          (bundle.extensionId && item.vscodeMeta?.extensionId === bundle.extensionId && item.vscodeMeta?.variantLabel === variant.label)
          || (!bundle.extensionId && item.name.toLowerCase() === variant.theme.name.toLowerCase())
        )
      ));
      const stored: CustomTheme = {
        ...variant.theme,
        id: existingIndex >= 0 ? customThemes[existingIndex]!.id : variant.theme.id,
        createdAt: existingIndex >= 0 ? customThemes[existingIndex]!.createdAt ?? timestamp : timestamp,
        updatedAt: timestamp
      };
      if (existingIndex >= 0) customThemes[existingIndex] = stored;
      else customThemes.unshift(stored);
      imported.push(stored);
    }

    await this.writeCustomThemes(customThemes);

    const allThemes = [...BUILTIN_THEMES, ...customThemes];
    let preferences = await this.readPreferences(allThemes);
    let appliedTheme: CustomTheme | undefined;

    if (input.apply && imported.length > 0) {
      // 若 --all 与 --variant 同时传入，激活 variant 对应项；否则激活第一项
      const primary = input.variant?.trim()
        ? imported.find(item => item.name.toLowerCase() === input.variant!.trim().toLowerCase()) ?? imported[0]!
        : imported[0]!;
      appliedTheme = primary;
      preferences = {
        ...preferences,
        modePreference: primary.mode,
        activeThemeId: primary.id,
        ...(primary.mode === 'light' ? { activeLightThemeId: primary.id } : { activeDarkThemeId: primary.id })
      };
      await this.writePreferences(preferences);
    }

    const snapshot = this.buildSnapshot(customThemes, preferences);
    this.broadcast('import', snapshot, appliedTheme?.id ?? imported[0]?.id);

    return {
      sourceLabel: bundle.sourceLabel,
      ...(bundle.extensionId ? { extensionId: bundle.extensionId } : {}),
      ...(bundle.extensionName ? { extensionName: bundle.extensionName } : {}),
      ...(bundle.publisher ? { publisher: bundle.publisher } : {}),
      ...(bundle.version ? { version: bundle.version } : {}),
      ...(bundle.marketplaceUrl ? { marketplaceUrl: bundle.marketplaceUrl } : {}),
      variants: bundle.variants,
      imported,
      ...(appliedTheme ? { appliedTheme } : {}),
      state: { ...snapshot, revision: this.revision, updatedAt: this.updatedAt }
    };
  }
}
