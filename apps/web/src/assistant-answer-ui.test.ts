import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  ASK_USER_QUESTION_ANSWER_ORIGIN,
  ASSISTANT_ANSWER_ORIGIN,
  ASSISTANT_REPLY_ORIGIN,
  BUILTIN_ASK_USER_QUESTION_PLUGIN_ID,
  BUILTIN_CONFIRM_ACTION_PLUGIN_ID,
  CONFIRM_ACTION_INTERACTION_ORIGIN,
  createDeclarativeOutputPlugin,
  createDefaultOutputPluginRegistry,
  outputPluginInstanceKey,
  serializeAskUserQuestionAnswer,
  serializeConfirmActionInteraction,
  type AskUserQuestionAnswerPayload,
  type ConfirmActionInteractionPayload,
  type DeclarativeOutputPluginInteractionPayload,
  type DeclarativeOutputPluginManifest
} from '@agent-dock/agent-dock-shared';
import { TooltipProvider } from './HoverTooltip';
import { TimelineItem } from './TimelineItems';
import { buildTimelineSections, groupTimelineSections, type TimelineEvent } from './timeline';
import { searchTimeline } from './timeline-search';

const renderTimelineItem = (props: Parameters<typeof TimelineItem>[0], queryClient?: QueryClient) => {
  const inner = createElement(TooltipProvider, null, createElement(TimelineItem, props));
  return renderToStaticMarkup(
    queryClient ? createElement(QueryClientProvider, { client: queryClient }, inner) : inner
  );
};

const askXml = `已整理两个持久化方案，请拍板：

<agentdock-ask-user-question id="ask_storage_cat" title="选择存储方案">
  <question id="q1" multi="false" allow-other="true">
    <prompt>希望采用哪种持久化方案？</prompt>
    <option value="sqlite" recommended="true" description="内置零运维，单文件轻量">SQLite</option>
    <option value="postgres" description="适合多节点并发扩展">PostgreSQL</option>
  </question>
</agentdock-ask-user-question>`;

const confirmXml = `准备清理构建缓存：

<agentdock-confirm-action id="confirm_cache_cat" title="清理本地构建缓存" risk="low" confirm-label="确认清理" cancel-label="暂缓">
  <summary>清理 dist 临时构建目录，不影响源代码。</summary>
  <command>rm -rf apps/web/dist</command>
</agentdock-confirm-action>`;

const deployManifest: DeclarativeOutputPluginManifest = {
  id: 'local:deploy-approval',
  name: '发布审批卡',
  description: '审批预发或生产发布动作',
  icon: 'shield-check',
  tagName: 'agentdock-deploy-approval',
  version: '1.0.0',
  defaultEnabled: true,
  kind: 'action-card',
  card: {
    accentTone: 'sky',
    allowNote: true,
    actions: [
      { value: 'approve', label: '批准发布', style: 'primary' },
      { value: 'reject', label: '驳回', style: 'danger' }
    ]
  }
};

describe('🐾 小猫代答与小猫回复前端渲染', () => {
  it('renders AskUserQuestion locked card and Q&A echo turn with 🐾 小猫代答 styling (named and fallback)', () => {
    const assistantEvent: TimelineEvent = {
      id: 'a_ask',
      sequence: 2,
      type: 'text',
      timestamp: '2026-11-28T02:10:00.000Z',
      data: { role: 'assistant', text: askXml }
    } as TimelineEvent;

    const namedAnswer: AskUserQuestionAnswerPayload = {
      version: 1,
      questionId: 'ask_storage_cat',
      title: '选择存储方案',
      source: 'assistant',
      answeredBy: '小A同学',
      responderName: '小A同学',
      responderSessionId: 'ses_main',
      answeredAt: '2026-11-28T02:11:00.000Z',
      answers: [{
        questionId: 'q1',
        prompt: '希望采用哪种持久化方案？',
        selectedValues: ['sqlite'],
        selectedLabels: ['SQLite'],
        otherText: '单机轻量零运维，直接开启 WAL 模式'
      }]
    };

    const lockedHtml = renderTimelineItem({
      event: assistantEvent,
      final: true,
      replay: true,
      sessionId: 'ses_side',
      askUserQuestionXmlEnabled: true,
      pluginInteractionsByKey: new Map([
        [outputPluginInstanceKey(BUILTIN_ASK_USER_QUESTION_PLUGIN_ID, 'ask_storage_cat'), namedAnswer]
      ])
    });

    expect(lockedHtml).toContain('data-ask-card-state="answered"');
    expect(lockedHtml).toContain('data-ask-card-source="assistant"');
    expect(lockedHtml).toContain('data-ask-source="assistant"');
    expect(lockedHtml).toContain('ui-kitten-card');
    expect(lockedHtml).toContain('ui-kitten-badge');
    expect(lockedHtml).toContain('🐾');
    expect(lockedHtml).toContain('小A同学代答');
    expect(lockedHtml).toContain('已代答');
    expect(lockedHtml).toContain('SQLite');
    expect(lockedHtml).toContain('单机轻量零运维，直接开启 WAL 模式');
    expect(lockedHtml).not.toContain('data-ask-submit');

    const echoEvent: TimelineEvent = {
      id: 'u_ask_cat',
      sequence: 3,
      type: 'text',
      timestamp: '2026-11-28T02:11:00.000Z',
      data: {
        role: 'user',
        origin: ASK_USER_QUESTION_ANSWER_ORIGIN,
        text: serializeAskUserQuestionAnswer(namedAnswer)
      }
    } as TimelineEvent;

    const echoHtml = renderTimelineItem({ event: echoEvent, sessionId: 'ses_side' });
    expect(echoHtml).toContain('data-ask-answer-card=""');
    expect(echoHtml).toContain('data-ask-answer-source="assistant"');
    expect(echoHtml).toContain('ui-kitten-card');
    expect(echoHtml).toContain('ui-kitten-card-header');
    expect(echoHtml).toContain('ui-kitten-a-badge');
    expect(echoHtml).toContain('小猫代答');
    expect(echoHtml).toContain('小A同学代答');

    // 飞书端回答的交互来源徽标统一渲染飞书双翼 LarkIcon 而非普通发送图标
    const larkAnswer: AskUserQuestionAnswerPayload = {
      ...namedAnswer,
      source: 'lark',
      answeredBy: '暮雪离歌',
      responderName: undefined
    };
    const larkLockedHtml = renderTimelineItem({
      event: assistantEvent,
      final: true,
      replay: true,
      sessionId: 'ses_side',
      askUserQuestionXmlEnabled: true,
      pluginInteractionsByKey: new Map([
        [outputPluginInstanceKey(BUILTIN_ASK_USER_QUESTION_PLUGIN_ID, 'ask_storage_cat'), larkAnswer]
      ])
    });
    expect(larkLockedHtml).toContain('data-ask-source="lark"');
    expect(larkLockedHtml).toContain('data-lark-icon=""');
    expect(larkLockedHtml).toContain('飞书 · 暮雪离歌');
    expect(echoHtml).toContain('代答理由');
    expect(echoHtml).toContain('SQLite');

    // 未提供小猫名时默认展示「🐾 小猫代答」
    const fallbackPayload: AskUserQuestionAnswerPayload = {
      ...namedAnswer,
      answeredBy: undefined,
      responderName: undefined
    };
    const fallbackHtml = renderTimelineItem({
      event: {
        ...echoEvent,
        id: 'u_ask_cat_default',
        data: { role: 'user', origin: ASK_USER_QUESTION_ANSWER_ORIGIN, text: serializeAskUserQuestionAnswer(fallbackPayload) }
      } as TimelineEvent,
      sessionId: 'ses_side'
    });
    expect(fallbackHtml).toContain('🐾');
    expect(fallbackHtml).toContain('小猫代答');
  });

  it('renders ConfirmAction and DeclarativeOutputPlugin cards with 🐾 小猫代答 locked & echo states', () => {
    const registry = createDefaultOutputPluginRegistry();
    const deployPlugin = createDeclarativeOutputPlugin(deployManifest);
    registry.register(deployPlugin);
    const enabledIds = new Set([
      BUILTIN_ASK_USER_QUESTION_PLUGIN_ID,
      BUILTIN_CONFIRM_ACTION_PLUGIN_ID,
      'local:deploy-approval'
    ]);

    const confirmPayload: ConfirmActionInteractionPayload = {
      version: 1,
      pluginId: BUILTIN_CONFIRM_ACTION_PLUGIN_ID,
      actionId: 'confirm_cache_cat',
      title: '清理本地构建缓存',
      risk: 'low',
      decision: 'confirm',
      decisionLabel: '确认清理',
      comment: '沙箱缓存目录可安全清理',
      source: 'assistant',
      decidedBy: '小A同学',
      responderName: '小A同学',
      responderSessionId: 'ses_main',
      decidedAt: '2026-11-28T02:12:00.000Z'
    };

    const confirmLockedHtml = renderTimelineItem({
      event: {
        id: 'a_confirm',
        sequence: 4,
        type: 'text',
        timestamp: '2026-11-28T02:12:00.000Z',
        data: { role: 'assistant', text: confirmXml }
      } as TimelineEvent,
      final: true,
      replay: true,
      sessionId: 'ses_side',
      outputPluginRegistry: registry,
      enabledOutputPluginIds: enabledIds,
      pluginInteractionsByKey: new Map([
        [outputPluginInstanceKey(BUILTIN_CONFIRM_ACTION_PLUGIN_ID, 'confirm_cache_cat'), confirmPayload]
      ])
    });
    expect(confirmLockedHtml).toContain('data-confirm-card-state="answered"');
    expect(confirmLockedHtml).toContain('data-confirm-card-source="assistant"');
    expect(confirmLockedHtml).toContain('data-confirm-source="assistant"');
    expect(confirmLockedHtml).toContain('ui-kitten-card');
    expect(confirmLockedHtml).toContain('小A同学代答');
    expect(confirmLockedHtml).toContain('代答理由');

    const confirmEchoHtml = renderTimelineItem({
      event: {
        id: 'u_confirm_echo',
        sequence: 5,
        type: 'text',
        timestamp: '2026-11-28T02:12:00.000Z',
        data: {
          role: 'user',
          origin: CONFIRM_ACTION_INTERACTION_ORIGIN,
          text: serializeConfirmActionInteraction(confirmPayload)
        }
      } as TimelineEvent,
      sessionId: 'ses_side',
      outputPluginRegistry: registry
    });
    expect(confirmEchoHtml).toContain('data-confirm-interaction-source="assistant"');
    expect(confirmEchoHtml).toContain('小猫代答 · 已确认执行');
    expect(confirmEchoHtml).toContain('小A同学代答');

    const declPayload: DeclarativeOutputPluginInteractionPayload = {
      version: 1,
      pluginId: 'local:deploy-approval',
      pluginName: '发布审批卡',
      instanceId: 'rel_cat_9',
      title: '发布预发环境',
      source: 'assistant',
      actedBy: '布丁',
      responderName: '布丁',
      responderSessionId: 'ses_main',
      actedAt: '2026-11-28T02:13:00.000Z',
      actionValue: 'approve',
      actionLabel: '批准发布',
      fields: [],
      note: '预发验证放行'
    };

    const declLockedHtml = renderTimelineItem({
      event: {
        id: 'a_decl',
        sequence: 6,
        type: 'text',
        timestamp: '2026-11-28T02:13:00.000Z',
        data: {
          role: 'assistant',
          text: '请确认发布：\n\n<agentdock-deploy-approval id="rel_cat_9" title="发布预发环境"><summary>发布到 staging</summary></agentdock-deploy-approval>'
        }
      } as TimelineEvent,
      final: true,
      replay: true,
      sessionId: 'ses_side',
      outputPluginRegistry: registry,
      enabledOutputPluginIds: enabledIds,
      pluginInteractionsByKey: new Map([
        [outputPluginInstanceKey('local:deploy-approval', 'rel_cat_9'), declPayload]
      ])
    });
    expect(declLockedHtml).toContain('data-output-plugin-state="answered"');
    expect(declLockedHtml).toContain('data-output-plugin-source="assistant"');
    expect(declLockedHtml).toContain('布丁代答');
    expect(declLockedHtml).toContain('ui-kitten-card');

    const declEchoHtml = renderTimelineItem({
      event: {
        id: 'u_decl_echo',
        sequence: 7,
        type: 'text',
        timestamp: '2026-11-28T02:13:00.000Z',
        data: {
          role: 'user',
          origin: deployPlugin.interactionOrigin,
          text: deployPlugin.serializeInteraction!(declPayload)
        }
      } as TimelineEvent,
      sessionId: 'ses_side',
      outputPluginRegistry: registry
    });
    expect(declEchoHtml).toContain('data-output-plugin-source="assistant"');
    expect(declEchoHtml).toContain('布丁代答');
    expect(declEchoHtml).toContain('预发验证放行');
  });

  it('renders natural-language assistant_reply turns as dedicated 🐾 小猫回复 bubbles distinct from human user bubbles', () => {
    const replyEvent: TimelineEvent = {
      id: 'u_cat_reply',
      sequence: 8,
      type: 'text',
      timestamp: '2026-11-28T02:15:00.000Z',
      data: {
        role: 'user',
        origin: ASSISTANT_REPLY_ORIGIN,
        text: '直接按方案 A 推进，保持默认 SQLite WAL 配置，不需要引入 Redis。'
      }
    } as TimelineEvent;

    // 1) 无 QueryClientProvider 时优雅回落为「🐾 小猫回复」
    const defaultHtml = renderTimelineItem({
      event: replyEvent,
      sessionId: 'ses_side',
      sentPrompt: '主会话小猫回复/续做指示（续做原事项，不要新开便签）：\n直接按方案 A 推进，保持默认 SQLite WAL 配置，不需要引入 Redis。\n\n沿用原事项的验收标准；完成后逐条给出证据。'
    });
    expect(defaultHtml).toContain('data-assistant-reply-bubble=""');
    expect(defaultHtml).toContain('data-assistant-reply-origin="assistant_reply"');
    expect(defaultHtml).toContain('ui-kitten-reply-bubble');
    expect(defaultHtml).toContain('🐾');
    expect(defaultHtml).toContain('小猫回复');
    expect(defaultHtml).toContain('来自主会话');
    expect(defaultHtml).toContain('主会话下发指令');
    expect(defaultHtml).toContain('直接按方案 A 推进');

    // 2) 在 QueryClientProvider 内自动读取当前认领小猫名
    const qc = new QueryClient();
    qc.setQueryData(['assistant-state'], { companion: { name: '小A同学', adoptedAt: '2026-11-28T00:00:00.000Z' } });
    const namedHtml = renderTimelineItem({ event: replyEvent, sessionId: 'ses_side' }, qc);
    expect(namedHtml).toContain('小A同学回复');
    expect(namedHtml).toContain('小猫回复 · 来自主会话');

    // 3) 支持 assistant_answer 与携带小猫名后缀的 origin
    const answerOriginHtml = renderTimelineItem({
      event: {
        ...replyEvent,
        id: 'u_cat_answer',
        data: { role: 'user', origin: `${ASSISTANT_ANSWER_ORIGIN}:布丁`, text: '已确认用暗色柔紫点缀。' }
      } as TimelineEvent,
      sessionId: 'ses_side'
    });
    expect(answerOriginHtml).toContain('布丁代答');
    expect(answerOriginHtml).toContain('已确认用暗色柔紫点缀');

    // 4) 时间线 Cmd+F 搜索可命中「小猫回复」与代答内容
    const turns = groupTimelineSections(buildTimelineSections([replyEvent]));
    expect(searchTimeline({ turns, query: '小猫回复' })).toHaveLength(1);
    expect(searchTimeline({ turns, query: 'SQLite WAL' })).toHaveLength(1);
  });
});
