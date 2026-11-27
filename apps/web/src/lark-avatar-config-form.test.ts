import { describe, expect, it } from 'vitest';
import {
  DEFAULT_LARK_AVATAR_REPLY_FORWARD_MODE,
  LARK_AVATAR_REACTION_ROUTE_OPTIONS,
  LARK_AVATAR_REPLY_FORWARD_OPTIONS,
  LARK_AVATAR_REPLY_FORWARD_SUMMARY,
  buildLarkAvatarAgentOptions,
  describeLarkAvatarReplyForwardMode,
  normalizeLarkAvatarReactionRoute,
  normalizeLarkAvatarReplyForwardMode,
  resolveFallbackAgentId,
  resolveSaveAgentId
} from './lark-avatar-config-form';

describe('lark avatar config form agent preservation', () => {
  const agents = [
    { id: 'codex', name: 'Codex' },
    { id: 'claude', name: 'Claude Code' },
    { id: 'trae', name: 'Trae' }
  ];

  it('keeps saved trae instead of falling back to codex on mount when both queries are cached', () => {
    expect(resolveFallbackAgentId({
      currentAgentId: '',
      savedAgentId: 'trae',
      configPending: false,
      agents
    })).toBe('trae');
  });

  it('waits while remote config is still pending instead of pre-filling codex', () => {
    expect(resolveFallbackAgentId({
      currentAgentId: '',
      savedAgentId: undefined,
      configPending: true,
      agents
    })).toBe('');
  });

  it('falls back to the first available agent only when config is loaded and has no saved agentId', () => {
    expect(resolveFallbackAgentId({
      currentAgentId: '',
      savedAgentId: undefined,
      configPending: false,
      agents
    })).toBe('codex');
  });

  it('keeps the user-selected agent after an explicit switch', () => {
    expect(resolveFallbackAgentId({
      currentAgentId: 'claude',
      savedAgentId: 'trae',
      configPending: false,
      agents
    })).toBe('claude');
  });

  it('retains a saved non-default agent option even when absent from the discovered list', () => {
    const options = buildLarkAvatarAgentOptions([{ id: 'codex', name: 'Codex' }], 'trae');
    expect(options).toEqual([
      { value: 'trae', label: 'trae（已保存）', agentId: 'trae' },
      { value: 'codex', label: 'Codex', agentId: 'codex' }
    ]);

    expect(buildLarkAvatarAgentOptions(agents, 'trae')).toEqual([
      { value: 'codex', label: 'Codex', agentId: 'codex' },
      { value: 'claude', label: 'Claude Code', agentId: 'claude' },
      { value: 'trae', label: 'Trae', agentId: 'trae' }
    ]);
  });

  it('falls back to saved agentId on submit when draft agentId is empty', () => {
    expect(resolveSaveAgentId('', 'trae')).toBe('trae');
    expect(resolveSaveAgentId('   ', 'trae')).toBe('trae');
    expect(resolveSaveAgentId('claude', 'trae')).toBe('claude');
  });
});

describe('lark avatar replyForwardMode options and hydration', () => {
  it('exposes the three reply forward modes with clear Chinese labels and comparison summary', () => {
    expect(LARK_AVATAR_REPLY_FORWARD_OPTIONS.map(option => [option.value, option.label])).toEqual([
      ['all', '回复所有 AgentText'],
      ['final_only', '仅回复最终回复'],
      ['none', '不在飞书回复']
    ]);
    expect(LARK_AVATAR_REPLY_FORWARD_SUMMARY).toContain('回复所有 AgentText');
    expect(LARK_AVATAR_REPLY_FORWARD_SUMMARY).toContain('仅回复最终回复');
    expect(LARK_AVATAR_REPLY_FORWARD_SUMMARY).toContain('不在飞书回复');
  });

  it('normalizes legacy/missing/unknown values to default final_only while preserving valid modes', () => {
    expect(DEFAULT_LARK_AVATAR_REPLY_FORWARD_MODE).toBe('final_only');
    expect(normalizeLarkAvatarReplyForwardMode(undefined)).toBe('final_only');
    expect(normalizeLarkAvatarReplyForwardMode(null)).toBe('final_only');
    expect(normalizeLarkAvatarReplyForwardMode('')).toBe('final_only');
    expect(normalizeLarkAvatarReplyForwardMode('invalid')).toBe('final_only');
    expect(normalizeLarkAvatarReplyForwardMode('all')).toBe('all');
    expect(normalizeLarkAvatarReplyForwardMode('final_only')).toBe('final_only');
    expect(normalizeLarkAvatarReplyForwardMode('none')).toBe('none');
  });

  it('describes each replyForwardMode accurately and preserves saved agentId alongside mode switches', () => {
    expect(describeLarkAvatarReplyForwardMode('all').description).toContain('逐条发回飞书');
    expect(describeLarkAvatarReplyForwardMode('final_only').description).toContain('屏蔽中间过程');
    expect(describeLarkAvatarReplyForwardMode('none').description).toContain('不向飞书发送');

    // 切换转发策略并保存时，即便草稿 agentId 尚未水合完成，也不能丢掉已保存的 trae
    expect(resolveSaveAgentId('', 'trae')).toBe('trae');
  });

  it('exposes only supported reaction routes and downgrades legacy private_chat to main', () => {
    expect(LARK_AVATAR_REACTION_ROUTE_OPTIONS.map(option => option.value)).toEqual(['main', 'independent', 'ask']);
    expect(normalizeLarkAvatarReactionRoute('main')).toBe('main');
    expect(normalizeLarkAvatarReactionRoute('independent')).toBe('independent');
    expect(normalizeLarkAvatarReactionRoute('ask')).toBe('ask');
    expect(normalizeLarkAvatarReactionRoute('private_chat')).toBe('main');
    expect(normalizeLarkAvatarReactionRoute(undefined)).toBe('main');
  });
});
