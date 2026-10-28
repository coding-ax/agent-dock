import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRepositories, type Repositories } from '@agent-dock/agent-dock-storage';
import { buildApp } from '../app.js';
import { LlmEndpointService, llmEndpointConfigKey } from './service.js';
import type { Fetch } from './client.js';

const repositories: Repositories[] = [];
afterEach(() => { while (repositories.length) repositories.pop()!.close(); });

const SECRET = 'sk-test-secret-value';

function harness() {
  const repos = createRepositories(':memory:');
  repositories.push(repos);
  // 默认给一个能返回正文的响应；个别用例自己换。
  const fetcher = vi.fn<Fetch>(async () => new Response(
    'data: {"choices":[{"delta":{"content":"已就绪"}}]}\n\ndata: [DONE]\n\n',
    { status: 200, headers: { 'content-type': 'text/event-stream' } }
  ));
  const service = new LlmEndpointService({ config: repos.config, fetcher });
  return { repos, service, fetcher };
}

const validBody = { format: 'openai-chat', baseUrl: 'https://api.openai.com/v1', apiKey: SECRET, model: 'gpt-5' };

describe('LlmEndpointService 配置面', () => {
  it('未配置时 state 只有 configured:false 与格式选项', async () => {
    const { service } = harness();
    const state = await service.state();
    expect(state.configured).toBe(false);
    expect(state.formats).toHaveLength(3);
    expect(await service.endpoint()).toBeUndefined();
  });

  it('未配置时 resolve 抛 409', async () => {
    const { service } = harness();
    await expect(service.resolve()).rejects.toMatchObject({ code: 'LLM_NOT_CONFIGURED', statusCode: 409 });
  });

  it('保存后能读回，且 baseUrl 被规范化', async () => {
    const { service, repos } = harness();
    await service.save({ ...validBody, baseUrl: 'api.openai.com/v1/' });
    expect(await service.endpoint()).toMatchObject({ baseUrl: 'https://api.openai.com/v1', model: 'gpt-5', format: 'openai-chat' });
    expect(JSON.parse((await repos.config.get(llmEndpointConfigKey))!)).toMatchObject({ apiKey: SECRET });
  });

  it('state 只报 apiKeySet，绝不下发密钥', async () => {
    const { service } = harness();
    await service.save(validBody);
    const state = await service.state();
    expect(state.apiKeySet).toBe(true);
    // 整串 JSON 里不能任何位置出现密钥。
    expect(JSON.stringify(state)).not.toContain(SECRET);
  });

  it('apiKey 留空沿用已存的那把——改模型名不必重填密钥', async () => {
    const { service } = harness();
    await service.save(validBody);
    await service.save({ format: 'anthropic-messages', baseUrl: 'https://api.anthropic.com', model: 'claude-fable-5' });
    expect(await service.endpoint()).toMatchObject({ apiKey: SECRET, model: 'claude-fable-5', format: 'anthropic-messages' });
  });

  it('传了新密钥就替换', async () => {
    const { service } = harness();
    await service.save(validBody);
    await service.save({ ...validBody, apiKey: 'sk-new-value' });
    expect((await service.endpoint())?.apiKey).toBe('sk-new-value');
  });

  it('首次配置没有密钥时是 400', async () => {
    const { service } = harness();
    await expect(service.save({ format: 'openai-chat', baseUrl: 'https://api.openai.com/v1', model: 'gpt-5' }))
      .rejects.toMatchObject({ code: 'LLM_API_KEY_REQUIRED', statusCode: 400 });
    // 密钥全空白的输入也不能当成「有密钥」。
    await expect(service.save({ ...validBody, apiKey: '   ' })).rejects.toMatchObject({ code: 'LLM_API_KEY_REQUIRED' });
  });

  it('清除后回到未配置，库里存的是空串（ConfigRepository 没有 delete）', async () => {
    const { service, repos } = harness();
    await service.save(validBody);
    expect((await service.clear()).configured).toBe(false);
    expect(await repos.config.get(llmEndpointConfigKey)).toBe('');
    expect(await service.endpoint()).toBeUndefined();
  });

  it('非法 body 是 400 而不是 500', async () => {
    const { service } = harness();
    for (const body of [{}, { format: 'nope', baseUrl: 'https://x.com', apiKey: SECRET, model: 'm' }, { ...validBody, model: '' }, 'string']) {
      const error = await service.save(body).catch(error => error);
      // 让 ZodError 冒到全局 handler 会变成 500，用户看到「服务器内部错误」而实际只是写错字段。
      expect(error.code).toBe('INVALID_LLM_ENDPOINT');
      expect(error.statusCode).toBe(400);
    }
  });

  it('非法 Base URL 是 400 且提示期望形态', async () => {
    const { service } = harness();
    for (const baseUrl of ['', '   ', 'ftp://x.com', 'http://']) {
      const error = await service.save({ ...validBody, baseUrl }).catch(error => error);
      expect(error.statusCode).toBe(400);
    }
    const error = await service.save({ ...validBody, baseUrl: 'ftp://x.com' }).catch(error => error);
    expect(error.message).toContain('https://api.openai.com/v1');
  });

  it('temperature 超出 0..1 被拒（Anthropic 只接受这个区间）', async () => {
    const { service } = harness();
    await expect(service.save({ ...validBody, temperature: 1.5 })).rejects.toMatchObject({ code: 'INVALID_LLM_ENDPOINT' });
    await expect(service.save({ ...validBody, temperature: 0.5 })).resolves.toMatchObject({ configured: true });
  });

  it('库里被手改成非法值时当作未配置，不让面板 500', async () => {
    const { repos, service } = harness();
    for (const raw of ['codex', '{坏掉的', JSON.stringify({ format: 'nope', baseUrl: 'x', apiKey: 'k', model: 'm' })]) {
      await repos.config.set(llmEndpointConfigKey, raw);
      expect(await service.endpoint()).toBeUndefined();
      expect((await service.state()).configured).toBe(false);
    }
  });
});

describe('LlmEndpointService 试跑', () => {
  it('回正文、模型与地址', async () => {
    const { service } = harness();
    await service.save(validBody);
    const result = await service.run({ prompt: '试跑' });
    expect(result).toMatchObject({ text: '已就绪', model: 'gpt-5', baseUrl: 'https://api.openai.com/v1', format: 'openai-chat' });
  });

  it('空 prompt 是 400，且不发起请求', async () => {
    const { service, fetcher } = harness();
    await service.save(validBody);
    await expect(service.run({ prompt: '  ' })).rejects.toMatchObject({ code: 'INVALID_PROMPT', statusCode: 400 });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('未配置时试跑是 409，且不发起请求', async () => {
    const { service, fetcher } = harness();
    await expect(service.run({ prompt: '试跑' })).rejects.toMatchObject({ code: 'LLM_NOT_CONFIGURED' });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('onDelta 收到增量', async () => {
    const { service } = harness();
    await service.save(validBody);
    const deltas: string[] = [];
    await service.run({ prompt: '试跑', onDelta: text => deltas.push(text) });
    expect(deltas).toEqual(['已就绪']);
  });

  it('上游失败原样抛，错误里不带密钥', async () => {
    const { repos } = harness();
    const fetcher = vi.fn<Fetch>(async () => new Response(JSON.stringify({ error: { message: 'Invalid API key' } }), { status: 401, headers: { 'content-type': 'application/json' } }));
    const service = new LlmEndpointService({ config: repos.config, fetcher });
    await service.save(validBody);
    const error = await service.run({ prompt: '试跑' }).catch(error => error);
    expect(error.code).toBe('LLM_UNAUTHORIZED');
    expect(error.message).not.toContain(SECRET);
  });
});

describe('模型端点路由', () => {
  const mount = async (service?: LlmEndpointService) => buildApp({} as any, service ? { llm: { service } } : {});

  it('GET/PUT/DELETE/test 四个端点连通', async () => {
    const { service } = harness();
    const app = await mount(service);

    expect((await app.inject({ method: 'GET', url: '/api/llm' })).json()).toMatchObject({ configured: false });

    const saved = await app.inject({ method: 'PUT', url: '/api/llm', payload: validBody });
    expect(saved.statusCode).toBe(200);
    expect(saved.json()).toMatchObject({ configured: true, apiKeySet: true, model: 'gpt-5' });

    const fetched = await app.inject({ method: 'GET', url: '/api/llm' });
    // 在 HTTP 这一层再断言一次密钥不外泄——投影函数对了不代表响应体对。
    expect(fetched.body).not.toContain(SECRET);

    const tested = await app.inject({ method: 'POST', url: '/api/llm/test', payload: {} });
    expect(tested.statusCode).toBe(200);
    expect(tested.json()).toMatchObject({ text: '已就绪', model: 'gpt-5' });

    expect((await app.inject({ method: 'DELETE', url: '/api/llm' })).json()).toMatchObject({ configured: false });
  });

  it('试跑可带自定义 prompt', async () => {
    const { service, fetcher } = harness();
    const app = await mount(service);
    await app.inject({ method: 'PUT', url: '/api/llm', payload: validBody });
    await app.inject({ method: 'POST', url: '/api/llm/test', payload: { prompt: '自定义' } });
    const body = JSON.parse((fetcher.mock.calls[0]![1] as RequestInit).body as string);
    expect(body.messages.at(-1)).toEqual({ role: 'user', content: '自定义' });
  });

  it('试跑未配置时是 409', async () => {
    const { service } = harness();
    const app = await mount(service);
    expect((await app.inject({ method: 'POST', url: '/api/llm/test', payload: {} })).statusCode).toBe(409);
  });

  it('非法 body 经路由是 400 而不是 500', async () => {
    const { service } = harness();
    const app = await mount(service);
    const bad = await app.inject({ method: 'PUT', url: '/api/llm', payload: { format: 'nope' } });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error.code).toBe('INVALID_LLM_ENDPOINT');
  });

  it('上游 401 经路由是 4xx 而不是 500', async () => {
    const { repos } = harness();
    const fetcher = vi.fn<Fetch>(async () => new Response(JSON.stringify({ error: { message: 'Invalid API key' } }), { status: 401, headers: { 'content-type': 'application/json' } }));
    const service = new LlmEndpointService({ config: repos.config, fetcher });
    const app = await mount(service);
    await app.inject({ method: 'PUT', url: '/api/llm', payload: validBody });
    const tested = await app.inject({ method: 'POST', url: '/api/llm/test', payload: {} });
    expect(tested.statusCode).toBe(400);
    expect(tested.json().error.code).toBe('LLM_UNAUTHORIZED');
  });

  it('流式试跑把增量按 SSE 帧发出，最后一条是完整结果', async () => {
    const { service } = harness();
    const app = await mount(service);
    await app.inject({ method: 'PUT', url: '/api/llm', payload: validBody });

    const streamed = await app.inject({ method: 'POST', url: '/api/llm/test/stream', payload: {} });
    expect(streamed.statusCode).toBe(200);
    expect(streamed.headers['content-type']).toContain('text/event-stream');
    // 反代缓冲会把增量攒成一坨，这个头必须发出去。
    expect(streamed.headers['x-accel-buffering']).toBe('no');

    const frames = streamed.body.split('\n\n').filter(Boolean);
    expect(frames.some(frame => frame.startsWith('event: delta'))).toBe(true);
    const done = frames.find(frame => frame.startsWith('event: done'))!;
    expect(done).toBeTruthy();
    expect(JSON.parse(done.split('\ndata: ')[1]!)).toMatchObject({ text: '已就绪', model: 'gpt-5' });
  });

  it('流式试跑的失败也是一条事件（头和状态已经发出去了，没法再改状态码）', async () => {
    const { repos } = harness();
    const fetcher = vi.fn<Fetch>(async () => new Response(JSON.stringify({ error: { message: 'Invalid API key' } }), { status: 401, headers: { 'content-type': 'application/json' } }));
    const service = new LlmEndpointService({ config: repos.config, fetcher });
    const app = await mount(service);
    await app.inject({ method: 'PUT', url: '/api/llm', payload: validBody });

    const streamed = await app.inject({ method: 'POST', url: '/api/llm/test/stream', payload: {} });
    expect(streamed.statusCode).toBe(200);
    const failed = streamed.body.split('\n\n').find(frame => frame.startsWith('event: failed'))!;
    expect(JSON.parse(failed.split('\ndata: ')[1]!)).toMatchObject({ code: 'LLM_UNAUTHORIZED' });
  });

  it('未配置时流式试跑报 failed 事件', async () => {
    const { service } = harness();
    const app = await mount(service);
    const streamed = await app.inject({ method: 'POST', url: '/api/llm/test/stream', payload: {} });
    const failed = streamed.body.split('\n\n').find(frame => frame.startsWith('event: failed'))!;
    expect(JSON.parse(failed.split('\ndata: ')[1]!)).toMatchObject({ code: 'LLM_NOT_CONFIGURED' });
  });

  it('没挂 service 时路由不存在', async () => {
    const app = await mount();
    expect((await app.inject({ method: 'GET', url: '/api/llm' })).statusCode).toBe(404);
  });
});
