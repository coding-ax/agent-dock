import { describe, expect, it } from 'vitest';
import { readSseEvents, type SseEvent } from './sse.js';

/** 把若干段字节按顺序合成一个 ReadableStream，模拟网络分块到达。 */
function streamOf(chunks: Array<string | Uint8Array>): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(typeof chunk === 'string' ? encoder.encode(chunk) : chunk);
      controller.close();
    }
  });
}

async function collect(chunks: Array<string | Uint8Array>): Promise<SseEvent[]> {
  const events: SseEvent[] = [];
  await readSseEvents(streamOf(chunks), event => { events.push(event); });
  return events;
}

describe('readSseEvents', () => {
  it('解析单个事件', async () => {
    expect(await collect(['data: {"a":1}\n\n'])).toEqual([{ data: '{"a":1}' }]);
  });

  it('一次到达多个事件', async () => {
    expect(await collect(['data: 1\n\ndata: 2\n\n'])).toEqual([{ data: '1' }, { data: '2' }]);
  });

  it('事件被切在 data 行中间也能拼回', async () => {
    // 这是流式最容易错的地方：不能对半个 JSON 调 parse。
    const events = await collect(['data: {"te', 'xt":"平台 AI', ' 已就绪。"}\n\n']);
    expect(events).toEqual([{ data: '{"text":"平台 AI 已就绪。"}' }]);
  });

  it('一个多字节字符被切在两个 chunk 中间不会乱码', async () => {
    const encoder = new TextEncoder();
    const bytes = encoder.encode('data: 平台\n\n');
    // 从「平」这个汉字的中间切开：UTF-8 里它是 3 个字节。
    const cut = bytes.indexOf(0xe5) + 1;
    const events = await collect([bytes.slice(0, cut), bytes.slice(cut)]);
    expect(events).toEqual([{ data: '平台' }]);
  });

  it('认 CRLF 换行，也认 CRLF 与 LF 混用', async () => {
    expect(await collect(['data: a\r\n\r\ndata: b\r\n\r\n'])).toEqual([{ data: 'a' }, { data: 'b' }]);
    expect(await collect(['data: a\r\n\r\ndata: b\n\n'])).toEqual([{ data: 'a' }, { data: 'b' }]);
  });

  it('边界正好落在 \\r\\n 与下一行之间', async () => {
    // 第一个 chunk 以 \r\n\r 结尾，分隔符的最后一个字节在下一个 chunk 里。
    expect(await collect(['data: a\r\n\r', '\ndata: b\r\n\r\n'])).toEqual([{ data: 'a' }, { data: 'b' }]);
  });

  it('跳过注释行（网关心跳）与空行', async () => {
    expect(await collect([': ping\n\n', ':heartbeat\n\ndata: real\n\n'])).toEqual([{ data: 'real' }]);
  });

  it('多行 data 用换行拼起来', async () => {
    expect(await collect(['data: line1\ndata: line2\n\n'])).toEqual([{ data: 'line1\nline2' }]);
  });

  it('带上 event 名', async () => {
    expect(await collect(['event: message_start\ndata: {}\n\n'])).toEqual([{ event: 'message_start', data: '{}' }]);
  });

  it('没有尾随空行的最后一个事件也会被送出', async () => {
    expect(await collect(['data: last'])).toEqual([{ data: 'last' }]);
  });

  it('没有 data 行的块被丢掉', async () => {
    expect(await collect(['event: ping\n\n', 'data: x\n\n'])).toEqual([{ data: 'x' }]);
  });

  it('回调返回 false 时提前结束并取消底层流', async () => {
    const events: SseEvent[] = [];
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('data: 1\n\ndata: 2\n\ndata: 3\n\n'));
      },
      cancel() { cancelled = true; }
    });
    await readSseEvents(stream, event => { events.push(event); return false; });
    expect(events).toEqual([{ data: '1' }]);
    // 提前返回必须真的取消，否则连接会一直挂着。
    expect(cancelled).toBe(true);
  });

  it('空流不产出任何事件', async () => {
    expect(await collect([])).toEqual([]);
  });
});
