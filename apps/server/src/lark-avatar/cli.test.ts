import { describe, expect, it, vi } from 'vitest';
import {
  buildLarkAvatarReactionInput,
  buildLarkAvatarSendInput,
  formatLarkAvatarDiagnostics,
  formatLarkAvatarSendResult,
  reactionDiagnosticsLimit
} from './cli.js';

describe('lark avatar send CLI', () => {
  it('builds a request with reply target, thread flags and repeated at targets', () => {
    expect(buildLarkAvatarSendInput({
      chat: '  发布群  ',
      text: '@张三 已更到预发',
      replyTo: 'om_parent',
      inThread: true,
      at: [' 张三 ', 'ou_abc', '张三', ''],
      match: 'fuzzy'
    })).toEqual({
      chat: '发布群',
      text: '@张三 已更到预发',
      replyTo: 'om_parent',
      inThread: true,
      at: ['张三', 'ou_abc'],
      match: 'fuzzy'
    });
  });

  it('reads text from a file and permits stdin', () => {
    const readFile = vi.fn(() => '文件正文\n');
    expect(buildLarkAvatarSendInput({ chat: 'oc_1', textFile: '-' }, readFile))
      .toEqual({ chat: 'oc_1', text: '文件正文\n' });
    expect(readFile).toHaveBeenCalledWith('-');
  });

  it('keeps the reported 19-digit group id and ou_ mention untouched', () => {
    expect(buildLarkAvatarSendInput({
      chat: '[TikTok Search] Code Review Group (Search Cloud)',
      text: '@ou_3658a80b8ff9251eee1c2b0f36d1a 请看',
      at: ['ou_3658a80b8ff9251eee1c2b0f36d1a']
    })).toEqual({
      chat: '[TikTok Search] Code Review Group (Search Cloud)',
      text: '@ou_3658a80b8ff9251eee1c2b0f36d1a 请看',
      at: ['ou_3658a80b8ff9251eee1c2b0f36d1a']
    });
    const request = buildLarkAvatarSendInput({
      chat: '7246718914305097756',
      text: 'hi',
      replyTo: '7246718914305097758'
    });
    expect(request.chat).toBe('7246718914305097756');
    expect(request.replyTo).toBe('7246718914305097758');
  });

  it('fails with actionable messages for missing or conflicting input', () => {
    expect(() => buildLarkAvatarSendInput({ text: 'hi' })).toThrow(/--chat 必填/);
    expect(() => buildLarkAvatarSendInput({ chat: 'oc_1' })).toThrow(/消息正文不能为空/);
    expect(() => buildLarkAvatarSendInput({ chat: 'oc_1', text: 'hi', textFile: 'a.txt' })).toThrow(/只能用一个/);
    expect(() => buildLarkAvatarSendInput({ chat: 'oc_1', text: '  ' })).toThrow(/消息正文不能为空/);
    expect(() => buildLarkAvatarSendInput({ chat: 'oc_1', text: 'hi', match: 'prefix' })).toThrow(/exact 或 fuzzy/);
  });

  it('formats a human-readable send result', () => {
    expect(formatLarkAvatarSendResult({
      messageId: 'om_sent',
      chatId: '900001',
      rootId: 555,
      mentions: [{ userId: 42, name: '张三' }]
    })).toBe('已发送 om_sent\n群：900001\n回复：555\n提及：@张三（42）\n');
  });

  it('builds fake reaction input and validates the operator type', () => {
    expect(buildLarkAvatarReactionInput({
      message: ' om_fake ',
      emoji: ' THUMBSUP ',
      operator: 'ou_me',
      operatorType: 'user',
      actionTime: '1000',
      chat: 'oc_test',
      chatName: '测试群',
      sender: '张三',
      content: '整理发布说明'
    })).toEqual({
      messageId: 'om_fake',
      emojiType: 'THUMBSUP',
      operatorId: 'ou_me',
      operatorType: 'user',
      actionTime: '1000',
      chatId: 'oc_test',
      chatName: '测试群',
      senderName: '张三',
      content: '整理发布说明'
    });
    expect(() => buildLarkAvatarReactionInput({ message: '', emoji: 'DONE' })).toThrow(/--message 必填/);
    expect(() => buildLarkAvatarReactionInput({ message: 'om_1', emoji: '' })).toThrow(/--emoji 必填/);
    expect(() => buildLarkAvatarReactionInput({ message: 'om_1', emoji: 'DONE', operatorType: 'human' })).toThrow(/user、bot 或 app/);
  });

  it('formats diagnostics with skip reasons instead of hiding them', () => {
    const text = formatLarkAvatarDiagnostics({
      lastEvent: {
        at: '2026-01-01T00:00:00.000Z', messageId: 'om_1', emojiType: 'THUMBSUP',
        operatorType: 'user', operatorId: 'ou_me', outcome: 'ignored:emoji_mismatch', detail: 'DONE'
      },
      triggers: [{
        createdAt: '2026-01-01T00:00:00.000Z', emoji: 'THUMBSUP', state: 'ignored', reason: 'bot_reaction'
      }]
    });
    expect(text).toContain('ignored:emoji_mismatch：DONE');
    expect(text).toContain('THUMBSUP ignored（bot_reaction）');
    expect(reactionDiagnosticsLimit('0')).toBe(1);
    expect(reactionDiagnosticsLimit('500')).toBe(100);
    expect(reactionDiagnosticsLimit(undefined)).toBe(10);
  });
});
