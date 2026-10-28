/**
 * 一次模型调用的 HTTP 与流式编排。
 *
 * 约定照搬 apps/server/src/lark/service.ts 的 LarkCardService.request：fetcher 从构造
 * 函数注入（测试才能替换）、AbortController + setTimeout 组合超时、AbortSignal.any 合并
 * 调用方信号、clearTimeout 放 finally、超时与网络错误分开报码。
 *
 * 对流式做了一层「透明化」：无论上游是否真的支持 SSE，对外都只回累积好的完整正文。
 * 增量通过 onDelta 回调出去——它是旁路，永远不是返回值。这条不变式让「只要最终字符串」
 * 的调用方（自动写描述）和「要看字一个个蹦出来」的调用方（试跑）共用同一条代码路径。
 */
import { RuntimeError } from '@agent-dock/agent-dock-shared';
import { abortable } from '../abortable.js';
import { readSseEvents } from './sse.js';
import { llmAdapter } from './adapters.js';
import { llmErrorCodes, resolveRequestUrl, type LlmEndpoint, type LlmRequest, type LlmResult, type ResolvedRequest } from './types.js';

export type Fetch = typeof globalThis.fetch;

/** 一次文本调用最多等多久。比这更慢的文本请求已经不正常了。 */
export const defaultLlmTimeoutMs = 30_000;

/** 上游没给用法说明时，错误信息里展示多少字节的原始响应。 */
const rawBodyPreviewLimit = 300;

export interface LlmClientOptions {
  fetcher?: Fetch;
}

export class LlmClient {
  private readonly fetcher: Fetch;

  constructor(options: LlmClientOptions = {}) {
    this.fetcher = options.fetcher ?? globalThis.fetch;
  }

  /** 拿一段文本。流式与否对调用方透明，见文件头注释。 */
  async complete(endpoint: LlmEndpoint, request: LlmRequest): Promise<LlmResult> {
    const adapter = llmAdapter(endpoint.format);
    const resolved: ResolvedRequest = {
      prompt: request.prompt,
      systemPrompt: request.systemPrompt ?? endpoint.systemPrompt,
      maxTokens: request.maxTokens ?? endpoint.maxTokens,
      temperature: request.temperature ?? endpoint.temperature
    };
    const url = resolveRequestUrl(endpoint.baseUrl, adapter);
    const timeoutMs = request.timeoutMs ?? endpoint.timeoutMs ?? defaultLlmTimeoutMs;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new RuntimeError(llmErrorCodes.timeout, `模型调用超过 ${timeoutMs}ms 未返回，已中断`, 504)), timeoutMs);
    try {
      return await abortable((async () => {
        const response = await this.fetcher(url, {
          method: 'POST',
          headers: adapter.headers(endpoint),
          body: JSON.stringify(adapter.body(endpoint, resolved, true)),
          signal: controller.signal,
          // 不跟随重定向：301/302 对 POST 会被改写成不带 body 的 GET，
          // 于是拿到一个和成因完全看不出关系的 404/405。直接报出来让用户换成最终地址。
          redirect: 'manual'
        });
        controller.signal.throwIfAborted();
        return await this.consume(response, adapter, url, endpoint, request.onDelta);
      })(), controller.signal);
    } catch (error) {
      // 已经是我们自己造的错（超时/HTTP/上游）就原样抛，别包成「网络错误」。
      if (error instanceof RuntimeError) throw error;
      if (controller.signal.aborted) throw controller.signal.reason;
      throw new RuntimeError(llmErrorCodes.network, `无法连接模型端点 ${url}：${error instanceof Error ? error.message : String(error)}`, 502);
    } finally {
      clearTimeout(timer);
    }
  }

  /** 把响应体变成正文。SSE 与整包 JSON 两条路，由 content-type 决定。 */
  private async consume(
    response: Response,
    adapter: ReturnType<typeof llmAdapter>,
    url: string,
    endpoint: LlmEndpoint,
    onDelta?: (text: string) => void
  ): Promise<LlmResult> {
    const contentType = response.headers.get('content-type') ?? '';
    const isStream = contentType.includes('text/event-stream') && response.body;

    // 3xx 必须最先判：redirect:'manual' 下它的 ok 是 false，交给下面的 !ok 分支会被
    // mapError 当成「接口不存在」，报出来的东西和成因（地址被重定向了）毫无关系。
    if (response.status >= 300 && response.status < 400) {
      throw new RuntimeError(llmErrorCodes.redirect, `模型端点返回了重定向（HTTP ${response.status}）到 ${response.headers.get('location') ?? '未知地址'}。请把 Base URL 直接填成最终地址。`, 502);
    }

    if (!response.ok) {
      // 失败时也按 SSE 走一遍：上游常在流里发一条错误事件再断，那条比状态码有用。
      const { payload, raw } = isStream ? await this.drainStream(response.body!, adapter, undefined, false) : await this.readJson(response);
      const mapped = adapter.mapError(response.status, payload, url, raw);
      throw new RuntimeError(mapped.code, mapped.message, response.status >= 500 ? 502 : 400);
    }

    if (isStream) {
      const { payload, raw, text } = await this.drainStream(response.body!, adapter, onDelta, true);
      if (text) return { text, model: endpoint.model, ...(adapter.readTruncated(payload) ? { truncated: true } : {}) };
      // 流里一条正文都没有：可能是上游只发了错误事件，也可能真的回了空。
      const streamError = adapter.readStreamError(payload);
      if (streamError) throw new RuntimeError(llmErrorCodes.upstream, `模型端点返回失败：${streamError}`, 502);
      const mapped = adapter.mapError(response.status, payload, url, raw);
      // 走到这里说明 HTTP 是 2xx 但流里没内容。上游若有 error 字段就用它，否则
      // 报「返回为空」——比 500 更能说明问题（多半是流被中断了）。
      if (raw.includes('"error"')) throw new RuntimeError(mapped.code, mapped.message, 502);
      throw new RuntimeError(llmErrorCodes.empty, `模型端点返回了空的流式响应（${url}）。`, 502);
    }

    const { payload, raw } = await this.readJson(response);
    // 有些网关回 200 却在 body 里放错误对象。先认这个，再谈正文。
    const text = adapter.readText(payload);
    if (text === undefined) {
      const errorMessage = this.payloadErrorMessage(payload);
      if (errorMessage) throw new RuntimeError(llmErrorCodes.upstream, `模型端点返回失败：${errorMessage}`, 502);
      throw new RuntimeError(llmErrorCodes.empty, `模型端点没有返回正文（${url}）。返回内容：${raw.slice(0, rawBodyPreviewLimit)}`, 502);
    }
    return { text, model: endpoint.model, ...(adapter.readTruncated(payload) ? { truncated: true } : {}) };
  }

  /** 读流。返回累积文本、最后一条事件负载（供截断/错误判定）与原始片段。 */
  private async drainStream(
    body: ReadableStream<Uint8Array>,
    adapter: ReturnType<typeof llmAdapter>,
    onDelta: ((text: string) => void) | undefined,
    collect: boolean
  ): Promise<{ text: string; payload: unknown; raw: string }> {
    let text = '';
    let payload: unknown;
    const snippets: string[] = [];
    let sawDone = false;
    await readSseEvents(body, event => {
      const data = event.data;
      // OpenAI 用哨兵字符串结束，它不是 JSON，必须在解析之前认出来。
      if (data.trim() === '[DONE]') { sawDone = true; return false; }
      let parsed: unknown;
      try { parsed = JSON.parse(data); } catch {
        // 解析不了就跳过这一条，不要让一条坏事件毁掉整段回答。
        if (snippets.length < 3) snippets.push(data);
        return;
      }
      payload = parsed;
      if (adapter.isTerminal(parsed)) return false;
      const delta = adapter.readDelta(parsed);
      if (delta === undefined) return;
      if (collect) text += delta;
      onDelta?.(delta);
    });
    void sawDone;
    return { text, payload, raw: snippets.join('\n') };
  }

  /** 读整包 JSON（以及拿不到 JSON 时的原始文本，错误提示要用）。 */
  private async readJson(response: Response): Promise<{ payload: unknown; raw: string }> {
    const raw = await response.text().catch(() => '');
    try { return { payload: raw ? JSON.parse(raw) : undefined, raw }; } catch { return { payload: undefined, raw }; }
  }

  private payloadErrorMessage(payload: unknown): string | undefined {
    if (typeof payload !== 'object' || payload === null) return undefined;
    const record = payload as Record<string, unknown>;
    const error = record.error;
    if (typeof error === 'string') return error;
    if (typeof error === 'object' && error !== null) {
      const message = (error as Record<string, unknown>).message;
      if (typeof message === 'string') return message;
    }
    return typeof record.message === 'string' ? record.message : undefined;
  }
}
