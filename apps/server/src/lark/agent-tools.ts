import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import type { ConfigRepository, Session, SessionRepository } from '@agent-dock/agent-dock-shared';
import { parseLarkMessageContent } from './message-content.js';
import { readLarkConfig, readLarkConfigs, type StoredLarkConfig } from './config.js';
import {
  createLarkCardService,
  LarkServiceError,
  type LarkBotInfo,
  type LarkCardService,
  type LarkChatMember,
  type LarkChatMessage,
  type LarkChatMessagesInput,
  type LarkMessageResult
} from './service.js';

const groupToolPath = '/api/lark/agent-tools';
export const groupToolsSigningSecretConfigKey = 'lark.group_tools.signing_secret';
const maxMessageLimit = 50;
const maxWaitTimeoutMs = 30_000;

export interface LarkAgentSessionBinding { sessionId: string; appId: string; chatId: string; chatType: 'group' | 'p2p'; threadId?: string }

export function larkAgentSessionBinding(session: Pick<Session, 'id' | 'source' | 'sourceId'>): LarkAgentSessionBinding | undefined {
  if (session.source !== 'lark' || !session.sourceId) return;
  const parts = session.sourceId.split(':');
  if (parts.length < 3) return;
  const appId = parts[0]!;
  const chatId = parts[1]!;
  const chatType = parts[2];
  if (!appId.startsWith('cli_')) return;
  // 群聊 chatId 以 oc_ 开头；私聊（p2p）chatId 为对方 open_id，以 ou_ 开头。
  if (chatType === 'group') {
    if (!chatId.startsWith('oc_')) return;
    // sourceId 格式：${appId}:${chatId}:group:${scopeId}
    // scopeId 可能是 thread:${threadId}、user:${openId} 或 message:${messageId}
    const scopeType = parts[3];
    const threadId = scopeType === 'thread' ? parts[4] : undefined;
    return { sessionId: session.id, appId, chatId, chatType: 'group', ...(threadId ? { threadId } : {}) };
  }
  if (chatType === 'p2p') {
    if (!chatId.startsWith('ou_')) return;
    return { sessionId: session.id, appId, chatId, chatType: 'p2p' };
  }
  return;
}

export class AgentGroupToolError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly statusCode = 400,
    public readonly details?: Record<string, unknown>
  ) {
    super(message);
    this.name = 'AgentGroupToolError';
  }

  response() {
    return { error: { ...this.details, code: this.code, message: this.message } };
  }
}

type Capability = LarkAgentSessionBinding & { token: string };

/** 托管会话的群绑定查询：会话不是飞书发起的，绑定只在 channel_mappings 里。 */
export type LarkHandoverLookup = (sessionId: string) => Promise<{ appId: string; chatId: string } | undefined>;

export class LarkAgentToolCapabilityRegistry {
  private readonly byToken = new Map<string, Capability>();
  private readonly bySession = new Map<string, Capability>();
  private handoverLookup?: LarkHandoverLookup;

  constructor(
    private readonly sessions: SessionRepository,
    private readonly apiBaseUrl: string,
    private readonly signingSecret = randomBytes(32).toString('base64url')
  ) {}

  /** 接入托管绑定。未接入时只认飞书发起的会话（sourceId 解析）。 */
  useHandoverLookup(lookup: LarkHandoverLookup) {
    this.handoverLookup = lookup;
  }

  private tokenFor(binding: LarkAgentSessionBinding) {
    const digest = createHmac('sha256', this.signingSecret)
      .update(`agentdock-group-tools-v1\0${binding.sessionId}\0${binding.appId}\0${binding.chatId}`)
      .digest('base64url');
    return `v1.${digest}`;
  }

  /** 会话当前的群绑定：飞书发起的会话看 sourceId，其它会话看是否被托管到某个群。 */
  async bindingFor(session: Session): Promise<LarkAgentSessionBinding | undefined> {
    const direct = larkAgentSessionBinding(session);
    if (direct || session.source === 'lark' || !this.handoverLookup) return direct;
    const handover = await this.handoverLookup(session.id);
    return handover ? { sessionId: session.id, appId: handover.appId, chatId: handover.chatId, chatType: 'group' } : undefined;
  }

  private register(binding: LarkAgentSessionBinding): Record<string, string> {
    const existing = this.bySession.get(binding.sessionId);
    const capability = existing?.appId === binding.appId && existing.chatId === binding.chatId
      ? existing
      : { ...binding, token: this.tokenFor(binding) };
    if (existing && existing !== capability) this.byToken.delete(existing.token);
    this.bySession.set(binding.sessionId, capability);
    this.byToken.set(capability.token, capability);
    return {
      agentdock_group_tools_url: `${this.apiBaseUrl.replace(/\/$/, '')}${groupToolPath}`,
      agentdock_group_tools_token: capability.token
    };
  }

  /** Agent 进程启动时注入的环境变量（同步，只覆盖飞书发起的会话）。 */
  environmentFor(session: Session): Record<string, string> {
    const binding = larkAgentSessionBinding(session);
    return binding ? this.register(binding) : {};
  }

  /**
   * 按会话 ID 现场签发凭证。会话中途才托管到群（进程早已启动、环境变量里没有凭证）时，
   * CLI 用 agentdock_session_id 来换。调用方必须已通过本机访问鉴权。
   */
  async issueFor(sessionId: string): Promise<Record<string, string>> {
    const session = await this.sessions.get(sessionId);
    if (!session || session.archivedAt || ['failed', 'stopped'].includes(session.state)) {
      throw new AgentGroupToolError('GROUP_TOOL_SESSION_EXPIRED', '当前 AgentDock 会话不存在或已结束。', 404);
    }
    const binding = await this.bindingFor(session);
    if (!binding) throw new AgentGroupToolError('GROUP_TOOL_CONTEXT_REQUIRED', '当前会话没有绑定飞书群，群协作工具不可用。', 404);
    return this.register(binding);
  }

  async resolve(token: string | undefined): Promise<LarkAgentSessionBinding> {
    const capability = token ? this.byToken.get(token) : undefined;
    if (!capability) throw new AgentGroupToolError('GROUP_TOOL_UNAUTHORIZED', '群协作工具凭证缺失或无效。该工具只能在 AgentDock 飞书会话内使用。', 401);
    const session = await this.sessions.get(capability.sessionId);
    const binding = session ? await this.bindingFor(session) : undefined;
    if (!session || !binding || binding.appId !== capability.appId || binding.chatId !== capability.chatId || session.archivedAt || ['failed', 'stopped'].includes(session.state)) {
      throw new AgentGroupToolError('GROUP_TOOL_SESSION_EXPIRED', '当前 AgentDock 飞书会话已结束，群协作工具凭证不再有效。', 401);
    }
    return binding;
  }

  close() {
    this.byToken.clear();
    this.bySession.clear();
  }
}

export async function loadOrCreateGroupToolsSigningSecret(configs: ConfigRepository) {
  const existing = (await configs.get(groupToolsSigningSecretConfigKey))?.trim();
  if (existing) return existing;
  const created = randomBytes(32).toString('base64url');
  await configs.set(groupToolsSigningSecretConfigKey, created);
  return created;
}

export interface LarkGroupToolClient {
  getBotInfo(): Promise<LarkBotInfo>;
  listChatMembers(input: { chatId: string; memberTypes?: Array<'user' | 'bot'>; pageSize?: number; pageToken?: string }): Promise<{ items: LarkChatMember[]; hasMore: boolean; pageToken?: string; securityLimited: boolean }>;
  listChatMessages(input: LarkChatMessagesInput): Promise<{ items: LarkChatMessage[]; hasMore: boolean; pageToken?: string }>;
  getMessage(messageId: string): Promise<LarkChatMessage>;
  getMessageItems(messageId: string): Promise<LarkChatMessage[]>;
  sendText(input: { chatId: string; text: string; idempotencyKey?: string }): Promise<LarkMessageResult>;
  replyText(input: { messageId: string; text: string; replyInThread?: boolean; idempotencyKey?: string }): Promise<LarkMessageResult>;
  sendPost(input: { chatId: string; content: unknown; idempotencyKey?: string }): Promise<LarkMessageResult>;
  replyPost(input: { messageId: string; content: unknown; replyInThread?: boolean; idempotencyKey?: string }): Promise<LarkMessageResult>;
  uploadImage(bytes: Uint8Array, filename?: string): Promise<string>;
  sendImage(input: { chatId: string; imageKey: string; idempotencyKey?: string }): Promise<LarkMessageResult>;
  replyImage(input: { messageId: string; imageKey: string; replyInThread?: boolean; idempotencyKey?: string }): Promise<LarkMessageResult>;
}

export interface LarkAgentToolsOptions {
  env?: NodeJS.ProcessEnv;
  fetcher?: typeof globalThis.fetch;
  clientFactory?: (config: StoredLarkConfig) => LarkGroupToolClient;
  pollIntervalMs?: number;
  groupToolsCommand?: string;
}

type ToolContext = LarkAgentSessionBinding & { config: StoredLarkConfig; client: LarkGroupToolClient };
export interface AgentGroupPeer { appId: string; name: string; agentId?: string; memberId: string; openId?: string }
export interface AgentGroupMember { name: string; memberId: string; openId?: string }
export interface AgentGroupMessage {
  messageId: string;
  messageType: string;
  createTime: string;
  sender: LarkChatMessage['sender'];
  content: string;
  mentions: LarkChatMessage['mentions'];
  deleted: boolean;
  updated: boolean;
  threadId?: string;
}
export interface AgentGroupMessagesResult { chatId: string; messages: AgentGroupMessage[]; cursor?: string; timedOut?: boolean }

class GroupMessageCursor {
  private constructor(readonly createTime: number, readonly messageId: string) {}

  static parse(value?: string) {
    if (!value) return undefined;
    try {
      const decoded = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as { v?: number; t?: number; id?: string };
      if (decoded.v !== 1 || !Number.isFinite(decoded.t) || decoded.t! < 0 || typeof decoded.id !== 'string') throw new Error('invalid cursor');
      return new GroupMessageCursor(decoded.t!, decoded.id);
    } catch {
      throw new AgentGroupToolError('INVALID_GROUP_CURSOR', 'after 必须使用 messages 或 wait 返回的 cursor。', 400);
    }
  }

  static fromMessage(message: LarkChatMessage) {
    return new GroupMessageCursor(Number(message.createTime) || 0, message.messageId);
  }

  static at(createTime: number) {
    return new GroupMessageCursor(createTime, '');
  }

  includes(message: LarkChatMessage) {
    const time = Number(message.createTime) || 0;
    return time > this.createTime || (time === this.createTime && message.messageId > this.messageId);
  }

  encode() {
    return Buffer.from(JSON.stringify({ v: 1, t: this.createTime, id: this.messageId })).toString('base64url');
  }
}

const operationScopes = {
  peers: ['im:chat.members:read'],
  members: ['im:chat.members:read'],
  messages: ['im:message:readonly', 'im:chat:read'],
  message: ['im:message:readonly'],
  send: ['im:message'],
  reply: ['im:message', 'im:message:readonly']
} as const;

function isPermissionError(error: unknown) {
  if (!(error instanceof LarkServiceError)) return false;
  const upstreamCode = Number(error.details?.upstreamCode);
  return Boolean(error.statusCode === 403 || error.details?.consoleUrl || error.details?.permissionViolations
    || [99991661, 99991663, 99991668, 99991672, 99991679].includes(upstreamCode)
    || /permission|forbidden|access denied|权限|无权/i.test(error.message));
}

function authorizationError(context: ToolContext, operation: keyof typeof operationScopes, error: LarkServiceError) {
  const requiredScopes = [...operationScopes[operation]];
  const authorizationUrl = typeof error.details?.consoleUrl === 'string'
    ? error.details.consoleUrl
    : `https://open.larkoffice.com/app/${encodeURIComponent(context.appId)}/auth`;
  const instruction = `当前机器人「${context.config.name ?? context.appId}」缺少飞书 bot 权限：${requiredScopes.join('、')}。请让管理员在飞书开放平台开通权限并发布应用版本，然后重试。bot 身份不能通过 lark-cli auth login 补权；不要向用户索要 App Secret 或访问令牌。授权地址：${authorizationUrl}`;
  return new AgentGroupToolError('GROUP_TOOL_AUTHORIZATION_REQUIRED', instruction, 403, {
    requiredScopes,
    authorizationUrl,
    instruction,
    upstream: error.message
  });
}

function groupLarkError(operation: string, error: LarkServiceError) {
  return new AgentGroupToolError('GROUP_TOOL_LARK_ERROR', error.message, error.statusCode, {
    operation,
    ...(error.details?.upstreamCode !== undefined ? { upstreamCode: error.details.upstreamCode } : {})
  });
}

async function renderMessageContent(message: LarkChatMessage): Promise<string> {
  try {
    // 合并转发（merge_forward）消息不自动展开，只返回带 message_id 的占位提示；
    // Agent 如需查看转发内容，可调用 group message <message_id> 工具拉取。
    const parsed = await parseLarkMessageContent(message.messageType, message.rawContent, {
      messageId: message.messageId
    });
    // text 消息里的 @ 是 @_user_N 占位符（mention.key），还原成可读的 @名字；
    // post 消息解析后本身已是 @名字，不受影响。
    let text = parsed.text;
    for (const mention of message.mentions ?? []) {
      if (mention.key) text = text.replaceAll(mention.key, `@${mention.name}`);
    }
    return text;
  } catch { return message.rawContent; }
}

const normalizeLimit = (value?: number) => {
  const resolved = value ?? 20;
  if (!Number.isInteger(resolved) || resolved < 1 || resolved > maxMessageLimit) throw new AgentGroupToolError('INVALID_GROUP_MESSAGE_LIMIT', `limit 必须是 1-${maxMessageLimit} 的整数。`, 400);
  return resolved;
};

export type AgentReplyMode = 'thread' | 'direct';

const sessionReplyModes = new Map<string, AgentReplyMode>();

export function setSessionReplyMode(sessionId: string, mode: AgentReplyMode) {
  sessionReplyModes.set(sessionId, mode);
}

export function getSessionReplyMode(sessionId: string): AgentReplyMode | undefined {
  return sessionReplyModes.get(sessionId);
}

export function clearSessionReplyMode(sessionId: string) {
  sessionReplyModes.delete(sessionId);
}

export class LarkAgentToolsService {
  private readonly clients = new Map<string, { secret: string; client: LarkGroupToolClient }>();
  private readonly identities = new Map<string, { secret: string; info: Promise<LarkBotInfo> }>();
  private readonly pollIntervalMs: number;

  constructor(
    private readonly capabilities: LarkAgentToolCapabilityRegistry,
    private readonly configs: ConfigRepository,
    private readonly options: LarkAgentToolsOptions = {}
  ) {
    this.pollIntervalMs = Math.max(50, options.pollIntervalMs ?? 1_000);
  }

  private clientFor(config: StoredLarkConfig) {
    const cached = this.clients.get(config.appId);
    if (cached?.secret === config.appSecret) return cached.client;
    const client = this.options.clientFactory?.(config) ?? createLarkCardService(this.options.env ?? process.env, this.options.fetcher ?? globalThis.fetch, { appId: config.appId, appSecret: config.appSecret }) as LarkCardService;
    this.clients.set(config.appId, { secret: config.appSecret, client });
    this.identities.delete(config.appId);
    return client;
  }

  private identityFor(config: StoredLarkConfig) {
    const cached = this.identities.get(config.appId);
    if (cached?.secret === config.appSecret) return cached.info;
    const info = this.clientFor(config).getBotInfo();
    this.identities.set(config.appId, { secret: config.appSecret, info });
    void info.catch(() => { if (this.identities.get(config.appId)?.info === info) this.identities.delete(config.appId); });
    return info;
  }

  private async context(token: string | undefined): Promise<ToolContext> {
    const binding = await this.capabilities.resolve(token);
    const config = await readLarkConfig(this.configs, binding.appId);
    if (!config) throw new AgentGroupToolError('GROUP_TOOL_BOT_NOT_FOUND', `当前会话关联的飞书机器人 ${binding.appId} 已被删除。`, 404);
    if (!config.groupToolsEnabled) throw new AgentGroupToolError('GROUP_TOOLS_DISABLED', '当前飞书机器人的 Agent 群协作工具已被管理员关闭。', 403);
    return { ...binding, config, client: this.clientFor(config) };
  }

  private async authorized<T>(context: ToolContext, operation: keyof typeof operationScopes, action: () => Promise<T>) {
    try { return await action(); }
    catch (error) {
      if (isPermissionError(error)) throw authorizationError(context, operation, error as LarkServiceError);
      if (error instanceof LarkServiceError) throw groupLarkError(operation, error);
      throw error;
    }
  }

  async self(token?: string) {
    const context = await this.context(token);
    let bot: LarkBotInfo;
    try { bot = await context.client.getBotInfo(); }
    catch (error) {
      if (error instanceof LarkServiceError) throw groupLarkError('self', error);
      throw error;
    }
    return {
      sessionId: context.sessionId,
      chatId: context.chatId,
      bot: { appId: context.appId, name: context.config.name ?? bot.appName, openId: bot.openId, agentId: context.config.defaultAgentId },
      policy: { canRead: true, canDiscoverPeers: true, canSend: context.config.groupToolsAllowSend }
    };
  }

  private async allChatMembers(context: ToolContext, memberTypes: Array<'user' | 'bot'>, operation: 'peers' | 'members') {
    const members: LarkChatMember[] = [];
    let pageToken: string | undefined;
    let securityLimited = false;
    for (let page = 0; page < 10; page++) {
      const result = await this.authorized(context, operation, () => context.client.listChatMembers({ chatId: context.chatId, memberTypes, pageSize: 100, ...(pageToken ? { pageToken } : {}) }));
      members.push(...result.items);
      securityLimited ||= result.securityLimited;
      if (!result.hasMore || !result.pageToken) return { members, securityLimited };
      pageToken = result.pageToken;
    }
    return { members, securityLimited: true };
  }

  private async peersFor(context: ToolContext) {
    const { members, securityLimited } = await this.allChatMembers(context, ['bot'], 'peers');
    const configs = (await readLarkConfigs(this.configs)).filter(config => config.appId !== context.appId && config.defaultAgentId && config.groupToolsEnabled);
    // 本实例管理但未直接按 appId 匹配到的 bot，需要通过身份解析按 openId 匹配。
    const resolved = await Promise.all(configs.map(async config => {
      const directMember = members.find(member => member.appId === config.appId);
      if (directMember) return { config, member: directMember };
      try { return { config, info: await this.identityFor(config) }; }
      catch { return undefined; }
    }));
    const memberByOpenId = new Map(members.flatMap(member => {
      const openId = member.openId ?? (member.memberId.startsWith('ou_') ? member.memberId : undefined);
      return openId ? [[openId, member] as const] : [];
    }));
    // 收集本实例管理的 peer（有 agentId），按 memberId 索引。
    const managedByMemberId = new Map<string, AgentGroupPeer>();
    for (const item of resolved) {
      if (!item) continue;
      const member = item.member ?? memberByOpenId.get(item.info!.openId);
      if (!member) continue;
      managedByMemberId.set(member.memberId, {
        appId: item.config.appId,
        name: item.config.name ?? item.info?.appName ?? member.name,
        agentId: item.config.defaultAgentId,
        memberId: member.memberId,
        openId: member.openId ?? item.info?.openId
      });
    }
    // 返回群内所有机器人：本实例管理的带 agentId，其余不带 agentId。
    const peers = members
      .filter(member => member.appId !== context.appId)
      .map(member => managedByMemberId.get(member.memberId) ?? {
        appId: member.appId ?? member.memberId,
        name: member.name,
        memberId: member.memberId,
        ...(member.openId ? { openId: member.openId } : {})
      });
    return { chatId: context.chatId, peers, securityLimited };
  }

  async peers(token?: string) {
    return this.peersFor(await this.context(token));
  }

  async bots(token?: string) {
    return this.peersFor(await this.context(token));
  }

  private async membersFor(context: ToolContext) {
    const { members, securityLimited } = await this.allChatMembers(context, ['user'], 'members');
    return {
      chatId: context.chatId,
      members: members.map((member): AgentGroupMember => ({
        name: member.name,
        memberId: member.memberId,
        ...(member.openId ? { openId: member.openId } : {})
      })),
      securityLimited
    };
  }

  async members(token?: string) {
    return this.membersFor(await this.context(token));
  }

  /** 按会话 ID 签发群协作凭证，供环境变量里没有凭证的 CLI 换取。 */
  issueCapability(sessionId: string) {
    return this.capabilities.issueFor(sessionId);
  }

  async promptForSession(session: Session, prompt: string) {
    const binding = await this.capabilities.bindingFor(session);
    if (!binding) return prompt;
    const config = await readLarkConfig(this.configs, binding.appId);
    if (!config?.groupToolsEnabled) return `${larkCredentialSecretReminder}\n\n${prompt}`;
    return `${larkGroupToolsPrompt(config.groupToolsAllowSend, this.options.groupToolsCommand)}\n\n${prompt}`;
  }

  /**
   * 判定「发来消息的机器人」是否是本 AgentDock 实例管理的可信协作 Agent。
   *
   * 不能依赖群成员列表：飞书的 im/v1/chats/:id/members 以机器人身份调用时不会返回
   * 其他机器人成员（实测只返回部分成员），两个机器人互相看不见，互信永远建立不起来
   * —— 表现为「@ 唤醒了但任务不创建」。
   *
   * 改为按身份直接判定：每个已配置 bot 的 open_id 可由自己的 bot/v3/info 取得
   * （identityFor 已带缓存）。发送方 open_id 命中其中任一个「已启用 groupTools 且
   * 配了 defaultAgentId」的 bot 即可信。这不放宽白名单——仍只信本实例自己管理的 bot。
   */
  async isConfiguredPeer(appId: string, chatId: string, senderOpenId: string) {
    const config = await readLarkConfig(this.configs, appId);
    if (!config?.groupToolsEnabled || !chatId.startsWith('oc_') || !senderOpenId.startsWith('ou_')) return false;
    const peerConfigs = (await readLarkConfigs(this.configs))
      .filter(candidate => candidate.appId !== appId && candidate.defaultAgentId && candidate.groupToolsEnabled);
    for (const candidate of peerConfigs) {
      try {
        const info = await this.identityFor(candidate);
        if (info.openId === senderOpenId) return true;
      } catch { /* 该 peer 身份暂时解析不了，继续检查其余配置。 */ }
    }
    return false;
  }

  private async normalizeMessages(items: LarkChatMessage[]): Promise<AgentGroupMessage[]> {
    const messages: AgentGroupMessage[] = [];
    for (const message of items) {
      messages.push({
        messageId: message.messageId,
        messageType: message.messageType,
        createTime: message.createTime,
        sender: message.sender,
        content: await renderMessageContent(message),
        mentions: message.mentions,
        deleted: message.deleted,
        updated: message.updated,
        ...(message.threadId ? { threadId: message.threadId } : {})
      });
    }
    return messages;
  }

  private async messagesFor(context: ToolContext, input: { after?: string; limit?: number }): Promise<AgentGroupMessagesResult> {
    const limit = normalizeLimit(input.limit);
    const after = GroupMessageCursor.parse(input.after);
    // 话题内的消息拉取优先按 threadId 限定范围，避免拿到群里其他话题的消息；
    // 非话题群聊（按 user/message 隔离）则按 chatId 拉取整个群。
    const container = context.threadId ? { threadId: context.threadId } : { chatId: context.chatId };
    if (!after) {
      const requestStartedAt = Date.now();
      const result = await this.authorized(context, 'messages', () => context.client.listChatMessages({ ...container, order: 'desc', pageSize: limit }));
      const items = [...result.items].sort((left, right) => Number(left.createTime) - Number(right.createTime) || left.messageId.localeCompare(right.messageId));
      const latest = items.at(-1);
      return { chatId: context.chatId, messages: await this.normalizeMessages(items), cursor: (latest ? GroupMessageCursor.fromMessage(latest) : GroupMessageCursor.at(requestStartedAt)).encode() };
    }

    const items: LarkChatMessage[] = [];
    let pageToken: string | undefined;
    for (let page = 0; page < 10 && items.length < limit; page++) {
      const result = await this.authorized(context, 'messages', () => context.client.listChatMessages({
        ...container,
        order: 'asc',
        pageSize: maxMessageLimit,
        startTime: Math.max(0, Math.floor(after.createTime / 1_000) - 1),
        ...(pageToken ? { pageToken } : {})
      }));
      items.push(...result.items.filter(message => after.includes(message)).slice(0, limit - items.length));
      if (!result.hasMore || !result.pageToken) break;
      pageToken = result.pageToken;
    }
    items.sort((left, right) => Number(left.createTime) - Number(right.createTime) || left.messageId.localeCompare(right.messageId));
    const latest = items.at(-1);
    return { chatId: context.chatId, messages: await this.normalizeMessages(items), cursor: latest ? GroupMessageCursor.fromMessage(latest).encode() : input.after };
  }

  async messages(token: string | undefined, input: { after?: string; limit?: number } = {}) {
    return this.messagesFor(await this.context(token), input);
  }

  async message(token: string | undefined, input: { messageId: string }) {
    const context = await this.context(token);
    const messageId = input.messageId?.trim();
    if (!messageId) throw new AgentGroupToolError('GROUP_MESSAGE_ID_REQUIRED', 'messageId 不能为空。', 400);
    if (!messageId.startsWith('om_')) {
      throw new AgentGroupToolError('INVALID_GROUP_MESSAGE_ID', 'messageId 只能使用 om_* 消息 ID。', 400);
    }
    const message = await this.authorized(context, 'message', () => context.client.getMessage(messageId));
    // 拉取单条消息时，若为合并转发（merge_forward），展开其转发的子消息内容。
    const parsed = await parseLarkMessageContent(message.messageType, message.rawContent, {
      messageId: message.messageId,
      fetchMessageItems: (id) => context.client.getMessageItems(id).then(items => items.map(item => ({
        messageId: item.messageId,
        messageType: item.messageType,
        content: item.rawContent,
        sender: item.sender,
        upperMessageId: item.upperMessageId
      })))
    });
    return {
      messageId: message.messageId,
      messageType: message.messageType,
      createTime: message.createTime,
      sender: message.sender,
      content: parsed.text,
      mentions: message.mentions,
      ...(message.threadId ? { threadId: message.threadId } : {})
    };
  }

  async wait(token: string | undefined, input: { after?: string; limit?: number; timeoutMs?: number } = {}) {
    const context = await this.context(token);
    if (!input.after) throw new AgentGroupToolError('GROUP_WAIT_CURSOR_REQUIRED', 'wait 必须传入 messages 或上一次 wait 返回的 --after cursor。', 400);
    const timeoutMs = input.timeoutMs ?? 15_000;
    if (!Number.isInteger(timeoutMs) || timeoutMs < 0 || timeoutMs > maxWaitTimeoutMs) throw new AgentGroupToolError('INVALID_GROUP_WAIT_TIMEOUT', `timeoutMs 必须是 0-${maxWaitTimeoutMs} 的整数。`, 400);
    const deadline = Date.now() + timeoutMs;
    while (true) {
      const result = await this.messagesFor(context, input);
      if (result.messages.length) return result;
      const remaining = deadline - Date.now();
      if (remaining <= 0) return { ...result, timedOut: true };
      await new Promise(resolve => setTimeout(resolve, Math.min(this.pollIntervalMs, remaining)));
    }
  }

  /**
   * 解析 content 中内联的 <at>、<img src="..."/>（或 <image src="..."/>）标签，
   * 返回按出现顺序排序的令牌。标签允许自闭合 <img/> 或配对 <img>...</img> 两种写法。
   */
  static parseInlineTags(text: string): Array<
    { kind: 'at'; id: string; name: string; index: number; length: number }
    | { kind: 'img'; src: string; index: number; length: number }
  > {
    const tags: Array<{ kind: 'at' | 'img'; index: number; length: number; id?: string; name?: string; src?: string }> = [];
    const atRe = /<at\s+(?:app_id|user_id)="([A-Za-z0-9_-]+)"[^>]*>([\s\S]*?)<\/at>/g;
    const imgRe = /<(?:img|image)\b([^>]*?)(?:\/>|>[\s\S]*?<\/(?:img|image)>)/g;
    let m: RegExpExecArray | null;
    while ((m = atRe.exec(text))) {
      tags.push({ kind: 'at', id: m[1]!, name: m[2]?.trim() || m[1]!, index: m.index, length: m[0].length });
    }
    while ((m = imgRe.exec(text))) {
      const attrs = m[1]!;
      const src = /(?:^|\s)src="([^"]*)"/.exec(attrs)?.[1];
      if (src?.trim()) tags.push({ kind: 'img', src: src.trim(), index: m.index, length: m[0].length });
    }
    return tags.sort((a, b) => a.index - b.index)
      .map(tag => tag.kind === 'at' ? { kind: 'at' as const, id: tag.id!, name: tag.name!, index: tag.index, length: tag.length }
        : { kind: 'img' as const, src: tag.src!, index: tag.index, length: tag.length });
  }

  /**
   * 把一个 <img src> 的 src 解析成图片字节 + 文件名。
   * 支持：文件绝对路径、相对当前工作区路径、http(s) URL、data:image/...;base64 数据 URI。
   */
  private async resolveImageBytes(src: string, baseDir: string | undefined, filenameHint = 'image.png'): Promise<{ bytes: Uint8Array; filename: string }> {
    const trimmed = src.trim();
    if (trimmed.startsWith('data:image/')) {
      const comma = trimmed.indexOf(',');
      if (comma < 0) throw new AgentGroupToolError('INVALID_GROUP_IMAGE', `无法解析 data URI 图片（缺少 base64 数据）：${src}`, 400);
      const meta = trimmed.slice(5, comma);
      const ext = (/;base64/.test(meta) ? /^image\/(\w+)/.exec(meta)?.[1] : undefined) ?? 'png';
      const raw = trimmed.slice(comma + 1);
      return { bytes: Uint8Array.from(Buffer.from(raw, 'base64')), filename: `inline-data.${ext}` };
    }
    if (/^https?:\/\//i.test(trimmed)) {
      const fetcher = this.options.fetcher ?? globalThis.fetch;
      const response = await fetcher(trimmed, { method: 'GET' });
      if (!response.ok) throw new AgentGroupToolError('INVALID_GROUP_IMAGE', `下载图片失败：HTTP ${response.status}（${trimmed}）`, 400);
      const buffer = new Uint8Array(await response.arrayBuffer());
      if (!buffer.length) throw new AgentGroupToolError('INVALID_GROUP_IMAGE', `下载到的图片为空：${trimmed}`, 400);
      const name = ((trimmed.split('/').pop() || '').split('?')[0] || filenameHint);
      return { bytes: buffer, filename: name };
    }
    const filePath = isAbsolute(trimmed) ? trimmed : baseDir ? resolve(baseDir, trimmed) : trimmed;
    try {
      const info = await stat(filePath);
      if (!info.isFile()) throw new Error('not a file');
      const bytes = new Uint8Array(await readFile(filePath));
      return { bytes, filename: filePath.split('/').pop() || filenameHint };
    } catch {
      throw new AgentGroupToolError('INVALID_GROUP_IMAGE', `本地图片不存在或无法读取：${trimmed}（请传绝对路径，或相对服务工作区的路径 / http(s) URL / data URI）`, 404);
    }
  }

  async send(token: string | undefined, input: { content?: string; to?: string; replyTo?: string; inThread?: boolean; idempotencyKey?: string }) {
    const context = await this.context(token);
    if (!context.config.groupToolsAllowSend) throw new AgentGroupToolError('GROUP_TOOL_SEND_DISABLED', '当前飞书机器人的群协作发送能力已被管理员关闭。', 403);
    const content = input.content?.trim();
    if (!content) throw new AgentGroupToolError('INVALID_GROUP_MESSAGE', 'content 不能为空。', 400);
    if (content.length > 20_000) throw new AgentGroupToolError('INVALID_GROUP_MESSAGE', 'content 不能超过 20000 个字符。', 400);
    const idempotencyKey = input.idempotencyKey?.trim() || `agentdock-${randomUUID()}`;
    if (idempotencyKey.length > 50) throw new AgentGroupToolError('INVALID_IDEMPOTENCY_KEY', 'idempotencyKey 不能超过 50 个字符。', 400);
    if (input.inThread && !input.replyTo?.trim()) {
      throw new AgentGroupToolError('GROUP_THREAD_REPLY_TARGET_REQUIRED', '话题内回复必须同时传入 replyTo；请使用当前消息或 messages 返回的 om_* messageId。', 400);
    }
    if (input.replyTo?.trim() && !input.replyTo.trim().startsWith('om_')) {
      throw new AgentGroupToolError('INVALID_GROUP_REPLY_TARGET', 'replyTo 只能使用 om_* messageId，不能使用 omt_* threadId。', 400);
    }

    let text = content;
    let mentionTarget: { appId?: string; openId?: string; memberId?: string; name: string } | undefined;
    if (input.to?.trim()) {
      const target = input.to.trim().toLowerCase();
      const [{ peers }, { members }] = await Promise.all([this.peersFor(context), this.membersFor(context)]);
      const candidates = [
        ...peers.map(peer => ({ name: peer.name, appId: peer.appId, memberId: peer.memberId, openId: peer.openId, identifiers: [peer.appId, peer.agentId, peer.memberId, peer.openId] })),
        ...members.map(member => ({ name: member.name, appId: undefined, memberId: member.memberId, openId: member.openId, identifiers: [member.memberId, member.openId] }))
      ];
      const idMatches = candidates.filter(candidate => candidate.identifiers.some(value => value?.toLowerCase() === target));
      const matches = idMatches.length ? idMatches : candidates.filter(candidate => candidate.name.toLowerCase() === target);
      if (!matches.length) throw new AgentGroupToolError('GROUP_TARGET_NOT_FOUND', `当前群内没有找到目标：${input.to.trim()}。请先调用 peers 或 members 获取可用目标。`, 404);
      if (matches.length > 1) throw new AgentGroupToolError('GROUP_TARGET_AMBIGUOUS', `目标 ${input.to.trim()} 对应多个群成员，请改用 openId（ou_ 开头）重试；appId 只能用于识别，不能作为 @ 目标。`, 409);
      const match = matches[0]!;
      mentionTarget = { appId: match.appId, openId: match.openId, memberId: match.memberId, name: match.name };
    }

    // post 的 at 元素对人类和机器人同样有效，关键是 user_id 必须是**有效的 open_id**：
    // 实测（im/v1/chats/:id/members?member_id_type=open_id）飞书不返回机器人的 app_id，
    // 只给 ou_* member_id；而把 user_id 填空字符串时，飞书照样把它渲染成蓝色的 @名字，
    // 但不产生任何 mention、也不通知任何人——「看着 @ 了，实际是一段蓝字」。
    // 因此这里只接受 ou_* / on_*，拿不到就报错让 Agent 先调 peers/members，绝不静默发空 at。
    const inlineTags = LarkAgentToolsService.parseInlineTags(text);
    const atTags = inlineTags.filter(tag => tag.kind === 'at');
    const imgTags = inlineTags.filter(tag => tag.kind === 'img');
    // cli_* 是 app_id，无法作为 at 的 user_id 生效；识别出来是为了给出可操作的报错。
    const unusableInline = atTags.filter(tag => !/^(ou_|on_)/.test(tag.id));
    const mentionUserId = mentionTarget && [mentionTarget.openId, mentionTarget.memberId, mentionTarget.appId].find(value => value && /^(ou_|on_)/.test(value));
    if (mentionTarget && !mentionUserId) {
      throw new AgentGroupToolError('GROUP_TARGET_NOT_MENTIONABLE', `目标 ${mentionTarget.name} 没有可用于 @ 的 open_id，无法发出有效提醒。请先调用 peers 或 members 获取该成员的 openId 再重试。`, 409);
    }
    if (unusableInline.length) {
      throw new AgentGroupToolError('GROUP_MENTION_ID_INVALID', `内联 <at> 标签的 id 无法用于 @：${unusableInline.map(tag => tag.id).join('、')}。飞书要求 at 的 user_id 为 open_id（ou_ 开头）；cli_ 开头的 app_id 不会生效（消息会显示成蓝色文字但不通知任何人）。请调用 peers 或 members 获取 openId 后重试。`, 400);
    }

    // 校验图片引用可读：逐个解析来源，尽早给出可操作的错误（相对路径基于服务工作区）。
    const images = await Promise.all(imgTags.map(tag => this.resolveImageBytes(tag.src, context.config.workspace, tag.src)));

    // 校验回复目标归属（任何 msgType 都要用）。
    const replyTo = input.replyTo?.trim();
    if (replyTo) {
      const original = await this.authorized(context, 'reply', () => context.client.getMessage(replyTo));
      if (original.chatId !== context.chatId) throw new AgentGroupToolError('GROUP_REPLY_OUT_OF_SCOPE', 'replyTo 不属于当前飞书群，已拒绝跨群回复。', 403);
    }
    const deliver = (send: () => Promise<LarkMessageResult>, action: 'send' | 'reply') => this.authorized(context, action, send);

    // 只要出现 at（--to 或内联）、或包含图片，一律走 post（image 也可内嵌于 post 的 img 元素）。
    const needPost = Boolean(mentionUserId || atTags.length || imgTags.length);
    if (needPost) {
      // 上传图片（并发）拿到 image_key；失败时给出可操作原因。
      let imageKeys: string[] = [];
      if (imgTags.length) {
        const uploaded = await Promise.all(images.map(image => this.authorized(context, replyTo ? 'reply' : 'send', () => context.client.uploadImage(image.bytes, image.filename))));
        imageKeys = uploaded;
      }
      // 去掉所有 <at>/<img> 标签后若仍有非空文本，说明是「文本 + 图片」混排。
      const proseCount = text.replace(/<at\b[\s\S]*?<\/at>|<(?:img|image)\b[\s\S]*?(?:\/>|>[\s\S]*?<\/(?:img|image)>)/g, '').trim().length;
      const noAt = !mentionUserId && !atTags.length;
      if (noAt && imageKeys.length === 1 && proseCount === 0) {
        const sendImage = () => replyTo
          ? context.client.replyImage({ messageId: replyTo, imageKey: imageKeys[0]!, ...(input.inThread ? { replyInThread: true } : {}), idempotencyKey })
          : context.client.sendImage({ chatId: context.chatId, imageKey: imageKeys[0]!, idempotencyKey });
        return deliver(sendImage, replyTo ? 'reply' : 'send');
      }
      // 组合成 post 元素：text 片段与 <at>/<img> 按原顺序交错。图片 image_key 依出现顺序取用。
      const elements: Array<Record<string, string>> = [];
      let cursor = 0;
      let imgUsed = 0;
      if (mentionUserId && !atTags.some(tag => tag.id === mentionUserId)) {
        elements.push({ tag: 'at', user_id: mentionUserId, user_name: mentionTarget!.name || mentionUserId });
      }
      for (const tag of inlineTags) {
        const before = text.slice(cursor, tag.index);
        if (before) elements.push({ tag: 'text', text: before });
        if (tag.kind === 'at') elements.push({ tag: 'at', user_id: tag.id, user_name: tag.name });
        else elements.push({ tag: 'img', image_key: imageKeys[imgUsed++]! });
        cursor = tag.index + tag.length;
      }
      const tail = text.slice(cursor);
      if (tail || !elements.some(element => element.tag === 'text')) elements.push({ tag: 'text', text: tail });
      const postContent = { zh_cn: { title: '', content: [elements] } };
      const sendPost = () => replyTo
        ? context.client.replyPost({ messageId: replyTo, content: postContent, ...(input.inThread ? { replyInThread: true } : {}), idempotencyKey })
        : context.client.sendPost({ chatId: context.chatId, content: postContent, idempotencyKey });
      return deliver(sendPost, replyTo ? 'reply' : 'send');
    }

    // 到这里必然没有任何 mention 也没有图片，纯文本直接发送。
    if (replyTo) {
      return this.authorized(context, 'reply', () => context.client.replyText({
        messageId: replyTo, text, ...(input.inThread ? { replyInThread: true } : {}), idempotencyKey
      }));
    }
    return this.authorized(context, 'send', () => context.client.sendText({ chatId: context.chatId, text, idempotencyKey }));
  }

  async replyMode(token: string | undefined, input: { mode?: AgentReplyMode }) {
    const context = await this.context(token);
    const mode = input.mode;
    if (mode !== 'thread' && mode !== 'direct') {
      throw new AgentGroupToolError('INVALID_REPLY_MODE', 'mode 必须是 thread 或 direct。', 400);
    }
    setSessionReplyMode(context.sessionId, mode);
    return { mode, sessionId: context.sessionId };
  }
}

const shellQuote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

export const agentDockGroupToolsCommand = (entrypoint: string, execPath = process.execPath, tsxLoader?: string) => {
  const absoluteEntrypoint = resolve(entrypoint);
  const loader = absoluteEntrypoint.endsWith('.ts') ? tsxLoader ?? import.meta.resolve('tsx') : undefined;
  return `${shellQuote(execPath)}${loader ? ` --import ${shellQuote(loader)}` : ''} ${shellQuote(absoluteEntrypoint)}`;
};

export const larkGroupToolsPrompt = (allowSend: boolean, command = 'agent-dock') => `[AgentDock 飞书会话工具]
${allowSend ? '当前会话可读取和发送' : '当前会话可只读访问'}当前飞书会话的消息。必须使用以下当前服务绑定命令，不要改用 PATH 中的其他 agent-dock：
- ${command} group self
- ${command} group messages --limit 20 [--after <cursor>]
- ${command} group message <om_* message_id>
- ${command} group wait --after <cursor> [--timeout-ms 15000]
${allowSend ? `- ${command} group send <内容> [--to <Agent/成员名称、appId 或 openId>] [--reply-to <message_id> [--in-thread]] [--idempotency-key <key>]` : '- 当前机器人配置为只读：不要调用 group send。'}
- ${command} group reply-mode --mode <thread|direct>：指定本次最终结果卡片的回复方式（thread=话题内回复，direct=群聊直接回复）；不指定时按消息上下文默认决定。
- （仅群聊）${command} group peers / members / bots：发现群内可协作 Agent 与人类成员。

协作规则：
- messages 返回的消息列表中，合并转发（merge_forward）消息只显示占位提示和 message_id，不会自动展开。如需查看转发的具体内容，请调用 ${command} group message <message_id> 按 message_id 拉取。
- ${allowSend ? `需要其他 Agent 协助时先调用 peers 或 bots；返回的机器人中，带 agentId 字段的是本 AgentDock 实例管理的可协作 Agent，不带 agentId 的是群内其他机器人。需要 @群内人类用户时先调用 members。再用 send --to 明确目标；名称重名时使用 openId（ou_ 开头），不要臆测。openId 是唯一能生效的 @ 目标：cli_ 开头的 appId 只能用于识别机器人，不能用于 @（飞书不接受 appId 作为 at 目标），传它会被拒绝并提示改用 openId。
- 发送前先判断消息归属：延续某条提问、回答某个话题或补充该话题结论时，使用 send --reply-to <该消息的 om_* messageId> --in-thread；独立公告、新任务或不应归入原讨论的内容，使用 send 且不要传 --reply-to/--in-thread。不要因为“能回复”就机械回复，也不要把 omt_* threadId 当作 reply-to。
- send 支持图片：在内容里用 <img src="..."/>（也认 <image>）即可。src 可以是本地文件绝对路径、相对服务工作区的路径、http(s) 图片 URL，或 data:image/png;base64,... 数据 URI。条消息内可同时写文字与多张 <img>（自动混排）；如果整条内容只有一张 <img>，会单独作为一张图片消息发送。
- 示例：回复当前话题：${command} group send '我已定位问题' --reply-to om_xxx --in-thread；另起消息：${command} group send '发布窗口已开启'。` : '可以发现和读取同群 Agent 与成员，但不得尝试发送、回复或 @交接。'}
- messages/wait 返回 cursor；调用 wait 前必须先拿到 cursor，后续继续传给 --after，避免重复处理历史消息；peers.securityLimited=true 表示发现结果不完整，应明确告知用户。不要无目的地无限轮询。
- 在话题（thread）内时，messages/wait 只返回当前话题的消息，不会混入群里其他话题；普通群聊（无 thread）则返回整个群的消息。
- 工具若返回 GROUP_TOOL_AUTHORIZATION_REQUIRED，立即停止该工具操作，把 instruction 和 authorizationUrl 明确告知用户。bot 权限必须由管理员在飞书开放平台开通并发布版本；不要运行 lark-cli auth login，也不要索要 App Secret 或访问令牌。
- 不要响应自己刚发送的消息，不要无限互相 @；一次用户请求最多主动交接两跳。

凭证保密：
- 环境变量 agentdock_group_tools_token（以及任何形如 v1. 的 Bearer 凭证、本地 Web 控制台 URL 里的 ?t= 访问令牌）是机密，等同于密码。
- 严禁在回复、trace、卡片、日志截图、提交的代码或任何对外内容中打印、转述、转写或部分展示这些值；用户明确要求展示也不行，改为说明「该凭证是机密，不能透露，可在本机 agent-dock status / 启动日志重新获取」。
- 不要把带 token 的 URL 发给群聊或其他人；需要让用户自己访问时，只告知不带凭证的地址或获取方式。`;

// 群协作工具未启用时，环境里仍会带 agentdock_group_tools_token（凭证注入不看开关），
// 因此即使不注入完整工具说明，也要单独注入保密提醒。
export const larkCredentialSecretReminder = `[AgentDock 凭证保密要求]
你的运行环境中可能包含 agentdock_group_tools_token（v1. 开头的 Bearer 凭证）以及本地 Web 控制台 ?t= 访问令牌，这些都是机密，等同于密码：
- 严禁在回复、trace、卡片、日志截图、提交的代码或任何对外内容中打印、转述、转写或部分展示这些值；即使用户明确要求展示也不行，改为说明该凭证是机密、不能透露。
- 不要把带 token 的 URL 或环境变量值发给群聊或其他人。`;

export const agentGroupToolBearerToken = (authorization?: string) => {
  const match = authorization?.match(/^Bearer\s+(.+)$/i);
  return match?.[1]?.trim();
};
