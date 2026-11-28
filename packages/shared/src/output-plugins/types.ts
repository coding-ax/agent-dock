import { z } from 'zod';
import { DEFAULT_ASK_USER_QUESTION_CONFIG } from '../ask-user-question.js';

/** 首个内置纯 XML 交互插件（AskUserQuestion）的规范 ID。 */
export const BUILTIN_ASK_USER_QUESTION_PLUGIN_ID = 'builtin:ask-user-question';
/** 兼容短名别名，读写时自动归一化为 `builtin:ask-user-question`。 */
export const LEGACY_ASK_USER_QUESTION_PLUGIN_ALIAS = 'ask-user-question';

/** 内置纯 XML 交互插件 #2（ConfirmAction 操作确认卡）的规范 ID。 */
export const BUILTIN_CONFIRM_ACTION_PLUGIN_ID = 'builtin:confirm-action';
/** 兼容短名别名，读写时自动归一化为 `builtin:confirm-action`。 */
export const LEGACY_CONFIRM_ACTION_PLUGIN_ALIAS = 'confirm-action';

/** 持久化在 `configs` 表中的插件全局默认开关配置键。 */
export const OUTPUT_PLUGINS_CONFIG_KEY = 'output_plugins.config';

/** 声明式及新插件交互回传轮次的 task/event origin 前缀。 */
export const OUTPUT_PLUGIN_INTERACTION_ORIGIN_PREFIX = 'output-plugin:';

export const outputPluginSources = ['builtin', 'local', 'custom'] as const;
export type OutputPluginSource = (typeof outputPluginSources)[number];

export const outputPluginAccentTones = ['sky', 'emerald', 'amber', 'rose', 'violet', 'zinc'] as const;
export type OutputPluginAccentTone = (typeof outputPluginAccentTones)[number];

export const outputPluginIconNames = [
  'message-circle-question',
  'shield-check',
  'check-square',
  'clipboard-list',
  'file-text',
  'sparkles',
  'bell',
  'terminal',
  'git-diff',
  'download',
  'bar-chart',
  'puzzle'
] as const;
export type OutputPluginIconName = (typeof outputPluginIconNames)[number] | (string & {});

export const outputPluginInteractionSources = ['web', 'lark', 'assistant'] as const;
export type OutputPluginInteractionSource = (typeof outputPluginInteractionSources)[number];

/** 主会话小猫向侧边会话发送自然语言回复/指示/返工轮次的 task/event origin。 */
export const ASSISTANT_REPLY_ORIGIN = 'assistant_reply';
/** 主会话小猫向侧边会话代答/拍板轮次的兼容 origin 别名。 */
export const ASSISTANT_ANSWER_ORIGIN = 'assistant_answer';

export interface AssistantReplyOriginMeta {
  kind: 'reply' | 'answer';
  responderName?: string;
}

/**
 * 识别由主会话小猫发往侧边会话的续跑/回复轮次 origin：
 * - 精确匹配 `assistant_reply` / `assistant_answer`
 * - 兼容携带小猫名后缀的 `assistant_reply:<name>` / `assistant_answer:<name>`
 */
export function parseAssistantReplyOrigin(origin: string | null | undefined): AssistantReplyOriginMeta | null {
  if (!origin) return null;
  const trimmed = origin.trim();
  if (trimmed === ASSISTANT_REPLY_ORIGIN) return { kind: 'reply' };
  if (trimmed === ASSISTANT_ANSWER_ORIGIN) return { kind: 'answer' };
  if (trimmed.startsWith(`${ASSISTANT_REPLY_ORIGIN}:`)) {
    const responderName = trimmed.slice(ASSISTANT_REPLY_ORIGIN.length + 1).trim();
    return { kind: 'reply', ...(responderName ? { responderName } : {}) };
  }
  if (trimmed.startsWith(`${ASSISTANT_ANSWER_ORIGIN}:`)) {
    const responderName = trimmed.slice(ASSISTANT_ANSWER_ORIGIN.length + 1).trim();
    return { kind: 'answer', ...(responderName ? { responderName } : {}) };
  }
  return null;
}

export function isAssistantReplyOrigin(origin: string | null | undefined): boolean {
  return parseAssistantReplyOrigin(origin) !== null;
}

/** 统一格式化输出插件交互来源标签（网页端 / 飞书 / 小猫代答）。 */
export function formatOutputPluginInteractionSourceLabel(
  source: OutputPluginInteractionSource,
  options: { actorName?: string; responderName?: string } = {}
): string {
  const actor = options.responderName?.trim() || options.actorName?.trim();
  if (source === 'assistant') {
    return actor ? `${actor}代答` : '小猫代答';
  }
  if (source === 'lark') {
    return actor ? `飞书 · ${actor}` : '飞书';
  }
  return actor ? `网页端 · ${actor}` : '网页端';
}

export const declarativePluginKinds = ['action-card', 'form-card', 'info-card'] as const;
export type DeclarativePluginKind = (typeof declarativePluginKinds)[number];

export const declarativeActionStyles = ['primary', 'default', 'danger'] as const;
export type DeclarativeActionStyle = (typeof declarativeActionStyles)[number];

export const declarativeFieldTypes = ['text', 'textarea', 'select'] as const;
export type DeclarativeFieldType = (typeof declarativeFieldTypes)[number];

export const declarativePluginActionPresetSchema = z.object({
  value: z.string().trim().min(1).max(120),
  label: z.string().trim().min(1).max(120),
  style: z.enum(declarativeActionStyles).default('default'),
  description: z.string().trim().max(300).optional()
});

export type DeclarativePluginActionPreset = z.infer<typeof declarativePluginActionPresetSchema>;

export const declarativePluginCardDefaultsSchema = z.object({
  accentTone: z.enum(outputPluginAccentTones).default('sky'),
  headerTitle: z.string().trim().max(120).optional(),
  submitLabel: z.string().trim().max(60).optional(),
  allowNote: z.boolean().default(false),
  notePlaceholder: z.string().trim().max(160).optional(),
  actions: z.array(declarativePluginActionPresetSchema).max(8).optional(),
  trailingHintMarkdown: z.string().trim().max(240).optional(),
  streamingPlaceholderText: z.string().trim().max(120).optional()
});

export type DeclarativePluginCardDefaults = z.infer<typeof declarativePluginCardDefaultsSchema>;

/** 允许插件自定义 XML 标签名的合法格式：必须以 `agentdock-` 开头，彻底杜绝与 HTML 标签冲突。 */
export const OUTPUT_PLUGIN_TAG_NAME_REGEX = /^agentdock-[a-z][a-z0-9-]{1,62}$/;
export const OUTPUT_PLUGIN_ID_REGEX = /^[a-z0-9][a-z0-9:._-]{1,95}$/;

export const declarativeOutputPluginManifestSchema = z.object({
  id: z.string().trim().regex(OUTPUT_PLUGIN_ID_REGEX, '插件 id 仅允许小写字母、数字及 : . _ -，长度 2~96'),
  name: z.string().trim().min(1).max(80),
  description: z.string().trim().min(1).max(400),
  icon: z.string().trim().min(1).max(60).default('puzzle'),
  tagName: z.string().trim().regex(OUTPUT_PLUGIN_TAG_NAME_REGEX, 'XML 标签名必须以 agentdock- 开头且仅含小写字母、数字和连字符'),
  version: z.string().trim().min(1).max(32).default('1.0.0'),
  defaultEnabled: z.boolean().default(false),
  kind: z.enum(declarativePluginKinds),
  promptInstruction: z.string().trim().min(1).max(4_000).optional(),
  disabledNotice: z.string().trim().min(1).max(600).optional(),
  protocolExample: z.string().trim().min(1).max(3_000).optional(),
  responseTemplate: z.string().trim().min(1).max(2_000).optional(),
  card: declarativePluginCardDefaultsSchema.optional()
});

export type DeclarativeOutputPluginManifest = z.infer<typeof declarativeOutputPluginManifestSchema>;

export interface OutputPluginCapabilities {
  web: boolean;
  lark: boolean;
  interactive: boolean;
  streamingPlaceholder: boolean;
}

/** 可序列化下发给前端/CLI 的插件元数据。 */
export interface OutputPluginMetadata {
  id: string;
  name: string;
  description: string;
  icon: OutputPluginIconName;
  tagName: string;
  defaultEnabled: boolean;
  version: string;
  builtin: boolean;
  source: OutputPluginSource;
  capabilities: OutputPluginCapabilities;
  protocolExample?: string;
  interactionOrigin?: string;
  declarative?: DeclarativeOutputPluginManifest;
  sourcePath?: string;
}

export interface OutputPluginParseResult<TSpec = unknown> {
  pluginId: string;
  tagName: string;
  proseText: string;
  spec: TSpec;
  rawXml: string;
  startIndex: number;
  endIndex: number;
}

export type OutputPluginStreamingSplit<TSpec = unknown> =
  | { kind: 'none'; proseText: string }
  | { kind: 'pending'; pluginId: string; tagName: string; proseText: string; partialTitle?: string }
  | { kind: 'complete'; pluginId: string; tagName: string; proseText: string; spec: TSpec; rawXml: string };

/**
 * 统一纯 XML 交互输出插件契约（零 MCP、零 Tool、全 Agent CLI 通用）：
 * - 共享层负责元数据、按需提示词、代码围栏免疫解析、交互序列化与搜索索引；
 * - Web 层按 pluginId 挂载交互卡片与回显渲染器（声明式插件自动享受内置通用渲染器）；
 * - 飞书层按 pluginId 挂载 Schema 2.0 卡片构造器与 `card.action.trigger` 处理器（声明式插件同样零代码自动适配）。
 */
export interface OutputPluginDefinition<TSpec = unknown, TInteraction = unknown> extends OutputPluginMetadata {
  /** 仅当当前会话启用该插件时按需拼装注入给 Agent；关闭不消耗任何 Token。 */
  promptInstruction: string | (() => string);
  /** 活跃会话中途关闭该插件时下发的一次性短提醒。 */
  disabledNotice?: string | (() => string);
  /** 严格提取回答末尾裸 XML 块（自动代码围栏免疫）。 */
  parseOutput(text: string | null | undefined, precomputedMasked?: string): OutputPluginParseResult<TSpec> | null;
  /** 流式/终态通用拆分器（支持未闭合流式占位）。 */
  splitStreaming(text: string | null | undefined, streaming: boolean, precomputedMasked?: string): OutputPluginStreamingSplit<TSpec>;
  /** 提取稳定卡片实例 ID（用于跨端幂等响应与卡片锁定同步）。 */
  getInstanceId(spec: TSpec): string;
  /** 提取展示标题（用于流式占位与卡片标题兜底）。 */
  getTitle?(spec: TSpec): string | undefined;
  /** 解析交互回传事件文本。 */
  parseInteraction?(raw: string | null | undefined): TInteraction | null;
  /** 提取交互载荷关联的卡片实例 ID。 */
  getInteractionInstanceId?(payload: TInteraction): string;
  /** 序列化交互回传载荷（落入用户时间线事件文本）。 */
  serializeInteraction?(payload: TInteraction): string;
  /** 将交互回传格式化为发给 Agent 的自然语言提示词。 */
  formatInteractionForAgent?(payload: TInteraction): string;
  /** 简短人类可读摘要（供飞书任务名/通知等展示）。 */
  summarizeInteraction?(payload: TInteraction): string;
  /** 供时间线 Cmd+F 提取可见卡片文本。 */
  extractSearchText?(spec: TSpec): string;
  /** 供时间线 Cmd+F 提取交互回显可见文本。 */
  extractInteractionSearchText?(payload: TInteraction): string;
}

/** 全局默认开关配置（落库 `output_plugins.config`）。 */
export const outputPluginsGlobalConfigSchema = z.object({
  plugins: z.record(z.string().min(1), z.boolean()).default({})
});

export interface OutputPluginsGlobalConfig {
  plugins: Record<string, boolean>;
}

/** 会话级插件开关覆写映射：boolean 表示显式覆写，null/缺省表示跟随全局默认。 */
export type SessionOutputPluginsMap = Record<string, boolean | null>;

export const sessionOutputPluginsPatchSchema = z.record(
  z.string().trim().min(1).max(120),
  z.boolean().nullable()
);

/** 归一化插件 ID（将内置插件短名别名统一到 `builtin:*` 规范 ID）。 */
export function normalizeOutputPluginId(id: string): string {
  const trimmed = id.trim();
  if (trimmed === LEGACY_ASK_USER_QUESTION_PLUGIN_ALIAS) {
    return BUILTIN_ASK_USER_QUESTION_PLUGIN_ID;
  }
  if (trimmed === LEGACY_CONFIRM_ACTION_PLUGIN_ALIAS) {
    return BUILTIN_CONFIRM_ACTION_PLUGIN_ID;
  }
  return trimmed;
}

export function resolvePluginPromptInstruction(plugin: Pick<OutputPluginDefinition, 'promptInstruction'>): string {
  return typeof plugin.promptInstruction === 'function'
    ? plugin.promptInstruction()
    : plugin.promptInstruction;
}

export function resolvePluginDisabledNotice(plugin: Pick<OutputPluginDefinition, 'disabledNotice' | 'name' | 'tagName'>): string {
  if (plugin.disabledNotice) {
    return typeof plugin.disabledNotice === 'function'
      ? plugin.disabledNotice()
      : plugin.disabledNotice;
  }
  return `[AgentDock] 交互插件「${plugin.name}」已关闭，请不要再输出 <${plugin.tagName}> XML 块。`;
}

export function defaultGlobalOutputPluginsConfig(): OutputPluginsGlobalConfig {
  return {
    plugins: {
      [BUILTIN_ASK_USER_QUESTION_PLUGIN_ID]: DEFAULT_ASK_USER_QUESTION_CONFIG.askUserQuestionXmlEnabled,
      [BUILTIN_CONFIRM_ACTION_PLUGIN_ID]: true
    }
  };
}

/**
 * 归一化全局插件开关配置，并兼容迁移历史 `ask_user_question.config`。
 */
export function normalizeGlobalOutputPluginsConfig(
  raw: unknown,
  legacyAskUserQuestionXmlEnabled?: boolean
): OutputPluginsGlobalConfig {
  const plugins: Record<string, boolean> = {};
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    const record = raw as Record<string, unknown>;
    const sourceMap = record.plugins && typeof record.plugins === 'object' && !Array.isArray(record.plugins)
      ? (record.plugins as Record<string, unknown>)
      : undefined;
    if (sourceMap) {
      for (const [key, value] of Object.entries(sourceMap)) {
        if (typeof value !== 'boolean') continue;
        const normalizedId = normalizeOutputPluginId(key);
        if (!normalizedId) continue;
        plugins[normalizedId] = value;
      }
    }
    if (
      typeof record.askUserQuestionXmlEnabled === 'boolean'
      && plugins[BUILTIN_ASK_USER_QUESTION_PLUGIN_ID] === undefined
    ) {
      plugins[BUILTIN_ASK_USER_QUESTION_PLUGIN_ID] = record.askUserQuestionXmlEnabled;
    }
  }
  if (
    typeof legacyAskUserQuestionXmlEnabled === 'boolean'
    && plugins[BUILTIN_ASK_USER_QUESTION_PLUGIN_ID] === undefined
  ) {
    plugins[BUILTIN_ASK_USER_QUESTION_PLUGIN_ID] = legacyAskUserQuestionXmlEnabled;
  }
  return { plugins };
}

/**
 * 归一化会话级插件覆写映射（剔除 null / 非法值，兼容合并旧 `askUserQuestionEnabled` 列）。
 */
export function normalizeSessionOutputPlugins(
  raw: unknown,
  legacyAskUserQuestionEnabled?: boolean | null
): Record<string, boolean> {
  const result: Record<string, boolean> = {};
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
      if (typeof value !== 'boolean') continue;
      const normalizedId = normalizeOutputPluginId(key);
      if (!normalizedId) continue;
      result[normalizedId] = value;
    }
  }
  if (
    typeof legacyAskUserQuestionEnabled === 'boolean'
    && result[BUILTIN_ASK_USER_QUESTION_PLUGIN_ID] === undefined
  ) {
    result[BUILTIN_ASK_USER_QUESTION_PLUGIN_ID] = legacyAskUserQuestionEnabled;
  }
  return result;
}

/**
 * 将部分会话级插件 patch 合并进现有映射：
 * - `boolean`：写入显式覆写；
 * - `null`：删除覆写（恢复跟随全局默认）。
 */
export function mergeSessionOutputPluginsPatch(
  current: SessionOutputPluginsMap | null | undefined,
  patch: SessionOutputPluginsMap,
  legacyAskUserQuestionEnabled?: boolean | null
): Record<string, boolean> {
  const next = normalizeSessionOutputPlugins(current, legacyAskUserQuestionEnabled);
  for (const [key, value] of Object.entries(patch)) {
    const normalizedId = normalizeOutputPluginId(key);
    if (!normalizedId) continue;
    if (value === null || value === undefined) {
      delete next[normalizedId];
    } else if (typeof value === 'boolean') {
      next[normalizedId] = value;
    }
  }
  return next;
}

/**
 * 统一解析某插件在当前会话是否生效：
 * 会话级覆写（含兼容列 askUserQuestionEnabled） > 全局默认配置 > 插件内置 defaultEnabled。
 */
export function resolveOutputPluginEnabled(
  pluginId: string,
  options: {
    defaultEnabled?: boolean;
    globalConfig?: OutputPluginsGlobalConfig | null;
    sessionOverrides?: SessionOutputPluginsMap | null;
    legacySessionAskEnabled?: boolean | null;
  } = {}
): boolean {
  const canonicalId = normalizeOutputPluginId(pluginId);
  const overrides = options.sessionOverrides;
  if (overrides) {
    const direct = overrides[canonicalId];
    if (typeof direct === 'boolean') return direct;
    if (canonicalId === BUILTIN_ASK_USER_QUESTION_PLUGIN_ID) {
      const alias = overrides[LEGACY_ASK_USER_QUESTION_PLUGIN_ALIAS];
      if (typeof alias === 'boolean') return alias;
    } else if (canonicalId === BUILTIN_CONFIRM_ACTION_PLUGIN_ID) {
      const alias = overrides[LEGACY_CONFIRM_ACTION_PLUGIN_ALIAS];
      if (typeof alias === 'boolean') return alias;
    }
  }
  if (canonicalId === BUILTIN_ASK_USER_QUESTION_PLUGIN_ID && typeof options.legacySessionAskEnabled === 'boolean') {
    return options.legacySessionAskEnabled;
  }
  const globalMap = options.globalConfig?.plugins;
  if (globalMap) {
    const globalDirect = globalMap[canonicalId];
    if (typeof globalDirect === 'boolean') return globalDirect;
    if (canonicalId === BUILTIN_ASK_USER_QUESTION_PLUGIN_ID) {
      const globalAlias = globalMap[LEGACY_ASK_USER_QUESTION_PLUGIN_ALIAS];
      if (typeof globalAlias === 'boolean') return globalAlias;
    } else if (canonicalId === BUILTIN_CONFIRM_ACTION_PLUGIN_ID) {
      const globalAlias = globalMap[LEGACY_CONFIRM_ACTION_PLUGIN_ALIAS];
      if (typeof globalAlias === 'boolean') return globalAlias;
    }
  }
  if (typeof options.defaultEnabled === 'boolean') return options.defaultEnabled;
  if (canonicalId === BUILTIN_ASK_USER_QUESTION_PLUGIN_ID) {
    return DEFAULT_ASK_USER_QUESTION_CONFIG.askUserQuestionXmlEnabled;
  }
  if (canonicalId === BUILTIN_CONFIRM_ACTION_PLUGIN_ID) return true;
  return false;
}

/** 判断某插件在会话级是否存在显式覆写（用于前端展示「已覆写」与「恢复默认」）。 */
export function getSessionOutputPluginOverride(
  pluginId: string,
  sessionOverrides?: SessionOutputPluginsMap | null,
  legacySessionAskEnabled?: boolean | null
): boolean | null {
  const canonicalId = normalizeOutputPluginId(pluginId);
  if (sessionOverrides) {
    const direct = sessionOverrides[canonicalId];
    if (typeof direct === 'boolean') return direct;
    if (canonicalId === BUILTIN_ASK_USER_QUESTION_PLUGIN_ID) {
      const alias = sessionOverrides[LEGACY_ASK_USER_QUESTION_PLUGIN_ALIAS];
      if (typeof alias === 'boolean') return alias;
    } else if (canonicalId === BUILTIN_CONFIRM_ACTION_PLUGIN_ID) {
      const alias = sessionOverrides[LEGACY_CONFIRM_ACTION_PLUGIN_ALIAS];
      if (typeof alias === 'boolean') return alias;
    }
  }
  if (canonicalId === BUILTIN_ASK_USER_QUESTION_PLUGIN_ID && typeof legacySessionAskEnabled === 'boolean') {
    return legacySessionAskEnabled;
  }
  return null;
}

/** 生成插件交互回传缓存/查重键。 */
export function outputPluginInstanceKey(pluginId: string, instanceId: string): string {
  return `${normalizeOutputPluginId(pluginId)}:${instanceId}`;
}

export interface OutputPluginCatalogItem extends OutputPluginMetadata {
  globalEnabled: boolean;
  promptInstruction: string;
}

export interface OutputPluginLoadWarning {
  file: string;
  message: string;
}

export interface OutputPluginsCatalogSnapshot {
  configured: boolean;
  config: OutputPluginsGlobalConfig;
  localDir: string;
  localDirExists: boolean;
  warnings: OutputPluginLoadWarning[];
  plugins: OutputPluginCatalogItem[];
}
