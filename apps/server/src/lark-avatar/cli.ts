import { readFileSync } from 'node:fs';
import { callDaemon, requireDaemon } from '../session-cli.js';

export interface LarkAvatarSendCliOptions {
  chat?: string;
  text?: string;
  textFile?: string;
  replyTo?: string;
  inThread?: boolean;
  at?: string[];
  match?: string;
  json?: boolean;
}

export interface LarkAvatarSendRequest {
  chat: string;
  text: string;
  replyTo?: string;
  inThread?: boolean;
  at?: string[];
  match?: 'exact' | 'fuzzy';
}

export interface LarkAvatarDiagnosticsCliOptions {
  limit?: string;
  json?: boolean;
}

export interface LarkAvatarReactionCliOptions {
  message: string;
  emoji: string;
  operator?: string;
  operatorType?: string;
  actionTime?: string;
  chat?: string;
  chatName?: string;
  sender?: string;
  content?: string;
  json?: boolean;
}

export interface LarkAvatarReactionRouteCliOptions {
  trigger: string;
  route: string;
  operator?: string;
  json?: boolean;
}

const readTextFile = (path: string): string => path === '-' ? readFileSync(0, 'utf8') : readFileSync(path, 'utf8');

/** CLI 参数校验与请求体构造；与 daemon 调用分开，便于单测。 */
export function buildLarkAvatarSendInput(
  options: LarkAvatarSendCliOptions,
  readFile: (path: string) => string = readTextFile
): LarkAvatarSendRequest {
  const chat = options.chat?.trim();
  if (!chat) throw new Error('--chat 必填：群名、oc_* chat_id 或数字 chat_id');
  if (options.text !== undefined && options.textFile !== undefined) {
    throw new Error('--text 和 --text-file 只能用一个');
  }

  const text = options.textFile !== undefined ? readFile(options.textFile) : options.text;
  if (text === undefined || !text.trim()) {
    throw new Error('消息正文不能为空：请用 --text <text> 或 --text-file <file>');
  }

  const at = [...new Set((options.at ?? []).map(item => item.trim()).filter(Boolean))];
  if (options.match !== undefined && options.match !== 'exact' && options.match !== 'fuzzy') {
    throw new Error('--match 只能是 exact 或 fuzzy');
  }

  return {
    chat,
    text,
    ...(options.replyTo?.trim() ? { replyTo: options.replyTo.trim() } : {}),
    ...(options.inThread === true ? { inThread: true } : {}),
    ...(at.length ? { at } : {}),
    ...(options.match ? { match: options.match } : {})
  };
}

export function formatLarkAvatarSendResult(result: Record<string, unknown>): string {
  const mentions = Array.isArray(result.mentions)
    ? result.mentions.map(mention => {
        const item = mention as Record<string, unknown>;
        return `@${String(item.name ?? item.userId ?? '')}（${String(item.userId ?? '')}）`;
      })
    : [];
  return [
    `已发送 ${String(result.messageId ?? '')}`,
    `群：${String(result.chatId ?? '')}`,
    ...(result.rootId !== null && result.rootId !== undefined ? [`回复：${String(result.rootId)}`] : []),
    ...(mentions.length ? [`提及：${mentions.join('、')}`] : [])
  ].join('\n') + '\n';
}

export async function runLarkAvatarSend(options: LarkAvatarSendCliOptions): Promise<string> {
  const body = buildLarkAvatarSendInput(options);
  const result = await callDaemon<Record<string, unknown>>(requireDaemon(), '/api/lark-avatar/send', 'POST', body);
  return options.json ? `${JSON.stringify(result, null, 2)}\n` : formatLarkAvatarSendResult(result);
}

export function reactionDiagnosticsLimit(value: string | undefined): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.min(100, Math.max(1, Math.floor(parsed))) : 10;
}

export function buildLarkAvatarReactionInput(options: LarkAvatarReactionCliOptions): Record<string, unknown> {
  const messageId = options.message?.trim();
  const emojiType = options.emoji?.trim();
  if (!messageId) throw new Error('--message 必填：被反应消息的 om_* message_id');
  if (!emojiType) throw new Error('--emoji 必填：飞书 emoji_type，例如 THUMBSUP');
  if (options.operatorType && !['user', 'bot', 'app'].includes(options.operatorType)) {
    throw new Error('--operator-type 只能是 user、bot 或 app');
  }
  return {
    messageId,
    emojiType,
    ...(options.operator?.trim() ? { operatorId: options.operator.trim() } : {}),
    ...(options.operatorType ? { operatorType: options.operatorType } : {}),
    ...(options.actionTime?.trim() ? { actionTime: options.actionTime.trim() } : {}),
    ...(options.chat?.trim() ? { chatId: options.chat.trim() } : {}),
    ...(options.chatName?.trim() ? { chatName: options.chatName.trim() } : {}),
    ...(options.sender?.trim() ? { senderName: options.sender.trim() } : {}),
    ...(options.content?.trim() ? { content: options.content.trim() } : {})
  };
}

const formatDiagnosticsEvent = (value: unknown): string => {
  if (!value || typeof value !== 'object') return '还没有收到 reaction 事件。';
  const event = value as Record<string, unknown>;
  const who = [event.operatorType, event.operatorId].filter(Boolean).join('/');
  const target = [event.sessionId ? `session=${String(event.sessionId)}` : '', event.taskId ? `task=${String(event.taskId)}` : ''].filter(Boolean).join(' ');
  return [
    `${String(event.at ?? '')}  ${String(event.emojiType ?? '')}  ${who || 'unknown'}`,
    `  ${String(event.outcome ?? '')}${event.detail ? `：${String(event.detail)}` : ''}${target ? `  ${target}` : ''}`
  ].join('\n');
};

export function formatLarkAvatarDiagnostics(result: Record<string, unknown>): string {
  const triggers = Array.isArray(result.triggers) ? result.triggers as Array<Record<string, unknown>> : [];
  const lines = ['最近一次表情事件：', formatDiagnosticsEvent(result.lastEvent), '', `最近 ${triggers.length} 条触发账本：`];
  if (!triggers.length) lines.push('- 暂无记录');
  for (const trigger of triggers) {
    lines.push(`- ${String(trigger.createdAt ?? '')} [${String(trigger.key ?? '')}] ${String(trigger.emoji ?? '')} ${String(trigger.state ?? '')}`
      + `${trigger.reason ? `（${String(trigger.reason)}）` : ''}${trigger.taskId ? ` task=${String(trigger.taskId)}` : ''}`);
  }
  if (!result.lastEvent) {
    lines.push('', '如果已经在飞书加过表情：确认机器人已在目标会话、应用已订阅 im.message.reaction.created_v1、且替身监听未暂停。');
  }
  return `${lines.join('\n')}\n`;
}

export async function runLarkAvatarDiagnostics(options: LarkAvatarDiagnosticsCliOptions): Promise<string> {
  const limit = reactionDiagnosticsLimit(options.limit);
  const result = await callDaemon<Record<string, unknown>>(
    requireDaemon(),
    `/api/lark-avatar/reaction-diagnostics?limit=${limit}`,
    'GET'
  );
  return options.json ? `${JSON.stringify(result, null, 2)}\n` : formatLarkAvatarDiagnostics(result);
}

export async function runLarkAvatarReaction(options: LarkAvatarReactionCliOptions): Promise<string> {
  const body = buildLarkAvatarReactionInput(options);
  const result = await callDaemon<Record<string, unknown>>(requireDaemon(), '/api/lark-avatar/reaction-test', 'POST', body);
  if (options.json) return `${JSON.stringify(result, null, 2)}\n`;
  const parts = [
    `表情事件已注入：action=${String(result.action ?? '')}`
      + `${result.reason ? ` reason=${String(result.reason)}` : ''}`
      + `${result.sessionId ? ` session=${String(result.sessionId)}` : ''}`
      + `${result.taskId ? ` task=${String(result.taskId)}` : ''}`,
    formatDiagnosticsEvent((result.diagnostics as Record<string, unknown> | undefined)?.lastEvent)
  ];
  return `${parts.join('\n')}\n`;
}

export async function runLarkAvatarReactionRoute(options: LarkAvatarReactionRouteCliOptions): Promise<string> {
  if (!options.trigger?.trim()) throw new Error('--trigger 必填：reaction 账本 key');
  if (options.route !== 'main' && options.route !== 'independent') {
    throw new Error('--route 只能是 main 或 independent');
  }
  const result = await callDaemon<Record<string, unknown>>(requireDaemon(), '/api/lark-avatar/reaction-route-test', 'POST', {
    triggerId: options.trigger.trim(),
    route: options.route,
    ...(options.operator?.trim() ? { operatorId: options.operator.trim() } : {})
  });
  if (options.json) return `${JSON.stringify(result, null, 2)}\n`;
  return `${String(result.type ?? '')}：${String(result.content ?? '')}\n`;
}

// ---- AI 飞书替身平台化 CLI：状态、三档回复策略、保留上限/清理、监听、收件箱、草稿 ----

export interface LarkAvatarCommonCliOptions {
  json?: boolean;
  daemonDir?: string;
}

export interface LarkAvatarConfigSetCliOptions extends LarkAvatarCommonCliOptions {
  region?: string;
  replyForward?: string;
  replyMode?: string;
  replyInTopic?: boolean;
  noReplyInTopic?: boolean;
  inboxMax?: string;
  cleanupWarn?: string;
  triggerPrefix?: string;
  contextMessages?: string;
  contextScope?: string;
  emojiReactions?: boolean;
  noEmojiReactions?: boolean;
  reactionTrigger?: string;
  reactionEmoji?: string;
  reactionRoute?: string;
  reactionIgnoreBots?: boolean;
  noReactionIgnoreBots?: boolean;
  replySignature?: string;
  agentTimeout?: string;
  agent?: string;
  model?: string;
  reasoningEffort?: string;
  workspace?: string;
  listenChats?: string;
}

export interface LarkAvatarInboxListCliOptions extends LarkAvatarCommonCliOptions {
  state?: string;
  tier?: string;
  limit?: string;
}

export interface LarkAvatarInboxCleanupCliOptions extends LarkAvatarCommonCliOptions {
  keepLatest?: string;
  all?: boolean;
}

export interface LarkAvatarDraftListCliOptions extends LarkAvatarCommonCliOptions {
  state?: string;
}

export interface LarkAvatarDraftWriteCliOptions extends LarkAvatarCommonCliOptions {
  target?: string;
  text?: string;
  textFile?: string;
  item?: string;
  threadKey?: string;
  replyRoot?: string;
}

const REPLY_FORWARD_LABELS: Record<string, string> = {
  all: 'all（转发所有 AgentText）',
  final_only: 'final_only（仅转发最终回复）',
  none: 'none（不在飞书回复，仅本地留存）'
};

function parseNonNegInt(raw: string, flag: string): number {
  const n = Number(raw);
  if (!Number.isSafeInteger(n) || n < 0) throw new Error(`${flag} 必须是非负整数`);
  return n;
}

export async function runLarkAvatarStatus(options: LarkAvatarCommonCliOptions = {}): Promise<string> {
  const status = await callDaemon<Record<string, unknown>>(requireDaemon(options.daemonDir), '/api/lark-avatar/status', 'GET');
  if (options.json) return `${JSON.stringify({ ok: true, ...status }, null, 2)}\n`;
  const account = status.account as Record<string, unknown> | undefined;
  const retention = status.retention as Record<string, unknown> | undefined;
  const lines = [
    `连接状态：${String(status.state ?? 'disconnected')}${account?.name ? `（${String(account.name)}）` : ''}`,
    `监听中：${status.listening ? '是' : '否'}${status.lastError ? ` · 最近错误：${String(status.lastError)}` : ''}`,
    ...(retention ? [
      `消息记录：当前 ${String(retention.inboxCount ?? 0)} 条 · 上限 ${Number(retention.inboxMaxItems ?? 60) === 0 ? '不限制' : `${String(retention.inboxMaxItems)} 条`} · 清理提醒阈值 ${Number(retention.inboxCleanupWarnThreshold ?? 200) === 0 ? '关闭' : `${String(retention.inboxCleanupWarnThreshold)} 条`}${retention.shouldWarnCleanup ? ' [建议清理]' : ''}`
    ] : [])
  ];
  return `${lines.join('\n')}\n`;
}

export async function runLarkAvatarConfigShow(options: LarkAvatarCommonCliOptions = {}): Promise<string> {
  const record = await callDaemon<Record<string, unknown> | null>(requireDaemon(options.daemonDir), '/api/lark-avatar/config', 'GET');
  if (options.json) return `${JSON.stringify({ ok: true, state: record }, null, 2)}\n`;
  if (!record) return '尚未配置 AI 飞书替身。\n';
  const cfg = (record.config ?? {}) as Record<string, unknown>;
  const lines = [
    `区域：${String(cfg.region ?? 'feishu')}  状态：${String(record.state ?? 'disconnected')}  监听：${cfg.listening ? '开启' : '暂停'}`,
    `回复转发策略：${REPLY_FORWARD_LABELS[String(cfg.replyForwardMode ?? 'final_only')] ?? String(cfg.replyForwardMode)}`,
    `回复方式：${String(cfg.replyMode ?? 'quote')}  话题内回复：${cfg.replyInTopic ? '开' : '关'}  触发前缀：${String(cfg.triggerPrefix ?? '/ai')}`,
    `上下文：最近 ${String(cfg.contextMessages ?? 12)} 条（范围=${String(cfg.contextScope ?? 'anchor')}）`,
    `记录保留：上限 ${Number(cfg.inboxMaxItems ?? 60) === 0 ? '不限制' : `${String(cfg.inboxMaxItems)} 条`} · 提醒阈值 ${Number(cfg.inboxCleanupWarnThreshold ?? 200) === 0 ? '关闭' : `${String(cfg.inboxCleanupWarnThreshold)} 条`}`,
    `表情触发：${cfg.reactionTriggerEnabled ? `开启（emoji=${String(cfg.reactionTriggerEmoji ?? 'OK')} · 路由=${String(cfg.reactionTriggerRoute ?? 'main')}）` : '关闭'}`,
    `执行器：Agent=${String(cfg.agentId || '默认')}  Model=${String(cfg.model || '默认')}  Workspace=${String(cfg.workspace || '默认')}`
  ];
  return `${lines.join('\n')}\n`;
}

export async function runLarkAvatarConfigSet(options: LarkAvatarConfigSetCliOptions = {}): Promise<string> {
  const patch: Record<string, unknown> = {};
  if (options.region !== undefined) {
    if (options.region !== 'feishu' && options.region !== 'lark') throw new Error('--region 必须是 feishu 或 lark');
    patch.region = options.region;
  }
  if (options.replyForward !== undefined) {
    if (!['all', 'final_only', 'none'].includes(options.replyForward)) throw new Error('--reply-forward 必须是 all / final_only / none');
    patch.replyForwardMode = options.replyForward;
  }
  if (options.replyMode !== undefined) {
    if (!['direct', 'quote', 'thread'].includes(options.replyMode)) throw new Error('--reply-mode 必须是 direct / quote / thread');
    patch.replyMode = options.replyMode;
  }
  if (options.replyInTopic) patch.replyInTopic = true;
  if (options.noReplyInTopic) patch.replyInTopic = false;
  if (options.inboxMax !== undefined) patch.inboxMaxItems = parseNonNegInt(options.inboxMax, '--inbox-max');
  if (options.cleanupWarn !== undefined) patch.inboxCleanupWarnThreshold = parseNonNegInt(options.cleanupWarn, '--cleanup-warn');
  if (options.triggerPrefix !== undefined) patch.triggerPrefix = options.triggerPrefix;
  if (options.contextMessages !== undefined) patch.contextMessages = parseNonNegInt(options.contextMessages, '--context-messages');
  if (options.contextScope !== undefined) {
    if (options.contextScope !== 'anchor' && options.contextScope !== 'chat') throw new Error('--context-scope 必须是 anchor 或 chat');
    patch.contextScope = options.contextScope;
  }
  if (options.emojiReactions) patch.emojiReactions = true;
  if (options.noEmojiReactions) patch.emojiReactions = false;
  if (options.reactionTrigger !== undefined) {
    const v = options.reactionTrigger.trim().toLowerCase();
    if (v !== 'on' && v !== 'off' && v !== 'true' && v !== 'false') throw new Error('--reaction-trigger 必须是 on 或 off');
    patch.reactionTriggerEnabled = v === 'on' || v === 'true';
  }
  if (options.reactionEmoji !== undefined) patch.reactionTriggerEmoji = options.reactionEmoji.trim();
  if (options.reactionRoute !== undefined) {
    if (!['main', 'independent', 'ask'].includes(options.reactionRoute)) throw new Error('--reaction-route 必须是 main / independent / ask');
    patch.reactionTriggerRoute = options.reactionRoute;
  }
  if (options.reactionIgnoreBots) patch.reactionTriggerIgnoreBots = true;
  if (options.noReactionIgnoreBots) patch.reactionTriggerIgnoreBots = false;
  if (options.replySignature !== undefined) patch.replySignature = options.replySignature;
  if (options.agentTimeout !== undefined) patch.agentTimeoutSeconds = parseNonNegInt(options.agentTimeout, '--agent-timeout');
  if (options.agent !== undefined) patch.agentId = options.agent.trim();
  if (options.model !== undefined) patch.model = options.model.trim();
  if (options.reasoningEffort !== undefined) patch.reasoningEffort = options.reasoningEffort.trim();
  if (options.workspace !== undefined) patch.workspace = options.workspace.trim();
  if (options.listenChats !== undefined) {
    patch.listenChats = options.listenChats.split(',').map(s => s.trim()).filter(Boolean);
  }
  if (!Object.keys(patch).length) throw new Error('请至少提供一个配置修改项，可用 --help 查看参数');

  const saved = await callDaemon<Record<string, unknown>>(requireDaemon(options.daemonDir), '/api/lark-avatar/config', 'PUT', patch);
  if (options.json) return `${JSON.stringify({ ok: true, state: saved }, null, 2)}\n`;
  return `已保存 AI 飞书替身配置。\n`;
}

export async function runLarkAvatarListen(enabled: boolean, options: LarkAvatarCommonCliOptions = {}): Promise<string> {
  const result = await callDaemon<Record<string, unknown>>(requireDaemon(options.daemonDir), '/api/lark-avatar/listening', 'PUT', { enabled });
  if (options.json) return `${JSON.stringify({ ok: true, ...result }, null, 2)}\n`;
  return enabled ? '已开启 AI 飞书替身监听。\n' : '已暂停 AI 飞书替身监听。\n';
}

export async function runLarkAvatarChats(options: LarkAvatarCommonCliOptions = {}): Promise<string> {
  const chats = await callDaemon<Array<Record<string, unknown>>>(requireDaemon(options.daemonDir), '/api/lark-avatar/chats', 'GET');
  if (options.json) return `${JSON.stringify({ ok: true, chats }, null, 2)}\n`;
  if (!chats.length) return '暂无可用飞书会话。\n';
  return chats.map(c => `${String(c.id ?? '')}  [${String(c.type ?? 'unknown')}]  ${String(c.name ?? '')}`).join('\n') + '\n';
}

export async function runLarkAvatarPoll(options: LarkAvatarCommonCliOptions = {}): Promise<string> {
  const result = await callDaemon<Record<string, unknown>>(requireDaemon(options.daemonDir), '/api/lark-avatar/poll', 'POST', {});
  if (options.json) return `${JSON.stringify({ ok: true, ...result }, null, 2)}\n`;
  return `已触发补拉：${JSON.stringify(result)}\n`;
}

export async function runLarkAvatarInboxList(options: LarkAvatarInboxListCliOptions = {}): Promise<string> {
  const params = new URLSearchParams();
  if (options.state?.trim()) params.set('state', options.state.trim());
  if (options.tier?.trim()) params.set('tier', options.tier.trim());
  if (options.limit?.trim()) params.set('limit', options.limit.trim());
  const qs = params.toString() ? `?${params.toString()}` : '';
  const items = await callDaemon<Array<Record<string, unknown>>>(requireDaemon(options.daemonDir), `/api/lark-avatar/inbox${qs}`, 'GET');
  if (options.json) return `${JSON.stringify({ ok: true, items }, null, 2)}\n`;
  if (!items.length) return '收件箱暂无消息记录。\n';
  return items.map(item =>
    `${String(item.id ?? '')}  [${String(item.tier ?? '')}/${String(item.state ?? '')}]  ${String(item.chatName ?? item.chatId ?? '')}  ${String(item.senderName ?? '')}: ${String(item.title ?? '')}`
  ).join('\n') + '\n';
}

export async function runLarkAvatarInboxCleanup(options: LarkAvatarInboxCleanupCliOptions = {}): Promise<string> {
  const body = options.all
    ? { keepLatest: 0 }
    : options.keepLatest !== undefined
      ? { keepLatest: parseNonNegInt(options.keepLatest, '--keep-latest') }
      : {};
  const result = await callDaemon<{ deleted: number; remaining: number; keepLatest: number }>(
    requireDaemon(options.daemonDir),
    '/api/lark-avatar/inbox/cleanup',
    'POST',
    body
  );
  if (options.json) return `${JSON.stringify({ ok: true, ...result }, null, 2)}\n`;
  return `已清理 ${result.deleted} 条记录，剩余 ${result.remaining} 条。\n`;
}

export async function runLarkAvatarDraftList(options: LarkAvatarDraftListCliOptions = {}): Promise<string> {
  const qs = options.state?.trim() ? `?state=${encodeURIComponent(options.state.trim())}` : '';
  const drafts = await callDaemon<Array<Record<string, unknown>>>(requireDaemon(options.daemonDir), `/api/lark-avatar/drafts${qs}`, 'GET');
  if (options.json) return `${JSON.stringify({ ok: true, drafts }, null, 2)}\n`;
  if (!drafts.length) return '暂无替身草稿。\n';
  return drafts.map(d => `${String(d.id ?? '')}  [${String(d.state ?? '')}]  ${String(d.target ?? '')}  ${String(d.body ?? '').slice(0, 60)}`).join('\n') + '\n';
}

export async function runLarkAvatarDraftCreate(options: LarkAvatarDraftWriteCliOptions = {}): Promise<string> {
  const target = options.target?.trim();
  if (!target) throw new Error('--target 必填');
  const bodyText = options.textFile !== undefined ? readTextFile(options.textFile) : options.text;
  if (!bodyText?.trim()) throw new Error('草稿正文不能为空，请传 --text 或 --text-file');
  const draft = await callDaemon<Record<string, unknown>>(requireDaemon(options.daemonDir), '/api/lark-avatar/drafts', 'POST', {
    target,
    body: bodyText,
    ...(options.item ? { itemId: options.item } : {}),
    ...(options.threadKey ? { threadKey: options.threadKey } : {}),
    ...(options.replyRoot ? { replyRootId: options.replyRoot } : {})
  });
  if (options.json) return `${JSON.stringify({ ok: true, draft }, null, 2)}\n`;
  return `已创建草稿 ${String(draft.id ?? '')}。\n`;
}

export async function runLarkAvatarDraftUpdate(id: string, options: LarkAvatarDraftWriteCliOptions = {}): Promise<string> {
  const bodyText = options.textFile !== undefined ? readTextFile(options.textFile) : options.text;
  if (bodyText === undefined) throw new Error('请传 --text 或 --text-file');
  const draft = await callDaemon<Record<string, unknown>>(requireDaemon(options.daemonDir), `/api/lark-avatar/drafts/${encodeURIComponent(id)}`, 'PATCH', { body: bodyText });
  if (options.json) return `${JSON.stringify({ ok: true, draft }, null, 2)}\n`;
  return `已更新草稿 ${id}。\n`;
}

export async function runLarkAvatarDraftSend(id: string, options: LarkAvatarDraftWriteCliOptions = {}): Promise<string> {
  const bodyText = options.textFile !== undefined ? readTextFile(options.textFile) : options.text;
  const draft = await callDaemon<Record<string, unknown>>(requireDaemon(options.daemonDir), `/api/lark-avatar/drafts/${encodeURIComponent(id)}/send`, 'POST', bodyText !== undefined ? { body: bodyText } : {});
  if (options.json) return `${JSON.stringify({ ok: true, draft }, null, 2)}\n`;
  return `已发送草稿 ${id}。\n`;
}

export async function runLarkAvatarDraftDiscard(id: string, options: LarkAvatarCommonCliOptions = {}): Promise<string> {
  const draft = await callDaemon<Record<string, unknown>>(requireDaemon(options.daemonDir), `/api/lark-avatar/drafts/${encodeURIComponent(id)}/discard`, 'POST', {});
  if (options.json) return `${JSON.stringify({ ok: true, draft }, null, 2)}\n`;
  return `已丢弃草稿 ${id}。\n`;
}
