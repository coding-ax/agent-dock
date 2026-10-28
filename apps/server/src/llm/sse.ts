/**
 * SSE 读取器。
 *
 * 三种格式的流式都是 SSE，所以只需要一个读取器 + 每格式一个事件解码器，
 * 而不是三套流式实现。
 *
 * 两处必须小心的地方：
 * 1. TextDecoder 要带 { stream: true } 增量解码——UTF-8 的一个汉字可能被切在
 *    两个 chunk 的边界上，不保留半个字符的状态就会解码出乱码。
 * 2. 一个 chunk 可能落在某一行的中间，所以必须按「事件块」缓冲，凑齐了才解析，
 *    绝不能对半个 JSON 调 JSON.parse。
 *
 * 事件块以空行分隔（\n\n 或 \r\n\r\n）。块内只取 data: 行，多行 data 用换行拼；
 * 以 : 开头的是注释（有网关拿它做心跳），丢掉。
 */
export interface SseEvent { event?: string; data: string }

/** 事件块的分隔符。返回 { index, length }，没找到返回 undefined。 */
function findBoundary(buffer: string): { index: number; length: number } | undefined {
  const lf = buffer.indexOf('\n\n');
  const crlf = buffer.indexOf('\r\n\r\n');
  if (lf < 0 && crlf < 0) return undefined;
  if (crlf >= 0 && (lf < 0 || crlf < lf)) return { index: crlf, length: 4 };
  return { index: lf, length: 2 };
}

/** 解析一个完整的事件块。没有任何 data 行时返回 undefined。 */
function parseBlock(raw: string): SseEvent | undefined {
  let event: string | undefined;
  const data: string[] = [];
  for (const line of raw.split('\n')) {
    // 逐行剥掉尾部 \r，这样 \r\n 与 \n 两种换行都能处理。
    const clean = line.endsWith('\r') ? line.slice(0, -1) : line;
    if (!clean || clean.startsWith(':')) continue;
    const colon = clean.indexOf(':');
    const field = colon < 0 ? clean : clean.slice(0, colon);
    // 按 SSE 规范，值前面那个空格要去掉（'data: x' → 'x'）。
    const value = colon < 0 ? '' : clean.slice(colon + 1).replace(/^ /, '');
    if (field === 'data') data.push(value);
    else if (field === 'event') event = value;
  }
  if (!data.length) return undefined;
  return { ...(event ? { event } : {}), data: data.join('\n') };
}

/** 把响应体读成事件流。调用方 onEach 返回 false 表示提前结束。 */
export async function readSseEvents(body: ReadableStream<Uint8Array>, onEach: (event: SseEvent) => void | false): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let stopped = false;
  try {
    while (!stopped) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let boundary = findBoundary(buffer);
      while (boundary) {
        const raw = buffer.slice(0, boundary.index);
        buffer = buffer.slice(boundary.index + boundary.length);
        const parsed = parseBlock(raw);
        if (parsed && onEach(parsed) === false) { stopped = true; break; }
        boundary = findBoundary(buffer);
      }
    }
    if (!stopped) {
      // 收尾：补上 decoder 里可能还留着的半个字符，并处理没有以空行结尾的最后一个块。
      buffer += decoder.decode();
      const parsed = parseBlock(buffer);
      if (parsed) onEach(parsed);
    }
  } finally {
    // 提前结束时必须把底层流取消掉，否则连接会一直挂着。
    if (stopped) await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}
