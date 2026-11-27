import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type {
  CustomTheme,
  CustomThemeMode,
  CustomThemeSource,
  ThemeContrastAdjustment,
  ThemeContrastReport,
  ThemePreferenceMode,
  ThemesStateSnapshot
} from '@agent-dock/agent-dock-shared';
import { callDaemon, requireDaemon } from '../session-cli.js';
import { parseJsonc, parseMarketplaceReference } from './vscode-importer.js';
import type { ImportVsCodeResult } from './service.js';

export interface ThemeCommonCliOptions {
  json?: boolean;
  daemonDir?: string;
}

export interface ThemeCreateCliOptions extends ThemeCommonCliOptions {
  id?: string;
  name?: string;
  mode?: string;
  tokens?: string;
  fromFile?: string;
  description?: string;
  source?: string;
  apply?: boolean;
}

export interface ThemeImportVsCodeCliOptions extends ThemeCommonCliOptions {
  variant?: string;
  all?: boolean;
  apply?: boolean;
}

export interface ThemeApplyCliOptions extends ThemeCommonCliOptions {
  mode?: string;
}

export interface ThemeExportCliOptions extends ThemeCommonCliOptions {
  output?: string;
}

const sourceLabelMap: Record<CustomThemeSource, string> = {
  builtin: '内置',
  custom: '自定义',
  ai: 'AI 生成',
  vscode: 'VS Code'
};

function formatThemeLine(theme: CustomTheme, activeId: string): string {
  const marker = theme.id === activeId ? '●' : '○';
  const modeTag = theme.mode === 'dark' ? 'dark ' : 'light';
  const sourceTag = sourceLabelMap[theme.source] ?? theme.source;
  return `${marker} ${theme.id}  [${modeTag} | ${sourceTag}]  ${theme.name}  accent=${theme.tokens.accent}`;
}

export async function runThemeList(options: ThemeCommonCliOptions = {}): Promise<string> {
  const state = await callDaemon<ThemesStateSnapshot>(requireDaemon(options.daemonDir), '/api/themes', 'GET');
  if (options.json) return `${JSON.stringify({ ok: true, ...state }, null, 2)}\n`;
  const pref = state.preferences;
  const lines = [
    `当前主题偏好：${pref.modePreference}（active=${pref.activeThemeId} · light=${pref.activeLightThemeId} · dark=${pref.activeDarkThemeId}）`,
    ...state.themes.map(theme => formatThemeLine(theme, pref.activeThemeId))
  ];
  return `${lines.join('\n')}\n`;
}

export async function runThemeCreate(options: ThemeCreateCliOptions = {}): Promise<string> {
  let filePayload: Record<string, unknown> | undefined;
  if (options.fromFile?.trim()) {
    const filePath = resolve(process.cwd(), options.fromFile.trim());
    const content = await readFile(filePath, 'utf8');
    const parsed = parseJsonc<unknown>(content, filePath);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error(`--from-file 内容必须是 JSON 对象：${filePath}`);
    }
    filePayload = parsed as Record<string, unknown>;
  }

  let inlineTokens: Record<string, unknown> | undefined;
  if (options.tokens?.trim()) {
    const parsed = parseJsonc<unknown>(options.tokens, '--tokens');
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('--tokens 必须是合法的 JSON 对象');
    }
    inlineTokens = parsed as Record<string, unknown>;
  }

  const fileTokens = filePayload && typeof filePayload.tokens === 'object' && filePayload.tokens && !Array.isArray(filePayload.tokens)
    ? (filePayload.tokens as Record<string, unknown>)
    : (filePayload && ('bgCanvas' in filePayload || 'accent' in filePayload || 'textPrimary' in filePayload) ? filePayload : undefined);

  const tokens = { ...(fileTokens ?? {}), ...(inlineTokens ?? {}) };
  if (Object.keys(tokens).length === 0) {
    throw new Error('请通过 --tokens <json> 或 --from-file <path> 提供至少一个主题颜色字段');
  }

  const name = options.name?.trim() || (typeof filePayload?.name === 'string' ? filePayload.name.trim() : '');
  if (!name) throw new Error('请通过 --name 指定主题名称（或在 --from-file JSON 中包含 name）');

  const rawMode = (options.mode?.trim() || (typeof filePayload?.mode === 'string' ? filePayload.mode.trim() : '')).toLowerCase();
  if (rawMode !== 'light' && rawMode !== 'dark') {
    throw new Error('--mode 必须是 light 或 dark');
  }
  const mode: CustomThemeMode = rawMode;

  const rawSource = (options.source?.trim() || (typeof filePayload?.source === 'string' ? filePayload.source.trim() : 'custom')).toLowerCase();
  const source: Exclude<CustomThemeSource, 'builtin'> = rawSource === 'ai' ? 'ai' : rawSource === 'vscode' ? 'vscode' : 'custom';

  const description = options.description?.trim()
    || (typeof filePayload?.description === 'string' ? filePayload.description.trim() : undefined);

  const result = await callDaemon<{
    theme: CustomTheme;
    adjustments: ThemeContrastAdjustment[];
    report: ThemeContrastReport;
    state: ThemesStateSnapshot;
  }>(requireDaemon(options.daemonDir), '/api/themes', 'POST', {
    ...(options.id?.trim() ? { id: options.id.trim() } : {}),
    name,
    mode,
    source,
    ...(description ? { description } : {}),
    tokens,
    apply: Boolean(options.apply)
  });

  if (options.json) return `${JSON.stringify({ ok: true, ...result }, null, 2)}\n`;
  const lines = [
    `已保存主题「${result.theme.name}」（${result.theme.id} · ${result.theme.mode} · WCAG ${result.report.grade}）${options.apply ? '，并已实时应用到所有客户端' : ''}。`
  ];
  if (result.adjustments.length > 0) {
    lines.push(`WCAG 对比度守护已自动校准 ${result.adjustments.length} 项色值：${result.adjustments.map(item => `${item.token}(${item.from}→${item.to})`).join('、')}`);
  }
  return `${lines.join('\n')}\n`;
}

export async function runThemeImportVsCode(sourceInput: string, options: ThemeImportVsCodeCliOptions = {}): Promise<string> {
  const raw = sourceInput?.trim();
  if (!raw) throw new Error('请提供 .vsix / .json / .jsonc 路径、扩展目录、Marketplace 链接或 publisher.extension 标识');

  // 若是本地存在的相对路径，先基于调用方当前工作目录转成绝对路径（daemon 的 cwd 可能与调用方不同）
  let resolvedSource = raw;
  if (!parseMarketplaceReference(raw) && !/^https?:\/\//i.test(raw) && !raw.startsWith('{') && !raw.startsWith('~')) {
    const candidate = resolve(process.cwd(), raw);
    if (existsSync(candidate)) resolvedSource = candidate;
  }

  const result = await callDaemon<ImportVsCodeResult>(
    requireDaemon(options.daemonDir),
    '/api/themes/import-vscode',
    'POST',
    {
      source: resolvedSource,
      ...(options.variant?.trim() ? { variant: options.variant.trim() } : {}),
      ...(options.all ? { all: true } : {}),
      apply: Boolean(options.apply)
    },
    { timeoutMs: 30_000 }
  );

  if (options.json) return `${JSON.stringify({ ok: true, ...result }, null, 2)}\n`;
  const lines = [
    `已从「${result.sourceLabel}」导入 ${result.imported.length} 套主题（共检测到 ${result.variants.length} 个变体）：`,
    ...result.imported.map(theme => `  - ${theme.id}  [${theme.mode}]  ${theme.name}  accent=${theme.tokens.accent}`)
  ];
  if (result.appliedTheme) {
    lines.push(`已实时应用主题「${result.appliedTheme.name}」（${result.appliedTheme.id}）。`);
  }
  return `${lines.join('\n')}\n`;
}

export async function runThemeApply(idOrName?: string, options: ThemeApplyCliOptions = {}): Promise<string> {
  const rawMode = options.mode?.trim().toLowerCase();
  if (rawMode && rawMode !== 'system' && rawMode !== 'light' && rawMode !== 'dark') {
    throw new Error('--mode 必须是 system、light 或 dark');
  }
  const modePreference = rawMode as ThemePreferenceMode | undefined;
  if (!idOrName?.trim() && !modePreference) {
    throw new Error('请指定主题 ID / 名称，或传入 --mode system|light|dark');
  }

  const state = await callDaemon<ThemesStateSnapshot>(
    requireDaemon(options.daemonDir),
    '/api/themes/active',
    'POST',
    {
      ...(idOrName?.trim() ? { themeId: idOrName.trim() } : {}),
      ...(modePreference ? { modePreference } : {})
    }
  );
  if (options.json) return `${JSON.stringify({ ok: true, ...state }, null, 2)}\n`;
  const active = state.themes.find(item => item.id === state.preferences.activeThemeId);
  return `已切换主题：${active ? `「${active.name}」(${active.id})` : state.preferences.activeThemeId}（偏好=${state.preferences.modePreference}）。\n`;
}

export async function runThemeReset(options: ThemeCommonCliOptions = {}): Promise<string> {
  const state = await callDaemon<ThemesStateSnapshot>(
    requireDaemon(options.daemonDir),
    '/api/themes/active',
    'POST',
    { reset: true }
  );
  if (options.json) return `${JSON.stringify({ ok: true, ...state }, null, 2)}\n`;
  return '已恢复默认主题偏好（跟随系统 · 默认浅色 / 默认深色）。\n';
}

export async function runThemeDelete(id: string, options: ThemeCommonCliOptions = {}): Promise<string> {
  const trimmed = id?.trim();
  if (!trimmed) throw new Error('请指定要删除的主题 ID');
  const result = await callDaemon<{ deleted: true; id: string; state: ThemesStateSnapshot }>(
    requireDaemon(options.daemonDir),
    `/api/themes/${encodeURIComponent(trimmed)}`,
    'DELETE'
  );
  if (options.json) return `${JSON.stringify({ ok: true, ...result }, null, 2)}\n`;
  return `已删除自定义主题 ${result.id}。\n`;
}

export async function runThemeExport(idOrName: string, options: ThemeExportCliOptions = {}): Promise<string> {
  const query = idOrName?.trim();
  if (!query) throw new Error('请指定要导出的主题 ID 或名称');
  const state = await callDaemon<ThemesStateSnapshot>(requireDaemon(options.daemonDir), '/api/themes', 'GET');
  const lower = query.toLowerCase();
  const target = state.themes.find(item => item.id === query)
    ?? state.themes.find(item => item.name.toLowerCase() === lower)
    ?? state.themes.find(item => item.id.toLowerCase() === lower);
  if (!target) throw new Error(`未找到主题：${query}`);

  const serialized = `${JSON.stringify(target, null, 2)}\n`;
  if (options.output?.trim()) {
    const outPath = resolve(process.cwd(), options.output.trim());
    await writeFile(outPath, serialized, 'utf8');
    if (options.json) return `${JSON.stringify({ ok: true, id: target.id, output: outPath }, null, 2)}\n`;
    return `已导出主题「${target.name}」至 ${outPath}。\n`;
  }
  return serialized;
}
