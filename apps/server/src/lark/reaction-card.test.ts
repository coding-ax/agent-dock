import { describe, expect, it } from 'vitest';
import { escapeCardMarkdown, authorizeCardOperator } from './routes.js';
import { LarkServiceError } from './service.js';

describe('reaction ask-card markdown', () => {
  it('keeps user text from changing card structure or injecting links', () => {
    const escaped = escapeCardMarkdown('看这个 [点我](https://evil.example)\n# 标题 `code` <at id="x">');
    expect(escaped).not.toContain('\n');
    expect(escaped).toContain('\\[点我\\]');
    expect(escaped).toContain('\\#');
    expect(escaped).toContain('\\`code\\`');
    expect(escaped).toContain('\\<at id="x"\\>');
  });

  it('leaves ordinary text readable', () => {
    expect(escapeCardMarkdown('  把发布说明整理一下，谢谢  ')).toBe('把发布说明整理一下，谢谢');
  });
});

describe('card action authorization wiring', () => {
  const service = {
    getUserEmails: async () => { throw new LarkServiceError('LARK_OPENAPI_ERROR', 'not in contacts', 502, { upstreamCode: 230001 }); },
    resolveChatUsersByNames: async () => []
  };
  const config = {
    appId: 'cli_test', appSecret: 'secret', allowedUsers: [{ openId: 'ou_member', name: '成员' }], peerBotsAllowed: true
  } as unknown as Parameters<typeof authorizeCardOperator>[0]['config'];

  it('declares card clickers as human users so 230001 cannot be treated as a peer bot', async () => {
    // 受限名单 + 通讯录不可见（230001）：卡片入口必须拒绝，而不是走 peerBotsAllowed。
    await expect(authorizeCardOperator({ config, operatorOpenId: 'ou_stranger', service })).resolves.toBe(false);
    // 白名单成员照常放行。
    await expect(authorizeCardOperator({ config, operatorOpenId: 'ou_member', service })).resolves.toBe(true);
  });

  it('still refuses a card clicker without an open id when a list is configured', async () => {
    await expect(authorizeCardOperator({ config, service })).resolves.toBe(false);
  });
});
