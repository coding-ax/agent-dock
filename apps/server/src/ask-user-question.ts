/**
 * 纯 XML 协议版 AskUserQuestion 兼容服务门面。
 *
 * 底层逻辑已全面收口到统一交互插件引擎 `OutputPluginService`（内置插件 `builtin:ask-user-question`）。
 * 本模块保留所有历史接口、路由（`/api/ask-user-question/config`、`/api/sessions/:id/ask-user-question/answer`）
 * 与导出常量，确保既有调用方与历史测试 100% 无损兼容。
 */
import type { FastifyInstance } from 'fastify';
import {
  askUserQuestionAnswerItemSchema,
  askUserQuestionConfigSchema,
  askUserQuestionOutputPlugin,
  BUILTIN_ASK_USER_QUESTION_PLUGIN_ID,
  DEFAULT_ASK_USER_QUESTION_CONFIG,
  OutputPluginRegistry,
  resolveOutputPluginEnabled,
  RuntimeError,
  type AskUserQuestionAnswerItem,
  type AskUserQuestionAnswerPayload,
  type AskUserQuestionConfig,
  type AskUserQuestionSource,
  type ChannelMappingRepository,
  type ConfigRepository,
  type Session,
  type TaskRecord,
  type ToolRiskPolicy
} from '@agent-dock/agent-dock-shared';
import { z } from 'zod';
import {
  ASK_USER_QUESTION_ANSWERED_CHANNEL,
  interactionMappingKey,
  OutputPluginService,
  readOutputPluginsGlobalConfig
} from './output-plugins/service.js';

export { ASK_USER_QUESTION_ANSWERED_CHANNEL };

export interface AskUserQuestionConfigState {
  configured: boolean;
  config: AskUserQuestionConfig;
}

export interface AskUserQuestionRuntimePort {
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

export interface AskUserQuestionServiceOptions {
  config: ConfigRepository;
  channelMappings?: ChannelMappingRepository;
  runtime?: AskUserQuestionRuntimePort;
  /** 共享的底层统一插件服务实例；未传时自动创建独立实例（便于单测与兼容构造）。 */
  outputPlugins?: OutputPluginService;
}

export interface SubmitAskUserQuestionAnswerInput {
  sessionId: string;
  questionId: string;
  title?: string;
  source: AskUserQuestionSource;
  answeredBy?: string;
  responderName?: string;
  responderSessionId?: string;
  answers: AskUserQuestionAnswerItem[];
  clientMessageId?: string;
  mode?: 'queue' | 'interrupt';
  dispatchTurn?: (params: {
    prompt: string;
    agentPrompt: string;
    origin: string;
    clientMessageId: string;
    payload: AskUserQuestionAnswerPayload;
  }) => Promise<unknown>;
}

export type SubmitAskUserQuestionAnswerResult =
  | { status: 'answered'; payload: AskUserQuestionAnswerPayload; task?: unknown }
  | { status: 'already_answered'; existing: AskUserQuestionAnswerPayload };

export type AskUserQuestionAnsweredListener = (
  sessionId: string,
  payload: AskUserQuestionAnswerPayload
) => void | Promise<void>;

const webAnswerBodySchema = z.object({
  questionId: z.string().trim().min(1).max(200),
  title: z.string().trim().max(300).optional(),
  source: z.enum(['web', 'assistant']).optional(),
  answeredBy: z.string().trim().max(200).optional(),
  responderName: z.string().trim().max(200).optional(),
  responderSessionId: z.string().trim().max(200).optional(),
  answers: z.array(askUserQuestionAnswerItemSchema).min(1),
  mode: z.enum(['queue', 'interrupt']).optional(),
  clientMessageId: z.string().trim().min(1).max(200).optional()
});

/** 从 ConfigRepository 读取 AskUserQuestion 全局配置（优先合并 `output_plugins.config` 与历史键）。 */
export async function readAskUserQuestionConfig(config?: ConfigRepository): Promise<AskUserQuestionConfig> {
  const state = await readOutputPluginsGlobalConfig(config);
  return {
    askUserQuestionXmlEnabled: resolveOutputPluginEnabled(BUILTIN_ASK_USER_QUESTION_PLUGIN_ID, {
      defaultEnabled: DEFAULT_ASK_USER_QUESTION_CONFIG.askUserQuestionXmlEnabled,
      globalConfig: state.config
    })
  };
}

export function answeredMappingKey(sessionId: string, questionId: string): string {
  return interactionMappingKey(sessionId, questionId);
}

export class AskUserQuestionService {
  readonly outputPlugins: OutputPluginService;

  constructor(options: AskUserQuestionServiceOptions) {
    this.outputPlugins = options.outputPlugins ?? new OutputPluginService({
      config: options.config,
      channelMappings: options.channelMappings,
      runtime: options.runtime,
      registry: new OutputPluginRegistry([askUserQuestionOutputPlugin]),
      disableLocalPlugins: true
    });
  }

  async state(): Promise<AskUserQuestionConfigState> {
    const global = await this.outputPlugins.globalState();
    const askEnabled = resolveOutputPluginEnabled(BUILTIN_ASK_USER_QUESTION_PLUGIN_ID, {
      defaultEnabled: DEFAULT_ASK_USER_QUESTION_CONFIG.askUserQuestionXmlEnabled,
      globalConfig: global.config
    });
    return {
      configured: global.configured,
      config: { askUserQuestionXmlEnabled: askEnabled }
    };
  }

  async get(): Promise<AskUserQuestionConfig> {
    return (await this.state()).config;
  }

  async isEnabled(): Promise<boolean> {
    return (await this.get()).askUserQuestionXmlEnabled;
  }

  /** 统一解析某会话的 AskUserQuestion XML 生效状态（会话级覆写优先于全局默认）。 */
  async isEnabledForSession(session?: Pick<Session, 'askUserQuestionEnabled' | 'outputPlugins'> | null): Promise<boolean> {
    return this.outputPlugins.isPluginEnabledForSession(BUILTIN_ASK_USER_QUESTION_PLUGIN_ID, session);
  }

  async save(input: unknown): Promise<AskUserQuestionConfigState> {
    const parsed = askUserQuestionConfigSchema.safeParse(input);
    if (!parsed.success) {
      throw new RuntimeError(
        'INVALID_ASK_USER_QUESTION_CONFIG',
        `询问卡片配置不合法：${parsed.error.issues.map(issue => `${issue.path.join('.') || 'body'} ${issue.message}`).join('；')}`,
        400
      );
    }
    await this.outputPlugins.saveGlobalConfig({
      plugins: {
        [BUILTIN_ASK_USER_QUESTION_PLUGIN_ID]: parsed.data.askUserQuestionXmlEnabled
      }
    });
    return {
      configured: true,
      config: { askUserQuestionXmlEnabled: parsed.data.askUserQuestionXmlEnabled }
    };
  }

  async promptForSession(
    session: Pick<Session, 'id' | 'source' | 'askUserQuestionEnabled' | 'outputPlugins'>,
    prompt: string,
    origin?: string
  ): Promise<string> {
    return this.outputPlugins.promptForSession(session, prompt, origin);
  }

  onAnswered(listener: AskUserQuestionAnsweredListener): () => void {
    return this.outputPlugins.onInteraction(event => {
      if (event.pluginId !== BUILTIN_ASK_USER_QUESTION_PLUGIN_ID) return;
      return listener(event.sessionId, event.payload as AskUserQuestionAnswerPayload);
    });
  }

  async getAnswered(sessionId: string, questionId: string): Promise<AskUserQuestionAnswerPayload | undefined> {
    return (await this.outputPlugins.getSubmittedInteraction(
      BUILTIN_ASK_USER_QUESTION_PLUGIN_ID,
      sessionId,
      questionId
    )) as AskUserQuestionAnswerPayload | undefined;
  }

  async submitAnswer(input: SubmitAskUserQuestionAnswerInput): Promise<SubmitAskUserQuestionAnswerResult> {
    const sessionId = input.sessionId.trim();
    const questionId = input.questionId.trim();
    if (!sessionId || !questionId) {
      throw new RuntimeError('INVALID_ASK_USER_QUESTION_ANSWER', 'sessionId 和 questionId 不能为空', 400);
    }
    const result = await this.outputPlugins.submitInteraction({
      pluginId: BUILTIN_ASK_USER_QUESTION_PLUGIN_ID,
      sessionId,
      instanceId: questionId,
      title: input.title,
      source: input.source,
      actedBy: input.answeredBy,
      responderName: input.responderName,
      responderSessionId: input.responderSessionId,
      answers: input.answers,
      clientMessageId: input.clientMessageId,
      mode: input.mode,
      ...(input.dispatchTurn
        ? {
            dispatchTurn: params => input.dispatchTurn!({
              ...params,
              payload: params.payload as AskUserQuestionAnswerPayload
            })
          }
        : {})
    });

    if (result.status === 'already_submitted') {
      return {
        status: 'already_answered',
        existing: result.existing as AskUserQuestionAnswerPayload
      };
    }
    return {
      status: 'answered',
      payload: result.payload as AskUserQuestionAnswerPayload,
      task: result.task
    };
  }
}

export function registerAskUserQuestionRoutes(app: FastifyInstance, service: AskUserQuestionService): void {
  app.get('/api/ask-user-question/config', async () => service.state());
  app.put('/api/ask-user-question/config', async request => service.save(request.body));
  app.post<{ Params: { id: string } }>('/api/sessions/:id/ask-user-question/answer', async (request, reply) => {
    const parsed = webAnswerBodySchema.safeParse(request.body);
    if (!parsed.success) {
      throw new RuntimeError(
        'INVALID_ASK_USER_QUESTION_ANSWER',
        `问答提交参数不合法：${parsed.error.issues.map(issue => `${issue.path.join('.') || 'body'} ${issue.message}`).join('；')}`,
        400
      );
    }
    const result = await service.submitAnswer({
      sessionId: request.params.id,
      questionId: parsed.data.questionId,
      title: parsed.data.title,
      source: parsed.data.source ?? 'web',
      answeredBy: parsed.data.answeredBy,
      responderName: parsed.data.responderName,
      responderSessionId: parsed.data.responderSessionId,
      answers: parsed.data.answers,
      mode: parsed.data.mode,
      clientMessageId: parsed.data.clientMessageId
    });
    if (result.status === 'already_answered') {
      return reply.code(409).send({
        error: {
          code: 'ASK_USER_QUESTION_ALREADY_ANSWERED',
          message: '该询问已完成作答，无需重复提交'
        },
        alreadyAnswered: true,
        existing: result.existing
      });
    }
    return reply.code(202).send({
      accepted: true,
      payload: result.payload,
      task: result.task
    });
  });
}
