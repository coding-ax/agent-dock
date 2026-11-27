import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  BUILTIN_ASK_USER_QUESTION_PLUGIN_ID,
  BUILTIN_CONFIRM_ACTION_PLUGIN_ID,
  CONFIRM_ACTION_INTERACTION_ORIGIN,
  createDeclarativeOutputPlugin,
  declarativePluginInteractionOrigin,
  outputPluginInstanceKey,
  serializeConfirmActionInteraction,
  type ConfirmActionInteractionPayload,
  type DeclarativeOutputPluginInteractionPayload,
  type DeclarativeOutputPluginManifest,
  type OutputPluginCatalogItem,
  type OutputPluginsCatalogSnapshot
} from '@agent-dock/agent-dock-shared';
import { Composer } from '../Composer';
import { TooltipProvider } from '../HoverTooltip';
import { ActivityPanel, TimelineItem } from '../TimelineItems';
import { detectInjectionTags } from '../bubble-injection';
import {
  EMPTY_DRAFT_COMPOSER_PREFS,
  normalizeDraftComposerPrefs,
  withDraftOutputPluginOverride,
  withoutDraftOutputPluginOverrides
} from '../last-used-prefs';
import { buildTimelineSections, groupTimelineSections, type TimelineEvent } from '../timeline';
import { searchTimeline } from '../timeline-search';
import {
  buildClientOutputPluginRegistry,
  buildFallbackOutputPluginCatalogItems,
  OUTPUT_PLUGINS_QUERY_KEY,
  OutputPluginsCenterPanel,
  resolveSessionEnabledOutputPluginIds
} from './index';

const deployApprovalManifest: DeclarativeOutputPluginManifest = {
  id: 'local:deploy-approval',
  name: '发布审批卡',
  description: '在执行生产发布前请负责人一键确认或取消。',
  icon: 'shield-check',
  tagName: 'agentdock-deploy-approval',
  version: '1.0.0',
  defaultEnabled: false,
  kind: 'action-card',
  card: {
    accentTone: 'amber',
    headerTitle: '生产发布确认',
    allowNote: true,
    notePlaceholder: '可选：审批备注…',
    actions: [
      { value: 'approve', label: '确认发布', style: 'primary' },
      { value: 'cancel', label: '取消发布', style: 'danger' }
    ]
  }
};

const envFormManifest: DeclarativeOutputPluginManifest = {
  id: 'local:env-form',
  name: '部署参数表',
  description: '收集结构化部署参数。',
  icon: 'clipboard-list',
  tagName: 'agentdock-env-form',
  version: '1.0.0',
  defaultEnabled: true,
  kind: 'form-card',
  card: {
    accentTone: 'sky',
    submitLabel: '确认参数',
    allowNote: false
  }
};

const catalogItems: OutputPluginCatalogItem[] = [
  ...buildFallbackOutputPluginCatalogItems(),
  {
    ...createDeclarativeOutputPlugin(deployApprovalManifest),
    promptInstruction: createDeclarativeOutputPlugin(deployApprovalManifest).promptInstruction as string,
    globalEnabled: false
  },
  {
    ...createDeclarativeOutputPlugin(envFormManifest),
    promptInstruction: createDeclarativeOutputPlugin(envFormManifest).promptInstruction as string,
    globalEnabled: true
  }
];

describe('Web Output Plugins system', () => {
  it('hydrates declarative plugins into client registry and renders action-card, form-card, streaming placeholder, locked card & echo turn', () => {
    const registry = buildClientOutputPluginRegistry(catalogItems);
    const enabledIds = resolveSessionEnabledOutputPluginIds(
      catalogItems,
      { plugins: { [BUILTIN_ASK_USER_QUESTION_PLUGIN_ID]: true, 'local:deploy-approval': true, 'local:env-form': true } }
    );

    const actionEvent: TimelineEvent = {
      id: 'a_act',
      sequence: 2,
      type: 'text',
      timestamp: '2026-11-27T10:00:00.000Z',
      data: {
        role: 'assistant',
        text: `构建已完成，请确认：\n\n<agentdock-deploy-approval id="rel_7" title="发布 v0.4.0">\n  <summary>生产集群升级</summary>\n  <field label="集群">prod-cn</field>\n</agentdock-deploy-approval>`
      }
    } as TimelineEvent;

    const actionHtml = renderToStaticMarkup(
      createElement(TooltipProvider, null, createElement(TimelineItem, {
        event: actionEvent,
        final: true,
        replay: true,
        sessionId: 'ses_1',
        outputPluginRegistry: registry,
        enabledOutputPluginIds: enabledIds,
        onInteractOutputPlugin: () => undefined
      }))
    );
    expect(actionHtml).toContain('构建已完成，请确认：');
    expect(actionHtml).toContain('data-output-plugin-card="local:deploy-approval"');
    expect(actionHtml).toContain('data-output-plugin-state="pending"');
    expect(actionHtml).toContain('发布 v0.4.0');
    expect(actionHtml).toContain('prod-cn');
    expect(actionHtml).toContain('确认发布');
    expect(actionHtml).toContain('取消发布');
    expect(actionHtml).not.toContain('&lt;agentdock-deploy-approval');

    // 已响应锁定态
    const answeredPayload: DeclarativeOutputPluginInteractionPayload = {
      version: 1,
      pluginId: 'local:deploy-approval',
      pluginName: '发布审批卡',
      instanceId: 'rel_7',
      title: '发布 v0.4.0',
      source: 'lark',
      actedBy: '暮雪离歌',
      actedAt: '2026-11-27T10:01:00.000Z',
      actionValue: 'approve',
      actionLabel: '确认发布',
      fields: [],
      note: '先灰度 10%'
    };
    const interactionsMap = new Map<string, unknown>([
      [outputPluginInstanceKey('local:deploy-approval', 'rel_7'), answeredPayload]
    ]);
    const lockedHtml = renderToStaticMarkup(
      createElement(TooltipProvider, null, createElement(TimelineItem, {
        event: actionEvent,
        final: true,
        replay: true,
        sessionId: 'ses_1',
        outputPluginRegistry: registry,
        enabledOutputPluginIds: enabledIds,
        pluginInteractionsByKey: interactionsMap
      }))
    );
    expect(lockedHtml).toContain('data-output-plugin-state="answered"');
    expect(lockedHtml).toContain('已响应');
    expect(lockedHtml).toContain('飞书 · 暮雪离歌');
    expect(lockedHtml).toContain('先灰度 10%');
    expect(lockedHtml).not.toContain('data-plugin-action="approve"');

    // 交互回传轮次专属回显卡片
    const turnEvent: TimelineEvent = {
      id: 'u_turn_1',
      sequence: 3,
      type: 'text',
      timestamp: '2026-11-27T10:01:00.000Z',
      data: {
        role: 'user',
        origin: declarativePluginInteractionOrigin('local:deploy-approval'),
        text: JSON.stringify(answeredPayload)
      }
    } as TimelineEvent;
    const echoHtml = renderToStaticMarkup(
      createElement(TooltipProvider, null, createElement(TimelineItem, {
        event: turnEvent,
        sessionId: 'ses_1',
        outputPluginRegistry: registry
      }))
    );
    expect(echoHtml).toContain('data-output-plugin-interaction-card="local:deploy-approval"');
    expect(echoHtml).toContain('发布审批卡');
    expect(echoHtml).toContain('确认发布');
    expect(echoHtml).toContain('先灰度 10%');

    // 流式未闭合占位（ActivityPanel & TimelineItem）
    const streamingEvent: TimelineEvent = {
      id: 'a_stream',
      sequence: 4,
      type: 'text',
      timestamp: '2026-11-27T10:02:00.000Z',
      data: {
        role: 'assistant',
        text: '准备收集参数：\n\n<agentdock-env-form id="f1" title="部署参数">\n  <field name="env"'
      }
    } as TimelineEvent;
    const panelHtml = renderToStaticMarkup(
      createElement(TooltipProvider, null, createElement(ActivityPanel, {
        groups: [{
          id: 'g1',
          label: '执行过程',
          labelTitle: '执行过程',
          events: [streamingEvent],
          startedAt: '2026-11-27T10:02:00.000Z'
        }],
        ongoing: true,
        replay: true,
        sessionId: 'ses_1',
        modelLabel: 'Codex',
        outputPluginRegistry: registry,
        enabledOutputPluginIds: enabledIds
      }))
    );
    expect(panelHtml).toContain('data-output-plugin-placeholder="local:env-form"');
    expect(panelHtml).toContain('正在生成「部署参数」卡片…');
    expect(panelHtml).not.toContain('agentdock-env-form');

    // 时间线 Cmd+F 搜索与注入标签识别
    const turns = groupTimelineSections(buildTimelineSections([actionEvent, turnEvent]));
    expect(searchTimeline({ turns, query: '先灰度 10%', outputPluginRegistry: registry })).toHaveLength(1);
    expect(searchTimeline({ turns, query: 'prod-cn', outputPluginRegistry: registry })).toHaveLength(1);
    expect(detectInjectionTags('[AgentDock 交互插件协议：发布审批卡]\n...')).toContain('交互插件协议');
  });

  it('renders OutputPluginsCenterPanel with builtin + local plugins, warnings, and zero native titles on buttons', () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const snapshot: OutputPluginsCatalogSnapshot = {
      configured: true,
      config: {
        plugins: {
          [BUILTIN_ASK_USER_QUESTION_PLUGIN_ID]: true,
          'local:deploy-approval': false,
          'local:env-form': true
        }
      },
      localDir: '/Users/demo/.agentdock/output-plugins',
      localDirExists: true,
      warnings: [{ file: 'broken.json', message: 'JSON 解析失败' }],
      plugins: catalogItems
    };
    qc.setQueryData(OUTPUT_PLUGINS_QUERY_KEY, snapshot);

    const html = renderToStaticMarkup(
      createElement(QueryClientProvider, { client: qc },
        createElement(TooltipProvider, null, createElement(OutputPluginsCenterPanel))
      )
    );
    expect(html).toContain('data-testid="output-plugins-center"');
    expect(html).toContain('交互插件中心');
    expect(html).toContain('询问卡片（AskUserQuestion）');
    expect(html).toContain('操作确认卡（ConfirmAction）');
    expect(html).toContain('发布审批卡');
    expect(html).toContain('部署参数表');
    expect(html).toContain('broken.json');
    expect(html).toContain('/Users/demo/.agentdock/output-plugins');
    expect(html).toContain('data-testid="output-plugins-reload"');
  });

  it('renders builtin ConfirmAction card (pending, confirmed, cancelled, streaming placeholder) and bespoke echo turn', () => {
    const registry = buildClientOutputPluginRegistry(catalogItems);
    const enabledIds = new Set([BUILTIN_ASK_USER_QUESTION_PLUGIN_ID, BUILTIN_CONFIRM_ACTION_PLUGIN_ID]);

    const confirmEvent: TimelineEvent = {
      id: 'a_confirm',
      sequence: 10,
      type: 'text',
      timestamp: '2026-11-27T11:00:00.000Z',
      data: {
        role: 'assistant',
        text: `即将推送生产版本，请拍板：\n\n<agentdock-confirm-action id="prod_rel_1" title="确认发布 v0.3.28 到生产" risk="high" confirm-label="确认发布" cancel-label="暂缓">\n  <summary>包含数据库迁移与服务滚动重启</summary>\n  <detail label="集群">prod-cn-east</detail>\n  <command>pnpm deploy --env prod</command>\n</agentdock-confirm-action>`
      }
    } as TimelineEvent;

    const pendingHtml = renderToStaticMarkup(
      createElement(TooltipProvider, null, createElement(TimelineItem, {
        event: confirmEvent,
        final: true,
        replay: true,
        sessionId: 'ses_1',
        outputPluginRegistry: registry,
        enabledOutputPluginIds: enabledIds,
        onInteractOutputPlugin: () => undefined
      }))
    );
    expect(pendingHtml).toContain('即将推送生产版本，请拍板：');
    expect(pendingHtml).toContain('data-confirm-card=""');
    expect(pendingHtml).toContain('data-confirm-card-state="pending"');
    expect(pendingHtml).toContain('data-confirm-risk="high"');
    expect(pendingHtml).toContain('高风险');
    expect(pendingHtml).toContain('prod-cn-east');
    expect(pendingHtml).toContain('pnpm deploy --env prod');
    expect(pendingHtml).toContain('确认发布');
    expect(pendingHtml).toContain('暂缓');
    expect(pendingHtml).not.toContain('&lt;agentdock-confirm-action');

    const confirmedPayload: ConfirmActionInteractionPayload = {
      version: 1,
      pluginId: BUILTIN_CONFIRM_ACTION_PLUGIN_ID,
      actionId: 'prod_rel_1',
      title: '确认发布 v0.3.28 到生产',
      risk: 'high',
      decision: 'confirm',
      decisionLabel: '确认发布',
      comment: '先灰度 10% 观察指标',
      source: 'web',
      decidedAt: '2026-11-27T11:01:00.000Z'
    };
    const confirmedMap = new Map<string, unknown>([
      [outputPluginInstanceKey(BUILTIN_CONFIRM_ACTION_PLUGIN_ID, 'prod_rel_1'), confirmedPayload]
    ]);
    const answeredHtml = renderToStaticMarkup(
      createElement(TooltipProvider, null, createElement(TimelineItem, {
        event: confirmEvent,
        final: true,
        replay: true,
        sessionId: 'ses_1',
        outputPluginRegistry: registry,
        enabledOutputPluginIds: enabledIds,
        pluginInteractionsByKey: confirmedMap
      }))
    );
    expect(answeredHtml).toContain('data-confirm-card-state="answered"');
    expect(answeredHtml).toContain('data-confirm-decision="confirm"');
    expect(answeredHtml).toContain('已确认执行');
    expect(answeredHtml).toContain('先灰度 10% 观察指标');
    expect(answeredHtml).not.toContain('data-confirm-submit=""');

    const echoEvent: TimelineEvent = {
      id: 'u_confirm_echo',
      sequence: 11,
      type: 'text',
      timestamp: '2026-11-27T11:01:00.000Z',
      data: {
        role: 'user',
        origin: CONFIRM_ACTION_INTERACTION_ORIGIN,
        text: serializeConfirmActionInteraction(confirmedPayload)
      }
    } as TimelineEvent;
    const echoHtml = renderToStaticMarkup(
      createElement(TooltipProvider, null, createElement(TimelineItem, {
        event: echoEvent,
        sessionId: 'ses_1',
        outputPluginRegistry: registry
      }))
    );
    expect(echoHtml).toContain('data-confirm-interaction-card=""');
    expect(echoHtml).toContain('data-confirm-interaction-decision="confirm"');
    expect(echoHtml).toContain('已确认执行');
    expect(echoHtml).toContain('先灰度 10% 观察指标');

    const streamingConfirm: TimelineEvent = {
      id: 'a_confirm_stream',
      sequence: 12,
      type: 'text',
      timestamp: '2026-11-27T11:02:00.000Z',
      data: {
        role: 'assistant',
        text: '请确认：\n\n<agentdock-confirm-action id="s1" title="删除测试库">\n  <summary>释放磁盘'
      }
    } as TimelineEvent;
    const streamHtml = renderToStaticMarkup(
      createElement(TooltipProvider, null, createElement(ActivityPanel, {
        groups: [{
          id: 'g_confirm',
          label: '执行过程',
          labelTitle: '执行过程',
          events: [streamingConfirm],
          startedAt: '2026-11-27T11:02:00.000Z'
        }],
        ongoing: true,
        replay: true,
        sessionId: 'ses_1',
        modelLabel: 'Codex',
        outputPluginRegistry: registry,
        enabledOutputPluginIds: enabledIds
      }))
    );
    expect(streamHtml).toContain('data-confirm-streaming-placeholder=""');
    expect(streamHtml).toContain('正在生成「删除测试库」操作确认卡…');
    expect(streamHtml).not.toContain('agentdock-confirm-action');

    const turns = groupTimelineSections(buildTimelineSections([confirmEvent, echoEvent]));
    expect(searchTimeline({ turns, query: 'pnpm deploy --env prod', outputPluginRegistry: registry })).toHaveLength(1);
    expect(searchTimeline({ turns, query: '先灰度 10% 观察指标', outputPluginRegistry: registry })).toHaveLength(1);
    expect(detectInjectionTags('[AgentDock 操作确认卡片协议]\n...')).toContain('操作确认协议');
  });

  it('scales Composer bottom bar to multi-plugin trigger badge and migrates draft prefs cleanly', () => {
    const html = renderToStaticMarkup(createElement(TooltipProvider, null, createElement(Composer, {
      sessionId: 'ses_1',
      state: 'idle',
      value: '',
      references: [],
      sending: false,
      mode: 'queue',
      queuedTasks: [],
      skills: [],
      models: [{ id: 'gpt-5', name: 'GPT-5' }],
      reasoningEfforts: [{ id: 'medium', name: '中' }],
      currentModel: 'gpt-5',
      currentReasoningEffort: 'medium',
      advertisedCommands: [],
      modelReadiness: { kind: 'ready' },
      switchingModel: false,
      switchingReasoningEffort: false,
      refreshingModels: false,
      outputPlugins: [
        {
          id: BUILTIN_ASK_USER_QUESTION_PLUGIN_ID,
          name: '询问卡片',
          description: '选项卡片',
          icon: 'message-circle-question',
          tagName: 'agentdock-ask-user-question',
          builtin: true,
          enabled: true,
          globalEnabled: true,
          override: null
        },
        {
          id: 'local:deploy-approval',
          name: '发布审批卡',
          description: '一键审批',
          icon: 'shield-check',
          tagName: 'agentdock-deploy-approval',
          builtin: false,
          enabled: true,
          globalEnabled: false,
          override: true
        }
      ],
      onSetOutputPlugin: () => undefined,
      onChange: () => undefined,
      onReferencesChange: () => undefined,
      onModeChange: () => undefined,
      onSubmit: () => undefined,
      onInterrupt: () => undefined,
      onCancelQueued: () => undefined,
      onSteerQueued: () => undefined,
      onEditQueued: () => undefined,
      onModelChange: () => undefined,
      onReasoningEffortChange: () => undefined,
      onRefreshModels: () => undefined
    })));
    expect(html).toContain('data-testid="composer-output-plugins-trigger"');
    expect(html).toContain('data-enabled-count="2"');
    expect(html).toContain('data-override-count="1"');

    // 草稿偏好兼容旧 askUserQuestionEnabled 并支持多插件覆写与一键清空
    const migrated = normalizeDraftComposerPrefs({ version: 1, askUserQuestionEnabled: false, byAgent: {} });
    expect(migrated.outputPlugins).toEqual({ [BUILTIN_ASK_USER_QUESTION_PLUGIN_ID]: false });
    expect(migrated.askUserQuestionEnabled).toBe(false);

    const multi = withDraftOutputPluginOverride(
      withDraftOutputPluginOverride(EMPTY_DRAFT_COMPOSER_PREFS, 'ask-user-question', false),
      'local:deploy-approval',
      true
    );
    expect(multi.outputPlugins).toEqual({
      [BUILTIN_ASK_USER_QUESTION_PLUGIN_ID]: false,
      'local:deploy-approval': true
    });
    expect(multi.askUserQuestionEnabled).toBe(false);

    const cleared = withoutDraftOutputPluginOverrides(multi);
    expect(cleared.outputPlugins).toBeUndefined();
    expect(cleared.askUserQuestionEnabled).toBeUndefined();
  });
});
