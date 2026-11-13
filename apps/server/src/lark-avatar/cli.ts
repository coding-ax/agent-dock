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
