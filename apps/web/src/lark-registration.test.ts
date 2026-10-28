import { describe, expect, it, vi } from 'vitest';
import { registerLarkBot } from './lark-registration';
const result = { appId: 'cli_test', appName: '中文机器人', config: { bots: [{ appId: 'cli_test' }], listeningDisabled: false } };
function stream(text: string, chunkSize = 1): typeof fetch {
  const bytes = new TextEncoder().encode(text);
  return vi.fn(async () => new Response(new ReadableStream({ start(controller) {
    for (let offset = 0; offset < bytes.length; offset += chunkSize) controller.enqueue(bytes.slice(offset, offset + chunkSize));
    controller.close();
  } }), { headers: { 'content-type': 'text/event-stream' } })) as typeof fetch;
}
const frame = (event: string, data: unknown) => `event: ${event}\r\ndata: ${JSON.stringify(data)}\r\n\r\n`;
describe('registration SSE client', () => {
  it('handles split UTF-8, CRLF, heartbeats and terminal success', async () => {
    const progress = vi.fn();
    const fetcher = stream(frame('heartbeat', {}) + frame('qrcode', { url: 'https://open.feishu.cn/scan', expireIn: 60 }) + frame('status', { status: 'slow_down' }) + frame('success', result));
    await expect(registerLarkBot(new AbortController().signal, progress, fetcher)).resolves.toEqual(result);
    expect(progress).toHaveBeenLastCalledWith(expect.objectContaining({ kind: 'waiting', slow: true }));
  });
  it('detects premature EOF and surfaces server errors', async () => {
    await expect(registerLarkBot(new AbortController().signal, vi.fn(), stream(frame('heartbeat', {})))).rejects.toThrow('连接已断开');
    await expect(registerLarkBot(new AbortController().signal, vi.fn(), stream(frame('error', { message: '二维码已过期' })))).rejects.toThrow('二维码已过期');
  });
  it('rejects unsafe authorization links and invalid success payloads', async () => {
    await expect(registerLarkBot(new AbortController().signal, vi.fn(), stream(frame('qrcode', { url: 'javascript:alert(1)', expireIn: 60 })))).rejects.toThrow('二维码信息无效');
    await expect(registerLarkBot(new AbortController().signal, vi.fn(), stream(frame('success', { appId: 'cli_missing' })))).rejects.toThrow('创建结果不完整');
  });
  it('reports HTTP conflicts without attempting to parse an SSE stream', async () => {
    const fetcher = vi.fn(async () => Response.json({ error: { message: '已有扫码流程' } }, { status: 409 })) as typeof fetch;
    await expect(registerLarkBot(new AbortController().signal, vi.fn(), fetcher)).rejects.toThrow('已有扫码流程');
  });
});
