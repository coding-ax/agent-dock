import { describe, expect, it } from 'vitest';
import type { AgentConfig, ConfigRepository } from '@agent-dock/agent-dock-shared';
import type { AgentDockRuntime } from '@agent-dock/agent-dock-runtime';
import { buildApp } from './app.js';
import { DEFAULT_SIDE_CHAT_CONFIG, matchSideChatTrigger, SideChatConfigService, sideChatConfigKey } from './side-chat-config.js';
import { sessionTokenAllows } from './web-access.js';

function memoryConfigRepo(initial: Record<string, string> = {}): ConfigRepository {
  const map = new Map(Object.entries(initial));
  return {
    async get(key: string) { return map.get(key); },
    async set(key: string, value: string) { map.set(key, value); }
  };
}

function fakeAgent(id: string, disabled = false): AgentConfig {
  return {
    id,
    name: id,
    command: id,
    args: [],
    protocol: 'acp',
    env: {},
    permissionMode: 'full-trust',
    timeout: 600,
    capabilities: { pause: false, resume: true },
    builtin: true,
    disabled
  };
}

const minimalRuntime = {
  listAgents: async () => [fakeAgent('claude'), fakeAgent('codex'), fakeAgent('disabled-agent', true)],
  listSessions: async () => []
} as unknown as AgentDockRuntime;

describe('SideChatConfigService & routes', () => {
  it('未配置时返回默认配置', async () => {
    const service = new SideChatConfigService({ config: memoryConfigRepo() });
    expect(await service.state()).toEqual({
      configured: false,
      config: DEFAULT_SIDE_CHAT_CONFIG
    });
  });

  it('库里 JSON 损坏或结构不合法时安全回退默认配置', async () => {
    const broken = new SideChatConfigService({ config: memoryConfigRepo({ [sideChatConfigKey]: '{bad-json' }) });
    expect(await broken.state()).toEqual({ configured: false, config: DEFAULT_SIDE_CHAT_CONFIG });

    const invalid = new SideChatConfigService({ config: memoryConfigRepo({ [sideChatConfigKey]: JSON.stringify({ targetMode: 'unknown' }) }) });
    expect(await invalid.state()).toEqual({ configured: false, config: DEFAULT_SIDE_CHAT_CONFIG });
  });

  it('通过 HTTP 读写与重置侧边对话配置', async () => {
    const repo = memoryConfigRepo();
    const agents = [fakeAgent('claude'), fakeAgent('codex'), fakeAgent('disabled-agent', true)];
    const service = new SideChatConfigService({ config: repo, listAgents: () => agents });
    const app = await buildApp(minimalRuntime, { sideChatConfig: service });

    try {
      const initial = await app.inject({ method: 'GET', url: '/api/side-chat/config' });
      expect(initial.statusCode).toBe(200);
      expect(initial.json()).toEqual({ configured: false, config: DEFAULT_SIDE_CHAT_CONFIG });

      const saved = await app.inject({
        method: 'PUT',
        url: '/api/side-chat/config',
        payload: {
          targetMode: 'custom_agent',
          agentId: '  codex  ',
          model: ' gpt-5 ',
          reasoningEffort: ' high ',
          openMode: 'switch_session',
          btwEnabled: true,
          triggerPrefix: '  btw:  ',
          btwSessionReuse: 'reuse_latest'
        }
      });
      expect(saved.statusCode).toBe(200);
      expect(saved.json()).toEqual({
        configured: true,
        config: {
          targetMode: 'custom_agent',
          agentId: 'codex',
          model: 'gpt-5',
          reasoningEffort: 'high',
          openMode: 'switch_session',
          btwEnabled: true,
          triggerPrefix: 'btw:',
          btwSessionReuse: 'reuse_latest'
        }
      });

      const reloaded = await app.inject({ method: 'GET', url: '/api/side-chat/config' });
      expect(reloaded.statusCode).toBe(200);
      expect(reloaded.json()).toEqual(saved.json());

      // 切回 follow_current 时清理独立 Agent 专属覆盖项
      const follow = await app.inject({
        method: 'PUT',
        url: '/api/side-chat/config',
        payload: {
          targetMode: 'follow_current',
          agentId: 'codex',
          model: 'gpt-5',
          reasoningEffort: 'high',
          openMode: 'side_pane',
          btwEnabled: false,
          btwSessionReuse: 'new_session'
        }
      });
      expect(follow.statusCode).toBe(200);
      expect(follow.json()).toEqual({
        configured: true,
        config: {
          targetMode: 'follow_current',
          openMode: 'side_pane',
          btwEnabled: false,
          triggerPrefix: '/btw',
          btwSessionReuse: 'new_session'
        }
      });

      const reset = await app.inject({ method: 'DELETE', url: '/api/side-chat/config' });
      expect(reset.statusCode).toBe(200);
      expect(reset.json()).toEqual({ configured: false, config: DEFAULT_SIDE_CHAT_CONFIG });
    } finally {
      await app.close();
    }
  });

  it('校验失败时返回 400', async () => {
    const repo = memoryConfigRepo();
    const agents = [fakeAgent('claude'), fakeAgent('disabled-agent', true)];
    const service = new SideChatConfigService({ config: repo, listAgents: () => agents });
    const app = await buildApp(minimalRuntime, { sideChatConfig: service });

    try {
      const missingAgent = await app.inject({
        method: 'PUT',
        url: '/api/side-chat/config',
        payload: { targetMode: 'custom_agent', openMode: 'side_pane', btwEnabled: true, btwSessionReuse: 'new_session' }
      });
      expect(missingAgent.statusCode).toBe(400);
      expect(missingAgent.json().error.code).toBe('SIDE_CHAT_AGENT_REQUIRED');

      const disabledAgent = await app.inject({
        method: 'PUT',
        url: '/api/side-chat/config',
        payload: { targetMode: 'custom_agent', agentId: 'disabled-agent', openMode: 'side_pane', btwEnabled: true, btwSessionReuse: 'new_session' }
      });
      expect(disabledAgent.statusCode).toBe(400);
      expect(disabledAgent.json().error.code).toBe('SIDE_CHAT_AGENT_NOT_FOUND');

      const invalidMode = await app.inject({
        method: 'PUT',
        url: '/api/side-chat/config',
        payload: { targetMode: 'invalid_mode' }
      });
      expect(invalidMode.statusCode).toBe(400);
      expect(invalidMode.json().error.code).toBe('INVALID_SIDE_CHAT_CONFIG');
    } finally {
      await app.close();
    }
  });

  it('会话级令牌仅允许只读 /api/side-chat/config，不允许修改或重置', () => {
    expect(sessionTokenAllows('GET', '/api/side-chat/config', 'ses_1')).toBe(true);
    expect(sessionTokenAllows('PUT', '/api/side-chat/config', 'ses_1')).toBe(false);
    expect(sessionTokenAllows('DELETE', '/api/side-chat/config', 'ses_1')).toBe(false);
  });

  it('matchSideChatTrigger 支持默认 /btw 与自定义前缀（如 btw:）', () => {
    expect(matchSideChatTrigger('/btw remind 灰度是什么')).toEqual({ matched: true, prompt: 'remind 灰度是什么' });
    expect(matchSideChatTrigger('/BTW')).toEqual({ matched: true, prompt: '' });
    expect(matchSideChatTrigger('/btw2 xxx')).toEqual({ matched: false });
    expect(matchSideChatTrigger('btw: remind 灰度是什么', 'btw:')).toEqual({ matched: true, prompt: 'remind 灰度是什么' });
    expect(matchSideChatTrigger('BTW:直接紧跟正文', 'btw:')).toEqual({ matched: true, prompt: '直接紧跟正文' });
    expect(matchSideChatTrigger('普通消息 btw: 在中间', 'btw:')).toEqual({ matched: false });
  });
});
