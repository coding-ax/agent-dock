/**
 * 平台直连模型端点的领域模型。
 *
 * 平台自己没有任何模型通道，但也不该为了「扩写一句描述」去冷启动一个完整 Agent 进程
 * （走 ACP、握手、工具循环、跑完归档）。这里定义的端点就是平台拿模型能力的唯一来源：
 * 一个 Base URL + 一把 Key + 一种线格式 + 一个模型名，一次 HTTP 往返。
 *
 * 密钥只存在于服务端。Stored 形状里有 apiKey，下发给前端的 Public 形状里只有 apiKeySet。
 */
import { z } from 'zod';

/**
 * 三种线格式。用自描述的名字而不是 'openai' / 'anthropic'——OpenAI 有两套线格式，
 * 而它们之间的差异恰好就是最容易写错的地方（请求体字段名、响应正文路径全都不一样）。
 */
export const llmFormats = ['openai-chat', 'openai-responses', 'anthropic-messages'] as const;
export type LlmFormat = (typeof llmFormats)[number];

/** 一个端点：去哪、用哪种格式说话、用哪个模型。 */
export interface LlmEndpoint {
  format: LlmFormat;
  /** 已规范化：无尾斜杠。见 normalizeBaseUrl。 */
  baseUrl: string;
  apiKey: string;
  model: string;
  /** 端点上配的系统提示词；调用时传入的 systemPrompt 优先。 */
  systemPrompt?: string;
  maxTokens?: number;
  /** 区间 0..1——三种格式的安全交集（Anthropic 就是 0..1，OpenAI 是 0..2）。 */
  temperature?: number;
  timeoutMs?: number;
}

export interface LlmRequest {
  prompt: string;
  systemPrompt?: string;
  maxTokens?: number;
  temperature?: number;
  timeoutMs?: number;
  /** 增量文本回调。传了就走流式并把增量实时推出去；不传同样走流式，只是不回调。 */
  onDelta?: (text: string) => void;
}

export interface LlmResult {
  /** 累积的完整正文。流式与否都回这一份，调用方永远只认它。 */
  text: string;
  model: string;
  /** 上游因 token 上限截断。调用方据此判断「拿到了半截答案」而不是「模型说了空话」。 */
  truncated?: boolean;
}

/** 一次调用排除「没配端点」之后的失败，都带上能定位问题的码。 */
export const llmErrorCodes = {
  timeout: 'LLM_TIMEOUT',
  network: 'LLM_NETWORK_ERROR',
  unauthorized: 'LLM_UNAUTHORIZED',
  forbidden: 'LLM_FORBIDDEN',
  rateLimited: 'LLM_RATE_LIMITED',
  modelNotFound: 'LLM_MODEL_NOT_FOUND',
  notFound: 'LLM_ENDPOINT_NOT_FOUND',
  redirect: 'LLM_ENDPOINT_REDIRECT',
  notJson: 'LLM_ENDPOINT_NOT_JSON',
  upstream: 'LLM_UPSTREAM_ERROR',
  empty: 'LLM_EMPTY_REPLY',
  abandoned: 'LLM_STREAM_ABANDONED'
} as const;

/**
 * 每种格式一个适配器，新增格式是纯加法：加一个枚举字面量、写一个适配器、
 * 往注册表里加一行。client / service / 路由都不提任何一种格式的名字。
 */
export interface LlmFormatAdapter {
  readonly format: LlmFormat;
  /** 人看的名字，直接进 UI 的下拉框。 */
  readonly label: string;
  /** Base URL 输入框的示例值，直接进 UI 的 placeholder。 */
  readonly baseUrlPlaceholder: string;
  /** 补齐到 baseUrl 之后的路径（含前导斜杠），**不含版本段**——版本段由 resolveRequestUrl 统一处理。 */
  readonly requestPath: string;
  /**
   * 这个格式的 token 上限是否必填。Anthropic 必填，漏了直接 400；
   * OpenAI 系在部分推理模型上还会因为 max_tokens 这个字段名而报错，所以默认不发。
   */
  readonly requiresMaxTokens: boolean;
  headers(endpoint: LlmEndpoint): Record<string, string>;
  body(endpoint: LlmEndpoint, request: ResolvedRequest, stream: boolean): unknown;
  /** 非流式响应里取正文。取不到返回 undefined——空串是合法的空回复，两者必须能区分。 */
  readText(payload: unknown): string | undefined;
  /** 上游是否因 token 上限截断。 */
  readTruncated(payload: unknown): boolean;
  /** 一条 SSE 事件负载里的增量文本；非正文事件返回 undefined。 */
  readDelta(payload: unknown): string | undefined;
  /** 这条事件是否表示流结束。 */
  isTerminal(payload: unknown): boolean;
  /** 上游在流中途报错时的消息；不是错误事件返回 undefined。 */
  readStreamError(payload: unknown): string | undefined;
  /** 非 2xx 负载转成带码的错误。code 决定用户看到什么提示。 */
  mapError(status: number, payload: unknown, url: string, rawText: string): { code: string; message: string };
}

/** 端点默认值与调用参数合并之后的结果，适配器只认它。 */
export interface ResolvedRequest {
  prompt: string;
  systemPrompt?: string;
  maxTokens?: number;
  temperature?: number;
}

/** 存进库的形状。apiKey 是明文——与飞书 appSecret 同一处置：靠不下发而不是靠加密。 */
export interface StoredLlmEndpoint {
  format: LlmFormat;
  baseUrl: string;
  apiKey: string;
  model: string;
  systemPrompt?: string;
  maxTokens?: number;
  temperature?: number;
  timeoutMs?: number;
}

/** 下发给前端的形状：绝不带 apiKey。 */
export interface PublicLlmEndpoint {
  configured: boolean;
  format?: LlmFormat;
  baseUrl?: string;
  model?: string;
  /** 只报「有没有配密钥」。 */
  apiKeySet?: boolean;
  systemPrompt?: string;
  maxTokens?: number;
  temperature?: number;
  timeoutMs?: number;
}

const baseUrlSchema = z.string().trim().min(1, 'Base URL 不能为空');
const apiKeySchema = z.string();
const modelSchema = z.string().trim().min(1, '模型名不能为空');

/**
 * PUT 的入参。apiKey 允许空串——约定是「留空表示沿用已存的那把」，
 * 与飞书 appSecret 的写入约定一致，这样用户改模型名时不必重填密钥。
 */
export const llmEndpointInputSchema = z.object({
  format: z.enum(llmFormats),
  baseUrl: baseUrlSchema,
  apiKey: apiKeySchema.optional(),
  model: modelSchema,
  systemPrompt: z.string().optional(),
  maxTokens: z.number().int().positive().optional(),
  // 区间取三种格式的交集：Anthropic 只接受 0..1，照 0..2 校验会让用户在 anthropic 上撞 400。
  temperature: z.number().min(0).max(1).optional(),
  timeoutMs: z.number().int().positive().optional()
});
export type LlmEndpointInput = z.infer<typeof llmEndpointInputSchema>;

/**
 * 规范化 Base URL：去掉尾部斜杠、补上 scheme。
 *
 * 不在这里补 `/v1` —— 版本段由 resolveRequestUrl 统一处理，这样用户填
 * `https://api.anthropic.com` 和 `https://api.anthropic.com/v1` 都能通。
 *
 * 非法 URL 返回 undefined 而不是抛，让调用方决定报什么错。
 */
export function normalizeBaseUrl(input: string): string | undefined {
  const trimmed = input.trim();
  if (!trimmed) return undefined;
  // 先判 scheme 再剥尾斜杠：反过来会把 'http://' 剥成 'http:'，然后被当成裸域名
  // 补成 'https://http:' 这种看着像合法、实际毫无意义的值。
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  try {
    const url = new URL(withScheme);
    // 只放行 http(s)：ftp:// 之类能通过 URL 解析但 fetch 不了，早点拦掉。
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return undefined;
    // 空主机说明是 'http://' / 'https://' 这种只有 scheme 的输入。
    if (!url.hostname) return undefined;
    // 不要用 url.origin + url.pathname 拼：origin 是 'null' 时会拼出 'null/path'。
    return withScheme.replace(/\/+$/, '');
  } catch { return undefined; }
}

/**
 * 拼最终请求 URL：baseUrl + 版本段 + 格式自己的路径。
 *
 * 三种格式共用同一条规则，所以没有「Anthropic 要补、OpenAI 不用补」这种按格式分叉的逻辑
 * ——那种写法会在用户把 /v1 填进 baseUrl 时拼出 /v1/v1/messages。
 * 判据是 baseUrl 里是否已经出现过版本段：出现过就用用户的，没出现就补 /v1。
 */
export function resolveRequestUrl(baseUrl: string, adapter: LlmFormatAdapter): string {
  const base = baseUrl.replace(/\/+$/, '');
  const hasVersion = /\/v\d+(?:$|\/)/.test(base);
  return hasVersion ? `${base}${adapter.requestPath}` : `${base}/v1${adapter.requestPath}`;
}
