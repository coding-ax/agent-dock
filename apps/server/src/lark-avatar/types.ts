export const inboxTiers = ['action', 'fyi', 'noise'] as const;
export type InboxTier = (typeof inboxTiers)[number];

export const inboxStates = ['new', 'handled'] as const;
export type InboxState = (typeof inboxStates)[number];

export const draftStates = ['pending', 'sent', 'failed', 'discarded'] as const;
export type DraftState = (typeof draftStates)[number];

export const avatarStates = ['disconnected', 'connecting', 'connected', 'expired'] as const;
export type AvatarState = (typeof avatarStates)[number];

export const larkRegionNames = ['feishu', 'lark'] as const;
export type LarkRegionName = (typeof larkRegionNames)[number];

export const replyModes = ['direct', 'quote', 'thread'] as const;
export type LarkAvatarReplyMode = (typeof replyModes)[number];

export const contextScopes = ['anchor', 'chat'] as const;
export type LarkAvatarContextScope = (typeof contextScopes)[number];

export const loginStates = ['idle', 'starting', 'waiting', 'scanned', 'success', 'failed', 'expired'] as const;
export type LarkAvatarLoginState = (typeof loginStates)[number];

export type JsonObject = Record<string, unknown>;

export interface LarkAvatarAccount {
  userId: string;
  name: string;
  avatarUrl?: string;
  email?: string;
}

export interface LarkAvatarChatSummary {
  id: string;
  name: string;
  type: 'p2p' | 'group' | 'topic' | 'unknown';
  avatarUrl?: string;
  memberCount?: number;
  lastMessageAt?: string;
}

/** 飞书网页端本人身份凭证。只保存在本地，管理面不会下发。 */
export interface LarkAvatarCredentials {
  region: LarkRegionName;
  cookies: Record<string, string>;
  savedAt: number;
  deviceId: string;
  appKey: string;
  userId: string;
  csrfToken: string;
  webAppId: string;
}

export interface LarkAvatarConfig {
  region: LarkRegionName;
  /** 飞书消息以此前缀触发 Agent，默认 /ai。 */
  triggerPrefix: string;
  /** 每次触发时带入最近多少条消息作为上下文。 */
  contextMessages: number;
  /** 哪些消息共用同一个 Agent 会话：按聊天+话题，或只按聊天。 */
  contextScope: LarkAvatarContextScope;
  /** 话题内的消息是否回到原话题；关闭后发到主会话。 */
  replyInTopic: boolean;
  /** 主会话消息的回复方式：直接发送、引用回复或开话题回复。 */
  replyMode: LarkAvatarReplyMode;
  /** 触发后先在原消息上加 2–3 个随机飞书表情回应。 */
  emojiReactions: boolean;
  /** 加在 Agent 发出的每条消息末尾。 */
  replySignature: string;
  /** Agent 单轮超时秒数；0 表示不限制。 */
  agentTimeoutSeconds: number;
  /** 是否接收 WebSocket 推送和定时补拉；关闭后保留登录凭证。 */
  listening: boolean;
  listenChats: string[];
  /** 兼容旧配置；触发权限固定为本人，其他发送者只作为上下文。 */
  allowedSenders: string[];
  /** 触发时使用的 Agent；为空时跟随服务默认值。 */
  agentId: string;
  /** 空字符串表示使用 Agent 的默认模型。 */
  model: string;
  /** 空字符串表示使用 Agent 的默认推理强度。 */
  reasoningEffort: string;
  /** 空字符串表示使用服务默认工作目录。 */
  workspace: string;
}

export interface LarkAvatarState {
  id: string;
  config: LarkAvatarConfig;
  account?: LarkAvatarAccount;
  state: AvatarState;
  lastError?: string;
  createdAt: string;
  updatedAt: string;
}

/** 管理面可安全下发的配置：Cookie 和 ticket 永远不进入这个对象。 */
export interface PublicLarkAvatarConfig {
  region: LarkRegionName;
  triggerPrefix: string;
  contextMessages: number;
  contextScope: LarkAvatarContextScope;
  replyInTopic: boolean;
  replyMode: LarkAvatarReplyMode;
  emojiReactions: boolean;
  replySignature: string;
  agentTimeoutSeconds: number;
  listening: boolean;
  listenChats: string[];
  allowedSenders: string[];
  agentId: string;
  model: string;
  reasoningEffort: string;
  workspace: string;
}

export interface PublicLarkAvatarState extends Omit<LarkAvatarState, 'config'> {
  config: PublicLarkAvatarConfig;
}

export interface LarkAvatarLoginSnapshot {
  state: LarkAvatarLoginState;
  message: string;
  region: LarkRegionName;
  qrContent?: string;
  attempt: number;
  expiresAt?: string;
}

export interface LarkAvatarInboxItem {
  id: string;
  threadKey: string;
  messageId: string;
  chatId: string;
  chatType: string;
  chatName?: string;
  chatAvatarUrl?: string;
  senderId?: string;
  senderName?: string;
  senderAvatarUrl?: string;
  title: string;
  summary?: string;
  tier: InboxTier;
  tierReason?: string;
  state: InboxState;
  occurredAt: string;
  receivedAt: string;
  payload: JsonObject;
}

export interface LarkAvatarDraft {
  id: string;
  itemId?: string;
  threadKey?: string;
  target: string;
  replyRootId?: string;
  replyQuote?: boolean;
  replyThreadChat?: boolean;
  body: string;
  state: DraftState;
  sentMessageId?: string;
  idempotencyKey: string;
  attempts: number;
  lastError?: string;
  createdAt: string;
  updatedAt: string;
  sentAt?: string;
}
