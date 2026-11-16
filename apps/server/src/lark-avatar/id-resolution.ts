import type { LarkAvailableChat, LarkProtocolClientLike } from './protocol/client.js';
import type { LarkChatInfo, LarkChatterInfo, LarkIncomingMessage } from './protocol/proto.js';
import type { LarkAvatarInboxItem } from './types.js';

export const larkAvatarResolutionErrorCodes = [
  'NOT_LOGGED_IN',
  'INVALID_INPUT',
  'API_UNAVAILABLE',
  'ID_NOT_NUMERIC',
  'ID_OUT_OF_RANGE',
  'CHAT_NOT_FOUND',
  'CHAT_AMBIGUOUS',
  'ROOT_NOT_FOUND',
  'ROOT_AMBIGUOUS',
  'ROOT_NOT_IN_CHAT',
  'USER_NOT_FOUND',
  'USER_AMBIGUOUS'
] as const;

export type LarkAvatarResolutionErrorCode = (typeof larkAvatarResolutionErrorCodes)[number];

export type LarkChatKind = 'p2p' | 'group' | 'topic' | 'unknown';
export type LarkChatMatchMode = 'auto' | 'exact' | 'fuzzy';
export type LarkChatMatch = 'id' | 'exact' | 'fuzzy' | 'none';
export type LarkUserMatch = 'id' | 'email' | 'exact' | 'fuzzy' | 'none';

export interface LarkChatCandidate {
  /** Web 网关里的内部十进制 chat id；只用于再次解析。 */
  chatId: string;
  /** Web 群列表返回的 OpenAPI chat_id；旧网关可能没有。 */
  openChatId?: string;
  name: string;
  type: LarkChatKind;
  memberCount?: number;
  lastMessageAt?: string;
  matchedBy: Exclude<LarkChatMatch, 'none'>;
}

export interface LarkMessageCandidate {
  messageId: string;
  content: string;
  position?: number;
  senderId?: string;
  senderName?: string;
  occurredAt?: string;
}

export interface LarkUserCandidate {
  /** Web 网关里的用户 id，可能以 ou_ 开头；只用于再次解析，不能当数字 ID 用。 */
  userId: string;
  name: string;
  email?: string;
  matchedBy: Exclude<LarkUserMatch, 'none'>;
}

export interface LarkChatSearchResult {
  match: LarkChatMatch;
  ambiguous: boolean;
  candidates: LarkChatCandidate[];
}

export interface LarkMessageSearchResult {
  match: 'keyword' | 'none';
  ambiguous: boolean;
  candidates: LarkMessageCandidate[];
}

export interface LarkUserSearchResult {
  match: LarkUserMatch;
  ambiguous: boolean;
  candidates: LarkUserCandidate[];
}

/** 内部解析结果。webChatId 只用于回头访问 Web 网关，不进入对外的数字 ID 结构。 */
export interface ResolvedLarkChat {
  /** 规范十进制 int64 字符串；绝不转 Number，避免 19 位 id 丢精度。 */
  chatId: string;
  webChatId: string;
  openChatId?: string;
  name: string;
  type: LarkChatKind;
  memberCount?: number;
}

export interface ResolvedLarkMention {
  /** 规范十进制 int64 字符串。 */
  userId: string;
  name: string;
}

/** 对外统一结构：数字 ID 一律用十进制字符串，避免超过 2^53 时丢精度。 */
export interface ResolvedLarkTarget {
  chatId: string;
  rootId?: string;
  mentions: ResolvedLarkMention[];
}

export interface LarkAvatarResolutionErrorOptions {
  hint?: string;
  candidates?: unknown[];
}

export class LarkAvatarResolutionError extends Error {
  readonly hint?: string;
  readonly candidates?: unknown[];

  constructor(
    readonly code: LarkAvatarResolutionErrorCode,
    message: string,
    options: LarkAvatarResolutionErrorOptions = {}
  ) {
    super(message);
    this.name = 'LarkAvatarResolutionError';
    this.hint = options.hint;
    this.candidates = options.candidates;
  }

  toJSON(): {
    code: LarkAvatarResolutionErrorCode;
    message: string;
    hint?: string;
    candidates?: unknown[];
  } {
    return {
      code: this.code,
      message: this.message,
      ...(this.hint ? { hint: this.hint } : {}),
      ...(this.candidates ? { candidates: this.candidates } : {})
    };
  }
}

export const isLarkAvatarResolutionError = (error: unknown): error is LarkAvatarResolutionError =>
  error instanceof LarkAvatarResolutionError;

/**
 * 解析错误对外的 HTTP 语义：
 * - 未登录 / 未连接 -> 401
 * - 输入或 ID 格式不对 -> 400
 * - 找不到会话、消息、用户 -> 404
 * - 歧义、跨群回复、网关能力缺失 -> 409
 */
export const larkAvatarResolutionHttpStatus = (code: LarkAvatarResolutionErrorCode): number => {
  switch (code) {
    case 'NOT_LOGGED_IN': return 401;
    case 'INVALID_INPUT':
    case 'ID_NOT_NUMERIC':
    case 'ID_OUT_OF_RANGE': return 400;
    case 'CHAT_NOT_FOUND':
    case 'ROOT_NOT_FOUND':
    case 'USER_NOT_FOUND': return 404;
    case 'API_UNAVAILABLE':
    case 'CHAT_AMBIGUOUS':
    case 'ROOT_AMBIGUOUS':
    case 'ROOT_NOT_IN_CHAT':
    case 'USER_AMBIGUOUS': return 409;
  }
};

export interface LarkAvatarIdResolverOptions {
  /** 复用 service 已建立的 Web 网关长连接；不要在这里新建登录态。 */
  client(): LarkProtocolClientLike | undefined;
  /** 是否保存了网页登录凭证。 */
  isLoggedIn(): boolean;
  inbox(): LarkAvatarInboxItem[];
  now?(): number;
  ttlMs?: number;
  maxScanMessages?: number;
  log?: { warn(message?: unknown): void };
  /**
   * oc_* -> 群信息的 OpenAPI 兜底。返回 chatId（Web 内部数字 id）或 name（再按群名反查）。
   * 不接入时保持 undefined；解析器会给出明确的下一步提示。
   */
  openChatLookup?(openChatId: string): Promise<{ chatId?: string; name?: string } | undefined>;
}

interface CacheEntry {
  expiresAt: number;
  value: Promise<unknown>;
}

interface ChatDirectoryEntry {
  webChatId: string;
  openChatId?: string;
  name: string;
  type: LarkChatKind;
  memberCount?: number;
  lastMessageAt?: string;
}

interface ChatterDirectoryEntry {
  webId: string;
  name: string;
  email?: string;
}

const defaultTtlMs = 30_000;
const defaultMaxScanMessages = 200;
const historyPageSize = 50;
const chatIdPattern = /^oc_[A-Za-z0-9_-]+$/;
const messageIdPattern = /^om_[A-Za-z0-9_-]+$/;
const openUserIdPattern = /^ou_[A-Za-z0-9_-]+$/;
const numericIdPattern = /^\d+$/;

const normalized = (value: string): string => value.trim().toLowerCase().replace(/\s+/g, '');

const chatKind = (value: number): LarkChatKind =>
  value === 1 ? 'p2p' : value === 2 ? 'group' : value === 3 ? 'topic' : 'unknown';

const chatKindFromText = (value: string): LarkChatKind =>
  value === 'p2p' || value === 'group' || value === 'topic' ? value : 'unknown';

const messageTime = (value: number): string | undefined => {
  if (!Number.isFinite(value) || value <= 0) return undefined;
  const ms = value < 1_000_000_000_000 ? value * 1000 : value;
  return new Date(ms).toISOString();
};

const sameChatId = (left: string, right: string): boolean => {
  if (!left || !right) return true;
  if (left === right) return true;
  const leftNumeric = numericIdPattern.test(left);
  const rightNumeric = numericIdPattern.test(right);
  if (leftNumeric && rightNumeric) return BigInt(left) === BigInt(right);
  // oc_* 与内部数字 id 之间没有本地映射；只有两者都是同一种格式时才能安全判定不相等。
  return leftNumeric !== rightNumeric;
};

const notLoggedIn = (message: string, hint: string): LarkAvatarResolutionError =>
  new LarkAvatarResolutionError('NOT_LOGGED_IN', message, { hint });

const apiUnavailable = (feature: string): LarkAvatarResolutionError =>
  new LarkAvatarResolutionError(
    'API_UNAVAILABLE',
    `当前飞书 Web 网关客户端没有暴露${feature}接口`,
    { hint: '请确认 lark-avatar 版本与登录状态；该解析只复用现有 Web 会话，不会新建登录态。' }
  );

/**
 * 把外部 OpenAPI ID / 名称 / 关键字解析成 Web 内部数字 ID。
 *
 * 只读：只会调用 PullChats / PullChatters / PullMessages / history，
 * 不会发消息，也不会创建新的登录态。
 */
export class LarkAvatarIdResolver {
  private readonly cache = new Map<string, CacheEntry>();
  private readonly knownChats = new Map<string, ResolvedLarkChat>();
  private readonly now: () => number;
  private readonly ttlMs: number;
  private readonly maxScanMessages: number;
  private readonly log: { warn(message?: unknown): void };
  private listChatsAvailable?: boolean;

  constructor(private readonly options: LarkAvatarIdResolverOptions) {
    this.now = options.now ?? (() => Date.now());
    this.ttlMs = options.ttlMs ?? defaultTtlMs;
    this.maxScanMessages = options.maxScanMessages ?? defaultMaxScanMessages;
    this.log = options.log ?? { warn: () => undefined };
  }

  clear(): void {
    this.cache.clear();
    this.knownChats.clear();
    this.listChatsAvailable = undefined;
  }

  async searchChats(query: string, options: { match?: LarkChatMatchMode } = {}): Promise<LarkChatSearchResult> {
    this.requireClient();
    const raw = query.trim();
    if (!raw) throw new LarkAvatarResolutionError('INVALID_INPUT', '群名或 chat_id 不能为空');

    const directory = await this.chatDirectory();
    const byId = directory.find(entry => entry.webChatId === raw || entry.openChatId === raw);
    if (byId) {
      return { match: 'id', ambiguous: false, candidates: [this.chatCandidate(byId, 'id')] };
    }

    const wanted = normalized(raw);
    const exact = directory.filter(entry => normalized(entry.name) === wanted);
    if (exact.length) {
      return {
        match: 'exact',
        ambiguous: exact.length > 1,
        candidates: exact.map(entry => this.chatCandidate(entry, 'exact'))
      };
    }
    if (options.match === 'exact') return { match: 'none', ambiguous: false, candidates: [] };

    const fuzzy = directory.filter(entry => {
      const name = normalized(entry.name);
      return Boolean(name) && (name.includes(wanted) || wanted.includes(name));
    });
    return {
      match: fuzzy.length ? 'fuzzy' : 'none',
      ambiguous: fuzzy.length > 1,
      candidates: fuzzy.map(entry => this.chatCandidate(entry, 'fuzzy'))
    };
  }

  async resolveChat(query: string, options: { match?: LarkChatMatchMode } = {}): Promise<ResolvedLarkChat> {
    this.requireClient();
    const raw = query.trim();
    if (!raw) throw new LarkAvatarResolutionError('INVALID_INPUT', '群名或 chat_id 不能为空');

    if (numericIdPattern.test(raw) || chatIdPattern.test(raw)) return this.resolveChatByWebId(raw);

    const search = await this.searchChats(raw, options);
    if (!search.candidates.length) {
      throw new LarkAvatarResolutionError('CHAT_NOT_FOUND', `找不到群「${raw}」`, {
        hint: this.listChatsAvailable === false
          ? '当前 Web 网关没有会话列表接口；请改用 oc_* chat_id 或数字 chat_id。'
          : '只索引最近会话（最多 100 个）和本机 inbox；可以先在飞书里打开该群，或改用 oc_* chat_id。'
      });
    }
    if (search.candidates.length > 1) {
      throw new LarkAvatarResolutionError('CHAT_AMBIGUOUS', `群名「${raw}」匹配到 ${search.candidates.length} 个会话`, {
        hint: '请从候选中选择 chatId，或改用更精确的群名 / oc_* chat_id。',
        candidates: search.candidates
      });
    }

    const candidate = search.candidates[0]!;
    const resolved = await this.resolveChatByWebId(candidate.chatId);
    return this.rememberChat({
      ...resolved,
      name: resolved.name || candidate.name,
      type: resolved.type === 'unknown' ? candidate.type : resolved.type,
      ...(resolved.openChatId || candidate.openChatId ? { openChatId: resolved.openChatId ?? candidate.openChatId } : {})
    });
  }

  async searchMessages(
    chat: ResolvedLarkChat,
    keyword: string
  ): Promise<LarkMessageSearchResult> {
    this.requireClient();
    const raw = keyword.trim();
    if (!raw) throw new LarkAvatarResolutionError('INVALID_INPUT', '消息关键字不能为空');

    const messages = await this.recentMessages(chat);
    const wanted = normalized(raw);
    const matched = messages.filter(message => normalized(message.content).includes(wanted));
    return {
      match: matched.length ? 'keyword' : 'none',
      ambiguous: matched.length > 1,
      candidates: await this.messageCandidates(chat, matched)
    };
  }

  async resolveRoot(chat: ResolvedLarkChat, root: string): Promise<string> {
    const client = this.requireClient();
    const raw = root.trim();
    if (!raw) throw new LarkAvatarResolutionError('INVALID_INPUT', 'rootId 或消息关键字不能为空');

    if (numericIdPattern.test(raw)) return this.toDecimalId(raw, 'rootId');

    if (messageIdPattern.test(raw)) {
      if (!client.messagesByIds) throw apiUnavailable('按消息 ID 取消息');
      const messages = await client.messagesByIds([raw]);
      const message = messages.find(item => item.messageId === raw)
        ?? (messages.length === 1 ? messages[0] : undefined);
      if (!message) {
        throw new LarkAvatarResolutionError('ROOT_NOT_FOUND', `找不到消息 ${raw}`, {
          hint: '确认消息 ID 属于当前登录账号可见的会话；外部 OpenAPI 消息 ID 不一定是 Web 网关消息 ID。'
        });
      }
      if (!sameChatId(message.chatId, chat.webChatId)) {
        throw new LarkAvatarResolutionError('ROOT_NOT_IN_CHAT', `消息 ${raw} 不在群「${chat.name || chat.webChatId}」里`, {
          hint: '请指定该消息所在的群，或改用数字 chatId 对应的会话。'
        });
      }
      return this.messageRootId(message);
    }

    const search = await this.searchMessages(chat, raw);
    if (!search.candidates.length) {
      throw new LarkAvatarResolutionError('ROOT_NOT_FOUND', `在群「${chat.name || chat.webChatId}」最近消息里找不到关键字「${raw}」`, {
        hint: `只扫描最近 ${this.maxScanMessages} 条消息；可以改用 om_* 消息 ID 或数字 rootId。`
      });
    }
    if (search.candidates.length > 1) {
      throw new LarkAvatarResolutionError('ROOT_AMBIGUOUS', `关键字「${raw}」匹配到 ${search.candidates.length} 条消息`, {
        hint: '请从候选中挑一条更精确的关键字，或直接传消息 ID。',
        candidates: search.candidates
      });
    }

    const match = search.candidates[0]!;
    const messages = await this.recentMessages(chat);
    const message = messages.find(item => item.messageId === match.messageId);
    if (!message) {
      throw new LarkAvatarResolutionError('ROOT_NOT_FOUND', `消息 ${match.messageId} 在最近消息缓存里已失效`);
    }
    return this.messageRootId(message);
  }

  /**
   * Web 消息的 rootId 有两种历史形态：内部十进制 id 和 om_* 消息 id。
   * 十进制统一规范化成字符串；om_* 原样保留，交给 PutMessageRequest 的 string 字段。
   */
  private messageRootId(message: LarkIncomingMessage): string {
    const raw = message.rootId || message.messageId;
    if (!raw) {
      throw new LarkAvatarResolutionError('ROOT_NOT_FOUND', '消息没有可用的 rootId 或 messageId', {
        hint: '请改用数字 rootId 或 om_* 消息 ID。'
      });
    }
    return numericIdPattern.test(raw) ? this.toDecimalId(raw, '消息的 rootId') : raw;
  }

  async searchUsers(chat: ResolvedLarkChat, query: string): Promise<LarkUserSearchResult> {
    this.requireClient();
    const raw = query.trim().replace(/^@/, '').trim();
    if (!raw) throw new LarkAvatarResolutionError('INVALID_INPUT', '被 @ 的用户不能为空');

    if (numericIdPattern.test(raw)) {
      return {
        match: 'id',
        ambiguous: false,
        candidates: [{ userId: raw, name: await this.chatterName(raw), matchedBy: 'id' }]
      };
    }

    const directory = await this.chatterDirectory(chat);
    const wanted = normalized(raw);
    const emailMatches = directory.filter(entry => normalized(entry.email ?? '') === wanted);
    if (emailMatches.length) {
      return {
        match: 'email',
        ambiguous: emailMatches.length > 1,
        candidates: emailMatches.map(entry => this.userCandidate(entry, 'email'))
      };
    }

    const exact = directory.filter(entry => normalized(entry.name) === wanted);
    if (exact.length) {
      return {
        match: 'exact',
        ambiguous: exact.length > 1,
        candidates: exact.map(entry => this.userCandidate(entry, 'exact'))
      };
    }

    const fuzzy = directory.filter(entry => {
      const name = normalized(entry.name);
      return Boolean(name) && (name.includes(wanted) || wanted.includes(name));
    });
    return {
      match: fuzzy.length ? 'fuzzy' : 'none',
      ambiguous: fuzzy.length > 1,
      candidates: fuzzy.map(entry => this.userCandidate(entry, 'fuzzy'))
    };
  }

  async resolveMentions(chat: ResolvedLarkChat, mentions: string[]): Promise<ResolvedLarkMention[]> {
    const resolved = new Map<string, ResolvedLarkMention>();
    for (const input of mentions) {
      const raw = input.trim().replace(/^@/, '').trim();
      if (!raw) continue;
      const mention = await this.resolveMention(chat, raw);
      if (!resolved.has(mention.userId)) resolved.set(mention.userId, mention);
    }
    return [...resolved.values()];
  }

  async resolveTarget(input: {
    chat: string;
    root?: string;
    mentions?: string[];
    match?: LarkChatMatchMode;
  }): Promise<ResolvedLarkTarget> {
    const chat = await this.resolveChat(input.chat, { ...(input.match ? { match: input.match } : {}) });
    const rootId = input.root?.trim() ? await this.resolveRoot(chat, input.root) : undefined;
    const mentions = input.mentions?.length ? await this.resolveMentions(chat, input.mentions) : [];
    return {
      chatId: chat.chatId,
      ...(rootId !== undefined ? { rootId } : {}),
      mentions
    };
  }

  private async resolveMention(chat: ResolvedLarkChat, raw: string): Promise<ResolvedLarkMention> {
    if (numericIdPattern.test(raw)) {
      return { userId: this.toDecimalId(raw, 'userId'), name: await this.chatterName(raw) };
    }
    if (openUserIdPattern.test(raw)) {
      const chatter = await this.lookupChatter(raw);
      return {
        userId: this.toDecimalId(chatter.id, `用户 ${raw} 的 userId`),
        name: chatter.name || raw
      };
    }

    const search = await this.searchUsers(chat, raw);
    if (!search.candidates.length) {
      throw new LarkAvatarResolutionError('USER_NOT_FOUND', `在群「${chat.name || chat.webChatId}」里找不到用户「${raw}」`, {
        hint: `只能匹配本机 inbox 和最近 ${this.maxScanMessages} 条消息的参与者；更稳妥的方式是传 ou_* open_id 或数字 userId。`
      });
    }
    if (search.candidates.length > 1) {
      throw new LarkAvatarResolutionError('USER_AMBIGUOUS', `用户「${raw}」匹配到 ${search.candidates.length} 个候选`, {
        hint: '请改用 ou_* open_id、邮箱或数字 userId。',
        candidates: search.candidates
      });
    }

    const candidate = search.candidates[0]!;
    if (numericIdPattern.test(candidate.userId)) {
      return { userId: this.toDecimalId(candidate.userId, 'userId'), name: candidate.name || candidate.userId };
    }
    const chatter = await this.lookupChatter(candidate.userId);
    return {
      userId: this.toDecimalId(chatter.id, `用户 ${candidate.userId} 的 userId`),
      name: chatter.name || candidate.name || candidate.userId
    };
  }

  private async resolveChatByWebId(webChatId: string): Promise<ResolvedLarkChat> {
    return this.cached(`chat:web:${webChatId}`, async () => {
      if (numericIdPattern.test(webChatId)) {
        return this.rememberChat({
          chatId: this.toDecimalId(webChatId, '会话 chat_id'),
          webChatId,
          name: '',
          type: 'unknown'
        });
      }

      const known = [...this.knownChats.values()].find(chat => chat.openChatId === webChatId);
      if (known) return known;

      const directory = await this.chatDirectory();
      const mapped = directory.find(entry => entry.openChatId === webChatId);
      if (mapped) return this.rememberChat(this.fromDirectoryEntry(mapped, webChatId));

      // 旧网关不认识 oc_*：lookup 可能返回空、抛 API_UNAVAILABLE，或返回的 id 仍是 oc_*。
      try {
        const chat = await this.lookupChat(webChatId);
        if (chat) return this.rememberChat(this.fromChatInfo(chat, webChatId));
      } catch (error) {
        if (!(error instanceof LarkAvatarResolutionError)) throw error;
        if (error.code !== 'API_UNAVAILABLE' && error.code !== 'ID_NOT_NUMERIC') throw error;
        this.log.warn(`飞书替身按 oc_* 直查失败，尝试 OpenAPI 兜底：${error.message}`);
      }

      const hint = await this.openChatInfo(webChatId);
      if (hint?.chatId && numericIdPattern.test(hint.chatId)) {
        return this.rememberChat({
          chatId: this.toDecimalId(hint.chatId, `OpenAPI 会话 ${webChatId} 的 chat_id`),
          webChatId: hint.chatId,
          openChatId: webChatId,
          name: hint.name ?? '',
          type: 'unknown'
        });
      }
      if (hint?.name) {
        const search = await this.searchChats(hint.name, { match: 'exact' });
        if (search.candidates.length > 1) {
          throw new LarkAvatarResolutionError('CHAT_AMBIGUOUS', `OpenAPI 群「${hint.name}」在 Web 列表里匹配到 ${search.candidates.length} 个会话`, {
            hint: '请从候选中选择 chatId，或改用数字 chat_id。',
            candidates: search.candidates
          });
        }
        if (search.candidates.length === 1) {
          const entry = directory.find(item => item.webChatId === search.candidates[0]!.chatId);
          if (entry) {
            return this.rememberChat({
              ...this.fromDirectoryEntry(entry, webChatId),
              name: entry.name || hint.name
            });
          }
        }
      }

      const nextStep = this.options.openChatLookup
        ? (hint?.name
            ? `OpenAPI 找到了群「${hint.name}」，但 Web 会话列表里没有同名群；请先在飞书打开该群刷新列表，或改用数字 chat_id。`
            : 'OpenAPI 也查不到该群；请确认机器人已加入该群并具备 im:chat:readonly，或改用群名/数字 chat_id。')
        : 'Web 群列表没有返回 openChatId，当前实例也未接入 OpenAPI 群信息反查；请改用群名/数字 chat_id，或先配置飞书机器人（im:chat:readonly）后重试。';
      throw new LarkAvatarResolutionError('CHAT_NOT_FOUND', `找不到 chat_id 为 ${webChatId} 的会话`, { hint: nextStep });
    });
  }

  private fromDirectoryEntry(entry: ChatDirectoryEntry, openChatId?: string): ResolvedLarkChat {
    return {
      chatId: this.toDecimalId(entry.webChatId, `会话 ${entry.name || entry.webChatId} 的 chat_id`),
      webChatId: entry.webChatId,
      ...(openChatId ?? entry.openChatId ? { openChatId: openChatId ?? entry.openChatId } : {}),
      name: entry.name,
      type: entry.type,
      ...(entry.memberCount !== undefined ? { memberCount: entry.memberCount } : {})
    };
  }

  private fromChatInfo(chat: LarkChatInfo, fallbackWebId: string): ResolvedLarkChat {
    const webChatId = chat.id || fallbackWebId;
    return {
      chatId: this.toDecimalId(webChatId, `会话 ${chat.name || webChatId} 的 chat_id`),
      webChatId,
      ...(chat.openChatId ? { openChatId: chat.openChatId } : {}),
      name: chat.name,
      type: chatKind(chat.type),
      ...(chat.memberCount > 0 ? { memberCount: chat.memberCount } : {})
    };
  }

  private rememberChat(chat: ResolvedLarkChat): ResolvedLarkChat {
    this.knownChats.set(chat.webChatId, chat);
    return chat;
  }

  private async lookupChat(webChatId: string): Promise<LarkChatInfo | undefined> {
    const client = this.requireClient();
    if (!client.lookup) throw apiUnavailable('会话资料查询');
    const result = await client.lookup([webChatId], []);
    const direct = result.chats.get(webChatId);
    if (direct) return direct;
    // 网关可能用内部数字 id 作为返回的 key，所以单个请求时接受唯一的返回值。
    const values = [...result.chats.values()];
    return values.length === 1 ? values[0] : undefined;
  }

  private async openChatInfo(openChatId: string): Promise<{ chatId?: string; name?: string } | undefined> {
    if (!this.options.openChatLookup) return undefined;
    try {
      return await this.options.openChatLookup(openChatId);
    } catch (error) {
      this.log.warn(`飞书替身 OpenAPI 反查 ${openChatId} 失败：${error instanceof Error ? error.message : String(error)}`);
      return undefined;
    }
  }

  private async lookupChatter(webId: string): Promise<LarkChatterInfo> {
    return this.cached(`chatter:${webId}`, async () => {
      const client = this.requireClient();
      if (!client.lookup) throw apiUnavailable('用户资料查询');
      const result = await client.lookup([], [webId]);
      const direct = result.chatters.get(webId);
      const values = [...result.chatters.values()];
      const chatter = direct ?? (values.length === 1 ? values[0] : undefined);
      if (!chatter) {
        throw new LarkAvatarResolutionError('USER_NOT_FOUND', `找不到用户 ${webId}`, {
          hint: '确认该用户与当前登录账号在同一个会话；ou_* open_id 必须能被 Web 网关识别。'
        });
      }
      return chatter;
    });
  }

  private async chatterName(userId: string): Promise<string> {
    return this.cached(`name:user:${userId}`, async () => {
      try {
        const chatter = await this.lookupChatter(userId);
        return chatter.name || userId;
      } catch {
        // 数字 ID 直用时用户资料只是锦上添花，查不到就用 ID 作为名字。
        return userId;
      }
    });
  }

  private async chatDirectory(): Promise<ChatDirectoryEntry[]> {
    return this.cached('dir:chats', async () => {
      const client = this.requireClient();
      const entries = new Map<string, ChatDirectoryEntry>();

      for (const item of this.options.inbox()) {
        if (!item.chatId) continue;
        entries.set(item.chatId, {
          webChatId: item.chatId,
          name: item.chatName || item.senderName || item.chatId,
          type: chatKindFromText(item.chatType),
          lastMessageAt: item.occurredAt
        });
      }

      this.listChatsAvailable = Boolean(client.listChats);
      if (client.listChats) {
        try {
          for (const chat of await client.listChats()) this.mergeListedChat(entries, chat);
        } catch (error) {
          this.log.warn(`飞书替身解析群名时读取会话列表失败：${error instanceof Error ? error.message : String(error)}`);
        }
      }

      for (const chat of this.knownChats.values()) {
        const current = entries.get(chat.webChatId);
        entries.set(chat.webChatId, {
          webChatId: chat.webChatId,
          ...(chat.openChatId ?? current?.openChatId ? { openChatId: chat.openChatId ?? current?.openChatId } : {}),
          name: chat.name || current?.name || '',
          type: chat.type === 'unknown' ? current?.type ?? 'unknown' : chat.type,
          ...(chat.memberCount !== undefined
            ? { memberCount: chat.memberCount }
            : current?.memberCount !== undefined ? { memberCount: current.memberCount } : {}),
          ...(current?.lastMessageAt ? { lastMessageAt: current.lastMessageAt } : {})
        });
      }

      return [...entries.values()];
    });
  }

  private mergeListedChat(entries: Map<string, ChatDirectoryEntry>, chat: LarkAvailableChat): void {
    if (!chat.id) return;
    const current = entries.get(chat.id);
    const updateTime = Number.isFinite(chat.updateTime) && chat.updateTime > 0
      ? new Date(chat.updateTime < 1_000_000_000_000 ? chat.updateTime * 1000 : chat.updateTime).toISOString()
      : current?.lastMessageAt;
    entries.set(chat.id, {
      webChatId: chat.id,
      ...(chat.openChatId ?? current?.openChatId ? { openChatId: chat.openChatId ?? current?.openChatId } : {}),
      name: chat.name || current?.name || chat.id,
      type: chatKind(chat.type) === 'unknown' ? current?.type ?? 'unknown' : chatKind(chat.type),
      ...(chat.memberCount > 0
        ? { memberCount: chat.memberCount }
        : current?.memberCount !== undefined ? { memberCount: current.memberCount } : {}),
      ...(updateTime ? { lastMessageAt: updateTime } : {})
    });
  }

  private chatCandidate(entry: ChatDirectoryEntry, matchedBy: Exclude<LarkChatMatch, 'none'>): LarkChatCandidate {
    return {
      chatId: entry.webChatId,
      ...(entry.openChatId ? { openChatId: entry.openChatId } : {}),
      name: entry.name,
      type: entry.type,
      ...(entry.memberCount !== undefined ? { memberCount: entry.memberCount } : {}),
      ...(entry.lastMessageAt ? { lastMessageAt: entry.lastMessageAt } : {}),
      matchedBy
    };
  }

  private async recentMessages(chat: ResolvedLarkChat): Promise<LarkIncomingMessage[]> {
    return this.cached(`messages:${chat.webChatId}`, async () => {
      const client = this.requireClient();
      if (!client.history) throw apiUnavailable('会话历史');
      const info = await this.lookupChat(chat.webChatId);
      let before = info?.lastMessagePosition ?? 0;
      if (before <= 0) return [];

      const collected: LarkIncomingMessage[] = [];
      const seen = new Set<string>();
      while (collected.length < this.maxScanMessages && before > 0) {
        const limit = Math.min(historyPageSize, this.maxScanMessages - collected.length);
        const page = await client.history(chat.webChatId, before, limit);
        if (!page.length) break;
        for (const message of page) {
          const key = message.messageId || `${message.chatId}:${message.position}`;
          if (seen.has(key)) continue;
          seen.add(key);
          collected.push(message);
        }
        const positions = page.map(message => message.position).filter(position => Number.isFinite(position) && position > 0);
        if (!positions.length) break;
        const oldest = Math.min(...positions);
        if (oldest <= 1 || oldest >= before) break;
        before = oldest - 1;
      }
      return collected.sort((left, right) => left.position - right.position).slice(-this.maxScanMessages);
    });
  }

  private async messageCandidates(
    chat: ResolvedLarkChat,
    messages: LarkIncomingMessage[]
  ): Promise<LarkMessageCandidate[]> {
    if (!messages.length) return [];
    const names = await this.chatterNames(messages.map(message => message.fromId).filter(Boolean));
    return messages.slice(-20).map(message => {
      const senderName = names.get(message.fromId);
      const occurredAt = messageTime(message.createTime);
      return {
        messageId: message.messageId,
        content: message.content.trim().slice(0, 160),
        ...(message.position > 0 ? { position: message.position } : {}),
        ...(message.fromId ? { senderId: message.fromId } : {}),
        ...(senderName ? { senderName } : {}),
        ...(occurredAt ? { occurredAt } : {})
      };
    });
  }

  private async chatterNames(userIds: string[]): Promise<Map<string, string>> {
    const names = new Map<string, string>();
    if (!userIds.length) return names;
    const client = this.requireClient();
    if (!client.lookup) return names;
    try {
      const result = await client.lookup([], [...new Set(userIds)]);
      for (const [id, chatter] of result.chatters) {
        if (chatter.name) names.set(id, chatter.name);
        if (chatter.id !== id && chatter.name) names.set(chatter.id, chatter.name);
      }
    } catch (error) {
      this.log.warn(`飞书替身解析消息发送者失败：${error instanceof Error ? error.message : String(error)}`);
    }
    return names;
  }

  private async chatterDirectory(chat: ResolvedLarkChat): Promise<ChatterDirectoryEntry[]> {
    return this.cached(`dir:users:${chat.webChatId}`, async () => {
      const entries = new Map<string, ChatterDirectoryEntry>();
      for (const item of this.options.inbox()) {
        if (!sameChatId(item.chatId, chat.webChatId) || !item.senderId) continue;
        entries.set(item.senderId, {
          webId: item.senderId,
          name: item.senderName || item.senderId
        });
      }

      let messages: LarkIncomingMessage[] = [];
      try {
        messages = await this.recentMessages(chat);
      } catch (error) {
        if (!entries.size) throw error;
      }

      const ids = new Set<string>();
      for (const message of messages) {
        if (message.fromId) ids.add(message.fromId);
        for (const id of message.atUserIds) if (id) ids.add(id);
      }
      if (ids.size) {
        const client = this.requireClient();
        if (client.lookup) {
          try {
            const result = await client.lookup([], [...ids]);
            for (const chatter of result.chatters.values()) {
              if (!chatter.id) continue;
              entries.set(chatter.id, {
                webId: chatter.id,
                name: chatter.name || chatter.id,
                ...(chatter.email ? { email: chatter.email } : {})
              });
            }
          } catch (error) {
            this.log.warn(`飞书替身解析群成员失败：${error instanceof Error ? error.message : String(error)}`);
          }
        }
      }

      return [...entries.values()];
    });
  }

  private userCandidate(entry: ChatterDirectoryEntry, matchedBy: Exclude<LarkUserMatch, 'none'>): LarkUserCandidate {
    return {
      userId: entry.webId,
      name: entry.name,
      ...(entry.email ? { email: entry.email } : {}),
      matchedBy
    };
  }

  private requireClient(): LarkProtocolClientLike {
    if (!this.options.isLoggedIn()) {
      throw notLoggedIn('飞书替身尚未登录', '请先扫码登录或导入 Cookie，再发起解析。');
    }
    const client = this.options.client();
    if (!client) {
      throw notLoggedIn('飞书替身 Web 网关未连接', '请在设置里开启监听（listening）以建立复用现有登录态的 Web 长连接。');
    }
    return client;
  }

  /** 只校验十进制与 int64 范围，返回规范字符串；不经过 Number，19 位 id 不会丢精度。 */
  private toDecimalId(value: string, label: string): string {
    const text = value.trim();
    if (!numericIdPattern.test(text)) {
      throw new LarkAvatarResolutionError('ID_NOT_NUMERIC', `${label} 不是 Web 数字 ID：${text || '(空)'}`, {
        hint: 'oc_/om_/ou_ 前缀是 OpenAPI ID，不能直接当数字用；oc_* 群可用群名或 OpenAPI 反查。'
      });
    }
    const id = BigInt(text);
    if (id <= 0n || id > 9223372036854775807n) {
      throw new LarkAvatarResolutionError('ID_OUT_OF_RANGE', `${label} 超出 int64 范围：${text}`, {
        hint: '飞书 Web 数字 ID 必须是 1..2^63-1 的十进制整数。'
      });
    }
    return id.toString();
  }

  private cached<T>(key: string, load: () => Promise<T>): Promise<T> {
    const now = this.now();
    const hit = this.cache.get(key);
    if (hit && hit.expiresAt > now) return hit.value as Promise<T>;
    if (hit) this.cache.delete(key);

    const entry: CacheEntry = {
      expiresAt: now + this.ttlMs,
      value: load()
    };
    entry.value = entry.value.catch(error => {
      if (this.cache.get(key) === entry) this.cache.delete(key);
      throw error;
    });
    this.cache.set(key, entry);
    return entry.value as Promise<T>;
  }
}
