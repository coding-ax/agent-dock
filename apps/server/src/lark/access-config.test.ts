import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRepositories } from '@agent-dock/agent-dock-storage';
import type { RepositoryBundle } from '@agent-dock/agent-dock-shared';
import { isLarkOperatorAllowed, resolveLarkAccessConfig } from './access-config.js';
import { deleteLarkConfig, readLarkConfig, saveLarkConfig, type SaveLarkConfigInput } from './config.js';
import { createLarkCardService, LarkServiceError } from './service.js';

const bundles: RepositoryBundle[] = [];
const directories: string[] = [];
const repository = (filename = ':memory:') => { const bundle = createRepositories(filename); bundles.push(bundle); return bundle.config; };
const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; };
const member = (openId: string, name = '成员') => ({ openId, name });
async function configured(repo: ReturnType<typeof repository>, input: SaveLarkConfigInput = {}) {
  return (await saveLarkConfig(repo, undefined, { appId: 'cli_test', appSecret: 'secret', ...input }))[0]!;
}
afterEach(() => { bundles.splice(0).forEach(bundle => bundle.close()); directories.splice(0).forEach(dir => rmSync(dir, { recursive: true, force: true })); });

describe('persistent Lark identity bindings', () => {
  it('pins names with the real name resolver across later calls and database reopening', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'agentdock-bindings-')); directories.push(dir);
    const file = join(dir, 'config.db');
    const repo = repository(file);
    const config = await configured(repo, { allowedUserNames: ['成员'] });
    let openId = 'ou_original';
    const service = createLarkCardService({}, fetch, { appId: config.appId, appSecret: config.appSecret });
    vi.spyOn(service, 'listChats').mockResolvedValue({ items: [{ chatId: 'oc_group', name: '群', external: false }], hasMore: false });
    const listMembers = vi.spyOn(service, 'listChatMembers').mockImplementation(async () => ({ items: [{ memberId: openId, openId, memberType: 'user', name: '成员' }], hasMore: false }));
    expect((await resolveLarkAccessConfig(config, service, 'user', repo)).allowedUsers).toEqual([member('ou_original')]);
    openId = 'ou_replacement';
    const reopened = repository(file);
    expect((await resolveLarkAccessConfig(config, service, 'operator', reopened)).allowedUsers).toEqual([member('ou_original')]);
    expect(listMembers).toHaveBeenCalledOnce();
    expect(await readLarkConfig(reopened, config.appId)).toMatchObject({ allowedUsers: [member('ou_original')], allowedUserNames: [] });
  });

  it('persists bot and high-risk identities independently', async () => {
    const repo = repository();
    const config = await configured(repo, { allowedUsers: [member('ou_user')], allowedBotNames: ['机器人'], peerBotsAllowed: false, gateEnabled: true, highRiskAllowedUserNames: ['管理员'] });
    const resolver = vi.fn().mockResolvedValueOnce([member('ou_bot', '机器人')]).mockResolvedValueOnce([member('ou_admin', '管理员')]);
    const service = { resolveChatUsersByNames: resolver };
    await resolveLarkAccessConfig(config, service, 'bot', repo);
    await resolveLarkAccessConfig(config, service, 'user', repo);
    resolver.mockRejectedValue(new Error('姓名已更换'));
    expect((await resolveLarkAccessConfig(config, service, 'bot', repo)).allowedBots[0]?.openId).toBe('ou_bot');
    expect((await resolveLarkAccessConfig(config, service, 'user', repo)).highRiskAllowedUsers[0]?.openId).toBe('ou_admin');
    expect(resolver).toHaveBeenCalledTimes(2);
    expect(resolver).toHaveBeenCalledWith(['机器人'], ['bot']);
  });

  it('does not resolve unused bot restrictions or a disabled gate', async () => {
    const repo = repository();
    const config = await configured(repo, { allowedBotNames: ['机器人'], highRiskAllowedUserNames: ['管理员'] });
    const resolveChatUsersByNames = vi.fn();
    await resolveLarkAccessConfig(config, { resolveChatUsersByNames }, 'user', repo);
    await resolveLarkAccessConfig(config, { resolveChatUsersByNames }, 'operator', repo);
    expect(resolveChatUsersByNames).not.toHaveBeenCalled();
  });

  it.each(['not found', 'ambiguous', 'permission denied'])('keeps pending restrictions after %s', async message => {
    const repo = repository();
    const config = await configured(repo, { allowedUserNames: ['成员'] });
    await expect(resolveLarkAccessConfig(config, { resolveChatUsersByNames: vi.fn().mockRejectedValue(new Error(message)) }, 'user', repo)).rejects.toThrow(message);
    expect(await readLarkConfig(repo, config.appId)).toMatchObject({ allowedUsers: [], allowedUserNames: ['成员'] });
  });

  it('adopts the first committed identity when two database connections race', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'agentdock-race-')); directories.push(dir);
    const file = join(dir, 'config.db');
    const firstRepo = repository(file), secondRepo = repository(file);
    const config = await configured(firstRepo, { allowedUserNames: ['成员'] });
    const entered = deferred(), release = deferred();
    const slow = resolveLarkAccessConfig(config, { resolveChatUsersByNames: async () => { entered.resolve(); await release.promise; return [member('ou_replacement')]; } }, 'user', secondRepo);
    await entered.promise;
    await resolveLarkAccessConfig(config, { resolveChatUsersByNames: async () => [member('ou_original')] }, 'user', firstRepo);
    release.resolve();
    expect((await slow).allowedUsers).toEqual([member('ou_original')]);
    expect((await readLarkConfig(secondRepo, config.appId))?.allowedUsers).toEqual([member('ou_original')]);
  });

  it('rejects an in-flight result after the administrator changes and restores the same names', async () => {
    const repo = repository();
    const config = await configured(repo, { allowedUserNames: ['成员'] });
    const entered = deferred(), release = deferred();
    const resolving = resolveLarkAccessConfig(config, { resolveChatUsersByNames: async () => { entered.resolve(); await release.promise; return [member('ou_stale')]; } }, 'user', repo);
    const rejected = expect(resolving).rejects.toMatchObject({ code: 'LARK_ACCESS_CONFIG_CHANGED' });
    await entered.promise;
    await saveLarkConfig(repo, undefined, { originalAppId: config.appId, allowedUserNames: ['其他成员'] });
    await saveLarkConfig(repo, undefined, { originalAppId: config.appId, allowedUserNames: ['成员'] });
    release.resolve(); await rejected;
    expect(await readLarkConfig(repo, config.appId)).toMatchObject({ allowedUsers: [], allowedUserNames: ['成员'] });
  });

  it('does not recreate a deleted bot after an in-flight lookup', async () => {
    const repo = repository(); const config = await configured(repo, { allowedUserNames: ['成员'] });
    const entered = deferred(), release = deferred();
    const resolving = resolveLarkAccessConfig(config, { resolveChatUsersByNames: async () => { entered.resolve(); await release.promise; return [member('ou_stale')]; } }, 'user', repo);
    const rejected = expect(resolving).rejects.toMatchObject({ code: 'LARK_ACCESS_CONFIG_CHANGED' });
    await entered.promise; await deleteLarkConfig(repo, config.appId); release.resolve(); await rejected;
    expect(await readLarkConfig(repo, config.appId)).toBeUndefined();
  });

  it('retries a concurrent administrator save without erasing a freshly persisted binding', async () => {
    const repo = repository(); const config = await configured(repo, { allowedUserNames: ['成员'] });
    const entered = deferred(), release = deferred(); let calls = 0;
    const agents = { get: async () => { if (++calls === 1) { entered.resolve(); await release.promise; } return { id: 'codex' }; } } as any;
    const saving = saveLarkConfig(repo, agents, { originalAppId: config.appId, defaultAgentId: 'codex', traceLimit: 75, allowedUserNames: ['成员'] });
    await entered.promise;
    await resolveLarkAccessConfig(config, { resolveChatUsersByNames: async () => [member('ou_original')] }, 'user', repo);
    release.resolve(); await saving;
    expect(await readLarkConfig(repo, config.appId)).toMatchObject({ allowedUsers: [member('ou_original')], allowedUserNames: [], traceLimit: 75 });
    expect(calls).toBe(2);
  });

  it('does not authorize when the binding cannot be persisted', async () => {
    const repo = repository(); const config = await configured(repo, { allowedUserNames: ['成员'] });
    const broken = { ...repo, compareAndSet: async () => { throw new Error('disk full'); } };
    await expect(resolveLarkAccessConfig(config, { resolveChatUsersByNames: async () => [member('ou_original')] }, 'user', broken)).rejects.toThrow('disk full');
    expect((await readLarkConfig(repo, config.appId))?.allowedUserNames).toEqual(['成员']);
  });
});

describe('operator access policy', () => {
  const open = (file: string, methods: Record<string, unknown> = {}) => ({ getUserEmails: async () => [] as string[], resolveChatUsersByNames: async () => [] as Array<{ openId: string; name: string }>, ...methods });

  it('allows everyone when no list is configured', async () => {
    const repo = repository(); const config = await configured(repo);
    expect(await isLarkOperatorAllowed({ config, operatorOpenId: 'ou_any', service: open(':memory:'), repository: repo })).toBe(true);
  });

  it('matches allowedUsers by open id and rejects strangers', async () => {
    const repo = repository(); const config = await configured(repo, { allowedUsers: [{ openId: 'ou_member', name: '成员' }] });
    const service = open(':memory:');
    expect(await isLarkOperatorAllowed({ config, operatorOpenId: 'ou_member', service, repository: repo })).toBe(true);
    expect(await isLarkOperatorAllowed({ config, operatorOpenId: 'ou_stranger', service, repository: repo })).toBe(false);
    expect(await isLarkOperatorAllowed({ config, service, repository: repo })).toBe(false);
  });

  it('resolves an email-only allow list instead of denying everyone', async () => {
    const repo = repository(); const config = await configured(repo, { allowedEmails: ['member@example.com'] });
    // 仅邮箱白名单时旧实现只看 allowedUsers，把所有人都拒绝；这是权限逻辑分叉。
    const service = open(':memory:', { getUserEmails: async (openId: string) => openId === 'ou_member' ? ['member@example.com'] : ['other@example.com'] });
    expect(await isLarkOperatorAllowed({ config, operatorOpenId: 'ou_member', service, repository: repo })).toBe(true);
    expect(await isLarkOperatorAllowed({ config, operatorOpenId: 'ou_other', service, repository: repo })).toBe(false);
  });

  it('resolves a name-only allow list through the persistent binding', async () => {
    const repo = repository(); const config = await configured(repo, { allowedUserNames: ['成员'] });
    const service = open(':memory:', { resolveChatUsersByNames: async () => [member('ou_member')] });
    expect(await isLarkOperatorAllowed({ config, operatorOpenId: 'ou_member', service, repository: repo })).toBe(true);
    expect((await readLarkConfig(repo, config.appId))?.allowedUsers).toEqual([member('ou_member')]);
  });

  it('honours allowedBots and peerBotsAllowed for directory-less bot operators', async () => {
    // allowedBots 单独存在时不限制人类名单（与消息入口一致），必须叠加一个受限名单才会走到 230001 分支。
    const repo = repository(); const config = await configured(repo, { allowedUsers: [member('ou_member')], allowedBots: [member('ou_bot', '机器人')], peerBotsAllowed: false });
    const service = open(':memory:', { getUserEmails: async () => { throw new LarkServiceError('LARK_OPENAPI_ERROR', 'not in contacts', 502, { upstreamCode: 230001 }); } });
    expect(await isLarkOperatorAllowed({ config, operatorOpenId: 'ou_bot', service, repository: repo })).toBe(true);
    expect(await isLarkOperatorAllowed({ config, operatorOpenId: 'ou_peer', service, repository: repo })).toBe(false);
  });

  it('fails closed for a human missing from the directory even when peer bots are allowed', async () => {
    const repo = repository();
    const config = await configured(repo, { allowedUsers: [member('ou_member')], peerBotsAllowed: true });
    const service = open(':memory:', { getUserEmails: async () => { throw new LarkServiceError('LARK_OPENAPI_ERROR', 'not in contacts', 502, { upstreamCode: 230001 }); } });
    // 230001 在旧实现里直接返回 peerBotsAllowed=true，会把“不在通讯录可见范围的人类”当成 peer bot 放行。
    expect(await isLarkOperatorAllowed({ config, operatorOpenId: 'ou_human', operatorType: 'user', service, repository: repo })).toBe(false);
    expect(await isLarkOperatorAllowed({ config, operatorOpenId: 'ou_unknown', operatorType: 'unknown', service, repository: repo })).toBe(false);
    // 明确是机器人时才走 peerBotsAllowed。
    expect(await isLarkOperatorAllowed({ config, operatorOpenId: 'ou_peer_bot', operatorType: 'bot', service, repository: repo })).toBe(true);
  });

  it('fails closed when operator_type is missing: call sites must declare how the operator was identified', async () => {
    const repo = repository();
    const config = await configured(repo, { allowedUsers: [member('ou_member')], peerBotsAllowed: true });
    const service = open(':memory:', { getUserEmails: async () => { throw new LarkServiceError('LARK_OPENAPI_ERROR', 'not in contacts', 502, { upstreamCode: 230001 }); } });
    // 共享判定层不再有“没传 operator_type 就按 peer bot 放行”的默认分支。
    expect(await isLarkOperatorAllowed({ config, operatorOpenId: 'ou_card_actor', service, repository: repo })).toBe(false);
  });

  it('refuses user_id/union_id identities under a restricted allow list instead of guessing', async () => {
    const repo = repository();
    const config = await configured(repo, { allowedUsers: [member('ou_member')] });
    const emails = vi.fn(async () => ['member@example.com']);
    const service = open(':memory:', { getUserEmails: emails });
    expect(await isLarkOperatorAllowed({ config, operatorOpenId: '12345', operatorType: 'user', operatorIdentity: 'user_id', service, repository: repo })).toBe(false);
    expect(await isLarkOperatorAllowed({ config, operatorOpenId: '12345', operatorType: 'user', operatorIdentity: 'union_id', service, repository: repo })).toBe(false);
    expect(emails).not.toHaveBeenCalled();
    // 事件只有 open_id 时才正常匹配。
    expect(await isLarkOperatorAllowed({ config, operatorOpenId: 'ou_member', operatorType: 'user', operatorIdentity: 'open_id', service, repository: repo })).toBe(true);
  });
});
