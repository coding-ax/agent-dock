import { isLarkOperatorAllowed, resolveLarkAccessConfig } from './access-config.js';
import { EventDispatcher, LoggerLevel, WSClient } from './sdk.js';
import type { WSClient as LarkWSClient } from './sdk.js';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import type { AgentConfig, AgentEvent, AskUserQuestionAnswerItem, AskUserQuestionAnswerPayload, AskUserQuestionSpec, ConfirmActionInteractionPayload, ConfirmActionSpec, ConfigRepository, ChannelMappingRepository, PermissionMode, Session, TaskRecord, ToolRiskPolicy } from '@agent-dock/agent-dock-shared';
import { defaultHighRiskPattern, defaultLarkTraceLimit, readLarkConfig, type StoredLarkConfig } from './config.js';
import { parseLarkMessageContent, type LarkMessageResource } from './message-content.js';
import { boundLarkCardElements, createLarkCardService, larkIdentityPermissionHelp, LarkServiceError, type LarkCardActionButton, type LarkCardService } from './service.js';
import { clearSessionReplyMode, getSessionReplyMode, type AgentReplyMode } from './agent-tools.js';
import { larkHandoverChannel } from './handover-binding.js';
import { LarkTurnTracker } from './turn-tracker.js';
import { buildSideSessionSeed, matchSideChatTrigger, readSideChatConfig, type SideChatConfig } from '../side-chat-config.js';
import { readAskUserQuestionConfig, type AskUserQuestionService } from '../ask-user-question.js';
import { readOutputPluginsGlobalConfig, type OutputPluginService } from '../output-plugins/service.js';
import {
  LARK_ASK_CARD_CHANNEL,
  type PersistedLarkAskCard
} from './ask-user-question-card.js';
import {
  cardChannelForOutputPlugin,
  defaultLarkOutputPluginAdapterRegistry,
  dispatchLarkOutputPluginCard,
  LARK_OUTPUT_PLUGIN_CARD_CHANNEL,
  type LarkOutputPluginAdapterRegistry,
  type PersistedLarkOutputPluginCard
} from './output-plugins/index.js';
import {
  buildRegexTriggerPrompt,
  findMatchingRealtimeRegexTrigger,
  recordLarkRegexTriggerHit,
  type LarkRegexReplyMode,
  type LarkRegexTriggerHitType
} from './regex-triggers.js';
import {
  ASK_USER_QUESTION_ANSWER_ORIGIN,
  BUILTIN_ASK_USER_QUESTION_PLUGIN_ID,
  BUILTIN_CONFIRM_ACTION_PLUGIN_ID,
  CONFIRM_ACTION_INTERACTION_ORIGIN,
  defaultOutputPluginRegistry,
  formatAskUserQuestionAnswerForAgent,
  formatConfirmActionInteractionForAgent,
  isAgentStreamErrorText,
  isAgentWarningText,
  isCarriedOverToolCall,
  normalizeOutputPluginId,
  now,
  pickFinalAssistantEntry,
  resolveOutputPluginEnabled,
  serializeAskUserQuestionAnswer,
  serializeConfirmActionInteraction,
  stripAgentStreamErrorSuffix,
  summarizeAskUserQuestionAnswer,
  type OutputPluginRegistry,
  unresolvedToolCallsAfterAnswer
} from '@agent-dock/agent-dock-shared';

type ListenerLog = {
  info(details: unknown, message?: string): void;
  warn(details: unknown, message?: string): void;
  error(details: unknown, message?: string): void;
};

export interface LarkRuntime {
  start(input: { agentId: string; cwd?: string; model?: string; reasoningEffort?: string; systemPrompt?: string; permissionMode?: PermissionMode; source?: string; sourceId?: string }): Promise<Session>;
  listAgents?(): Promise<AgentConfig[]>;
  listSessions?(): Promise<Session[]>;
  getSession(id: string): Promise<Session | undefined>;
  stop?(id: string): Promise<unknown>;
  setPermissionMode?(id: string, mode: PermissionMode): Promise<Session>;
  send(id: string, prompt: string, agentPrompt?: string): Promise<unknown>;
  dispatch?(id: string, prompt: string, mode?: 'queue' | 'interrupt', agentPrompt?: string, riskPolicy?: ToolRiskPolicy, origin?: string, clientMessageId?: string): Promise<{ id: string; status: string; queuedAhead?: number }>;
  getTasks?(id: string): Promise<TaskRecord[]>;
  getEvents?(id: string, afterSequence?: number): Promise<AgentEvent[]>;
  getRecentEvents?(id: string, limit: number): Promise<AgentEvent[]>;
  interrupt(id: string): Promise<unknown>;
  cancelQueued?(id: string, taskId: string): Promise<unknown>;
  archive?(id: string): Promise<unknown>;
  setRiskPolicy?(id: string, policy?: ToolRiskPolicy): Promise<unknown>;
  subscribe(sessionId: string, listener: (event: AgentEvent) => void): () => void;
}

export interface LarkMessageEvent {
  messageId: string;
  chatId: string;
  chatType: string;
  createTime?: string;
  rootId?: string;
  parentId?: string;
  threadId?: string;
  messageType: string;
  content: string;
  senderOpenId?: string;
  senderType?: string;
  mentions: Array<{ key: string; name: string; openId?: string; appId?: string; mentionedType?: string }>;
}

/** `im.message.reaction.created_v1` 的本地精简形态；正文/聊天需再按 message_id 查询。 */
export interface LarkReactionEvent {
  messageId: string;
  emojiType: string;
  operatorType: 'user' | 'bot' | 'app' | 'unknown';
  operatorId?: string;
  /** operatorId 来自哪个字段；白名单只存 open_id，其他形态需要先解析或直接 fail-closed。 */
  operatorIdentity?: 'open_id' | 'user_id' | 'union_id' | 'app_id';
  appId?: string;
  actionTime?: string;
}

/**
 * `im.message.reaction.created_v1` 原始事件 → 本地精简形态。
 * 飞书不同版本可能只给其中一个 user_id 字段；app 反应只带 app_id。
 */
export function parseLarkReactionEvent(raw: unknown): LarkReactionEvent | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const event = raw as Record<string, any>;
  const messageId = String(event.message_id ?? '').trim();
  const emojiType = String(event.reaction_type?.emoji_type ?? '').trim();
  if (!messageId || !emojiType) return undefined;
  const operatorTypeRaw = String(event.operator_type ?? '').toLowerCase();
  const operatorType = operatorTypeRaw === 'user' || operatorTypeRaw === 'bot' || operatorTypeRaw === 'app'
    ? operatorTypeRaw
    : 'unknown';
  const identity: LarkReactionEvent['operatorIdentity'] | undefined = event.user_id?.open_id
    ? 'open_id'
    : event.user_id?.user_id
      ? 'user_id'
      : event.user_id?.union_id
        ? 'union_id'
        : event.app_id
          ? 'app_id'
          : undefined;
  const operatorId = String(event.user_id?.open_id ?? event.user_id?.user_id ?? event.user_id?.union_id ?? event.app_id ?? '').trim();
  return {
    messageId,
    emojiType,
    operatorType,
    ...(identity ? { operatorIdentity: identity } : {}),
    ...(operatorId ? { operatorId } : {}),
    ...(event.app_id ? { appId: String(event.app_id) } : {}),
    ...(event.action_time ? { actionTime: String(event.action_time) } : {})
  };
}

export interface LarkListener {
  readonly listening: boolean;
  start(config: StoredLarkConfig): Promise<void>;
  stop(): void;
  coordinatorFor?(): LarkMessageCoordinator | undefined;
}

type TraceEntry = { type: AgentEvent['type']; data: Record<string, any>; timestamp: string };
type TraceGroup = { narratives: TraceEntry[]; actions: TraceEntry[] };
type LarkCardElement = Record<string, any>;
type LarkGroup = { sessionId?: string; sessionConfigKey?: string; /** 「托管给机器人」绑定到的目标会话：这个群只驱动它。 */ boundSessionId?: string; /** 会话级静态上下文已注入到哪条会话、内容签名是什么；相同就不再每轮重复注入。 */ staticPrompt?: { sessionId: string; signature: string }; tail: Promise<void> };
type LarkTaskState = 'queued' | 'running' | 'interrupting' | 'interrupted' | 'completed' | 'failed';
type LarkTask = {
  id: string;
  group: LarkGroup;
  event: LarkMessageEvent;
  prompt: string;
  resources: LarkMessageResource[];
  config: StoredLarkConfig;
  state: LarkTaskState;
  events: AgentEvent[];
  lastSuccessfulElements?: LarkCardElement[];
  sessionId?: string;
  cardMessageId?: string;
  runtimeTaskId?: string;
  startedAt?: number;
  interruptRequested?: boolean;
  requestUpdate?: (state: 'queued' | 'running' | 'completed' | 'failed' | 'interrupted', completed?: boolean) => Promise<void>;
  retryable?: boolean;
  /** 递增的轮次编号，用于防止上一轮的终态回调覆盖重试后的新状态。 */
  turn: number;
  /** 已提示过「归档并重开」，避免同一失效会话反复弹操作按钮。 */
  reopenOffered?: boolean;
  /** Agent 通过 group reply-mode 工具指定的回复方式；未指定时按默认逻辑（parent_id）决定。 */
  replyMode?: AgentReplyMode;
  /** 侧边对话强制以话题形式回复触发消息（reply_in_thread），无论群聊还是私聊。 */
  forceReplyInThread?: boolean;
  /** 命中群聊正则监听规则或历史补偿时的上下文。 */
  regexTrigger?: {
    ruleId: string;
    ruleName: string;
    chatName: string;
    pattern: string;
    flags: string;
    replyMode: LarkRegexReplyMode;
    promptTemplate: string;
    matchedText: string;
    messagePreview: string;
    senderName?: string;
    triggerType: LarkRegexTriggerHitType;
    allowBotSender?: boolean;
    backfillByAdmin?: boolean;
  };
  /** 记录本轮预检或启动阶段的失败原因，便于历史补偿 API 回传精准报错。 */
  failureReason?: string;
  /** 命中侧边对话触发词时的上下文：按 SideChatConfig 创建并绑定侧边会话，不阻塞主会话。 */
  sideChat?: {
    parentGroupKey: string;
    parentSourceId: string;
    triggerRootId: string;
    config: SideChatConfig;
  };
  /** 任务来源（例如 AskUserQuestion 作答轮次为 ask-user-question-answer）。 */
  origin?: string;
  /** 覆盖发给 Agent 的自然语言正文（当 task.prompt 承载结构化载荷时使用）。 */
  agentPromptOverride?: string;
  /** 客户端幂等键，用于防重派发。 */
  clientMessageId?: string;
  /** 卡片顶栏展示用的可读任务摘要（避免暴露结构化 JSON）。 */
  taskDisplayName?: string;
  /** 由卡片回调发起的续跑轮次无需给原消息贴确认表情。 */
  skipReaction?: boolean;
};

export interface LarkCardActionContext {
  formValue?: Record<string, unknown>;
  openMessageId?: string;
  openChatId?: string;
  option?: string;
  inputValue?: string;
}
type PersistedLarkCardTask = {
  app_id: string;
  chat_id: string;
  reply_message_id?: string;
  reply_in_thread?: boolean;
  /** @deprecated 兼容旧记录；历史版本可能错误地写入 omt_* thread_id。 */
  root_message_id?: string;
  card_message_id: string;
  runtime_task_id?: string;
  task_name: string;
  prompt: string;
  state: LarkTaskState;
  started_at: number;
  last_successful_elements?: LarkCardElement[];
  /** 对账重试次数：原卡更新失败（非不可更新错误）时累计，达到上限后不再等待下次对账。 */
  reconcile_attempts?: number;
};
const acknowledgementEmojis = ['OK', 'THUMBSUP', 'FINGERHEART', 'APPLAUSE', 'JIAYI'] as const;

// 飞书长连接重连策略：网络长时间不可用（如 DNS 持续失败）时，SDK 默认按服务端下发的
// 固定间隔无限重试，会持续刷屏并空耗资源。这里统一走指数退避并设置硬性次数上限。
const larkReconnectMaxAttempts = 20;
const larkReconnectBaseIntervalMs = 1_000;
const larkReconnectMaxIntervalMs = 60_000;
const larkReconnectMultiplier = 2;
/** 单轮重连全部耗尽后的冷却时间：冷却后开新一轮，保证长时间断网恢复后机器人能自愈合。 */
const larkReconnectCooldownMs = 60_000;

const larkCardChannel = (appId: string) => `lark-card:${appId}`;
export const larkSideChatThreadChannel = (appId: string) => `lark-side-chat:${appId}`;
export { larkHandoverChannel } from './handover-binding.js';
const terminalTaskStates = new Set(['completed', 'failed', 'interrupted', 'cancelled']);
// 群名列表只用于身份注入，且注入里最多展示 20 个群名，因此分页与等待都设上限：
// 它在每轮群聊的关键路径上，不能让「机器人在几百个群里」或「飞书变慢」拖住用户的回复。
const maxChatNamePages = 5;
const chatNamesTimeoutMs = 2_000;
/** 原卡更新失败（非不可更新错误）的最大对账重试次数，超过后不再等待下次对账，直接尝试补发新卡片。 */
const MAX_RECONCILE_ATTEMPTS = 20;
const persistedCardTask = (value?: string | null): PersistedLarkCardTask | undefined => {
  if (!value) return;
  try {
    const parsed = JSON.parse(value) as Partial<PersistedLarkCardTask>;
    if (!parsed.app_id || !parsed.chat_id || !parsed.card_message_id || !parsed.task_name || !parsed.state || !Number.isFinite(parsed.started_at)) return;
    return parsed as PersistedLarkCardTask;
  } catch { return; }
};

// 只放「决定会话身份」的配置：换 Agent 或换工作区意味着必须开新会话。
// defaultModel / defaultReasoningEffort 只是「新会话的默认值」，改它们不该打断进行中的会话：
// 会话自己持有 model / reasoningEffort，要改某条会话的模型请走 session 级接口。
const larkSessionConfigKey = (config: StoredLarkConfig) => JSON.stringify([
  config.defaultAgentId ?? null,
  config.workspace ?? null
]);

// 群聊不能按 chat_id 复用同一个 Agent 会话，否则不同话题/提问人的历史和预注入 Prompt 会串在一起。
// 话题群优先按 thread_id 隔离，让同一话题内的连续追问复用同一会话；
// 普通群聊没有 thread_id 时，根据 groupSessionScope 配置决定：user=按发送人隔离，chat=全群共享。
const larkGroupScopeId = (event: LarkMessageEvent, groupSessionScope: 'user' | 'chat' = 'user') => {
  if (event.chatType !== 'group') return event.chatType;
  const thread = event.threadId?.trim();
  if (thread) return `thread:${thread}`;
  if (groupSessionScope === 'chat') return 'chat';
  const actor = event.senderOpenId?.trim();
  if (actor) return `user:${actor}`;
  return `message:${event.messageId}`;
};

const larkGroupKey = (event: LarkMessageEvent, groupSessionScope: 'user' | 'chat' = 'user') => `${event.chatId}:${larkGroupScopeId(event, groupSessionScope)}`;

const larkReplyContext = (event: LarkMessageEvent) => ({
  // 回复 API 的路径参数只能使用真实的 om_* 消息 ID。回复触发消息即可保留准确的上下文位置。
  messageId: event.messageId,
  // 有 thread_id 的消息一定在某个话题里（话题群的所有消息、或普通群的话题消息），
  // 回复时应在话题内回复，避免脱离话题跑到群主流。
  // 没有 thread_id 的是群主流消息，直接回复即可。
  ...(event.threadId?.trim() ? { replyInThread: true } : {})
});

const larkSourceId = (config: StoredLarkConfig, chatId: string, chatType: string, scopeId: string) => {
  const base = `${config.appId}:${chatId}:${chatType}`;
  // sourceId 会持久化到 runtime session；群聊追加 scopeId 后，私聊仍保持旧格式，群聊则能按话题或发送人复用会话。
  return chatType === 'group' ? `${base}:${scopeId}` : base;
};

const escapeRegExpLiteral = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * 处理正文里的 @：只移除对**本机器人**的 @——那只是唤醒动作，不属于 prompt 内容。
 * 对其他人的 @ 必须保留（@韩伟 是任务语义的一部分）：
 * - text 消息正文里是 @_user_N 占位符（mention.key），替换成可读的 @名字；
 * - post 消息解析后本身已是 @名字，原样不动。
 */
function renderPromptMentions(
  text: string,
  mentions: ReadonlyArray<{ key?: string; name?: string; openId?: string; appId?: string; mentionedType?: string }>,
  isSelfMention: (mention: { key?: string; name?: string; openId?: string; appId?: string; mentionedType?: string }) => boolean
): string {
  for (const mention of mentions) {
    if (isSelfMention(mention)) {
      if (mention.key) text = text.replaceAll(mention.key, '');
      if (mention.name) text = text.replace(new RegExp(`@${escapeRegExpLiteral(mention.name)}`, 'g'), '');
    } else if (mention.key) {
      text = text.replaceAll(mention.key, `@${mention.name}`);
    }
  }
  return text;
}

async function parsePrompt(
  event: LarkMessageEvent,
  selfMention: (mention: { key?: string; name?: string; openId?: string; appId?: string; mentionedType?: string }) => boolean,
  service?: Pick<LarkCardService, 'getMessage' | 'getUserName'>,
  trace?: { log?: ListenerLog; appId?: string; stripSideChatTriggerPrefix?: string }
) {
  const { log, appId, stripSideChatTriggerPrefix } = trace ?? {};
  // 合并转发（merge_forward）消息不自动展开，只返回带 message_id 的占位提示；
  // Agent 如需查看转发内容，可通过群协作工具按 message_id 拉取。
  const parsed = await parseLarkMessageContent(event.messageType, event.content, {
    messageId: event.messageId
  });
  let text = renderPromptMentions(parsed.text, event.mentions, selfMention);
  text = text.trim();
  if (stripSideChatTriggerPrefix) {
    const matched = matchSideChatTrigger(text, stripSideChatTriggerPrefix);
    if (matched.matched) text = matched.prompt;
  }

  const quotedResources: LarkMessageResource[] = [];
  // 并行获取：当前发送者名字 + 被引用消息（如有）。两者失败都不影响主流程。
  const [senderName, parentIdBlock] = await Promise.all([
    (async () => {
      if (!event.senderOpenId || !service?.getUserName) return '';
      try {
        const name = await service.getUserName(event.senderOpenId);
        if (name) return name;
        // 飞书对无权限的字段是静默省略：接口 code 仍为 0，但 user 里没有 name。
        // 这时只能退回 open_id，且必须留下日志——否则线上表现就是 prompt 里冒出裸 ou_ 前缀，
        // 没有任何线索可查。
        log?.warn(
          { appId, chatId: event.chatId, messageId: event.messageId, senderOpenId: event.senderOpenId },
          '飞书发送人姓名解析为空，本轮 prompt 用 open_id 代替；请确认该应用已开通 contact:user.base:readonly，且发送人在应用通讯录可见范围内'
        );
        return event.senderOpenId;
      } catch (error) {
        log?.warn(
          { error, appId, chatId: event.chatId, messageId: event.messageId, senderOpenId: event.senderOpenId },
          '飞书发送人姓名解析失败，本轮 prompt 用 open_id 代替'
        );
        return event.senderOpenId;
      }
    })(),
    (async () => {
      if (!event.parentId || !service) return '';
      try {
        const parent = await service.getMessage(event.parentId);
        const parentParsed = await parseLarkMessageContent(parent.messageType, parent.rawContent, {
          messageId: parent.messageId
        });
        quotedResources.push(...parentParsed.resources.map(resource => ({ ...resource, messageId: parent.messageId })));
        // 单条消息 GET 只回 sender.id（open_id），不回 sender.name——不补解析就会在 prompt 里
        // 冒出裸 ou_，和「当前消息」那行已经解析出姓名形成明显割裂。走与当前发送人同一条路径补名字，
        // 查不到就退回 id：不能因为查名字失败把整块引用信息丢掉。
        let parentSender = parent.sender.name ?? '';
        if (!parentSender && parent.sender.id && service.getUserName) {
          try { parentSender = await service.getUserName(parent.sender.id); }
          catch (error) {
            log?.warn({ error, appId, chatId: event.chatId, messageId: parent.messageId, senderOpenId: parent.sender.id }, '引用消息发送人姓名解析失败，prompt 用 open_id 代替');
          }
        }
        parentSender = parentSender || parent.sender.id || '未知用户';
        // 引用消息不把完整文本塞进 prompt（避免每轮重复携带大段内容），只提供 message id，
        // 并给出与当前消息的清晰分界；Agent 需要原文时用 group message <id> 拉取。
        return `==== 引用消息 ====\n发送者：${parentSender}\n消息 id：${parent.messageId}\n（如需查看被引用消息完整内容，可用 group message ${parent.messageId} 拉取）\n\n==== 当前消息 ====\n`;
      } catch {
        // 被引用消息可能已删除或机器人无权访问，忽略即可。
        return '';
      }
    })()
  ]);

  const current = senderName && text ? `${senderName}: ${text}` : text;
  const prompt = parentIdBlock ? parentIdBlock + current : current;
  return { prompt, resources: [...quotedResources, ...parsed.resources] };
}

const resourceExtensions: Record<string, string> = {
  'image/jpeg': '.jpg', 'image/png': '.png', 'image/gif': '.gif', 'image/webp': '.webp',
  'application/pdf': '.pdf', 'text/plain': '.txt', 'audio/mpeg': '.mp3', 'video/mp4': '.mp4'
};

const safeResourceName = (resource: LarkMessageResource, contentType?: string) => {
  const hash = createHash('sha256').update(`${resource.type}:${resource.key}`).digest('hex').slice(0, 12);
  const supplied = resource.fileName ? basename(resource.fileName).replace(/[^\p{L}\p{N}._ -]/gu, '_').slice(0, 120) : '';
  return supplied ? `${hash}-${supplied}` : `${resource.type}-${hash}${resourceExtensions[contentType ?? ''] ?? ''}`;
};

const resourceFailureGuidance = (error: unknown) => {
  const upstreamCode = error instanceof LarkServiceError ? Number(error.details?.upstreamCode) : undefined;
  const httpStatus = error instanceof LarkServiceError ? Number(error.details?.httpStatus) : undefined;
  if (upstreamCode === 234002 || upstreamCode === 14005) {
    return '该错误通常表示机器人无权访问这条消息所在的会话，或附件已被删除，并非缺少 API scope；请用户重新上传附件，并确认机器人仍在对应会话中。';
  }
  // 5xx 服务端错误（如 code 40007 的内部错误）通常是飞书侧瞬时故障，已自动重试；
  // 若仍失败，提示用户稍后重试或重新上传，而非误导为权限问题。
  if (httpStatus !== undefined && httpStatus >= 500 && httpStatus < 600) {
    return '该错误来自飞书服务端瞬时故障（已自动重试），通常稍后即可恢复；如持续失败，请用户重新上传附件。';
  }
  const consoleUrl = error instanceof LarkServiceError && typeof error.details?.consoleUrl === 'string' ? error.details.consoleUrl : undefined;
  return `请管理员确认机器人已开通 \`im:message:readonly\` 权限${consoleUrl ? `，权限配置地址：${consoleUrl}` : ''}；如果权限已开通，请用户重新上传可能已过期或删除的附件。`;
};

export const isLarkMessageRateLimit = (error: unknown): error is LarkServiceError => error instanceof LarkServiceError
  && Number(error.details?.upstreamCode) === 230020;

export const larkRateLimitBackoffMs = (failures: number) => Math.min(60_000, 5_000 * (2 ** Math.max(0, failures - 1)));

export const isLarkCardContentRejected = (error: unknown): error is LarkServiceError => error instanceof LarkServiceError
  && [230028, 230099].includes(Number(error.details?.upstreamCode));

export const isLarkMessageUnupdatable = (error: unknown): error is LarkServiceError => error instanceof LarkServiceError
  && [230012, 230030].includes(Number(error.details?.upstreamCode));

const rejectedDeltaElement = (changedCount: number): LarkCardElement => ({
  tag: 'markdown',
  element_id: 'agentdock_rejected_delta',
  content: `<font color='orange'>本次新增或变化的 ${Math.max(1, changedCount)} 个内容区块未通过飞书审核，已保留上一次成功内容；完整增量请在 AgentDock Web 查看。</font>`,
  text_size: 'notation',
  margin: '8px 0px 0px 0px'
});

export function patchRejectedCardDelta(previous: LarkCardElement[] = [], current: LarkCardElement[] = []): LarkCardElement[] {
  const baseline = previous.filter(element => element.element_id !== 'agentdock_rejected_delta');
  const same = (left: LarkCardElement, right: LarkCardElement) => JSON.stringify(left) === JSON.stringify(right);
  let prefix = 0;
  while (prefix < baseline.length && prefix < current.length && same(baseline[prefix]!, current[prefix]!)) prefix++;
  let suffix = 0;
  while (
    suffix < baseline.length - prefix
    && suffix < current.length - prefix
    && same(baseline[baseline.length - 1 - suffix]!, current[current.length - 1 - suffix]!)
  ) suffix++;
  const previousChangedEnd = baseline.length - suffix;
  const currentChangedCount = Math.max(1, current.length - prefix - suffix);
  return boundLarkCardElements([
    ...baseline.slice(0, prefix),
    ...baseline.slice(prefix, previousChangedEnd),
    rejectedDeltaElement(currentChangedCount),
    ...(suffix ? current.slice(current.length - suffix) : [])
  ]);
}

async function materializeLarkResources(messageId: string, prompt: string, resources: LarkMessageResource[], service: Pick<LarkCardService, 'downloadMessageResource'>) {
  if (!resources.length) return prompt;
  const directory = join(tmpdir(), 'agent-dock', 'lark-resources', messageId.replace(/[^a-zA-Z0-9_-]/g, '_'));
  const notes: string[] = [];
  for (const resource of resources) {
    try {
      const downloaded = await service.downloadMessageResource(resource.messageId ?? messageId, resource.key, resource.type);
      await mkdir(directory, { recursive: true, mode: 0o700 });
      const path = join(directory, safeResourceName(resource, downloaded.contentType));
      await writeFile(path, downloaded.data, { mode: 0o600 });
      notes.push(`- ${resource.label}已下载到本地：${path}。请使用本地文件读取工具查看。`);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      notes.push(`- ${resource.label}下载失败：${reason}。你无法读取该附件；请在回复中明确告知用户。${resourceFailureGuidance(error)}`);
    }
  }
  return `${prompt}\n\n[AgentDock 飞书附件处理结果]\n${notes.join('\n')}`.trim();
}

// 群消息统一回复触发消息；有 thread_id 的消息显式 reply_in_thread，避免卡片脱离提问人的话题。
// input 可携带 replyInThread / forceMainThread 覆盖默认的「按 thread_id 判断」逻辑，供 Agent 或正则规则指定回复方式。
async function sendTaskCard(
  service: Pick<LarkCardService, 'send' | 'reply'>,
  event: LarkMessageEvent,
  input: Omit<Parameters<LarkCardService['send']>[0], 'chatId'> & { replyInThread?: boolean; forceMainThread?: boolean },
  log?: { warn: (...args: any[]) => void }
) {
  const { forceMainThread, ...cardInput } = input;
  if (forceMainThread && event.threadId?.trim()) {
    return await service.send({ chatId: event.chatId, ...cardInput });
  }
  if ((event.chatType === 'group' || cardInput.replyInThread) && typeof service.reply === 'function') {
    try {
      const replyContext = forceMainThread ? { messageId: event.messageId } : larkReplyContext(event);
      return await service.reply({ ...replyContext, ...cardInput });
    } catch (error) {
      // 回复触发消息失败（例如消息已被删除）时，回退为群内发送，保证卡片仍能送达。
      log?.warn({ error, messageId: event.messageId, chatId: event.chatId }, '回复卡片失败，回退为群内发送');
      return await service.send({ chatId: event.chatId, ...cardInput });
    }
  }
  return await service.send({ chatId: event.chatId, ...cardInput });
}

// 进程重启后的 reconciliation 可能无法更新原 running 卡片，只能补发终态卡片。
// 持久化真实 reply_message_id 和话题标记，让进程重启后的终态补发仍回到原话题。
// 旧 root_message_id 仅在确实是 om_* 消息 ID 时兼容；omt_* 不能传给回复接口。
async function sendPersistedTaskCard(
  service: Pick<LarkCardService, 'send' | 'reply'>,
  persisted: Pick<PersistedLarkCardTask, 'chat_id' | 'reply_message_id' | 'reply_in_thread' | 'root_message_id'>,
  input: Omit<Parameters<LarkCardService['send']>[0], 'chatId'>,
  log?: { warn: (...args: any[]) => void }
) {
  const replyMessageId = persisted.reply_message_id?.trim()
    || (persisted.root_message_id?.trim().startsWith('om_') ? persisted.root_message_id.trim() : undefined);
  if (replyMessageId && typeof service.reply === 'function') {
    try {
      return await service.reply({ messageId: replyMessageId, ...(persisted.reply_in_thread ? { replyInThread: true } : {}), ...input });
    } catch (error) {
      // The original message may have been deleted while AgentDock was down.
      // Keep reconciliation deliverable by falling back to a top-level card.
      log?.warn({ error, messageId: replyMessageId, chatId: persisted.chat_id }, '恢复卡片回复失败，回退为群内发送');
    }
  }
  return await service.send({ chatId: persisted.chat_id, ...input });
}

/**
 * 静默模式（quietReply）下的终态交付：不依赖 trace 卡片，把最终回复以文本消息
 * 由服务自动发送到会话。群聊优先回复触发消息（有 thread_id 则进话题）。
 */
async function sendQuietFinalReply(
  service: Pick<LarkCardService, 'sendText' | 'replyText'>,
  event: LarkMessageEvent,
  text: string,
  log?: { warn: (...args: any[]) => void },
  forceReplyInThread?: boolean,
  forceMainThread?: boolean
): Promise<void> {
  const content = text.trim() || '（Agent 未返回最终输出）';
  if (forceMainThread && event.threadId?.trim()) {
    await service.sendText({ chatId: event.chatId, text: content });
    return;
  }
  if ((event.chatType === 'group' || forceReplyInThread) && typeof service.replyText === 'function') {
    try {
      const replyInThread = forceMainThread ? false : Boolean(forceReplyInThread || event.threadId?.trim());
      await service.replyText({ messageId: event.messageId, text: content, ...(replyInThread ? { replyInThread: true } : {}) });
      return;
    } catch (error) {
      // 回复触发消息失败（例如消息已被删除）时回退为群内发送，保证最终回复仍能送达。
      log?.warn({ error, messageId: event.messageId, chatId: event.chatId }, '静默回复失败，回退为群内发送');
    }
  }
  await service.sendText({ chatId: event.chatId, text: content });
}

/** 终态失败交付：静默模式下改为文本，否则发送失败卡片。返回 message_id（静默模式为空串）。 */
async function deliverTaskFailure(
  service: Pick<LarkCardService, 'send' | 'reply' | 'sendText' | 'replyText'>,
  event: LarkMessageEvent,
  config: Pick<StoredLarkConfig, 'quietReply'>,
  input: Omit<Parameters<LarkCardService['send']>[0], 'chatId'> & { replyInThread?: boolean; forceMainThread?: boolean },
  log?: { warn: (...args: any[]) => void }
): Promise<{ messageId: string }> {
  if (config.quietReply) {
    // markdown 转纯文本：去掉 <> 包裹的 HTML 标签与 markdown 强调符号。
    const markdown = typeof input.markdown === 'string' ? input.markdown : '';
    const text = markdown
      .replace(/<[^>]+>/g, '')
      .replace(/\*\*/g, '')
      .replace(/`/g, '')
      .replace(/\n{3,}/g, '\n\n')
      .trim() || '（AgentDock 处理失败）';
    await sendQuietFinalReply(service, event, text, log, input.replyInThread, input.forceMainThread);
    return { messageId: '' };
  }
  return await sendTaskCard(service, event, input, log);
}

function compactTrace(events: AgentEvent[]): TraceEntry[] {
  const result: TraceEntry[] = [];
  const tools = new Map<string, TraceEntry>();
  for (const event of events) {
    if (event.type === 'task' || event.type === 'completed' || event.type === 'status') continue;
    // 更早轮次起在后台的进程在本轮推的进度：不属于这一轮，也别让它按首次出现占位、把回答切成两段。
    if (isCarriedOverToolCall(event)) continue;
    let data = event.data && typeof event.data === 'object' ? event.data as Record<string, any> : { value: event.data };
    if (event.type === 'text' && data.role === 'user') continue;
    // Agent 自己的告警（技能描述被裁剪之类）与正文共用 assistant text 通道。卡片是给人看的
    // 最终回复，告警不属于回答内容，直接丢掉——Web 时间线把它单独列成告警行，那是给排障看的视图。
    if (event.type === 'text' && typeof data.text === 'string' && (isAgentWarningText(data.text) || isAgentStreamErrorText(data.text))) continue;
    if (event.type === 'text' && typeof data.text === 'string') data = { ...data, text: stripAgentStreamErrorSuffix(data.text) };
    if (event.type === 'text' && typeof data.text === 'string' && !data.text) continue;
    if (event.type === 'raw_terminal' && typeof data.text === 'string') {
      try {
        const raw = JSON.parse(data.text);
        if (raw && typeof raw === 'object' && raw.type === 'status') continue;
      } catch { /* Non-JSON terminal output remains a visible execution record. */ }
    }
    const previous = result.at(-1);
    const role = data.role ?? 'assistant';
    if ((event.type === 'text' || event.type === 'thinking') && previous?.type === event.type && (previous.data.role ?? 'assistant') === role) {
      previous.data.text = `${previous.data.text ?? ''}${data.text ?? ''}`;
      continue;
    }
    if ((event.type === 'tool_call' || event.type === 'tool_result') && data.id) {
      const existing = tools.get(String(data.id));
      if (!existing) {
        const terminal = /completed|failed|error|cancelled|rejected/.test(String(data.status ?? '').toLowerCase()) || event.type === 'tool_result';
        const entry = { type: event.type, data: { ...data, startedAt: data.startedAt ?? event.timestamp, ...(terminal ? { completedAt: data.completedAt ?? event.timestamp } : {}) }, timestamp: event.timestamp };
        tools.set(String(data.id), entry);
        result.push(entry);
        continue;
      }
      const incomingName = String(data.name ?? '').trim();
      const existingName = String(existing.data.name ?? '').trim();
      const incomingGeneric = !incomingName || /^(?:tool|tool call)$/i.test(incomingName);
      existing.type = event.type;
      existing.data = {
        ...existing.data,
        ...data,
        name: incomingGeneric ? existingName || incomingName || 'tool' : incomingName,
        input: data.input ?? existing.data.input,
        output: data.output ?? existing.data.output,
        startedAt: existing.data.startedAt ?? existing.timestamp,
        ...(/completed|failed|error|cancelled|rejected/.test(String(data.status ?? '').toLowerCase()) || event.type === 'tool_result' ? { completedAt: data.completedAt ?? event.timestamp } : {})
      };
      existing.timestamp = event.timestamp;
      continue;
    }
    result.push({ type: event.type, data: { ...data }, timestamp: event.timestamp });
  }
  return result;
}

export function eventsForRuntimeTask(events: AgentEvent[], taskId: string) {
  const taskRecord = (event: AgentEvent) => event.type === 'task' ? (event.data as any)?.task : undefined;
  // 优先用该任务的 user 提示事件定位轮次起点（与既有行为一致）；若任务在发出提示事件
  // 之前就已失败（模型不可用 / 启动失败等），退回用该任务自己的 task 事件锚定。
  // 绝不回退到整个会话：否则本轮卡片会把历史轮次的 trace 一起渲染进去。
  const promptIndex = events.findIndex(event => event.type === 'text' && (event.data as any)?.role === 'user' && (event.data as any)?.taskId === taskId);
  const anchor = promptIndex >= 0 ? promptIndex : events.findIndex(event => taskRecord(event)?.id === taskId);
  if (anchor < 0) return [];
  const endOffset = events.slice(anchor + 1).findIndex(event => {
    const task = taskRecord(event);
    return task?.id === taskId && terminalTaskStates.has(task.status);
  });
  return events.slice(anchor + 1, endOffset < 0 ? undefined : anchor + 1 + endOffset);
}

const fenced = (value: unknown) => {
  if (value === undefined) return '';
  const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
  return `\n\n\`\`\`text\n${text.replaceAll('```', '``\\`')}\n\`\`\``;
};

const truncate = (value: unknown, limit: number) => {
  const text = (typeof value === 'string' ? value : JSON.stringify(value, null, 2) ?? '').trim();
  if (text.length <= limit) return text;
  return `${text.slice(0, limit).trimEnd()}\n…（内容过长，已截断）`;
};
const truncateInline = (value: string, limit = 64) => {
  const text = value.replace(/\s+/g, ' ').trim();
  return text.length <= limit ? text : `${text.slice(0, Math.max(1, limit - 1)).trimEnd()}…`;
};
const traceElapsed = (startedAt?: string, completedAt?: string) => {
  if (!startedAt) return '';
  const start = Date.parse(startedAt);
  const end = completedAt ? Date.parse(completedAt) : Date.now();
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return '';
  const milliseconds = end - start;
  if (milliseconds < 1_000) return `${Math.max(1, Math.round(milliseconds))}ms`;
  const seconds = Math.round(milliseconds / 1_000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return rest ? `${minutes}m ${rest}s` : `${minutes}m`;
};
const escapeCardInline = (value: string) => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');

const firstValue = (value: unknown, keys: string[]): string | undefined => {
  if (!value || typeof value !== 'object') return undefined;
  const record = value as Record<string, unknown>;
  for (const key of keys) {
    const candidate = record[key];
    if (typeof candidate === 'string' && candidate.trim()) return candidate.trim();
  }
  for (const candidate of Object.values(record)) {
    const nested = firstValue(candidate, keys);
    if (nested) return nested;
  }
  return undefined;
};

type TraceToolKind = 'command' | 'read' | 'edit' | 'search' | 'web' | 'git' | 'test' | 'data' | 'agent' | 'tool';

const toolIcon = (kind: TraceToolKind) => ({
  command: 'command_outlined',
  read: 'file-link-text_outlined',
  edit: 'edit_outlined',
  search: 'search_outlined',
  web: 'web-card_outlined',
  git: 'code_outlined',
  test: 'doc-checklist_outlined',
  data: 'data-sheet_outlined',
  agent: 'robot_outlined',
  tool: 'setting_outlined'
}[kind]);

const larkSubagentInvokeNames = new Set([
  'invoke_subagent', 'agent', 'task', 'subagent', 'spawn_agent', 'spawn_subagent',
  'resume_agent', 'delegate_task', 'delegate_agent', 'call_subagent', 'run_subagent', 'create_subagent'
]);
const larkBoilerplatePrograms = new Set([
  'cd', 'pushd', 'popd', 'export', 'set', 'unset', 'umask', 'echo', 'printf', 'date', 'sleep', 'true', 'mkdir', 'pwd'
]);

const larkShellProgram = (rawCommand: string): { program: string; args: string[]; hasGroup: boolean; hasWriteRedirect: boolean } => {
  const withoutHeredoc = rawCommand.split('\n').reduce<{ lines: string[]; end?: string }>((acc, line) => {
    if (acc.end) {
      if (line.trim() === acc.end) acc.end = undefined;
      return acc;
    }
    const hd = line.match(/<<-?\s*(?:'([^']+)'|"([^"]+)"|\\?([A-Za-z0-9_.-]+))/);
    if (hd && !line.includes('<<<')) {
      acc.lines.push(line.slice(0, hd.index));
      acc.end = hd[1] ?? hd[2] ?? hd[3];
    } else {
      acc.lines.push(line);
    }
    return acc;
  }, { lines: [] }).lines.join('\n');
  const statements = withoutHeredoc.split(/\s*(?:&&|\|\||;|\n)\s*/).map(s => s.trim()).filter(Boolean);
  const parsed = statements.map(statement => {
    const head = statement.split(/\s*(?<!\|)\|(?!\|)\s*/)[0]?.trim() ?? '';
    const hasWriteRedirect = /(?:^|\s)1?>>?\s*(?!\/dev\/null\b)\S/.test(head);
    const tokens = head.replace(/(?:2?>&[0-9]+|2>>?\s*\S+|&>>?\s*\S+|1?>>?\s*\S+)/g, ' ').trim().split(/\s+/).filter(Boolean);
    let idx = 0;
    while (idx < tokens.length) {
      const tok = tokens[idx]!;
      if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(tok)) { idx++; continue; }
      const base = tok.replace(/^['"(]+|['"]+$/g, '').split('/').at(-1)?.toLowerCase() ?? '';
      if (base === 'env' || base === 'time' || base === 'nohup' || base === 'exec' || base === 'sudo') { idx++; continue; }
      break;
    }
    const rawProg = tokens[idx] ?? '';
    const program = rawProg.replace(/^['"(]+|['"]+$/g, '').split('/').at(-1)?.toLowerCase() ?? '';
    return { program, args: tokens.slice(idx + 1), hasWriteRedirect };
  }).filter(item => Boolean(item.program));
  const hasGroup = parsed.some(item =>
    !item.args.includes('-h') && !item.args.includes('--help') && (
      (item.program === 'agent-dock' && item.args[0] === 'group' && ['self', 'peers', 'messages', 'send', 'wait'].includes(item.args[1] ?? ''))
      || (item.program === 'group' && ['self', 'peers', 'messages', 'send', 'wait'].includes(item.args[0] ?? ''))
    )
  );
  const primary = parsed.find(item => !larkBoilerplatePrograms.has(item.program)) ?? parsed[0];
  return { program: primary?.program ?? '', args: primary?.args ?? [], hasGroup, hasWriteRedirect: primary?.hasWriteRedirect ?? false };
};

const toolPresentation = (entry: TraceEntry) => {
  const data = entry.data;
  const inputRecord = data.input && typeof data.input === 'object' && !Array.isArray(data.input) ? data.input as Record<string, unknown> : undefined;
  const name = String(data.name ?? data.title ?? '工具').trim();
  const stripped = name.replace(/^Run\s+([A-Za-z0-9_.:-]+)$/, '$1').replace(/^default_api:([A-Za-z0-9_.:-]+)$/, '$1');
  const toolKey = stripped.toLowerCase();
  const acpKind = typeof data.kind === 'string' ? data.kind.trim().toLowerCase() : undefined;
  const rawCommand = typeof data.input === 'string'
    ? data.input.trim()
    : firstValue(data.input, ['command', 'cmd', 'CommandLine']);
  const command = rawCommand ? rawCommand.replace(/\s+/g, ' ').trim() : undefined;
  const url = firstValue(data.input, ['url', 'Url', 'URL', 'href']);
  const path = firstValue(data.input, ['file_path', 'filePath', 'path', 'Path', 'TargetFile', 'AbsolutePath', 'DirectoryPath', 'cwd']);
  const query = firstValue(data.input, ['query', 'Query', 'pattern', 'Pattern', 'glob', 'Glob']);
  const description = firstValue(data.input, ['description', 'command_description', 'toolSummary']) ?? (typeof data.description === 'string' ? data.description.trim() : undefined);
  const isGeneric = /^(?:tool|tool call|unknown tool)$/i.test(name);
  let action = isGeneric ? '工具调用' : stripped;
  let kind: TraceToolKind = 'tool';
  let extractedDetail: string | undefined;

  const hasEditKeys = Boolean(inputRecord && ['Target', 'Replacement', 'TargetContent', 'ReplacementContent', 'old_string', 'new_string', 'oldText', 'newText', 'edits'].some(k => inputRecord[k] !== undefined));
  const hasPatchKeys = Boolean(inputRecord && ['patch', 'diff', 'unified_diff', 'unifiedDiff'].some(k => inputRecord[k] !== undefined));
  const hasWriteKeys = Boolean(inputRecord && ['Content', 'content', 'CodeContent', 'file_text', 'file_content', 'Overwrite', 'Append'].some(k => inputRecord[k] !== undefined));

  if (command && rawCommand) {
    const shell = larkShellProgram(rawCommand);
    let subArg: string | undefined;
    for (let i = 0; i < shell.args.length; i++) {
      const arg = shell.args[i]!;
      if (arg === '--') { subArg = shell.args[i + 1]?.toLowerCase(); break; }
      if (['--filter', '-F', '-C', '--dir', '-p', '--prefix'].includes(arg)) { i++; continue; }
      if (arg.startsWith('-')) continue;
      subArg = arg.toLowerCase();
      break;
    }
    if (shell.hasGroup) { action = 'Agent 群协作'; kind = 'agent'; }
    else if (['apply_patch', 'patch'].includes(shell.program)) { action = '应用补丁'; kind = 'edit'; }
    else if (['ego-browser', 'ego-lite', 'playwright', 'puppeteer'].includes(shell.program) || (['npx', 'pnpm', 'npm', 'yarn', 'bun'].includes(shell.program) && ['ego-browser', 'playwright', 'puppeteer'].includes(subArg ?? ''))) { action = '操作浏览器'; kind = 'web'; }
    else if (['vitest', 'jest', 'pytest', 'mocha', 'ava'].includes(shell.program) || (['npx', 'pnpm', 'npm', 'yarn', 'bun'].includes(shell.program) && ['test', 'vitest', 'jest', 'pytest'].includes(subArg ?? '')) || ((shell.program === 'go' || shell.program === 'cargo') && shell.args[0] === 'test')) { action = '运行测试'; kind = 'test'; }
    else if (shell.program === 'git') { action = 'Git 操作'; kind = 'git'; }
    else if (['sqlite', 'sqlite3', 'psql', 'mysql', 'mariadb', 'duckdb'].includes(shell.program)) { action = '查询数据'; kind = 'data'; }
    else if (['curl', 'wget', 'http', 'httpie'].includes(shell.program)) { action = '读取网页'; kind = 'web'; }
    else if (['ls', 'll', 'tree', 'exa', 'eza'].includes(shell.program)) { action = '查看目录'; kind = 'search'; }
    else if (['find', 'fd', 'fdfind'].includes(shell.program) || (shell.program === 'rg' && shell.args.includes('--files'))) { action = '查找文件'; kind = 'search'; }
    else if (['rg', 'ripgrep', 'grep', 'egrep', 'fgrep', 'ag', 'ack'].includes(shell.program)) { action = '搜索内容'; kind = 'search'; }
    else if (!shell.hasWriteRedirect && (['cat', 'head', 'tail', 'nl', 'bat', 'less', 'more'].includes(shell.program) || (shell.program === 'sed' && shell.args.some(a => /^-[a-zA-Z]*n/.test(a)) && !shell.args.some(a => /^-[a-zA-Z]*i/.test(a))))) { action = '读取文件'; kind = 'read'; }
    else { action = '执行命令'; kind = 'command'; }
  } else {
    const mcpMatch = stripped.match(/^mcp__([^_](?:.*?)?)__(.+)$/i) ?? stripped.match(/^mcp[.:]([^.:/\s]+)[.:](.+)$/i);
    const mcpServer = firstValue(data.input, ['server', 'mcp_server']) ?? mcpMatch?.[1];
    const mcpTool = firstValue(data.input, ['tool', 'mcp_tool']) ?? mcpMatch?.[2];
    const agyFile = name.match(/^File\s+(.+)$/);
    if (mcpServer && mcpTool) {
      extractedDetail = `${mcpServer} / ${mcpTool}`;
      if (/^(?:playwright|puppeteer|chrome[-_]?devtools|browser|ego[-_]?browser)/i.test(mcpServer) || /^(?:browser_|playwright_)/i.test(mcpTool)) { action = '操作浏览器'; kind = 'web'; }
      else { action = '调用 MCP'; kind = 'tool'; }
    } else if (/^(?:ego-browser|browser|browser_subagent|playwright|(?:browser|playwright)_[a-z0-9_]+)$/.test(toolKey)) {
      action = '操作浏览器'; kind = 'web';
    } else if (agyFile) {
      extractedDetail = agyFile[1]!.trim();
      if (hasEditKeys || acpKind === 'edit') { action = '修改文件'; kind = 'edit'; }
      else if (hasPatchKeys) { action = '应用补丁'; kind = 'edit'; }
      else if (hasWriteKeys) { action = '写入文件'; kind = 'edit'; }
      else if (acpKind === 'delete') { action = '删除文件'; kind = 'edit'; }
      else if (acpKind === 'move') { action = '移动文件'; kind = 'edit'; }
      else { action = '读取文件'; kind = 'read'; }
    } else if (['view_file_outline', 'view_code_item'].includes(toolKey)) { action = '查看代码结构'; kind = 'read'; }
    else if (['view_image', 'read_image'].includes(toolKey) || /^View\s+Image(?:\s+(.+))?$/i.test(name)) { action = '查看图片'; kind = 'read'; extractedDetail = name.match(/^View\s+Image\s+(.+)$/i)?.[1]; }
    else if (['read_file', 'read', 'view_file', 'open_file'].includes(toolKey) || /^Read(?:\s+File|\s+file\s+.+|\s+.+)$/i.test(name)) {
      action = '读取文件'; kind = 'read';
      extractedDetail = name.match(/^Read\s+file\s+['"]?(.+?)['"]?$/i)?.[1] ?? (name.match(/^Read\s+(?!File$)(.+)$/i)?.[1]);
    } else if (['apply_patch', 'patch'].includes(toolKey)) { action = '应用补丁'; kind = 'edit'; }
    else if (['write_file', 'write', 'write_to_file', 'create_file'].includes(toolKey) || /^Preparing file…$/i.test(name) || /^Write\s+.+$/i.test(name)) {
      action = '写入文件'; kind = 'edit'; extractedDetail = name.match(/^Write\s+(.+)$/i)?.[1];
    } else if (['edit_file', 'edit', 'multiedit', 'strreplace', 'replace_file_content', 'multi_replace_file_content', 'notebookedit'].includes(toolKey) || /^Editing files?$/i.test(name) || /^Edit\s+.+$/i.test(name)) {
      action = '修改文件'; kind = 'edit'; extractedDetail = name.match(/^Edit\s+(.+)$/i)?.[1];
    } else if (['delete_file', 'delete'].includes(toolKey) || acpKind === 'delete') { action = '删除文件'; kind = 'edit'; }
    else if (['move_file', 'rename_file'].includes(toolKey) || acpKind === 'move') { action = '移动文件'; kind = 'edit'; }
    else if (['list_dir', 'ls', 'list', 'list_directory'].includes(toolKey) || /^List\s+files(?:\s+in\s+.+)?$/i.test(name)) {
      action = '查看目录'; kind = 'search'; extractedDetail = name.match(/^List\s+files\s+in\s+['"]?(.+?)['"]?$/i)?.[1];
    } else if (['glob', 'find_by_name', 'file_search', 'glob_file_search', 'find'].includes(toolKey) || /^Find(?:\s+.+)?$/i.test(name)) {
      action = '查找文件'; kind = 'search';
    } else if (['grep', 'grep_search', 'search', 'search_content', 'codebase_search', 'semantic_search', 'ripgrep', 'rg'].includes(toolKey) || /^grep(?:\s+.+)?$/i.test(name) || /^Search\s+for\s+.+$/i.test(name)) {
      action = '搜索内容'; kind = 'search';
    } else if (['search_web', 'websearch', 'web_search', 'search_query'].includes(toolKey) || /^Web\s+search(?::\s*.+)?$/i.test(name) || /\son\s+Web$/i.test(name) || /^Search\s+"/.test(name)) {
      action = '搜索网页'; kind = 'web';
    } else if (['webfetch', 'web_fetch', 'read_url_content', 'fetch_url', 'open_url', 'fetch'].includes(toolKey) || /^Fetch(?:\s+.+)?$/i.test(name)) {
      action = '读取网页'; kind = 'web'; extractedDetail = name.match(/^Fetch\s+(.+)$/i)?.[1];
    } else if (['command_status', 'bash_output', 'bashoutput'].includes(toolKey)) { action = '查看命令输出'; kind = 'command'; }
    else if (['write_stdin', 'send_command_input'].includes(toolKey)) { action = '向命令发送输入'; kind = 'command'; }
    else if (['run_command', 'bash', 'shell', 'powershell', 'terminal', 'exec_command', 'run_terminal_cmd'].includes(toolKey)) { action = '执行命令'; kind = 'command'; }
    else if (['generate_image', 'image-generator', 'image_generator', 'edit_image'].includes(toolKey) || ['image-generator', 'image_generator'].includes((firstValue(data.input, ['TypeName', 'subagent_type']) ?? '').toLowerCase())) { action = '生成图片'; kind = 'tool'; }
    else if (/^group\s+(?:self|peers|messages|send|wait)\b/i.test(name)) { action = 'Agent 群协作'; kind = 'agent'; }
    else if (['define_subagent', 'register_subagent'].includes(toolKey)) { action = '定义子 Agent'; kind = 'agent'; }
    else if (['manage_subagents', 'listagents', 'list_agents', 'close_agent'].includes(toolKey)) { action = '管理子 Agent'; kind = 'agent'; }
    else if (['send_message', 'sendmessage'].includes(toolKey)) { action = '发送消息'; kind = 'agent'; }
    else if (toolKey === 'swarm') { action = '多 Agent 协作'; kind = 'agent'; }
    else if (['run_workflow', 'execute_workflow'].includes(toolKey)) { action = '运行工作流'; kind = 'agent'; }
    else if (
      larkSubagentInvokeNames.has(toolKey)
      || /^Task\s+\((?:low|medium|high|max)\s+effort\)$/i.test(name)
      || acpKind === 'subagent'
      || Boolean(inputRecord && (typeof inputRecord.subagent_type === 'string' || typeof inputRecord.agent_type === 'string' || (typeof inputRecord.TypeName === 'string' && typeof inputRecord.Role === 'string' && typeof inputRecord.Prompt === 'string')))
    ) {
      action = '调用子 Agent'; kind = 'agent';
      extractedDetail = firstValue(data.input, ['Role', 'role', 'description', 'subagent_type', 'TypeName']);
    } else if (['ask_question', 'askuserquestion', 'askquestion', 'question'].includes(toolKey) || /^Asking for your input$/i.test(name) || Array.isArray(inputRecord?.questions)) { action = '发起提问'; kind = 'tool'; }
    else if (['todowrite', 'todo_write', 'todoread'].includes(toolKey) || /^Update TODOs/i.test(name) || Array.isArray(inputRecord?.todos)) { action = '更新待办'; kind = 'tool'; }
    else if (['update_plan', 'plan', 'taskcreate', 'taskupdate', 'tasklist', 'taskget'].includes(toolKey) || /^(?:Create|Update|List|Get)\s+tasks?/i.test(name)) { action = '更新计划'; kind = 'tool'; }
    else if (['manage_task', 'monitor'].includes(toolKey)) { action = '管理后台任务'; kind = 'tool'; }
    else if (['taskstop', 'stop_task'].includes(toolKey)) { action = '停止后台任务'; kind = 'tool'; }
    else if (['schedule', 'cron', 'set_timer'].includes(toolKey)) { action = '设置定时任务'; kind = 'tool'; }
    else if (['skill', 'load_skill'].includes(toolKey) || /^Load skill/i.test(name)) { action = '加载技能'; kind = 'tool'; extractedDetail = firstValue(data.input, ['skill']) ?? name.match(/^Load skill:\s*(.+)$/i)?.[1]; }
    else if (['compact', 'compact_conversation'].includes(toolKey) || /^Compact conversation$/i.test(name)) { action = '压缩上下文'; kind = 'tool'; }
    else if (isGeneric && hasEditKeys) { action = '修改文件'; kind = 'edit'; }
    else if (isGeneric && hasWriteKeys) { action = '写入文件'; kind = 'edit'; }
    else if (isGeneric && path) { action = '读取文件'; kind = 'read'; }
    else if (isGeneric && url) { action = '读取网页'; kind = 'web'; }
    else if (acpKind === 'read') { action = '读取文件'; kind = 'read'; }
    else if (acpKind === 'edit') { action = '修改文件'; kind = 'edit'; }
    else if (acpKind === 'search') { action = '搜索内容'; kind = 'search'; }
    else if (acpKind === 'fetch') { action = '读取网页'; kind = 'web'; }
    else if (acpKind === 'execute') { action = '执行命令'; kind = 'command'; }
  }

  const fullDetail = command ?? extractedDetail ?? url ?? path ?? query ?? (isGeneric ? '' : name);
  const detail = truncateInline(fullDetail === action ? '' : fullDetail);
  const status = String(data.status ?? (entry.type === 'tool_result' ? 'completed' : 'running')).toLowerCase();
  const failed = /fail|error|reject|cancel/.test(status);
  const running = /running|pending|started|in_progress/.test(status);
  return {
    kind,
    action,
    description,
    detail,
    statusLabel: failed ? '失败' : running ? '执行中' : '已完成',
    statusColor: failed ? 'yellow' : running ? 'orange' : 'green',
    indicatorColor: failed ? 'trace_failure' : running ? 'trace_running' : 'trace_success',
    elapsed: traceElapsed(data.startedAt ?? entry.timestamp, running ? undefined : data.completedAt ?? entry.timestamp),
    fullDetail,
    input: truncate(data.input, 250),
    output: truncate(data.output, 450)
  };
};

// 工具未返回结果的判定收敛到 shared（见 packages/shared/src/turn-outcome.ts）。
// 原实现按 statusLabel === '执行中' 判，等价于只看状态字面量，缺了 ACP 乱序更新的保护：
// 同一个 toolCallId 迟到的 running 快照会把已经跑完的轮次判成失败。
// 现在只认「卡在最终回复之后」的那些调用：最终回复之前没收口的，说明 Agent 已经越过它继续
// 作答并给出了回答，据此判失败会和 runtime 的结论打架（卡片说失败、控制台说完成）。
const hasUnresolvedToolCalls = (events: AgentEvent[]) => unresolvedToolCallsAfterAnswer(compactTrace(events)).length > 0;

const toolPanel = (entry: TraceEntry, index: string | number): LarkCardElement => {
  const tool = toolPresentation(entry);
  const description = escapeCardInline(truncateInline(tool.description || tool.action, 72));
  const detail = escapeCardInline(tool.detail || '');
  const detailSuffix = detail && detail !== description ? `　<font color='grey'>${detail}</font>` : '';
  const elapsedSuffix = tool.elapsed ? `　<font color='grey'>${tool.elapsed}</font>` : '';
  const stateLamp = `<font color='${tool.indicatorColor}'>●</font>　`;
  const sections = [
    tool.fullDetail && tool.fullDetail !== tool.detail && !tool.input ? `**完整内容**\n\n\`\`\`text\n${tool.fullDetail.replaceAll('```', '``\\`')}\n\`\`\`` : '',
    tool.input ? `**输入**\n\n\`\`\`text\n${tool.input.replaceAll('```', '``\\`')}\n\`\`\`` : '',
    tool.output ? `**结果**\n\n\`\`\`text\n${tool.output.replaceAll('```', '``\\`')}\n\`\`\`` : ''
  ].filter(Boolean);
  return {
    tag: 'collapsible_panel', element_id: `trace_tool_${index}`, expanded: false,
    direction: 'vertical', vertical_spacing: '4px', padding: '4px 0px 0px 0px', margin: '0px 0px 0px 20px',
    header: {
      title: { tag: 'markdown', content: `${stateLamp}${description}${detailSuffix}${elapsedSuffix}`, text_size: 'notation', icon: { tag: 'standard_icon', token: toolIcon(tool.kind), color: 'grey' } },
      vertical_align: 'center', icon: { tag: 'standard_icon', token: 'down-small-ccm_outlined', color: 'grey', size: '12px 12px' },
      icon_position: 'right', icon_expanded_angle: -180
    },
    elements: sections.length
      ? sections.map(content => ({ tag: 'markdown', content, text_size: 'notation', margin: '0px' }))
      : [{ tag: 'markdown', content: '<font color=\'grey\'>暂无可展示的输入或结果</font>', text_size: 'notation', margin: '0px' }]
  };
};

const traceGroups = (entries: TraceEntry[]): TraceGroup[] => {
  const groups: TraceGroup[] = [];
  let narratives: TraceEntry[] = [];
  let actions: TraceEntry[] = [];
  const flush = () => {
    if (narratives.length || actions.length) groups.push({ narratives, actions });
    narratives = [];
    actions = [];
  };
  for (const entry of entries) {
    if (entry.type === 'thinking' || entry.type === 'text') {
      if (actions.length) flush();
      narratives.push(entry);
      continue;
    }
    actions.push(entry);
  }
  flush();
  return groups;
};

const groupDescription = (group: TraceGroup) => {
  const narrative = [...group.narratives].reverse().find(entry => entry.type === 'text') ?? group.narratives.at(-1);
  const assistantNarrative = [...group.narratives].reverse().find(entry => entry.type === 'text');
  const narrativeText = String(assistantNarrative?.data.text ?? '').trim();
  if (narrativeText) return narrativeText;
  const tool = group.actions.find(entry => entry.type === 'tool_call' || entry.type === 'tool_result');
  if (tool) {
    const presentation = toolPresentation(tool);
    return presentation.description || presentation.fullDetail || presentation.action;
  }
  return narrative ? '思考过程' : '执行过程';
};

const groupPanel = (group: TraceGroup, index: number, terminal = false): LarkCardElement => {
  const visibleActions = group.actions;
  const tools = visibleActions.filter(entry => entry.type === 'tool_call' || entry.type === 'tool_result');
  const statuses = tools.map(entry => toolPresentation(entry));
  const failedCount = statuses.filter(item => item.statusLabel === '失败').length;
  const succeededCount = statuses.filter(item => item.statusLabel === '已完成').length;
  const hasErrorEvent = visibleActions.some(entry => entry.type === 'error');
  const status = hasErrorEvent || (failedCount > 0 && succeededCount > 0)
    ? { label: '有失败', color: 'trace_failure' }
    : failedCount > 0 ? { label: '失败', color: 'trace_failure' }
    : statuses.some(item => item.statusLabel === '执行中') ? { label: '执行中', color: 'trace_running' }
      : tools.length ? { label: '已完成', color: 'green' } : terminal ? { label: '已完成', color: 'green' } : { label: '执行中', color: 'trace_running' };
  const thinkingEntries = group.narratives.filter(entry => entry.type === 'thinking' && String(entry.data.text ?? '').trim());
  const actionElements = visibleActions.flatMap((entry, actionIndex): LarkCardElement[] => {
    if (entry.type === 'tool_call' || entry.type === 'tool_result') return [toolPanel(entry, `${index}_${actionIndex}`)];
    if (entry.type === 'permission_request') return [{ tag: 'markdown', content: `**权限请求**　<text_tag color='orange'>${entry.data.status ?? '待处理'}</text_tag>\n\n${truncate(entry.data.title, 800)}`, text_size: 'x-small', margin: '0px' }];
    if (entry.type === 'error') return [{ tag: 'markdown', content: `<text_tag color='yellow'>有错误</text_tag>\n\n${truncate(entry.data.message ?? 'Agent 执行未完全成功', 1_500)}`, text_size: 'x-small', margin: '0px' }];
    if (entry.type === 'raw_terminal') return [toolPanel({ ...entry, type: 'tool_result', data: { ...entry.data, name: 'terminal', output: entry.data.text, status: 'completed' } }, `${index}_${actionIndex}`)];
    return [];
  });
  const preview = escapeCardInline(truncateInline(groupDescription(group), 92));
  const first = group.narratives[0] ?? group.actions[0];
  const last = group.actions.at(-1) ?? group.narratives.at(-1);
  const elapsed = traceElapsed(first?.data.startedAt ?? first?.timestamp, last?.data.completedAt ?? last?.timestamp);
  const elapsedSuffix = elapsed ? `　<font color='grey'>${elapsed}</font>` : '';
  const stateSuffix = `　<font color='${status.color}'>● ${status.label}</font>`;
  const countParts = [thinkingEntries.length ? `${thinkingEntries.length} 段思考` : '', tools.length ? `${tools.length} 次工具调用` : ''].filter(Boolean);
  const summaryElements: LarkCardElement[] = countParts.length ? [{
    tag: 'div', width: 'auto', margin: '0px 0px 2px 0px',
    text: { tag: 'plain_text', content: countParts.join(' · '), text_size: 'notation', text_color: 'grey' },
    icon: { tag: 'standard_icon', token: 'setting_outlined', color: 'grey' }
  }] : [];
  const thinkingElements: LarkCardElement[] = thinkingEntries.map(entry => ({
    tag: 'markdown', content: `**思考过程**　<font color='grey'>${truncate(entry.data.text, 500)}</font>`, text_size: 'notation', margin: '0px 0px 2px 20px',
    icon: { tag: 'standard_icon', token: 'mindnote_outlined', color: 'grey' }
  }));
  return {
    tag: 'collapsible_panel', element_id: `trace_group_${index}`, expanded: false,
    direction: 'vertical', vertical_spacing: '2px', padding: '2px 0px 0px 0px', margin: '0px',
    header: {
      title: { tag: 'markdown', content: `${preview}${elapsedSuffix}${stateSuffix}`, text_size: 'notation' },
      vertical_align: 'center', icon: { tag: 'standard_icon', token: 'down-small-ccm_outlined', color: 'grey', size: '14px 14px' },
      icon_position: 'right', icon_expanded_angle: -180
    },
    elements: [...summaryElements, ...thinkingElements, ...actionElements]
  };
};

/** 在已 compact 的条目中定位最终回复条目：最后一次活动之后的最后一条 assistant 文本；
 *  严格规则取不到、但本轮确有正文时退化为末条文本（Agent 答完又做了收尾动作的轮次）。 */
const findFinalMessageEntry = (entries: TraceEntry[]): TraceEntry | undefined => pickFinalAssistantEntry(entries);

/** 提取轮次原始未截断最终回复文本（用于完整解析末尾 AskUserQuestion XML）。 */
const extractRawFinalText = (events: AgentEvent[]): string => {
  const finalMessage = findFinalMessageEntry(compactTrace(events));
  return typeof finalMessage?.data?.text === 'string' ? finalMessage.data.text : '';
};

/** 提取轮次最终回复文本（直接 compact 事件并定位）。 */
const extractFinalText = (events: AgentEvent[]): string => {
  const finalMessage = findFinalMessageEntry(compactTrace(events));
  return finalMessage ? truncate(finalMessage.data.text, 6_000) : '';
};

export function renderLarkCardElements(
  events: AgentEvent[],
  config: Pick<StoredLarkConfig, 'traceLimit'>,
  completed = false,
  compensation = false,
  options?: {
    askUserQuestionXmlEnabled?: boolean;
    outputPluginRegistry?: OutputPluginRegistry;
    enabledOutputPluginIds?: ReadonlySet<string>;
    larkPluginAdapters?: LarkOutputPluginAdapterRegistry;
  }
): LarkCardElement[] {
  const pluginRegistry = options?.outputPluginRegistry ?? defaultOutputPluginRegistry;
  const pluginAdapters = options?.larkPluginAdapters ?? defaultLarkOutputPluginAdapterRegistry;
  const enabledPluginIds = options?.enabledOutputPluginIds
    ?? (options?.askUserQuestionXmlEnabled === false
      ? new Set<string>()
      : new Set<string>([BUILTIN_ASK_USER_QUESTION_PLUGIN_ID]));
  const hasEnabledPlugins = enabledPluginIds.size > 0;
  const entries = compactTrace(events);
  // final 文本仅用于 completed 终态卡片；运行中/其他状态不提升 final_output。
  const finalMessage = completed ? findFinalMessageEntry(entries) : undefined;
  let finalText = '';
  if (finalMessage) {
    const rawText = String(finalMessage.data.text ?? '');
    const extracted = hasEnabledPlugins ? pluginRegistry.parseTrailingOutput(rawText, enabledPluginIds) : null;
    if (extracted) {
      const plugin = pluginRegistry.get(extracted.pluginId);
      const adapter = plugin ? pluginAdapters.resolve(plugin) : undefined;
      const hintMd = adapter?.trailingHintMarkdown || "<font color='grey'>👇 请在下方交互卡片中确认并作答</font>";
      finalText = extracted.proseText
        ? `${truncate(extracted.proseText, 5_800)}\n\n${hintMd}`
        : plugin?.capabilities.interactive === false
          ? `请在下方查看「${plugin.name}」卡片。`
          : '请在下方交互卡片中确认并作答。';
    } else {
      finalText = truncate(rawText, 6_000);
    }
  }
  let activityEntries = finalMessage ? entries.filter(entry => entry !== finalMessage) : entries;
  if (!completed && hasEnabledPlugins && activityEntries.length) {
    // 流式阶段若最后一条正文正在输出任一已启用插件的 XML 标签，屏蔽裸 XML 源码。
    let lastTextIdx = -1;
    for (let i = activityEntries.length - 1; i >= 0; i--) {
      if (activityEntries[i]!.type === 'text') { lastTextIdx = i; break; }
    }
    if (lastTextIdx >= 0) {
      const target = activityEntries[lastTextIdx]!;
      const raw = String(target.data.text ?? '');
      const split = pluginRegistry.splitStreamingOutput(raw, true, enabledPluginIds);
      if (split.kind !== 'none') {
        const plugin = pluginRegistry.get(split.pluginId);
        const adapter = plugin ? pluginAdapters.resolve(plugin) : undefined;
        const placeholder = adapter?.streamingPlaceholderText || '⏳ 正在生成选项卡片…';
        const sanitized = split.proseText
          ? `${split.proseText}\n\n${placeholder}`
          : placeholder;
        activityEntries = activityEntries.map((entry, idx) => idx === lastTextIdx
          ? { ...entry, data: { ...entry.data, text: sanitized } }
          : entry);
      }
    }
  }
  // 先全量分组，再按 group 数量裁剪。
  // 若在 entry 级别切片，滑动窗口可能切断 group 边界，导致 group 数量随新事件到来而跳变。
  // 按 group 级别裁剪后，group 数量单调递增，超过 traceLimit 时才丢弃最旧的 group，计数稳定。
  const allGroups = traceGroups(activityEntries);
  const groups = config.traceLimit && allGroups.length > config.traceLimit
    ? allGroups.slice(-config.traceLimit)
    : allGroups;
  const elements: LarkCardElement[] = [];

  if (compensation) {
    elements.push({ tag: 'markdown', content: "<font color='orange'>原运行卡片未能更新，AgentDock 已补发终态结果。</font>", text_size: 'notation', margin: '0px 0px 8px 0px' });
  }
  if (finalText) {
    elements.push({ tag: 'markdown', element_id: 'final_output', content: completed ? finalText : `**当前进展**\n\n${finalText}`, text_align: 'left', text_size: 'normal_v2', margin: '0px' });
  } else if (completed) {
    elements.push({ tag: 'markdown', content: "<font color='orange'>Agent 未返回最终输出</font>", text_size: 'notation', margin: '0px' });
  }
  if (groups.length) {
    elements.push(...groups.map((group, index) => groupPanel(group, index, completed)));
  }
  if (!elements.length) elements.push({ tag: 'markdown', content: '正在思考中…', text_size: 'normal', margin: '0px' });
  return elements;
}

export function renderLarkTrace(events: AgentEvent[], config: Pick<StoredLarkConfig, 'traceLimit'>, _completed = false) {
  let entries = compactTrace(events);
  if (config.traceLimit) entries = entries.slice(-config.traceLimit);
  if (!entries.length) return '正在思考中…';
  return entries.map(entry => {
    const data = entry.data;
    if (entry.type === 'text') return `**Agent**\n\n${data.text ?? ''}`;
    if (entry.type === 'thinking') return `**思考**\n\n> ${String(data.text ?? '').replaceAll('\n', '\n> ')}`;
    if (entry.type === 'tool_call' || entry.type === 'tool_result') return `**工具 · ${data.name ?? 'tool'}** · ${data.status ?? (entry.type === 'tool_result' ? 'completed' : 'running')}${fenced(data.output ?? data.input)}`;
    if (entry.type === 'permission_request') return `**权限请求** · ${data.status ?? 'pending'}\n\n${data.title ?? ''}`;
    if (entry.type === 'error') return `**错误**\n\n${data.message ?? 'Agent 执行失败'}`;
    if (entry.type === 'raw_terminal') return `**终端**${fenced(data.text ?? '')}`;
    return '';
  }).filter(Boolean).join('\n\n---\n\n');
}

export class LarkMessageCoordinator {
  private readonly groups = new Map<string, LarkGroup>();
  private readonly tasks = new Map<string, LarkTask>();
  private readonly handledMessages = new Set<string>();
  /** 飞书侧聊话题映射（`${appId}:${rootId|threadId}` -> sideChatSessionId），与 cardMappings 双写。 */
  private readonly sideChatThreads = new Map<string, string>();
  private reconcileTimer?: NodeJS.Timeout;
  private reconcileRun?: Promise<number>;
  private reconcileConfig?: StoredLarkConfig;
  private reconcileIntervalMs = 5_000;
  private stopped = false;
  private chatNames?: Map<string, string>;
  private chatNamesFetchedAt = 0;
  private chatNamesFetch?: Promise<Map<string, string>>;
  /** 单人群聊免 @ 唤醒用的群人类成员数短缓存（15s TTL），避免连发消息反复查飞书接口，同时拉入第二个人后尽快失效。 */
  private readonly chatUserCounts = new Map<string, { count?: number; fetchedAt: number }>();
  private readonly chatUserCountFetches = new Map<string, Promise<number | undefined>>();
  /** 纯 XML 交互插件飞书卡片内存镜像（同时双写 cardMappings，兼容重启与无库单测）。 */
  private readonly pluginCards = new Map<string, PersistedLarkOutputPluginCard>();
  /** 未注入共享 turnTracker 时的本地插件卡片强幂等占坑表。 */
  private readonly localCardTracker = new LarkTurnTracker();
  /** 无 OutputPluginService 注入时的本地兜底幂等记录。 */
  private readonly localAnsweredPlugins = new Map<string, unknown>();

  constructor(
    private readonly runtime: LarkRuntime,
    private readonly service: LarkCardService,
    private readonly log: ListenerLog,
    private readonly random: () => number = Math.random,
    private readonly botOpenId?: string,
    private readonly peerBotAuthorized?: (chatId: string, senderOpenId: string) => Promise<boolean>,
    private readonly cardMappings?: ChannelMappingRepository,
    private readonly configRepository?: ConfigRepository,
    private readonly askUserQuestion?: AskUserQuestionService,
    private readonly outputPlugins?: OutputPluginService,
    private readonly larkPluginAdapters: LarkOutputPluginAdapterRegistry = defaultLarkOutputPluginAdapterRegistry,
    private readonly turnTracker?: LarkTurnTracker
  ) {}

  private get resolvedOutputPlugins(): OutputPluginService | undefined {
    return this.outputPlugins ?? this.askUserQuestion?.outputPlugins;
  }

  private get resolvedPluginRegistry(): OutputPluginRegistry {
    return this.resolvedOutputPlugins?.registry ?? defaultOutputPluginRegistry;
  }

  private cardChannelForPlugin(pluginId: string): string {
    return cardChannelForOutputPlugin(pluginId);
  }

  private async resolveEnabledOutputPluginIds(sessionId?: string): Promise<Set<string>> {
    const session = sessionId ? await this.runtime.getSession(sessionId).catch(() => undefined) : undefined;
    if (this.resolvedOutputPlugins) {
      return this.resolvedOutputPlugins.enabledPluginIdsForSession(session);
    }
    const globalState = await readOutputPluginsGlobalConfig(this.configRepository);
    const askGlobal = (await readAskUserQuestionConfig(this.configRepository)).askUserQuestionXmlEnabled;
    const mergedGlobal = {
      plugins: {
        [BUILTIN_ASK_USER_QUESTION_PLUGIN_ID]: askGlobal,
        ...globalState.config.plugins
      }
    };
    const enabled = new Set<string>();
    for (const plugin of this.resolvedPluginRegistry.list()) {
      if (resolveOutputPluginEnabled(plugin.id, {
        defaultEnabled: plugin.defaultEnabled,
        globalConfig: mergedGlobal,
        sessionOverrides: session?.outputPlugins,
        legacySessionAskEnabled: session?.askUserQuestionEnabled
      })) {
        enabled.add(plugin.id);
      }
    }
    return enabled;
  }

  private normalizePersistedCard(raw: Record<string, unknown>): PersistedLarkOutputPluginCard | undefined {
    const cardId = typeof raw.cardId === 'string' ? raw.cardId : '';
    const sessionId = typeof raw.sessionId === 'string' ? raw.sessionId : '';
    if (!cardId || !sessionId || !raw.spec) return undefined;
    const pluginId = typeof raw.pluginId === 'string' && raw.pluginId.trim()
      ? normalizeOutputPluginId(raw.pluginId)
      : BUILTIN_ASK_USER_QUESTION_PLUGIN_ID;
    const instanceId = typeof raw.instanceId === 'string' && raw.instanceId.trim()
      ? raw.instanceId
      : typeof raw.questionId === 'string' && raw.questionId.trim()
        ? raw.questionId
        : '';
    if (!instanceId) return undefined;
    return {
      ...(raw as unknown as PersistedLarkOutputPluginCard),
      pluginId,
      instanceId,
      ...(pluginId === BUILTIN_ASK_USER_QUESTION_PLUGIN_ID ? { questionId: instanceId } : {})
    };
  }

  private async lookupPluginCard(cardId: string, preferredPluginId?: string): Promise<PersistedLarkOutputPluginCard | undefined> {
    const cached = this.pluginCards.get(cardId);
    if (cached) return cached;
    if (!this.cardMappings) return undefined;
    const channels = preferredPluginId
      ? [this.cardChannelForPlugin(preferredPluginId), LARK_ASK_CARD_CHANNEL, LARK_OUTPUT_PLUGIN_CARD_CHANNEL]
      : [LARK_ASK_CARD_CHANNEL, LARK_OUTPUT_PLUGIN_CARD_CHANNEL];
    const visited = new Set<string>();
    for (const channel of channels) {
      if (visited.has(channel)) continue;
      visited.add(channel);
      const mapping = await this.cardMappings.get(channel, cardId).catch(() => undefined);
      if (!mapping?.extra) continue;
      try {
        const parsed = this.normalizePersistedCard(JSON.parse(mapping.extra) as Record<string, unknown>);
        if (parsed) {
          this.pluginCards.set(parsed.cardId, parsed);
          return parsed;
        }
      } catch { /* ignore malformed */ }
    }
    return undefined;
  }

  /** 向对应飞书群/私聊发送任意已注册纯 XML 插件的 Schema 2.0 卡片，并经统一强幂等派发器持久化映射以杜绝并发双发。 */
  async pushOutputPluginCard(input: {
    config: StoredLarkConfig;
    sessionId: string;
    taskId?: string;
    chatId: string;
    chatType: string;
    replyToMessageId?: string;
    replyInThread?: boolean;
    forceMainThread?: boolean;
    threadId?: string;
    rootId?: string;
    pluginId: string;
    spec: unknown;
  }): Promise<PersistedLarkOutputPluginCard | undefined> {
    return dispatchLarkOutputPluginCard({
      pluginRegistry: this.resolvedPluginRegistry,
      larkPluginAdapters: this.larkPluginAdapters,
      service: this.service,
      turnTracker: this.turnTracker,
      fallbackTracker: this.localCardTracker,
      cardMappings: this.cardMappings,
      hasLocalSent: key => {
        for (const record of this.pluginCards.values()) {
          if (record.sessionId !== key.sessionId) continue;
          if (record.pluginId !== key.pluginId || record.instanceId !== key.widgetId) continue;
          const recChatIds = [record.chatId?.trim(), record.receiveId?.trim()].filter((v): v is string => Boolean(v));
          if (recChatIds.length === 0 || recChatIds.includes(key.chatId)) return true;
        }
        return false;
      },
      onDispatched: record => {
        this.pluginCards.set(record.cardId, record);
        if (this.pluginCards.size > 2_000) {
          const oldest = this.pluginCards.keys().next().value;
          if (oldest) this.pluginCards.delete(oldest);
        }
      },
      appId: input.config.appId,
      sessionId: input.sessionId,
      taskId: input.taskId,
      chatId: input.chatId,
      chatType: input.chatType,
      replyToMessageId: input.replyToMessageId,
      replyInThread: input.replyInThread,
      forceMainThread: input.forceMainThread,
      threadId: input.threadId,
      rootId: input.rootId,
      webBaseUrl: input.config.webBaseUrl,
      pluginId: input.pluginId,
      spec: input.spec
    });
  }

  /** 向后兼容包装：推送内置 AskUserQuestion 飞书交互卡片。 */
  async pushAskUserQuestionCard(input: {
    config: StoredLarkConfig;
    sessionId: string;
    taskId?: string;
    chatId: string;
    chatType: string;
    replyToMessageId?: string;
    replyInThread?: boolean;
    forceMainThread?: boolean;
    threadId?: string;
    rootId?: string;
    spec: AskUserQuestionSpec;
  }): Promise<PersistedLarkAskCard | undefined> {
    const pushed = await this.pushOutputPluginCard({
      ...input,
      pluginId: BUILTIN_ASK_USER_QUESTION_PLUGIN_ID
    });
    return pushed as PersistedLarkAskCard | undefined;
  }

  /**
   * 终态判定必须基于完整轮次事件，不能用被截断的心跳缓冲（见 maxBufferedEvents）：
   * 长轮次里配对的 tool_call/tool_result 或末尾的 completed 可能已被淘汰，
   * 会把已成功的轮次判成失败。这里从 DB 倒序重载足够事件；失败时退回已接收事件。
   */
  private terminalReloadLimit(config: StoredLarkConfig) {
    return Math.max((config.traceLimit ?? defaultLarkTraceLimit) * 30, 500);
  }
  private async reloadTurnEvents(sessionId: string, config: StoredLarkConfig, fallback: AgentEvent[], runtimeTaskId?: string, afterSequence?: number): Promise<AgentEvent[]> {
    if (!this.runtime.getRecentEvents) return fallback;
    try {
      const persisted = await this.runtime.getRecentEvents(sessionId, this.terminalReloadLimit(config));
      if (runtimeTaskId) return eventsForRuntimeTask(persisted, runtimeTaskId);
      // 没有 runtimeTaskId 时按本轮开始前的 sequence 水位裁剪，避免把更早轮次的
      // 未完成工具调用或 error 算进本轮终态。
      return afterSequence ? persisted.filter(event => event.sequence > afterSequence) : persisted;
    } catch (error) {
      this.log.warn({ error, sessionId, runtimeTaskId }, '读取任务最终事件失败，使用已接收事件判定终态');
      return fallback;
    }
  }

  /**
   * 终态卡片渲染用的事件集 = DB 重载结果 并上 内存缓冲里未被重载覆盖的尾部事件。
   * DB 重载（eventsForRuntimeTask / afterSequence 裁剪）正常应在运行时事件落库后执行，
   * 但长轮次下存在「重载读到的快照晚于内存缓冲」的窗口：若最终输出恰好落在该窗口，
   * 只按重载结果替换会把缓冲里已到的最终 assistant 文本丢掉，卡片就误判「Agent 未返回最终输出」。
   * 这里以重载为准、按 id 并上缓冲里重载未覆盖的事件，保证最终文本不被误删。
   */
  private mergeCardEvents(buffered: AgentEvent[], reloaded: AgentEvent[]): AgentEvent[] {
    const seen = new Set(reloaded.map(event => event.id));
    const extra = buffered.filter(event => !seen.has(event.id));
    if (!extra.length) return reloaded;
    return [...reloaded, ...extra];
  }

  /**
   * 机器人所在群聊的 chatId → 群名称映射，带 TTL 缓存；
   * 仅用于注入里的「机器人所在的其他群」。拉取失败时沿用上次缓存。
   *
   * 这条路径在每个群聊轮次的关键路径上（注入 prompt 前必须拿到），因此有两道约束：
   * - 分页有上限：机器人在很多群里时，逐页串行拉取会把首字延迟拖到数秒；
   *   注入里本来也只展示前 20 个群名，没必要为此拉全量。
   * - 整体有超时：飞书接口慢时不能无限期挂住用户的这一轮回复，超时就退回已有缓存
   *   （通常是上一轮的结果），宁可少注入群名也不拖慢回复。
   *
   * 返回 `undefined` 专指「这轮拿不到列表」（超时或失败且无缓存）。不能和「拿到了但一台群
   * 都没有」混为一谈：前者必须让 Agent 知道信息缺失，后者才能说「机器人只在这个群」。
   * 注意「当前群聊」的名字不走这里——见 `resolveCurrentChatName`。
   */
  private async resolveChatNames(config: StoredLarkConfig): Promise<Map<string, string> | undefined> {
    if (this.chatNames && Date.now() - this.chatNamesFetchedAt < 5 * 60_000) return this.chatNames;
    if (!this.chatNamesFetch) {
      this.chatNamesFetch = (async () => {
        const names = new Map<string, string>();
        let pageToken: string | undefined;
        for (let page = 0; page < maxChatNamePages; page++) {
          const result = await this.service.listChats(pageToken);
          for (const chat of result.items) names.set(chat.chatId, chat.name);
          pageToken = result.hasMore ? result.pageToken : undefined;
          if (!pageToken) break;
        }
        return names;
      })();
    }
    const pending = this.chatNamesFetch;
    let timer: NodeJS.Timeout | undefined;
    try {
      const names = await Promise.race([
        pending,
        new Promise<undefined>(resolve => { timer = setTimeout(() => resolve(undefined), chatNamesTimeoutMs); })
      ]);
      if (names) { this.chatNames = names; this.chatNamesFetchedAt = Date.now(); }
      else this.log.warn({ appId: config.appId }, '获取机器人所在群列表超时，本轮跳过群列表注入');
    } catch (error) {
      this.log.warn({ error, appId: config.appId }, '获取机器人所在群列表失败，跳过群列表注入');
    } finally {
      if (timer) clearTimeout(timer);
      // 超时只放弃等待，不取消后台拉取：它完成后会填充缓存供后续轮次使用。
      if (this.chatNamesFetch === pending) {
        void pending.then(names => {
          if (this.chatNamesFetch === pending) this.chatNamesFetch = undefined;
          this.chatNames = names; this.chatNamesFetchedAt = Date.now();
        }).catch(() => { if (this.chatNamesFetch === pending) this.chatNamesFetch = undefined; });
      }
    }
    return this.chatNames;
  }

  /**
   * 当前群名：三路兜底，按成本从低到高。
   *
   * 这条是身份注入里唯一必须可靠的字段——Agent 靠它知道「我在哪个群」，而它此前只有一条来路
   * （机器人所在群列表），于是踩了两个坑：列表有 5 分钟缓存，新建的托管群在那之前不在里面；
   * 名字取不到时注入里整行消失，连 chat_id 一起丢，Agent 只能把「所在群聊」里的别的群名
   * 当成自己在的群。
   *
   * 1. 本地绑定：托管群建群时群名就写进了 channel_mappings，读本地即可，零 API 零权限。
   * 2. 单群查询：`GET /im/v1/chats/:chat_id`，只问当前群，不吃列表缓存与分页。
   * 3. 群列表缓存：前两路都没结果时的兜底。
   *
   * 三路全失败返回 `undefined`，调用方仍然会注入 chat_id。
   */
  private async resolveCurrentChatName(config: StoredLarkConfig, event: LarkMessageEvent): Promise<string | undefined> {
    const bound = await this.boundChatName(config, event.chatId);
    if (bound) return bound;
    try {
      const chat = await this.service.getChat(event.chatId);
      if (chat?.userCount !== undefined) this.rememberChatUserCount(event.chatId, chat.userCount);
      if (chat?.name) return chat.name;
    } catch (error) {
      this.log.warn({ error, appId: config.appId, chatId: event.chatId }, '查询当前群信息失败，退回群列表解析群名');
    }
    return (await this.resolveChatNames(config))?.get(event.chatId);
  }

  private rememberChatUserCount(chatId: string, count: number | undefined) {
    this.chatUserCounts.set(chatId, { ...(count !== undefined ? { count } : {}), fetchedAt: Date.now() });
    if (this.chatUserCounts.size > 500) this.chatUserCounts.delete(this.chatUserCounts.values().next().value ? this.chatUserCounts.keys().next().value! : chatId);
  }

  /**
   * 群内人类成员数（不含机器人）：用于「单人群聊免 @ 自动响应」判定。
   * 仅当 `user_count === 1` 时返回 true；大于 1 人或查询失败一律返回 false（fail-closed，避免多人误触发）。
   */
  private async isSoloUserGroup(config: StoredLarkConfig, chatId: string): Promise<boolean> {
    if (typeof this.service.getChat !== 'function') return false;
    const cached = this.chatUserCounts.get(chatId);
    if (cached && Date.now() - cached.fetchedAt < 15_000) return cached.count === 1;
    let pending = this.chatUserCountFetches.get(chatId);
    if (!pending) {
      pending = Promise.resolve(this.service.getChat(chatId))
        .then(chat => {
          const count = chat?.userCount;
          this.rememberChatUserCount(chatId, count);
          return count;
        })
        .catch(error => {
          this.log.warn({ error, appId: config.appId, chatId }, '查询群成员人数失败，跳过单人群免 @ 自动唤醒');
          return undefined;
        })
        .finally(() => {
          if (this.chatUserCountFetches.get(chatId) === pending) this.chatUserCountFetches.delete(chatId);
        });
      this.chatUserCountFetches.set(chatId, pending);
    }
    return (await pending) === 1;
  }

  /** 「托管给机器人」建群时群名已落库；直接读本地映射，不依赖任何飞书接口。 */
  private async boundChatName(config: StoredLarkConfig, chatId: string): Promise<string | undefined> {
    if (!this.cardMappings) return undefined;
    try {
      const mapping = await this.cardMappings.get(larkHandoverChannel(config.appId), chatId);
      if (!mapping?.extra) return undefined;
      const extra = JSON.parse(mapping.extra) as { name?: unknown };
      return typeof extra.name === 'string' && extra.name.trim() ? extra.name.trim() : undefined;
    } catch (error) {
      this.log.warn({ error, appId: config.appId, chatId }, '读取托管群名失败，继续走飞书接口');
      return undefined;
    }
  }

  /**
   * 判断这次失败是不是「会话/ACP 回不来了」这一类会话级故障。
   *
   * 正常轮次失败（未返回最终输出、工具调用没返回、被截断）之前一定产生过 Agent 活动事件；
   * 只有连一次 thinking/text/tool 都没等到就失败的，才是连接/恢复层面的故障——此时重试大概率无效，
   * 应引导用户归档旧会话并按最新配置重开。
   */
  private shouldOfferSessionReopen(task: LarkTask): boolean {
    if (!task.sessionId || !this.runtime.archive || task.reopenOffered) return false;
    return !task.events.some(event => {
      if (event.type === 'thinking' || event.type === 'tool_call' || event.type === 'tool_result' || event.type === 'raw_terminal' || event.type === 'completed') return true;
      if (event.type === 'text') return (event.data as Record<string, unknown> | undefined)?.role !== 'user';
      return false;
    });
  }

  private sessionReopenElements(): LarkCardElement[] {
    return [{
      tag: 'markdown', element_id: 'session_reopen_notice', text_size: 'normal_v2', margin: '0px',
      content: '**当前会话已失效（Agent 连接已断开）。**\n点击「归档并重开」会归档旧会话，下一条消息将按最新配置新建会话。'
    }];
  }

  private sessionReopenActions(task: LarkTask, state: LarkTaskState): LarkCardActionButton[] | undefined {
    if (state !== 'failed' || !this.shouldOfferSessionReopen(task)) return undefined;
    const actions: LarkCardActionButton[] = [];
    if (task.retryable !== false) actions.push({ action: 'retry', label: '重试', style: 'default', elementId: 'retry' });
    actions.push({ action: 'archive_reopen', label: '归档并重开', style: 'primary', elementId: 'archive_reopen' });
    return actions;
  }

  private async saveCardTask(task: LarkTask, state = task.state) {
    if (!this.cardMappings || !task.sessionId || !task.cardMessageId || !task.startedAt) return;
    const cardTaskName = task.regexTrigger
      ? `[${task.regexTrigger.ruleName}] ${task.regexTrigger.messagePreview}`.slice(0, 80)
      : task.prompt.slice(0, 80);
    const forceMainFromThread = task.regexTrigger?.replyMode === 'main' && Boolean(task.event.threadId?.trim());
    const extra: PersistedLarkCardTask = {
      app_id: task.config.appId,
      chat_id: task.event.chatId,
      card_message_id: task.cardMessageId,
      ...(task.runtimeTaskId ? { runtime_task_id: task.runtimeTaskId } : {}),
      task_name: cardTaskName,
      prompt: task.prompt,
      state,
      ...(task.lastSuccessfulElements?.length ? { last_successful_elements: task.lastSuccessfulElements } : {}),
      ...(!forceMainFromThread && (task.event.chatType === 'group' || task.forceReplyInThread) ? {
        reply_message_id: task.event.messageId,
        ...(task.replyMode
          ? { reply_in_thread: task.replyMode === 'thread' }
          : task.regexTrigger
            ? { reply_in_thread: task.regexTrigger.replyMode === 'thread' }
            : (task.forceReplyInThread || task.event.threadId?.trim()) ? { reply_in_thread: true } : {})
      } : {}),
      started_at: task.startedAt
    };
    await this.cardMappings.save({
      id: `${larkCardChannel(task.config.appId)}:${task.id}`,
      channel: larkCardChannel(task.config.appId),
      externalId: task.id,
      sessionId: task.sessionId,
      extra: JSON.stringify(extra),
      createdAt: new Date(task.startedAt).toISOString()
    });
  }

  private async performReconcile(config: StoredLarkConfig) {
    if (!this.cardMappings || !this.runtime.getTasks || !this.runtime.getEvents) return 0;
    const mappings = await this.cardMappings.list(larkCardChannel(config.appId));
    let unresolved = 0;
    for (const mapping of mappings) {
      const persisted = persistedCardTask(mapping.extra);
      if (!persisted || terminalTaskStates.has(persisted.state)) continue;
      let runtimeTasks: TaskRecord[];
      try { runtimeTasks = await this.runtime.getTasks(mapping.sessionId); }
      catch (error) { unresolved++; this.log.warn({ error, sessionId: mapping.sessionId, externalId: mapping.externalId }, '读取待补偿飞书任务失败'); continue; }
      const runtimeTask = (persisted.runtime_task_id ? runtimeTasks.find(item => item.id === persisted.runtime_task_id) : undefined)
        ?? [...runtimeTasks].reverse().find(item => item.prompt === persisted.prompt && Date.parse(item.createdAt) >= persisted.started_at - 5_000);
      if (!runtimeTask || !terminalTaskStates.has(runtimeTask.status)) { unresolved++; continue; }
      let state: 'completed' | 'failed' | 'interrupted' = runtimeTask.status === 'completed'
        ? 'completed'
        : runtimeTask.status === 'failed' ? 'failed' : 'interrupted';
      const recentLimit = this.terminalReloadLimit(config);
      const sessionEvents = await (this.runtime.getRecentEvents?.(mapping.sessionId, recentLimit) ?? this.runtime.getEvents!(mapping.sessionId)).catch(() => []);
      const events = eventsForRuntimeTask(sessionEvents, runtimeTask.id);
      if (state === 'completed' && hasUnresolvedToolCalls(events)) state = 'failed';
      const completed = state === 'completed';
      const elapsedSeconds = Math.max(0, (Date.parse(runtimeTask.updatedAt) - persisted.started_at) / 1_000);
      let updated = false;
      let lastError: unknown;
      let contentRejected = false;
      const currentElements = boundLarkCardElements(renderLarkCardElements(events, config, completed));
      let deliveredElements = currentElements;
      for (let attempt = 1; attempt <= 3; attempt++) {
        try {
          await this.service.update({
            messageId: persisted.card_message_id,
            state,
            taskId: mapping.externalId,
            taskName: persisted.task_name,
            elapsedSeconds,
            sessionId: mapping.sessionId,
            ...(config.webBaseUrl ? { webBaseUrl: config.webBaseUrl } : {}),
            elements: currentElements
          });
          updated = true;
          break;
        } catch (error) {
          lastError = error;
          if (isLarkCardContentRejected(error)) { contentRejected = true; break; }
          if (attempt < 3) {
            const delay = isLarkMessageRateLimit(error) ? larkRateLimitBackoffMs(attempt) : attempt * 300;
            await new Promise(resolve => setTimeout(resolve, delay));
          }
        }
      }
      if (!updated && contentRejected && Array.isArray(persisted.last_successful_elements) && persisted.last_successful_elements.length) {
        const patchedElements = patchRejectedCardDelta(persisted.last_successful_elements, currentElements);
        try {
          await this.service.update({
            messageId: persisted.card_message_id,
            state,
            taskId: mapping.externalId,
            taskName: persisted.task_name,
            elapsedSeconds,
            sessionId: mapping.sessionId,
            ...(config.webBaseUrl ? { webBaseUrl: config.webBaseUrl } : {}),
            elements: patchedElements
          });
          updated = true;
          deliveredElements = patchedElements;
          lastError = undefined;
          this.log.warn({ messageId: persisted.card_message_id, state }, '飞书终态卡片增量被拒绝，已保留上次成功内容并原地修补');
        } catch (error) {
          lastError = error;
        }
      }
      let cardMessageId = persisted.card_message_id;
      if (!updated) {
        if (!isLarkMessageUnupdatable(lastError)) {
          const attempts = (persisted.reconcile_attempts ?? 0) + 1;
          if (attempts >= MAX_RECONCILE_ATTEMPTS) {
            this.log.warn({ error: lastError, messageId: persisted.card_message_id, attempts }, `飞书原卡更新失败已达 ${MAX_RECONCILE_ATTEMPTS} 次上限，不再等待下次对账，尝试补发新卡片`);
            // 不 continue，继续往下走补发新卡片的逻辑
          } else {
            await this.cardMappings.save({
              ...mapping,
              extra: JSON.stringify({ ...persisted, reconcile_attempts: attempts })
            });
            this.log.warn({ error: lastError, messageId: persisted.card_message_id, attempts }, '飞书原卡暂时更新失败，保留原卡等待下次对账');
            unresolved++;
            continue;
          }
        }
        try {
          const replacementElements = contentRejected
            ? patchRejectedCardDelta(persisted.last_successful_elements, currentElements)
            : boundLarkCardElements(renderLarkCardElements(events, config, completed, true));
          const replacement = await sendPersistedTaskCard(this.service, persisted, {
            state,
            taskId: mapping.externalId,
            taskName: persisted.task_name,
            elapsedSeconds,
            sessionId: mapping.sessionId,
            ...(config.webBaseUrl ? { webBaseUrl: config.webBaseUrl } : {}),
            elements: replacementElements,
            idempotencyKey: `reconcile_${persisted.card_message_id}_${state}`.slice(0, 50)
          }, this.log);
          cardMessageId = replacement.messageId;
          deliveredElements = replacementElements;
        } catch (error) {
          if (isLarkCardContentRejected(error)) {
            try {
              const patchedElements = patchRejectedCardDelta(persisted.last_successful_elements, currentElements);
              const minimal = await sendPersistedTaskCard(this.service, persisted, {
                state,
                taskId: mapping.externalId,
                taskName: persisted.task_name,
                elapsedSeconds,
                sessionId: mapping.sessionId,
                ...(config.webBaseUrl ? { webBaseUrl: config.webBaseUrl } : {}),
                elements: patchedElements,
                idempotencyKey: `reconcile_safe_${persisted.card_message_id}_${state}`.slice(0, 50)
              }, this.log);
              cardMessageId = minimal.messageId;
              deliveredElements = patchedElements;
              this.log.warn({ rejectedMessageId: persisted.card_message_id, replacementMessageId: cardMessageId, upstreamCode: error.details?.upstreamCode }, '飞书补发终态卡片内容被拒绝，已降级为最小安全卡片');
            } catch (fallbackError) {
              this.log.error({ error: fallbackError, contentError: error, updateError: lastError, messageId: persisted.card_message_id }, '飞书终态对账最小卡片补偿失败');
              unresolved++;
              continue;
            }
          } else {
            this.log.error({ error, updateError: lastError, messageId: persisted.card_message_id }, '飞书终态对账补偿失败');
            unresolved++;
            continue;
          }
        }
      }
      await this.cardMappings.save({
        ...mapping,
        extra: JSON.stringify({ ...persisted, card_message_id: cardMessageId, runtime_task_id: runtimeTask.id, state, last_successful_elements: deliveredElements, reconcile_attempts: undefined })
      });
      this.log.info({ messageId: persisted.card_message_id, replacementMessageId: cardMessageId === persisted.card_message_id ? undefined : cardMessageId, state }, '飞书卡片终态对账完成');
    }
    return unresolved;
  }

  reconcile(config: StoredLarkConfig) {
    this.reconcileConfig = config;
    if (this.reconcileRun) return this.reconcileRun;
    const run = this.performReconcile(config).finally(() => {
      if (this.reconcileRun === run) this.reconcileRun = undefined;
    });
    this.reconcileRun = run;
    return run;
  }

  private scheduleReconcile() {
    if (this.stopped || this.reconcileTimer || !this.reconcileConfig) return;
    this.reconcileTimer = setTimeout(() => {
      this.reconcileTimer = undefined;
      const config = this.reconcileConfig;
      if (!config || this.stopped) return;
      void this.reconcile(config).then(unresolved => {
        if (unresolved > 0) this.scheduleReconcile();
      }).catch(error => {
        this.log.warn({ error, appId: config.appId }, '飞书卡片周期对账失败，稍后重试');
        this.scheduleReconcile();
      });
    }, this.reconcileIntervalMs);
    this.reconcileTimer.unref();
  }

  async startReconciliation(config: StoredLarkConfig, intervalMs = 5_000) {
    this.reconcileConfig = config;
    this.reconcileIntervalMs = Math.max(50, intervalMs);
    if (this.reconcileTimer) { clearTimeout(this.reconcileTimer); this.reconcileTimer = undefined; }
    const unresolved = await this.reconcile(config);
    if (unresolved > 0) this.scheduleReconcile();
    return unresolved;
  }

  // 某条 mention 是否指向本机器人：以 open_id 为主，兼容 app_id；
  // botOpenId 尚未解析出来时兜底按 mentioned_type='bot' 识别。
  private isSelfMention(config: StoredLarkConfig, mention: { key?: string; name?: string; openId?: string; appId?: string; mentionedType?: string }) {
    return (this.botOpenId !== undefined && mention.openId === this.botOpenId)
      || (mention.appId !== undefined && mention.appId === config.appId)
      || (this.botOpenId === undefined && mention.mentionedType === 'bot');
  }

  private async lookupSideChatThread(appId: string, event: Pick<LarkMessageEvent, 'rootId' | 'threadId'>): Promise<{ key: string; sessionId: string } | undefined> {
    const keys = [event.rootId?.trim(), event.threadId?.trim()].filter((value): value is string => Boolean(value));
    for (const key of keys) {
      const mem = this.sideChatThreads.get(`${appId}:${key}`);
      if (mem) return { key, sessionId: mem };
      if (this.cardMappings) {
        try {
          const mapping = await this.cardMappings.get(larkSideChatThreadChannel(appId), key);
          if (mapping?.sessionId) {
            this.sideChatThreads.set(`${appId}:${key}`, mapping.sessionId);
            return { key, sessionId: mapping.sessionId };
          }
        } catch (error) {
          this.log.warn({ error, appId, key }, '读取飞书侧聊话题绑定失败');
        }
      }
    }
    return undefined;
  }

  private async saveSideChatThread(appId: string, keys: string[], sessionId: string) {
    const uniqueKeys = [...new Set(keys.map(key => key.trim()).filter(Boolean))];
    for (const key of uniqueKeys) {
      this.sideChatThreads.set(`${appId}:${key}`, sessionId);
      if (this.sideChatThreads.size > 5_000) this.sideChatThreads.delete(this.sideChatThreads.keys().next().value!);
      if (this.cardMappings) {
        try {
          await this.cardMappings.save({
            id: `${larkSideChatThreadChannel(appId)}:${key}`,
            channel: larkSideChatThreadChannel(appId),
            externalId: key,
            sessionId,
            createdAt: new Date().toISOString()
          });
        } catch (error) {
          this.log.warn({ error, appId, key, sessionId }, '持久化飞书侧聊话题绑定失败');
        }
      }
    }
  }

  /** 查找当前聊天对应的主会话（用于侧边会话关联父会话上下文，不新建主会话）。 */
  private async findParentSessionForSideChat(
    config: StoredLarkConfig,
    event: LarkMessageEvent,
    parentGroupKey: string,
    parentSourceId: string
  ): Promise<Session | undefined> {
    const parentGroup = this.groups.get(parentGroupKey);
    let candidateId = parentGroup?.boundSessionId ?? parentGroup?.sessionId;
    if (!candidateId && this.cardMappings) {
      try {
        const handover = await this.cardMappings.get(larkHandoverChannel(config.appId), event.chatId);
        if (handover?.sessionId) candidateId = handover.sessionId;
      } catch { /* ignore */ }
    }
    if (candidateId) {
      const existing = await this.runtime.getSession(candidateId);
      if (existing && !existing.archivedAt) return existing;
    }
    if (this.runtime.listSessions) {
      const sessions = await this.runtime.listSessions();
      const matched = [...sessions].reverse().find(item => item.source === 'lark'
        && item.sourceId === parentSourceId
        && !item.archivedAt);
      if (matched) return matched;
    }
    return undefined;
  }

  /**
   * 按 SideChatConfig 创建飞书侧边会话并绑定话题。
   * 复用与网页端完全一致的「侧边会话」模型（source: 'side-chat' + buildSideSessionSeed）。
   */
  private async sideChatSessionFor(task: LarkTask): Promise<Session> {
    const { group, event, config, sideChat } = task;
    if (!sideChat) throw new Error('Missing sideChat context');
    if (group.boundSessionId) {
      const existing = await this.runtime.getSession(group.boundSessionId);
      if (existing && !existing.archivedAt && !['failed', 'stopped'].includes(existing.state)) return existing;
    }
    const parentSession = await this.findParentSessionForSideChat(config, event, sideChat.parentGroupKey, sideChat.parentSourceId);
    const sideConfig = sideChat.config;

    let agentId: string | undefined;
    let model: string | undefined;
    let reasoningEffort: string | undefined;

    if (sideConfig.targetMode === 'custom_agent' && sideConfig.agentId?.trim()) {
      const targetId = sideConfig.agentId.trim();
      const availableAgents = this.runtime.listAgents ? await this.runtime.listAgents() : undefined;
      const available = !availableAgents || availableAgents.some(agent => agent.id === targetId && !agent.disabled);
      if (available) {
        agentId = targetId;
        model = sideConfig.model?.trim() || undefined;
        reasoningEffort = sideConfig.reasoningEffort?.trim() || undefined;
      }
    }

    if (!agentId) {
      agentId = parentSession?.agentId ?? config.defaultAgentId;
      model = parentSession ? parentSession.model : config.defaultModel;
      reasoningEffort = parentSession ? parentSession.reasoningEffort : config.defaultReasoningEffort;
    }
    if (!agentId) throw new Error('尚未配置默认 Agent，请先在设置中配置飞书默认 Agent 或侧边对话目标 Agent');

    const cwd = parentSession?.cwd ?? config.workspace;
    const session = await this.runtime.start({
      agentId,
      ...(cwd ? { cwd } : {}),
      ...(model ? { model } : {}),
      ...(reasoningEffort ? { reasoningEffort } : {}),
      ...(parentSession ? { systemPrompt: buildSideSessionSeed(parentSession.id) } : {}),
      permissionMode: 'full-trust',
      source: 'side-chat',
      sourceId: parentSession ? parentSession.id : sideChat.parentSourceId
    });
    group.boundSessionId = session.id;
    group.sessionId = session.id;
    await this.saveSideChatThread(config.appId, [sideChat.triggerRootId, ...(event.threadId ? [event.threadId] : [])], session.id);
    return session;
  }

  async handle(event: LarkMessageEvent, config: StoredLarkConfig) {
    if (this.stopped || this.handledMessages.has(event.messageId)) return;
    // 防自激循环：本机器人发出的任何消息（全轮次同步卡片/文本、group send 等）绝不可反向唤醒自己。
    if (this.botOpenId && event.senderOpenId && event.senderOpenId === this.botOpenId) return;
    if (this.turnTracker?.isOutboundMessage(event.messageId)) return;

    // 唤醒判定以 open_id 为主（机器人被 @ 时飞书回调给的也是 open_id），
    // 并兼容极端情况下携带 app_id 的形态。@ 唤不醒时先看下面那条日志里的原始 mentions。
    const mentionsBot = event.mentions.some(mention => this.isSelfMention(config, mention));
    // 先查是否处于机器人已开启的侧聊话题中：在群聊侧聊话题下直接追问（且没有 @ 别人）时自动唤醒，无需每次再 @ 或敲 /btw。
    const existingSideThread = await this.lookupSideChatThread(config.appId, event);
    const inSideChatFollowUp = Boolean(existingSideThread) && (event.chatType === 'p2p' || mentionsBot || event.mentions.length === 0);
    let shouldWake = event.chatType === 'p2p' || (event.chatType === 'group' && mentionsBot) || inSideChatFollowUp;

    // 群聊正则自动唤起：当消息未直接 @ 本机器人时，匹配对应 botId + chatId 的已启用正则规则。
    // 若同一消息已经 @ 了本机器人（shouldWake 已为 true），直接走常规 @ 路径且只触发一轮，避免重复唤起。
    let matchedRegex: Awaited<ReturnType<typeof findMatchingRealtimeRegexTrigger>>;
    let regexParsedText = '';
    if (
      !shouldWake
      && !this.stopped
      && !this.handledMessages.has(event.messageId)
      && event.chatType === 'group'
      && this.configRepository
    ) {
      const isSelfBot = Boolean(this.botOpenId && event.senderOpenId === this.botOpenId);
      if (!isSelfBot) {
        try {
          const quickParsed = await parseLarkMessageContent(event.messageType, event.content, { messageId: event.messageId });
          regexParsedText = renderPromptMentions(quickParsed.text, event.mentions, mention => this.isSelfMention(config, mention)).trim();
          matchedRegex = await findMatchingRealtimeRegexTrigger(this.configRepository, {
            botId: config.appId,
            chatId: event.chatId,
            messageId: event.messageId,
            messageText: regexParsedText,
            ...(event.senderType ? { senderType: event.senderType } : {}),
            isSelfBot
          });
          if (matchedRegex) {
            shouldWake = true;
            this.log.info(
              { messageId: event.messageId, chatId: event.chatId, appId: config.appId, ruleId: matchedRegex.rule.id, ruleName: matchedRegex.rule.name, replyMode: matchedRegex.rule.replyMode },
              '飞书群消息命中正则规则，自动唤起机器人'
            );
          }
        } catch (error) {
          this.log.warn({ error, messageId: event.messageId, chatId: event.chatId, appId: config.appId }, '检测飞书群聊正则监听规则失败');
        }
      }
    }

    // 单人群聊（群内只有 1 名人类成员，不含机器人）且未 @ 别人时，免 @ 自动响应；群内超过 1 人自动关闭。
    if (
      !shouldWake
      && !this.stopped
      && !this.handledMessages.has(event.messageId)
      && event.chatType === 'group'
      && event.mentions.length === 0
      && (!event.senderType || event.senderType === 'user')
    ) {
      if (await this.isSoloUserGroup(config, event.chatId)) {
        shouldWake = true;
        this.log.info({ messageId: event.messageId, chatId: event.chatId, appId: config.appId }, '单人群聊免 @ 自动唤醒');
      }
    }
    if (event.chatType === 'group' && !shouldWake && event.mentions.length) {
      // 有 @ 却没命中本机器人：多数是正常的（@ 的是别人），但也是「@ 不醒」类问题的第一现场。
      this.log.info({ messageId: event.messageId, chatId: event.chatId, appId: config.appId, botOpenId: this.botOpenId, mentions: event.mentions }, '飞书消息含 @ 但未命中本机器人，跳过');
    }
    if (this.stopped || !shouldWake || this.handledMessages.has(event.messageId)) return;
    // 先标记已处理，避免异步解析期间同一条消息被重复入队。
    this.handledMessages.add(event.messageId);
    if (this.handledMessages.size > 5_000) this.handledMessages.delete(this.handledMessages.values().next().value!);

    const sideChatConfig = await readSideChatConfig(this.configRepository);
    const mainScopeId = larkGroupScopeId(event, config.groupSessionScope);
    const mainGroupKey = larkGroupKey(event, config.groupSessionScope);

    // 轻量检测消息正文是否命中侧边对话触发前缀（默认 /btw），不阻塞主会话队列。
    let matchedNewSideChat = false;
    if (!matchedRegex && !existingSideThread && sideChatConfig.btwEnabled) {
      try {
        const quickParsed = await parseLarkMessageContent(event.messageType, event.content, { messageId: event.messageId });
        const quickText = renderPromptMentions(quickParsed.text, event.mentions, mention => this.isSelfMention(config, mention)).trim();
        matchedNewSideChat = matchSideChatTrigger(quickText, sideChatConfig.triggerPrefix).matched;
      } catch { /* 解析失败按普通消息处理 */ }
    }

    const triggerRootId = event.rootId?.trim() || event.messageId;
    const isSideChat = !matchedRegex && (Boolean(existingSideThread) || matchedNewSideChat);
    const regexGroupKey = matchedRegex
      ? (matchedRegex.rule.replyMode === 'thread'
          ? `${event.chatId}:${event.threadId?.trim() ? `thread:${event.threadId.trim()}` : `regex-thread:${event.messageId}`}`
          : mainGroupKey)
      : undefined;
    const groupKey = isSideChat
      ? `side-chat:${event.chatId}:${existingSideThread ? existingSideThread.key : triggerRootId}`
      : (regexGroupKey ?? mainGroupKey);
    const group = this.groups.get(groupKey) ?? { tail: Promise.resolve() };
    if (existingSideThread) {
      group.boundSessionId = existingSideThread.sessionId;
      // 追问消息带了新的 threadId 时顺便补记，确保后续按 threadId 也能命中。
      if (event.threadId?.trim()) {
        void this.saveSideChatThread(config.appId, [existingSideThread.key, event.threadId.trim()], existingSideThread.sessionId);
      }
    } else if (!isSideChat && !matchedRegex && !group.boundSessionId && this.cardMappings) {
      // 「托管给机器人」：该群被显式绑定到某个会话时，忽略常规的 sourceId 复用，强制用这个会话。
      try {
        const mapping = await this.cardMappings.get(larkHandoverChannel(config.appId), event.chatId);
        if (mapping?.sessionId) group.boundSessionId = mapping.sessionId;
      } catch (error) {
        this.log.warn({ error, appId: config.appId, chatId: event.chatId }, '读取托管绑定失败，按普通会话处理');
      }
    }

    const task: LarkTask = {
      id: event.messageId,
      group,
      event,
      prompt: '',
      resources: [],
      config,
      state: 'queued',
      events: [],
      turn: 0,
      ...(isSideChat || matchedRegex?.rule.replyMode === 'thread' ? { forceReplyInThread: true } : {}),
      ...(matchedRegex ? {
        regexTrigger: {
          ruleId: matchedRegex.rule.id,
          ruleName: matchedRegex.rule.name,
          chatName: matchedRegex.rule.chatName,
          pattern: matchedRegex.rule.pattern,
          flags: matchedRegex.rule.flags,
          replyMode: matchedRegex.rule.replyMode,
          promptTemplate: matchedRegex.rule.promptTemplate,
          matchedText: matchedRegex.matchedText,
          messagePreview: regexParsedText.slice(0, 120),
          triggerType: 'realtime',
          allowBotSender: !matchedRegex.rule.ignoreBotMessages
        }
      } : {}),
      ...(matchedNewSideChat ? {
        sideChat: {
          parentGroupKey: mainGroupKey,
          parentSourceId: larkSourceId(config, event.chatId, event.chatType, mainScopeId),
          triggerRootId,
          config: sideChatConfig
        }
      } : {})
    };
    this.tasks.set(task.id, task);
    if (this.tasks.size > 5_000) this.tasks.delete(this.tasks.keys().next().value!);
    const stripSideChatTriggerPrefix = isSideChat && sideChatConfig.btwEnabled ? sideChatConfig.triggerPrefix : undefined;
    group.tail = group.tail.then(async () => {
      if (this.stopped) return;
      const parsed = await parsePrompt(event, mention => this.isSelfMention(config, mention), this.service, {
        log: this.log,
        appId: config.appId,
        ...(stripSideChatTriggerPrefix ? { stripSideChatTriggerPrefix } : {})
      });
      if (task.regexTrigger) {
        let senderName = task.regexTrigger.senderName;
        if (!senderName && event.senderOpenId && event.senderType !== 'app' && event.senderType !== 'bot') {
          senderName = await this.service.getUserName(event.senderOpenId).catch(() => undefined);
          if (senderName) task.regexTrigger.senderName = senderName;
        }
        const chatName = task.regexTrigger.chatName && task.regexTrigger.chatName !== event.chatId
          ? task.regexTrigger.chatName
          : (await this.resolveCurrentChatName(config, event)) || event.chatId;
        task.regexTrigger.chatName = chatName;
        const messageText = parsed.prompt || regexParsedText;
        task.regexTrigger.messagePreview = messageText.slice(0, 120);
        task.prompt = buildRegexTriggerPrompt({
          promptTemplate: task.regexTrigger.promptTemplate,
          chatName,
          chatId: event.chatId,
          botName: config.name ?? config.appId,
          botId: config.appId,
          ruleName: task.regexTrigger.ruleName,
          pattern: task.regexTrigger.pattern,
          flags: task.regexTrigger.flags,
          replyMode: task.regexTrigger.replyMode,
          ...(senderName ? { senderName } : {}),
          ...(event.senderOpenId ? { senderId: event.senderOpenId } : {}),
          messageId: event.messageId,
          ...(event.createTime ? { messageTime: event.createTime } : {}),
          messageText,
          matchedText: task.regexTrigger.matchedText,
          triggerType: 'realtime'
        });
      } else {
        task.prompt = parsed.prompt;
      }
      task.resources = parsed.resources;
      await this.runTurn(task);
      if (task.regexTrigger) {
        await recordLarkRegexTriggerHit(this.configRepository, {
          ruleId: task.regexTrigger.ruleId,
          botId: config.appId,
          chatId: event.chatId,
          messageId: event.messageId,
          ...(task.sessionId ? { sessionId: task.sessionId } : {}),
          ...(task.cardMessageId ? { cardMessageId: task.cardMessageId } : {}),
          matchedText: task.regexTrigger.matchedText,
          ...(task.regexTrigger.senderName ? { senderName: task.regexTrigger.senderName } : {}),
          messagePreview: task.regexTrigger.messagePreview,
          triggerType: 'realtime',
          status: task.state === 'failed' ? 'failed' : 'triggered',
          ...(task.failureReason ? { error: task.failureReason } : {})
        });
      }
    }).catch(error => {
      this.log.error({ error, chatId: event.chatId, messageId: event.messageId }, '处理飞书唤醒消息失败');
    });
    this.groups.set(groupKey, group);
  }

  /**
   * 历史命中消息补偿入口：100% 复用当前机器人的飞书设置（Agent/模型/工作区/预注入 Prompt/群协作工具/门禁/卡片流式推送），
   * 按规则的 replyMode（话题内或主线程）发起一轮 Agent，并在派发成功后立即返回 sessionId 与 cardMessageId。
   */
  async triggerRegexMatch(input: {
    event: LarkMessageEvent;
    config: StoredLarkConfig;
    rule: {
      id: string;
      name: string;
      chatName: string;
      pattern: string;
      flags: string;
      replyMode: LarkRegexReplyMode;
      promptTemplate: string;
    };
    matchedText: string;
    messageText: string;
    senderName?: string;
    triggerType?: LarkRegexTriggerHitType;
  }): Promise<{ sessionId?: string; cardMessageId?: string; taskId: string }> {
    const { event, config, rule } = input;
    const triggerType = input.triggerType ?? 'backfill';
    const mainGroupKey = larkGroupKey(event, config.groupSessionScope);
    const groupKey = rule.replyMode === 'thread'
      ? `${event.chatId}:${event.threadId?.trim() ? `thread:${event.threadId.trim()}` : `regex-thread:${event.messageId}`}`
      : mainGroupKey;
    const group = this.groups.get(groupKey) ?? { tail: Promise.resolve() };
    this.groups.set(groupKey, group);

    const chatName = rule.chatName?.trim() || event.chatId;
    const prompt = buildRegexTriggerPrompt({
      promptTemplate: rule.promptTemplate,
      chatName,
      chatId: event.chatId,
      botName: config.name ?? config.appId,
      botId: config.appId,
      ruleName: rule.name,
      pattern: rule.pattern,
      flags: rule.flags,
      replyMode: rule.replyMode,
      ...(input.senderName ? { senderName: input.senderName } : {}),
      ...(event.senderOpenId ? { senderId: event.senderOpenId } : {}),
      messageId: event.messageId,
      ...(event.createTime ? { messageTime: event.createTime } : {}),
      messageText: input.messageText,
      matchedText: input.matchedText,
      triggerType
    });

    const taskId = triggerType === 'backfill' ? `${event.messageId}:bf:${Date.now().toString(36)}` : event.messageId;
    const task: LarkTask = {
      id: taskId,
      group,
      event,
      prompt,
      resources: [],
      config,
      state: 'queued',
      events: [],
      turn: 0,
      ...(rule.replyMode === 'thread' ? { forceReplyInThread: true } : {}),
      regexTrigger: {
        ruleId: rule.id,
        ruleName: rule.name,
        chatName,
        pattern: rule.pattern,
        flags: rule.flags,
        replyMode: rule.replyMode,
        promptTemplate: rule.promptTemplate,
        matchedText: input.matchedText,
        messagePreview: input.messageText.slice(0, 120),
        ...(input.senderName ? { senderName: input.senderName } : {}),
        triggerType,
        allowBotSender: true,
        backfillByAdmin: triggerType === 'backfill'
      }
    };
    this.tasks.set(task.id, task);
    if (this.tasks.size > 5_000) this.tasks.delete(this.tasks.keys().next().value!);
    this.handledMessages.add(event.messageId);
    if (this.handledMessages.size > 5_000) this.handledMessages.delete(this.handledMessages.values().next().value!);

    const runPromise = group.tail.then(() => this.runTurn(task));
    group.tail = runPromise.catch(error => {
      this.log.error({ error, chatId: event.chatId, messageId: event.messageId, ruleId: rule.id }, '飞书历史补偿轮次执行失败');
    });
    await runPromise;

    if (task.state === 'failed' && (!task.sessionId || task.failureReason)) {
      throw new LarkServiceError('LARK_BACKFILL_FAILED', task.failureReason || '发起历史补偿轮次失败', 502);
    }
    return {
      taskId: task.id,
      ...(task.sessionId ? { sessionId: task.sessionId } : {}),
      ...(task.cardMessageId ? { cardMessageId: task.cardMessageId } : {})
    };
  }

  /**
   * 卡片操作人的访问权限校验，与 runTurn 中「谁可以使用 Agent」的配置保持一致：
   * - 未配置白名单时所有人均可操作
   * - 配置了 allowedUsers 时按 openId 匹配
   * - 仅配置 allowedEmails 时拉取操作人邮箱匹配
   */
  private async isOperatorAllowed(config: StoredLarkConfig, operatorOpenId?: string, chatId?: string): Promise<boolean> {
    return isLarkOperatorAllowed({
      config,
      ...(operatorOpenId ? { operatorOpenId } : {}),
      // card.action.trigger 的 operator 只可能是终端用户；显式声明后才能对 230001 fail-closed。
      operatorType: 'user',
      operatorIdentity: 'open_id',
      ...(chatId ? { chatId } : {}),
      service: this.service,
      ...(this.configRepository ? { repository: this.configRepository } : {}),
      log: this.log
    });
  }

  private pushTaskError(task: LarkTask, message: string) {
    task.events.push({
      id: `lark-action-error-${task.id}-${Date.now()}`,
      sessionId: task.sessionId ?? '',
      sequence: Number.MAX_SAFE_INTEGER,
      type: 'error',
      timestamp: new Date().toISOString(),
      data: { message }
    });
  }

  async handleAction(value: unknown, operatorOpenId?: string, context?: LarkCardActionContext) {
    let parsed = value;
    if (typeof parsed === 'string') {
      try { parsed = JSON.parse(parsed); } catch { return { type: 'error', content: '无法识别卡片操作' }; }
    }
    if (!parsed || typeof parsed !== 'object') return { type: 'error', content: '无法识别卡片操作' };
    const action = String((parsed as any).action ?? '');
    if (this.larkPluginAdapters.isPluginCardAction(action, parsed as Record<string, unknown>)) {
      return this.handleOutputPluginAction(action, parsed as Record<string, unknown>, operatorOpenId, context);
    }
    const taskId = String((parsed as any).task_id ?? (parsed as any).taskId ?? '');
    const task = this.tasks.get(taskId);
    if (!task) return { type: 'warning', content: '任务已过期，请重新发送消息' };

    // 访问权限：操作人必须在机器人白名单中，与「谁可以使用 Agent」的配置一致。
    // 白名单内的成员均可取消 / 中断 / 重试任意任务，不再限制为任务发起人本人，
    // 避免 AI 协作链（上游 AI 触发下游 AI 任务）中人类无法干预的问题。
    const allowed = await this.isOperatorAllowed(task.config, operatorOpenId, task.event.chatId);
    if (!allowed) {
      return { type: 'warning', content: '当前账号不在机器人白名单中，无法执行此操作' };
    }

    // 会话/ACP 已失效时的自愈出口：归档旧会话并放掉 group 绑定，
    // 下一条消息走 sessionFor 重新创建会话，自然带上最新配置。
    if (action === 'archive_reopen') {
      if (task.state !== 'failed') return { type: 'warning', content: '只有失败的任务可以归档并重开会话' };
      if (!task.sessionId) return { type: 'warning', content: '当前任务没有可归档的会话' };
      if (!this.runtime.archive) return { type: 'warning', content: '当前运行时不支持归档会话' };
      const sessionId = task.sessionId;
      try {
        await this.runtime.archive(sessionId);
      } catch (error) {
        this.log.warn({ error, taskId, sessionId }, '归档飞书失效会话失败');
        return { type: 'error', content: `归档会话失败：${error instanceof Error ? error.message : String(error)}` };
      }
      task.reopenOffered = true;
      if (task.group.sessionId === sessionId) { task.group.sessionId = undefined; task.group.sessionConfigKey = undefined; }
      this.log.info({ taskId, sessionId, appId: task.config.appId, chatId: task.event.chatId }, '已归档飞书失效会话，下一条消息将按最新配置重新创建');
      return { type: 'success', content: '已归档旧会话，下一条消息将按最新配置重新创建' };
    }

    // 旧版排队卡片会发 interrupt，仍按安全的单轮次取消处理，不中断当前运行任务。
    if (action === 'cancel' || (action === 'interrupt' && task.state === 'queued')) {
      if (task.state !== 'queued') return { type: 'warning', content: '任务已不在排队中' };
      if (!task.sessionId || !task.runtimeTaskId || !this.runtime.cancelQueued) return { type: 'warning', content: '排队任务当前不可取消' };
      task.state = 'interrupting';
      const sessionId = task.sessionId;
      const runtimeTaskId = task.runtimeTaskId;
      const cancelQueued = this.runtime.cancelQueued.bind(this.runtime);
      void (async () => {
        try {
          await cancelQueued(sessionId, runtimeTaskId);
          task.state = 'interrupted';
          await task.requestUpdate?.('interrupted', false);
        } catch (error) {
          // 排队任务可能在点击时已转为运行态；绝不回退中断 Session，交由任务事件流对账实际状态。
          if (task.state === 'interrupting') task.state = 'queued';
          this.log.warn({ error, taskId, sessionId, runtimeTaskId }, '取消飞书排队任务失败');
          this.pushTaskError(task, `取消排队任务失败：${error instanceof Error ? error.message : String(error)}`);
          await task.requestUpdate?.('queued', false).catch(() => undefined);
        }
      })();
      return { type: 'success', content: '正在取消排队任务' };
    }

    if (action === 'interrupt') {
      if (!task.sessionId || task.state !== 'running') return { type: 'warning', content: '任务当前不可中断' };
      task.state = 'interrupting';
      task.interruptRequested = true;
      const sessionId = task.sessionId;
      void (async () => {
        try {
          await this.runtime.interrupt(sessionId);
          task.state = 'interrupted';
          await task.requestUpdate?.('interrupted', false);
        } catch (error) {
          task.state = 'running';
          task.interruptRequested = false;
          this.log.warn({ error, taskId, sessionId }, '中断飞书任务失败');
          this.pushTaskError(task, `中断任务失败：${error instanceof Error ? error.message : String(error)}`);
          await task.requestUpdate?.('running', false).catch(() => undefined);
        }
      })();
      return { type: 'success', content: '正在取消任务' };
    }

    if (action === 'retry') {
      if (task.state !== 'failed' && task.state !== 'interrupted') return { type: 'warning', content: '只有失败或已中断的任务可以重试' };
      task.state = 'queued';
      task.group.tail = task.group.tail.then(() => this.runTurn(task)).catch(error => {
        this.log.error({ error, chatId: task.event.chatId, messageId: task.event.messageId }, '重试飞书任务失败');
        this.pushTaskError(task, `重试任务失败：${error instanceof Error ? error.message : String(error)}`);
        task.state = 'failed';
        task.requestUpdate?.('failed', false).catch(() => undefined);
      });
      return { type: 'success', content: '已开始重试' };
    }

    return { type: 'error', content: '不支持的卡片操作' };
  }

  private async handleOutputPluginAction(
    action: string,
    value: Record<string, unknown>,
    operatorOpenId?: string,
    context?: LarkCardActionContext
  ): Promise<{ type: 'success' | 'warning' | 'error' | 'info'; content: string }> {
    const hintedPluginId = typeof value.plugin_id === 'string' && value.plugin_id.trim()
      ? normalizeOutputPluginId(value.plugin_id)
      : undefined;

    if (action === 'ask_user_question_preview') {
      return { type: 'info', content: '这是 AskUserQuestion 样式预览卡片；实际对话中点击将提交回答并驱动 Agent 继续执行' };
    }
    if (action === 'confirm_action_preview') {
      return { type: 'info', content: '这是操作确认样式预览卡片；实际对话中点击将提交决定并驱动 Agent 继续执行' };
    }
    if (action === 'output_plugin_preview') {
      return { type: 'info', content: '这是交互插件样式预览卡片；实际对话中点击将提交响应并驱动 Agent 继续执行' };
    }

    const cardId = String(value.card_id ?? value.cardId ?? '').trim();
    if (!cardId) return { type: 'error', content: '交互卡片缺少标识，无法提交' };

    const record = await this.lookupPluginCard(cardId, hintedPluginId);
    if (!record) return { type: 'warning', content: '交互卡片已失效，请在会话中直接回复' };

    const plugin = this.resolvedPluginRegistry.get(record.pluginId);
    if (!plugin) return { type: 'warning', content: `对应交互插件（${record.pluginId}）当前未加载` };
    const adapter = this.larkPluginAdapters.resolve(plugin);
    if (!adapter || !adapter.parseAction) {
      return { type: 'error', content: '当前插件暂不支持飞书交互回调' };
    }

    const botConfig = (this.reconcileConfig?.appId === record.appId ? this.reconcileConfig : undefined)
      ?? (await readLarkConfig(this.configRepository, record.appId))
      ?? ({
        appId: record.appId,
        appSecret: '',
        listening: true,
        groupToolsEnabled: false,
        groupToolsAllowSend: false,
        groupSessionScope: 'user',
        pushIntervalMs: 1_000,
        hideTraceOnComplete: false,
        quietReply: false,
        allowedUsers: [],
        allowedEmails: [],
        allowedBots: [],
        peerBotsAllowed: true,
        highRiskAllowedUsers: [],
        highRiskAllowedEmails: [],
        highRiskPattern: defaultHighRiskPattern,
        gateEnabled: false,
        softGateEnabled: false,
        hardGateEnabled: false,
        hookTrustConfirmed: false,
        preInjectPrompt: '',
        ...(record.webBaseUrl ? { webBaseUrl: record.webBaseUrl } : {})
      } satisfies StoredLarkConfig);

    const allowed = await this.isOperatorAllowed(botConfig, operatorOpenId, record.chatId);
    if (!allowed) {
      return { type: 'warning', content: '当前账号不在机器人白名单中，无法提交操作' };
    }

    const parsedAction = adapter.parseAction(record.spec, action, value, context?.formValue);
    if (!parsedAction.ok) {
      return { type: 'warning', content: parsedAction.error };
    }

    const actedBy = operatorOpenId && typeof this.service.getUserName === 'function'
      ? (await this.service.getUserName(operatorOpenId).catch(() => '')) || undefined
      : undefined;

    const cardMessageId = context?.openMessageId?.trim() || record.messageId;
    const webBaseUrl = record.webBaseUrl ?? botConfig.webBaseUrl;
    const isAsk = plugin.id === BUILTIN_ASK_USER_QUESTION_PLUGIN_ID;

    const updateCardToAnswered = async (payload: unknown) => {
      if (!cardMessageId || typeof this.service.updateInteractiveCard !== 'function' || !adapter.buildAnsweredCard) return;
      try {
        await this.service.updateInteractiveCard({
          messageId: cardMessageId,
          card: adapter.buildAnsweredCard({
            plugin,
            payload,
            sessionId: record.sessionId,
            webBaseUrl
          })
        });
      } catch (error) {
        this.log.warn({ error, cardId, pluginId: plugin.id, messageId: cardMessageId }, '更新飞书交互插件锁定卡片失败');
      }
    };

    const dispatchFollowUp = async (params: {
      prompt: string;
      agentPrompt: string;
      origin: string;
      clientMessageId: string;
      payload: unknown;
    }) => {
      const groupKey = `${record.appId}:outp:${record.sessionId}`;
      let group = this.groups.get(groupKey);
      if (!group) {
        group = { boundSessionId: record.sessionId, tail: Promise.resolve() };
        this.groups.set(groupKey, group);
      } else {
        group.boundSessionId = record.sessionId;
      }

      const displaySummary = plugin.summarizeInteraction
        ? plugin.summarizeInteraction(params.payload)
        : `已响应「${plugin.name}」`;

      const syntheticEvent: LarkMessageEvent = {
        messageId: record.replyToMessageId || record.messageId || `outp-reply-${record.cardId}`,
        chatId: record.chatId,
        chatType: record.chatType || 'group',
        ...(record.threadId ? { threadId: record.threadId } : {}),
        ...(record.rootId ? { rootId: record.rootId } : {}),
        messageType: 'text',
        content: JSON.stringify({ text: displaySummary }),
        ...(operatorOpenId ? { senderOpenId: operatorOpenId } : {}),
        senderType: 'user',
        mentions: []
      };

      const followUpTask: LarkTask = {
        id: `lark_${isAsk ? 'askq' : 'outp'}_${randomUUID().replace(/-/g, '').slice(0, 12)}`,
        group,
        event: syntheticEvent,
        prompt: params.prompt,
        resources: [],
        config: botConfig,
        state: 'queued',
        events: [],
        turn: 0,
        sessionId: record.sessionId,
        ...(record.replyInThread || record.threadId ? { forceReplyInThread: true } : {}),
        origin: params.origin,
        agentPromptOverride: params.agentPrompt,
        clientMessageId: params.clientMessageId,
        taskDisplayName: displaySummary,
        skipReaction: true
      };

      this.tasks.set(followUpTask.id, followUpTask);
      if (this.tasks.size > 5_000) this.tasks.delete(this.tasks.keys().next().value!);

      const runPromise = group.tail.then(() => this.runTurn(followUpTask));
      group.tail = runPromise.catch(error => {
        this.log.error({ error, cardId, pluginId: plugin.id, sessionId: record.sessionId }, '飞书交互插件续跑轮次失败');
      });

      if (this.runtime.dispatch) {
        await runPromise;
      }
      return { id: followUpTask.runtimeTaskId ?? followUpTask.id, status: followUpTask.state };
    };

    try {
      const outputPluginsService = this.resolvedOutputPlugins;
      const specTitle = plugin.getTitle?.(record.spec);

      if (outputPluginsService) {
        const result = await outputPluginsService.submitInteraction({
          pluginId: plugin.id,
          sessionId: record.sessionId,
          instanceId: record.instanceId,
          ...(specTitle ? { title: specTitle } : {}),
          source: 'lark',
          actedBy,
          ...parsedAction.interaction,
          dispatchTurn: dispatchFollowUp
        });
        if (result.status === 'already_submitted') {
          await updateCardToAnswered(result.existing);
          return { type: 'info', content: isAsk ? '该询问已作答，无需重复提交' : '该卡片已响应，无需重复提交' };
        }
        await updateCardToAnswered(result.payload);
        return { type: 'success', content: isAsk ? '已提交回答，Agent 正在继续处理' : '已提交操作，Agent 正在继续处理' };
      }

      // 独立单测 / 未注入 OutputPluginService 时的本地幂等兜底
      const localKey = `${plugin.id}:${record.sessionId}:${record.instanceId}`;
      const existing = this.localAnsweredPlugins.get(localKey);
      if (existing) {
        await updateCardToAnswered(existing);
        return { type: 'info', content: isAsk ? '该询问已作答，无需重复提交' : '该卡片已响应，无需重复提交' };
      }

      if (isAsk) {
        const payload: AskUserQuestionAnswerPayload = {
          version: 1,
          questionId: record.instanceId,
          ...(specTitle ? { title: specTitle } : {}),
          source: 'lark',
          ...(actedBy ? { answeredBy: actedBy } : {}),
          answeredAt: now(),
          answers: (parsedAction.interaction.answers ?? []) as AskUserQuestionAnswerItem[]
        };
        this.localAnsweredPlugins.set(localKey, payload);
        await dispatchFollowUp({
          prompt: serializeAskUserQuestionAnswer(payload),
          agentPrompt: formatAskUserQuestionAnswerForAgent(payload),
          origin: ASK_USER_QUESTION_ANSWER_ORIGIN,
          clientMessageId: `askq:${record.sessionId}:${record.instanceId}`,
          payload
        });
        await updateCardToAnswered(payload);
        return { type: 'success', content: '已提交回答，Agent 正在继续处理' };
      }

      if (plugin.id === BUILTIN_CONFIRM_ACTION_PLUGIN_ID) {
        const confirmSpec = record.spec as ConfirmActionSpec;
        const decision = parsedAction.interaction.decision ?? 'confirm';
        const decisionLabel = parsedAction.interaction.decisionLabel?.trim()
          || (decision === 'confirm' ? confirmSpec.confirmLabel : confirmSpec.cancelLabel)
          || (decision === 'confirm' ? '确认执行' : '取消');
        const comment = parsedAction.interaction.comment?.trim() || undefined;
        const payload: ConfirmActionInteractionPayload = {
          version: 1,
          pluginId: BUILTIN_CONFIRM_ACTION_PLUGIN_ID,
          actionId: record.instanceId,
          ...(specTitle ? { title: specTitle } : {}),
          ...(parsedAction.interaction.risk ?? confirmSpec.risk ? { risk: parsedAction.interaction.risk ?? confirmSpec.risk } : {}),
          decision,
          decisionLabel,
          ...(comment ? { comment } : {}),
          source: 'lark',
          ...(actedBy ? { decidedBy: actedBy } : {}),
          decidedAt: now()
        };
        this.localAnsweredPlugins.set(localKey, payload);
        await dispatchFollowUp({
          prompt: serializeConfirmActionInteraction(payload),
          agentPrompt: formatConfirmActionInteractionForAgent(payload),
          origin: CONFIRM_ACTION_INTERACTION_ORIGIN,
          clientMessageId: `outp:${plugin.id}:${record.sessionId}:${record.instanceId}`,
          payload
        });
        await updateCardToAnswered(payload);
        return { type: 'success', content: '已提交操作决定，Agent 正在继续处理' };
      }

      const fallbackPayload = {
        version: 1 as const,
        pluginId: plugin.id,
        pluginName: plugin.name,
        instanceId: record.instanceId,
        ...(specTitle ? { title: specTitle } : {}),
        source: 'lark' as const,
        ...(actedBy ? { actedBy } : {}),
        actedAt: now(),
        ...(parsedAction.interaction.actionValue ? { actionValue: parsedAction.interaction.actionValue } : {}),
        ...(parsedAction.interaction.actionLabel ? { actionLabel: parsedAction.interaction.actionLabel } : {}),
        fields: parsedAction.interaction.fields ?? [],
        ...(parsedAction.interaction.note ? { note: parsedAction.interaction.note } : {})
      };
      this.localAnsweredPlugins.set(localKey, fallbackPayload);
      await dispatchFollowUp({
        prompt: plugin.serializeInteraction!(fallbackPayload),
        agentPrompt: plugin.formatInteractionForAgent!(fallbackPayload),
        origin: plugin.interactionOrigin!,
        clientMessageId: `outp:${plugin.id}:${record.sessionId}:${record.instanceId}`,
        payload: fallbackPayload
      });
      await updateCardToAnswered(fallbackPayload);
      return { type: 'success', content: '已提交操作，Agent 正在继续处理' };
    } catch (error) {
      this.log.error({ error, cardId, pluginId: plugin.id, sessionId: record.sessionId }, '处理飞书交互插件提交失败');
      return { type: 'error', content: `提交失败：${error instanceof Error ? error.message : String(error)}` };
    }
  }

  stop() {
    this.stopped = true;
    if (this.reconcileTimer) clearTimeout(this.reconcileTimer);
    this.reconcileTimer = undefined;
    this.reconcileConfig = undefined;
    this.groups.clear();
    this.tasks.clear();
    this.handledMessages.clear();
    this.pluginCards.clear();
    this.localCardTracker.clear();
    this.localAnsweredPlugins.clear();
  }

  private async sessionFor(group: LarkGroup, config: StoredLarkConfig, chatId: string, chatType: LarkMessageEvent['chatType'], scopeId: string) {
    if (!config.defaultAgentId) throw new LarkServiceError('LARK_AGENT_CONFIG_REQUIRED', '机器人尚未配置默认 Agent，请在 AgentDock 飞书设置的“Agent 与门禁”中完成配置。', 409);
    // 托管群优先：这个群就是某个已存在会话的入口，不再按 sourceId 新建/复用，也不因配置变更换会话。
    if (group.boundSessionId) {
      const bound = await this.runtime.getSession(group.boundSessionId);
      if (bound && !bound.archivedAt && !['failed', 'stopped'].includes(bound.state)) {
        if (bound.permissionMode !== 'full-trust' && this.runtime.setPermissionMode) return this.runtime.setPermissionMode(bound.id, 'full-trust');
        return bound;
      }
      group.boundSessionId = undefined;
    }
    const configKey = larkSessionConfigKey(config);
    const sourceId = larkSourceId(config, chatId, chatType, scopeId);
    if (group.sessionId) {
      const existing = await this.runtime.getSession(group.sessionId);
      const reusable = existing && !['failed', 'stopped'].includes(existing.state);
      if (reusable && group.sessionConfigKey === configKey) {
        if (existing.permissionMode !== 'full-trust' && this.runtime.setPermissionMode) return this.runtime.setPermissionMode(existing.id, 'full-trust');
        return existing;
      }
      if (reusable && group.sessionConfigKey !== configKey) {
        this.log.info({ sessionId: existing.id, appId: config.appId, chatId }, '飞书 Agent 配置已变更，停止旧 Session 并应用新配置');
        await this.runtime.stop?.(existing.id);
      }
      group.sessionId = undefined;
      group.sessionConfigKey = undefined;
    }
    if (this.runtime.listSessions) {
      const sessions = await this.runtime.listSessions();
      const existing = [...sessions].reverse().find(item => item.source === 'lark'
        && item.sourceId === sourceId
        && item.agentId === config.defaultAgentId
        && !item.archivedAt
        && !['failed', 'stopped'].includes(item.state)
        && (!config.workspace || item.cwd === config.workspace));
      if (existing) {
        group.sessionId = existing.id;
        group.sessionConfigKey = configKey;
        this.log.info({ sessionId: existing.id, appId: config.appId, chatId }, '复用已持久化的飞书 Session');
        if (existing.permissionMode !== 'full-trust' && this.runtime.setPermissionMode) return this.runtime.setPermissionMode(existing.id, 'full-trust');
        return existing;
      }
    }
    const session = await this.runtime.start({
      agentId: config.defaultAgentId,
      ...(config.workspace ? { cwd: config.workspace } : {}),
      ...(config.defaultModel ? { model: config.defaultModel } : {}),
      ...(config.defaultReasoningEffort ? { reasoningEffort: config.defaultReasoningEffort } : {}),
      permissionMode: 'full-trust',
      source: 'lark',
      sourceId
    });
    group.sessionId = session.id;
    group.sessionConfigKey = configKey;
    return session;
  }

  /**
   * 用户仅 @ 机器人而未发送任何文字时，拉取当前会话最近的聊天记录作为上下文，
   * 让 Agent 根据历史判断用户意图；若拉取失败则退化为纯提示，让 Agent 主动询问。
   */
  private async buildEmptyMessageFallback(event: LarkMessageEvent, config: StoredLarkConfig): Promise<string> {
    const fallback = '用户仅 @ 了机器人而未发送任何文字内容。请礼貌地询问用户需要什么帮助。';
    try {
      // 话题内的空 @ 优先拉取该话题的消息，保证上下文不串到群里其他话题。
      const threadId = event.threadId?.trim();
      const result = await this.service.listChatMessages({
        ...(threadId ? { threadId } : { chatId: event.chatId }),
        pageSize: 20,
        order: 'desc'
      });
      const messages = result.items
        .filter(item => item.messageId !== event.messageId && !item.deleted)
        .sort((a, b) => Number(a.createTime) - Number(b.createTime));
      if (!messages.length) return fallback;
      const lines = await Promise.all(messages.map(async item => {
        const sender = item.sender.name || item.sender.id || '未知用户';
        // 合并转发消息不自动展开，只返回占位提示；Agent 可通过群协作工具按 message_id 拉取转发内容。
        const parsed = await parseLarkMessageContent(item.messageType, item.rawContent, {
          messageId: item.messageId
        });
        let text = parsed.text;
        // 历史消息同样只剥对本机器人的 @，保留对其他人的 @（@某某是上下文语义）。
        text = renderPromptMentions(text, item.mentions, mention => this.isSelfMention(config, mention));
        text = text.trim();
        return `${sender}: ${text || '[图片/文件/卡片等非文字消息]'}`;
      }));
      return `[AgentDock 空消息兜底]\n用户仅 @ 了机器人而未发送任何文字内容。以下是当前会话最近的聊天记录，请根据上下文判断用户的意图并回复。如果无法判断，请礼貌地询问用户需要什么帮助。\n\n[最近聊天记录]\n${lines.join('\n')}`;
    } catch (error) {
      this.log.warn({ error, chatId: event.chatId, messageId: event.messageId }, '拉取飞书聊天记录为空消息兜底失败');
      return fallback;
    }
  }

  private async runTurn(task: LarkTask) {
    if (this.stopped) return;
    // 每次 runTurn 递增轮次编号，用于让上一轮的终态回调（finish）识别自己已过期，
    // 避免它在 await getEvents 期间被重试打断后，把 task.state 覆盖回终态。
    task.turn = (task.turn ?? 0) + 1;
    const currentTurn = task.turn;
    const { group, event } = task;
    let config = task.config;
    if (task.resources.length) {
      task.prompt = await materializeLarkResources(event.messageId, task.prompt, task.resources, this.service);
      task.resources = [];
    }
    // 用户仅 @ 机器人而未发送文字时，拉取最近聊天记录作为上下文，让 Agent 判断用户意图。
    // 侧边对话触发但未附带问题时（例如裸 `/btw`），直接提示已就绪，不把群主流记录塞进侧边会话。
    if (!task.prompt.trim()) {
      task.prompt = task.sideChat
        ? '用户开启了侧边对话，但未输入具体问题。请简短说明侧边对话已就绪，用户可在本话题中继续提问。'
        : await this.buildEmptyMessageFallback(event, config);
    }
    const forceMainThread = task.regexTrigger?.replyMode === 'main';
    const replyDeliveryOpt = task.forceReplyInThread
      ? { replyInThread: true }
      : forceMainThread
        ? { replyInThread: false, forceMainThread: true }
        : {};
    const prompt = task.prompt;
    const cardTaskName = task.taskDisplayName
      ?? (task.regexTrigger
        ? `[${task.regexTrigger.ruleName}] ${task.regexTrigger.messagePreview}`.slice(0, 80)
        : prompt.slice(0, 80));
    const firstAttempt = !task.cardMessageId;
    const emojiType = acknowledgementEmojis[Math.floor(this.random() * acknowledgementEmojis.length)] ?? acknowledgementEmojis[0];
    let reactionId: string | undefined;
    if (firstAttempt && !task.skipReaction) {
      try {
        reactionId = (await this.service.addReaction(event.messageId, emojiType)).reactionId;
      } catch (error) {
        this.log.warn({ error, messageId: event.messageId }, '发送飞书确认表情失败，继续执行任务');
      }
    }

    const backfillByAdmin = task.regexTrigger?.backfillByAdmin === true;
    const allowRegexBotSender = task.regexTrigger?.allowBotSender === true;
    if (!backfillByAdmin) {
      try {
        config = await resolveLarkAccessConfig(config, this.service, event.senderType === 'app' || event.senderType === 'bot' ? 'bot' : 'user', this.configRepository);
        task.config = config;
      } catch (error) {
        task.state = 'failed'; task.retryable = false; task.startedAt = Date.now();
        task.failureReason = error instanceof Error ? error.message : String(error);
        const card = await deliverTaskFailure(this.service, event, config, { state: 'failed', retryable: false, taskId: task.id, taskName: '白名单身份解析失败', markdown: `**暂时无法验证白名单身份。**\n\n${error instanceof Error ? error.message : String(error)}\n\n请确认机器人与名单中的成员在同一群中，且具备读取群成员权限；修正后重新发送消息。`, ...(config.webBaseUrl ? { webBaseUrl: config.webBaseUrl } : {}), ...replyDeliveryOpt }, this.log);
        if (card.messageId) task.cardMessageId = card.messageId;
        if (reactionId && !config.quietReply) await this.service.deleteReaction(event.messageId, reactionId).catch(() => undefined);
        return;
      }
    }
    let actorEmails: string[] = [];
    const allowedUsers = config.allowedUsers ?? [];
    const allowedEmails = config.allowedEmails ?? [];
    const allowedBots = config.allowedBots ?? [];
    const peerBotsAllowed = config.peerBotsAllowed !== false;
    const highRiskAllowedUsers = config.highRiskAllowedUsers ?? [];
    const highRiskAllowedEmails = config.highRiskAllowedEmails ?? [];
    const highRiskPattern = config.highRiskPattern || defaultHighRiskPattern;
    const gateEnabled = config.gateEnabled === true;
    const botSender = event.senderType === 'app' || event.senderType === 'bot';
    if (!backfillByAdmin) {
      if (botSender) {
        try {
          if (!allowRegexBotSender && config.groupToolsEnabled && event.senderOpenId) await this.peerBotAuthorized?.(event.chatId, event.senderOpenId);
        } catch (error) {
          task.state = 'failed'; task.retryable = false; task.startedAt = Date.now();
          task.failureReason = error instanceof Error ? error.message : String(error);
          const card = await deliverTaskFailure(this.service, event, config, { state: 'failed', retryable: false, taskId: task.id, taskName: 'Agent 协作身份校验失败', markdown: `**无法验证发起交接的 Agent。**\n\n${error instanceof Error ? error.message : String(error)}`, ...(config.webBaseUrl ? { webBaseUrl: config.webBaseUrl } : {}), ...replyDeliveryOpt }, this.log);
          if (card.messageId) task.cardMessageId = card.messageId;
          if (reactionId && !config.quietReply) await this.service.deleteReaction(event.messageId, reactionId).catch(() => undefined);
          return;
        }
      } else if ((!allowedUsers.length && allowedEmails.length) || (gateEnabled && !highRiskAllowedUsers.length && highRiskAllowedEmails.length)) {
        try {
          if (!event.senderOpenId) throw new Error('消息事件未包含发送人 open_id');
          actorEmails = await this.service.getUserEmails(event.senderOpenId);
          if (!actorEmails.length) throw new LarkServiceError('LARK_SENDER_EMAIL_EMPTY', '飞书没有返回当前发送人的邮箱字段', 409);
        } catch (error) {
          task.state = 'failed'; task.retryable = false; task.startedAt = Date.now();
          task.failureReason = error instanceof Error ? error.message : String(error);
          const card = await deliverTaskFailure(this.service, event, config, { state: 'failed', retryable: false, taskId: task.id, taskName: '身份解析权限缺失', markdown: larkIdentityPermissionHelp(error, config.appId), ...(config.webBaseUrl ? { webBaseUrl: config.webBaseUrl } : {}), ...replyDeliveryOpt }, this.log);
          if (card.messageId) task.cardMessageId = card.messageId;
          if (reactionId && !config.quietReply) await this.service.deleteReaction(event.messageId, reactionId).catch(() => undefined);
          return;
        }
      }
    }
    const senderOpenId = event.senderOpenId ?? '';
    const allowedUser = allowedUsers.find(user => user.openId === senderOpenId);
    const allowedBot = allowedBots.find(bot => bot.openId === senderOpenId);
    const highRiskAllowedUser = highRiskAllowedUsers.find(user => user.openId === senderOpenId);
    const accessRestricted = allowedUsers.length > 0 || allowedEmails.length > 0 || Boolean(config.allowedUserNames?.length);
    const allowed = backfillByAdmin
      ? true
      : botSender
        ? (allowRegexBotSender || !accessRestricted || peerBotsAllowed || Boolean(allowedBot))
        : !accessRestricted || (allowedUsers.length ? Boolean(allowedUser) : actorEmails.some(email => allowedEmails.includes(email)));
    if (!allowed) {
      task.state = 'failed'; task.retryable = false; task.startedAt = Date.now();
      task.failureReason = '当前账号不在机器人白名单中';
      const card = await deliverTaskFailure(this.service, event, config, { state: 'failed', retryable: false, taskId: task.id, taskName: '访问被拒绝', markdown: '**当前账号不在机器人白名单中。**\n\n如需使用，请联系机器人管理员添加你。', ...(config.webBaseUrl ? { webBaseUrl: config.webBaseUrl } : {}), ...replyDeliveryOpt }, this.log);
      if (card.messageId) task.cardMessageId = card.messageId;
      if (reactionId && !config.quietReply) await this.service.deleteReaction(event.messageId, reactionId).catch(() => undefined);
      return;
    }
    const highRiskAuthorized = botSender
      ? false
      : (!gateEnabled || (!highRiskAllowedUsers.length && !highRiskAllowedEmails.length)
          ? allowed
          : highRiskAllowedUsers.length
            ? Boolean(highRiskAllowedUser)
            : actorEmails.some(email => highRiskAllowedEmails.includes(email)));
    const actorEmail = actorEmails[0];
    const riskPolicy: ToolRiskPolicy = {
      enabled: gateEnabled && config.hardGateEnabled,
      authorized: highRiskAuthorized,
      pattern: highRiskPattern,
      ...(actorEmail ? { actorEmail } : {}),
      reason: '当前飞书发送人不在高危操作允许名单中'
    };
    const regexScopeId = task.regexTrigger?.replyMode === 'thread'
      ? (event.threadId?.trim() ? `thread:${event.threadId.trim()}` : `regex-thread:${event.messageId}`)
      : undefined;
    let session: Session;
    try {
      session = task.sideChat
        ? await this.sideChatSessionFor(task)
        : await this.sessionFor(group, config, event.chatId, event.chatType, regexScopeId ?? larkGroupScopeId(event, config.groupSessionScope));
    }
    catch (error) {
      task.state = 'failed'; task.startedAt = Date.now();
      task.failureReason = error instanceof Error ? error.message : String(error);
      const markdown = `**Agent 启动失败**\n\n${task.failureReason}`;
      const card = await deliverTaskFailure(this.service, event, config, { state: 'failed', taskId: task.id, taskName: cardTaskName, markdown, ...(config.webBaseUrl ? { webBaseUrl: config.webBaseUrl } : {}), ...replyDeliveryOpt }, this.log);
      if (card.messageId) task.cardMessageId = card.messageId;
      if (reactionId && !config.quietReply) await this.service.deleteReaction(event.messageId, reactionId).catch(() => undefined);
      return;
    }
    task.sessionId = session.id;
    task.state = 'running';
    task.events = [];
    task.startedAt = Date.now();
    task.interruptRequested = false;
    if (config.quietReply) {
      // 静默模式：不创建、不更新 trace 卡片，最终回复由服务在终态时以文本发送。
      task.lastSuccessfulElements = [];
    } else {
      const initialElements = boundLarkCardElements(renderLarkCardElements([], config));
      if (task.cardMessageId) {
        await this.service.update({ messageId: task.cardMessageId, state: 'running', taskId: task.id, taskName: cardTaskName, markdown: '正在思考中…', sessionId: task.sessionId, ...(config.webBaseUrl ? { webBaseUrl: config.webBaseUrl } : {}) });
      } else {
        const card = await sendTaskCard(this.service, event, { state: 'running', taskId: task.id, taskName: cardTaskName, markdown: '正在思考中…', sessionId: task.sessionId, ...(config.webBaseUrl ? { webBaseUrl: config.webBaseUrl } : {}), ...replyDeliveryOpt }, this.log);
        task.cardMessageId = card.messageId;
      }
      task.lastSuccessfulElements = initialElements;
    }
    await this.saveCardTask(task);
    if (reactionId && !config.quietReply) {
      // 静默回复没有 trace 卡片，确认表情是唯一的可见反馈，保留不撤回。
      try { await this.service.deleteReaction(event.messageId, reactionId); }
      catch (error) { this.log.warn({ error, messageId: event.messageId, reactionId }, '撤销飞书确认表情失败'); }
    }

    let timer: NodeJS.Timeout | undefined;
    let heartbeatActive = false;
    type PendingCardUpdate = {
      input: Parameters<LarkCardService['update']>[0];
      terminal: boolean;
      completed: boolean;
    };
    let pendingUpdate: PendingCardUpdate | undefined;
    let updateChain: Promise<void> | undefined;
    let cardRateLimitFailures = 0;
    let cardRateLimitedUntil = 0;
    const flushUpdates = () => {
      if (updateChain) return updateChain;
      updateChain = (async () => {
        while (pendingUpdate) {
          const pending = pendingUpdate;
          pendingUpdate = undefined;
          let lastError: unknown;
          let delivered = false;
          let contentRejected = false;
          const attempts = pending.terminal ? 3 : 1;
          for (let attempt = 1; attempt <= attempts; attempt++) {
            try {
              await this.service.update(pending.input);
              lastError = undefined;
              delivered = true;
              if (pending.input.elements) task.lastSuccessfulElements = pending.input.elements as LarkCardElement[];
              cardRateLimitFailures = 0;
              cardRateLimitedUntil = 0;
              break;
            } catch (error) {
              lastError = error;
              if (isLarkCardContentRejected(error)) { contentRejected = true; break; }
              if (isLarkMessageRateLimit(error)) {
                cardRateLimitFailures += 1;
                cardRateLimitedUntil = Date.now() + larkRateLimitBackoffMs(cardRateLimitFailures);
              }
              this.log.warn({ error, messageId: pending.input.messageId, attempt, attempts }, '更新飞书服务卡片失败');
              if (attempt < attempts) {
                const retryDelay = isLarkMessageRateLimit(error)
                  ? Math.max(0, cardRateLimitedUntil - Date.now())
                  : attempt * 300;
                await new Promise(resolve => setTimeout(resolve, retryDelay));
              }
            }
          }
          if (lastError && contentRejected && Array.isArray(task.lastSuccessfulElements) && task.lastSuccessfulElements.length) {
            const patchedElements = patchRejectedCardDelta(task.lastSuccessfulElements, pending.input.elements as LarkCardElement[] | undefined);
            try {
              await this.service.update({ ...pending.input, elements: patchedElements, markdown: undefined });
              delivered = true;
              lastError = undefined;
              task.lastSuccessfulElements = patchedElements;
              this.log.warn({ messageId: pending.input.messageId, state: pending.input.state }, '飞书卡片增量被拒绝，已保留上次成功内容并原地修补');
            } catch (error) {
              lastError = error;
            }
          }
          if (lastError && pending.terminal) {
            if (!isLarkMessageUnupdatable(lastError)) {
              this.log.warn({ error: lastError, messageId: pending.input.messageId }, '飞书原卡暂时更新失败，保留原卡等待终态对账');
              this.scheduleReconcile();
              continue;
            }
            try {
              const replacementActions = pending.input.state === 'failed' ? this.sessionReopenActions(task, 'failed') : undefined;
              const replacementElements = contentRejected
                ? patchRejectedCardDelta(task.lastSuccessfulElements, pending.input.elements as LarkCardElement[] | undefined)
                : replacementActions
                  ? boundLarkCardElements(this.sessionReopenElements())
                  : boundLarkCardElements(renderLarkCardElements(task.events, config, pending.completed, true));
              const replacement = await sendTaskCard(this.service, event, {
                state: pending.input.state,
                taskId: task.id,
                taskName: cardTaskName,
                elapsedSeconds: pending.input.elapsedSeconds,
                sessionId: task.sessionId,
                ...(config.webBaseUrl ? { webBaseUrl: config.webBaseUrl } : {}),
                elements: replacementElements,
                ...(replacementActions ? { actions: replacementActions } : {}),
                idempotencyKey: `comp_${pending.input.messageId}_${pending.input.state}`.slice(0, 50),
                ...replyDeliveryOpt
              }, this.log);
              task.cardMessageId = replacement.messageId;
              task.lastSuccessfulElements = replacementElements;
              delivered = true;
              this.log.info({ previousMessageId: pending.input.messageId, replacementMessageId: replacement.messageId, state: pending.input.state }, '已补发飞书终态卡片');
            } catch (compensationError) {
              if (isLarkCardContentRejected(compensationError)) {
                try {
                  const patchedElements = patchRejectedCardDelta(task.lastSuccessfulElements, pending.input.elements as LarkCardElement[] | undefined);
                  const minimalActions = pending.input.state === 'failed' ? this.sessionReopenActions(task, 'failed') : undefined;
                  const minimal = await sendTaskCard(this.service, event, {
                    state: pending.input.state,
                    taskId: task.id,
                    taskName: cardTaskName,
                    elapsedSeconds: pending.input.elapsedSeconds,
                    sessionId: task.sessionId,
                    ...(config.webBaseUrl ? { webBaseUrl: config.webBaseUrl } : {}),
                    elements: patchedElements,
                    ...(minimalActions ? { actions: minimalActions } : {}),
                    idempotencyKey: `comp_safe_${pending.input.messageId}_${pending.input.state}`.slice(0, 50),
                    ...replyDeliveryOpt
                  }, this.log);
                  task.cardMessageId = minimal.messageId;
                  task.lastSuccessfulElements = patchedElements;
                  delivered = true;
                  this.log.warn({ previousMessageId: pending.input.messageId, replacementMessageId: minimal.messageId, upstreamCode: compensationError.details?.upstreamCode }, '飞书补发终态卡片增量被拒绝，已保留上次成功内容');
                } catch (fallbackError) {
                  this.log.error({ error: fallbackError, contentError: compensationError, updateError: lastError, messageId: pending.input.messageId }, '补发飞书终态最小卡片失败');
                }
              } else {
                this.log.error({ error: compensationError, updateError: lastError, messageId: pending.input.messageId }, '补发飞书终态卡片失败');
              }
            }
          }
          if (delivered && pending.input.state) await this.saveCardTask(task, pending.input.state);
        }
      })().finally(() => {
        updateChain = undefined;
        if (pendingUpdate) void flushUpdates();
      });
      return updateChain;
    };
    let enabledOutputPluginIds = await this.resolveEnabledOutputPluginIds(task.sessionId);
    const update = (state: 'queued' | 'running' | 'completed' | 'failed' | 'interrupted', completed = false) => {
      if (config.quietReply) return Promise.resolve();
      if (timer) { clearTimeout(timer); timer = undefined; }
      const actions = this.sessionReopenActions(task, state);
      const elements = actions
        ? boundLarkCardElements(this.sessionReopenElements())
        : boundLarkCardElements(renderLarkCardElements(task.events, config, completed, false, {
            outputPluginRegistry: this.resolvedPluginRegistry,
            enabledOutputPluginIds,
            larkPluginAdapters: this.larkPluginAdapters
          }));
      pendingUpdate = {
        terminal: state !== 'running',
        completed,
        input: {
          messageId: task.cardMessageId!,
          state,
          taskId: task.id,
          taskName: cardTaskName,
          elapsedSeconds: (Date.now() - task.startedAt!) / 1_000,
          sessionId: task.sessionId,
          ...(config.webBaseUrl ? { webBaseUrl: config.webBaseUrl } : {}),
          elements,
          ...(actions ? { actions } : {})
        }
      };
      return flushUpdates();
    };
    // 终态卡片交付：默认在原卡片上原地更新；若 Agent 通过 group reply-mode 工具指定了与默认不同的
    // 回复方式（话题 / 直接回复），则把原卡片降级为提示，并以 Agent 指定的方式补发终态卡片。
    const finalizeCard = async (state: 'completed' | 'failed' | 'interrupted', completed: boolean) => {
      const sessionId = task.sessionId ?? '';
      const agentReplyMode = getSessionReplyMode(sessionId);
      if (agentReplyMode) clearSessionReplyMode(sessionId);
      enabledOutputPluginIds = await this.resolveEnabledOutputPluginIds(sessionId || task.sessionId);
      const rawFinalText = completed ? extractRawFinalText(task.events) : '';
      const extractedPlugin = completed && enabledOutputPluginIds.size > 0
        ? this.resolvedPluginRegistry.parseTrailingOutput(rawFinalText, enabledOutputPluginIds)
        : null;
      const defaultReplyInThread = task.regexTrigger
        ? task.regexTrigger.replyMode === 'thread'
        : Boolean(task.forceReplyInThread || event.threadId?.trim());
      const resolvedReplyInThread = agentReplyMode ? agentReplyMode === 'thread' : defaultReplyInThread;
      // 静默模式：不展示 trace 卡片，由服务把最终回复以文本自动发送到会话。
      if (config.quietReply) {
        const finalText = extractedPlugin ? truncate(extractedPlugin.proseText, 6_000) : extractFinalText(task.events);
        const suffix = state === 'failed'
          ? '\n\n（任务未完全成功，详见 AgentDock Web 会话记录。）'
          : state === 'interrupted'
            ? '\n\n（任务已被取消。）'
            : '';
        // 静默模式唯一的终态交付通道：必须保证最终回复送达，瞬态失败要重试。
        const reply = `${finalText}${suffix}`;
        if (reply.trim() || !extractedPlugin) {
          const maxQuietReplyAttempts = 3;
          let lastQuietError: unknown;
          for (let attempt = 1; attempt <= maxQuietReplyAttempts; attempt++) {
            try {
              await sendQuietFinalReply(this.service, event, reply, this.log, task.forceReplyInThread, forceMainThread);
              lastQuietError = undefined;
              break;
            } catch (error) {
              lastQuietError = error;
              if (attempt < maxQuietReplyAttempts) {
                const delay = isLarkMessageRateLimit(error) ? larkRateLimitBackoffMs(attempt) : attempt * 500;
                this.log.warn({ error, attempt, chatId: event.chatId, messageId: event.messageId }, '发送静默终态回复失败，准备重试');
                await new Promise(resolve => setTimeout(resolve, delay));
              }
            }
          }
          if (lastQuietError !== undefined) {
            // 重试耗尽仍失败：静默模式没有卡片可补偿/对账，把失败显式抛出，交还给终态回调的
            // 统一错误出口（带 taskId/runtimeTaskId 上下文），避免「最终回复未送达」被静默吞掉。
            // 不在本级再打一条 error，否则同一失败会重复记录两条。
            throw lastQuietError;
          }
        }
        if (extractedPlugin && sessionId) {
          await this.pushOutputPluginCard({
            config,
            sessionId,
            taskId: task.runtimeTaskId ?? task.id,
            chatId: event.chatId,
            chatType: event.chatType,
            replyToMessageId: event.messageId,
            replyInThread: resolvedReplyInThread,
            forceMainThread,
            threadId: event.threadId,
            rootId: event.rootId,
            pluginId: extractedPlugin.pluginId,
            spec: extractedPlugin.spec
          }).catch(error => {
            this.log.warn({ error, sessionId, pluginId: extractedPlugin.pluginId }, '静默模式发送飞书交互插件卡片失败');
          });
        }
        return;
      }
      const agentReplyInThread = agentReplyMode === 'thread';
      if (agentReplyMode && agentReplyInThread !== defaultReplyInThread) {
        task.replyMode = agentReplyMode;
        const notice = agentReplyInThread ? '已按要求在话题中回复结果。' : '已按要求在群聊中直接回复结果。';
        pendingUpdate = {
          terminal: true,
          completed,
          input: {
            messageId: task.cardMessageId!,
            state,
            taskId: task.id,
            taskName: cardTaskName,
            elapsedSeconds: (Date.now() - task.startedAt!) / 1_000,
            sessionId: task.sessionId,
            ...(config.webBaseUrl ? { webBaseUrl: config.webBaseUrl } : {}),
            elements: [{ tag: 'markdown', content: notice }]
          }
        };
        await flushUpdates();
        const replyActions = this.sessionReopenActions(task, state);
        const replacement = await sendTaskCard(this.service, event, {
          state,
          taskId: task.id,
          taskName: cardTaskName,
          elapsedSeconds: (Date.now() - task.startedAt!) / 1_000,
          sessionId: task.sessionId,
          ...(config.webBaseUrl ? { webBaseUrl: config.webBaseUrl } : {}),
          elements: boundLarkCardElements(renderLarkCardElements(task.events, config, completed, false, {
            outputPluginRegistry: this.resolvedPluginRegistry,
            enabledOutputPluginIds,
            larkPluginAdapters: this.larkPluginAdapters
          })),
          ...(replyActions ? { actions: replyActions } : {}),
          replyInThread: agentReplyInThread
        }, this.log);
        task.cardMessageId = replacement.messageId;
        await this.saveCardTask(task, state);
      } else {
        await update(state, completed);
      }
      if (extractedPlugin && sessionId) {
        await this.pushOutputPluginCard({
          config,
          sessionId,
          taskId: task.runtimeTaskId ?? task.id,
          chatId: event.chatId,
          chatType: event.chatType,
          replyToMessageId: event.messageId,
          replyInThread: resolvedReplyInThread,
          forceMainThread,
          threadId: event.threadId,
          rootId: event.rootId,
          pluginId: extractedPlugin.pluginId,
          spec: extractedPlugin.spec
        }).catch(error => {
          this.log.warn({ error, sessionId, pluginId: extractedPlugin.pluginId }, '发送飞书交互插件卡片失败');
        });
      }
    };
    const scheduleHeartbeat = () => {
      // 静默模式无卡片可更新，跳过心跳定时器。
      if (config.quietReply || !heartbeatActive || timer) return;
      timer = setTimeout(() => {
        timer = undefined;
        void update('running').finally(scheduleHeartbeat);
      }, Math.max(config.pushIntervalMs, cardRateLimitedUntil - Date.now()));
    };
    task.requestUpdate = update;
    const isGroup = event.chatType === 'group';
    const chatNames = isGroup ? await this.resolveChatNames(config) : undefined;
    const currentChatName = isGroup ? await this.resolveCurrentChatName(config, event) : undefined;
    const otherChats = [...chatNames?.entries() ?? []].filter(([chatId]) => chatId !== event.chatId);
    // 当前群永远注入（名字取不到也要留 chat_id）：Agent 判断「我在哪个群」只能靠这一行，
    // 名字缺失时整行消失会让它把下面「其他群」里的名字当成自己在的群。
    const currentChatLine = isGroup ? `\n- 当前群聊：${currentChatName ?? '名称未获取'}（chat_id: ${event.chatId}）` : '';
    // 群列表本轮没拿到时必须说明，否则这一行的缺席会被读成「机器人只在这个群」。
    const otherChatsLine = !isGroup ? '' : chatNames === undefined
      ? '\n- 机器人所在的其他群：本轮未取到（飞书群列表接口不可用），不代表机器人只在当前群'
      : otherChats.length
        ? `\n- 机器人所在的其他群（不含当前群）：${otherChats.slice(0, 20).map(([, name]) => name).join('、')}${otherChats.length > 20 ? ` 等 ${otherChats.length} 个群` : ''}`
        : '';
    // 会话级上下文只在该会话首轮或内容变化时注入；后续轮次靠会话历史继承。
    // 否则每轮都会把身份、@ 规则、回复方式、静默说明再复制一份，长会话里是 O(n²) 的浪费。
    const staticInjected: string[] = [];
    staticInjected.push(`[AgentDock 机器人身份]
- 机器人名称：${config.name ?? config.appId}
- App ID：${config.appId}${config.workspace ? `\n- 工作区：${config.workspace}` : ''}${currentChatLine}${otherChatsLine}
- 在飞书消息里 @ 机器人（app）时，text 格式的 <at> 标签不会被解析（会原样显示）。需要 @ 机器人时使用 group send --to <机器人名称或其 open_id>，AgentDock 会自动以 post 格式提及对方；如需手动构造，post 的 at 元素为 {"tag":"at","user_id":"<对方 open_id>","user_name":"<名字>"}。user_id 必须是 ou_ 开头的 open_id（机器人也用 open_id）：填 app_id 或留空时，飞书只会把它显示成蓝色文字，不会通知任何人。open_id 通过 group peers / group members 获取；cli_ 开头的 app_id 只能用于识别机器人，不能作为 @ 目标。`);
    if (event.chatType === 'group') {
      staticInjected.push(`[AgentDock 飞书回复方式]
- 默认情况下，AgentDock 会根据消息上下文决定回复方式：话题内的回复会在话题中回复，顶层消息会直接回复。
- 如果你希望改变本次最终结果卡片的回复方式，可以在回复前调用：group reply-mode --mode thread|direct
  - thread：在话题中回复（创建/加入话题）
  - direct：直接回复到群聊主流（不创建话题）
- 该设置仅对当前任务的最终结果卡片生效；大多数情况下遵循默认行为即可。`);
    }
    if (config.quietReply) {
      staticInjected.push(`[AgentDock 静默回复模式 · 自动注入]
- 当前机器人开启了「静默回复」：本次任务**不会展示 trace 卡片**，你的**最后一条回复会由服务自动发送**到当前会话（无需、也请不要用 group send 重复发送最终答案）。
- 请把这份自动发送的最终回复放在你的最后一条文本消息里，服务会在任务结束时把它发送到对应会话。
- 如果你的最终回复需要 @ 某人，必须额外处理：最终自动发送的是纯文本，text 格式的 <at> 标签不会被解析（会原样显示），服务也不会替你 @ 任何人。
  - 需要 @ 时，请用 group send --to <对方 open_id> 单独发送一条消息（AgentDock 会自动以 post 格式提及对方），不要把 <at> 塞进最终回复里。
  - @ 的 user_id 必须是有效的 ou_ 开头 open_id；填 app_id 或留空只会显示成蓝色文字，不会通知任何人。对方 open_id 通过 group peers / group members 获取。`);
    }
    // 每条新消息必须带上当前 message_id / thread_id，这部分是真正的轮次级信息。
    const dynamicInjected: string[] = [];
    // 预注入 Prompt 是用户自己的每轮指令，语义上就该每轮生效；不随 AgentDock 静态说明一起缓存。
    if (config.preInjectPrompt?.trim()) dynamicInjected.push(`[AgentDock 预注入 Prompt]\n${config.preInjectPrompt.trim()}`);
    if (event.chatType === 'group' && config.groupToolsEnabled && config.groupToolsAllowSend) {
      dynamicInjected.push(`[AgentDock 飞书当前消息 · 系统上下文]
- 当前消息 message_id：${event.messageId}
- 当前消息 thread_id：${event.threadId?.trim() || '事件未提供'}
- 延续当前讨论或回答当前提问：group send '...' --reply-to ${event.messageId} --in-thread
- 独立公告、新任务或不应归入当前讨论：group send，不要传 --reply-to/--in-thread。`);
    }
    if (gateEnabled && !highRiskAuthorized) dynamicInjected.push(`[AgentDock 安全策略 · 自动注入]\n当前飞书发送人不在高危操作允许名单中。禁止执行匹配以下正则的操作，也不要通过脚本、子进程、MCP 或其他等价方式绕过：\n${highRiskPattern}\n如果用户要求此类操作，请明确说明已被 AgentDock 安全策略阻止。`);
    const staticSignature = staticInjected.join('\n\n');
    const staticAlreadyInjected = group.staticPrompt?.sessionId === session.id && group.staticPrompt.signature === staticSignature;
    const injected = [...(staticAlreadyInjected ? [] : staticInjected), ...dynamicInjected];
    if (!staticAlreadyInjected) group.staticPrompt = { sessionId: session.id, signature: staticSignature };
    const effectiveUserPrompt = task.agentPromptOverride ?? prompt;
    const agentPrompt = injected.length ? `${injected.join('\n\n')}\n\n[用户请求]\n${effectiveUserPrompt}` : effectiveUserPrompt;

    if (this.runtime.dispatch) {
      task.state = 'queued';
      let runtimeTaskId: string | undefined;
      let active = false;
      let settling = false;
      let settled = false;
      let buffered: AgentEvent[] = [];
      let unsubscribe = () => {};
      const cleanup = () => {
        heartbeatActive = false;
        if (timer) clearTimeout(timer);
        unsubscribe();
        task.requestUpdate = undefined;
      };
      const finish = (state: 'completed' | 'failed' | 'interrupted') => {
        if (settling || settled) return;
        settling = true;
        heartbeatActive = false;
        void (async () => {
          // 终态卡片仅需最终回复 + 最近 traceLimit 条活动，倒序加载足够原始事件即可，
          // 避免长会话全量加载导致内存峰值。
          // 先快照当前缓冲作为 fallback，再等 reload；await 期间 receive() 可能继续写入并 slice
          // 出新数组引用，因此合并必须用 task.events 的最新引用，而不是 await 前捕获的旧引用。
          if (runtimeTaskId) {
            const bufferedEvents = task.events;
            const reloaded = await this.reloadTurnEvents(session.id, config, bufferedEvents, runtimeTaskId);
            task.events = this.mergeCardEvents(task.events, reloaded);
          }
          // 若轮次已变（用户点击了重试并启动了新一轮），本轮终态回调不得覆盖新状态。
          if (task.turn !== currentTurn) return;
          const resolvedState = state === 'completed' && hasUnresolvedToolCalls(task.events) ? 'failed' : state;
          if (resolvedState !== state) this.log.warn({ taskId: task.id, runtimeTaskId }, '任务已结束但仍有工具未返回结果，按失败终态处理');
          settled = true;
          active = false;
          task.state = resolvedState;
          await finalizeCard(resolvedState, resolvedState === 'completed').finally(cleanup);
        })().catch(error => this.log.error({ error, taskId: task.id, runtimeTaskId }, '生成飞书任务终态失败'));
      };
      const receive = (agentEvent: AgentEvent) => {
        if (agentEvent.type === 'task') {
          const record = (agentEvent.data as any)?.task;
          if (!record || record.id !== runtimeTaskId) return;
          if (record.status === 'running') {
            active = true;
            heartbeatActive = true;
            task.state = 'running';
            task.startedAt = Date.now();
            void update('running').finally(scheduleHeartbeat);
          } else if (record.status === 'completed' || record.status === 'failed' || record.status === 'interrupted' || record.status === 'cancelled') finish(record.status === 'cancelled' ? 'interrupted' : record.status);
          return;
        }
        if (!active || settled) return;
        task.events.push(agentEvent);
        // 仅保留最近 N 条原始事件用于心跳渲染，避免长任务内存无限增长；
        // 终态卡片会从 DB 倒序加载足够事件，不依赖此缓冲。
        const maxBufferedEvents = Math.max((config.traceLimit ?? defaultLarkTraceLimit) * 20, 200);
        if (task.events.length > maxBufferedEvents) {
          task.events = task.events.slice(-maxBufferedEvents);
        }
        if (!settling) scheduleHeartbeat();
      };
      unsubscribe = this.runtime.subscribe(session.id, agentEvent => {
        if (!runtimeTaskId) buffered.push(agentEvent);
        else receive(agentEvent);
      });
      const releaseLarkDispatch = this.turnTracker?.beginLarkDispatch(session.id);
      try {
        let runtimeTask: { id: string; status: string; queuedAhead?: number };
        try {
          runtimeTask = task.origin || task.clientMessageId
            ? await this.runtime.dispatch(session.id, prompt, 'queue', agentPrompt, riskPolicy, task.origin, task.clientMessageId)
            : await this.runtime.dispatch(session.id, prompt, 'queue', agentPrompt, riskPolicy);
          this.turnTracker?.markLarkOwnedTask(runtimeTask.id);
        } finally {
          releaseLarkDispatch?.();
        }
        runtimeTaskId = runtimeTask.id;
        task.runtimeTaskId = runtimeTask.id;
        await this.saveCardTask(task, runtimeTask.status === 'queued' ? 'queued' : task.state);
        for (const agentEvent of buffered) receive(agentEvent);
        buffered = [];
        if (runtimeTask.status === 'queued' && (runtimeTask.queuedAhead ?? 0) > 0 && task.state === 'queued') {
          if (config.quietReply) {
            await sendQuietFinalReply(this.service, event, `已收到请求，前面还有 ${runtimeTask.queuedAhead} 个任务，完成后我会把结果发到这里。`, this.log, task.forceReplyInThread, forceMainThread);
          } else {
            await this.service.update({ messageId: task.cardMessageId!, state: 'queued', taskId: task.id, taskName: cardTaskName, markdown: `正在排队，前面还有 ${runtimeTask.queuedAhead} 个任务…`, sessionId: task.sessionId, ...(config.webBaseUrl ? { webBaseUrl: config.webBaseUrl } : {}) });
          }
          await this.saveCardTask(task, 'queued');
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        task.failureReason = message;
        task.events.push({ id: `lark-error-${event.messageId}`, sessionId: session.id, sequence: Number.MAX_SAFE_INTEGER, type: 'error', timestamp: new Date().toISOString(), data: { message } });
        task.state = 'failed';
        await finalizeCard('failed', false);
        cleanup();
      }
      return;
    }

    const unsubscribe = this.runtime.subscribe(session.id, agentEvent => {
      task.events.push(agentEvent);
      const maxBufferedEvents = Math.max((config.traceLimit ?? defaultLarkTraceLimit) * 20, 200);
      if (task.events.length > maxBufferedEvents) {
        task.events = task.events.slice(-maxBufferedEvents);
      }
      scheduleHeartbeat();
    });
    const releaseLarkSend = this.turnTracker?.beginLarkSend(session.id);
    try {
      heartbeatActive = true;
      scheduleHeartbeat();
      await this.runtime.setRiskPolicy?.(session.id, riskPolicy);
      // 本轮开始前的最大 sequence：重载时用它裁掉更早轮次的事件（此路径没有 runtimeTaskId 可用）。
      const turnStartSequence = task.events.reduce((max, item) => Math.max(max, item.sequence), 0);
      if (agentPrompt === prompt) await this.runtime.send(session.id, prompt);
      else await this.runtime.send(session.id, prompt, agentPrompt);
      // 若轮次已变（用户在 send 期间点击了重试），本轮不得覆盖新状态。
      if (task.turn !== currentTurn) return;
      if (task.interruptRequested) {
        await finalizeCard('interrupted', false);
        task.state = 'interrupted';
      } else {
        // runtime.send 内部可能因无最终输出、工具未返回等原因把任务标记为 failed，
        // 但 send 本身不抛错。此处需根据事件实际判定终态，不能默认 completed。
        // 终态语义与 runtime 对齐：失败轮次的 error 事件是最后一个事件；轮次中段的
        // 非致命 error 之后若仍有 completed（或后续活动），说明 Agent 已恢复，不算失败。
        // task.events 是被截断的环形缓冲（见 receive 里的 maxBufferedEvents），长轮次里
        // 配对的 tool_call/tool_result 或末尾的 completed 可能已被淘汰，直接判定会把成功轮次
        // 判成失败。与 finish() 的 settle 路径一致，先从 DB 倒序重载足够事件。
        const verdictEvents = await this.reloadTurnEvents(session.id, config, task.events, undefined, turnStartSequence);
        const lastTerminal = [...verdictEvents].reverse().find(item => item.type === 'error' || item.type === 'completed');
        const hasError = lastTerminal?.type === 'error';
        const unresolved = hasUnresolvedToolCalls(verdictEvents);
        const state: 'completed' | 'failed' = hasError || unresolved ? 'failed' : 'completed';
        task.events = verdictEvents;
        await finalizeCard(state, state === 'completed');
        task.state = state;
      }
    } catch (error) {
      if (task.turn !== currentTurn) return;
      if (task.interruptRequested) {
        await finalizeCard('interrupted', false);
        task.state = 'interrupted';
      } else {
        if (!task.events.some(item => item.type === 'error')) task.events.push({ id: `lark-error-${event.messageId}`, sessionId: session.id, sequence: Number.MAX_SAFE_INTEGER, type: 'error', timestamp: new Date().toISOString(), data: { message: error instanceof Error ? error.message : String(error) } });
        await finalizeCard('failed', false);
        task.state = 'failed';
      }
    } finally {
      releaseLarkSend?.();
      heartbeatActive = false;
      if (timer) clearTimeout(timer);
      unsubscribe();
      if (task.turn === currentTurn) task.requestUpdate = undefined;
    }
  }
}

export interface LarkLongConnectionListenerOptions {
  runtime?: LarkRuntime;
  cardMappings?: ChannelMappingRepository;
  configRepository?: ConfigRepository;
  askUserQuestion?: AskUserQuestionService;
  outputPlugins?: OutputPluginService;
  larkPluginAdapters?: LarkOutputPluginAdapterRegistry;
  turnTracker?: LarkTurnTracker;
  env?: NodeJS.ProcessEnv;
  fetcher?: typeof globalThis.fetch;
  /** 覆盖飞书 OpenAPI 域名（Lark 国际版或私有网关）。 */
  baseUrl?: string;
  peerBotAuthorized?: (appId: string, chatId: string, senderOpenId: string) => Promise<boolean>;
  /** SDK 内部日志出口；CLI 监听时转到 stderr，避免污染 stdout 的 JSONL 事件流。 */
  sdkLogger?: Record<'error' | 'warn' | 'info' | 'debug' | 'trace', (...args: unknown[]) => void>;
  /**
   * 收到原始飞书消息事件后的旁路回调。CLI 的 `lark message listen` 用它在不创建
   * AgentDock 会话的前提下消费消息；coordinator 仍按原逻辑处理，回调不影响其行为。
   */
  onMessage?: (event: LarkMessageEvent, config: StoredLarkConfig) => void | Promise<void>;
  /**
   * 收到 `im.message.reaction.created_v1` 后的旁路回调（AI 替身的表情触发）。
   * 与 onMessage 一样只做旁路消费，不影响卡片/消息协调器。
   */
  onReaction?: (event: LarkReactionEvent, config: StoredLarkConfig) => void | Promise<void>;
  /**
   * 卡片操作的第一处理人。返回 toast 结果表示已处理；返回 undefined 时交回原有 coordinator。
   * 用于 AI 替身的「询问」卡片按钮。
   */
  onCardAction?: (value: unknown, operatorOpenId: string | undefined, config: StoredLarkConfig) =>
    Promise<{ type: 'success' | 'warning' | 'error'; content: string } | undefined> | { type: 'success' | 'warning' | 'error'; content: string } | undefined;
  /**
   * 监听在后台耗尽重连次数（或遇到不可恢复错误）后回调。
   * 注意：正常 stop() 不触发。由上层（pool）决定是否冷却后重建，listener 自身不自愈。
   */
  onTerminalFailure?: (appId: string, config: StoredLarkConfig) => void;
  /**
   * 仅 pool 使用：监听失败后冷却重建的等待时长，默认 {@link larkReconnectCooldownMs}。
   * 抽成可注入项主要为了让冷却自愈逻辑可被快速单测。
   */
  reconnectCooldownMs?: number;
  /**
   * 仅 pool 使用：监听器工厂，默认创建真实的飞书长连接 listener。
   * 抽成可注入项是为了在单测里替换成可控的假 listener 来验证冷却重建编排。
   */
  createListener?: (log: ListenerLog, options: LarkLongConnectionListenerOptions) => LarkListener;
}

export class LarkLongConnectionListener implements LarkListener {
  private client?: LarkWSClient;
  private coordinator?: LarkMessageCoordinator;
  private credentials?: string;
  private config?: StoredLarkConfig;
  listening = false;

  constructor(private readonly log: ListenerLog, private readonly options: LarkLongConnectionListenerOptions = {}) {}

  async start(config: StoredLarkConfig) {
    const credentials = `${config.appId}\u0000${config.appSecret}`;
    if (this.listening && this.credentials === credentials) {
      this.config = config;
      try { await this.coordinator?.startReconciliation(config); }
      catch (error) { this.log.warn({ error, appId: config.appId }, '飞书卡片终态对账刷新失败，继续保持消息监听'); }
      return;
    }
    this.stop();

    const service = createLarkCardService(this.options.env ?? process.env, this.options.fetcher ?? globalThis.fetch, {
      appId: config.appId,
      appSecret: config.appSecret,
      ...(this.options.baseUrl ? { baseUrl: this.options.baseUrl } : {})
    });
    let botOpenId: string;
    try { botOpenId = await service.getBotOpenId(); }
    catch (error) { throw new LarkServiceError('LARK_LISTENER_START_FAILED', `Failed to resolve Lark bot identity: ${error instanceof Error ? error.message : String(error)}`, 502); }
    const coordinator = this.options.runtime ? new LarkMessageCoordinator(
      this.options.runtime,
      service,
      this.log,
      Math.random,
      botOpenId,
      (chatId, senderOpenId) => this.options.peerBotAuthorized?.(config.appId, chatId, senderOpenId) ?? Promise.resolve(false),
      this.options.cardMappings,
      this.options.configRepository,
      this.options.askUserQuestion,
      this.options.outputPlugins,
      this.options.larkPluginAdapters,
      this.options.turnTracker
    ) : undefined;
    try { await coordinator?.startReconciliation(config); }
    catch (error) { this.log.warn({ error, appId: config.appId }, '飞书卡片终态对账启动失败，继续建立消息监听'); }
    const dispatcher = new EventDispatcher({
      loggerLevel: LoggerLevel.warn,
      ...(this.options.sdkLogger ? { logger: this.options.sdkLogger } : {})
    }).register({
      'im.message.reaction.created_v1': (event: any) => {
        const reaction = parseLarkReactionEvent(event);
        if (!reaction) return;
        this.log.info({ messageId: reaction.messageId, emojiType: reaction.emojiType, operatorType: reaction.operatorType, operatorId: reaction.operatorId }, '收到飞书表情事件');
        if (this.options.onReaction) {
          void Promise.resolve(this.options.onReaction(reaction, this.config ?? config)).catch(error => {
            this.log.error({ error, messageId: reaction.messageId, emojiType: reaction.emojiType }, '处理飞书表情事件失败');
          });
        }
      },
      'im.message.receive_v1': event => {
        const message = event.message;
        // mentions 原样打出：@ 相关问题（唤不醒、通知丢失）的第一现场就是这里的原始结构。
        // 注意 at 的 user_id 若为空或填了 app_id，飞书不会生成 mentions 条目（消息仍显示蓝字）。
        this.log.info({ messageId: message.message_id, chatId: message.chat_id, chatType: message.chat_type, senderType: event.sender?.sender_type, mentions: message.mentions ?? [] }, '收到飞书消息事件');
        const messageEvent: LarkMessageEvent = {
          messageId: message.message_id,
          chatId: message.chat_id,
          chatType: message.chat_type,
          ...(event.create_time ?? message.create_time ? { createTime: String(event.create_time ?? message.create_time) } : {}),
          ...(message.root_id ? { rootId: message.root_id } : {}),
          ...(message.parent_id ? { parentId: message.parent_id } : {}),
          ...(message.thread_id ? { threadId: message.thread_id } : {}),
          messageType: message.message_type,
          content: message.content,
          ...(event.sender?.sender_id?.open_id ? { senderOpenId: event.sender.sender_id.open_id } : {}),
          ...(event.sender?.sender_type ? { senderType: event.sender.sender_type } : {}),
          mentions: (message.mentions ?? []).map(mention => {
            // 机器人的 mention 走的也是 open_id；这里保留 app_id 的兜底识别只为兼容
            // 极端情况下飞书回调携带 app_id 的形态，正常路径用 openId 即可命中。
            const rawId = (mention.id ?? {}) as Record<string, string | undefined>;
            const appId = rawId.app_id ?? [rawId.open_id, rawId.user_id, rawId.union_id, mention.key].find(value => value?.startsWith('cli_'));
            return {
              key: mention.key, name: mention.name,
              ...(rawId.open_id && !rawId.open_id.startsWith('cli_') ? { openId: rawId.open_id } : {}),
              ...(appId ? { appId } : {}),
              ...(mention.mentioned_type ? { mentionedType: mention.mentioned_type } : {})
            };
          })
        };
        const handlerConfig = this.config ?? config;
        if (this.options.onMessage) {
          void Promise.resolve(this.options.onMessage(messageEvent, handlerConfig)).catch(error => {
            this.log.error({ error, messageId: message.message_id, chatId: message.chat_id }, '处理飞书消息旁路回调失败');
          });
        }
        coordinator?.handle(messageEvent, handlerConfig).catch(error => {
          this.log.error({ error, messageId: message.message_id, chatId: message.chat_id }, '处理飞书消息事件失败');
        });
      },
      'card.action.trigger': async (event: any) => {
        const operatorOpenId = event.operator?.open_id;
        if (this.options.onCardAction) {
          try {
            const routed = await this.options.onCardAction(event.action?.value, operatorOpenId, this.config ?? config);
            if (routed) return { toast: routed };
          } catch (error) {
            this.log.error({ error, operatorOpenId }, '处理飞书卡片旁路操作失败');
          }
        }
        const actionContext: LarkCardActionContext = {
          ...(event.action?.form_value && typeof event.action.form_value === 'object' ? { formValue: event.action.form_value } : {}),
          ...(event.context?.open_message_id ? { openMessageId: String(event.context.open_message_id) } : {}),
          ...(event.context?.open_chat_id ? { openChatId: String(event.context.open_chat_id) } : {}),
          ...(typeof event.action?.option === 'string' ? { option: event.action.option } : {}),
          ...(typeof event.action?.input_value === 'string' ? { inputValue: event.action.input_value } : {})
        };
        const result = await coordinator?.handleAction(event.action?.value, operatorOpenId, actionContext);
        if (!result) return;
        return { toast: result };
      }
    });
    const client = new WSClient({
      appId: config.appId,
      appSecret: config.appSecret,
      loggerLevel: LoggerLevel.warn,
      ...(this.options.sdkLogger ? { logger: this.options.sdkLogger } : {}),
      autoReconnect: true,
      // 握手超时：避免 TCP 已建立但 WebSocket 升级无响应时，重连循环的 connect() 永远挂起。
      handshakeTimeoutMs: 15_000,
      // 存活检测：超过该时长未收到任何入站帧（含 pong）则主动断开并触发重连，
      // 防止连接半开（TCP 看起来正常但实际已不通）时监听静默失效。
      wsConfig: {
        pingTimeout: 120,
        // 网络长时间不可用时，SDK 默认按固定间隔无限重试（DNS 失败时约每 30s 一条错误，
        // 整夜刷屏）。改为指数退避 + 20 次硬上限；耗尽后由 onError 安排冷却重启。
        reconnectMaxAttempts: larkReconnectMaxAttempts,
        reconnectBaseIntervalMs: larkReconnectBaseIntervalMs,
        reconnectMaxIntervalMs: larkReconnectMaxIntervalMs,
        reconnectMultiplier: larkReconnectMultiplier
      },
      onReady: () => this.log.info({ appId: config.appId }, '飞书消息监听已连接'),
      onReconnecting: () => this.log.warn({ appId: config.appId, attempts: larkReconnectMaxAttempts }, `飞书消息监听正在重连（最多 ${larkReconnectMaxAttempts} 次，指数退避）`),
      onReconnected: () => this.log.info({ appId: config.appId }, '飞书消息监听已恢复'),
      onError: error => {
        this.listening = false;
        this.log.error({ error, appId: config.appId, maxAttempts: larkReconnectMaxAttempts }, `飞书消息监听重连 ${larkReconnectMaxAttempts} 次后仍失败（或遇到不可恢复错误）`);
        this.options.onTerminalFailure?.(config.appId, config);
      }
    });
    try {
      await client.start({ eventDispatcher: dispatcher });
      // 注意：SDK 的 start() 内部是 fire-and-forget 地触发首次连接（未 await reConnect），
      // 返回时连接结果尚未产生，无法在此判定成败。凭据错误 / 网络不可用等失败会在首次连接
      // 尝试完成后经 onError → onTerminalFailure 异步暴露，由 pool 把该 listener 下线并安排
      // 冷却重建。因此这里不做 getConnectionStatus().state === 'failed' 检查（此时恒为非 failed，
      // 检查是死代码），失败处理统一收敛在 onError 回调里。
      this.client = client;
      this.coordinator = coordinator;
      this.credentials = credentials;
      this.config = config;
      this.listening = true;
    } catch (error) {
      client.close();
      coordinator?.stop();
      throw new LarkServiceError('LARK_LISTENER_START_FAILED', `Failed to start Lark listener: ${error instanceof Error ? error.message : String(error)}`, 502);
    }
  }

  coordinatorFor(): LarkMessageCoordinator | undefined {
    return this.coordinator;
  }

  stop() {
    this.client?.close();
    this.coordinator?.stop();
    this.client = undefined;
    this.coordinator = undefined;
    this.credentials = undefined;
    this.config = undefined;
    this.listening = false;
  }
}

export interface LarkListenerPool {
  readonly listening: boolean;
  readonly activeAppIds: string[];
  sync(configs: StoredLarkConfig[]): Promise<void>;
  stop(): void;
  coordinatorFor?(appId: string): LarkMessageCoordinator | undefined;
}

export class LarkLongConnectionListenerPool implements LarkListenerPool {
  private readonly listeners = new Map<string, LarkListener>();
  private readonly configs = new Map<string, StoredLarkConfig>();
  private readonly cooldownTimers = new Map<string, NodeJS.Timeout>();
  /**
   * 同一 appId 正在进行的启动 Promise。start() 是异步的，listener 在 start 成功前还没进 map；
   * 若冷却重建与设置页 sync 并发触发，两者都看不到在途 listener 会各自再建一个，导致同一条飞书
   * 消息被两个 listener 重复处理。这里用 in-flight Promise 去重，保证每个 appId 同时只有一个启动。
   */
  private readonly inflightStarts = new Map<string, Promise<LarkListener>>();

  constructor(private readonly log: ListenerLog, private readonly options: LarkLongConnectionListenerOptions = {}) {}

  get listening() { return this.listeners.size > 0; }
  get activeAppIds() { return [...this.listeners.keys()]; }
  coordinatorFor(appId: string): LarkMessageCoordinator | undefined {
    return this.listeners.get(appId)?.coordinatorFor?.();
  }

  async sync(configs: StoredLarkConfig[]) {
    const enabled = new Map(configs.filter(config => config.listening).map(config => [config.appId, config]));
    this.configs.clear();
    for (const [appId, config] of enabled) this.configs.set(appId, config);
    for (const [appId, listener] of this.listeners) {
      if (enabled.has(appId)) continue;
      this.clearCooldown(appId);
      listener.stop();
      this.listeners.delete(appId);
    }
    const failures: unknown[] = [];
    for (const [appId, config] of enabled) {
      try {
        await this.ensureListener(appId, config);
      } catch (error) {
        failures.push(error);
        // 启动即失败（凭据错误 / 网络不可用）：不保留死 listener，安排冷却重建自愈。
        this.teardownListener(appId);
        this.scheduleCooldownRebuild(appId);
      }
    }
    if (failures.length) throw failures[0];
  }

  /** 下线并移除一个 listener（含 SDK 定时器/协调节点的资源释放）。 */
  private teardownListener(appId: string) {
    const listener = this.listeners.get(appId);
    if (listener) { listener.stop(); this.listeners.delete(appId); }
  }

  /**
   * 为指定 app 建立（或复用）监听器；失败由调用方处理。并发调用按 appId 复用同一个
   * in-flight Promise，避免重复创建。
   */
  private ensureListener(appId: string, config: StoredLarkConfig): Promise<LarkListener> {
    const existing = this.listeners.get(appId);
    if (existing?.listening) {
      // 已存活：start() 内部会刷新 config 并触发卡片对账，不需要新建连接。
      this.clearCooldown(appId);
      return existing.start(config).then(() => existing);
    }
    const inflight = this.inflightStarts.get(appId);
    if (inflight) return inflight;

    const started = (async (): Promise<LarkListener> => {
      const listener = (this.options.createListener ?? ((l, o) => new LarkLongConnectionListener(l, o)))(this.log, {
        ...this.options,
        // 后台重连耗尽后回调：先 stop 释放 SDK/coordinator 定时器资源，再下线并进入冷却重建，
        // 避免长断网时每轮（20 次退避 + 冷却）泄漏一份 client/eventDispatcher 闭包。
        onTerminalFailure: failedAppId => {
          const failed = this.listeners.get(failedAppId);
          failed?.stop();
          this.listeners.delete(failedAppId);
          this.scheduleCooldownRebuild(failedAppId);
        }
      });
      await listener.start(config);
      this.listeners.set(appId, listener);
      this.clearCooldown(appId);
      return listener;
    })();

    this.inflightStarts.set(appId, started);
    started.finally(() => {
      if (this.inflightStarts.get(appId) === started) this.inflightStarts.delete(appId);
    }).catch(() => { /* 失败由调用方处理，这里仅保证 in-flight 被清理 */ });
    return started;
  }

  private clearCooldown(appId: string) {
    const timer = this.cooldownTimers.get(appId);
    if (timer) { clearTimeout(timer); this.cooldownTimers.delete(appId); }
  }

  /**
   * 冷却后重建监听。每轮仍是「最多 20 次指数退避重试 + 冷却」，不会退化成高频无限重试；
   * 重建持续失败时按冷却周期一直重试（网络恢复 / 配置修正后即可自愈），
   * 期间若用户关闭监听或删除配置，sync() 会清掉定时器。
   */
  private scheduleCooldownRebuild(appId: string) {
    const cooldownMs = this.options.reconnectCooldownMs ?? larkReconnectCooldownMs;
    if (this.cooldownTimers.has(appId) || !this.configs.has(appId)) return;
    this.log.warn({ appId, cooldownSeconds: Math.round(cooldownMs / 1000) }, '飞书消息监听已离线，等待冷却后自动重建');
    const timer = setTimeout(() => {
      this.cooldownTimers.delete(appId);
      const latest = this.configs.get(appId);
      if (!latest) return;
      void this.ensureListener(appId, latest).catch(error => {
        this.log.error({ error, appId }, '飞书消息监听冷却重建失败，将再次冷却后重试');
        this.scheduleCooldownRebuild(appId);
      });
    }, cooldownMs);
    timer.unref();
    this.cooldownTimers.set(appId, timer);
  }

  stop() {
    for (const timer of this.cooldownTimers.values()) clearTimeout(timer);
    this.cooldownTimers.clear();
    this.inflightStarts.clear();
    this.configs.clear();
    for (const listener of this.listeners.values()) listener.stop();
    this.listeners.clear();
  }
}
