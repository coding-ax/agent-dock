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
