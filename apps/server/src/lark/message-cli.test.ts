import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import type { StoredLarkConfig } from './config.js';
import type { LarkListener, LarkLongConnectionListenerOptions } from './listener.js';
import {
  buildLarkPostContent,
  formatLarkChatMessage,
  formatLarkMessages,
  larkMessageEventJsonLine,
  parseBeforeTime,
  readMessageText,
  redactLarkSecret,
  resolveLarkMessageBot,
  runLarkMessageListen,
  runLarkMessageRead,
  runLarkMessageSend,
  type SignalSource
} from './message-cli.js';
import { LarkServiceError } from './service.js';

const storedBot = (overrides: Partial<StoredLarkConfig> = {}): StoredLarkConfig => ({
  appId: 'cli_a',
  appSecret: 'super-secret',
  name: '发布机器人',
  preInjectPrompt: '',
  listening: true,
  groupToolsEnabled: false,
  groupToolsAllowSend: false,
  groupSessionScope: 'user',
  pushIntervalMs: 1_000,
  hideTraceOnComplete: true,
  quietReply: false,
  allowedUsers: [],
  allowedEmails: [],
  allowedBots: [],
  peerBotsAllowed: true,
  highRiskAllowedUsers: [],
  highRiskAllowedEmails: [],
  highRiskPattern: 'x',
  gateEnabled: false,
  softGateEnabled: false,
  hardGateEnabled: false,
  hookTrustConfirmed: false,
  ...overrides
});

const jsonResponse = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { 'content-type': 'application/json' }
});

const tokenResponse = () => jsonResponse({ code: 0, tenant_access_token: 'tenant-token', expire: 7200 });

describe('Lark message bot selection', () => {
  it('uses the first saved bot by default and selects another by name', async () => {
    const configs = [storedBot(), storedBot({ appId: 'cli_b', name: '告警机器人', appSecret: 'second-secret' })];
    await expect(resolveLarkMessageBot({}, { configs })).resolves.toMatchObject({ appId: 'cli_a', name: '发布机器人', source: 'config' });
    await expect(resolveLarkMessageBot({ bot: '告警机器人' }, { configs })).resolves.toMatchObject({ appId: 'cli_b', source: 'config' });
    await expect(resolveLarkMessageBot({ app: 'cli_b' }, { configs })).resolves.toMatchObject({ appId: 'cli_b', source: 'config' });
  });

  it('rejects ambiguous bot names with app IDs as the next step', async () => {
    const configs = [
      storedBot({ appId: 'cli_a', name: '同名' }),
      storedBot({ appId: 'cli_b', name: '同名', appSecret: 'two' })
    ];
    await expect(resolveLarkMessageBot({ bot: '同名' }, { configs })).rejects.toThrow(/多个应用：cli_a、cli_b.*--app/);
  });

  it('falls back to environment credentials when no bot is saved', async () => {
    await expect(resolveLarkMessageBot({}, {
      configs: [],
      env: { LARK_APP_ID: 'cli_env', LARK_APP_SECRET: 'env-secret', LARK_OPEN_API_BASE_URL: 'https://open.larksuite.com/' }
    })).resolves.toMatchObject({
      appId: 'cli_env', appSecret: 'env-secret', baseUrl: 'https://open.larksuite.com', source: 'env'
    });
  });

  it('gives an actionable error when nothing is configured and never echoes a secret', async () => {
    await expect(resolveLarkMessageBot({}, { configs: [], env: {} })).rejects.toThrow(/设置页保存机器人.*--app/);
    await expect(resolveLarkMessageBot({ app: 'cli_missing' }, { configs: [storedBot()] })).rejects.toThrow(/没有找到 appId.*发布机器人 \(cli_a\)/);
    expect(redactLarkSecret('app_secret=super-secret raw super-secret', 'super-secret')).toBe('app_secret=[redacted] raw [redacted]');
  });
});

describe('Lark message formatting', () => {
  it('formats text and post messages into stable CLI objects', async () => {
    const text = await formatLarkChatMessage({
      messageId: 'om_1', chatId: 'oc_1', messageType: 'text', createTime: '1700000000000',
      sender: { id: 'ou_user', idType: 'open_id', type: 'user', name: '小王' }, rawContent: JSON.stringify({ text: 'hello' }),
      mentions: [], deleted: false, updated: false
    });
    expect(text).toMatchObject({ messageId: 'om_1', text: 'hello', sender: { openId: 'ou_user', name: '小王' } });
    expect(text.createTimeIso).toBe('2023-11-14T22:13:20.000Z');

    const post = await formatLarkChatMessage({
      messageId: 'om_2', chatId: 'oc_1', messageType: 'post', createTime: '1700000000000',
      sender: { id: 'ou_user' }, rawContent: JSON.stringify({ zh_cn: { title: '标题', content: [[{ tag: 'text', text: '正文' }]] } }),
      mentions: [], deleted: false, updated: false
    });
    expect(post.text).toBe('标题\n\n正文');
  });

  it('builds a post payload that preserves paragraph breaks', () => {
    expect(buildLarkPostContent('第一段\n\n第二段\n继续')).toEqual({
      zh_cn: {
        title: '',
        content: [[{ tag: 'text', text: '第一段' }], [{ tag: 'text', text: '第二段\n继续' }]]
      }
    });
  });

  it('renders one JSONL message event and compact human lines', () => {
    const message = {
      messageId: 'om_1', chatId: 'oc_1', messageType: 'text', sender: { name: '小王' }, text: '第一行\n第二行', mentions: []
    };
    expect(larkMessageEventJsonLine(message, { appId: 'cli_a', name: '发布机器人' }).trim()).toBe(JSON.stringify({
      type: 'message', appId: 'cli_a', bot: '发布机器人', message
    }));
    expect(formatLarkMessages([message])).toContain('小王  om_1  第一行 ⏎ 第二行');
  });

  it('parses --before as seconds, milliseconds, or ISO time', () => {
    expect(parseBeforeTime('1700000000')).toBe(1_700_000_000);
    expect(parseBeforeTime('1700000000000')).toBe(1_700_000_000);
    expect(parseBeforeTime('2023-11-14T22:13:20Z')).toBe(1_700_000_000);
    expect(() => parseBeforeTime('not-a-time')).toThrow(/无法解析 --before/);
  });

  it('reads message bodies from stdin without trimming content', async () => {
    await expect(readMessageText(undefined, {}, Readable.from(['  hello\n']))).resolves.toBe('  hello\n');
    await expect(readMessageText(undefined, {}, { ...Readable.from([]), isTTY: true } as never)).rejects.toThrow(/stdin/);
    await expect(readMessageText('a', { text: 'b' })).rejects.toThrow(/只能给一个/);
  });
});

describe('Lark message send/read', () => {
  it('sends text as the selected bot and prints a JSON result without the secret', async () => {
    const fetcher = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes('/auth/v3/tenant_access_token')) return tokenResponse();
      return jsonResponse({ code: 0, data: { message_id: 'om_sent', chat_id: 'oc_1' } });
    });
    const result = await runLarkMessageSend(undefined, { chat: 'oc_1', text: '构建完成', json: true }, {
      configs: [storedBot()], fetcher: fetcher as typeof fetch
    });
    expect(JSON.parse(result)).toEqual({
      ok: true, action: 'lark.message.send', appId: 'cli_a', bot: '发布机器人', chatId: 'oc_1', messageId: 'om_sent', format: 'text'
    });
    expect(result).not.toContain('super-secret');
    const sendCall = fetcher.mock.calls.find(call => String(call[0]).includes('/im/v1/messages?receive_id_type=chat_id'));
    expect(JSON.parse(String((sendCall?.[1] as RequestInit).body))).toEqual({
      receive_id: 'oc_1', msg_type: 'text', content: JSON.stringify({ text: '构建完成' })
    });
  });

  it('creates a post payload and supports stdin', async () => {
    const fetcher = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes('/auth/v3/tenant_access_token')) return tokenResponse();
      return jsonResponse({ code: 0, data: { message_id: 'om_post', chat_id: 'oc_1' } });
    });
    const result = await runLarkMessageSend(undefined, { chat: 'oc_1', format: 'post', json: true }, {
      configs: [storedBot()], fetcher: fetcher as typeof fetch, stdin: Readable.from(['第一段\n\n第二段'])
    });
    expect(result).toContain('om_post');
    const sendCall = fetcher.mock.calls.find(call => String(call[0]).includes('/im/v1/messages?receive_id_type=chat_id'));
    expect(JSON.parse(String((sendCall?.[1] as RequestInit).body))).toMatchObject({
      msg_type: 'post',
      content: JSON.stringify(buildLarkPostContent('第一段\n\n第二段'))
    });
  });

  it('reads recent messages and returns metadata plus parsed text', async () => {
    const fetcher = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes('/auth/v3/tenant_access_token')) return tokenResponse();
      return jsonResponse({
        code: 0,
        data: {
          has_more: false,
          items: [{
            message_id: 'om_2', chat_id: 'oc_1', msg_type: 'text', create_time: '1700000000000',
            sender: { id: 'ou_user', id_type: 'open_id', sender_type: 'user', name: '小王' },
            body: { content: JSON.stringify({ text: '最近一条' }) }, mentions: []
          }]
        }
      });
    });
    const result = await runLarkMessageRead({ chat: 'oc_1', limit: '10', before: '1700000100', json: true }, {
      configs: [storedBot()], fetcher: fetcher as typeof fetch
    });
    expect(JSON.parse(result)).toMatchObject({
      ok: true, chatId: 'oc_1', count: 1, hasMore: false, messages: [{ messageId: 'om_2', text: '最近一条', sender: { name: '小王' } }]
    });
    expect(fetcher.mock.calls.some(call => String(call[0]).includes('end_time=1700000100'))).toBe(true);
  });
});

describe('Lark message listener lifecycle', () => {
  it('writes JSONL, stops after one matching message, and removes signal handlers', async () => {
    const signals = new EventEmitter();
    const stdout: string[] = [];
    const stderr: string[] = [];
    let captured: LarkLongConnectionListenerOptions | undefined;
    const stop = vi.fn();
    const listener: LarkListener = { listening: true, start: async () => {}, stop };
    const run = runLarkMessageListen({ chat: 'oc_1', once: true }, {
      configs: [storedBot()],
      signals: signals as unknown as SignalSource,
      stdout: { write: chunk => stdout.push(chunk) },
      stderr: { write: chunk => stderr.push(chunk) },
      createListener: options => { captured = options; return listener; }
    });
    await vi.waitFor(() => expect(captured).toBeDefined());
    await captured!.onMessage!({
      messageId: 'om_event', chatId: 'oc_2', chatType: 'group', messageType: 'text',
      content: JSON.stringify({ text: 'ignored' }), senderOpenId: 'ou_1', senderType: 'user', mentions: []
    }, storedBot());
    expect(stdout).toHaveLength(0);
    await captured!.onMessage!({
      messageId: 'om_event', chatId: 'oc_1', chatType: 'group', messageType: 'text',
      content: JSON.stringify({ text: 'hello' }), senderOpenId: 'ou_1', senderType: 'user', mentions: []
    }, storedBot());
    await run;
    expect(stop).toHaveBeenCalledOnce();
    expect(JSON.parse(stdout.join(''))).toMatchObject({ type: 'message', appId: 'cli_a', message: { messageId: 'om_event', text: 'hello' } });
    expect(signals.listenerCount('SIGINT')).toBe(0);
    expect(signals.listenerCount('SIGTERM')).toBe(0);
    expect(stderr).toEqual([]);
  });

  it('stops and resolves on SIGINT or SIGTERM before any message', async () => {
    for (const signal of ['SIGINT', 'SIGTERM'] as const) {
      const signals = new EventEmitter();
      const stop = vi.fn();
      const listener: LarkListener = { listening: true, start: async () => {}, stop };
      const run = runLarkMessageListen({}, {
        configs: [storedBot()],
        signals: signals as unknown as SignalSource,
        stdout: { write: () => {} },
        stderr: { write: () => {} },
        createListener: () => listener
      });
      await vi.waitFor(() => expect(signals.listenerCount(signal)).toBe(1));
      signals.emit(signal);
      await run;
      expect(stop).toHaveBeenCalledOnce();
      expect(signals.listenerCount('SIGINT')).toBe(0);
      expect(signals.listenerCount('SIGTERM')).toBe(0);
    }
  });

  it('stops when the SDK exhausts its reconnect budget', async () => {
    const signals = new EventEmitter();
    const stop = vi.fn();
    let captured: LarkLongConnectionListenerOptions | undefined;
    const run = runLarkMessageListen({}, {
      configs: [storedBot()],
      signals: signals as unknown as SignalSource,
      stdout: { write: () => {} },
      stderr: { write: () => {} },
      createListener: options => {
        captured = options;
        return { listening: true, start: async () => {}, stop };
      }
    });
    await vi.waitFor(() => expect(captured).toBeDefined());
    captured!.onTerminalFailure?.('cli_a', storedBot());
    await expect(run).rejects.toThrow(/重连耗尽/);
    expect(stop).toHaveBeenCalledOnce();
    expect(signals.listenerCount('SIGINT')).toBe(0);
  });

  it('reports start failures and still closes the listener', async () => {
    const stop = vi.fn();
    const listener: LarkListener = {
      listening: false,
      start: async () => { throw new LarkServiceError('LARK_LISTENER_START_FAILED', 'bad app_secret=super-secret'); },
      stop
    };
    await expect(runLarkMessageListen({}, {
      configs: [storedBot()],
      stdout: { write: () => {} },
      stderr: { write: () => {} },
      createListener: () => listener
    })).rejects.toThrow(/bad app_secret=\[redacted\][\s\S]*无法建立飞书长连接/);
    expect(stop).toHaveBeenCalledOnce();
  });
});
