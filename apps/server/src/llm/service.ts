/**
 * LLM 端点配置：平台拿模型能力的唯一来源。
 *
 * 「借用 Agent 跑任务」那条路已删除——为了扩写一句描述去冷启动一个完整 Agent 进程
 * 太慢，且用户没配 Agent 就等于没有 AI 能力。现在平台直连模型端点。
 *
 * 密钥处置沿用飞书 appSecret 的既有约定：明文存 configs 表，靠「不下发给前端」
 * 而不是靠加密。所以 Stored 形状里有 apiKey，PublicLLlmEndpoint 里只有 apiKeySet，
 * 且投影逐字段显式列出、绝不 spread——将来加字段时默认是「不下发」而不是「泄露」。
 */
import type { FastifyInstance } from 'fastify';
import { RuntimeError, type ConfigRepository } from '@agent-dock/agent-dock-shared';
import { LlmClient, type LlmClientOptions, type Fetch } from './client.js';
import { llmFormatOptions } from './adapters.js';
import {
  llmEndpointInputSchema, normalizeBaseUrl,
  type LlmEndpoint, type PublicLlmEndpoint, type StoredLlmEndpoint
} from './types.js';

export const llmEndpointConfigKey = 'platform.llm';

export interface LlmEndpointState extends PublicLlmEndpoint {
  /** 三种格式的选项与 Base URL 示例，直接进 UI，省得前端再抄一份。 */
  formats: typeof llmFormatOptions;
}

/** 存进库的形状校验。与入参的区别：apiKey 在这里是必填的（写库前已经合并过旧值）。 */
const storedSchema = llmEndpointInputSchema.required({ apiKey: true });

export interface LlmEndpointServiceOptions {
  config: ConfigRepository;
  fetcher?: Fetch;
  client?: LlmClient;
}

export class LlmEndpointService {
  private readonly client: LlmClient;

  constructor(private readonly options: LlmEndpointServiceOptions) {
    this.client = options.client ?? new LlmClient({ fetcher: options.fetcher } satisfies LlmClientOptions);
  }

  /**
   * 读端点。存了空串表示「已清除」——ConfigRepository 没有 delete。
   * 库里的值可能来自手改或旧版本，解析不出来就当作没配，而不是让整个面板 500。
   */
  async endpoint(): Promise<LlmEndpoint | undefined> {
    const raw = await this.options.config.get(llmEndpointConfigKey);
    if (!raw) return undefined;
    try {
      const parsed = storedSchema.safeParse(JSON.parse(raw));
      return parsed.success ? parsed.data : undefined;
    } catch { return undefined; }
  }

  async state(): Promise<LlmEndpointState> {
    const endpoint = await this.endpoint();
    if (!endpoint) return { configured: false, formats: llmFormatOptions };
    return { ...publicLlmEndpoint(endpoint), formats: llmFormatOptions };
  }

  /**
   * 写端点。
   *
   * apiKey 留空表示沿用已存的那把（与飞书 appSecret 的写入约定一致）——用户改个模型名
   * 不该被迫重新粘贴密钥。首次配置却没有密钥就是 400，因为没有可沿用的旧值。
   */
  async save(input: unknown): Promise<LlmEndpointState> {
    const parsed = llmEndpointInputSchema.safeParse(input);
    // 配置面写入口的错误得是 400：让 ZodError 冒到全局 handler 会变成 500，
    // 用户看到的是「服务器内部错误」，而实际只是请求体写错了字段。
    if (!parsed.success) {
      throw new RuntimeError('INVALID_LLM_ENDPOINT', `模型端点配置不合法：${parsed.error.issues.map(issue => `${issue.path.join('.') || 'body'} ${issue.message}`).join('；')}`, 400);
    }
    const baseUrl = normalizeBaseUrl(parsed.data.baseUrl);
    if (!baseUrl) throw new RuntimeError('INVALID_LLM_ENDPOINT', `Base URL 不是合法的 http(s) 地址：${parsed.data.baseUrl}。形如 https://api.openai.com/v1`, 400);

    const current = await this.endpoint();
    const apiKey = parsed.data.apiKey?.trim() || current?.apiKey;
    if (!apiKey) throw new RuntimeError('LLM_API_KEY_REQUIRED', '首次配置需要填写 API Key。', 400);

    const stored: StoredLlmEndpoint = { ...parsed.data, baseUrl, apiKey };
    await this.options.config.set(llmEndpointConfigKey, JSON.stringify(stored));
    return this.state();
  }

  async clear(): Promise<LlmEndpointState> {
    await this.options.config.set(llmEndpointConfigKey, '');
    return this.state();
  }

  /** 解析出可用的端点；没配就抛 409。 */
  async resolve(): Promise<LlmEndpoint> {
    const endpoint = await this.endpoint();
    if (!endpoint) throw new RuntimeError('LLM_NOT_CONFIGURED', '尚未配置模型端点：请在模型端点里填写 Base URL、API Key 与模型名。', 409);
    return endpoint;
  }

  /**
   * 跑一次。流式对调用方透明，onDelta 只是旁路。
   *
   * 与旧「借 Agent」路径的契约差别：没有 sessionId/taskId/status 那套状态机了，
   * 因为一次 HTTP 往返没有轮次可言。失败一律抛（带码的 RuntimeError），
   * 不像 runOnce 那样把轮次内的失败藏在 result.status 里。
   */
  async run(input: { prompt: string; timeoutMs?: number; onDelta?: (text: string) => void }) {
    const endpoint = await this.resolve();
    const prompt = input.prompt?.trim();
    if (!prompt) throw new RuntimeError('INVALID_PROMPT', 'Prompt 不能为空', 400);
    const result = await this.client.complete(endpoint, { prompt, timeoutMs: input.timeoutMs, onDelta: input.onDelta });
    return {
      format: endpoint.format,
      model: endpoint.model,
      baseUrl: endpoint.baseUrl,
      text: result.text,
      ...(result.truncated ? { truncated: true } : {})
    };
  }
}

/** 逐字段显式列出，绝不 spread——将来加字段时默认是「不下发」而不是「泄露」。 */
export const publicLlmEndpoint = (endpoint: LlmEndpoint): PublicLlmEndpoint => ({
  configured: true,
  format: endpoint.format,
  baseUrl: endpoint.baseUrl,
  model: endpoint.model,
  apiKeySet: Boolean(endpoint.apiKey),
  ...(endpoint.systemPrompt === undefined ? {} : { systemPrompt: endpoint.systemPrompt }),
  ...(endpoint.maxTokens === undefined ? {} : { maxTokens: endpoint.maxTokens }),
  ...(endpoint.temperature === undefined ? {} : { temperature: endpoint.temperature }),
  ...(endpoint.timeoutMs === undefined ? {} : { timeoutMs: endpoint.timeoutMs })
});

/** 试跑用的默认提示词：只验证链路通不通。直连模型没有文件系统，不必叮嘱它别动文件。 */
export const defaultLlmTestPrompt = '请只回复一句话：模型端点已就绪。';

export interface LlmRoutesOptions {
  service?: LlmEndpointService;
  testPrompt?: string;
}

/**
 * 模型端点配置面。挂在 /api/llm 下，属于管理面。
 *
 * web-access 的 sessionTokenAllows 只放行本路径的 GET——配置面板一打开就读它，
 * 403 会把整页打成「访问被拒」；而返回体里保证没有密钥，比已放行的 /api/agents 透露得更少。
 * 写与试跑（会带着密钥向用户指定的地址发请求）保持 master-only。
 */
export async function registerLlmRoutes(app: FastifyInstance, options?: LlmRoutesOptions): Promise<void> {
  const service = options?.service;
  if (!service) return;
  const testPrompt = options?.testPrompt ?? defaultLlmTestPrompt;
  app.get('/api/llm', async () => service.state());
  app.put('/api/llm', async request => service.save(request.body));
  app.delete('/api/llm', async () => service.clear());
  app.post<{ Body: { prompt?: string; timeoutMs?: number } }>('/api/llm/test', async request => {
    const prompt = request.body?.prompt?.trim() || testPrompt;
    return service.run({ prompt, timeoutMs: request.body?.timeoutMs });
  });
  // 流式试跑：试跑按钮用它把字一个个显示出来，而不是盯着转圈等十几秒。
  // SSE 帧格式与 /api/sessions/:id/stream 一致，前端两种都能用同一套读法。
  app.post<{ Body: { prompt?: string; timeoutMs?: number } }>('/api/llm/test/stream', async (request, reply) => {
    const prompt = request.body?.prompt?.trim() || testPrompt;
    reply.raw.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      // 反代（含 vite dev proxy）默认会缓冲响应，不显式关掉的话增量会被攒成一坨。
      'x-accel-buffering': 'no'
    });
    const send = (event: string, data: unknown) => { reply.raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); };
    try {
      const result = await service.run({
        prompt,
        timeoutMs: request.body?.timeoutMs,
        onDelta: text => send('delta', { text })
      });
      send('done', result);
    } catch (error) {
      // 失败也走 200 的流：头和状态已经发出去了，只能把错误当成一条事件告诉前端。
      const runtimeError = error as { code?: string; message?: string };
      send('failed', { code: runtimeError?.code ?? 'LLM_ERROR', message: runtimeError?.message ?? String(error) });
    } finally {
      reply.raw.end();
    }
    return reply;
  });
}
