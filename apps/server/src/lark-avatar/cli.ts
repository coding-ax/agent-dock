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
