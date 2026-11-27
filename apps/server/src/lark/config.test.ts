import { afterEach, describe, expect, it } from 'vitest';
import { createRepositories } from '@agent-dock/agent-dock-storage';
import type { RepositoryBundle } from '@agent-dock/agent-dock-shared';
import { publicLarkConfigs, readLarkConfig, saveLarkConfig, type SaveLarkConfigInput } from './config.js';

const bundles: RepositoryBundle[] = [];
const repository = () => { const bundle = createRepositories(':memory:'); bundles.push(bundle); return bundle.config; };
async function configured(repo: ReturnType<typeof repository>, input: SaveLarkConfigInput = {}) {
  return (await saveLarkConfig(repo, undefined, { appId: 'cli_test', appSecret: 'secret', ...input }))[0]!;
}
afterEach(() => bundles.splice(0).forEach(bundle => bundle.close()));

const avatar = 'https://s1-imfile.feishucdn.com/static-resource/v1/v3_00141_example';

describe('Lark bot avatar', () => {
  // StoredLarkConfig 的读写都是逐字段重建的字面量，漏列一处就会静默丢字段。
  it('survives a storage round trip and reaches the public projection', async () => {
    const repo = repository();
    await configured(repo, { avatarUrl: avatar });
    expect((await readLarkConfig(repo, 'cli_test'))?.avatarUrl).toBe(avatar);
    const { bots } = publicLarkConfigs([(await readLarkConfig(repo, 'cli_test'))!]);
    expect(bots[0]?.avatarUrl).toBe(avatar);
  });

  it('is preserved by later saves that do not carry an avatar', async () => {
    const repo = repository();
    await configured(repo, { avatarUrl: avatar });
    // 典型的非头像保存路径：只改 Agent 相关配置。
    await configured(repo, { originalAppId: 'cli_test', defaultAgentId: undefined, gateEnabled: true, hookTrustConfirmed: true });
    expect((await readLarkConfig(repo, 'cli_test'))?.avatarUrl).toBe(avatar);
  });

  it('is replaced when a save carries a fresh avatar and cleared by an empty one', async () => {
    const repo = repository();
    await configured(repo, { avatarUrl: avatar });
    await configured(repo, { originalAppId: 'cli_test', avatarUrl: 'https://example.com/new.png' });
    expect((await readLarkConfig(repo, 'cli_test'))?.avatarUrl).toBe('https://example.com/new.png');
    await configured(repo, { originalAppId: 'cli_test', avatarUrl: '' });
    expect((await readLarkConfig(repo, 'cli_test'))?.avatarUrl).toBeUndefined();
  });

  it('omits the field entirely when the bot has never been inspected', async () => {
    const repo = repository();
    await configured(repo);
    const { bots } = publicLarkConfigs([(await readLarkConfig(repo, 'cli_test'))!]);
    expect(bots[0]).not.toHaveProperty('avatarUrl');
  });
});

describe('Lark bot groupSessionScope default & persistence', () => {
  it('defaults newly created bots to chat (全群共享) and allows switching cleanly back to user', async () => {
    const repo = repository();
    const created = await configured(repo);
    expect(created.groupSessionScope).toBe('chat');

    // 允许从全群共享切回按发送人隔离（修复旧实现仅认 chat 导致切不回 user 的 bug）
    const switchedToUser = await configured(repo, { originalAppId: 'cli_test', groupSessionScope: 'user' });
    expect(switchedToUser.groupSessionScope).toBe('user');

    // 未显式传 groupSessionScope 的后续保存应保留已存的 user
    const keptUser = await configured(repo, { originalAppId: 'cli_test', preInjectPrompt: 'hello' });
    expect(keptUser.groupSessionScope).toBe('user');
  });

  it('keeps legacy stored bots missing groupSessionScope backwards-compatible as user', async () => {
    const repo = repository();
    await repo.set('lark.bots', JSON.stringify([{ appId: 'cli_legacy', appSecret: 'secret' }]));
    const loaded = await readLarkConfig(repo, 'cli_legacy');
    expect(loaded?.groupSessionScope).toBe('user');
  });
});
