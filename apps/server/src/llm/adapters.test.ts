import { describe, expect, it } from 'vitest';
import { adapters, llmAdapter, llmFormatOptions } from './adapters.js';
import { llmFormats, normalizeBaseUrl, resolveRequestUrl, type LlmEndpoint } from './types.js';

const endpoint = (format: LlmEndpoint['format'], overrides: Partial<LlmEndpoint> = {}): LlmEndpoint => ({
  format, baseUrl: 'https://api.example.com/v1', apiKey: 'sk-secret-value', model: 'test-model', ...overrides
});

const request = { prompt: '你好', systemPrompt: '你是助手', maxTokens: 64, temperature: 0.5 };

describe('格式注册表', () => {
  it('每种格式都有适配器，缺一个就编译不过（这里是运行时兜底断言）', () => {
    for (const format of llmFormats) expect(llmAdapter(format)).toBeDefined();
    expect(Object.keys(adapters).sort()).toEqual([...llmFormats].sort());
  });

  it('给 UI 的选项里带人看的名字与 Base URL 示例', () => {
    const options = llmFormatOptions;
    expect(options).toHaveLength(3);
    for (const option of options) {
      expect(option.label).toBeTruthy();
      expect(option.baseUrlPlaceholder).toMatch(/^https:\/\//);
    }
  });
});

describe('normalizeBaseUrl', () => {
  it('去掉尾部斜杠、补上 scheme', () => {
    expect(normalizeBaseUrl('https://api.openai.com/v1/')).toBe('https://api.openai.com/v1');
    expect(normalizeBaseUrl('https://api.openai.com/v1///')).toBe('https://api.openai.com/v1');
    // 用户常只填裸域名。
    expect(normalizeBaseUrl('api.openai.com')).toBe('https://api.openai.com');
    expect(normalizeBaseUrl('  https://x.com/v1  ')).toBe('https://x.com/v1');
  });

  it('保留路径与查询串', () => {
    expect(normalizeBaseUrl('https://gw.corp/openai/v1')).toBe('https://gw.corp/openai/v1');
    expect(normalizeBaseUrl('https://gw.corp/v1?k=1')).toBe('https://gw.corp/v1?k=1');
  });

  it('拒绝空串与非 http(s) 协议', () => {
    expect(normalizeBaseUrl('')).toBeUndefined();
    expect(normalizeBaseUrl('   ')).toBeUndefined();
    expect(normalizeBaseUrl('ftp://x.com')).toBeUndefined();
    expect(normalizeBaseUrl('http://')).toBeUndefined();
  });
});

describe('resolveRequestUrl', () => {
  it('OpenAI 系：缺版本段时补 /v1，已有时不重复补', () => {
    const adapter = llmAdapter('openai-chat');
    expect(resolveRequestUrl('https://api.openai.com', adapter)).toBe('https://api.openai.com/v1/chat/completions');
    expect(resolveRequestUrl('https://api.openai.com/v1', adapter)).toBe('https://api.openai.com/v1/chat/completions');
  });

  it('自建网关带了别的版本段就不动它', () => {
    const adapter = llmAdapter('openai-chat');
    expect(resolveRequestUrl('https://gw.corp/openai/v2', adapter)).toBe('https://gw.corp/openai/v2/chat/completions');
    // 路径里有 /v1 段但不在末尾，也算已有版本段。
    expect(resolveRequestUrl('https://gw.corp/v1/openai', adapter)).toBe('https://gw.corp/v1/openai/chat/completions');
  });

  it('Anthropic 不会拼出 /v1/v1/messages', () => {
    const adapter = llmAdapter('anthropic-messages');
    // 这是统一「缺了就补 /v1」最容易踩的坑，所以单独钉死。
    expect(resolveRequestUrl('https://api.anthropic.com', adapter)).toBe('https://api.anthropic.com/v1/messages');
    expect(resolveRequestUrl('https://api.anthropic.com/v1', adapter)).toBe('https://api.anthropic.com/v1/messages');
  });

  it('Responses 用自己的路径', () => {
    const adapter = llmAdapter('openai-responses');
    expect(resolveRequestUrl('https://api.openai.com/v1', adapter)).toBe('https://api.openai.com/v1/responses');
  });
});

describe('鉴权头', () => {
  it('OpenAI 两种格式走 Bearer', () => {
    for (const format of ['openai-chat', 'openai-responses'] as const) {
      const headers = llmAdapter(format).headers(endpoint(format));
      expect(headers.authorization).toBe('Bearer sk-secret-value');
      expect(headers['content-type']).toBe('application/json');
    }
  });

  it('Anthropic 走 x-api-key 且必须带版本头', () => {
    const headers = llmAdapter('anthropic-messages').headers(endpoint('anthropic-messages'));
    expect(headers['x-api-key']).toBe('sk-secret-value');
    // 漏了这个头会得到一个看不出原因的 400。
    expect(headers['anthropic-version']).toBeTruthy();
    expect(headers.authorization).toBeUndefined();
  });
});

describe('请求体', () => {
  it('openai-chat：系统提示词是 messages 第一条', () => {
    const body = llmAdapter('openai-chat').body(endpoint('openai-chat'), request, true) as any;
    expect(body.model).toBe('test-model');
    expect(body.messages).toEqual([{ role: 'system', content: '你是助手' }, { role: 'user', content: '你好' }]);
    expect(body.stream).toBe(true);
    expect(body.max_tokens).toBe(64);
    expect(body.temperature).toBe(0.5);
  });

  it('openai-chat：没显式要限长时不发 max_tokens（推理模型上这个字段名会 400）', () => {
    const body = llmAdapter('openai-chat').body(endpoint('openai-chat'), { prompt: '你好' }, true) as any;
    expect('max_tokens' in body).toBe(false);
    expect('max_completion_tokens' in body).toBe(false);
  });

  it('openai-responses：input + instructions + max_output_tokens，且不用 system 角色', () => {
    const body = llmAdapter('openai-responses').body(endpoint('openai-responses'), request, true) as any;
    expect(body.input).toEqual([{ role: 'user', content: '你好' }]);
    expect(body.instructions).toBe('你是助手');
    expect(body.max_output_tokens).toBe(64);
    expect('messages' in body).toBe(false);
  });

  it('anthropic：max_tokens 必填，system 是顶层参数而不是消息角色', () => {
    const withTokens = llmAdapter('anthropic-messages').body(endpoint('anthropic-messages'), request, true) as any;
    expect(withTokens.max_tokens).toBe(64);
    expect(withTokens.system).toBe('你是助手');
    // 把 system 放进 messages 会被 400——这是跨格式第一号坑。
    expect(withTokens.messages).toEqual([{ role: 'user', content: '你好' }]);

    // 调用方没给上限时也必须带一个，否则 400。
    const withoutTokens = llmAdapter('anthropic-messages').body(endpoint('anthropic-messages'), { prompt: '你好' }, true) as any;
    expect(typeof withoutTokens.max_tokens).toBe('number');
    expect(withoutTokens.max_tokens).toBeGreaterThan(0);
  });
});

describe('readText', () => {
  it('openai-chat 取 choices[0].message.content', () => {
    expect(llmAdapter('openai-chat').readText({ choices: [{ message: { content: '答案' } }] })).toBe('答案');
  });

  it('openai-chat 认分片数组形态的 content（不少网关这么回）', () => {
    expect(llmAdapter('openai-chat').readText({ choices: [{ message: { content: [{ type: 'text', text: '答' }, { type: 'text', text: '案' }] } }] })).toBe('答案');
  });

  it('openai-responses 跳过 reasoning 条目并按 output_text 过滤', () => {
    // 推理模型会在首位放一个 type='reasoning' 的条目，它同样带 content 数组。
    const payload = {
      output: [
        { type: 'reasoning', content: [{ type: 'summary_text', text: '思考中…' }] },
        { type: 'message', content: [{ type: 'output_text', text: '答案' }] }
      ]
    };
    expect(llmAdapter('openai-responses').readText(payload)).toBe('答案');
  });

  it('openai-responses 绝不读 output_text 字段', () => {
    // 那个字段在原始 JSON 里不存在——它是官方 SDK 算出来的访问器。
    // 读它会让每一次成功都表现为「没有返回内容」。这里放一个陷阱值验证我们不碰它。
    const payload = { output_text: '不该被读到', output: [{ type: 'message', content: [{ type: 'output_text', text: '真的答案' }] }] };
    expect(llmAdapter('openai-responses').readText(payload)).toBe('真的答案');
  });

  it('openai-responses 只认 type=message 的条目', () => {
    const payload = { output: [{ type: 'function_call', content: [{ type: 'output_text', text: '不该被读到' }] }] };
    expect(llmAdapter('openai-responses').readText(payload)).toBeUndefined();
  });

  it('anthropic 只拼 text 块，跳过 thinking 块', () => {
    const payload = { content: [{ type: 'thinking', thinking: '思考中…' }, { type: 'text', text: '答' }, { type: 'text', text: '案' }] };
    expect(llmAdapter('anthropic-messages').readText(payload)).toBe('答案');
  });

  it('取不到正文时返回 undefined 而不是空串', () => {
    // 两者必须能区分：空串是合法的空回复，undefined 说明结构不对。
    expect(llmAdapter('openai-chat').readText({})).toBeUndefined();
    expect(llmAdapter('openai-responses').readText({ output: [] })).toBeUndefined();
    expect(llmAdapter('anthropic-messages').readText({ content: [] })).toBeUndefined();
    expect(llmAdapter('openai-chat').readText(null)).toBeUndefined();
    expect(llmAdapter('openai-chat').readText({ choices: [] })).toBeUndefined();
  });

  it('空串回复仍然返回空串', () => {
    expect(llmAdapter('openai-chat').readText({ choices: [{ message: { content: '' } }] })).toBe('');
  });
});

describe('readTruncated', () => {
  it('三种格式各自的截断标记', () => {
    expect(llmAdapter('openai-chat').readTruncated({ choices: [{ finish_reason: 'length' }] })).toBe(true);
    expect(llmAdapter('openai-chat').readTruncated({ choices: [{ finish_reason: 'stop' }] })).toBe(false);
    expect(llmAdapter('openai-responses').readTruncated({ status: 'incomplete' })).toBe(true);
    expect(llmAdapter('openai-responses').readTruncated({ status: 'completed' })).toBe(false);
    expect(llmAdapter('anthropic-messages').readTruncated({ stop_reason: 'max_tokens' })).toBe(true);
    expect(llmAdapter('anthropic-messages').readTruncated({ stop_reason: 'end_turn' })).toBe(false);
  });
});

describe('流式事件解码', () => {
  it('openai-chat 取 choices[0].delta.content', () => {
    const adapter = llmAdapter('openai-chat');
    expect(adapter.readDelta({ choices: [{ delta: { content: '平台' } }] })).toBe('平台');
    // 只带 role 的首条事件没有正文。
    expect(adapter.readDelta({ choices: [{ delta: { role: 'assistant' } }] })).toBeUndefined();
    // 结束事件没有 choices。
    expect(adapter.readDelta({ choices: [] })).toBeUndefined();
  });

  it('openai-responses 只认 response.output_text.delta', () => {
    const adapter = llmAdapter('openai-responses');
    expect(adapter.readDelta({ type: 'response.output_text.delta', delta: '平台' })).toBe('平台');
    // done 事件带的是整段文本而非增量，当成增量会把回答重复计入。
    expect(adapter.readDelta({ type: 'response.output_text.done', text: '平台 AI 已就绪。' })).toBeUndefined();
    expect(adapter.readDelta({ type: 'response.created' })).toBeUndefined();
  });

  it('anthropic 只认 content_block_delta 里的 text_delta', () => {
    const adapter = llmAdapter('anthropic-messages');
    expect(adapter.readDelta({ type: 'content_block_delta', delta: { type: 'text_delta', text: '平台' } })).toBe('平台');
    // 这两个也走 content_block_delta，不按 delta.type 收窄会拼进乱码。
    expect(adapter.readDelta({ type: 'content_block_delta', delta: { type: 'input_json_delta', partial_json: '{"a"' } })).toBeUndefined();
    expect(adapter.readDelta({ type: 'content_block_delta', delta: { type: 'thinking_delta', thinking: '想' } })).toBeUndefined();
    expect(adapter.readDelta({ type: 'message_start' })).toBeUndefined();
  });
});

describe('流结束与流内错误', () => {
  it('三种格式的结束标记', () => {
    expect(llmAdapter('openai-responses').isTerminal({ type: 'response.completed' })).toBe(true);
    expect(llmAdapter('anthropic-messages').isTerminal({ type: 'message_stop' })).toBe(true);
    for (const format of llmFormats) {
      expect(llmAdapter(format).isTerminal({ type: 'something_else' })).toBe(false);
      expect(llmAdapter(format).isTerminal(null)).toBe(false);
    }
  });

  it('流里的错误事件被认出来', () => {
    expect(llmAdapter('anthropic-messages').readStreamError({ type: 'error', error: { type: 'overloaded_error', message: '上游过载' } })).toBe('上游过载');
    expect(llmAdapter('openai-chat').readStreamError({ type: 'error', error: { message: '上游过载' } })).toBe('上游过载');
    // Responses 的失败事件把说明放在 response 里。
    expect(llmAdapter('openai-responses').readStreamError({ type: 'response.failed', response: { error: { message: '生成失败' } } })).toBe('生成失败');
    // 正常事件不算错误。
    expect(llmAdapter('anthropic-messages').readStreamError({ type: 'message_stop' })).toBeUndefined();
  });
});

describe('mapError', () => {
  const url = 'https://api.example.com/v1/chat/completions';

  it('401 / 403 映射成能看懂的中文，并带上上游原话', () => {
    const unauthorized = llmAdapter('openai-chat').mapError(401, { error: { message: 'Invalid API key' } }, url, '');
    expect(unauthorized.code).toBe('LLM_UNAUTHORIZED');
    expect(unauthorized.message).toContain('Invalid API key');
    expect(llmAdapter('openai-chat').mapError(403, {}, url, '').code).toBe('LLM_FORBIDDEN');
  });

  it('404 区分「模型不存在」与「路径不对」', () => {
    const modelMissing = llmAdapter('openai-chat').mapError(404, { error: { code: 'model_not_found', message: 'The model does not exist' } }, url, '');
    expect(modelMissing.code).toBe('LLM_MODEL_NOT_FOUND');

    const pathWrong = llmAdapter('openai-chat').mapError(404, {}, url, '');
    expect(pathWrong.code).toBe('LLM_ENDPOINT_NOT_FOUND');
    // 错误信息里要带请求到的地址，否则用户无从判断自己填错了哪一层。
    expect(pathWrong.message).toContain(url);
  });

  it('Responses 的 404 额外提示这个接口可能根本不存在', () => {
    const mapped = llmAdapter('openai-responses').mapError(404, {}, 'https://gw.corp/v1/responses', '');
    expect(mapped.code).toBe('LLM_ENDPOINT_NOT_FOUND');
    // 很多兼容网关只实现 chat/completions——这条提示能省掉一整轮排查。
    expect(mapped.message).toMatch(/Responses API/);
    expect(mapped.message).toMatch(/Chat Completions/);
  });

  it('429 与 5xx 各自成码', () => {
    expect(llmAdapter('openai-chat').mapError(429, {}, url, '').code).toBe('LLM_RATE_LIMITED');
    expect(llmAdapter('openai-chat').mapError(503, {}, url, '').code).toBe('LLM_UPSTREAM_ERROR');
    expect(llmAdapter('anthropic-messages').mapError(500, { error: { message: 'internal' } }, url, '').message).toContain('internal');
  });

  it('返回 HTML 时提示 baseUrl 可能填成了网页地址', () => {
    const mapped = llmAdapter('openai-chat').mapError(400, undefined, url, '<!DOCTYPE html><html>…');
    expect(mapped.code).toBe('LLM_ENDPOINT_NOT_JSON');
    expect(mapped.message).toMatch(/Base URL/);
  });

  it('错误信息里绝不出现密钥', () => {
    // 密钥走的是请求头，所以任何从响应体生成的错误都不该带上它。
    for (const format of llmFormats) {
      for (const status of [400, 401, 403, 404, 429, 500]) {
        const mapped = llmAdapter(format).mapError(status, { error: { message: 'x' } }, url, 'sk-secret-value');
        expect(mapped.message).not.toContain('sk-secret-value');
      }
    }
  });
});
