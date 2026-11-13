import { describe, expect, it, vi } from 'vitest';
import { buildLarkAvatarSendInput, formatLarkAvatarSendResult } from './cli.js';

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
});
