import { promisify } from 'node:util';
import { brotliCompress, constants, gzip } from 'node:zlib';
import type { FastifyInstance } from 'fastify';

const brotli = promisify(brotliCompress);
const gzipAsync = promisify(gzip);

/** 小于这个体积的 JSON 不压：省下的字节抵不过一次线程池往返，轮询类小接口原样回。 */
export const JSON_COMPRESSION_THRESHOLD = 32 * 1024;

/**
 * 按 Accept-Encoding 选编码：brotli 优先，gzip 兜底；`q=0` 表示明确不接受。
 * `*` 视同两者都接受。都不接受时返回 undefined，响应原样发出。
 */
export function pickJsonEncoding(header: string | string[] | undefined): 'br' | 'gzip' | undefined {
  const accepted = new Map<string, number>();
  for (const part of (Array.isArray(header) ? header.join(',') : header ?? '').split(',')) {
    const [name, ...params] = part.trim().toLowerCase().split(';');
    if (!name) continue;
    const q = params.map(param => param.trim()).find(param => param.startsWith('q='));
    accepted.set(name, q ? Number(q.slice(2)) || 0 : 1);
  }
  const allows = (name: string) => (accepted.get(name) ?? accepted.get('*') ?? 0) > 0;
  if (allows('br')) return 'br';
  if (allows('gzip')) return 'gzip';
  return undefined;
}

/**
 * 大 JSON 响应按 Accept-Encoding 压缩。
 *
 * 重会话打开一次时间线就是一份几十 MB 的 JSON（实测 30 万行事件合并后 4.9 万条、27.9 MB），
 * 经 Cloudflare 隧道远程打开要 15～87 秒；本机打开只要两百毫秒，差的全是传输。这类 JSON
 * 满是重复的键、id 与时间戳，brotli q4 压到 3.8 MB（7.4 倍），耗时约 90 ms，且在 libuv
 * 线程池里跑，不占事件循环。q4 而不是默认的 q11：后者对几十 MB 要秒级，换来的体积差不到两成。
 *
 * 只处理已经序列化好的字符串 / Buffer。SSE、流式 JSON 数组、文件下载都是流，原样放过——
 * 给流套压缩会让 SSE 被缓冲，实时性全失。
 */
export function registerJsonCompression(app: FastifyInstance, threshold = JSON_COMPRESSION_THRESHOLD) {
  app.addHook('onSend', async (request, reply, payload) => {
    if (typeof payload !== 'string' && !Buffer.isBuffer(payload)) return payload;
    if (reply.hasHeader('content-encoding')) return payload;
    if (!String(reply.getHeader('content-type') ?? '').toLowerCase().includes('application/json')) return payload;
    const size = Buffer.byteLength(payload);
    if (size < threshold) return payload;
    const encoding = pickJsonEncoding(request.headers['accept-encoding']);
    if (!encoding) return payload;
    const body = encoding === 'br'
      ? await brotli(payload, { params: { [constants.BROTLI_PARAM_MODE]: constants.BROTLI_MODE_TEXT, [constants.BROTLI_PARAM_QUALITY]: 4, [constants.BROTLI_PARAM_SIZE_HINT]: size } })
      : await gzipAsync(payload, { level: 6 });
    reply.header('content-encoding', encoding);
    const vary = String(reply.getHeader('vary') ?? '');
    if (!/(^|,)\s*accept-encoding\s*(,|$)/i.test(vary)) reply.header('vary', vary ? `${vary}, Accept-Encoding` : 'Accept-Encoding');
    // 长度交给 Fastify 按压缩后的 Buffer 重算；留着旧值，浏览器会按原始长度等数据、一直挂着。
    reply.removeHeader('content-length');
    return body;
  });
}
