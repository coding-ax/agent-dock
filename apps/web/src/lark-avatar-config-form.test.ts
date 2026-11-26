import { describe, expect, it } from 'vitest';
import {
  buildLarkAvatarAgentOptions,
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
