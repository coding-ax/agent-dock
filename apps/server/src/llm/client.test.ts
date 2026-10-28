import { describe, expect, it, vi } from 'vitest';
import { RuntimeError } from '@agent-dock/agent-dock-shared';
import { LlmClient, defaultLlmTimeoutMs, type Fetch } from './client.js';
import type { LlmEndpoint } from './types.js';

const endpoint = (overrides: Partial<LlmEndpoint> = {}): LlmEndpoint => ({
  format: 'openai-chat', baseUrl: 'https://api.example.com/v1', apiKey: 'sk-secret-value', model: 'test-model', ...overrides
});

/** 造一个带 content-type 与 body 的响应。body 为字符串时按整包给，为数组时按 SSE 分块给。 */
function response(body: string | string[], init: { status?: number; contentType?: string; headers?: Record<string, string> } = {}): Response {
  const status = init.status ?? 200;
  const contentType = init.contentType ?? (Array.isArray(body) ? 'text/event-stream' : 'application/json');
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of (Array.isArray(body) ? body : [body])) controller.enqueue(encoder.encode(chunk));
      controller.close();
    }
  });
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers({ 'content-type': contentType, ...init.headers }),
    body: stream,
    text: async () => Array.isArray(body) ? body.join('') : body,
    json: async () => JSON.parse(Array.isArray(body) ? body.join('') : body)
  } as unknown as Response;
}

const sse = (payloads: unknown[], terminator = 'data: [DONE]\n\n') =>
  [...payloads.map(payload => `data: ${typeof payload === 'string' ? payload : JSON.stringify(payload)}\n\n`), terminator];

const client = (fetcher: Fetch) => new LlmClient({ fetcher });

describe('流式拼接', () => {
  it('把分块的增量拼成完整正文', async () => {
    const fetcher = vi.fn(async () => response(sse([
      { choices: [{ delta: { content: '平台' } }] },
      { choices: [{ delta: { content: ' AI 已' } }] },
      { choices: [{ delta: { content: '就绪。' } }] }
    ])));
    const result = await client(fetcher).complete(endpoint(), { prompt: '试跑' });
    expect(result.text).toBe('平台 AI 已就绪。');
    expect(result.model).toBe('test-model');
  });

  it('一个事件被切在 JSON 中间也能拼回', async () => {
    // 直接构造原始 SSE 文本再手动切开，模拟网络分块。
    const raw = 'data: {"choices":[{"delta":{"content":"平台 AI 已就绪。"}}]}\n\ndata: [DONE]\n\n';
    const fetcher = vi.fn(async () => response([raw.slice(0, 20), raw.slice(20)]));
    expect((await client(fetcher).complete(endpoint(), { prompt: 'x' })).text).toBe('平台 AI 已就绪。');
  });

  it('onDelta 拿到逐段增量，且文本与返回值一致', async () => {
    const deltas: string[] = [];
    const fetcher = vi.fn(async () => response(sse([
      { choices: [{ delta: { content: '平台' } }] },
      { choices: [{ delta: { content: ' AI' } }] }
    ])));
    const result = await client(fetcher).complete(endpoint(), { prompt: 'x', onDelta: text => deltas.push(text) });
    // 增量是旁路，返回值始终是完整正文——这条不变式让两种调用方共用一条路径。
    expect(deltas).toEqual(['平台', ' AI']);
    expect(result.text).toBe(deltas.join(''));
  });

  it('遇到 [DONE] 就停，不再读后面的垃圾', async () => {
    const fetcher = vi.fn(async () => response(['data: {"choices":[{"delta":{"content":"答"}}]}\n\ndata: [DONE]\n\ndata: {"choices":[{"delta":{"content":"不该出现"}}]}\n\n']));
    expect((await client(fetcher).complete(endpoint(), { prompt: 'x' })).text).toBe('答');
  });

  it('结构化结束事件也能停', async () => {
    const fetcher = vi.fn(async () => response(sse([
      { type: 'content_block_delta', delta: { type: 'text_delta', text: '答' } },
      { type: 'message_stop' }
    ], '')));
    const result = await client(fetcher).complete(endpoint({ format: 'anthropic-messages' }), { prompt: 'x' });
    expect(result.text).toBe('答');
  });

  it('流里出现坏 JSON 的单个事件不影响其余增量', async () => {
    const fetcher = vi.fn(async () => response([
      'data: {坏掉的\n\n',
      'data: {"choices":[{"delta":{"content":"答"}}]}\n\n',
      'data: [DONE]\n\n'
    ]));
    expect((await client(fetcher).complete(endpoint(), { prompt: 'x' })).text).toBe('答');
  });

  it('流内的错误事件变成失败', async () => {
    const fetcher = vi.fn(async () => response(['data: {"type":"error","error":{"type":"overloaded_error","message":"上游过载"}}\n\n']));
    await expect(client(fetcher).complete(endpoint({ format: 'anthropic-messages' }), { prompt: 'x' }))
      .rejects.toMatchObject({ code: 'LLM_UPSTREAM_ERROR' });
  });

  it('截断标记带上（流式）', async () => {
    const fetcher = vi.fn(async () => response(sse([
      { choices: [{ delta: { content: '半截' }, finish_reason: 'length' }] }
    ])));
    const result = await client(fetcher).complete(endpoint(), { prompt: 'x' });
    expect(result.truncated).toBe(true);
  });

  it('流式但一条正文都没有时报错而不是返回空串', async () => {
    const fetcher = vi.fn(async () => response(['data: [DONE]\n\n']));
    await expect(client(fetcher).complete(endpoint(), { prompt: 'x' })).rejects.toMatchObject({ code: 'LLM_EMPTY_REPLY' });
  });
});

describe('网关无视 stream:true 时退回非流式', () => {
  it('content-type 是 application/json 就按整包解析', async () => {
    // 有些反代不支持 SSE，会回一个普通 JSON——这条守卫能挡掉一整类「换了个网关就炸」。
    const fetcher = vi.fn(async () => response(JSON.stringify({ choices: [{ message: { content: '整包答案' } }] })));
    const result = await client(fetcher).complete(endpoint(), { prompt: 'x' });
    expect(result.text).toBe('整包答案');
    // 请求体仍然带 stream:true，是上游选择忽略它。
    expect(JSON.parse((fetcher.mock.calls[0]![1] as RequestInit).body as string).stream).toBe(true);
  });

  it('非流式的截断标记也认', async () => {
    const fetcher = vi.fn(async () => response(JSON.stringify({ choices: [{ message: { content: '半截' }, finish_reason: 'length' }] })));
    expect((await client(fetcher).complete(endpoint(), { prompt: 'x' })).truncated).toBe(true);
  });

  it('200 但 body 里是 error 对象时报上游错误', async () => {
    const fetcher = vi.fn(async () => response(JSON.stringify({ error: { message: '模型被限流了' } })));
    await expect(client(fetcher).complete(endpoint(), { prompt: 'x' })).rejects.toMatchObject({ code: 'LLM_UPSTREAM_ERROR', message: expect.stringContaining('模型被限流了') });
  });

  it('返回 HTML 时提示 baseUrl 可能填错', async () => {
    const fetcher = vi.fn(async () => response('<!DOCTYPE html><html>not found</html>', { status: 404, contentType: 'text/html' }));
    await expect(client(fetcher).complete(endpoint(), { prompt: 'x' })).rejects.toMatchObject({ code: 'LLM_ENDPOINT_NOT_FOUND' });
  });

  it('空串回复是合法的，不当成错误', async () => {
    const fetcher = vi.fn(async () => response(JSON.stringify({ choices: [{ message: { content: '' } }] })));
    expect((await client(fetcher).complete(endpoint(), { prompt: 'x' })).text).toBe('');
  });
});

describe('错误映射', () => {
  it('401 带上上游原话', async () => {
    const fetcher = vi.fn(async () => response(JSON.stringify({ error: { message: 'Invalid API key' } }), { status: 401 }));
    await expect(client(fetcher).complete(endpoint(), { prompt: 'x' })).rejects.toMatchObject({ code: 'LLM_UNAUTHORIZED', message: expect.stringContaining('Invalid API key') });
  });

  it('404 的提示里带请求到的地址', async () => {
    const fetcher = vi.fn(async () => response('{}', { status: 404 }));
    await expect(client(fetcher).complete(endpoint(), { prompt: 'x' })).rejects.toMatchObject({
      message: expect.stringContaining('https://api.example.com/v1/chat/completions')
    });
  });

  it('重定向单独成码而不是当成 4xx', async () => {
    // redirect:'manual' 下 3xx 的 ok 是 false，不给它单独的码就会报成「接口不存在」。
    const fetcher = vi.fn(async () => response('', { status: 301, headers: { location: 'https://real.example.com/v1' } }));
    await expect(client(fetcher).complete(endpoint(), { prompt: 'x' })).rejects.toMatchObject({ code: 'LLM_ENDPOINT_REDIRECT', message: expect.stringContaining('real.example.com') });
    // 且必须是 manual——自动跟随会把 POST 改写成不带 body 的 GET。
    expect((fetcher.mock.calls[0]![1] as RequestInit).redirect).toBe('manual');
  });

  it('连接失败报网络错误', async () => {
    const fetcher = vi.fn(async () => { throw new Error('ECONNREFUSED'); });
    await expect(client(fetcher).complete(endpoint(), { prompt: 'x' })).rejects.toMatchObject({ code: 'LLM_NETWORK_ERROR', message: expect.stringContaining('ECONNREFUSED') });
  });

  it('错误信息里绝不出现密钥', async () => {
    const fetcher = vi.fn(async () => response(JSON.stringify({ error: { message: 'bad' } }), { status: 400 }));
    const error = await client(fetcher).complete(endpoint(), { prompt: 'x' }).catch(error => error);
    expect(error.message).not.toContain('sk-secret-value');
    // 密钥只应出现在请求头里。
    expect(JSON.stringify((fetcher.mock.calls[0]![1] as RequestInit).headers)).toContain('sk-secret-value');
  });
});

describe('超时', () => {
  it('header 迟迟不来时超时并清掉定时器', async () => {
    vi.useFakeTimers();
    try {
      const fetcher = vi.fn(() => new Promise<Response>(() => { /* 永不 resolve */ }));
      const pending = client(fetcher).complete(endpoint({ timeoutMs: 1_000 }), { prompt: 'x' });
      const assertion = expect(pending).rejects.toMatchObject({ code: 'LLM_TIMEOUT' });
      await vi.advanceTimersByTimeAsync(1_100);
      await assertion;
      // 不清定时器会让进程挂着不退出。
      expect(vi.getTimerCount()).toBe(0);
    } finally { vi.useRealTimers(); }
  });

  it('连上了但 body 一直不来也会超时', async () => {
    // 真实失败模式：服务端回了 200 就不发数据了。只在 fetch 上设超时挡不住这种。
    vi.useFakeTimers();
    try {
      const stalled = { ok: true, status: 200, headers: new Headers({ 'content-type': 'text/event-stream' }), body: new ReadableStream<Uint8Array>({ start() { /* 不 enqueue 也不 close */ } }) } as unknown as Response;
      const fetcher = vi.fn(async () => stalled);
      const pending = client(fetcher).complete(endpoint({ timeoutMs: 500 }), { prompt: 'x' });
      const assertion = expect(pending).rejects.toMatchObject({ code: 'LLM_TIMEOUT' });
      await vi.advanceTimersByTimeAsync(600);
      await assertion;
    } finally { vi.useRealTimers(); }
  });

  it('默认超时是有限值', () => {
    expect(defaultLlmTimeoutMs).toBeGreaterThan(0);
    expect(Number.isFinite(defaultLlmTimeoutMs)).toBe(true);
  });
});

describe('请求构造', () => {
  it('打的是拼好的 URL，带格式自己的鉴权头', async () => {
    // 用 Anthropic 自己的事件形状，否则适配器读不出增量（那才是真的没覆盖到）。
    const fetcher = vi.fn(async () => response(sse([
      { type: 'content_block_delta', delta: { type: 'text_delta', text: 'ok' } },
      { type: 'message_stop' }
    ], '')));
    await client(fetcher).complete(endpoint({ format: 'anthropic-messages', baseUrl: 'https://api.anthropic.com' }), { prompt: 'x' });
    const [url, init] = fetcher.mock.calls[0]! as [string, RequestInit];
    expect(url).toBe('https://api.anthropic.com/v1/messages');
    expect((init.headers as Record<string, string>)['x-api-key']).toBe('sk-secret-value');
  });

  it('端点上的 systemPrompt 与 maxTokens 作为默认值生效', async () => {
    const fetcher = vi.fn(async () => response(sse([{ choices: [{ delta: { content: 'ok' } }] }])));
    await client(fetcher).complete(endpoint({ systemPrompt: '端点提示词', maxTokens: 77 }), { prompt: 'x' });
    const body = JSON.parse((fetcher.mock.calls[0]![1] as RequestInit).body as string);
    expect(body.messages[0]).toEqual({ role: 'system', content: '端点提示词' });
    expect(body.max_tokens).toBe(77);
  });

  it('调用参数覆盖端点默认值', async () => {
    const fetcher = vi.fn(async () => response(sse([{ choices: [{ delta: { content: 'ok' } }] }])));
    await client(fetcher).complete(endpoint({ systemPrompt: '端点提示词' }), { prompt: 'x', systemPrompt: '调用提示词' });
    const body = JSON.parse((fetcher.mock.calls[0]![1] as RequestInit).body as string);
    expect(body.messages[0].content).toBe('调用提示词');
  });
});
