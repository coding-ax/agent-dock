import { describe, expect, it, vi } from 'vitest';
import {
  handoverGroupName, handoverKittenProfile, larkKittenAvatarPublicUrl, syncKittenBotProfile,
  type HandoverCatLike
} from './kitten-handover.js';
import { LarkServiceError } from './service.js';

const lineage: HandoverCatLike[] = [
  { id: 'acat_old', familyId: 'fam_main', generation: 1, sessionId: 'ses_old', name: '小A同学', state: 'retired' },
  { id: 'acat_new', familyId: 'fam_main', generation: 2, sessionId: 'ses_new', name: '小B同学', state: 'active' },
  { id: 'acat_side', familyId: 'fam_other', generation: 1, sessionId: 'ses_side', name: '别的猫', state: 'active' }
];

describe('handover kitten profile', () => {
  it('recognizes a main-session lineage record and follows it to the active generation', () => {
    expect(handoverKittenProfile(lineage, 'ses_new')).toMatchObject({
      isMain: true, name: '小B同学', generation: 2, sessionId: 'ses_new', avatarUrl: '/api/lark/kitten-avatar.png'
    });
    // 交接后托管群还绑在旧会话上，此时要显示新猫，而不是退休的旧猫。
    expect(handoverKittenProfile(lineage, 'ses_old')).toMatchObject({ name: '小B同学', generation: 2 });
  });

  it('does not treat an ordinary side session as the main kitten', () => {
    expect(handoverKittenProfile(lineage, 'ses_unknown')).toBeUndefined();
    expect(handoverKittenProfile([], 'ses_new')).toBeUndefined();
  });
});

describe('handover naming', () => {
  it('uses the current kitten name for the default group name', () => {
    expect(handoverGroupName({ kitten: { name: '小A同学' }, title: '/Users/me/photo.png', agentId: 'claude' })).toBe('小A同学 · AgentDock');
    // 非主会话保持原行为：清洗会话标题，再退回 Agent 名。
    expect(handoverGroupName({ kitten: null, title: '发布讨论', agentId: 'claude' })).toBe('发布讨论 · AgentDock');
    expect(handoverGroupName({ kitten: null, title: '/Users/me/photo.png', agentId: 'codex' })).toBe('codex · AgentDock');
  });

  it('builds the public avatar URL from the explicit CDN prefix, then webBaseUrl', () => {
    expect(larkKittenAvatarPublicUrl({ cdnBaseUrl: 'https://cdn.example.com/', webBaseUrl: 'https://dock.example.com' }))
      .toBe('https://cdn.example.com/api/lark/kitten-avatar.png');
    expect(larkKittenAvatarPublicUrl({ webBaseUrl: 'https://dock.example.com/' }))
      .toBe('https://dock.example.com/api/lark/kitten-avatar.png');
    expect(larkKittenAvatarPublicUrl({})).toBeUndefined();
  });
});

describe('sync kitten bot profile', () => {
  it('updates both the bot name and avatar to the active kitten', async () => {
    const updateAppBase = vi.fn(async () => undefined);
    const result = await syncKittenBotProfile({
      lineage, sessionId: 'ses_old', bot: { updateAppBase }, avatarUrl: 'https://dock.example.com/api/lark/kitten-avatar.png'
    });

    expect(updateAppBase).toHaveBeenCalledWith({ name: '小B同学', avatarUrl: 'https://dock.example.com/api/lark/kitten-avatar.png' });
    expect(result).toMatchObject({ ok: true, supported: true, updated: true, name: '小B同学', generation: 2, avatarUpdated: true });
    expect(result.message).toContain('第 2 代「小B同学」');
  });

  it('updates the name but explains how to fix the avatar when no public URL is configured', async () => {
    const updateAppBase = vi.fn(async () => undefined);
    const result = await syncKittenBotProfile({ lineage, sessionId: 'ses_new', bot: { updateAppBase } });

    expect(updateAppBase).toHaveBeenCalledWith({ name: '小B同学' });
    expect(result).toMatchObject({ ok: true, updated: true, avatarUpdated: false });
    expect(result.message).toContain('AGENTDOCK_LARK_CDN_BASE_URL');
  });

  it('returns an explicit manual instruction for a non-main session instead of silently doing nothing', async () => {
    const updateAppBase = vi.fn(async () => undefined);
    const result = await syncKittenBotProfile({ lineage, sessionId: 'ses_unknown', bot: { updateAppBase } });

    expect(updateAppBase).not.toHaveBeenCalled();
    expect(result).toMatchObject({ ok: false, supported: false, updated: false, reason: 'NOT_MAIN_SESSION' });
    expect(result.message).toContain('手动');
  });

  it('reports permission/manual-bot limitations with the reason and where to fix it', async () => {
    const updateAppBase = vi.fn(async () => {
      throw new LarkServiceError('LARK_OPENAPI_ERROR', 'no permission', 502, { upstreamCode: 99991672 });
    });
    const result = await syncKittenBotProfile({ lineage, sessionId: 'ses_new', bot: { updateAppBase } });

    expect(result).toMatchObject({ ok: false, supported: false, updated: false, reason: 'BOT_UPDATE_UNSUPPORTED' });
    expect(result.message).toContain('飞书开放平台');
    expect(result.message).toContain('手动');
  });
});
