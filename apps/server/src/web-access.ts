import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * 本地 Web 控制台访问防护：签名令牌 + 全局中间件。
 *
 * 背景：daemon 默认绑 0.0.0.0，同局域网任何人扫到端口即可翻全部会话记录；
 * 飞书卡片「查看详情」又是裸链接。方案（借鉴 botmux/dsh）：
 * - 启动时生成进程级 HMAC secret，落 configs 表（重启不换，旧链接继续可用）
 * - 卡片链接携带按会话签名的短期 token（?t=），首访 302 换 HttpOnly cookie
 * - 所有 /api/* 默认需要凭证，未授权一律 401（fail-closed）
 * - 会话 token 只能访问本会话资源，转发一张卡片不沦陷全库
 */

export const webAccessSecretConfigKey = 'web.access_secret';
/** 全权凭证（机器所有者）。 */
export const webAccessCookieName = 'agentdock_web';
/**
 * 会话凭证（转发出去的卡片链接）。必须与 master 分开命名：两者同叫 agentdock_web 时，
 * 打开一张卡片链接就会把控制台的全权 cookie 覆盖成会话级，此后管理面全部 403，
 * 用户看到的是「鉴权自己坏了」，而真实原因是自己的凭证被自己降级了。
 */
export const webAccessSessionCookieName = 'agentdock_web_session';
export const webAccessCookieNames = [webAccessCookieName, webAccessSessionCookieName] as const;
export const defaultSessionTokenTtlMs = 30 * 24 * 60 * 60_000;
export const defaultMasterTokenTtlMs = 365 * 24 * 60 * 60_000;

export type WebTokenKind = 'session' | 'master';
export interface VerifiedWebToken { kind: WebTokenKind; sessionId?: string; expiresAt: number }

function b64urlEncode(input: Buffer | string) { return Buffer.from(input).toString('base64url'); }

function sign(payloadB64: string, secret: string) {
  return createHmac('sha256', secret).update(payloadB64).digest('base64url');
}

function issueToken(kind: WebTokenKind, secret: string, ttlMs: number, sessionId?: string) {
  const payload = JSON.stringify({ v: 1, k: kind, sid: sessionId ?? null, exp: Date.now() + ttlMs });
  const payloadB64 = b64urlEncode(payload);
  return `${payloadB64}.${sign(payloadB64, secret)}`;
}

/** 验证签名与有效期；任何篡改/过期都返回 null。比较走 timingSafeEqual。 */
export function verifyWebToken(token: string | undefined, secret: string, now = Date.now()): VerifiedWebToken | null {
  if (!token) return null;
  const dot = token.lastIndexOf('.');
  if (dot <= 0) return null;
  const payloadB64 = token.slice(0, dot);
  const signature = token.slice(dot + 1);
  const expected = sign(payloadB64, secret);
  const signatureBuffer = Buffer.from(signature);
  const expectedBuffer = Buffer.from(expected);
  if (signatureBuffer.length !== expectedBuffer.length || !timingSafeEqual(signatureBuffer, expectedBuffer)) return null;
  let payload: { v?: number; k?: string; sid?: string | null; exp?: number };
  try { payload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8')); }
  catch { return null; }
  if (payload.v !== 1 || typeof payload.exp !== 'number' || payload.exp <= now) return null;
  if (payload.k === 'master') return { kind: 'master', expiresAt: payload.exp };
  if (payload.k === 'session' && typeof payload.sid === 'string' && payload.sid) return { kind: 'session', sessionId: payload.sid, expiresAt: payload.exp };
  return null;
}

export function issueSessionToken(sessionId: string, secret: string, ttlMs = defaultSessionTokenTtlMs) {
  return issueToken('session', secret, ttlMs, sessionId);
}

export function issueMasterToken(secret: string, ttlMs = defaultMasterTokenTtlMs) {
  return issueToken('master', secret, ttlMs);
}

export async function loadOrCreateWebAccessSecret(configs: { get(key: string): Promise<string | undefined>; set(key: string, value: string): Promise<void> }) {
  const existing = (await configs.get(webAccessSecretConfigKey))?.trim();
  if (existing) return existing;
  const created = randomBytes(32).toString('base64url');
  await configs.set(webAccessSecretConfigKey, created);
  return created;
}

/**
 * 进程级单例：飞书卡片在 LarkService（拿不到 repos）里构造链接，
 * 由 startLocalServer 启动时注入 secret。未初始化时返回 undefined，
 * 卡片退回无 token 链接（测试与未启用场景）。
 */
interface WebAccessState { secret: string; sessionTokenTtlMs: number }
let activeState: WebAccessState | undefined;

export function initWebAccess(secret: string, sessionTokenTtlMs = defaultSessionTokenTtlMs) {
  activeState = { secret, sessionTokenTtlMs };
}

export function webAccessSessionToken(sessionId: string): string | undefined {
  if (!activeState) return undefined;
  return issueSessionToken(sessionId, activeState.secret, activeState.sessionTokenTtlMs);
}

export function parseCookieHeader(header: string | undefined, name: string): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const equals = part.indexOf('=');
    if (equals < 0) continue;
    if (part.slice(0, equals).trim() !== name) continue;
    const value = part.slice(equals + 1).trim();
    return value ? decodeURIComponent(value) : undefined;
  }
  return undefined;
}

/** 凭证该写进哪个 cookie：master 与 session 各自一个名字，互不覆盖。 */
export function webAccessCookieNameFor(kind: WebTokenKind): string {
  return kind === 'master' ? webAccessCookieName : webAccessSessionCookieName;
}

/** 回环源地址：127.0.0.0/8、::1，以及 IPv6 映射形式 ::ffff:127.0.0.1。 */
export function isLoopbackAddress(address: string | undefined): boolean {
  if (!address) return false;
  const normalized = address.toLowerCase().startsWith('::ffff:') ? address.slice(7) : address;
  if (normalized === '::1') return true;
  const parts = normalized.split('.');
  return parts.length === 4 && parts[0] === '127'
    && parts.every(part => /^\d{1,3}$/.test(part) && Number(part) <= 255);
}

/** Host 头指向本机主机名：localhost / 127.x / [::1]（可带端口）。 */
export function isLoopbackHostHeader(host: string | undefined): boolean {
  if (!host) return false;
  const name = (host.startsWith('[') ? host.slice(0, host.indexOf(']') + 1) : host.split(':')[0] ?? '').toLowerCase();
  return name === 'localhost' || name === '[::1]'
    || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(name);
}

/**
 * 是否可以把请求当作「本机所有者」直接授权。
 *
 * 为什么需要它：凭证是 cookie，cookie 按「源」隔离。localhost / 127.0.0.1 / [::1]
 * 是三个互不相通的 cookie 空间，而启动时只会打印其中一个的带凭证链接；用户换一个
 * 主机名（书签、Chrome 补全、旧链接）打开就永远 401，观感正是「cookie 有效期非常短」。
 * 局域网来源的源地址不是回环，转发出去的卡片链接防护不受影响。
 *
 * 三个条件缺一不可：
 * - 源地址回环：连接确实来自本机协议栈；
 * - Host 头也是回环名：挡 DNS rebinding——把域名解析到 127.0.0.1 后，源地址同样是
 *   回环，只信源地址等于把控制台（含终端 pty）交给任意网页；
 * - Sec-Fetch-Site 不是跨站：该头由浏览器自己填写、页面改不了。跨站页面发起的请求
 *   可以借本机回环直连 daemon，没有这一条就多出一个 CSRF 写面。缺头视为非浏览器
 *   客户端（curl 等本地进程），本来就已可信。
 */
export function isLocalOwnerRequest(input: { address?: string; host?: string; fetchSite?: string }): boolean {
  if (!isLoopbackAddress(input.address) || !isLoopbackHostHeader(input.host)) return false;
  const site = input.fetchSite?.trim().toLowerCase();
  return site === undefined || site === '' || site === 'same-origin' || site === 'none';
}

/**
 * 会话级 token 的授权面（白名单，其余一律拒绝）：
 * - /api/sessions、/api/agents 只读（SPA 会话列表/agent 展示引导需要）
 * - /api/lark/config 只读（只含 bot 名称等非密配置，App Secret 不下发；侧栏 bot 名依赖它）
 * - /api/system/capabilities 只读（SPA 首屏无条件拉取；仅含平台能力与 cwd）
 * - /api/llm 只读（只有格式/Base URL/模型名与「有没有配密钥」，密钥本身不下发；
 *   模型端点面板开会拉它，若 403 会把整页打成「访问被拒」）
 * - /api/system/skills、/api/system/update 只读（同样是 SPA 打开会话页时无条件拉取的，
 *   分别只有 cwd 下的技能清单和版本号/升级状态，都不含密钥；漏掉这一条会让「点开卡片
 *   链接」直接落到访问被拒面板，逼用户再输一次密码）
 * - /api/schedules 只读且必须带 sessionId 且等于本会话（列表不带 sessionId 会返回全部会话的
 *   定时任务，所以不做路径级放行，见下方逐参数判断）
 * - /api/sessions/:sid 及其全部子路径（含 stream/events/uploads/send）
 * 写接口与其他管理面（改配置、选目录、触发升级等）只有 master token 能进。
 */
export function sessionTokenAllows(method: string, pathname: string, sessionId: string, search?: URLSearchParams): boolean {
  if (pathname === `/api/sessions/${sessionId}` || pathname.startsWith(`/api/sessions/${sessionId}/`)) return true;
  if (method !== 'GET' && method !== 'HEAD') return false;
  if (pathname === '/api/schedules') return search?.get('sessionId') === sessionId;
  return pathname === '/api/sessions' || pathname.startsWith('/api/agents')
    || pathname === '/api/lark/config' || pathname === '/api/system/capabilities'
    || pathname === '/api/system/skills' || pathname === '/api/system/update'
    || pathname === '/api/llm';
}
