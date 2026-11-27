/**
 * AgentDock 纯 XML 输出交互插件服务：
 *
 * - 管理统一注册表（内置插件 + 本地声明式插件目录 `~/.agentdock/output-plugins` 热重载）；
 * - 管理全局默认开关（`output_plugins.config`，向后兼容迁移与双写 `ask_user_question.config`）；
 * - 按需为每个交互式会话拼装启用的插件 XML 协议提示词（关闭零 Token 消耗，中途关闭发一次性短提醒）；
 * - 提供 Web 与飞书统一的跨端幂等交互提交入口与事件广播，防止重复派发轮次并支持双端实时锁定同步。
 */
import type { FastifyInstance } from 'fastify';
import {
  ASK_USER_QUESTION_ANSWER_ORIGIN,
  ASK_USER_QUESTION_CONFIG_KEY,
  askUserQuestionAnswerItemSchema,
  askUserQuestionConfigSchema,
  BUILTIN_ASK_USER_QUESTION_PLUGIN_ID,
  BUILTIN_CONFIRM_ACTION_PLUGIN_ID,
  CONFIRM_ACTION_INTERACTION_ORIGIN,
  confirmActionDecisions,
  confirmActionRisks,
  createDefaultOutputPluginRegistry,
  declarativeInteractionFieldSchema,
  DEFAULT_ASK_USER_QUESTION_CONFIG,
  normalizeGlobalOutputPluginsConfig,
  normalizeOutputPluginId,
  now,
  OUTPUT_PLUGINS_CONFIG_KEY,
  outputPluginsGlobalConfigSchema,
  parseAskUserQuestionAnswer,
  parseConfirmActionInteraction,
  parseDeclarativeInteraction,
  resolveOutputPluginEnabled,
  resolvePluginDisabledNotice,
  resolvePluginPromptInstruction,
  RuntimeError,
  type AskUserQuestionAnswerItem,
  type AskUserQuestionAnswerPayload,
  type ChannelMappingRepository,
  type ConfigRepository,
  type ConfirmActionDecision,
  type ConfirmActionInteractionPayload,
  type ConfirmActionRisk,
  type DeclarativeInteractionField,
  type DeclarativeOutputPluginInteractionPayload,
  type OutputPluginCatalogItem,
  type OutputPluginDefinition,
  type OutputPluginInteractionSource,
  type OutputPluginLoadWarning,
  type OutputPluginRegistry,
  type OutputPluginsCatalogSnapshot,
  type OutputPluginsGlobalConfig,
  type Session,
  type TaskRecord,
  type ToolRiskPolicy
} from '@agent-dock/agent-dock-shared';
import { z } from 'zod';
import { loadLocalDeclarativeOutputPlugins } from './local-loader.js';

export const ASK_USER_QUESTION_ANSWERED_CHANNEL = 'ask-user-question:answered';
export const OUTPUT_PLUGIN_INTERACTION_CHANNEL_PREFIX = 'output-plugin:answered:';

const NON_INTERACTIVE_SESSION_SOURCES = new Set([
  'router',
  'platform',
  'lark-avatar',
  'lark-avatar-reaction'
]);

const NON_INTERACTIVE_TURN_ORIGINS = new Set([
  'injected',
  'maintenance',
  'handoff'
]);

export interface OutputPluginRuntimePort {
  getSession(id: string): Promise<Session | undefined>;
  getTasks?(id: string): Promise<TaskRecord[]>;
  dispatch(
    id: string,
    prompt: string,
    mode?: 'queue' | 'interrupt',
    agentPrompt?: string,
    riskPolicy?: ToolRiskPolicy,
    origin?: string,
    clientMessageId?: string
  ): Promise<TaskRecord & { queuedAhead?: number }>;
}

export interface OutputPluginServiceOptions {
  config: ConfigRepository;
  channelMappings?: ChannelMappingRepository;
  runtime?: OutputPluginRuntimePort;
  registry?: OutputPluginRegistry;
  /** 可选本地声明式插件目录（测试或自定义目录时传入；默认读取 `~/.agentdock/output-plugins`）。 */
  localPluginsDir?: string;
  env?: NodeJS.ProcessEnv;
  /** 单测或嵌入场景可关闭启动自动扫描本机 `~/.agentdock/output-plugins`。 */
  disableLocalPlugins?: boolean;
}

export interface OutputPluginsGlobalState {
  configured: boolean;
  config: OutputPluginsGlobalConfig;
}

export interface SubmitOutputPluginInteractionInput {
  pluginId: string;
  sessionId: string;
  instanceId: string;
  title?: string;
  source: OutputPluginInteractionSource;
  actedBy?: string;
  /** `builtin:ask-user-question` 专用作答列表。 */
  answers?: AskUserQuestionAnswerItem[];
  /** `builtin:confirm-action` 专用决策字段。 */
  decision?: ConfirmActionDecision;
  decisionLabel?: string;
  risk?: ConfirmActionRisk;
  comment?: string;
  /** 声明式 `action-card` / `form-card` 操作值与标签。 */
  actionValue?: string;
  actionLabel?: string;
  fields?: DeclarativeInteractionField[];
  note?: string;
  clientMessageId?: string;
  mode?: 'queue' | 'interrupt';
  dispatchTurn?: (params: {
    prompt: string;
    agentPrompt: string;
    origin: string;
    clientMessageId: string;
    payload: unknown;
  }) => Promise<unknown>;
}

export type SubmitOutputPluginInteractionResult<TPayload = unknown> =
  | { status: 'submitted'; pluginId: string; instanceId: string; payload: TPayload; task?: unknown }
  | { status: 'already_submitted'; pluginId: string; instanceId: string; existing: TPayload };

export type OutputPluginInteractionListener = (event: {
  pluginId: string;
  instanceId: string;
  sessionId: string;
  source: OutputPluginInteractionSource;
  payload: unknown;
}) => void | Promise<void>;

const saveGlobalConfigBodySchema = z.object({
  plugins: z.record(z.string().trim().min(1).max(120), z.boolean())
});

const webInteractBodySchema = z.object({
  instanceId: z.string().trim().min(1).max(200).optional(),
  questionId: z.string().trim().min(1).max(200).optional(),
  actionId: z.string().trim().min(1).max(200).optional(),
  title: z.string().trim().max(300).optional(),
  answers: z.array(askUserQuestionAnswerItemSchema).optional(),
  decision: z.enum(confirmActionDecisions).optional(),
  decisionLabel: z.string().trim().max(120).optional(),
  risk: z.enum(confirmActionRisks).optional(),
  comment: z.string().trim().max(4_000).optional(),
  actionValue: z.string().trim().max(200).optional(),
  actionLabel: z.string().trim().max(200).optional(),
  fields: z.array(declarativeInteractionFieldSchema).optional(),
  note: z.string().trim().max(4_000).optional(),
  mode: z.enum(['queue', 'interrupt']).optional(),
  clientMessageId: z.string().trim().min(1).max(200).optional()
});

export function interactionMappingChannel(pluginId: string): string {
  const canonicalId = normalizeOutputPluginId(pluginId);
  if (canonicalId === BUILTIN_ASK_USER_QUESTION_PLUGIN_ID) {
    return ASK_USER_QUESTION_ANSWERED_CHANNEL;
  }
  return `${OUTPUT_PLUGIN_INTERACTION_CHANNEL_PREFIX}${canonicalId}`;
}

export function interactionMappingKey(sessionId: string, instanceId: string): string {
  return `${sessionId}:${instanceId}`;
}

/** 从 ConfigRepository 读取全局插件开关，自动兼容迁移历史 `ask_user_question.config`。 */
export async function readOutputPluginsGlobalConfig(
  config?: ConfigRepository
): Promise<OutputPluginsGlobalState> {
  if (!config) {
    return { configured: false, config: { plugins: {} } };
  }
  const [rawPlugins, rawLegacyAsk] = await Promise.all([
    config.get(OUTPUT_PLUGINS_CONFIG_KEY),
    config.get(ASK_USER_QUESTION_CONFIG_KEY)
  ]);

  let legacyAskEnabled: boolean | undefined;
  let legacyConfigured = false;
  if (rawLegacyAsk?.trim()) {
    try {
      const parsedLegacy = askUserQuestionConfigSchema.safeParse(JSON.parse(rawLegacyAsk));
      if (parsedLegacy.success) {
        legacyAskEnabled = parsedLegacy.data.askUserQuestionXmlEnabled;
        legacyConfigured = true;
      }
    } catch { /* ignore malformed legacy config */ }
  }

  if (rawPlugins?.trim()) {
    try {
      const parsedJson = JSON.parse(rawPlugins);
      const parsed = outputPluginsGlobalConfigSchema.safeParse(parsedJson);
      if (parsed.success) {
        return {
          configured: true,
          config: normalizeGlobalOutputPluginsConfig(parsed.data, legacyAskEnabled)
        };
      }
    } catch { /* fallback to legacy */ }
  }

  return {
    configured: legacyConfigured,
    config: normalizeGlobalOutputPluginsConfig(undefined, legacyAskEnabled)
  };
}

export class OutputPluginService {
  readonly registry: OutputPluginRegistry;
  private readonly sessionPluginStates = new Map<string, Map<string, 'enabled' | 'disabled'>>();
  private readonly inFlightInteractions = new Set<string>();
  private readonly interactionListeners = new Set<OutputPluginInteractionListener>();
  private localDir = '';
  private localDirExists = false;
  private loadWarnings: OutputPluginLoadWarning[] = [];

  constructor(private readonly options: OutputPluginServiceOptions) {
    this.registry = options.registry ?? createDefaultOutputPluginRegistry();
    if (!options.disableLocalPlugins) {
      this.reloadLocalPluginsSync();
    } else {
      this.localDir = options.localPluginsDir ?? '';
      this.localDirExists = false;
      this.loadWarnings = [];
    }
  }

  /** 重新扫描本地声明式插件目录（`~/.agentdock/output-plugins/*.json`）并原子刷新注册表。 */
  reloadLocalPluginsSync(): { dir: string; exists: boolean; loadedCount: number; warnings: OutputPluginLoadWarning[] } {
    const result = loadLocalDeclarativeOutputPlugins({
      dir: this.options.localPluginsDir,
      env: this.options.env
    });
    const replaced = this.registry.replaceExternalPlugins(result.plugins);
    const warnings: OutputPluginLoadWarning[] = [
      ...result.warnings,
      ...replaced.skipped.map(item => ({ file: item.id, message: item.reason }))
    ];
    this.localDir = result.dir;
    this.localDirExists = result.exists;
    this.loadWarnings = warnings;
    return {
      dir: result.dir,
      exists: result.exists,
      loadedCount: replaced.loaded.length,
      warnings
    };
  }

  async globalState(): Promise<OutputPluginsGlobalState> {
    return readOutputPluginsGlobalConfig(this.options.config);
  }

  async catalog(): Promise<OutputPluginsCatalogSnapshot> {
    const state = await this.globalState();
    const plugins: OutputPluginCatalogItem[] = this.registry.listMetadata().map(meta => ({
      ...meta,
      globalEnabled: resolveOutputPluginEnabled(meta.id, {
        defaultEnabled: meta.defaultEnabled,
        globalConfig: state.config
      })
    }));
    const effectivePluginsMap: Record<string, boolean> = {};
    for (const plugin of plugins) {
      effectivePluginsMap[plugin.id] = plugin.globalEnabled;
    }
    return {
      configured: state.configured,
      config: { plugins: effectivePluginsMap },
      localDir: this.localDir,
      localDirExists: this.localDirExists,
      warnings: [...this.loadWarnings],
      plugins
    };
  }

  async reloadAndCatalog(): Promise<OutputPluginsCatalogSnapshot> {
    if (!this.options.disableLocalPlugins) {
      this.reloadLocalPluginsSync();
    }
    return this.catalog();
  }

  async saveGlobalConfig(input: unknown): Promise<OutputPluginsCatalogSnapshot> {
    const parsed = saveGlobalConfigBodySchema.safeParse(input);
    if (!parsed.success) {
      throw new RuntimeError(
        'INVALID_OUTPUT_PLUGINS_CONFIG',
        `交互插件全局配置不合法：${parsed.error.issues.map(issue => `${issue.path.join('.') || 'body'} ${issue.message}`).join('；')}`,
        400
      );
    }
    const existing = await this.globalState();
    const merged: Record<string, boolean> = { ...existing.config.plugins };
    for (const [key, value] of Object.entries(parsed.data.plugins)) {
      const canonicalId = normalizeOutputPluginId(key);
      if (!canonicalId) continue;
      merged[canonicalId] = value;
    }

    const normalized: OutputPluginsGlobalConfig = { plugins: merged };
    await this.options.config.set(OUTPUT_PLUGINS_CONFIG_KEY, JSON.stringify(normalized));

    // 向后兼容双写 `ask_user_question.config`，保证旧接口与旧读取方读到一致状态
    const askEnabled = resolveOutputPluginEnabled(BUILTIN_ASK_USER_QUESTION_PLUGIN_ID, {
      defaultEnabled: DEFAULT_ASK_USER_QUESTION_CONFIG.askUserQuestionXmlEnabled,
      globalConfig: normalized
    });
    await this.options.config.set(
      ASK_USER_QUESTION_CONFIG_KEY,
      JSON.stringify({ askUserQuestionXmlEnabled: askEnabled })
    );

    return this.catalog();
  }

  async isPluginEnabledForSession(
    pluginId: string,
    session?: Pick<Session, 'askUserQuestionEnabled' | 'outputPlugins'> | null
  ): Promise<boolean> {
    const canonicalId = normalizeOutputPluginId(pluginId);
    const plugin = this.registry.get(canonicalId);
    const globalState = await this.globalState();
    return resolveOutputPluginEnabled(canonicalId, {
      defaultEnabled: plugin?.defaultEnabled,
      globalConfig: globalState.config,
      sessionOverrides: session?.outputPlugins,
      legacySessionAskEnabled: session?.askUserQuestionEnabled
    });
  }

  async enabledPluginIdsForSession(
    session?: Pick<Session, 'askUserQuestionEnabled' | 'outputPlugins'> | null
  ): Promise<Set<string>> {
    const globalState = await this.globalState();
    const enabled = new Set<string>();
    for (const plugin of this.registry.list()) {
      const active = resolveOutputPluginEnabled(plugin.id, {
        defaultEnabled: plugin.defaultEnabled,
        globalConfig: globalState.config,
        sessionOverrides: session?.outputPlugins,
        legacySessionAskEnabled: session?.askUserQuestionEnabled
      });
      if (active) enabled.add(plugin.id);
    }
    return enabled;
  }

  /**
   * 按需向交互式会话注入所有已启用插件的纯 XML 协议指导（关闭的插件零 Token 消耗）。
   * 仅作用于实际提交给 Agent 的文本，不改变用户时间线展示内容。
   */
  async promptForSession(
    session: Pick<Session, 'id' | 'source' | 'askUserQuestionEnabled' | 'outputPlugins'>,
    prompt: string,
    origin?: string
  ): Promise<string> {
    if (session.source && NON_INTERACTIVE_SESSION_SOURCES.has(session.source)) return prompt;
    if (origin && NON_INTERACTIVE_TURN_ORIGINS.has(origin)) return prompt;

    const globalState = await this.globalState();
    const plugins = this.registry.list();
    if (!plugins.length) return prompt;

    let sessionMap = this.sessionPluginStates.get(session.id);
    const prefixes: string[] = [];

    for (const plugin of plugins) {
      const enabled = resolveOutputPluginEnabled(plugin.id, {
        defaultEnabled: plugin.defaultEnabled,
        globalConfig: globalState.config,
        sessionOverrides: session.outputPlugins,
        legacySessionAskEnabled: session.askUserQuestionEnabled
      });
      const previous = sessionMap?.get(plugin.id);

      if (enabled) {
        if (previous === 'enabled') continue;
        if (!sessionMap) {
          sessionMap = this.ensureSessionStateMap(session.id);
        }
        sessionMap.set(plugin.id, 'enabled');
        const guidance = resolvePluginPromptInstruction(plugin).trim();
        if (guidance) prefixes.push(guidance);
      } else if (previous === 'enabled') {
        sessionMap!.set(plugin.id, 'disabled');
        const notice = resolvePluginDisabledNotice(plugin).trim();
        if (notice) prefixes.push(notice);
      }
    }

    if (!prefixes.length) return prompt;
    return `${prefixes.join('\n\n')}\n\n${prompt}`;
  }

  private ensureSessionStateMap(sessionId: string): Map<string, 'enabled' | 'disabled'> {
    const existing = this.sessionPluginStates.get(sessionId);
    if (existing) return existing;
    const created = new Map<string, 'enabled' | 'disabled'>();
    this.sessionPluginStates.set(sessionId, created);
    if (this.sessionPluginStates.size > 5_000) {
      const oldest = this.sessionPluginStates.keys().next().value;
      if (oldest) this.sessionPluginStates.delete(oldest);
    }
    return created;
  }

  onInteraction(listener: OutputPluginInteractionListener): () => void {
    this.interactionListeners.add(listener);
    return () => {
      this.interactionListeners.delete(listener);
    };
  }

  async getSubmittedInteraction(
    pluginId: string,
    sessionId: string,
    instanceId: string
  ): Promise<unknown | undefined> {
    const canonicalId = normalizeOutputPluginId(pluginId);
    const plugin = this.registry.get(canonicalId);
    const channel = interactionMappingChannel(canonicalId);
    const key = interactionMappingKey(sessionId, instanceId);

    if (this.options.channelMappings) {
      const mapping = await this.options.channelMappings.get(channel, key);
      if (mapping?.extra) {
        const parsed = plugin?.parseInteraction
          ? plugin.parseInteraction(mapping.extra)
          : canonicalId === BUILTIN_ASK_USER_QUESTION_PLUGIN_ID
            ? parseAskUserQuestionAnswer(mapping.extra)
            : canonicalId === BUILTIN_CONFIRM_ACTION_PLUGIN_ID
              ? parseConfirmActionInteraction(mapping.extra)
              : parseDeclarativeInteraction(mapping.extra);
        if (parsed) return parsed;
      }
    }

    if (this.options.runtime?.getTasks && plugin?.interactionOrigin && plugin.parseInteraction && plugin.getInteractionInstanceId) {
      const tasks = await this.options.runtime.getTasks(sessionId).catch(() => []);
      for (let i = tasks.length - 1; i >= 0; i--) {
        const task = tasks[i]!;
        if (task.origin !== plugin.interactionOrigin) continue;
        if (task.status === 'cancelled' || task.status === 'failed') continue;
        const parsed = plugin.parseInteraction(task.prompt);
        if (parsed && plugin.getInteractionInstanceId(parsed) === instanceId) return parsed;
      }
    }
    return undefined;
  }

  private buildPayload(
    plugin: OutputPluginDefinition,
    input: SubmitOutputPluginInteractionInput,
    instanceId: string
  ): { payload: unknown; serializedPrompt: string; agentPrompt: string; origin: string; defaultClientMessageId: string } {
    if (!plugin.capabilities.interactive || !plugin.interactionOrigin || !plugin.serializeInteraction || !plugin.formatInteractionForAgent) {
      throw new RuntimeError('OUTPUT_PLUGIN_NOT_INTERACTIVE', `插件「${plugin.name}」为只读展示卡，不支持交互提交`, 400);
    }

    if (plugin.id === BUILTIN_ASK_USER_QUESTION_PLUGIN_ID) {
      const rawAnswers = input.answers ?? [];
      const normalizedAnswers: AskUserQuestionAnswerItem[] = rawAnswers.map(item => {
        const otherText = item.otherText?.trim() || undefined;
        return {
          questionId: item.questionId.trim(),
          prompt: item.prompt.trim(),
          selectedValues: item.selectedValues.map(value => value.trim()).filter(Boolean),
          selectedLabels: item.selectedLabels.map(label => label.trim()).filter(Boolean),
          ...(otherText ? { otherText } : {})
        };
      });
      const hasAnyAnswer = normalizedAnswers.some(
        item => item.selectedValues.length > 0 || item.selectedLabels.length > 0 || Boolean(item.otherText)
      );
      if (!normalizedAnswers.length || !hasAnyAnswer) {
        throw new RuntimeError('EMPTY_ASK_USER_QUESTION_ANSWER', '请至少选择或填写一项回答后再提交', 400);
      }
      const payload: AskUserQuestionAnswerPayload = {
        version: 1,
        questionId: instanceId,
        ...(input.title?.trim() ? { title: input.title.trim() } : {}),
        source: input.source,
        ...(input.actedBy?.trim() ? { answeredBy: input.actedBy.trim() } : {}),
        answeredAt: now(),
        answers: normalizedAnswers
      };
      return {
        payload,
        serializedPrompt: plugin.serializeInteraction(payload),
        agentPrompt: plugin.formatInteractionForAgent(payload),
        origin: ASK_USER_QUESTION_ANSWER_ORIGIN,
        defaultClientMessageId: `askq:${input.sessionId.trim()}:${instanceId}`
      };
    }

    if (plugin.id === BUILTIN_CONFIRM_ACTION_PLUGIN_ID) {
      const rawDecision = input.decision
        ?? (input.actionValue === 'confirm' || input.actionValue === 'approve'
          ? 'confirm'
          : input.actionValue === 'cancel' || input.actionValue === 'reject'
            ? 'cancel'
            : undefined);
      if (!rawDecision) {
        throw new RuntimeError('INVALID_CONFIRM_ACTION_DECISION', '请选择确认执行或取消操作', 400);
      }
      const decisionLabel = input.decisionLabel?.trim()
        || input.actionLabel?.trim()
        || (rawDecision === 'confirm' ? '确认执行' : '取消');
      const comment = (input.comment ?? input.note)?.trim() || undefined;
      const payload: ConfirmActionInteractionPayload = {
        version: 1,
        pluginId: BUILTIN_CONFIRM_ACTION_PLUGIN_ID,
        actionId: instanceId,
        ...(input.title?.trim() ? { title: input.title.trim() } : {}),
        ...(input.risk ? { risk: input.risk } : {}),
        decision: rawDecision,
        decisionLabel,
        ...(comment ? { comment } : {}),
        source: input.source,
        ...(input.actedBy?.trim() ? { decidedBy: input.actedBy.trim() } : {}),
        decidedAt: now()
      };
      return {
        payload,
        serializedPrompt: plugin.serializeInteraction(payload),
        agentPrompt: plugin.formatInteractionForAgent(payload),
        origin: CONFIRM_ACTION_INTERACTION_ORIGIN,
        defaultClientMessageId: `confirm:${input.sessionId.trim()}:${instanceId}`
      };
    }

    // 声明式交互插件（action-card / form-card）
    const actionValue = input.actionValue?.trim() || undefined;
    const actionLabel = input.actionLabel?.trim() || actionValue;
    const note = input.note?.trim() || undefined;
    const fields = (input.fields ?? []).map(field => ({
      name: field.name.trim(),
      label: field.label.trim(),
      value: field.value.trim(),
      ...(field.displayValue?.trim() ? { displayValue: field.displayValue.trim() } : {})
    })).filter(field => Boolean(field.name && (field.value || field.displayValue)));

    if (!actionValue && !fields.length && !note) {
      throw new RuntimeError('EMPTY_OUTPUT_PLUGIN_INTERACTION', '请先选择操作或填写表单内容后再提交', 400);
    }

    const payload: DeclarativeOutputPluginInteractionPayload = {
      version: 1,
      pluginId: plugin.id,
      pluginName: plugin.name,
      instanceId,
      ...(input.title?.trim() ? { title: input.title.trim() } : {}),
      source: input.source,
      ...(input.actedBy?.trim() ? { actedBy: input.actedBy.trim() } : {}),
      actedAt: now(),
      ...(actionValue ? { actionValue } : {}),
      ...(actionLabel ? { actionLabel } : {}),
      fields,
      ...(note ? { note } : {})
    };
    return {
      payload,
      serializedPrompt: plugin.serializeInteraction(payload),
      agentPrompt: plugin.formatInteractionForAgent(payload),
      origin: plugin.interactionOrigin,
      defaultClientMessageId: `outp:${plugin.id}:${input.sessionId.trim()}:${instanceId}`
    };
  }

  async submitInteraction(input: SubmitOutputPluginInteractionInput): Promise<SubmitOutputPluginInteractionResult> {
    const canonicalId = normalizeOutputPluginId(input.pluginId);
    const sessionId = input.sessionId.trim();
    const instanceId = input.instanceId.trim();
    if (!canonicalId || !sessionId || !instanceId) {
      throw new RuntimeError('INVALID_OUTPUT_PLUGIN_INTERACTION', 'pluginId、sessionId 和 instanceId 不能为空', 400);
    }

    const plugin = this.registry.get(canonicalId);
    if (!plugin) {
      throw new RuntimeError('OUTPUT_PLUGIN_NOT_FOUND', `未找到交互插件：${canonicalId}`, 404);
    }

    const prepared = this.buildPayload(plugin, input, instanceId);

    if (this.options.runtime) {
      const session = await this.options.runtime.getSession(sessionId);
      if (!session) throw new RuntimeError('SESSION_NOT_FOUND', `Unknown session: ${sessionId}`, 404);
      if (session.archivedAt) throw new RuntimeError('SESSION_ARCHIVED', '会话已归档，无法提交交互操作', 409);
    }

    const key = interactionMappingKey(sessionId, instanceId);
    const lockKey = `${canonicalId}:${key}`;
    if (this.inFlightInteractions.has(lockKey)) {
      throw new RuntimeError(
        canonicalId === BUILTIN_ASK_USER_QUESTION_PLUGIN_ID ? 'ASK_USER_QUESTION_IN_FLIGHT' : 'OUTPUT_PLUGIN_IN_FLIGHT',
        '该交互卡片正在提交中，请勿重复操作',
        409
      );
    }
    this.inFlightInteractions.add(lockKey);

    try {
      const existing = await this.getSubmittedInteraction(canonicalId, sessionId, instanceId);
      if (existing) {
        return {
          status: 'already_submitted',
          pluginId: canonicalId,
          instanceId,
          existing
        };
      }

      const clientMessageId = input.clientMessageId?.trim() || prepared.defaultClientMessageId;
      let task: unknown;
      if (input.dispatchTurn) {
        task = await input.dispatchTurn({
          prompt: prepared.serializedPrompt,
          agentPrompt: prepared.agentPrompt,
          origin: prepared.origin,
          clientMessageId,
          payload: prepared.payload
        });
      } else if (this.options.runtime) {
        task = await this.options.runtime.dispatch(
          sessionId,
          prepared.serializedPrompt,
          input.mode ?? 'queue',
          prepared.agentPrompt,
          undefined,
          prepared.origin,
          clientMessageId
        );
      } else {
        throw new RuntimeError('RUNTIME_UNAVAILABLE', 'AgentDock runtime 尚未就绪', 503);
      }

      if (this.options.channelMappings) {
        const channel = interactionMappingChannel(canonicalId);
        await this.options.channelMappings.save({
          id: `${channel}:${key}`,
          channel,
          externalId: key,
          sessionId,
          extra: prepared.serializedPrompt,
          createdAt: now()
        });
      }

      await Promise.allSettled(
        [...this.interactionListeners].map(listener => Promise.resolve(listener({
          pluginId: canonicalId,
          instanceId,
          sessionId,
          source: input.source,
          payload: prepared.payload
        })))
      );

      return {
        status: 'submitted',
        pluginId: canonicalId,
        instanceId,
        payload: prepared.payload,
        task
      };
    } finally {
      this.inFlightInteractions.delete(lockKey);
    }
  }
}

export function registerOutputPluginRoutes(app: FastifyInstance, service: OutputPluginService): void {
  app.get('/api/output-plugins', async () => service.catalog());
  app.put('/api/output-plugins/config', async request => service.saveGlobalConfig(request.body));
  app.post('/api/output-plugins/reload', async () => service.reloadAndCatalog());

  app.post<{ Params: { id: string; pluginId: string } }>(
    '/api/sessions/:id/output-plugins/:pluginId/interact',
    async (request, reply) => {
      const parsed = webInteractBodySchema.safeParse(request.body);
      if (!parsed.success) {
        throw new RuntimeError(
          'INVALID_OUTPUT_PLUGIN_INTERACTION',
          `交互提交参数不合法：${parsed.error.issues.map(issue => `${issue.path.join('.') || 'body'} ${issue.message}`).join('；')}`,
          400
        );
      }
      const instanceId = parsed.data.instanceId ?? parsed.data.questionId ?? parsed.data.actionId;
      if (!instanceId) {
        throw new RuntimeError('INVALID_OUTPUT_PLUGIN_INTERACTION', 'instanceId 不能为空', 400);
      }
      const result = await service.submitInteraction({
        pluginId: decodeURIComponent(request.params.pluginId),
        sessionId: request.params.id,
        instanceId,
        title: parsed.data.title,
        source: 'web',
        answers: parsed.data.answers,
        decision: parsed.data.decision,
        decisionLabel: parsed.data.decisionLabel,
        risk: parsed.data.risk,
        comment: parsed.data.comment,
        actionValue: parsed.data.actionValue,
        actionLabel: parsed.data.actionLabel,
        fields: parsed.data.fields,
        note: parsed.data.note,
        mode: parsed.data.mode,
        clientMessageId: parsed.data.clientMessageId
      });

      if (result.status === 'already_submitted') {
        return reply.code(409).send({
          error: {
            code: 'OUTPUT_PLUGIN_ALREADY_SUBMITTED',
            message: '该交互卡片已完成响应，无需重复提交'
          },
          alreadySubmitted: true,
          alreadyAnswered: true,
          existing: result.existing
        });
      }

      return reply.code(202).send({
        accepted: true,
        pluginId: result.pluginId,
        instanceId: result.instanceId,
        payload: result.payload,
        task: result.task
      });
    }
  );
}
