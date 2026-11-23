import { describe, expect, it } from 'vitest';
import type { Agent, Session, SideChatConfig } from './api';
import type { PaneTab } from './store';
import {
  DEFAULT_SIDE_CHAT_CONFIG,
  findReusableSideChatSession,
  matchSideChatTrigger,
  parseBtwCommand,
  resolveSideChatStartOptions,
  sideChatBuiltinCommand
} from './side-chat-config';

function makeSession(overrides: Partial<Session> & { id: string }): Session {
  return {
    agentId: 'claude',
    state: 'idle',
    cwd: '/repo',
    runId: 'run_1',
    createdAt: '2026-11-23T08:00:00Z',
    updatedAt: '2026-11-23T08:00:00Z',
    ...overrides
  };
}

const agents: Pick<Agent, 'id' | 'disabled'>[] = [
  { id: 'claude' },
  { id: 'codex' },
  { id: 'disabled-one', disabled: true }
];

describe('parseBtwCommand', () => {
  it('匹配裸 /btw 与带问题的 /btw', () => {
    expect(parseBtwCommand('/btw')).toEqual({ matched: true, prompt: '' });
    expect(parseBtwCommand('  /btw   ')).toEqual({ matched: true, prompt: '' });
    expect(parseBtwCommand('/btw 帮我看一下这个报错')).toEqual({ matched: true, prompt: '帮我看一下这个报错' });
    expect(parseBtwCommand('/BTW\n第一行\n第二行')).toEqual({ matched: true, prompt: '第一行\n第二行' });
  });

  it('不误匹配其他斜杠命令或普通文本', () => {
    expect(parseBtwCommand('/btw2 test')).toEqual({ matched: false });
    expect(parseBtwCommand('/plan 帮我规划')).toEqual({ matched: false });
    expect(parseBtwCommand('hello /btw world')).toEqual({ matched: false });
    expect(parseBtwCommand('')).toEqual({ matched: false });
  });

  it('matchSideChatTrigger 与 sideChatBuiltinCommand 支持自定义前缀', () => {
    expect(matchSideChatTrigger('btw: remind 灰度是什么', 'btw:')).toEqual({ matched: true, prompt: 'remind 灰度是什么' });
    expect(matchSideChatTrigger('btw:紧跟正文', 'btw:')).toEqual({ matched: true, prompt: '紧跟正文' });
    expect(sideChatBuiltinCommand('/btw')?.name).toBe('btw');
    expect(sideChatBuiltinCommand('/side')?.name).toBe('side');
    expect(sideChatBuiltinCommand('btw:')).toBeUndefined();
  });
});

describe('resolveSideChatStartOptions', () => {
  const source = makeSession({
    id: 'ses_main',
    agentId: 'claude',
    cwd: '/Users/me/project',
    model: 'claude-sonnet-4-5',
    reasoningEffort: 'medium'
  });

  it('默认配置跟随当前会话的 Agent、模型、思考深度和工作目录', () => {
    const resolved = resolveSideChatStartOptions(source, DEFAULT_SIDE_CHAT_CONFIG, agents);
    expect(resolved.agentId).toBe('claude');
    expect(resolved.cwd).toBe('/Users/me/project');
    expect(resolved.model).toBe('claude-sonnet-4-5');
    expect(resolved.reasoningEffort).toBe('medium');
    expect(resolved.source).toBe('side-chat');
    expect(resolved.sourceId).toBe('ses_main');
    expect(resolved.systemPrompt).toContain('ses_main');
  });

  it('custom_agent 模式使用指定的独立 Agent、模型和思考深度', () => {
    const config: SideChatConfig = {
      targetMode: 'custom_agent',
      agentId: 'codex',
      model: 'gpt-5',
      reasoningEffort: 'high',
      openMode: 'side_pane',
      btwEnabled: true,
      triggerPrefix: '/btw',
      btwSessionReuse: 'new_session'
    };
    const resolved = resolveSideChatStartOptions(source, config, agents);
    expect(resolved.agentId).toBe('codex');
    expect(resolved.cwd).toBe('/Users/me/project');
    expect(resolved.model).toBe('gpt-5');
    expect(resolved.reasoningEffort).toBe('high');
  });

  it('custom_agent 模式未指定模型/思考深度时不错误沿用主会话参数', () => {
    const config: SideChatConfig = {
      targetMode: 'custom_agent',
      agentId: 'codex',
      openMode: 'side_pane',
      btwEnabled: true,
      triggerPrefix: '/btw',
      btwSessionReuse: 'new_session'
    };
    const resolved = resolveSideChatStartOptions(source, config, agents);
    expect(resolved.agentId).toBe('codex');
    expect(resolved.model).toBeUndefined();
    expect(resolved.reasoningEffort).toBeUndefined();
  });

  it('指定的独立 Agent 不可用或已停用时安全回退当前会话', () => {
    const config: SideChatConfig = {
      targetMode: 'custom_agent',
      agentId: 'disabled-one',
      model: 'some-model',
      reasoningEffort: 'low',
      openMode: 'side_pane',
      btwEnabled: true,
      triggerPrefix: '/btw',
      btwSessionReuse: 'new_session'
    };
    const resolved = resolveSideChatStartOptions(source, config, agents);
    expect(resolved.agentId).toBe('claude');
    expect(resolved.model).toBe('claude-sonnet-4-5');
    expect(resolved.reasoningEffort).toBe('medium');
  });
});

describe('findReusableSideChatSession', () => {
  it('优先复用副屏已打开的所属侧边会话，其次复用最近活跃会话', () => {
    const older = makeSession({
      id: 'ses_side_1',
      source: 'side-chat',
      sourceId: 'ses_main',
      updatedAt: '2026-11-23T08:00:00Z'
    });
    const newer = makeSession({
      id: 'ses_side_2',
      source: 'side-chat',
      sourceId: 'ses_main',
      updatedAt: '2026-11-23T09:00:00Z'
    });
    const archived = makeSession({
      id: 'ses_side_archived',
      source: 'side-chat',
      sourceId: 'ses_main',
      archivedAt: '2026-11-23T10:00:00Z',
      updatedAt: '2026-11-23T10:00:00Z'
    });
    const stopped = makeSession({
      id: 'ses_side_stopped',
      source: 'side-chat',
      sourceId: 'ses_main',
      state: 'stopped',
      updatedAt: '2026-11-23T11:00:00Z'
    });
    const otherParent = makeSession({
      id: 'ses_side_other',
      source: 'side-chat',
      sourceId: 'ses_other',
      updatedAt: '2026-11-23T12:00:00Z'
    });

    const sessions = [older, newer, archived, stopped, otherParent];
    expect(findReusableSideChatSession('ses_main', sessions, [])?.id).toBe('ses_side_2');

    const tabs: PaneTab[] = [
      { id: 'side-chat:ses_side_1', kind: 'side-chat', sessionId: 'ses_side_1', title: '侧边聊天' }
    ];
    expect(findReusableSideChatSession('ses_main', sessions, tabs)?.id).toBe('ses_side_1');
  });
});
