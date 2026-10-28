/**
 * 三种线格式的适配器。
 *
 * 差异集中在四处：鉴权头、路径与请求体字段名、响应正文的位置、流式事件的类型名。
 * 把每种格式写成一个纯对象（而不是继承同一个基类），是因为它们之间没有共享行为，
 * 只有共享接口；新增第四种格式 = 加一个对象 + 往 adapters 表加一行。
 *
 * 每个 readText 都必须能面对真实网关的怪癖（OpenAI 的 content 有时是分片数组、
 * Anthropic 的 thinking 块、Responses 的 reasoning 条目），所以取文本一律走
 * 「先按类型过滤、再拼文本」，不按位置取下标。
 */
import { llmErrorCodes, type LlmFormat, type LlmFormatAdapter, type ResolvedRequest } from './types.js';

/** 安全地取一个字符串字段。任何一层不是对象都返回 undefined，不抛。 */
const str = (value: unknown): string | undefined => typeof value === 'string' ? value : undefined;

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined;

const asArray = (value: unknown): unknown[] => Array.isArray(value) ? value : [];

/**
 * OpenAI 的 message.content 正常是字符串，但不少网关会回一个分片数组
 * （`[{type:'text',text:'…'}]`）。两种都要认，否则换了个网关就静默拿到空串。
 */
function openAiContent(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  const parts = asArray(value);
  if (!parts.length) return undefined;
  const text = parts.map(part => {
    const record = asRecord(part);
    return record?.type === 'text' ? str(record.text) ?? '' : '';
  }).join('');
  return text || undefined;
}

/** 从上游错误体里挖出那句人话。Anthropic 比 OpenAI 深一层。 */
function upstreamMessage(payload: unknown): string | undefined {
  const envelope = asRecord(payload);
  if (!envelope) return undefined;
  const error = asRecord(envelope.error);
  return str(error?.message) ?? str(envelope.message);
}

function mapHttpError(status: number, payload: unknown, url: string, rawText: string, format: LlmFormat): { code: string; message: string } {
  const detail = upstreamMessage(payload);
  const envelope = asRecord(asRecord(payload)?.error);
  const upstreamCode = str(envelope?.code) ?? str(asRecord(payload)?.code);

  if (status === 401) return { code: llmErrorCodes.unauthorized, message: `模型端点拒绝了这把 API Key（HTTP 401）${detail ? `：${detail}` : ''}` };
  if (status === 403) return { code: llmErrorCodes.forbidden, message: `这把 API Key 没有调用该模型的权限（HTTP 403）${detail ? `：${detail}` : ''}` };
  if (status === 429) return { code: llmErrorCodes.rateLimited, message: `模型端点限流（HTTP 429），稍后重试${detail ? `：${detail}` : ''}` };
  if (status === 404) {
    // 404 有两种截然不同的成因，分开报：模型名写错 vs 路径不对。
    if (upstreamCode === 'model_not_found' || /model/i.test(detail ?? '')) {
      return { code: llmErrorCodes.modelNotFound, message: `模型不存在（HTTP 404）：${detail ?? '请检查模型名'}` };
    }
    // 很多兼容 OpenAI 的网关只实现了 /chat/completions，没有 /responses。
    // 这条提示能省掉一整轮「服务挂了？」的排查。
    const hint = format === 'openai-responses'
      ? '该服务可能不支持 Responses API（它不是 chat/completions 的别名），请把格式改成「OpenAI Chat Completions」。'
      : '请检查 Base URL 是否填到了正确的层级（多数服务需要 /v1，部分自建网关不带版本段）。';
    return { code: llmErrorCodes.notFound, message: `接口不存在（HTTP 404）：${url}。${hint}${detail ? ` 上游说明：${detail}` : ''}` };
  }
  if (status >= 500) return { code: llmErrorCodes.upstream, message: `模型端点返回 HTTP ${status}${detail ? `：${detail}` : ''}` };
  // 其余 4xx：请求写错了（模型名、参数、格式），把上游原话带上，否则用户无从下手。
  const looksHtml = /^\s*<(!doctype|html)/i.test(rawText);
  if (looksHtml) return { code: llmErrorCodes.notJson, message: `模型端点返回的不是 JSON（HTTP ${status}），Base URL 可能填成了网页地址：${url}` };
  return { code: llmErrorCodes.upstream, message: `模型端点返回 HTTP ${status}${detail ? `：${detail}` : ''}` };
}

/** 把 token 上限写进请求体。默认不发，只有调用方显式要限长时才发。 */
function withMaxTokens(body: Record<string, unknown>, request: ResolvedRequest, field: string, required: boolean, fallback: number) {
  if (request.maxTokens !== undefined) body[field] = request.maxTokens;
  else if (required) body[field] = fallback;
}

function withTemperature(body: Record<string, unknown>, request: ResolvedRequest) {
  if (request.temperature !== undefined) body.temperature = request.temperature;
}

/** 统一的错误事件读取：三种格式的错误事件都是 {type:'error'} 且带 message。 */
function readStreamError(payload: unknown): string | undefined {
  const record = asRecord(payload);
  if (!record || record.type !== 'error') return undefined;
  return upstreamMessage(payload) ?? '模型端点在流式返回中途报错';
}

// ---------------------------------------------------------------------------
// OpenAI Chat Completions（/v1/chat/completions）
// ---------------------------------------------------------------------------

const openAiChat: LlmFormatAdapter = {
  format: 'openai-chat',
  label: 'OpenAI Chat Completions',
  baseUrlPlaceholder: 'https://api.openai.com/v1',
  requestPath: '/chat/completions',
  requiresMaxTokens: false,
  headers: endpoint => ({ 'content-type': 'application/json', authorization: `Bearer ${endpoint.apiKey}` }),
  body: (endpoint, request, stream) => {
    const messages: Array<{ role: string; content: string }> = [];
    // 系统提示词在这个格式里是 messages 的第一条。与 Anthropic 的顶层 system 不同。
    if (request.systemPrompt) messages.push({ role: 'system', content: request.systemPrompt });
    messages.push({ role: 'user', content: request.prompt });
    const body: Record<string, unknown> = { model: endpoint.model, messages, stream };
    // 默认不发 max_tokens：新的推理模型（o1/o3/gpt-5 系）已改名为 max_completion_tokens，
    // 发旧名会 400。我们的提示词都要短输出，不设上限即可绕开整个改名问题。
    withMaxTokens(body, request, 'max_tokens', false, 1024);
    withTemperature(body, request);
    return body;
  },
  readText: payload => {
    const choice = asRecord(asArray(asRecord(payload)?.choices)[0]);
    return openAiContent(asRecord(choice?.message)?.content);
  },
  readTruncated: payload => asRecord(asArray(asRecord(payload)?.choices)[0])?.finish_reason === 'length',
  readDelta: payload => {
    const choice = asRecord(asArray(asRecord(payload)?.choices)[0]);
    return openAiContent(asRecord(choice?.delta)?.content);
  },
  // OpenAI 用哨兵字符串 `data: [DONE]` 结束，不是结构化事件；client 会在解析前先认它，
  // 这里兜一个结构化形态以防某些网关改用事件表示。
  isTerminal: payload => asRecord(payload)?.type === 'message_stop',
  readStreamError,
  mapError: (status, payload, url, rawText) => mapHttpError(status, payload, url, rawText, 'openai-chat')
};

// ---------------------------------------------------------------------------
// OpenAI Responses（/v1/responses）
// ---------------------------------------------------------------------------

const openAiResponses: LlmFormatAdapter = {
  format: 'openai-responses',
  label: 'OpenAI Responses',
  baseUrlPlaceholder: 'https://api.openai.com/v1',
  requestPath: '/responses',
  requiresMaxTokens: false,
  headers: endpoint => ({ 'content-type': 'application/json', authorization: `Bearer ${endpoint.apiKey}` }),
  body: (endpoint, request, stream) => {
    const body: Record<string, unknown> = {
      model: endpoint.model,
      // input 的 content 直接给字符串最简单；分片写法（input_text）只在要多模态时才需要。
      input: [{ role: 'user', content: request.prompt }],
      stream
    };
    // 这个格式的系统提示词是顶层 instructions，不是 messages 里的 system 角色——
    // 新模型上 system 角色已让位给 developer，用 instructions 可以完全绕开角色名漂移。
    if (request.systemPrompt) body.instructions = request.systemPrompt;
    withMaxTokens(body, request, 'max_output_tokens', false, 1024);
    withTemperature(body, request);
    return body;
  },
  readText: payload => {
    // 注意：绝不能读 payload.output_text。那个字段在原始 JSON 里根本不存在——
    // 它是官方 SDK 在响应对象上算出来的便捷访问器，用 fetch 拿到的裸响应里没有，
    // 读它会让每一次成功的调用都表现为「模型没有返回内容」。
    // 也不能读 output[0]：推理模型会在首位放一个 type='reasoning' 的条目，
    // 它同样带 content 数组（装的是 summary 块）。
    const text = asArray(asRecord(payload)?.output)
      .map(item => asRecord(item))
      .filter(item => item?.type === 'message')
      .flatMap(item => asArray(item?.content))
      .map(block => asRecord(block))
      .filter(block => block?.type === 'output_text')
      .map(block => str(block?.text) ?? '')
      .join('');
    return text || undefined;
  },
  readTruncated: payload => asRecord(payload)?.status === 'incomplete',
  // 只认 delta 事件。response.output_text.done 带的是整段文本而非增量，
  // 当成增量处理会把回答重复计入。
  readDelta: payload => {
    const record = asRecord(payload);
    return record?.type === 'response.output_text.delta' ? str(record.delta) : undefined;
  },
  isTerminal: payload => {
    const type = asRecord(payload)?.type;
    return type === 'response.completed' || type === 'response.incomplete' || type === 'response.failed';
  },
  readStreamError: payload => {
    const record = asRecord(payload);
    if (record?.type !== 'response.failed') return undefined;
    return upstreamMessage(record.response) ?? upstreamMessage(payload) ?? '模型端点返回失败';
  },
  mapError: (status, payload, url, rawText) => mapHttpError(status, payload, url, rawText, 'openai-responses')
};

// ---------------------------------------------------------------------------
// Anthropic Messages（/v1/messages）
// ---------------------------------------------------------------------------

const anthropicMessages: LlmFormatAdapter = {
  format: 'anthropic-messages',
  label: 'Anthropic Messages',
  baseUrlPlaceholder: 'https://api.anthropic.com',
  requestPath: '/messages',
  requiresMaxTokens: true,
  headers: endpoint => ({
    'content-type': 'application/json',
    // 两处与 OpenAI 不同：鉴权走 x-api-key 而非 Bearer，且必须带版本头——
    // 漏了会得到一个看不出原因的 400。
    'x-api-key': endpoint.apiKey,
    'anthropic-version': '2023-06-01'
  }),
  body: (endpoint, request, stream) => {
    const body: Record<string, unknown> = {
      model: endpoint.model,
      // max_tokens 在这个格式里是必填，漏了直接 400。
      max_tokens: request.maxTokens ?? 1024,
      messages: [{ role: 'user', content: request.prompt }],
      stream
    };
    // system 是顶层参数，不是 messages 里的角色——放进去会 400。这是跨格式第一号坑。
    if (request.systemPrompt) body.system = request.systemPrompt;
    withTemperature(body, request);
    return body;
  },
  readText: payload => {
    // 只拼 type==='text' 的块：thinking 块带的是 .thinking 而不是 .text，
    // tool_use 块带的是 input，混进来会拼出乱码。
    const text = asArray(asRecord(payload)?.content)
      .map(block => asRecord(block))
      .filter(block => block?.type === 'text')
      .map(block => str(block?.text) ?? '')
      .join('');
    return text || undefined;
  },
  readTruncated: payload => asRecord(payload)?.stop_reason === 'max_tokens',
  readDelta: payload => {
    const record = asRecord(payload);
    if (record?.type !== 'content_block_delta') return undefined;
    const delta = asRecord(record.delta);
    // input_json_delta（工具调用）与 thinking_delta 也走 content_block_delta，
    // 不按 delta.type 收窄会把它们当正文拼进去。
    return delta?.type === 'text_delta' ? str(delta.text) : undefined;
  },
  isTerminal: payload => asRecord(payload)?.type === 'message_stop',
  readStreamError,
  mapError: (status, payload, url, rawText) => mapHttpError(status, payload, url, rawText, 'anthropic-messages')
};

/** 格式注册表。类型是 Record<LlmFormat, …>，所以新增枚举字面量而不加适配器会编译不过。 */
const adapters: Record<LlmFormat, LlmFormatAdapter> = {
  'openai-chat': openAiChat,
  'openai-responses': openAiResponses,
  'anthropic-messages': anthropicMessages
};

export { adapters };
export const llmAdapter = (format: LlmFormat): LlmFormatAdapter => adapters[format];

/** 供 UI 渲染下拉框与 placeholder；顺序即展示顺序。 */
export const llmFormatOptions = (Object.keys(adapters) as LlmFormat[]).map(format => ({
  value: format,
  label: adapters[format].label,
  baseUrlPlaceholder: adapters[format].baseUrlPlaceholder
}));
