import { describe, expect, it } from 'vitest';
import { reactionOutcomeLabel, reactionSourceStatus, reactionStateLabel } from './lark-avatar-reaction-diagnostics';

describe('reaction diagnostics labels', () => {
  it('explains every route outcome', () => {
    expect(reactionOutcomeLabel('triggered:main')).toBe('已发到主会话');
    expect(reactionOutcomeLabel('triggered:independent')).toBe('已开独立轮次');
    expect(reactionOutcomeLabel('triggered:private_chat')).toBe('已私密转发到指定会话');
    expect(reactionOutcomeLabel('awaiting_route:ask')).toBe('已发询问卡片，等待选择');
    expect(reactionOutcomeLabel('route:main')).toBe('卡片选择后已执行');
    expect(reactionOutcomeLabel('route:failed')).toBe('卡片选择后执行失败');
  });

  it('explains skip and failure reasons instead of showing a bare code', () => {
    expect(reactionOutcomeLabel('ignored:listening_paused')).toBe('替身监听已暂停');
    expect(reactionOutcomeLabel('ignored:duplicate')).toBe('重复事件，已触发过');
    expect(reactionOutcomeLabel('ignored:bot_reaction')).toBe('机器人/应用添加的表情');
    expect(reactionOutcomeLabel('ignored:chat_not_listened')).toBe('会话不在监听白名单');
    expect(reactionOutcomeLabel('ignored:operator_not_allowed')).toBe('操作人不在机器人白名单');
    expect(reactionOutcomeLabel('ignored:operator_identity_unresolved')).toContain('user_id/union_id');
    expect(reactionOutcomeLabel('failed:permission_denied')).toBe('失败：机器人没有读取消息权限');
    expect(reactionOutcomeLabel('failed:no_main_session')).toBe('失败：还没有主会话');
    expect(reactionOutcomeLabel('failed:private_chat_not_configured')).toBe('失败：未配置私密接收会话');
    expect(reactionOutcomeLabel('failed:private_chat_same_as_target')).toContain('防泄密');
    expect(reactionOutcomeLabel('failed:dispatch_uncertain')).toContain('无法确认');
    expect(reactionOutcomeLabel('something-new')).toBe('something-new');
    expect(reactionOutcomeLabel(undefined)).toBe('未知');
  });

  it('labels ledger states', () => {
    expect(reactionStateLabel('pending')).toBe('处理中');
    expect(reactionStateLabel('dispatching')).toBe('派发中');
    expect(reactionStateLabel('dispatched')).toBe('已派发');
    expect(reactionStateLabel('ignored')).toBe('已跳过');
    expect(reactionStateLabel('failed')).toBe('失败');
    expect(reactionStateLabel('unknown')).toBe('unknown');
  });

  it('explains whether the bot reaction event channel is actually available', () => {
    expect(reactionSourceStatus(undefined)).toMatchObject({ ok: false, label: '事件通道状态未知' });
    expect(reactionSourceStatus({
      botConfigured: true, botEnabled: 1, botAppIds: ['cli_a'], listenerActive: false, activeAppIds: [], listenerDisabled: true
    })).toMatchObject({ ok: false, label: '机器人事件监听已关闭' });
    expect(reactionSourceStatus({
      botConfigured: false, botEnabled: 0, botAppIds: [], listenerActive: false, activeAppIds: [], listenerDisabled: false
    })).toMatchObject({ ok: false, label: '还没有配置飞书机器人' });
    expect(reactionSourceStatus({
      botConfigured: true, botEnabled: 0, botAppIds: ['cli_a'], listenerActive: false, activeAppIds: [], listenerDisabled: false
    })).toMatchObject({ ok: false, label: '没有启用中的飞书机器人' });
    expect(reactionSourceStatus({
      botConfigured: true, botEnabled: 1, botAppIds: ['cli_a'], listenerActive: false, activeAppIds: [], listenerDisabled: false
    })).toMatchObject({ ok: false, label: '机器人监听未连接' });
    expect(reactionSourceStatus({
      botConfigured: true, botEnabled: 1, botAppIds: ['cli_a'], listenerActive: true, activeAppIds: ['cli_a'], listenerDisabled: false
    })).toEqual({ ok: true, label: '机器人事件监听已就绪', detail: '监听中：cli_a' });
  });
});
