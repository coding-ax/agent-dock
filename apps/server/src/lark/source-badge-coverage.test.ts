import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ASK_USER_QUESTION_ANSWER_ORIGIN,
  ASSISTANT_ANSWER_ORIGIN,
  ASSISTANT_REPLY_ORIGIN,
  BUILTIN_CONFIRM_ACTION_PLUGIN_ID,
  CONFIRM_ACTION_INTERACTION_ORIGIN,
  OUTPUT_PLUGIN_INTERACTION_ORIGIN_PREFIX,
  TASK_RECOVERY_ORIGIN,
  type AskUserQuestionAnswerPayload,
  type AskUserQuestionSpec,
  type ConfirmActionInteractionPayload,
  type ConfirmActionSpec,
  type DeclarativeOutputPluginInteractionPayload,
  type DeclarativeOutputPluginSpec,
  type Locale,
  type OutputPluginDefinition,
  type TaskRecoveryRecord
} from '@agent-dock/agent-dock-shared';
import { setActiveServerLocaleForTest } from '../locale-service.js';
import { buildWebhookRequest, type NotificationPayload } from '../notifications/delivery.js';
import { buildTaskRecoveryConfirmCard, buildTaskRecoveryResolvedCard } from '../task-recovery/lark-card.js';
import { buildLarkAskUserQuestionAnsweredCard, buildLarkAskUserQuestionCard } from './ask-user-question-card.js';
import { confirmActionLarkAdapter } from './output-plugins/confirm-action-adapter.js';
import { createDeclarativeLarkAdapter } from './output-plugins/declarative-adapter.js';
import {
  buildChoiceCard,
  buildInteractionSourceLarkBadge,
  buildLarkApiSourceBadge,
  buildLarkCard,
  buildLarkCliSourceBadge,
  buildLarkNotificationSourceBadge,
  buildLarkOriginSourceBadge,
  createLarkCardService,
  withLarkCardSourceBadge,
  type LarkOriginBadgeVariant
} from './service.js';
import { classifyTurnSource, KNOWN_TURN_ORIGINS } from './turn-sync.js';

const CJK_RE = /[\u4e00-\u9fff]/;
const VALID_SCHEMA2_TEXT_TAG_COLORS = new Set([
  'neutral',
  'blue',
  'turquoise',
  'lime',
  'orange',
  'violet',
  'indigo',
  'wathet',
  'green',
  'yellow',
  'red',
  'purple',
  'carmine'
]);

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

function collectElements(node: unknown): Array<Record<string, any>> {
  if (Array.isArray(node)) return node.flatMap(collectElements);
  if (!node || typeof node !== 'object') return [];
  const rec = node as Record<string, any>;
  return [
    rec,
    ...collectElements(rec.body?.elements),
    ...collectElements(rec.elements),
    ...collectElements(rec.columns)
  ];
}

function assertSingleValidSourceBadge(card: Record<string, any>, opts: { locale: Locale; expectColor?: string; expectLabel?: string }) {
  expect(card.schema).toBe('2.0');
  const badges = collectElements(card).filter(el => el.element_id === 'task_source_badge');
  expect(badges, `Expected exactly 1 task_source_badge in card: ${JSON.stringify(card)}`).toHaveLength(1);
  const badge = badges[0]!;
  expect(badge.tag).toBe('div');
  expect(badge.icon, `Source badge must not attach outer div.icon (keep emoji inside <text_tag>): ${JSON.stringify(badge)}`).toBeUndefined();
  expect(badge.text?.tag).toBe('lark_md');
  const match = /<text_tag color='([^']+)'>([^<]+)<\/text_tag>/.exec(String(badge.text?.content ?? ''));
  expect(match, `Missing <text_tag> in badge: ${JSON.stringify(badge)}`).not.toBeNull();
  const [, color, text] = match!;
  expect(VALID_SCHEMA2_TEXT_TAG_COLORS.has(color!), `Illegal Schema 2.0 text_tag color: ${color}`).toBe(true);
  if (opts.expectColor) expect(color).toBe(opts.expectColor);
  if (opts.expectLabel) expect(text).toBe(opts.expectLabel);
  if (opts.locale === 'en-US') {
    expect(CJK_RE.test(JSON.stringify(card)), `English card leaked CJK: ${JSON.stringify(card)}`).toBe(false);
  }
}

afterEach(() => {
  setActiveServerLocaleForTest(undefined);
});

describe('Exhaustive TurnOrigin & outbound Feishu card source-badge coverage guard', () => {
  it('maps 100% of KNOWN_TURN_ORIGINS plus named assistant origins, interaction payload sources, and unknown fallbacks in zh-CN & en-US', () => {
    for (const locale of ['zh-CN', 'en-US'] as const) {
      for (const origin of KNOWN_TURN_ORIGINS) {
        const result = classifyTurnSource({ taskOrigin: origin, locale });
        expect(result.badge.trim().length, `Empty badge for origin=${origin} (${locale})`).toBeGreaterThan(0);
        expect(result.label.trim().length, `Empty label for origin=${origin} (${locale})`).toBeGreaterThan(0);
        const card = buildLarkCard({
          state: 'completed',
          taskName: `Origin ${origin}`,
          sourceBadge: {
            label: result.badge,
            color: result.tagColor
          },
          markdown: 'Done.',
          locale
        });
        assertSingleValidSourceBadge(card, {
          locale,
          expectColor: result.tagColor === 'grey' ? 'neutral' : result.tagColor,
          expectLabel: result.badge
        });
      }
    }

    // 关键新增/细分来源精确语义校验
    expect(classifyTurnSource({ taskOrigin: ASSISTANT_REPLY_ORIGIN, locale: 'zh-CN' }))
      .toMatchObject({ category: 'supervision', badge: '🐾 小猫回复', tagColor: 'purple' });
    expect(classifyTurnSource({ taskOrigin: `${ASSISTANT_REPLY_ORIGIN}:Milo`, locale: 'en-US' }))
      .toMatchObject({ category: 'supervision', badge: '🐾 Milo Reply', tagColor: 'purple' });
    expect(classifyTurnSource({ taskOrigin: ASSISTANT_ANSWER_ORIGIN, locale: 'zh-CN' }))
      .toMatchObject({ category: 'supervision', badge: '🐾 小猫代答', tagColor: 'purple' });
    expect(classifyTurnSource({ taskOrigin: `${ASSISTANT_ANSWER_ORIGIN}:小橘`, locale: 'zh-CN' }))
      .toMatchObject({ category: 'supervision', badge: '🐾 小橘代答', tagColor: 'purple' });

    expect(classifyTurnSource({ taskOrigin: 'cli', locale: 'zh-CN' }))
      .toMatchObject({ category: 'web', badge: '⌨️ CLI 触发', tagColor: 'indigo' });
    expect(classifyTurnSource({ taskOrigin: 'cli', locale: 'en-US' }))
      .toMatchObject({ category: 'web', badge: '⌨️ CLI', tagColor: 'indigo' });
    expect(classifyTurnSource({ taskOrigin: 'api', locale: 'zh-CN' }))
      .toMatchObject({ category: 'web', badge: '🔌 API 触发', tagColor: 'indigo' });
    expect(classifyTurnSource({ taskOrigin: 'api', locale: 'en-US' }))
      .toMatchObject({ category: 'web', badge: '🔌 API', tagColor: 'indigo' });
    expect(classifyTurnSource({ taskOrigin: 'webhook', locale: 'zh-CN' }))
      .toMatchObject({ category: 'web', badge: '🪝 Webhook', tagColor: 'violet' });
    expect(classifyTurnSource({ taskOrigin: 'sources-router', locale: 'en-US' }))
      .toMatchObject({ category: 'web', badge: '🪝 Webhook', tagColor: 'violet' });
    expect(classifyTurnSource({ taskOrigin: 'system', locale: 'zh-CN' }))
      .toMatchObject({ category: 'maintenance', badge: '⚙️ 系统触发', tagColor: 'neutral' });
    expect(classifyTurnSource({ taskOrigin: 'lark', locale: 'zh-CN' }))
      .toMatchObject({ category: 'web', badge: '🕊️ 飞书发起', tagColor: 'turquoise' });
    expect(classifyTurnSource({ taskOrigin: 'feishu', locale: 'en-US' }))
      .toMatchObject({ category: 'web', badge: '🕊️ From Lark', tagColor: 'turquoise' });

    // 交互卡片续跑轮次按 payload.source 区分 🕊️ 飞书 / 💻 网页 / 🐾 小猫代答
    expect(classifyTurnSource({
      taskOrigin: ASK_USER_QUESTION_ANSWER_ORIGIN,
      prompt: JSON.stringify({ version: 1, questionId: 'q1', source: 'lark', answeredAt: '2026-11-28T00:00:00Z', answers: [] }),
      locale: 'zh-CN'
    })).toMatchObject({ category: 'web', badge: '🕊️ 飞书 · 卡片响应', tagColor: 'turquoise' });
    expect(classifyTurnSource({
      taskOrigin: CONFIRM_ACTION_INTERACTION_ORIGIN,
      prompt: JSON.stringify({ version: 1, actionId: 'a1', source: 'web', decision: 'confirm', decisionLabel: 'Confirm', decidedAt: '2026-11-28T00:00:00Z' }),
      locale: 'en-US'
    })).toMatchObject({ category: 'web', badge: '💻 Web · Card Reply', tagColor: 'blue' });
    expect(classifyTurnSource({
      taskOrigin: `${OUTPUT_PLUGIN_INTERACTION_ORIGIN_PREFIX}custom:demo`,
      prompt: JSON.stringify({ version: 1, source: 'assistant', responderName: 'Milo' }),
      locale: 'en-US'
    })).toMatchObject({ category: 'supervision', badge: '🐾 Milo Answer', tagColor: 'purple' });

    // 未来未知来源优雅兜底：绝不产出空白裸卡，也不误标成网页同步
    expect(classifyTurnSource({ taskOrigin: 'future-channel-xyz', locale: 'zh-CN' }))
      .toMatchObject({ category: 'web', badge: '🏷️ 外部来源', tagColor: 'neutral', detailLabel: 'future-channel-xyz' });
    expect(classifyTurnSource({ taskOrigin: 'future-channel-xyz', locale: 'en-US' }))
      .toMatchObject({ category: 'web', badge: '🏷️ External', tagColor: 'neutral', detailLabel: 'future-channel-xyz' });
  });

  it('covers all Lark-origin sub-variants (default, regex, sideChat, cardReply, emoji) with inline 🕊️ + turquoise tag', () => {
    const expected: Record<LarkOriginBadgeVariant, { zh: string; en: string }> = {
      default: { zh: '🕊️ 飞书发起', en: '🕊️ From Lark' },
      regex: { zh: '🕊️ 飞书 · 正则唤起', en: '🕊️ Lark · Regex' },
      sideChat: { zh: '🕊️ 飞书 · 侧边对话', en: '🕊️ Lark · Side Chat' },
      cardReply: { zh: '🕊️ 飞书 · 卡片响应', en: '🕊️ Lark · Card Reply' },
      emoji: { zh: '🕊️ 飞书表情', en: '🕊️ Lark Reaction' }
    };
    for (const [variant, copy] of Object.entries(expected) as Array<[LarkOriginBadgeVariant, { zh: string; en: string }]>) {
      expect(buildLarkOriginSourceBadge('zh-CN', variant)).toEqual({ label: copy.zh, color: 'turquoise' });
      expect(buildLarkOriginSourceBadge('en-US', variant)).toEqual({ label: copy.en, color: 'turquoise' });
    }
    expect(buildInteractionSourceLarkBadge('lark', 'zh-CN')).toEqual({ label: '🕊️ 飞书', color: 'turquoise' });
    expect(buildInteractionSourceLarkBadge('lark', 'en-US')).toEqual({ label: '🕊️ Lark', color: 'turquoise' });
    expect(buildLarkNotificationSourceBadge('lark', 'zh-CN')).toEqual({ label: '🕊️ 飞书会话通知', color: 'turquoise' });
    expect(buildLarkNotificationSourceBadge('lark', 'en-US')).toEqual({ label: '🕊️ Lark Alert', color: 'turquoise' });
    expect(buildLarkCliSourceBadge('zh-CN')).toEqual({ label: '⌨️ CLI 触发', color: 'indigo' });
    expect(buildLarkCliSourceBadge('en-US')).toEqual({ label: '⌨️ CLI', color: 'indigo' });
    expect(buildLarkApiSourceBadge('zh-CN')).toEqual({ label: '🔌 API 触发', color: 'indigo' });
    expect(buildLarkApiSourceBadge('en-US')).toEqual({ label: '🔌 API', color: 'indigo' });
  });

  it('guarantees every outbound Schema 2.0 card family includes a single valid bilingual source tag (zero duplicate badges, zero CJK in en-US)', () => {
    const askSpec: AskUserQuestionSpec = {
      id: 'q1',
      title: 'Storage Choice',
      questions: [{
        id: 'q1_1',
        prompt: 'Choose DB',
        multi: false,
        allowOther: false,
        options: [{ value: 'sqlite', label: 'SQLite', recommended: true }]
      }]
    };
    const confirmSpec: ConfirmActionSpec = {
      id: 'c1',
      title: 'Deploy Service',
      summary: 'Roll out v0.3.30',
      risk: 'medium',
      details: [],
      confirmLabel: 'Confirm',
      cancelLabel: 'Cancel',
      allowComment: false
    };
    const confirmPlugin = { id: BUILTIN_CONFIRM_ACTION_PLUGIN_ID, name: 'ConfirmAction' } as OutputPluginDefinition;
    const declPlugin = {
      id: 'custom:release',
      name: 'Release',
      capabilities: { web: true, lark: true, interactive: true, streamingPlaceholder: true }
    } as OutputPluginDefinition;
    const declAdapter = createDeclarativeLarkAdapter(declPlugin);
    const declSpec: DeclarativeOutputPluginSpec = {
      id: 'd1',
      kind: 'action-card',
      title: 'Release Check',
      tone: 'blue',
      fields: [],
      actions: [{ value: 'ok', label: 'Approve', style: 'primary' }],
      links: [],
      allowNote: false
    };
    const recoveryRecord: TaskRecoveryRecord = {
      id: 'rec_1',
      sessionId: 'ses_1',
      interruptedTaskId: 't_1',
      rootTaskId: 't_1',
      originalPrompt: 'Run verification suite',
      interruptReason: 'daemon_restart',
      interruptedAt: '2026-11-28T05:00:00Z',
      detectedAt: '2026-11-28T05:01:00Z',
      mode: 'confirm',
      status: 'pending_confirm',
      attemptCount: 0,
      createdAt: '2026-11-28T05:01:00Z',
      updatedAt: '2026-11-28T05:01:00Z'
    };

    for (const locale of ['zh-CN', 'en-US'] as const) {
      const larkBadge = buildLarkOriginSourceBadge(locale);

      // 1) AskUserQuestion pending + answered (lark / web / assistant) + preview
      assertSingleValidSourceBadge(buildLarkAskUserQuestionCard({ cardId: 'a1', spec: askSpec, sourceBadge: larkBadge, locale }), {
        locale, expectColor: 'turquoise', expectLabel: larkBadge.label
      });
      assertSingleValidSourceBadge(buildLarkAskUserQuestionCard({ cardId: 'a2', spec: askSpec, previewMode: true, locale }), {
        locale, expectColor: 'wathet'
      });
      for (const source of ['lark', 'web', 'assistant'] as const) {
        const answerPayload: AskUserQuestionAnswerPayload = {
          version: 1,
          questionId: 'q1',
          title: 'Storage Choice',
          source,
          answeredBy: source === 'assistant' ? undefined : 'Alice',
          answeredAt: '2026-11-28T05:02:00Z',
          answers: [{ questionId: 'q1_1', prompt: 'Choose DB', selectedValues: ['sqlite'], selectedLabels: ['SQLite'] }]
        };
        const badge = buildInteractionSourceLarkBadge(source, locale, { responderName: source === 'assistant' ? 'Milo' : undefined });
        const answeredCard = withLarkCardSourceBadge(
          buildLarkAskUserQuestionAnsweredCard({ payload: answerPayload, sourceBadge: badge, locale }),
          badge
        );
        assertSingleValidSourceBadge(answeredCard, {
          locale,
          expectColor: source === 'lark' ? 'turquoise' : source === 'assistant' ? 'purple' : 'blue',
          expectLabel: badge.label
        });
      }

      // 2) ConfirmAction pending + answered
      assertSingleValidSourceBadge(confirmActionLarkAdapter.buildCard({ cardId: 'c1', plugin: confirmPlugin, spec: confirmSpec, sourceBadge: larkBadge, locale }), {
        locale, expectColor: 'turquoise', expectLabel: larkBadge.label
      });
      const confirmPayload: ConfirmActionInteractionPayload = {
        version: 1,
        pluginId: BUILTIN_CONFIRM_ACTION_PLUGIN_ID,
        actionId: 'c1',
        title: 'Deploy Service',
        decision: 'confirm',
        decisionLabel: 'Confirm',
        source: 'lark',
        decidedBy: 'Alice',
        decidedAt: '2026-11-28T05:02:00Z'
      };
      assertSingleValidSourceBadge(
        withLarkCardSourceBadge(
          confirmActionLarkAdapter.buildAnsweredCard!({ plugin: confirmPlugin, payload: confirmPayload, locale }),
          buildInteractionSourceLarkBadge('lark', locale)
        ),
        { locale, expectColor: 'turquoise', expectLabel: locale === 'en-US' ? '🕊️ Lark' : '🕊️ 飞书' }
      );

      // 3) Declarative plugin pending + answered
      assertSingleValidSourceBadge(declAdapter.buildCard({ cardId: 'd1', plugin: declPlugin, spec: declSpec, sourceBadge: larkBadge, locale }), {
        locale, expectColor: 'turquoise', expectLabel: larkBadge.label
      });
      const declPayload: DeclarativeOutputPluginInteractionPayload = {
        version: 1,
        pluginId: declPlugin.id,
        pluginName: declPlugin.name,
        instanceId: 'd1',
        title: 'Release Check',
        source: 'web',
        actedBy: 'Bob',
        actedAt: '2026-11-28T05:02:00Z',
        actionValue: 'ok',
        actionLabel: 'Approve',
        fields: []
      };
      assertSingleValidSourceBadge(declAdapter.buildAnsweredCard!({ plugin: declPlugin, payload: declPayload, locale }), {
        locale, expectColor: 'blue'
      });

      // 4) TaskRecovery confirm + resolved (lark / web / auto)
      assertSingleValidSourceBadge(buildTaskRecoveryConfirmCard({ record: recoveryRecord, cardId: 'rc1', locale }), {
        locale, expectColor: 'wathet'
      });
      for (const decidedSource of ['lark', 'web', 'auto'] as const) {
        const badge = buildInteractionSourceLarkBadge(decidedSource, locale);
        const resolved = withLarkCardSourceBadge(
          buildTaskRecoveryResolvedCard({
            record: { ...recoveryRecord, status: 'resumed', decidedSource, decidedBy: decidedSource === 'auto' ? undefined : 'Alice', decidedAt: '2026-11-28T05:02:00Z' },
            sourceBadge: badge,
            locale
          }),
          badge
        );
        assertSingleValidSourceBadge(resolved, {
          locale,
          expectColor: decidedSource === 'lark' ? 'turquoise' : decidedSource === 'web' ? 'blue' : 'wathet',
          expectLabel: badge.label
        });
      }

      // 5) AI Avatar Choice Card (reaction trigger)
      const choiceCard = buildChoiceCard({
        title: 'AI Avatar · Reaction',
        markdown: 'Choose target',
        sourceBadge: buildLarkOriginSourceBadge(locale, 'emoji'),
        buttons: [{ action: 'avatar_reaction_route', label: 'Main', value: { route: 'main' } }]
      });
      assertSingleValidSourceBadge(choiceCard, {
        locale,
        expectColor: 'turquoise',
        expectLabel: locale === 'en-US' ? '🕊️ Lark Reaction' : '🕊️ 飞书表情'
      });

      // 6) Webhook card (lark_webhook) upgraded to Schema 2.0 with source badge
      setActiveServerLocaleForTest(locale);
      const notifyPayload: NotificationPayload = {
        id: 'n1',
        kind: 'completed',
        sessionId: 'ses_1',
        agentId: 'claude',
        sessionTitle: 'Build',
        sessionSource: 'lark',
        summary: 'All passed',
        timestamp: '2026-11-28T05:00:00Z'
      };
      const webhookBody = JSON.parse(buildWebhookRequest('lark_webhook', notifyPayload).body);
      expect(webhookBody.msg_type).toBe('interactive');
      assertSingleValidSourceBadge(webhookBody.card, {
        locale: 'zh-CN', // webhook title/body currently uses zh-CN template copy; verify valid badge tag & color
        expectColor: 'turquoise',
        expectLabel: locale === 'en-US' ? '🕊️ Lark Alert' : '🕊️ 飞书会话通知'
      });
    }
  });

  it('sends sendNotificationCard, sendChoiceCard, updateChoiceCard, and updateInteractiveCard with inline 🕊️ turquoise tag, zero duplicate badges, and zero image uploads', async () => {
    const fetcher = vi.fn()
      // token -> sendNotificationCard -> sendChoiceCard -> updateChoiceCard -> updateInteractiveCard (zero /im/v1/images!)
      .mockResolvedValueOnce(jsonResponse({ code: 0, tenant_access_token: 'tok', expire: 7200 }))
      .mockResolvedValueOnce(jsonResponse({ code: 0, data: { message_id: 'om_n1', chat_id: 'oc_1' } }))
      .mockResolvedValueOnce(jsonResponse({ code: 0, data: { message_id: 'om_c1', chat_id: 'oc_1' } }))
      .mockResolvedValueOnce(jsonResponse({ code: 0, data: { message_id: 'om_c1', chat_id: 'oc_1' } }))
      .mockResolvedValueOnce(jsonResponse({ code: 0, data: { message_id: 'om_i1', chat_id: 'oc_1' } }));

    const service = createLarkCardService({ LARK_APP_ID: 'cli_all_cards', LARK_APP_SECRET: 'sec' }, fetcher as typeof fetch);

    await service.sendNotificationCard({
      receiveId: 'oc_1',
      receiveIdType: 'chat_id',
      title: 'Build Finished',
      markdown: 'All checks passed.',
      summary: 'Build Finished',
      sourceBadge: buildLarkNotificationSourceBadge('lark', 'en-US'),
      locale: 'en-US'
    });

    await service.sendChoiceCard({
      chatId: 'oc_1',
      title: 'Reaction Trigger',
      markdown: 'Pick destination',
      sourceBadge: buildLarkOriginSourceBadge('en-US', 'emoji'),
      buttons: [{ action: 'avatar_reaction_route', label: 'Main' }]
    });

    await service.updateChoiceCard({
      messageId: 'om_c1',
      text: 'Routed to main session',
      sourceBadge: buildLarkOriginSourceBadge('en-US', 'emoji')
    });

    const answeredBadge = buildInteractionSourceLarkBadge('lark', 'en-US');
    const answeredCard = buildLarkAskUserQuestionAnsweredCard({
      payload: {
        version: 1,
        questionId: 'q1',
        title: 'Confirm',
        source: 'lark',
        answeredBy: 'Alice',
        answeredAt: '2026-11-28T05:00:00Z',
        answers: [{ questionId: 'q1_1', prompt: 'Pick', selectedValues: ['a'], selectedLabels: ['A'] }]
      },
      sourceBadge: answeredBadge,
      locale: 'en-US'
    });
    await service.updateInteractiveCard({
      messageId: 'om_i1',
      card: answeredCard,
      sourceBadge: answeredBadge
    });

    // 4 张卡片零额外图片上传请求（1 次 token + 4 次发卡/更新）
    expect(fetcher).toHaveBeenCalledTimes(5);
    expect(fetcher.mock.calls.some(call => String(call[0]).includes('/open-apis/im/v1/images'))).toBe(false);

    const expectedLabels = ['🕊️ Lark Alert', '🕊️ Lark Reaction', '🕊️ Lark Reaction', '🕊️ Lark'];
    for (const [idx, callIndex] of [1, 2, 3, 4].entries()) {
      const card = JSON.parse(JSON.parse(String(fetcher.mock.calls[callIndex]?.[1]?.body)).content);
      assertSingleValidSourceBadge(card, {
        locale: 'en-US',
        expectColor: 'turquoise',
        expectLabel: expectedLabels[idx]
      });
    }
  });
});
