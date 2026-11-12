import { isAgentStreamErrorText, isAgentWarningText, type AgentEvent } from '@agent-dock/agent-dock-shared';

export type CoalescableType = 'text' | 'thinking';

export interface StreamDeltaInput {
  type: string;
  data: Record<string, unknown> | undefined;
  raw?: string;
}

export interface CoalescedStreamDelta {
  type: CoalescableType;
  data: Record<string, unknown>;
  raw?: string;
}

/** 默认按 2 KB 落一次库：一轮 247 KB 的思考流会从一万多条降到一百多条。 */
export const STREAM_COALESCE_MAX_BYTES = 2 * 1024;
/**
 * 再慢的流也要在 250ms 内露头，否则网页上会先停住、再一次性蹦出一大段。
 * 流快时先撞字节阈值，流慢时靠这个定时器。
 */
export const STREAM_COALESCE_MAX_DELAY_MS = 250;

const DEFAULT_ROLE = 'assistant';

/**
 * 只有「正文/思考的分片」能合并。用户提问（role:'user'）是轮次锚点，合并后就切不回轮次；
 * 带 raw 的事件是原始协议数据，不能丢结构；其它事件类型本来就不是流式分片。
 */
export function isCoalescableStreamDelta(input: StreamDeltaInput): input is StreamDeltaInput & { type: CoalescableType; data: Record<string, unknown> & { text: string } } {
  if (input.raw) return false;
  if (input.type !== 'text' && input.type !== 'thinking') return false;
  const data = input.data;
  if (!data || typeof data.text !== 'string') return false;
  if (input.type === 'text' && (data.role ?? DEFAULT_ROLE) === 'user') return false;
  return true;
}

/**
 * 除 text 外的字段必须完全一致才能并进同一段：taskId 不同就是两轮，role 不同就是两类行。
 * 用稳定序列化而不是引用比较，避免上游每次新建对象都被当成新段。
 */
function shapeOf(data: Record<string, unknown>) {
  return Object.keys(data)
    .filter(key => key !== 'text')
    .sort()
    .map(key => `${key}\u0000${JSON.stringify(data[key])}`)
    .join('\u0001');
}

interface PendingStream {
  type: CoalescableType;
  data: Record<string, unknown>;
  raw?: string;
  shape: string;
  text: string;
  bytes: number;
  timer?: ReturnType<typeof setTimeout>;
}

export interface StreamCoalescerOptions {
  /** 真正写库并派发一条事件；调用方保证它运行在 per-session 的串行队列里。 */
  append(sessionId: string, delta: CoalescedStreamDelta): Promise<AgentEvent>;
  /** 与同一会话的其它事件写入共用一个串行队列。定时 flush 必须从这里进队。 */
  enqueue<T>(sessionId: string, task: () => Promise<T>): Promise<T>;
  maxBytes?: number;
  maxDelayMs?: number;
  /** 后台定时 flush 失败时兜底，不能变成 unhandledRejection 打挂 daemon。 */
  onError?(error: unknown): void;
}

/**
 * 写入侧的流式分片合并。
 *
 * 每个会话只保留一个未落库的片段；同类型、同附加字段的连续分片只拼字符串，撞到字节阈值、
 * 定时器到期、或者来了别的事件（状态/工具/提问）时再落一条完整事件。这样：
 * - DB 里不再有每条 2~15 字节的 token 行，生命周期计数不再被流式输出撑爆；
 * - 合并后的正文是原样拼接，刷新/回放/CLI 读到的仍是完整文本；
 * - 落库和实时派发是同一条事件、同一个序号，SSE 断线重连不受影响。
 */
export class StreamEventCoalescer {
  private readonly pending = new Map<string, PendingStream>();
  private readonly maxBytes: number;
  private readonly maxDelayMs: number;

  constructor(private readonly options: StreamCoalescerOptions) {
    this.maxBytes = Math.max(1, options.maxBytes ?? STREAM_COALESCE_MAX_BYTES);
    this.maxDelayMs = Math.max(0, options.maxDelayMs ?? STREAM_COALESCE_MAX_DELAY_MS);
  }

  /**
   * 收下一段。返回 `undefined` 表示先攒着；返回事件表示这一下撞到了字节阈值、已经落库。
   * 必须在调用方的串行队列里执行（options.append 不走队列，避免自己等自己）。
   */
  async write(sessionId: string, input: StreamDeltaInput & { type: CoalescableType; data: Record<string, unknown> & { text: string } }): Promise<AgentEvent | undefined> {
    const shape = shapeOf(input.data);
    const current = this.pending.get(sessionId);
    const incomingSealed = input.type === 'text' && (isAgentWarningText(input.data.text) || isAgentStreamErrorText(input.data.text));
    // 告警/流错误是独立语义事件，不是正文分片：Agent 常常先吐一整条 `Warning: ...`，紧接着
    // 才是回答。若并进同一行，下游（最终输出、Web 时间线）会把整行当告警丢掉，答案就没了。
    if (current && (current.type !== input.type || current.shape !== shape || incomingSealed || isSealedSegment(current))) await this.flush(sessionId);

    let pending = this.pending.get(sessionId);
    if (!pending) {
      pending = { type: input.type, data: { ...input.data }, shape, text: '', bytes: 0 };
      this.pending.set(sessionId, pending);
      this.arm(sessionId, pending);
    }
    pending.text += input.data.text;
    pending.bytes += Buffer.byteLength(input.data.text, 'utf8');
    if (pending.bytes >= this.maxBytes) return this.flush(sessionId);
    return undefined;
  }

  /** 落掉当前片段；没有片段时是空操作。 */
  async flush(sessionId: string): Promise<AgentEvent | undefined> {
    const pending = this.pending.get(sessionId);
    if (!pending) return undefined;
    if (pending.timer) clearTimeout(pending.timer);
    this.pending.delete(sessionId);
    return this.options.append(sessionId, { type: pending.type, data: { ...pending.data, text: pending.text }, ...(pending.raw ? { raw: pending.raw } : {}) });
  }

  /** 进程退出/会话回收前把没攒满的尾巴落库。 */
  async flushAll(): Promise<void> {
    await Promise.all([...this.pending.keys()].map(sessionId => this.options.enqueue(sessionId, () => this.flush(sessionId)).then(() => undefined)));
  }

  /** 清掉定时器与未落库缓冲。只用于会话已经收尾、尾巴已显式 flush 过的场景。 */
  discard(sessionId: string) {
    const pending = this.pending.get(sessionId);
    if (!pending) return;
    if (pending.timer) clearTimeout(pending.timer);
    this.pending.delete(sessionId);
  }

  private arm(sessionId: string, pending: PendingStream) {
    if (!this.maxDelayMs) return;
    pending.timer = setTimeout(() => {
      pending.timer = undefined;
      void this.options.enqueue(sessionId, () => this.flush(sessionId)).catch(error => this.options.onError?.(error));
    }, this.maxDelayMs);
    pending.timer.unref?.();
  }
}

function isSealedSegment(pending: PendingStream) {
  return pending.type === 'text' && (isAgentWarningText(pending.text) || isAgentStreamErrorText(pending.text));
}
