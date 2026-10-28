import type { LarkConfig } from './api';

export type RegistrationResult = { appId: string; appName: string; warning?: string; config: LarkConfig };
export type RegistrationProgress =
  | { kind: 'starting' }
  | { kind: 'waiting'; url: string; expiresAt: number; slow: boolean }
  | { kind: 'saving' };

/** POST SSE：处理 UTF-8 / 换行跨 chunk、心跳、服务端错误与意外断流。 */
export async function registerLarkBot(signal: AbortSignal, progress: (value: RegistrationProgress) => void, fetcher = fetch): Promise<RegistrationResult> {
  const response = await fetcher('/api/lark/bot/oneclick', { method: 'POST', signal, headers: { Accept: 'text/event-stream' } });
  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    throw new Error(data.error?.message ?? `创建请求失败（${response.status}）`);
  }
  if (!response.body || !response.headers.get('content-type')?.includes('text/event-stream')) throw new Error('服务未返回扫码进度，请刷新页面后重试。');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let waiting: Extract<RegistrationProgress, { kind: 'waiting' }> | undefined;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) throw new Error('扫码连接已断开。请先刷新机器人列表，确认是否已创建，再重试。');
      buffer += decoder.decode(value, { stream: true });
      let match: RegExpExecArray | null;
      while ((match = /\r?\n\r?\n/.exec(buffer))) {
        const frame = buffer.slice(0, match.index);
        buffer = buffer.slice(match.index + match[0].length);
        const lines = frame.split(/\r?\n/);
        const event = lines.find(line => line.startsWith('event:'))?.slice(6).trim();
        const raw = lines.filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
        if (!raw || !event || event === 'heartbeat' || event === 'connected') continue;
        const data = JSON.parse(raw);
        if (event === 'error') throw new Error(data.message || '创建未完成，请重试。');
        if (event === 'qrcode') {
          const url = new URL(data.url);
          if (url.protocol !== 'https:' || !Number.isFinite(data.expireIn) || data.expireIn <= 0) throw new Error('二维码信息无效，请重新生成。');
          waiting = { kind: 'waiting', url: url.href, expiresAt: Date.now() + data.expireIn * 1000, slow: false };
          progress(waiting);
        }
        if (event === 'status') {
          if (data.status === 'saving') progress({ kind: 'saving' });
          else if (waiting) { waiting = { ...waiting, slow: data.status === 'slow_down' }; progress(waiting); }
        }
        if (event === 'success') {
          if (typeof data.appId !== 'string' || !data.config?.bots?.some((bot: { appId: string }) => bot.appId === data.appId)) throw new Error('创建结果不完整，请刷新机器人列表确认。');
          return data as RegistrationResult;
        }
      }
      if (buffer.length > 1_000_000) throw new Error('扫码进度响应异常，请重试。');
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
