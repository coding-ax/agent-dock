import { describe, expect, it } from 'vitest';
import { larkSessionAppLink, parseLarkSourceId } from './lark-session-link.js';

describe('parseLarkSourceId', () => {
  it('解析群聊主流会话', () => {
    expect(parseLarkSourceId('cli_aae2df:oc_f888:group:chat')).toEqual({ appId: 'cli_aae2df', chatId: 'oc_f888', chatType: 'group', scope: 'chat' });
  });
  it('解析按发送人 / 话题 scope（scope 内含冒号）', () => {
    expect(parseLarkSourceId('cli_x:oc_1:group:user:ou_abc')?.scope).toBe('user:ou_abc');
    expect(parseLarkSourceId('cli_x:oc_1:group:thread:omt_abc')?.scope).toBe('thread:omt_abc');
  });
  it('解析私聊（无 scope）', () => {
    expect(parseLarkSourceId('cli_x:oc_1:p2p')).toEqual({ appId: 'cli_x', chatId: 'oc_1', chatType: 'p2p', scope: '' });
  });
  it('兼容历史两段格式 <appId>:<chatId>', () => {
    expect(parseLarkSourceId('cli_example:oc_example')).toEqual({ appId: 'cli_example', chatId: 'oc_example', chatType: 'p2p', scope: '' });
  });
  it('非飞书来源 / 非法 chatId 返回 undefined', () => {
    expect(parseLarkSourceId(undefined)).toBeUndefined();
    expect(parseLarkSourceId('codex://threads/abc')).toBeUndefined();
    expect(parseLarkSourceId('cli_x:not_a_chat:group:chat')).toBeUndefined();
  });
});

describe('larkSessionAppLink', () => {
  it('群主流给出直达链接', () => {
    expect(larkSessionAppLink('cli_x:oc_1:group:chat')).toEqual({ url: 'https://applink.feishu.cn/client/chat/open?openChatId=oc_1', exact: true });
  });
  it('话题会话带上 threadId 做 best-effort 直达（exact=false）', () => {
    expect(larkSessionAppLink('cli_x:oc_1:group:thread:omt_1')).toEqual({ url: 'https://applink.feishu.cn/client/chat/open?openChatId=oc_1&threadId=omt_1', exact: false, threadId: 'omt_1' });
  });
});
