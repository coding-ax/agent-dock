import { existsSync } from 'node:fs';
import { createRepositories } from '@agent-dock/agent-dock-storage';
import { resolveDatabasePath } from '../session-cli.js';
import { readLarkConfigs, type StoredLarkConfig } from './config.js';
import { parseLarkMessageContent } from './message-content.js';
import {
  createLarkCardService,
  LarkServiceError,
  type LarkChatMessage,
  type LarkMessageResult
} from './service.js';
import type {
  LarkListener,
  LarkLongConnectionListenerOptions,
  LarkMessageEvent
} from './listener.js';

export interface LarkMessageBotOptions {
  app?: string;
  bot?: string;
  baseUrl?: string;
}

export interface LarkMessageSendCliOptions extends LarkMessageBotOptions {
  chat?: string;
  text?: string;
  format?: string;
  idempotencyKey?: string;
  json?: boolean;
}

export interface LarkMessageReadCliOptions extends LarkMessageBotOptions {
  chat?: string;
  limit?: string;
  before?: string;
  pageToken?: string;
  json?: boolean;
}

export interface LarkMessageListenCliOptions extends LarkMessageBotOptions {
  chat?: string;
  timeout?: string;
  once?: boolean;
  json?: boolean;
}

export interface ResolvedLarkMessageBot {
  appId: string;
  appSecret: string;
  name: string;
  baseUrl: string;
  source: 'config' | 'env';
  config?: StoredLarkConfig;
}

export interface SignalSource {
  on(signal: 'SIGINT' | 'SIGTERM', listener: () => void): unknown;
  off(signal: 'SIGINT' | 'SIGTERM', listener: () => void): unknown;
}

export interface LarkMessageCliDeps {
  env?: NodeJS.ProcessEnv;
  /** 单测直接注入已保存的机器人配置；不传时从 AgentDock 数据库读取。 */
  configs?: StoredLarkConfig[];
  fetcher?: typeof globalThis.fetch;
  stdin?: AsyncIterable<unknown> & { isTTY?: boolean };
  stdout?: { write(chunk: string): unknown };
  stderr?: { write(chunk: string): unknown };
  signals?: SignalSource;
  createListener?: (options: LarkLongConnectionListenerOptions) => LarkListener | Promise<LarkListener>;
}

export interface CliLarkMessage {
  messageId: string;
  chatId?: string;
  chatType?: string;
  messageType: string;
  createTime?: string;
  createTimeIso?: string;
  sender: { id?: string; openId?: string; type?: string; name?: string };
  text: string;
  mentions: Array<{ key?: string; name?: string; id?: string; openId?: string; appId?: string }>;
  rootId?: string;
  parentId?: string;
  threadId?: string;
  deleted?: boolean;
  updated?: boolean;
}

const output = (deps: LarkMessageCliDeps) => deps.stdout ?? process.stdout;
const errorOutput = (deps: LarkMessageCliDeps) => deps.stderr ?? process.stderr;
const envOf = (deps: LarkMessageCliDeps) => deps.env ?? process.env;

const botLabel = (config: Pick<StoredLarkConfig, 'appId' | 'name'>) => `${config.name?.trim() || config.appId} (${config.appId})`;

const availableBots = (configs: StoredLarkConfig[]) => configs.length
  ? configs.map(botLabel).join('、')
  : '（无已保存机器人）';

const noBotError = () => new Error(
  '未找到可用的飞书机器人配置。请先在 AgentDock 设置页保存机器人，或设置 LARK_APP_ID / LARK_APP_SECRET；'
  + '配置多个机器人时用 --app <appId> 或 --bot <名称> 选择。'
);

async function loadStoredConfigs(deps: LarkMessageCliDeps): Promise<StoredLarkConfig[]> {
  if (deps.configs) return deps.configs;
  const filename = resolveDatabasePath();
  if (!existsSync(filename)) return [];
  try {
    const repositories = createRepositories(filename);
    try {
      return await readLarkConfigs(repositories.config);
    } finally {
      repositories.close();
    }
  } catch (error) {
    throw new Error(
      `无法读取 AgentDock 机器人配置（${filename}）：${error instanceof Error ? error.message : String(error)}。`
      + '请检查数据库权限，或改用 LARK_APP_ID / LARK_APP_SECRET 环境变量。'
    );
  }
}

/**
 * 机器人选择顺序：
 * 1. `--app` 按 appId 精确匹配，`--bot` 按名称或 appId 匹配；
 * 2. 未指定时使用第一条已保存配置（与 daemon 内 `readLarkConfig` 的默认一致）；
 * 3. 没有保存配置时回退到 LARK_APP_ID / LARK_APP_SECRET。
 */
export async function resolveLarkMessageBot(
  options: LarkMessageBotOptions,
  deps: LarkMessageCliDeps = {}
): Promise<ResolvedLarkMessageBot> {
  const env = envOf(deps);
  const configs = await loadStoredConfigs(deps);
  const appSelector = options.app?.trim();
  const botSelector = options.bot?.trim();
  if (appSelector && botSelector) throw new Error('--app 和 --bot 只能指定一个。');

  const baseUrl = (options.baseUrl?.trim() || env.LARK_OPEN_API_BASE_URL?.trim() || 'https://open.feishu.cn').replace(/\/$/, '');
  let selected: StoredLarkConfig | undefined;
  if (appSelector) {
    selected = configs.find(config => config.appId === appSelector);
    if (!selected && env.LARK_APP_ID?.trim() === appSelector && env.LARK_APP_SECRET?.trim()) {
      return { appId: appSelector, appSecret: env.LARK_APP_SECRET.trim(), name: appSelector, baseUrl, source: 'env' };
    }
    if (!selected) {
      throw new Error(`没有找到 appId 为 ${appSelector} 的飞书机器人。已配置：${availableBots(configs)}。请用 --app <appId> 或 --bot <名称> 选择。`);
    }
  } else if (botSelector) {
    const matches = configs.filter(config => (config.name?.trim() || config.appId) === botSelector || config.appId === botSelector);
    if (matches.length > 1) {
      throw new Error(`机器人名称“${botSelector}”对应多个应用：${matches.map(config => config.appId).join('、')}。请改用 --app <appId>。`);
    }
    selected = matches[0];
    if (!selected) {
      throw new Error(`没有找到名称或 appId 为“${botSelector}”的飞书机器人。已配置：${availableBots(configs)}。`);
    }
  } else {
    selected = configs[0];
  }

  if (selected) {
    return {
      appId: selected.appId,
      appSecret: selected.appSecret,
      name: selected.name?.trim() || selected.appId,
      baseUrl,
      source: 'config',
      config: selected
    };
  }

  const appId = env.LARK_APP_ID?.trim();
  const appSecret = env.LARK_APP_SECRET?.trim();
  if (appId && appSecret) {
    return { appId, appSecret, name: appId, baseUrl, source: 'env' };
  }
  if (appId && !appSecret) {
    throw new Error(`已设置 LARK_APP_ID=${appId}，但缺少 LARK_APP_SECRET。请在 AgentDock 设置页保存机器人，或补齐环境变量。`);
  }
  throw noBotError();
}

export function redactLarkSecret(message: string, appSecret?: string): string {
  let redacted = message.replace(/(app_secret["'\s:=]+)[^"',}\s]+/gi, '$1[redacted]');
  if (appSecret) redacted = redacted.split(appSecret).join('[redacted]');
  return redacted;
}

export function larkMessageCliError(error: unknown, action: 'send' | 'read' | 'listen', bot: Pick<ResolvedLarkMessageBot, 'appId' | 'appSecret'>): Error {
  const raw = error instanceof Error ? error.message : String(error);
  let message = redactLarkSecret(raw, bot.appSecret);
  const lower = raw.toLowerCase();
  if (error instanceof LarkServiceError && error.code === 'LARK_LISTENER_START_FAILED') {
    message += `\n无法建立飞书长连接：请检查机器人 ${bot.appId} 的 App ID / App Secret，确认应用已启用机器人能力，并已开通接收消息权限。`;
  } else if (/app[_ ]?secret|app[_ ]?id|10003|10014|invalid credential|tenant_access_token/.test(lower)) {
    message += `\n机器人 ${bot.appId} 鉴权失败：请在 AgentDock 设置页重新检查 App ID / App Secret，确认应用已启用机器人能力。`;
  } else if (/permission|scope|99991672|230002|230013|forbidden/.test(lower)) {
    message += action === 'read'
      ? '\n请确认机器人已加入该群，并具备读取群消息的权限（im:message:readonly 或等价权限）。'
      : action === 'send'
        ? '\n请确认机器人已加入该群，并具备以机器人身份发消息的权限（im:message:send_as_bot）。'
        : '\n请确认应用已开通接收飞书消息事件的长连接权限。';
  }
  return new Error(message);
}

const requiredChatId = (options: LarkMessageBotOptions & { chat?: string }, deps: LarkMessageCliDeps) => {
  const chatId = options.chat?.trim() || envOf(deps).LARK_CHAT_ID?.trim();
  if (!chatId) throw new Error('缺少群 ID。请传 --chat <oc_xxx>，或设置 LARK_CHAT_ID。');
  if (!chatId.startsWith('oc_')) throw new Error(`群 ID 必须以 oc_ 开头，收到：${chatId}`);
  return chatId;
};

export async function readMessageText(
  positional: string | undefined,
  options: Pick<LarkMessageSendCliOptions, 'text'>,
  stdin: LarkMessageCliDeps['stdin'] = process.stdin
): Promise<string> {
  if (positional !== undefined && options.text !== undefined) throw new Error('消息正文只能给一个：使用位置参数或 --text，不要同时传。');
  let text = positional ?? options.text;
  if (text === undefined) {
    if (stdin.isTTY) throw new Error('缺少消息正文。请传入 --text <内容>，或通过 stdin 管道输入。');
    let received = '';
    for await (const chunk of stdin) received += Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk);
    text = received;
  }
  if (!text.trim()) throw new Error('消息正文不能为空。');
  return text;
}

export function buildLarkPostContent(text: string) {
  const paragraphs = text.split(/\n{2,}/).map(paragraph => paragraph.trim()).filter(Boolean);
  return {
    zh_cn: {
      title: '',
      content: paragraphs.map(paragraph => [{ tag: 'text', text: paragraph }])
    }
  };
}

export async function runLarkMessageSend(
  positional: string | undefined,
  options: LarkMessageSendCliOptions,
  deps: LarkMessageCliDeps = {}
): Promise<string> {
  const bot = await resolveLarkMessageBot(options, deps);
  const chatId = requiredChatId(options, deps);
  const text = await readMessageText(positional, options, deps.stdin);
  const format = options.format?.trim() || 'text';
  if (format !== 'text' && format !== 'post') throw new Error('--format 只能是 text 或 post。');
  const service = createLarkCardService(envOf(deps), deps.fetcher ?? globalThis.fetch, {
    appId: bot.appId,
    appSecret: bot.appSecret,
    baseUrl: bot.baseUrl
  });
  let result: LarkMessageResult;
  try {
    result = format === 'post'
      ? await service.sendPost({ chatId, content: buildLarkPostContent(text), ...(options.idempotencyKey ? { idempotencyKey: options.idempotencyKey } : {}) })
      : await service.sendText({ chatId, text, ...(options.idempotencyKey ? { idempotencyKey: options.idempotencyKey } : {}) });
  } catch (error) {
    throw larkMessageCliError(error, 'send', bot);
  }
  const payload = {
    ok: true,
    action: 'lark.message.send',
    appId: bot.appId,
    bot: bot.name,
    chatId: result.chatId ?? chatId,
    messageId: result.messageId,
    format
  };
  if (options.json) return `${JSON.stringify(payload)}\n`;
  return `已通过 ${bot.name} (${bot.appId}) 发送到 ${payload.chatId}：${payload.messageId}\n`;
}

export function parseBeforeTime(value: string | undefined): number | undefined {
  const text = value?.trim();
  if (!text) return undefined;
  if (/^\d+$/.test(text)) {
    const numeric = Number(text);
    if (!Number.isFinite(numeric) || numeric <= 0) throw new Error(`无法解析 --before：${value}`);
    return Math.floor(numeric >= 1_000_000_000_000 ? numeric / 1000 : numeric);
  }
  const parsed = Date.parse(text.replace(' ', 'T'));
  if (Number.isNaN(parsed)) throw new Error(`无法解析 --before：${value}。可用 ISO 时间（2026-11-12 10:00）或 Unix 时间戳。`);
  return Math.floor(parsed / 1000);
}

const positiveInteger = (value: string | undefined, name: string, fallback: number, max: number) => {
  const parsed = value === undefined ? fallback : Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) throw new Error(`${name} 必须是大于 0 的整数。`);
  if (parsed > max) throw new Error(`${name} 最大为 ${max}。`);
  return parsed;
};

function cliMessageFromChatMessage(message: LarkChatMessage): CliLarkMessage {
  const createTime = message.createTime;
  const timestamp = Number(createTime);
  const senderId = message.sender.id;
  return {
    messageId: message.messageId,
    ...(message.chatId ? { chatId: message.chatId } : {}),
    messageType: message.messageType,
    ...(createTime ? { createTime } : {}),
    ...(Number.isFinite(timestamp) && timestamp > 0 ? { createTimeIso: new Date(timestamp).toISOString() } : {}),
    sender: {
      ...(senderId?.startsWith('ou_') ? { openId: senderId } : senderId ? { id: senderId } : {}),
      ...(message.sender.type ? { type: message.sender.type } : {}),
      ...(message.sender.name ? { name: message.sender.name } : {})
    },
    text: '',
    mentions: message.mentions.map(mention => ({
      ...(mention.key ? { key: mention.key } : {}),
      ...(mention.name ? { name: mention.name } : {}),
      ...(mention.id?.startsWith('ou_') ? { openId: mention.id } : mention.id?.startsWith('cli_') ? { appId: mention.id } : mention.id ? { id: mention.id } : {})
    })),
    ...(message.threadId ? { threadId: message.threadId } : {}),
    ...(message.deleted ? { deleted: true } : {}),
    ...(message.updated ? { updated: true } : {})
  };
}

export async function formatLarkChatMessage(message: LarkChatMessage): Promise<CliLarkMessage> {
  const formatted = cliMessageFromChatMessage(message);
  const parsed = await parseLarkMessageContent(message.messageType, message.rawContent);
  return { ...formatted, text: parsed.text };
}

export function formatLarkMessages(messages: CliLarkMessage[]): string {
  if (!messages.length) return '没有消息。\n';
  return messages.map(message => {
    const time = message.createTimeIso ?? message.createTime ?? '未知时间';
    const sender = message.sender.name ?? message.sender.openId ?? message.sender.type ?? 'unknown';
    const text = message.text.replace(/\s*\n\s*/g, ' ⏎ ');
    return `${time}  ${sender}  ${message.messageId}  ${text}`;
  }).join('\n') + '\n';
}

export async function runLarkMessageRead(options: LarkMessageReadCliOptions, deps: LarkMessageCliDeps = {}): Promise<string> {
  const bot = await resolveLarkMessageBot(options, deps);
  const chatId = requiredChatId(options, deps);
  const limit = positiveInteger(options.limit, '--limit', 20, 200);
  const endTime = parseBeforeTime(options.before);
  const service = createLarkCardService(envOf(deps), deps.fetcher ?? globalThis.fetch, {
    appId: bot.appId,
    appSecret: bot.appSecret,
    baseUrl: bot.baseUrl
  });
  const items: LarkChatMessage[] = [];
  let pageToken = options.pageToken?.trim() || undefined;
  let hasMore = false;
  let nextPageToken: string | undefined;
  try {
    while (items.length < limit) {
      const page = await service.listChatMessages({
        chatId,
        pageSize: Math.min(50, limit - items.length),
        ...(pageToken ? { pageToken } : {}),
        ...(endTime ? { endTime } : {})
      });
      items.push(...page.items);
      hasMore = page.hasMore;
      nextPageToken = page.hasMore ? page.pageToken : undefined;
      if (!page.hasMore || !page.pageToken) break;
      pageToken = page.pageToken;
    }
  } catch (error) {
    throw larkMessageCliError(error, 'read', bot);
  }
  const messages = await Promise.all(items.slice(0, limit).map(formatLarkChatMessage));
  if (options.json) {
    return `${JSON.stringify({
      ok: true,
      action: 'lark.message.read',
      appId: bot.appId,
      bot: bot.name,
      chatId,
      count: messages.length,
      hasMore,
      ...(nextPageToken ? { nextPageToken } : {}),
      messages
    })}\n`;
  }
  return formatLarkMessages(messages);
}

function cliMessageFromEvent(event: LarkMessageEvent): CliLarkMessage {
  const timestamp = Number(event.createTime);
  return {
    messageId: event.messageId,
    chatId: event.chatId,
    chatType: event.chatType,
    messageType: event.messageType,
    ...(event.createTime ? { createTime: event.createTime } : {}),
    ...(Number.isFinite(timestamp) && timestamp > 0 ? { createTimeIso: new Date(timestamp).toISOString() } : {}),
    sender: {
      ...(event.senderOpenId ? { openId: event.senderOpenId } : {}),
      ...(event.senderType ? { type: event.senderType } : {})
    },
    text: '',
    mentions: event.mentions.map(mention => ({
      key: mention.key,
      name: mention.name,
      ...(mention.openId ? { openId: mention.openId } : {}),
      ...(mention.appId ? { appId: mention.appId } : {})
    })),
    ...(event.rootId ? { rootId: event.rootId } : {}),
    ...(event.parentId ? { parentId: event.parentId } : {}),
    ...(event.threadId ? { threadId: event.threadId } : {})
  };
}

export async function formatLarkMessageEvent(event: LarkMessageEvent): Promise<CliLarkMessage> {
  const formatted = cliMessageFromEvent(event);
  const parsed = await parseLarkMessageContent(event.messageType, event.content);
  return { ...formatted, text: parsed.text };
}

export function larkMessageEventJsonLine(message: CliLarkMessage, bot: Pick<ResolvedLarkMessageBot, 'appId' | 'name'>) {
  return `${JSON.stringify({
    type: 'message',
    appId: bot.appId,
    bot: bot.name,
    message
  })}\n`;
}

const listenerLog = (stderr: { write(chunk: string): unknown }) => ({
  info: () => {},
  warn: (_details: unknown, message?: string) => { stderr.write(`[lark] ${message ?? 'warning'}\n`); },
  error: (_details: unknown, message?: string) => { stderr.write(`[lark] ${message ?? 'error'}\n`); }
});

const listenerSdkLogger = (stderr: { write(chunk: string): unknown }, appSecret: string) => {
  const write = (...args: unknown[]) => {
    let text = '';
    try { text = args.map(value => typeof value === 'string' ? value : JSON.stringify(value)).join(' '); }
    catch { text = '[unserializable log]'; }
    stderr.write(`[lark-sdk] ${redactLarkSecret(text, appSecret)}\n`);
  };
  return { error: write, warn: write, info: write, debug: write, trace: write };
};

async function defaultListenerFactory(
  options: LarkLongConnectionListenerOptions,
  stderr: { write(chunk: string): unknown }
): Promise<LarkListener> {
  const { LarkLongConnectionListener } = await import('./listener.js');
  return new LarkLongConnectionListener(listenerLog(stderr), options);
}

export async function runLarkMessageListen(options: LarkMessageListenCliOptions, deps: LarkMessageCliDeps = {}): Promise<void> {
  const bot = await resolveLarkMessageBot(options, deps);
  const stdout = output(deps);
  const stderr = errorOutput(deps);
  const signals = deps.signals ?? process;
  const chatFilter = options.chat?.trim();
  if (chatFilter && !chatFilter.startsWith('oc_')) throw new Error(`群 ID 必须以 oc_ 开头，收到：${chatFilter}`);
  const timeoutSeconds = options.timeout === undefined ? undefined : positiveInteger(options.timeout, '--timeout', 0, 86_400);
  const listenerConfig = bot.config ?? ({ appId: bot.appId, appSecret: bot.appSecret } as StoredLarkConfig);

  let listener: LarkListener | undefined;
  let finished = false;
  let timer: NodeJS.Timeout | undefined;
  let writeChain = Promise.resolve();
  let resolveDone!: () => void;
  let rejectDone!: (error: unknown) => void;
  const done = new Promise<void>((resolve, reject) => { resolveDone = resolve; rejectDone = reject; });

  const cleanup = () => {
    if (timer) clearTimeout(timer);
    timer = undefined;
    signals.off('SIGINT', onSignal);
    signals.off('SIGTERM', onSignal);
  };
  const finish = (error?: unknown) => {
    if (finished) return;
    finished = true;
    cleanup();
    try { listener?.stop(); } catch (stopError) { stderr.write(`[lark] 关闭监听失败：${stopError instanceof Error ? stopError.message : String(stopError)}\n`); }
    listener = undefined;
    void writeChain.finally(() => error ? rejectDone(error) : resolveDone());
  };
  const onSignal = () => finish();
  signals.on('SIGINT', onSignal);
  signals.on('SIGTERM', onSignal);
  if (timeoutSeconds) timer = setTimeout(() => finish(), timeoutSeconds * 1_000);

  const onMessage = (event: LarkMessageEvent) => {
    if (finished) return;
    if (chatFilter && event.chatId !== chatFilter) return;
    writeChain = writeChain.then(async () => {
      if (finished) return;
      const message = await formatLarkMessageEvent(event);
      stdout.write(larkMessageEventJsonLine(message, bot));
      if (options.once) finish();
    }).catch(error => {
      finish(larkMessageCliError(error, 'listen', bot));
    });
    return writeChain;
  };

  const factory: NonNullable<LarkMessageCliDeps['createListener']> = deps.createListener
    ?? (listenerOptions => defaultListenerFactory(listenerOptions, stderr));
  try {
    listener = await factory({
      onMessage,
      baseUrl: bot.baseUrl,
      sdkLogger: listenerSdkLogger(stderr, bot.appSecret),
      onTerminalFailure: () => {
        finish(new Error(`飞书长连接重连耗尽后仍不可用。请检查网络和机器人 ${bot.appId} 的配置，然后重新运行。`));
      }
    });
    if (finished) { listener.stop(); listener = undefined; return done; }
    await listener.start(listenerConfig);
  } catch (error) {
    finish(larkMessageCliError(error, 'listen', bot));
    return done;
  }
  if (finished) {
    listener.stop();
    listener = undefined;
  }
  return done;
}
