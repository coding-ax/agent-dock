import { describe, expect, it } from 'vitest';
import {
  ASK_USER_QUESTION_ANSWER_ORIGIN,
  ASK_USER_QUESTION_XML_TAG,
  BUILTIN_ASK_USER_QUESTION_PLUGIN_ID,
  BUILTIN_CONFIRM_ACTION_PLUGIN_ID,
  CONFIRM_ACTION_INTERACTION_ORIGIN,
  CONFIRM_ACTION_XML_TAG,
  LEGACY_ASK_USER_QUESTION_PLUGIN_ALIAS,
  LEGACY_CONFIRM_ACTION_PLUGIN_ALIAS,
  OutputPluginRegistry,
  askUserQuestionOutputPlugin,
  confirmActionOutputPlugin,
  createDeclarativeOutputPlugin,
  createDefaultOutputPluginRegistry,
  declarativeOutputPluginManifestSchema,
  formatConfirmActionInteractionForAgent,
  getSessionOutputPluginOverride,
  mergeSessionOutputPluginsPatch,
  normalizeGlobalOutputPluginsConfig,
  normalizeOutputPluginId,
  normalizeSessionOutputPlugins,
  resolveOutputPluginEnabled,
  serializeAskUserQuestionAnswer,
  serializeConfirmActionInteraction,
  type ConfirmActionInteractionPayload,
  type DeclarativeOutputPluginInteractionPayload,
  type DeclarativeOutputPluginManifest
} from '../index.js';

const deployApprovalManifest: DeclarativeOutputPluginManifest = {
  id: 'local:deploy-approval',
  name: '发布审批卡',
  description: '在执行生产发布前请负责人一键确认或驳回。',
  icon: 'shield-check',
  tagName: 'agentdock-deploy-approval',
  version: '1.0.0',
  defaultEnabled: false,
  kind: 'action-card',
  card: {
    accentTone: 'amber',
    headerTitle: '生产发布确认',
    allowNote: true,
    notePlaceholder: '可填审批备注…',
    actions: [
      { value: 'approve', label: '批准发布', style: 'primary' },
      { value: 'reject', label: '驳回', style: 'danger' }
    ]
  }
};

const envFormManifest: DeclarativeOutputPluginManifest = {
  id: 'local:env-form',
  name: '参数收集表',
  description: '收集多字段结构化发布参数。',
  icon: 'clipboard-list',
  tagName: 'agentdock-env-form',
  version: '1.0.0',
  defaultEnabled: false,
  kind: 'form-card',
  card: {
    accentTone: 'sky',
    submitLabel: '确认参数',
    allowNote: false
  }
};

const releaseInfoManifest: DeclarativeOutputPluginManifest = {
  id: 'local:release-summary',
  name: '构建摘要卡',
  description: '只读结构化发布产物卡片。',
  icon: 'file-text',
  tagName: 'agentdock-release-summary',
  version: '1.0.0',
  defaultEnabled: true,
  kind: 'info-card'
};

describe('output-plugins shared contract & registry', () => {
  it('registers builtin AskUserQuestion and ConfirmAction and resolves short aliases seamlessly', () => {
    const registry = createDefaultOutputPluginRegistry();
    expect(registry.list().map(p => p.id)).toEqual([
      BUILTIN_ASK_USER_QUESTION_PLUGIN_ID,
      BUILTIN_CONFIRM_ACTION_PLUGIN_ID
    ]);

    const viaCanonical = registry.get(BUILTIN_ASK_USER_QUESTION_PLUGIN_ID);
    const viaAlias = registry.get(LEGACY_ASK_USER_QUESTION_PLUGIN_ALIAS);
    const viaTag = registry.getByTagName(ASK_USER_QUESTION_XML_TAG);
    const viaOrigin = registry.getByInteractionOrigin(ASK_USER_QUESTION_ANSWER_ORIGIN);

    expect(viaCanonical).toBe(askUserQuestionOutputPlugin);
    expect(viaAlias).toBe(askUserQuestionOutputPlugin);
    expect(viaTag).toBe(askUserQuestionOutputPlugin);
    expect(viaOrigin).toBe(askUserQuestionOutputPlugin);
    expect(viaCanonical?.builtin).toBe(true);
    expect(viaCanonical?.defaultEnabled).toBe(true);
    expect(viaCanonical?.capabilities).toEqual({
      web: true,
      lark: true,
      interactive: true,
      streamingPlaceholder: true
    });

    // Built-in Plugin #2: confirm-action
    expect(registry.get(BUILTIN_CONFIRM_ACTION_PLUGIN_ID)).toBe(confirmActionOutputPlugin);
    expect(registry.get(LEGACY_CONFIRM_ACTION_PLUGIN_ALIAS)).toBe(confirmActionOutputPlugin);
    expect(registry.getByTagName(CONFIRM_ACTION_XML_TAG)).toBe(confirmActionOutputPlugin);
    expect(registry.getByInteractionOrigin(CONFIRM_ACTION_INTERACTION_ORIGIN)).toBe(confirmActionOutputPlugin);
    expect(normalizeOutputPluginId('confirm-action')).toBe(BUILTIN_CONFIRM_ACTION_PLUGIN_ID);
    expect(confirmActionOutputPlugin.builtin).toBe(true);
    expect(confirmActionOutputPlugin.defaultEnabled).toBe(true);
  });

  it('parses builtin ConfirmAction XML with fence immunity, streaming placeholder, and interaction routing', () => {
    const registry = createDefaultOutputPluginRegistry();

    const fenced = '示例：\n```xml\n<agentdock-confirm-action id="fake" title="不要触发"></agentdock-confirm-action>\n```';
    expect(registry.parseTrailingOutput(fenced)).toBeNull();

    const realConfirm = `准备执行生产部署，请最终拍板：

<agentdock-confirm-action id="deploy_1" title="发布 v0.3.28 到生产" risk="high" confirm-label="放行发布" cancel-label="先取消">
  <summary>将执行数据库迁移并滚动重启 API</summary>
  <detail label="集群">prod-cn-east</detail>
  <detail label="变更数">4 项</detail>
  <command>pnpm deploy --env prod</command>
</agentdock-confirm-action>`;

    const parsed = registry.parseTrailingOutput(realConfirm, new Set([BUILTIN_CONFIRM_ACTION_PLUGIN_ID]));
    expect(parsed?.pluginId).toBe(BUILTIN_CONFIRM_ACTION_PLUGIN_ID);
    expect(parsed?.proseText).toBe('准备执行生产部署，请最终拍板：');
    expect(parsed?.spec).toMatchObject({
      id: 'deploy_1',
      title: '发布 v0.3.28 到生产',
      summary: '将执行数据库迁移并滚动重启 API',
      risk: 'high',
      command: 'pnpm deploy --env prod',
      confirmLabel: '放行发布',
      cancelLabel: '先取消',
      allowComment: true,
      details: [
        { label: '集群', value: 'prod-cn-east' },
        { label: '变更数', value: '4 项' }
      ]
    });

    const partial = '正在生成确认单：\n\n<agentdock-confirm-action id="d2" title="清理历史表">\n  <summary>删除 90 天前日志';
    const pending = registry.splitStreamingOutput(partial, true, new Set([BUILTIN_CONFIRM_ACTION_PLUGIN_ID]));
    expect(pending).toEqual({
      kind: 'pending',
      pluginId: BUILTIN_CONFIRM_ACTION_PLUGIN_ID,
      tagName: CONFIRM_ACTION_XML_TAG,
      proseText: '正在生成确认单：',
      partialTitle: '清理历史表'
    });

    const interactionPayload: ConfirmActionInteractionPayload = {
      version: 1,
      pluginId: BUILTIN_CONFIRM_ACTION_PLUGIN_ID,
      actionId: 'deploy_1',
      title: '发布 v0.3.28 到生产',
      risk: 'high',
      decision: 'confirm',
      decisionLabel: '放行发布',
      comment: '先发 10% 灰度验证 5 分钟',
      source: 'web',
      decidedAt: '2026-11-27T11:00:00.000Z'
    };
    const routed = registry.parseInteractionEvent(
      CONFIRM_ACTION_INTERACTION_ORIGIN,
      serializeConfirmActionInteraction(interactionPayload)
    );
    expect(routed?.plugin.id).toBe(BUILTIN_CONFIRM_ACTION_PLUGIN_ID);
    expect(routed?.instanceId).toBe('deploy_1');
    const promptText = formatConfirmActionInteractionForAgent(interactionPayload);
    expect(promptText).toContain('确认放行');
    expect(promptText).toContain('先发 10% 灰度验证 5 分钟');
  });

  it('rejects duplicate IDs, conflicting XML tagNames, and invalid non-agentdock tag names', () => {
    const registry = createDefaultOutputPluginRegistry();

    expect(() => registry.register(askUserQuestionOutputPlugin)).toThrow(/Duplicate output plugin id/);
    expect(() =>
      registry.register(
        createDeclarativeOutputPlugin({
          ...deployApprovalManifest,
          id: 'local:tag-clash',
          tagName: ASK_USER_QUESTION_XML_TAG
        })
      )
    ).toThrow(/conflicts with existing plugin/);

    // 非 agentdock- 前缀标签必须被 Zod schema 拦截，防止劫持原生 HTML 标签
    const badTag = declarativeOutputPluginManifestSchema.safeParse({
      ...deployApprovalManifest,
      tagName: 'script'
    });
    expect(badTag.success).toBe(false);

    // 不可卸载内置插件
    expect(registry.unregister(BUILTIN_ASK_USER_QUESTION_PLUGIN_ID)).toBe(false);
  });

  it('parses trailing XML, ignores fenced/inline code blocks, and splits streaming across multiple plugins', () => {
    const registry = createDefaultOutputPluginRegistry();
    const deployPlugin = createDeclarativeOutputPlugin(deployApprovalManifest);
    const formPlugin = createDeclarativeOutputPlugin(envFormManifest);
    const infoPlugin = createDeclarativeOutputPlugin(releaseInfoManifest);
    registry.register(deployPlugin);
    registry.register(formPlugin);
    registry.register(infoPlugin);

    // 1) action-card 解析与代码围栏免疫
    const fencedExample = `示例说明：

\`\`\`xml
<agentdock-deploy-approval id="fake"><summary>代码里的示例</summary></agentdock-deploy-approval>
\`\`\`

正文中提到 \`<agentdock-deploy-approval>\` 也不应触发。`;
    expect(registry.parseTrailingOutput(fencedExample)).toBeNull();

    const realActionText = `构建已通过，请审批：

<agentdock-deploy-approval id="rel_42" title="发布 v0.4.0">
  <summary>将部署到生产集群</summary>
  <field label="集群">prod-cn</field>
  <field label="变更数">3</field>
</agentdock-deploy-approval>`;

    // 未启用该插件时不解析
    expect(registry.parseTrailingOutput(realActionText, new Set([BUILTIN_ASK_USER_QUESTION_PLUGIN_ID]))).toBeNull();

    // 启用后正确解析并继承 manifest 默认动作按钮
    const parsedAction = registry.parseTrailingOutput(realActionText, new Set(['local:deploy-approval']));
    expect(parsedAction?.pluginId).toBe('local:deploy-approval');
    expect(parsedAction?.proseText).toBe('构建已通过，请审批：');
    expect(parsedAction?.spec).toMatchObject({
      id: 'rel_42',
      kind: 'action-card',
      title: '发布 v0.4.0',
      summary: '将部署到生产集群',
      tone: 'amber',
      allowNote: true,
      fields: [
        { label: '集群', value: 'prod-cn' },
        { label: '变更数', value: '3' }
      ],
      actions: [
        { value: 'approve', label: '批准发布', style: 'primary' },
        { value: 'reject', label: '驳回', style: 'danger' }
      ]
    });

    // 2) 流式未闭合标签与 `<agentd...` 前缀探测
    const streamingPartial = '准备推送确认：\n\n<agentdock-deploy-approval id="s1" title="灰度发布">\n  <summary>检查中';
    const splitPending = registry.splitStreamingOutput(streamingPartial, true, new Set(['local:deploy-approval']));
    expect(splitPending).toEqual({
      kind: 'pending',
      pluginId: 'local:deploy-approval',
      tagName: 'agentdock-deploy-approval',
      proseText: '准备推送确认：',
      partialTitle: '灰度发布'
    });

    const prefixTail = '即将生成：\n\n<agentd';
    const splitPrefix = registry.splitStreamingOutput(prefixTail, true, new Set(['local:deploy-approval']));
    expect(splitPrefix.kind).toBe('pending');
    if (splitPrefix.kind === 'pending') {
      expect(splitPrefix.pluginId).toBe('local:deploy-approval');
      expect(splitPrefix.proseText).toBe('即将生成：');
    }

    // 3) form-card 与 info-card 解析
    const formXml = `请补充配置：\n<agentdock-env-form id="f1" title="部署配置">\n  <field name="region" label="区域" type="select" required="true" options="cn:中国,us:美国"/>\n  <field name="branch" label="分支" type="text" placeholder="main" required="true"/>\n</agentdock-env-form>`;
    const parsedForm = registry.parseTrailingOutput(formXml);
    expect(parsedForm?.pluginId).toBe('local:env-form');
    expect((parsedForm?.spec as any).fields).toHaveLength(2);
    expect((parsedForm?.spec as any).fields[0].options).toEqual([
      { value: 'cn', label: '中国' },
      { value: 'us', label: '美国' }
    ]);

    const infoXml = `已完成：\n<agentdock-release-summary id="r1" title="v0.4.0 产物" status="PASS" tone="emerald">\n  <summary>100% 通过</summary>\n  <field label="产物">agentdock.tgz</field>\n  <link label="Release Notes" href="https://example.com/v0.4.0"/>\n  <link label="恶意脚本" href="javascript:alert(1)"/>\n</agentdock-release-summary>`;
    const parsedInfo = registry.parseTrailingOutput(infoXml);
    expect(parsedInfo?.pluginId).toBe('local:release-summary');
    expect((parsedInfo?.spec as any).links).toEqual([
      { label: 'Release Notes', href: 'https://example.com/v0.4.0' }
    ]);
  });

  it('routes interaction events back to owning plugin and formats Agent prompts cleanly', () => {
    const registry = createDefaultOutputPluginRegistry();
    const deployPlugin = createDeclarativeOutputPlugin(deployApprovalManifest);
    registry.register(deployPlugin);

    // AskUserQuestion 交互事件仍走原 origin
    const askPayload = {
      version: 1 as const,
      questionId: 'ask_1',
      title: '数据库',
      source: 'web' as const,
      answeredAt: '2026-11-27T10:00:00.000Z',
      answers: [{ questionId: 'q1', prompt: '选哪个？', selectedValues: ['sqlite'], selectedLabels: ['SQLite'] }]
    };
    const askEvent = registry.parseInteractionEvent(
      ASK_USER_QUESTION_ANSWER_ORIGIN,
      serializeAskUserQuestionAnswer(askPayload)
    );
    expect(askEvent?.plugin.id).toBe(BUILTIN_ASK_USER_QUESTION_PLUGIN_ID);
    expect(askEvent?.instanceId).toBe('ask_1');

    // Declarative 插件交互事件自动路由
    const declPayload: DeclarativeOutputPluginInteractionPayload = {
      version: 1,
      pluginId: 'local:deploy-approval',
      pluginName: '发布审批卡',
      instanceId: 'rel_42',
      title: '发布 v0.4.0',
      source: 'lark',
      actedBy: '暮雪离歌',
      actedAt: '2026-11-27T10:01:00.000Z',
      actionValue: 'approve',
      actionLabel: '批准发布',
      fields: [],
      note: '先发 10% 灰度'
    };
    const serialized = deployPlugin.serializeInteraction!(declPayload);
    const parsedInteraction = registry.parseInteractionEvent(deployPlugin.interactionOrigin, serialized);
    expect(parsedInteraction?.plugin.id).toBe('local:deploy-approval');
    expect(parsedInteraction?.instanceId).toBe('rel_42');

    const agentText = deployPlugin.formatInteractionForAgent!(declPayload);
    expect(agentText).toContain('发布 v0.4.0');
    expect(agentText).toContain('飞书 · 暮雪离歌');
    expect(agentText).toContain('批准发布 (approve)');
    expect(agentText).toContain('先发 10% 灰度');
  });

  it('resolves global/session plugin switches with full backward compatibility for legacy askUserQuestionEnabled', () => {
    expect(normalizeOutputPluginId('ask-user-question')).toBe(BUILTIN_ASK_USER_QUESTION_PLUGIN_ID);

    // 迁移旧全局配置 askUserQuestionXmlEnabled=false
    const migratedGlobal = normalizeGlobalOutputPluginsConfig(undefined, false);
    expect(migratedGlobal.plugins[BUILTIN_ASK_USER_QUESTION_PLUGIN_ID]).toBe(false);

    // 迁移旧会话列 askUserQuestionEnabled=false
    const migratedSession = normalizeSessionOutputPlugins(undefined, false);
    expect(migratedSession).toEqual({ [BUILTIN_ASK_USER_QUESTION_PLUGIN_ID]: false });

    // 会话显式覆写 > 历史列 > 全局配置 > 插件默认
    expect(resolveOutputPluginEnabled('builtin:ask-user-question', {
      defaultEnabled: true,
      globalConfig: { plugins: { [BUILTIN_ASK_USER_QUESTION_PLUGIN_ID]: false } },
      sessionOverrides: { [BUILTIN_ASK_USER_QUESTION_PLUGIN_ID]: true },
      legacySessionAskEnabled: false
    })).toBe(true);

    expect(resolveOutputPluginEnabled('builtin:ask-user-question', {
      defaultEnabled: true,
      globalConfig: { plugins: { [BUILTIN_ASK_USER_QUESTION_PLUGIN_ID]: true } },
      sessionOverrides: undefined,
      legacySessionAskEnabled: false
    })).toBe(false);

    expect(resolveOutputPluginEnabled('local:deploy-approval', {
      defaultEnabled: false,
      globalConfig: { plugins: {} },
      sessionOverrides: { 'local:deploy-approval': true }
    })).toBe(true);

    // Patch 合并：null 移除覆写，恢复跟随全局
    const merged = mergeSessionOutputPluginsPatch(
      { [BUILTIN_ASK_USER_QUESTION_PLUGIN_ID]: false, 'local:deploy-approval': true },
      { 'ask-user-question': null, 'local:env-form': true }
    );
    expect(merged).toEqual({
      'local:deploy-approval': true,
      'local:env-form': true
    });
    expect(getSessionOutputPluginOverride(BUILTIN_ASK_USER_QUESTION_PLUGIN_ID, merged)).toBeNull();
    expect(getSessionOutputPluginOverride('local:deploy-approval', merged)).toBe(true);
  });

  it('replaces external plugins atomically without disturbing builtins', () => {
    const registry = new OutputPluginRegistry([askUserQuestionOutputPlugin]);
    const p1 = createDeclarativeOutputPlugin(deployApprovalManifest);
    const p2 = createDeclarativeOutputPlugin(envFormManifest);

    const first = registry.replaceExternalPlugins([p1, p2]);
    expect(first.loaded.map(p => p.id)).toEqual(['local:deploy-approval', 'local:env-form']);
    expect(first.skipped).toEqual([]);
    expect(registry.list().map(p => p.id)).toEqual([
      BUILTIN_ASK_USER_QUESTION_PLUGIN_ID,
      'local:deploy-approval',
      'local:env-form'
    ]);

    // 二次替换移除 p1，保留内置并跳过与内置同标签的冲突项
    const clash = createDeclarativeOutputPlugin({
      ...releaseInfoManifest,
      id: 'local:bad-tag',
      tagName: ASK_USER_QUESTION_XML_TAG
    });
    const second = registry.replaceExternalPlugins([p2, clash]);
    expect(second.loaded.map(p => p.id)).toEqual(['local:env-form']);
    expect(second.skipped).toHaveLength(1);
    expect(registry.has('local:deploy-approval')).toBe(false);
    expect(registry.has(BUILTIN_ASK_USER_QUESTION_PLUGIN_ID)).toBe(true);
  });
});
