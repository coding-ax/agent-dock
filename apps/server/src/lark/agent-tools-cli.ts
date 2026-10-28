import type { AgentGroupCliOptions } from '../cli-program.js';

interface GroupToolErrorBody {
  code: string;
  message: string;
  instruction?: string;
  authorizationUrl?: string;
  requiredScopes?: string[];
  [key: string]: unknown;
}

export class AgentGroupToolCliError extends Error {
  constructor(public readonly error: GroupToolErrorBody, public readonly statusCode?: number) {
    super(error.message);
    this.name = 'AgentGroupToolCliError';
  }
}

interface GroupToolClientOptions {
  env?: NodeJS.ProcessEnv;
  fetcher?: typeof globalThis.fetch;
  /**
   * 环境变量里没有凭证时，按会话 ID 向本机 daemon 换取。
   * 会话中途才托管到飞书群时，Agent 进程早已启动，环境变量不会自动补上。
   */
  exchangeCapability?: (sessionId: string) => Promise<{ url: string; token: string } | undefined>;
}

const contextRequired = (detail?: string) => new AgentGroupToolCliError({
  code: 'GROUP_TOOL_CONTEXT_REQUIRED',
  message: `群协作工具只能由 AgentDock 飞书群会话内的 Agent 调用；当前进程没有会话 capability。${detail ? `（${detail}）` : ''}`
});

/** 默认换取方式：用 daemon 状态里的本机地址与访问凭证调 /api/sessions/:id/group-tools-capability。 */
async function exchangeViaDaemon(sessionId: string) {
  const { requireDaemon, callDaemon } = await import('../session-cli.js');
  const result = await callDaemon<{ agentdock_group_tools_url?: string; agentdock_group_tools_token?: string }>(
    requireDaemon(), `/api/sessions/${encodeURIComponent(sessionId)}/group-tools-capability`, 'POST'
  );
  return result.agentdock_group_tools_url && result.agentdock_group_tools_token
    ? { url: result.agentdock_group_tools_url, token: result.agentdock_group_tools_token }
    : undefined;
}

class AgentGroupToolHttpClient {
  private baseUrl: string;
  private token: string;
  private readonly sessionId: string;
  private readonly fetcher: typeof globalThis.fetch;
  private readonly exchange: (sessionId: string) => Promise<{ url: string; token: string } | undefined>;

  constructor(options: GroupToolClientOptions = {}) {
    const env = options.env ?? process.env;
    this.baseUrl = (env.agentdock_group_tools_url ?? env.AGENTDOCK_GROUP_TOOLS_URL)?.trim().replace(/\/$/, '') ?? '';
    this.token = (env.agentdock_group_tools_token ?? env.AGENTDOCK_GROUP_TOOLS_TOKEN)?.trim() ?? '';
    this.sessionId = env.agentdock_session_id?.trim() ?? '';
    this.fetcher = options.fetcher ?? globalThis.fetch;
    this.exchange = options.exchangeCapability ?? exchangeViaDaemon;
    if ((!this.baseUrl || !this.token) && !this.sessionId) throw contextRequired();
  }

  private async ensureCapability() {
    if (this.baseUrl && this.token) return;
    let issued: { url: string; token: string } | undefined;
    try { issued = await this.exchange(this.sessionId); }
    catch (error) { throw contextRequired(error instanceof Error ? error.message : String(error)); }
    if (!issued) throw contextRequired();
    this.baseUrl = issued.url.trim().replace(/\/$/, '');
    this.token = issued.token.trim();
  }

  async request(path: string, init: RequestInit = {}) {
    await this.ensureCapability();
    let response: Response;
    try {
      const headers = new Headers(init.headers);
      headers.set('authorization', `Bearer ${this.token}`);
      if (init.body !== undefined) headers.set('content-type', 'application/json; charset=utf-8');
      response = await this.fetcher(`${this.baseUrl}${path}`, {
        ...init,
        headers
      });
    } catch (error) {
      throw new AgentGroupToolCliError({
        code: 'GROUP_TOOL_UNAVAILABLE',
        message: `无法连接 AgentDock 群协作服务：${error instanceof Error ? error.message : String(error)}`
      });
    }
    const payload = await response.json().catch(() => ({})) as { error?: GroupToolErrorBody } & Record<string, unknown>;
    if (!response.ok) {
      throw new AgentGroupToolCliError(payload.error ?? {
        code: 'GROUP_TOOL_REQUEST_FAILED',
        message: `AgentDock 群协作服务返回 HTTP ${response.status}`
      }, response.status);
    }
    return payload;
  }
}

const queryPath = (path: string, options: AgentGroupCliOptions) => {
  const query = new URLSearchParams();
  if (options.after) query.set('after', options.after);
  if (options.limit) query.set('limit', options.limit);
  if (options.timeoutMs) query.set('timeoutMs', options.timeoutMs);
  return query.size ? `${path}?${query}` : path;
};

export function runGroupSelf(options: GroupToolClientOptions = {}) {
  return new AgentGroupToolHttpClient(options).request('/self');
}

export function runGroupPeers(options: GroupToolClientOptions = {}) {
  return new AgentGroupToolHttpClient(options).request('/peers');
}

export function runGroupMembers(options: GroupToolClientOptions = {}) {
  return new AgentGroupToolHttpClient(options).request('/members');
}

export function runGroupBots(options: GroupToolClientOptions = {}) {
  return new AgentGroupToolHttpClient(options).request('/bots');
}

export function runGroupMessages(cliOptions: AgentGroupCliOptions, options: GroupToolClientOptions = {}) {
  return new AgentGroupToolHttpClient(options).request(queryPath('/messages', cliOptions));
}

export function runGroupMessage(messageId: string, options: GroupToolClientOptions = {}) {
  const query = new URLSearchParams({ messageId });
  return new AgentGroupToolHttpClient(options).request(`/message?${query}`);
}

export function runGroupWait(cliOptions: AgentGroupCliOptions, options: GroupToolClientOptions = {}) {
  return new AgentGroupToolHttpClient(options).request(queryPath('/wait', cliOptions));
}

export function runGroupSend(content: string, cliOptions: AgentGroupCliOptions, options: GroupToolClientOptions = {}) {
  return new AgentGroupToolHttpClient(options).request('/send', {
    method: 'POST',
    body: JSON.stringify({
      content,
      ...(cliOptions.to ? { to: cliOptions.to } : {}),
      ...(cliOptions.replyTo ? { replyTo: cliOptions.replyTo } : {}),
      ...(cliOptions.inThread ? { inThread: true } : {}),
      ...(cliOptions.idempotencyKey ? { idempotencyKey: cliOptions.idempotencyKey } : {})
    })
  });
}

export function runGroupReplyMode(mode: string, options: GroupToolClientOptions = {}) {
  return new AgentGroupToolHttpClient(options).request('/reply-mode', {
    method: 'POST',
    body: JSON.stringify({ mode })
  });
}
