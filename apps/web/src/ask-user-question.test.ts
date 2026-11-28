import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  ASK_USER_QUESTION_ANSWER_ORIGIN,
  resolveAskUserQuestionEnabled,
  serializeAskUserQuestionAnswer,
  type AskUserQuestionAnswerPayload
} from '@agent-dock/agent-dock-shared';
import { Composer } from './Composer';
import { DraftComposer } from './DraftComposer';
import { TooltipProvider } from './HoverTooltip';
import { ActivityPanel, TimelineItem } from './TimelineItems';
import { detectInjectionTags } from './bubble-injection';
import {
  EMPTY_DRAFT_COMPOSER_PREFS,
  normalizeDraftComposerPrefs,
  withDraftAskUserQuestionEnabled
} from './last-used-prefs';
import { buildTimelineSections, groupTimelineSections, type TimelineEvent } from './timeline';
import { searchTimeline } from './timeline-search';

const renderTimelineItem = (props: Parameters<typeof TimelineItem>[0]) =>
  renderToStaticMarkup(createElement(TooltipProvider, null, createElement(TimelineItem, props)));

const sampleXml = `已整理完两个方案，请确认你的偏好：

<agentdock-ask-user-question id="ask_storage" title="选择存储方案">
  <question id="q1" multi="false" allow-other="true">
    <prompt>你希望使用哪种数据库？</prompt>
    <option value="sqlite" recommended="true" description="内置零运维，轻量单文件">SQLite</option>
    <option value="postgres" description="适合多实例扩展">PostgreSQL</option>
  </question>
</agentdock-ask-user-question>`;

const sampleAssistantEvent: TimelineEvent = {
  id: 'a1',
  sequence: 2,
  type: 'text',
  timestamp: '2026-11-27T05:00:00.000Z',
  data: { role: 'assistant', text: sampleXml }
} as TimelineEvent;

const sampleWebAnswerPayload: AskUserQuestionAnswerPayload = {
  version: 1,
  questionId: 'ask_storage',
  title: '选择存储方案',
  source: 'web',
  answeredAt: '2026-11-27T05:01:00.000Z',
  answers: [{
    questionId: 'q1',
    prompt: '你希望使用哪种数据库？',
    selectedValues: ['sqlite'],
    selectedLabels: ['SQLite'],
    otherText: '开启 WAL 模式'
  }]
};

const sampleLarkAnswerPayload: AskUserQuestionAnswerPayload = {
  version: 1,
  questionId: 'ask_storage',
  title: '选择存储方案',
  source: 'lark',
  answeredBy: '暮雪离歌',
  answeredAt: '2026-11-27T05:01:00.000Z',
  answers: [{
    questionId: 'q1',
    prompt: '你希望使用哪种数据库？',
    selectedValues: ['postgres'],
    selectedLabels: ['PostgreSQL']
  }]
};

describe('AskUserQuestion frontend rendering', () => {
  it('renders interactive card for trailing XML with recommended badge, description, and other option', () => {
    const html = renderTimelineItem({
      event: sampleAssistantEvent,
      final: true,
      replay: true,
      sessionId: 'ses_1',
      askUserQuestionXmlEnabled: true,
      onSubmitAskAnswer: () => undefined
    });

    expect(html).toContain('已整理完两个方案，请确认你的偏好：');
    expect(html).toContain('data-ask-card-state="pending"');
    expect(html).toContain('选择存储方案');
    expect(html).toContain('你希望使用哪种数据库？');
    expect(html).toContain('SQLite');
    expect(html).toContain('推荐');
    expect(html).toContain('内置零运维，轻量单文件');
    expect(html).toContain('其他 / 自定义回答');
    expect(html).toContain('提交回答');
    expect(html).not.toContain('&lt;agentdock-ask-user-question');
  });

  it('locks the original card into read-only answered state when answered from Web or Lark', () => {
    const answeredMap = new Map([['ask_storage', sampleLarkAnswerPayload]]);
    const html = renderTimelineItem({
      event: sampleAssistantEvent,
      final: true,
      replay: true,
      sessionId: 'ses_1',
      askUserQuestionXmlEnabled: true,
      askAnswersByQuestionId: answeredMap
    });

    expect(html).toContain('data-ask-card-state="answered"');
    expect(html).toContain('已回答');
    expect(html).toContain('飞书 · 暮雪离歌');
    expect(html).toContain('PostgreSQL');
    expect(html).not.toContain('data-ask-submit');
  });

  it('renders bespoke Q&A answer turn cards distinguishing Web and Lark sources', () => {
    const webAnswerEvent: TimelineEvent = {
      id: 'u_ans_web',
      sequence: 3,
      type: 'text',
      timestamp: '2026-11-27T05:01:00.000Z',
      data: {
        role: 'user',
        origin: ASK_USER_QUESTION_ANSWER_ORIGIN,
        text: serializeAskUserQuestionAnswer(sampleWebAnswerPayload)
      }
    } as TimelineEvent;

    const webHtml = renderTimelineItem({ event: webAnswerEvent, sessionId: 'ses_1' });
    expect(webHtml).toContain('data-ask-answer-card=""');
    expect(webHtml).toContain('data-ask-answer-source="web"');
    expect(webHtml).toContain('已回复询问');
    expect(webHtml).toContain('网页端');
    expect(webHtml).toContain('你希望使用哪种数据库？');
    expect(webHtml).toContain('SQLite');
    expect(webHtml).toContain('开启 WAL 模式');
    expect(webHtml).not.toContain('selectedValues');

    const larkAnswerEvent: TimelineEvent = {
      id: 'u_ans_lark',
      sequence: 4,
      type: 'text',
      timestamp: '2026-11-27T05:02:00.000Z',
      data: {
        role: 'user',
        origin: ASK_USER_QUESTION_ANSWER_ORIGIN,
        text: serializeAskUserQuestionAnswer(sampleLarkAnswerPayload)
      }
    } as TimelineEvent;

    const larkHtml = renderTimelineItem({ event: larkAnswerEvent, sessionId: 'ses_1' });
    expect(larkHtml).toContain('data-ask-answer-source="lark"');
    expect(larkHtml).toContain('飞书 · 暮雪离歌');
    expect(larkHtml).toContain('PostgreSQL');
  });

  it('hides incomplete streaming XML behind a smooth placeholder in both TimelineItem and ActivityPanel', () => {
    const streamingEvent: TimelineEvent = {
      id: 'a_stream',
      sequence: 5,
      type: 'text',
      timestamp: '2026-11-27T05:03:00.000Z',
      data: {
        role: 'assistant',
        text: '先看结论。\n\n<agentdock-ask-user-question id="s1" title="部署策略">\n  <question><prompt>选'
      }
    } as TimelineEvent;

    const itemHtml = renderTimelineItem({
      event: streamingEvent,
      streaming: true,
      replay: true,
      sessionId: 'ses_1',
      askUserQuestionXmlEnabled: true
    });
    expect(itemHtml).toContain('data-ask-streaming-placeholder=""');
    expect(itemHtml).toContain('正在生成「部署策略」选项…');
    expect(itemHtml).not.toContain('agentdock-ask-user-question');

    const panelHtml = renderToStaticMarkup(
      createElement(TooltipProvider, null, createElement(ActivityPanel, {
        groups: [{
          id: 'g1',
          label: '执行过程',
          labelTitle: '执行过程',
          events: [streamingEvent],
          startedAt: '2026-11-27T05:03:00.000Z'
        }],
        ongoing: true,
        replay: true,
        sessionId: 'ses_1',
        modelLabel: 'Codex',
        askUserQuestionXmlEnabled: true
      }))
    );
    expect(panelHtml).toContain('data-ask-streaming-placeholder=""');
    expect(panelHtml).not.toContain('agentdock-ask-user-question');
  });

  it('respects global switch OFF and ignores XML inside markdown code blocks', () => {
    const disabledHtml = renderTimelineItem({
      event: sampleAssistantEvent,
      final: true,
      replay: true,
      sessionId: 'ses_1',
      askUserQuestionXmlEnabled: false
    });
    expect(disabledHtml).not.toContain('data-ask-card=""');

    const codeFenceEvent: TimelineEvent = {
      id: 'a_code',
      sequence: 6,
      type: 'text',
      timestamp: '2026-11-27T05:04:00.000Z',
      data: {
        role: 'assistant',
        text: `协议示例：\n\n\`\`\`xml\n<agentdock-ask-user-question id="demo"><question id="q1"><prompt>示例</prompt><option value="a">A</option></question></agentdock-ask-user-question>\n\`\`\``
      }
    } as TimelineEvent;

    const codeFenceHtml = renderTimelineItem({
      event: codeFenceEvent,
      final: true,
      replay: true,
      sessionId: 'ses_1',
      askUserQuestionXmlEnabled: true
    });
    expect(codeFenceHtml).not.toContain('data-ask-card=""');
  });

  it('indexes readable Q&A text for timeline search and tags injected protocol in bubble-injection', () => {
    const timeline: TimelineEvent[] = [
      { id: 'u1', sequence: 1, type: 'text', timestamp: '2026-11-27T05:00:00.000Z', data: { role: 'user', text: '选数据库' } } as TimelineEvent,
      sampleAssistantEvent,
      {
        id: 'u2',
        sequence: 3,
        type: 'text',
        timestamp: '2026-11-27T05:01:00.000Z',
        data: { role: 'user', origin: ASK_USER_QUESTION_ANSWER_ORIGIN, text: serializeAskUserQuestionAnswer(sampleWebAnswerPayload) }
      } as TimelineEvent
    ];
    const turns = groupTimelineSections(buildTimelineSections(timeline));

    expect(searchTimeline({ turns, query: '开启 WAL 模式' })).toHaveLength(1);
    expect(searchTimeline({ turns, query: 'selectedValues' })).toHaveLength(0);
    expect(detectInjectionTags('[AgentDock 用户询问卡片协议]\n...')).toContain('询问卡片协议');
  });

  it('renders Composer and DraftComposer per-session AskUserQuestion toggles with accessible states and prefs persistence', () => {
    const baseComposerProps: Parameters<typeof Composer>[0] = {
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
    };

    const onHtml = renderToStaticMarkup(createElement(TooltipProvider, null, createElement(Composer, {
      ...baseComposerProps,
      askUserQuestionEnabled: true,
      askUserQuestionOverride: null,
      askUserQuestionJustSwitched: true,
      onToggleAskUserQuestion: () => undefined
    })));
    expect(onHtml).toContain('data-testid="composer-output-plugins-trigger"');
    expect(onHtml).toContain('data-state="on"');
    expect(onHtml).toContain('data-enabled-count="1"');
    expect(onHtml).toContain('data-override-count="0"');
    expect(onHtml).toContain('交互插件：本会话已启用 1 / 1 · 跟随全局');
    expect(onHtml).toContain('ui-icon-pop');
    // 严格遵守 tooltip-consistency：绝不在该按钮上渲染原生 title
    expect(onHtml).not.toMatch(/data-testid="composer-output-plugins-trigger"[^>]*title="/);

    const offHtml = renderToStaticMarkup(createElement(TooltipProvider, null, createElement(Composer, {
      ...baseComposerProps,
      askUserQuestionEnabled: false,
      askUserQuestionOverride: false,
      onToggleAskUserQuestion: () => undefined
    })));
    expect(offHtml).toContain('data-state="off"');
    expect(offHtml).toContain('data-enabled-count="0"');
    expect(offHtml).toContain('data-override-count="1"');
    expect(offHtml).toContain('交互插件：本会话已启用 0 / 1（含 1 项独立覆写）');

    // DraftComposer 草稿栏默认继承全局开关（支持传入全局 false / true）
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const draftHtml = renderToStaticMarkup(
      createElement(QueryClientProvider, { client: qc },
        createElement(TooltipProvider, null,
          createElement(DraftComposer, {
            agents: [{ id: 'codex', name: 'Codex', command: 'codex', args: [], protocol: 'acp', env: {}, permissionMode: 'full-trust', timeout: 600, capabilities: { pause: false, resume: true }, builtin: true }],
            sessions: [],
            askUserQuestionXmlEnabled: false,
            onCreated: () => undefined
          })
        )
      )
    );
    expect(draftHtml).toContain('data-testid="composer-output-plugins-trigger"');
    // 内置插件 #1 ask-user-question 关闭，内置插件 #2 confirm-action 仍默认开启，内置插件 #3 rich-blocks 默认关闭（1 / 3）
    expect(draftHtml).toContain('data-state="on"');
    expect(draftHtml).toContain('data-enabled-count="1"');
    expect(draftHtml).toContain('交互插件：新会话已启用 1 / 3');

    // 草稿偏好覆写与恢复跟随全局
    const overridden = withDraftAskUserQuestionEnabled(EMPTY_DRAFT_COMPOSER_PREFS, false);
    expect(overridden.askUserQuestionEnabled).toBe(false);
    expect(normalizeDraftComposerPrefs(overridden).askUserQuestionEnabled).toBe(false);
    const reset = withDraftAskUserQuestionEnabled(overridden, undefined);
    expect(reset.askUserQuestionEnabled).toBeUndefined();

    // 会话级关闭即时生效：同会话内不再把末尾 XML 渲染为交互卡片
    const sessionDisabled = resolveAskUserQuestionEnabled(false, true);
    expect(sessionDisabled).toBe(false);
    const rawHtml = renderTimelineItem({
      event: sampleAssistantEvent,
      final: true,
      replay: true,
      sessionId: 'ses_1',
      askUserQuestionXmlEnabled: sessionDisabled
    });
    expect(rawHtml).not.toContain('data-ask-card=""');
  });
});
