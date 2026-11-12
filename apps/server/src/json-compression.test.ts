import { Readable } from 'node:stream';
import { brotliDecompressSync, gunzipSync } from 'node:zlib';
import Fastify from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { pickJsonEncoding, registerJsonCompression } from './json-compression.js';

// 重复的键与 id 让它像真实的事件数组一样好压。
const bigEvents = Array.from({ length: 2_000 }, (_, index) => ({ id: `evt_${index}`, sessionId: 'ses_1', sequence: index + 1, type: 'tool_call', timestamp: '2026-11-11T08:56:22.444Z', data: { id: `call_${index}`, status: 'running', name: 'tool call' } }));

async function server() {
  const app = Fastify();
  registerJsonCompression(app);
  app.get('/big', async () => bigEvents);
  app.get('/small', async () => ({ ok: true }));
  app.get('/text', async (_request, reply) => reply.type('text/plain').send('x'.repeat(100_000)));
  app.get('/stream', async (_request, reply) => reply.type('application/json').send(Readable.from([JSON.stringify(bigEvents)])));
  await app.ready();
  return app;
}

describe('registerJsonCompression', () => {
  let app: Awaited<ReturnType<typeof server>> | undefined;
  afterEach(async () => { await app?.close(); app = undefined; });

  it('大 JSON 按 Accept-Encoding 压缩，解压后与原文一致', async () => {
    app = await server();
    const br = await app.inject({ method: 'GET', url: '/big', headers: { 'accept-encoding': 'gzip, deflate, br' } });
    expect(br.headers['content-encoding']).toBe('br');
    expect(br.headers.vary).toMatch(/accept-encoding/i);
    expect(Number(br.headers['content-length'])).toBe(br.rawPayload.length);
    expect(JSON.parse(brotliDecompressSync(br.rawPayload).toString('utf8'))).toEqual(bigEvents);
    expect(br.rawPayload.length).toBeLessThan(JSON.stringify(bigEvents).length / 5);

    const gz = await app.inject({ method: 'GET', url: '/big', headers: { 'accept-encoding': 'gzip' } });
    expect(gz.headers['content-encoding']).toBe('gzip');
    expect(JSON.parse(gunzipSync(gz.rawPayload).toString('utf8'))).toEqual(bigEvents);
  });

  it('客户端没声明支持、小响应、非 JSON、流式响应都原样发出', async () => {
    app = await server();
    const plain = await app.inject({ method: 'GET', url: '/big' });
    expect(plain.headers['content-encoding']).toBeUndefined();
    expect(plain.json()).toEqual(bigEvents);
    for (const url of ['/small', '/text', '/stream']) {
      const response = await app.inject({ method: 'GET', url, headers: { 'accept-encoding': 'br, gzip' } });
      expect(response.headers['content-encoding'], url).toBeUndefined();
    }
  });
});

describe('pickJsonEncoding', () => {
  it('brotli 优先，gzip 兜底，q=0 表示不接受', () => {
    expect(pickJsonEncoding('gzip, deflate, br')).toBe('br');
    expect(pickJsonEncoding('gzip')).toBe('gzip');
    expect(pickJsonEncoding('br;q=0, gzip;q=0.8')).toBe('gzip');
    expect(pickJsonEncoding('BR')).toBe('br');
    expect(pickJsonEncoding('*')).toBe('br');
    expect(pickJsonEncoding('*, br;q=0')).toBe('gzip');
    expect(pickJsonEncoding('identity')).toBeUndefined();
    expect(pickJsonEncoding(undefined)).toBeUndefined();
    expect(pickJsonEncoding('')).toBeUndefined();
  });
});
