import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';
import { AgentDockRuntime } from '@agent-dock/agent-dock-runtime';
import { createRepositories } from '@agent-dock/agent-dock-storage';
import {
  ASK_USER_QUESTION_CONFIG_KEY,
  ASK_USER_QUESTION_XML_TAG,
  BUILTIN_ASK_USER_QUESTION_PLUGIN_ID,
  BUILTIN_CONFIRM_ACTION_PLUGIN_ID,
  CONFIRM_ACTION_INTERACTION_ORIGIN,
  CONFIRM_ACTION_XML_TAG,
  declarativePluginInteractionOrigin,
  parseConfirmActionInteraction,
  parseDeclarativeInteraction,
  type ChannelMapping,
  type ChannelMappingRepository,
  type ConfigRepository,
  type DeclarativeOutputPluginManifest,
  type Session,
  type TaskRecord
} from '@agent-dock/agent-dock-shared';
import { AskUserQuestionService, registerAskUserQuestionRoutes } from '../ask-user-question.js';
import { buildApp } from '../app.js';
import { sessionTokenAllows } from '../web-access.js';
import { OutputPluginService, registerOutputPluginRoutes } from './service.js';

function createMemoryConfig(): ConfigRepository {
  const store = new Map<string, string>();
  return {
    get: async key => store.get(key),
    set: async (key, value) => { store.set(key, value); }
  };
}

function createMemoryChannelMappings(): ChannelMappingRepository {
  const rows = new Map<string, ChannelMapping>();
  return {
    get: async (channel, externalId) => rows.get(`${channel}:${externalId}`),
    list: async channel => [...rows.values()].filter(row => row.channel === channel),
    save: async mapping => { rows.set(`${mapping.channel}:${mapping.externalId}`, mapping); }
  };
}

const makeSession = (overrides: Partial<Session> = {}): Session => ({
  id: 'ses_1',
  agentId: 'codex',
  state: 'completed',
  cwd: '/tmp',
  runId: 'run_1',
  createdAt: '2026-11-27T00:00:00.000Z',
  updatedAt: '2026-11-27T00:00:00.000Z',
  ...overrides
});

const approvalManifest: DeclarativeOutputPluginManifest = {
  id: 'local:deploy-approval',
  name: '发布审批卡',
  description: '生产发布前一键确认或驳回。',
  icon: 'shield-check',
  tagName: 'agentdock-deploy-approval',
  version: '1.2.0',
  defaultEnabled: false,
  kind: 'action-card',
  card: {
    accentTone: 'amber',
    headerTitle: '生产发布确认',
    allowNote: true,
    actions: [
      { value: 'approve', label: '确认发布', style: 'primary' },
      { value: 'cancel', label: '取消', style: 'danger' }
    ]
  }
};

describe('OutputPluginService & local declarative plugin loader', () => {
  it('loads local declarative JSON plugins, reports malformed manifests cleanly, and supports hot reload', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'agentdock-outp-local-'));
    try {
      writeFileSync(join(dir, 'deploy-approval.json'), JSON.stringify(approvalManifest, null, 2));
      writeFileSync(join(dir, 'broken.json'), '{ not valid json');
      writeFileSync(join(dir, 'bad-tag.json'), JSON.stringify({
        ...approvalManifest,
        id: 'local:bad-tag',
        tagName: 'div'
      }));

      const config = createMemoryConfig();
      const service = new OutputPluginService({ config, localPluginsDir: dir });

      const catalog = await service.catalog();
      expect(catalog.localDir).toBe(dir);
      expect(catalog.localDirExists).toBe(true);
      expect(catalog.plugins.map(p => p.id)).toEqual([
        BUILTIN_ASK_USER_QUESTION_PLUGIN_ID,
        BUILTIN_CONFIRM_ACTION_PLUGIN_ID,
        'local:deploy-approval'
      ]);
      expect(catalog.plugins.find(p => p.id === BUILTIN_ASK_USER_QUESTION_PLUGIN_ID)?.globalEnabled).toBe(true);
      expect(catalog.plugins.find(p => p.id === BUILTIN_CONFIRM_ACTION_PLUGIN_ID)?.globalEnabled).toBe(true);
      expect(catalog.plugins.find(p => p.id === 'local:deploy-approval')?.globalEnabled).toBe(false);
      expect(catalog.warnings).toHaveLength(2);
      expect(catalog.warnings.some(w => w.file === 'broken.json')).toBe(true);
      expect(catalog.warnings.some(w => w.file === 'bad-tag.json')).toBe(true);

      // 热重载：添加新 info-card 并修复坏文件
      writeFileSync(join(dir, 'release-info.json'), JSON.stringify({
        id: 'local:release-info',
        name: '产物摘要卡',
        description: '展示构建产物摘要',
        icon: 'file-text',
        tagName: 'agentdock-release-info',
        version: '1.0.0',
        defaultEnabled: true,
        kind: 'info-card'
      }));
      rmSync(join(dir, 'broken.json'));
      rmSync(join(dir, 'bad-tag.json'));

      const reloaded = await service.reloadAndCatalog();
      expect(reloaded.warnings).toEqual([]);
      expect(reloaded.plugins.map(p => p.id)).toEqual([
        BUILTIN_ASK_USER_QUESTION_PLUGIN_ID,
        BUILTIN_CONFIRM_ACTION_PLUGIN_ID,
        'local:deploy-approval',
        'local:release-info'
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('migrates legacy ask_user_question.config and keeps legacy + unified APIs strictly in sync', async () => {
    const config = createMemoryConfig();
    await config.set(ASK_USER_QUESTION_CONFIG_KEY, JSON.stringify({ askUserQuestionXmlEnabled: false }));

    const outputPlugins = new OutputPluginService({ config, disableLocalPlugins: true });
    const askFacade = new AskUserQuestionService({ config, outputPlugins });

    // 启动即无缝继承旧库 askUserQuestionXmlEnabled=false
    const initialCatalog = await outputPlugins.catalog();
    expect(initialCatalog.configured).toBe(true);
    expect(initialCatalog.config.plugins[BUILTIN_ASK_USER_QUESTION_PLUGIN_ID]).toBe(false);
    expect(await askFacade.isEnabled()).toBe(false);

    // 通过统一插件接口开启后，旧 AskUserQuestion 接口同步感知
    await outputPlugins.saveGlobalConfig({ plugins: { 'ask-user-question': true } });
    expect(await askFacade.isEnabled()).toBe(true);
    expect((await askFacade.state()).config.askUserQuestionXmlEnabled).toBe(true);

    // 通过旧 AskUserQuestion 接口关闭后，统一插件接口同样同步感知
    await askFacade.save({ askUserQuestionXmlEnabled: false });
    const afterLegacy = await outputPlugins.catalog();
    expect(afterLegacy.config.plugins[BUILTIN_ASK_USER_QUESTION_PLUGIN_ID]).toBe(false);
  });

  it('injects prompts strictly on-demand per enabled plugin and sends one-shot disabled notice when turned off', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'agentdock-outp-prompt-'));
    try {
      writeFileSync(join(dir, 'deploy-approval.json'), JSON.stringify(approvalManifest, null, 2));
      const config = createMemoryConfig();
      const service = new OutputPluginService({ config, localPluginsDir: dir });

      // 默认启用内置 ask-user-question 与 confirm-action；local:deploy-approval 默认关闭不消耗 Token
      const session = makeSession({ id: 'ses_prompt_1' });
      const turn1 = await service.promptForSession(session, '帮我部署');
      expect(turn1).toContain(`<${ASK_USER_QUESTION_XML_TAG}`);
      expect(turn1).toContain(`<${CONFIRM_ACTION_XML_TAG}`);
      expect(turn1).not.toContain('<agentdock-deploy-approval');

      // 次轮已注入过不再重复
      expect(await service.promptForSession(session, '继续')).toBe('继续');

      // 会话级开启 local:deploy-approval，同时关闭 builtin:ask-user-question
      const toggledSession = makeSession({
        id: 'ses_prompt_1',
        outputPlugins: {
          [BUILTIN_ASK_USER_QUESTION_PLUGIN_ID]: false,
          'local:deploy-approval': true
        }
      });
      const turn3 = await service.promptForSession(toggledSession, '准备发布');
      expect(turn3).toContain('用户询问卡片协议已关闭');
      expect(turn3).toContain('<agentdock-deploy-approval');
      expect(turn3.endsWith('准备发布')).toBe(true);

      // 再次关闭 local:deploy-approval，下发一次停用提醒后恢复裸 prompt
      const turn4 = await service.promptForSession(
        makeSession({
          id: 'ses_prompt_1',
          outputPlugins: {
            [BUILTIN_ASK_USER_QUESTION_PLUGIN_ID]: false,
            'local:deploy-approval': false
          }
        }),
        '取消发布'
      );
      expect(turn4).toContain('交互插件「发布审批卡」已关闭');
      expect(await service.promptForSession(
        makeSession({
          id: 'ses_prompt_1',
          outputPlugins: {
            [BUILTIN_ASK_USER_QUESTION_PLUGIN_ID]: false,
            'local:deploy-approval': false
          }
        }),
        '下一轮'
      )).toBe('下一轮');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('handles HTTP routes, idempotent declarative interaction submission, session token rules, and session outputPlugins config PATCH', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'agentdock-outp-http-'));
    try {
      writeFileSync(join(dir, 'deploy-approval.json'), JSON.stringify(approvalManifest, null, 2));
      const config = createMemoryConfig();
      const channelMappings = createMemoryChannelMappings();
      const tasks: TaskRecord[] = [];
      const baseSession = makeSession({ id: 'ses_1' });
      const runtime: any = {
        getSession: vi.fn(async (id: string) => (id === 'ses_1' ? baseSession : undefined)),
        getTasks: vi.fn(async () => tasks),
        dispatch: vi.fn(async (sessionId: string, prompt: string, _mode?: string, agentPrompt?: string, _risk?: unknown, origin?: string) => {
          const rec: TaskRecord = {
            id: `task_${tasks.length + 1}`,
            sessionId,
            prompt,
            sentPrompt: agentPrompt,
            status: 'queued',
            origin: origin ?? null,
            createdAt: '2026-11-27T00:01:00.000Z',
            updatedAt: '2026-11-27T00:01:00.000Z'
          };
          tasks.push(rec);
          return { ...rec, queuedAhead: 0 };
        }),
        start: vi.fn(async (input: Record<string, unknown>) => ({ ...baseSession, ...input })),
        setModel: vi.fn(async () => baseSession),
        setReasoningEffort: vi.fn(async () => baseSession),
        setOutputPlugins: vi.fn(async (_id: string, patch: Record<string, boolean | null>) => ({ ...baseSession, outputPlugins: patch })),
        setAskUserQuestionEnabled: vi.fn(async (_id: string, enabled: boolean | null) => ({ ...baseSession, askUserQuestionEnabled: enabled })),
        getSessionConfigOptions: vi.fn(() => undefined)
      };

      const outputPlugins = new OutputPluginService({ config, channelMappings, runtime, localPluginsDir: dir });
      const askUserQuestion = new AskUserQuestionService({ config, channelMappings, runtime, outputPlugins });
      const app = await buildApp(runtime, { outputPlugins, askUserQuestion });
      try {
        const listRes = await app.inject({ method: 'GET', url: '/api/output-plugins' });
        expect(listRes.statusCode).toBe(200);
        expect(listRes.json().plugins.map((p: any) => p.id)).toEqual([
          BUILTIN_ASK_USER_QUESTION_PLUGIN_ID,
          BUILTIN_CONFIRM_ACTION_PLUGIN_ID,
          'local:deploy-approval'
        ]);

        // 内置插件 #2（confirm-action）支持短别名路由、补充意见与 409 幂等防重
        const confirmRes = await app.inject({
          method: 'POST',
          url: '/api/sessions/ses_1/output-plugins/confirm-action/interact',
          payload: {
            instanceId: 'confirm_prod_1',
            title: '生产发布确认',
            risk: 'high',
            decision: 'confirm',
            decisionLabel: '确认执行',
            comment: '先灰度 1 个节点'
          }
        });
        expect(confirmRes.statusCode).toBe(202);
        expect(confirmRes.json().pluginId).toBe(BUILTIN_CONFIRM_ACTION_PLUGIN_ID);
        expect(tasks).toHaveLength(1);
        expect(tasks[0]!.origin).toBe(CONFIRM_ACTION_INTERACTION_ORIGIN);
        expect(parseConfirmActionInteraction(tasks[0]!.prompt)).toMatchObject({
          actionId: 'confirm_prod_1',
          decision: 'confirm',
          comment: '先灰度 1 个节点'
        });
        const confirmDupRes = await app.inject({
          method: 'POST',
          url: '/api/sessions/ses_1/output-plugins/builtin%3Aconfirm-action/interact',
          payload: {
            instanceId: 'confirm_prod_1',
            decision: 'cancel',
            decisionLabel: '取消'
          }
        });
        expect(confirmDupRes.statusCode).toBe(409);
        expect(confirmDupRes.json().alreadySubmitted).toBe(true);
        expect(tasks).toHaveLength(1);

        const putRes = await app.inject({
          method: 'PUT',
          url: '/api/output-plugins/config',
          payload: { plugins: { 'local:deploy-approval': true } }
        });
        expect(putRes.statusCode).toBe(200);
        expect(putRes.json().config.plugins['local:deploy-approval']).toBe(true);

        // 声明式插件交互提交 + 幂等防重
        const interactRes = await app.inject({
          method: 'POST',
          url: '/api/sessions/ses_1/output-plugins/local%3Adeploy-approval/interact',
          payload: {
            instanceId: 'rel_100',
            title: '生产发布 v0.4.0',
            actionValue: 'approve',
            actionLabel: '确认发布',
            note: '先发灰度'
          }
        });
        expect(interactRes.statusCode).toBe(202);
        expect(interactRes.json().accepted).toBe(true);
        expect(tasks).toHaveLength(2);
        expect(tasks[1]!.origin).toBe(declarativePluginInteractionOrigin('local:deploy-approval'));
        expect(parseDeclarativeInteraction(tasks[1]!.prompt)?.actionValue).toBe('approve');

        const dupRes = await app.inject({
          method: 'POST',
          url: '/api/sessions/ses_1/output-plugins/local%3Adeploy-approval/interact',
          payload: {
            instanceId: 'rel_100',
            actionValue: 'cancel',
            actionLabel: '取消'
          }
        });
        expect(dupRes.statusCode).toBe(409);
        expect(dupRes.json().alreadySubmitted).toBe(true);
        expect(tasks).toHaveLength(2);

        // POST /api/sessions 与 PATCH /api/sessions/:id/config 支持 outputPlugins 且不触碰 setModel
        const createRes = await app.inject({
          method: 'POST',
          url: '/api/sessions',
          payload: { agentId: 'codex', outputPlugins: { 'local:deploy-approval': true } }
        });
        expect(createRes.statusCode).toBe(200);
        expect(runtime.start).toHaveBeenCalledWith(expect.objectContaining({
          outputPlugins: { 'local:deploy-approval': true }
        }));

        const patchRes = await app.inject({
          method: 'PATCH',
          url: '/api/sessions/ses_1/config',
          payload: { outputPlugins: { 'local:deploy-approval': false, [BUILTIN_ASK_USER_QUESTION_PLUGIN_ID]: null } }
        });
        expect(patchRes.statusCode).toBe(200);
        expect(runtime.setOutputPlugins).toHaveBeenCalledWith('ses_1', {
          'local:deploy-approval': false,
          [BUILTIN_ASK_USER_QUESTION_PLUGIN_ID]: null
        });
        expect(runtime.setModel).not.toHaveBeenCalled();

        // 会话级 token 权限校验：允许读 /api/output-plugins 与本会话 interact，禁止改全局配置与 reload
        expect(sessionTokenAllows('GET', '/api/output-plugins', 'ses_1')).toBe(true);
        expect(sessionTokenAllows('PUT', '/api/output-plugins/config', 'ses_1')).toBe(false);
        expect(sessionTokenAllows('POST', '/api/output-plugins/reload', 'ses_1')).toBe(false);
        expect(sessionTokenAllows('POST', '/api/sessions/ses_1/output-plugins/local:deploy-approval/interact', 'ses_1')).toBe(true);
      } finally {
        await app.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('keeps standalone registerOutputPluginRoutes and registerAskUserQuestionRoutes sharing the same OutputPluginService', async () => {
    const config = createMemoryConfig();
    const outputPlugins = new OutputPluginService({ config, disableLocalPlugins: true });
    const askFacade = new AskUserQuestionService({ config, outputPlugins });
    const app = Fastify();
    registerOutputPluginRoutes(app, outputPlugins);
    registerAskUserQuestionRoutes(app, askFacade);
    try {
      const r1 = await app.inject({
        method: 'PUT',
        url: '/api/output-plugins/config',
        payload: { plugins: { [BUILTIN_ASK_USER_QUESTION_PLUGIN_ID]: false } }
      });
      expect(r1.statusCode).toBe(200);
      const r2 = await app.inject({ method: 'GET', url: '/api/ask-user-question/config' });
      expect(r2.json()).toEqual({ configured: true, config: { askUserQuestionXmlEnabled: false } });
    } finally {
      await app.close();
    }
  });

  it('isolates per-session outputPlugins overrides across two sessions and global defaults end-to-end', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'agentdock-outp-isolation-'));
    const repos = createRepositories(join(dir, 'test.sqlite'));
    const driver = {
      start: vi.fn(async () => {}),
      send: vi.fn(async () => {}),
      interrupt: vi.fn(async () => {}),
      resume: vi.fn(async () => {}),
      stop: vi.fn(async () => {}),
      setModel: vi.fn(async () => {}),
      setReasoningEffort: vi.fn(async () => {}),
      setPermissionMode: vi.fn()
    };
    const runtime = new AgentDockRuntime(repos, {
      probe: () => ({ protocol: 'acp', available: true, pause: false, resume: true }),
      driverFactory: () => driver
    });
    await runtime.initialize([{
      id: 'mock',
      name: 'Mock Agent',
      command: 'mock',
      args: [],
      protocol: 'acp',
      env: {},
      permissionMode: 'full-trust',
      timeout: 30,
      capabilities: { pause: false, resume: false },
      builtin: true
    }]);
    const outputPlugins = new OutputPluginService({
      config: repos.config,
      channelMappings: repos.channelMappings,
      runtime,
      disableLocalPlugins: true
    });
    const app = await buildApp(runtime, { outputPlugins });
    try {
      const sesA = await runtime.start({ agentId: 'mock', cwd: dir });
      const sesB = await runtime.start({ agentId: 'mock', cwd: dir });

      // 初始状态：会话 A、会话 B 均继承全局默认（2/2 启用）
      const initialCatalog = (await app.inject({ method: 'GET', url: '/api/output-plugins' })).json();
      expect(initialCatalog.config.plugins[BUILTIN_ASK_USER_QUESTION_PLUGIN_ID]).toBe(true);
      expect(initialCatalog.config.plugins[BUILTIN_CONFIRM_ACTION_PLUGIN_ID]).toBe(true);

      // 会话 A 单独关闭 ConfirmAction（通过会话级 PATCH /api/sessions/:id/config）
      const patchARes = await app.inject({
        method: 'PATCH',
        url: `/api/sessions/${sesA.id}/config`,
        payload: { outputPlugins: { [BUILTIN_CONFIRM_ACTION_PLUGIN_ID]: false } }
      });
      expect(patchARes.statusCode).toBe(200);
      const updatedA = patchARes.json() as Session;
      expect(updatedA.outputPlugins).toEqual({ [BUILTIN_CONFIRM_ACTION_PLUGIN_ID]: false });

      // 会话 B 与全局默认配置 100% 不受影响
      const freshB = await runtime.getSession(sesB.id);
      expect(freshB?.outputPlugins).toBeUndefined();
      const catalogAfterA = (await app.inject({ method: 'GET', url: '/api/output-plugins' })).json();
      expect(catalogAfterA.config.plugins[BUILTIN_CONFIRM_ACTION_PLUGIN_ID]).toBe(true);

      // 按需提示词注入同样严格按会话隔离
      const enabledA = await outputPlugins.enabledPluginIdsForSession(updatedA);
      const enabledB = await outputPlugins.enabledPluginIdsForSession(freshB);
      expect([...enabledA]).toEqual([BUILTIN_ASK_USER_QUESTION_PLUGIN_ID]);
      expect([...enabledB].sort()).toEqual([
        BUILTIN_ASK_USER_QUESTION_PLUGIN_ID,
        BUILTIN_CONFIRM_ACTION_PLUGIN_ID
      ].sort());

      const promptA = await outputPlugins.promptForSession(updatedA, '执行任务 A');
      const promptB = await outputPlugins.promptForSession(freshB!, '执行任务 B');
      expect(promptA).toContain(`<${ASK_USER_QUESTION_XML_TAG}`);
      expect(promptA).not.toContain(`<${CONFIRM_ACTION_XML_TAG}`);
      expect(promptB).toContain(`<${ASK_USER_QUESTION_XML_TAG}`);
      expect(promptB).toContain(`<${CONFIRM_ACTION_XML_TAG}`);

      // 修改全局默认关闭 ask-user-question，但会话 A 显式覆写开启 ask-user-question：
      // 会话 A 不被全局覆写强行覆盖，会话 B（无覆写）自动跟随全局关闭
      await app.inject({
        method: 'PATCH',
        url: `/api/sessions/${sesA.id}/config`,
        payload: { outputPlugins: { [BUILTIN_ASK_USER_QUESTION_PLUGIN_ID]: true } }
      });
      await app.inject({
        method: 'PUT',
        url: '/api/output-plugins/config',
        payload: { plugins: { [BUILTIN_ASK_USER_QUESTION_PLUGIN_ID]: false } }
      });
      const reloadedA = await runtime.getSession(sesA.id);
      const reloadedB = await runtime.getSession(sesB.id);
      expect(await outputPlugins.isPluginEnabledForSession(BUILTIN_ASK_USER_QUESTION_PLUGIN_ID, reloadedA)).toBe(true);
      expect(await outputPlugins.isPluginEnabledForSession(BUILTIN_ASK_USER_QUESTION_PLUGIN_ID, reloadedB)).toBe(false);

      // 会话 A 一键恢复跟随全局默认
      const resetARes = await app.inject({
        method: 'PATCH',
        url: `/api/sessions/${sesA.id}/config`,
        payload: {
          outputPlugins: {
            [BUILTIN_ASK_USER_QUESTION_PLUGIN_ID]: null,
            [BUILTIN_CONFIRM_ACTION_PLUGIN_ID]: null
          }
        }
      });
      expect(resetARes.statusCode).toBe(200);
      const resetA = resetARes.json() as Session;
      expect(resetA.outputPlugins).toBeUndefined();
      expect(await outputPlugins.isPluginEnabledForSession(BUILTIN_ASK_USER_QUESTION_PLUGIN_ID, resetA)).toBe(false);
      expect(await outputPlugins.isPluginEnabledForSession(BUILTIN_CONFIRM_ACTION_PLUGIN_ID, resetA)).toBe(true);
    } finally {
      await app.close();
      await runtime.shutdown();
      repos.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
