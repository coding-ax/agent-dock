import type { FastifyInstance } from 'fastify';
import type { NetworkInterfaceInfo } from 'node:os';
import { RuntimeError, type ConfigRepository } from '@agent-dock/agent-dock-shared';
import { accessUrls } from './access-urls.js';
import { defaultMasterTokenTtlMs, issueMasterToken } from './web-access.js';

/**
 * 应用级扫码链接。
 *
 * 手机扫到的是启动输出里同类的 master 令牌（不是会话级令牌）：通过 `?t=` 交换
 * HttpOnly cookie 后，手机可以像本机控制台一样自由操作 AgentDock——查看所有会话、
 * 切换设置、管理 Agent。因此二维码等同于控制台登录凭证，界面必须明确提示不要外传。
 *
 * 地址来源分两类：
 * - 局域网：复用 accessUrls 的网卡扫描，但去掉回环入口（手机连不到 127.0.0.1）。
 * - 公网：用户自己配的 https 基址（Cloudflare Tunnel / 其他反代）。AgentDock 不自动
 *   开公网隧道——隧道必须由用户在前面配好身份验证（如 Cloudflare Access），否则
 *   仅靠 URL 里的 master 令牌挡公网扫描器过于单薄。
 */

export const publicUrlConfigKey = 'web.public_url';

export type ShareLinkKind = 'hostname' | 'lan-v4' | 'lan-v6' | 'public';

export interface ShareLinkUrl {
  kind: ShareLinkKind;
  label: string;
  url: string;
}

export interface ShareLinkResult {
  sessionId?: string;
  expiresAt: number;
  urls: ShareLinkUrl[];
  /** 已配置的公网基址；没有就是 undefined。 */
  publicUrl?: string;
  /** 公网基址来自环境变量时，设置面板只读。 */
  publicUrlSource?: 'env' | 'config';
  /** 服务只绑了回环：桌面端需要先开启局域网访问，局域网候选才会出现。 */
  lanEnabled: boolean;
}

export interface ShareSettings {
  publicUrl?: string;
  publicUrlSource?: 'env' | 'config';
  /** 环境变量已锁定公网地址时，界面不要再让用户改。 */
  envLocked: boolean;
}

export interface ShareLinkServiceOptions {
  host: string;
  port: number;
  secret: string;
  /** 扫码令牌有效期；默认与启动输出里的控制台链接一致。 */
  masterTokenTtlMs?: number;
  config?: ConfigRepository;
  env?: NodeJS.ProcessEnv;
  /** 便于单测注入。 */
  interfaces?: NodeJS.Dict<NetworkInterfaceInfo[]>;
  hostname?: string;
  now?: () => number;
}

const labels: Record<ShareLinkKind, string> = {
  hostname: '主机名',
  'lan-v4': '局域网 IPv4',
  'lan-v6': '局域网 IPv6',
  public: '公网'
};

/** 只接受 https 源站；路径前缀不支持——SPA 的静态资源和 /api 都挂在根路径，子路径部署会白屏。 */
export function normalizePublicUrl(raw: string | undefined): string | undefined {
  const value = raw?.trim();
  if (!value) return undefined;
  let url: URL;
  try { url = new URL(value); } catch { return undefined; }
  if (url.protocol !== 'https:') return undefined;
  if (url.username || url.password) return undefined;
  if (!url.hostname) return undefined;
  if (url.pathname !== '/' && url.pathname !== '') return undefined;
  url.search = '';
  url.hash = '';
  return url.origin;
}

function bindsLan(host: string): boolean {
  return host !== '127.0.0.1' && host !== '::1' && host.toLowerCase() !== 'localhost';
}

export class ShareLinkService {
  private readonly now: () => number;

  constructor(private readonly options: ShareLinkServiceOptions) {
    this.now = options.now ?? Date.now;
  }

  get lanEnabled(): boolean {
    return bindsLan(this.options.host);
  }

  private async storedPublicUrl(): Promise<{ url: string; source: 'env' | 'config' } | undefined> {
    // 环境变量优先：容器/CI 里配死地址，不让界面改出一个和实际入口不一致的链接。
    const fromEnv = normalizePublicUrl(this.options.env?.AGENTDOCK_PUBLIC_URL);
    if (fromEnv) return { url: fromEnv, source: 'env' };
    const stored = normalizePublicUrl(await this.options.config?.get(publicUrlConfigKey));
    return stored ? { url: stored, source: 'config' } : undefined;
  }

  async settings(): Promise<ShareSettings> {
    const publicUrl = await this.storedPublicUrl();
    return {
      ...(publicUrl ? { publicUrl: publicUrl.url, publicUrlSource: publicUrl.source } : {}),
      envLocked: Boolean(normalizePublicUrl(this.options.env?.AGENTDOCK_PUBLIC_URL))
    };
  }

  /** 空串表示清除。非字符串或非 https 地址一律 400，避免把明文 http 公网地址写进二维码。 */
  async savePublicUrl(raw: unknown): Promise<ShareSettings> {
    if (typeof raw !== 'string') throw new RuntimeError('INVALID_PUBLIC_URL', 'publicUrl 必须是字符串', 400);
    const trimmed = raw.trim();
    if (!trimmed) {
      await this.options.config?.set(publicUrlConfigKey, '');
      return this.settings();
    }
    const normalized = normalizePublicUrl(trimmed);
    if (!normalized) throw new RuntimeError('INVALID_PUBLIC_URL', '公网地址必须是无用户名密码的 https:// 地址，例如 https://dock.example.com', 400);
    await this.options.config?.set(publicUrlConfigKey, normalized);
    return this.settings();
  }

  async build(sessionId?: string): Promise<ShareLinkResult> {
    if (!this.options.secret) {
      throw new RuntimeError('SHARE_LINK_DISABLED', '本地 Web 访问防护未开启，无法签发扫码链接。桌面客户端请在「在手机上打开」里开启局域网访问；命令行请去掉 AGENTDOCK_WEB_AUTH=off。', 409);
    }
    const token = issueMasterToken(this.options.secret, this.options.masterTokenTtlMs ?? defaultMasterTokenTtlMs);
    const query = `?t=${encodeURIComponent(token)}`;
    // 应用级入口默认落到首页；带 sessionId 时仍然直接打开那个会话，方便从会话里发起扫码。
    const suffix = `${sessionId ? `/sessions/${encodeURIComponent(sessionId)}` : '/'}${query}`;

    const urls: ShareLinkUrl[] = accessUrls({
      host: this.options.host,
      port: this.options.port,
      ...(this.options.interfaces ? { interfaces: this.options.interfaces } : {}),
      ...(this.options.hostname ? { hostname: this.options.hostname } : {})
    })
      // 回环地址是给本机浏览器用的，手机上必然打不开。
      .filter(entry => entry.kind !== 'local')
      .map(entry => ({ kind: entry.kind as Exclude<ShareLinkKind, 'public'>, label: labels[entry.kind as Exclude<ShareLinkKind, 'public'>], url: `${entry.url.replace(/\/$/, '')}${suffix}` }));

    const publicUrl = await this.storedPublicUrl();
    if (publicUrl) urls.push({ kind: 'public', label: labels.public, url: `${publicUrl.url}${suffix}` });

    return {
      ...(sessionId ? { sessionId } : {}),
      expiresAt: this.now() + (this.options.masterTokenTtlMs ?? defaultMasterTokenTtlMs),
      urls,
      ...(publicUrl ? { publicUrl: publicUrl.url, publicUrlSource: publicUrl.source } : {}),
      lanEnabled: this.lanEnabled
    };
  }
}

interface ShareLinkRuntime {
  getSession(id: string): Promise<{ id: string } | undefined>;
}

/**
 * 注册扫码链接接口。
 *
 * 路径故意放在 `/api/system/` 下且不在 sessionTokenAllows 白名单里：只有 master
 * 凭证能生成新令牌。生成的链接本身也是 master 令牌——手机扫一次即可操作整个
 * 控制台，因此界面上必须按「登录凭证」的级别提示用户不要转发。
 */
export function registerShareLinkRoutes(app: FastifyInstance, service: ShareLinkService, runtime: ShareLinkRuntime) {
  app.get<{ Querystring: { sessionId?: string } }>('/api/system/share-link', async (request, reply) => {
    const sessionId = request.query.sessionId?.trim() || undefined;
    // 带 sessionId 时校验会话存在，避免二维码指向一个已删除的会话；不带则是纯应用级入口。
    if (sessionId && !(await runtime.getSession(sessionId))) throw new RuntimeError('SESSION_NOT_FOUND', `Session not found: ${sessionId}`, 404);
    // 带凭证的链接不能被中间缓存留存。
    reply.header('cache-control', 'no-store');
    return service.build(sessionId);
  });
  app.get('/api/system/share-settings', async (_request, reply) => {
    reply.header('cache-control', 'no-store');
    return service.settings();
  });
  app.put<{ Body: { publicUrl?: unknown } }>('/api/system/share-settings', async (request, reply) => {
    reply.header('cache-control', 'no-store');
    return service.savePublicUrl(request.body?.publicUrl);
  });
}
