import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  BUILTIN_CONFIRM_ACTION_PLUGIN_ID,
  CONFIRM_ACTION_INTERACTION_ORIGIN,
  confirmActionOutputPlugin,
  createDeclarativeOutputPlugin,
  declarativePluginInteractionOrigin,
  parseConfirmActionInteraction,
  parseDeclarativeInteraction,
  type AgentEvent,
  type ChannelMapping,
  type ChannelMappingRepository,
  type ConfigRepository,
  type DeclarativeOutputPluginManifest,
  type Session
} from '@agent-dock/agent-dock-shared';
import { OutputPluginService } from '../../output-plugins/service.js';
import { defaultHighRiskPattern, saveLarkConfig, type StoredLarkConfig } from '../config.js';
import { LarkMessageCoordinator, renderLarkCardElements, type LarkRuntime } from '../listener.js';
import type { LarkCardService } from '../service.js';
import {
  createDefaultLarkOutputPluginAdapterRegistry,
  LARK_CONFIRM_ACTION_COMMENT,
  LARK_CONFIRM_ACTION_DECIDE,
  LARK_OUTPUT_PLUGIN_ACTION_CLICK,
  LARK_OUTPUT_PLUGIN_ACTION_FORM,
  LARK_OUTPUT_PLUGIN_CARD_CHANNEL
} from './index.js';

function createMemoryConfig(): ConfigRepository {
  const store = new Map<string, string>();
  return {
    get: async key => store.get(key),
    set: async (key, value) => { store.set(key, value); }
  };
}

function createMemoryMappings(): ChannelMappingRepository {
  const store = new Map<string, ChannelMapping>();
  return {
    get: async (channel, externalId) => store.get(`${channel}:${externalId}`),
    list: async channel => [...store.values()].filter(row => row.channel === channel),
    save: async mapping => { store.set(`${mapping.channel}:${mapping.externalId}`, mapping); }
  };
}

const baseBotConfig: StoredLarkConfig = {
  appId: 'cli_test_bot',
  appSecret: 'secret_placeholder',
  name: '测试机器人',
  defaultAgentId: 'codex',
  listening: true,
  groupToolsEnabled: false,
  groupToolsAllowSend: false,
  groupSessionScope: 'user',
  pushIntervalMs: 500,
  hideTraceOnComplete: false,
  quietReply: false,
  allowedUsers: [],
  allowedEmails: [],
  allowedBots: [],
  peerBotsAllowed: true,
  highRiskAllowedUsers: [],
  highRiskAllowedEmails: [],
  highRiskPattern: defaultHighRiskPattern,
  gateEnabled: false,
  softGateEnabled: false,
  hardGateEnabled: false,
  hookTrustConfirmed: false,
  preInjectPrompt: '',
  webBaseUrl: 'http://127.0.0.1:4310'
};

const approvalManifest: DeclarativeOutputPluginManifest = {
  id: 'local:deploy-approval',
  name: '发布审批卡',
  description: '生产发布审批',
  icon: 'shield-check',
  tagName: 'agentdock-deploy-approval',
  version: '1.0.0',
  defaultEnabled: true,
  kind: 'action-card',
  card: {
    accentTone: 'amber',
    headerTitle: '生产发布审批',
    allowNote: true,
    actions: [
      { value: 'approve', label: '确认发布', style: 'primary' },
      { value: 'reject', label: '驳回', style: 'danger' }
    ]
  }
};

const envFormManifest: DeclarativeOutputPluginManifest = {
  id: 'local:env-form',
  name: '参数收集卡',
  description: '填写部署参数',
  icon: 'clipboard-list',
  tagName: 'agentdock-env-form',
  version: '1.0.0',
  defaultEnabled: true,
  kind: 'form-card',
  card: {
    accentTone: 'sky',
    submitLabel: '确认提交',
    allowNote: false
  }
};

describe('Lark Output Plugins Adapter Registry & Coordinator integration', () => {
  it('builds Schema 2.0 action-card & form-card and parses callbacks cleanly', () => {
    const adapters = createDefaultLarkOutputPluginAdapterRegistry();
    const approvalPlugin = createDeclarativeOutputPlugin(approvalManifest);
    const formPlugin = createDeclarativeOutputPlugin(envFormManifest);

    const approvalParsed = approvalPlugin.parseOutput(`请确认发布：
<agentdock-deploy-approval id="rel_9" title="发布 v0.4.0">
  <summary>生产集群升级</summary>
  <field label="集群">prod-cn</field>
</agentdock-deploy-approval>`);
    expect(approvalParsed).not.toBeNull();

    const approvalAdapter = adapters.resolve(approvalPlugin)!;
    const card = approvalAdapter.buildCard({
      cardId: 'outpc_1',
      plugin: approvalPlugin,
      spec: approvalParsed!.spec,
      sessionId: 'ses_1',
      webBaseUrl: 'http://127.0.0.1:4310'
    }) as any;
    expect(card.schema).toBe('2.0');
    expect(card.header.template).toBe('orange');
    expect(card.body.elements.some((el: any) => el.tag === 'button' && el.behaviors?.[0]?.value?.action === LARK_OUTPUT_PLUGIN_ACTION_CLICK)).toBe(true);

    const parsedClick = approvalAdapter.parseAction!(
      approvalParsed!.spec,
      LARK_OUTPUT_PLUGIN_ACTION_CLICK,
      { action_value: 'approve' }
    );
    expect(parsedClick).toEqual({
      ok: true,
      interaction: { actionValue: 'approve', actionLabel: '确认发布' }
    });

    // Form card
    const formParsed = formPlugin.parseOutput(`<agentdock-env-form id="f_9" title="配置参数">
  <field name="region" label="区域" type="select" required="true" options="cn:中国,us:美国"/>
  <field name="tag" label="镜像标签" type="text" required="true"/>
</agentdock-env-form>`);
    const formAdapter = adapters.resolve(formPlugin)!;
    const formCard = formAdapter.buildCard({
      cardId: 'outpc_2',
      plugin: formPlugin,
      spec: formParsed!.spec
    }) as any;
    expect(formCard.schema).toBe('2.0');
    expect(formCard.body.elements.some((el: any) => el.tag === 'form')).toBe(true);

    const missingRequired = formAdapter.parseAction!(
      formParsed!.spec,
      LARK_OUTPUT_PLUGIN_ACTION_FORM,
      {},
      { f_0: 'cn', f_1: '' }
    );
    expect(missingRequired.ok).toBe(false);

    const validForm = formAdapter.parseAction!(
      formParsed!.spec,
      LARK_OUTPUT_PLUGIN_ACTION_FORM,
      {},
      { f_0: 'cn', f_1: 'v0.4.0' }
    );
    expect(validForm).toEqual({
      ok: true,
      interaction: {
        actionValue: 'submit',
        actionLabel: '确认提交',
        fields: [
          { name: 'region', label: '区域', value: 'cn', displayValue: '中国' },
          { name: 'tag', label: '镜像标签', value: 'v0.4.0' }
        ]
      }
    });
  });

  it('strips trailing XML in renderLarkCardElements, pushes declarative card, handles callback idempotently, and locks card', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'agentdock-lark-outp-'));
    try {
      writeFileSync(join(dir, 'deploy-approval.json'), JSON.stringify(approvalManifest, null, 2));
      const configRepo = createMemoryConfig();
      await saveLarkConfig(configRepo, undefined, baseBotConfig);
      const mappings = createMemoryMappings();
      const dispatched: Array<{ prompt: string; agentPrompt?: string; origin?: string }> = [];
      const session: Session = {
        id: 'ses_lark_1',
        agentId: 'codex',
        state: 'completed',
        cwd: '/tmp',
        runId: 'run_1',
        createdAt: '2026-11-27T00:00:00.000Z',
        updatedAt: '2026-11-27T00:00:00.000Z'
      };

      const runtime: LarkRuntime = {
        listAgents: vi.fn(async () => []),
        start: vi.fn(async () => session),
        getSession: vi.fn(async () => session),
        send: vi.fn(async () => ({ id: 't1', sessionId: session.id, prompt: '', status: 'completed', createdAt: '', updatedAt: '' })),
        dispatch: vi.fn(async (_id, prompt, _mode, agentPrompt, _risk, origin) => {
          dispatched.push({ prompt, agentPrompt, origin });
          return { id: `task_${dispatched.length}`, sessionId: session.id, prompt, status: 'queued', origin: origin ?? null, createdAt: '', updatedAt: '' };
        }),
        interrupt: vi.fn(async () => undefined),
        subscribe: vi.fn(() => () => undefined)
      };

      const sentCards: Array<Record<string, unknown>> = [];
      const updatedCards: Array<{ messageId: string; card: Record<string, unknown> }> = [];
      const service = {
        send: vi.fn(async () => ({ messageId: 'om_trace_1' })),
        update: vi.fn(async () => ({ messageId: 'om_trace_1' })),
        sendInteractiveCard: vi.fn(async (input: any) => {
          sentCards.push(input.card);
          return { messageId: `om_plugin_${sentCards.length}` };
        }),
        replyInteractiveCard: vi.fn(async (input: any) => {
          sentCards.push(input.card);
          return { messageId: `om_plugin_${sentCards.length}` };
        }),
        updateInteractiveCard: vi.fn(async (input: any) => {
          updatedCards.push({ messageId: input.messageId, card: input.card });
          return { messageId: input.messageId };
        }),
        getUserName: vi.fn(async () => '暮雪离歌'),
        getChat: vi.fn(async () => ({ chatId: 'oc_ops', name: '运维群', userCount: 3 })),
        listChats: vi.fn(async () => ({ items: [], hasMore: false })),
        reply: vi.fn(async () => ({ messageId: 'om_trace_reply_1', chatId: 'oc_ops' }))
      } as unknown as LarkCardService;

      const outputPlugins = new OutputPluginService({
        config: configRepo,
        channelMappings: mappings,
        runtime: runtime as any,
        localPluginsDir: dir
      });

      const events: AgentEvent[] = [{
        id: 'e1',
        sessionId: session.id,
        sequence: 1,
        type: 'text',
        timestamp: '2026-11-27T00:00:01.000Z',
        data: {
          role: 'assistant',
          text: `检查完毕，等待审批。\n\n<agentdock-deploy-approval id="rel_88" title="生产发布"><summary>准备升级</summary></agentdock-deploy-approval>`
        }
      }];

      // renderLarkCardElements 隐藏裸 XML 并展示引导文案
      const rendered = renderLarkCardElements(events, { traceLimit: 50 }, true, false, {
        outputPluginRegistry: outputPlugins.registry,
        enabledOutputPluginIds: new Set(['local:deploy-approval'])
      });
      const finalMd = rendered.find(el => el.element_id === 'final_output')?.content ?? '';
      expect(finalMd).toContain('检查完毕，等待审批。');
      expect(finalMd).not.toContain('<agentdock-deploy-approval');

      const coordinator = new LarkMessageCoordinator(
        runtime,
        service,
        { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
        () => 0,
        'ou_bot',
        undefined,
        mappings,
        configRepo,
        undefined,
        outputPlugins
      );

      const extracted = outputPlugins.registry.parseTrailingOutput(events[0]!.data.text as string);
      const pushed = await coordinator.pushOutputPluginCard({
        config: baseBotConfig,
        sessionId: session.id,
        chatId: 'oc_ops',
        chatType: 'group',
        pluginId: extracted!.pluginId,
        spec: extracted!.spec
      });
      expect(pushed).toBeDefined();
      expect(await mappings.get(LARK_OUTPUT_PLUGIN_CARD_CHANNEL, pushed!.cardId)).toBeDefined();

      // 首次飞书点击回调 -> 派发续跑轮次 + 锁定卡片
      const firstToast = await coordinator.handleAction(
        {
          action: LARK_OUTPUT_PLUGIN_ACTION_CLICK,
          plugin_id: 'local:deploy-approval',
          card_id: pushed!.cardId,
          action_value: 'approve'
        },
        'ou_operator_1'
      );
      expect(firstToast).toEqual({ type: 'success', content: expect.any(String) });
      expect(dispatched).toHaveLength(1);
      expect(dispatched[0]!.origin).toBe(declarativePluginInteractionOrigin('local:deploy-approval'));
      expect(parseDeclarativeInteraction(dispatched[0]!.prompt)?.actionValue).toBe('approve');
      expect(updatedCards).toHaveLength(1);
      expect((updatedCards[0]!.card as any).header.template).toBe('green');

      // 重复点击 -> 幂等拦截，不再派发新轮次
      const dupToast = await coordinator.handleAction(
        {
          action: LARK_OUTPUT_PLUGIN_ACTION_CLICK,
          plugin_id: 'local:deploy-approval',
          card_id: pushed!.cardId,
          action_value: 'reject'
        },
        'ou_operator_1'
      );
      expect(dupToast.type).toBe('info');
      expect(dispatched).toHaveLength(1);

      // 内置插件 #2（builtin:confirm-action）：高风险飞书卡片推送、带补充意见确认回调、锁定更新与幂等防重
      const confirmExtracted = confirmActionOutputPlugin.parseOutput(`请最终拍板：\n\n<agentdock-confirm-action id="drop_old_1" title="清理 90 天前归档表" risk="high" confirm-label="确认清理" cancel-label="取消">\n  <summary>预计释放 12 GB 磁盘</summary>\n  <detail label="目标库">prod-archive</detail>\n  <command>DROP TABLE logs_2025_q1;</command>\n</agentdock-confirm-action>`);
      expect(confirmExtracted).not.toBeNull();
      const confirmAdapter = createDefaultLarkOutputPluginAdapterRegistry().resolve(confirmActionOutputPlugin)!;
      const confirmCard = confirmAdapter.buildCard({
        cardId: 'outpc_confirm_preview',
        plugin: confirmActionOutputPlugin,
        spec: confirmExtracted!.spec,
        sessionId: session.id,
        webBaseUrl: baseBotConfig.webBaseUrl
      }) as any;
      expect(confirmCard.schema).toBe('2.0');
      expect(confirmCard.header.template).toBe('red');
      expect(confirmAdapter.parseAction!(confirmExtracted!.spec, LARK_CONFIRM_ACTION_DECIDE, { decision: 'confirm' })).toEqual({
        ok: true,
        interaction: { decision: 'confirm', decisionLabel: '确认清理', risk: 'high' }
      });

      const pushedConfirm = await coordinator.pushOutputPluginCard({
        config: baseBotConfig,
        sessionId: session.id,
        chatId: 'oc_ops',
        chatType: 'group',
        pluginId: BUILTIN_CONFIRM_ACTION_PLUGIN_ID,
        spec: confirmExtracted!.spec
      });
      expect(pushedConfirm).toBeDefined();

      const confirmToast = await coordinator.handleAction(
        {
          action: LARK_CONFIRM_ACTION_COMMENT,
          plugin_id: BUILTIN_CONFIRM_ACTION_PLUGIN_ID,
          card_id: pushedConfirm!.cardId
        },
        'ou_operator_1',
        { formValue: { decision: 'confirm', comment_text: '请先做快照备份再执行' } }
      );
      expect(confirmToast).toEqual({ type: 'success', content: expect.any(String) });
      expect(dispatched).toHaveLength(2);
      expect(dispatched[1]!.origin).toBe(CONFIRM_ACTION_INTERACTION_ORIGIN);
      expect(parseConfirmActionInteraction(dispatched[1]!.prompt)).toMatchObject({
        actionId: 'drop_old_1',
        decision: 'confirm',
        decisionLabel: '确认清理',
        comment: '请先做快照备份再执行',
        source: 'lark'
      });
      expect((updatedCards.at(-1)!.card as any).header.template).toBe('green');

      const confirmDup = await coordinator.handleAction(
        {
          action: LARK_CONFIRM_ACTION_DECIDE,
          plugin_id: BUILTIN_CONFIRM_ACTION_PLUGIN_ID,
          card_id: pushedConfirm!.cardId,
          decision: 'cancel'
        },
        'ou_operator_1'
      );
      expect(confirmDup.type).toBe('info');
      expect(dispatched).toHaveLength(2);

      coordinator.stop();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
