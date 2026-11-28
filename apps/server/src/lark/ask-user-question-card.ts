import {
  fnv1aHex,
  formatInteractionSourceBadge,
  tShared,
  type AskUserQuestionAnswerItem,
  type AskUserQuestionAnswerPayload,
  type AskUserQuestionOption,
  type AskUserQuestionSpec,
  type Locale
} from '@agent-dock/agent-dock-shared';
import { getActiveServerLocale } from '../locale-service.js';
import { webAccessSessionToken } from '../web-access.js';
import {
  buildInteractionSourceLarkBadge,
  buildLarkInteractiveDefaultSourceBadge,
  buildLarkSourceBadgeElement,
  type LarkCardSourceBadge
} from './service.js';

export const LARK_ASK_CARD_CHANNEL = 'ask-user-question:lark-card';

export const LARK_ASK_ACTION_PICK = 'ask_user_question_pick';
export const LARK_ASK_ACTION_OTHER = 'ask_user_question_other';
export const LARK_ASK_ACTION_SUBMIT = 'ask_user_question_submit';
export const LARK_ASK_ACTION_PREVIEW = 'ask_user_question_preview';

export const LARK_ASK_ACTIONS = new Set([
  LARK_ASK_ACTION_PICK,
  LARK_ASK_ACTION_OTHER,
  LARK_ASK_ACTION_SUBMIT,
  LARK_ASK_ACTION_PREVIEW
]);

export function isLarkAskUserQuestionAction(action: string): boolean {
  return LARK_ASK_ACTIONS.has(action);
}

export interface PersistedLarkAskCard {
  cardId: string;
  appId: string;
  chatId: string;
  chatType: string;
  messageId: string;
  replyToMessageId?: string;
  replyInThread?: boolean;
  threadId?: string;
  rootId?: string;
  sessionId: string;
  taskId?: string;
  questionId: string;
  spec: AskUserQuestionSpec;
  webBaseUrl?: string;
  createdAt: string;
}

export interface BuildLarkAskCardInput {
  cardId: string;
  spec: AskUserQuestionSpec;
  sessionId?: string;
  webBaseUrl?: string;
  /** 仅用于样式预览卡（如 "【AskUserQuestion 样式预览】"）。 */
  previewBanner?: string;
  previewMode?: boolean;
  sourceBadge?: LarkCardSourceBadge;
  locale?: Locale;
}

export interface BuildLarkAskAnsweredCardInput {
  payload: AskUserQuestionAnswerPayload;
  sessionId?: string;
  webBaseUrl?: string;
  previewBanner?: string;
  sourceBadge?: LarkCardSourceBadge;
  locale?: Locale;
}

export const formSelectFieldName = (index: number) => `q_${index}_sel`;
export const formOtherFieldName = (index: number) => `q_${index}_other`;

export const MAX_LARK_QUICK_PICK_BUTTONS = 8;
export const MAX_LARK_SELECT_OPTIONS = 50;
export const MAX_LARK_OPTION_VALUE_LENGTH = 80;
const MAX_LARK_OPTION_LABEL_LENGTH = 60;
const MAX_LARK_SPEC_DESCRIPTION_LENGTH = 400;
const MAX_LARK_QUESTION_PROMPT_LENGTH = 300;
const MAX_LARK_OPTION_DESC_LABEL_LENGTH = 80;
const MAX_LARK_OPTION_DESC_LENGTH = 260;
const MAX_LARK_ANSWER_OTHER_TEXT_LENGTH = 800;
export const MAX_LARK_ASK_CARD_BYTES = 24_000;

/**
 * 为飞书 Schema 2.0 按钮回调值与 `select_static` / `multi_select_static` 选项值做安全长度编码：
 * - 长度 <= 80 时保持原值不变（100% 兼容既有交互回调）；
 * - 超长值折叠为确定性短键 `__opt_<idx>_<hash>`，避免触发飞书 `230099` / Schema 长度限制，
 *   回调解析阶段可无损还原回原始 `option.value`。
 */
export function encodeLarkAskOptionValue(rawValue: string, index: number): string {
  const trimmed = rawValue.trim();
  if (trimmed.length > 0 && trimmed.length <= MAX_LARK_OPTION_VALUE_LENGTH) {
    return trimmed;
  }
  return `__opt_${index}_${fnv1aHex(trimmed || String(index))}`;
}

function buildQuestionOptionLookup(options: AskUserQuestionOption[]): Map<string, AskUserQuestionOption> {
  const map = new Map<string, AskUserQuestionOption>();
  options.forEach((opt, idx) => {
    map.set(opt.value, opt);
    const encoded = encodeLarkAskOptionValue(opt.value, idx);
    if (!map.has(encoded)) map.set(encoded, opt);
  });
  return map;
}

function truncatePlain(value: string, maxLength: number): string {
  const clean = value.replace(/\s+/g, ' ').trim();
  if (clean.length <= maxLength) return clean;
  return `${clean.slice(0, Math.max(1, maxLength - 1))}…`;
}

function escapeLarkInlineMd(value: string): string {
  return value
    .replace(/[\r\n]+/g, ' ')
    .replace(/([\\`*_[\]<>~|])/g, '\\$1')
    .trim();
}

function escapeLarkTagText(value: string, locale: Locale): string {
  return truncatePlain(value.replace(/[<>&'"]/g, ''), 40) || tShared(locale, 'lark.ask.selectedFallback');
}

function formatOptionLabel(option: AskUserQuestionOption, locale: Locale): string {
  const label = truncatePlain(option.label, 38);
  if (!option.recommended) return truncatePlain(label, MAX_LARK_OPTION_LABEL_LENGTH);
  const formatted = /推荐|recommended/i.test(label)
    ? `★ ${label}`
    : tShared(locale, 'lark.ask.recommendedSuffix', { label });
  return truncatePlain(formatted, MAX_LARK_OPTION_LABEL_LENGTH);
}

function buildWebSessionFooter(locale: Locale, sessionId?: string, webBaseUrl?: string): Array<Record<string, unknown>> {
  if (!webBaseUrl) return [];
  const base = webBaseUrl.replace(/\/$/, '');
  let url = sessionId ? `${base}/sessions/${sessionId}` : `${base}/sessions`;
  const token = sessionId ? webAccessSessionToken(sessionId) : undefined;
  if (token) url += `?t=${token}`;
  return [{
    tag: 'markdown',
    content: `<font color='grey'>[${tShared(locale, 'lark.card.footer.viewSession')}](${url})</font>`,
    text_size: 'x-small',
    margin: '6px 0px 0px 0px'
  }];
}

function buildOptionDescriptionsMarkdown(
  options: AskUserQuestionOption[],
  locale: Locale,
  maxDescLength: number = MAX_LARK_OPTION_DESC_LENGTH
): string | undefined {
  if (maxDescLength <= 0) return undefined;
  const described = options.filter(opt => Boolean(opt.description?.trim()));
  if (!described.length) return undefined;
  const sep = locale === 'en-US' ? ': ' : '：';
  return described.map(opt => {
    const rec = opt.recommended ? ` <text_tag color='blue'>${tShared(locale, 'lark.ask.recommendedTag')}</text_tag>` : '';
    const labelMd = escapeLarkInlineMd(truncatePlain(opt.label, MAX_LARK_OPTION_DESC_LABEL_LENGTH));
    const descMd = escapeLarkInlineMd(truncatePlain(opt.description!, maxDescLength));
    return `• **${labelMd}**${rec}${sep}<font color='grey'>${descMd}</font>`;
  }).join('\n');
}

function renderLarkAskUserQuestionCard(
  input: BuildLarkAskCardInput,
  limits: { maxSpecDesc: number; maxOptDesc: number; omitOptDesc: boolean }
): Record<string, unknown> {
  const { cardId, spec, sessionId, webBaseUrl, previewBanner, previewMode } = input;
  const locale = input.locale ?? getActiveServerLocale();
  const isSingleQuickPick = spec.questions.length === 1
    && !spec.questions[0]!.multi
    && spec.questions[0]!.options.length > 0
    && spec.questions[0]!.options.length <= MAX_LARK_QUICK_PICK_BUTTONS;

  const baseTitle = spec.title?.trim() || (isSingleQuickPick ? tShared(locale, 'lark.ask.defaultTitleSingle') : tShared(locale, 'lark.ask.defaultTitleMulti'));
  const title = previewBanner ? `${previewBanner} ${baseTitle}` : baseTitle;
  const subtitle = previewMode
    ? tShared(locale, 'lark.ask.subtitlePreview')
    : isSingleQuickPick
      ? tShared(locale, 'lark.ask.subtitleSingle')
      : spec.questions.length > 1
        ? tShared(locale, 'lark.ask.subtitleMulti', { count: spec.questions.length })
        : tShared(locale, 'lark.ask.subtitleCustom');

  const summarySep = locale === 'en-US' ? ': ' : '：';
  const summary = truncatePlain(
    `${title}${summarySep}${spec.questions[0]?.prompt ?? tShared(locale, 'lark.ask.summaryFallback')}`,
    110
  );

  const elements: Array<Record<string, unknown>> = [];
  const badgeEl = buildLarkSourceBadgeElement(
    input.sourceBadge ?? buildLarkInteractiveDefaultSourceBadge(locale, Boolean(previewMode)),
    { margin: '0px 0px 4px 0px' }
  );
  if (badgeEl) elements.push(badgeEl);

  if (spec.description?.trim() && limits.maxSpecDesc > 0) {
    elements.push({
      tag: 'markdown',
      content: `<font color='grey'>${escapeLarkInlineMd(truncatePlain(spec.description, limits.maxSpecDesc))}</font>`,
      text_size: 'notation',
      margin: '0px 0px 4px 0px'
    });
  }

  if (isSingleQuickPick) {
    const question = spec.questions[0]!;
    elements.push({
      tag: 'markdown',
      content: `**${escapeLarkInlineMd(truncatePlain(question.prompt, MAX_LARK_QUESTION_PROMPT_LENGTH))}**`,
      text_size: 'normal_v2',
      margin: '0px 0px 4px 0px'
    });

    const descMd = limits.omitOptDesc
      ? undefined
      : buildOptionDescriptionsMarkdown(question.options, locale, limits.maxOptDesc);
    if (descMd) {
      elements.push({
        tag: 'markdown',
        content: descMd,
        text_size: 'notation',
        margin: '0px 0px 8px 0px'
      });
    }

    question.options.forEach((option, optIdx) => {
      elements.push({
        tag: 'button',
        element_id: `askq_opt_${optIdx}`,
        text: { tag: 'plain_text', content: formatOptionLabel(option, locale) },
        type: option.recommended ? 'primary' : 'default',
        width: 'fill',
        margin: optIdx === 0 ? '4px 0px 0px 0px' : '6px 0px 0px 0px',
        behaviors: [{
          type: 'callback',
          value: {
            action: previewMode ? LARK_ASK_ACTION_PREVIEW : LARK_ASK_ACTION_PICK,
            card_id: cardId,
            question_id: question.id,
            option_value: encodeLarkAskOptionValue(option.value, optIdx)
          }
        }]
      });
    });

    if (question.allowOther) {
      elements.push({ tag: 'hr', margin: '10px 0px 8px 0px' });
      elements.push({
        tag: 'form',
        name: 'askq_other_form',
        element_id: 'askq_other_form',
        direction: 'vertical',
        vertical_spacing: '8px',
        elements: [
          {
            tag: 'input',
            name: 'other_text',
            width: 'fill',
            label: { tag: 'plain_text', content: tShared(locale, 'lark.ask.otherLabel') },
            label_position: 'top',
            placeholder: {
              tag: 'plain_text',
              content: truncatePlain(question.otherPlaceholder || tShared(locale, 'lark.ask.otherPlaceholder'), 60)
            },
            required: true
          },
          {
            tag: 'button',
            name: 'askq_other_submit',
            form_action_type: 'submit',
            type: 'default',
            width: 'fill',
            text: { tag: 'plain_text', content: tShared(locale, 'lark.ask.otherSubmit') },
            behaviors: [{
              type: 'callback',
              value: {
                action: previewMode ? LARK_ASK_ACTION_PREVIEW : LARK_ASK_ACTION_OTHER,
                card_id: cardId,
                question_id: question.id
              }
            }]
          }
        ]
      });
    }
  } else {
    const formElements: Array<Record<string, unknown>> = [];

    spec.questions.forEach((question, index) => {
      if (index > 0) {
        formElements.push({ tag: 'hr', margin: '4px 0px' });
      }
      const boundedOptions = question.options.slice(0, MAX_LARK_SELECT_OPTIONS);
      const prefix = spec.questions.length > 1 ? `${index + 1}. ` : '';
      const modeTag = question.multi
        ? ` <text_tag color='wathet'>${tShared(locale, 'lark.ask.tagMulti')}</text_tag>`
        : boundedOptions.length > 0
          ? ` <text_tag color='neutral'>${tShared(locale, 'lark.ask.tagSingle')}</text_tag>`
          : '';
      formElements.push({
        tag: 'markdown',
        content: `**${prefix}${escapeLarkInlineMd(truncatePlain(question.prompt, MAX_LARK_QUESTION_PROMPT_LENGTH))}**${modeTag}`,
        text_size: 'normal_v2',
        margin: '0px'
      });

      const descMd = limits.omitOptDesc
        ? undefined
        : buildOptionDescriptionsMarkdown(boundedOptions, locale, limits.maxOptDesc);
      if (descMd) {
        formElements.push({
          tag: 'markdown',
          content: descMd,
          text_size: 'notation',
          margin: '0px'
        });
      }

      if (boundedOptions.length > 0) {
        const seenEncoded = new Set<string>();
        const selectOptions: Array<{ text: { tag: 'plain_text'; content: string }; value: string; recommended?: boolean }> = [];
        boundedOptions.forEach((opt, optIdx) => {
          let encoded = encodeLarkAskOptionValue(opt.value, optIdx);
          if (seenEncoded.has(encoded)) {
            encoded = `__opt_${optIdx}_${fnv1aHex(`${opt.value}:${optIdx}`)}`;
          }
          seenEncoded.add(encoded);
          selectOptions.push({
            text: { tag: 'plain_text', content: formatOptionLabel(opt, locale) },
            value: encoded,
            ...(opt.recommended ? { recommended: true } : {})
          });
        });
        const recommendedSelectOption = selectOptions.find(opt => opt.recommended);
        if (question.multi) {
          formElements.push({
            tag: 'multi_select_static',
            name: formSelectFieldName(index),
            width: 'fill',
            placeholder: { tag: 'plain_text', content: tShared(locale, 'lark.ask.placeholderMulti') },
            options: selectOptions.map(({ text, value }) => ({ text, value })),
            required: !question.allowOther
          });
        } else {
          formElements.push({
            tag: 'select_static',
            name: formSelectFieldName(index),
            width: 'fill',
            placeholder: { tag: 'plain_text', content: tShared(locale, 'lark.ask.placeholderSingle') },
            options: selectOptions.map(({ text, value }) => ({ text, value })),
            ...(recommendedSelectOption ? { initial_option: recommendedSelectOption.value } : {}),
            required: !question.allowOther
          });
        }
      }

      if (question.allowOther) {
        formElements.push({
          tag: 'input',
          name: formOtherFieldName(index),
          width: 'fill',
          placeholder: {
            tag: 'plain_text',
            content: truncatePlain(
              question.otherPlaceholder || (boundedOptions.length ? tShared(locale, 'lark.ask.placeholderOptionalOther') : tShared(locale, 'lark.ask.placeholderFreeText')),
              60
            )
          },
          required: boundedOptions.length === 0
        });
      }
    });

    formElements.push({
      tag: 'button',
      name: 'askq_submit',
      form_action_type: 'submit',
      type: 'primary',
      width: 'fill',
      margin: '4px 0px 0px 0px',
      text: { tag: 'plain_text', content: tShared(locale, 'lark.ask.submitButton') },
      behaviors: [{
        type: 'callback',
        value: {
          action: previewMode ? LARK_ASK_ACTION_PREVIEW : LARK_ASK_ACTION_SUBMIT,
          card_id: cardId
        }
      }]
    });

    elements.push({
      tag: 'form',
      name: 'askq_form',
      element_id: 'askq_form',
      direction: 'vertical',
      vertical_spacing: '8px',
      elements: formElements
    });
  }

  elements.push(...buildWebSessionFooter(locale, sessionId, webBaseUrl));

  return {
    schema: '2.0',
    config: {
      update_multi: true,
      width_mode: 'default',
      summary: { content: summary }
    },
    header: {
      template: 'blue',
      title: { tag: 'plain_text', content: truncatePlain(title, 60) },
      subtitle: { tag: 'plain_text', content: truncatePlain(subtitle, 80) }
    },
    body: {
      direction: 'vertical',
      vertical_spacing: '6px',
      padding: '12px',
      elements
    }
  };
}

/**
 * 构建飞书卡片 JSON 2.0 交互式询问卡片。
 *
 * - 单题单选且选项数 <= 8：直接展示一键可点按钮（推荐项用 primary 高亮）+ 可选「其他回答」内联表单；
 * - 多选 / 多题 / 选项较多 / 纯自由输入：使用单个 Schema 2.0 `form` 容器包裹 `select_static` / `multi_select_static` / `input` + 提交按钮；
 * - 自动执行飞书 Schema 2.0 字段安全截断与 24KB 体积护栏，防止超长文案触发 `230099`。
 */
export function buildLarkAskUserQuestionCard(input: BuildLarkAskCardInput): Record<string, unknown> {
  let card = renderLarkAskUserQuestionCard(input, {
    maxSpecDesc: MAX_LARK_SPEC_DESCRIPTION_LENGTH,
    maxOptDesc: MAX_LARK_OPTION_DESC_LENGTH,
    omitOptDesc: false
  });
  if (Buffer.byteLength(JSON.stringify(card), 'utf8') > MAX_LARK_ASK_CARD_BYTES) {
    card = renderLarkAskUserQuestionCard(input, {
      maxSpecDesc: 160,
      maxOptDesc: 80,
      omitOptDesc: false
    });
  }
  if (Buffer.byteLength(JSON.stringify(card), 'utf8') > MAX_LARK_ASK_CARD_BYTES) {
    card = renderLarkAskUserQuestionCard(input, {
      maxSpecDesc: 120,
      maxOptDesc: 0,
      omitOptDesc: true
    });
  }
  return card;
}

/**
 * 飞书交互卡片被 OpenAPI 拒收（如 230099 / 200xxx）时的极简只读降级卡：
 * 不含任何表单控件，仅保留来源徽标、问题/选项清单与直达 Web 作答链接，避免卡片彻底消失。
 */
export function buildLarkAskUserQuestionFallbackCard(input: BuildLarkAskCardInput): Record<string, unknown> {
  const { spec, sessionId, webBaseUrl, previewBanner, previewMode } = input;
  const locale = input.locale ?? getActiveServerLocale();
  const baseTitle = spec.title?.trim() || tShared(locale, 'lark.ask.defaultTitleMulti');
  const title = previewBanner ? `${previewBanner} ${baseTitle}` : baseTitle;
  const subtitle = locale === 'en-US'
    ? 'Reply directly in chat or answer in AgentDock Web'
    : '请直接在群内回复你的选择，或前往 AgentDock Web 端作答';

  const elements: Array<Record<string, unknown>> = [];
  const badgeEl = buildLarkSourceBadgeElement(
    input.sourceBadge ?? buildLarkInteractiveDefaultSourceBadge(locale, Boolean(previewMode)),
    { margin: '0px 0px 4px 0px' }
  );
  if (badgeEl) elements.push(badgeEl);

  const lines: string[] = [];
  if (spec.description?.trim()) {
    lines.push(`<font color='grey'>${escapeLarkInlineMd(truncatePlain(spec.description, 200))}</font>`);
  }
  spec.questions.slice(0, 8).forEach((question, index) => {
    const prefix = spec.questions.length > 1 ? `${index + 1}. ` : '';
    lines.push(`**${prefix}${escapeLarkInlineMd(truncatePlain(question.prompt, 160))}**`);
    question.options.slice(0, 10).forEach((option, optIdx) => {
      const label = escapeLarkInlineMd(truncatePlain(option.label, 60));
      lines.push(`  ${optIdx + 1}) ${label}`);
    });
  });
  lines.push(
    locale === 'en-US'
      ? `<font color='orange'>Interactive controls were simplified due to Lark card limits; please reply with your choice or open AgentDock Web.</font>`
      : `<font color='orange'>因飞书交互控件受限，已自动降级为精简摘要卡；可直接回复序号/方案，或在 AgentDock Web 端点击作答。</font>`
  );

  elements.push({
    tag: 'markdown',
    content: lines.join('\n').slice(0, 4_000),
    text_size: 'notation',
    margin: '0px'
  });
  elements.push(...buildWebSessionFooter(locale, sessionId, webBaseUrl));

  return {
    schema: '2.0',
    config: {
      update_multi: true,
      width_mode: 'default',
      summary: { content: truncatePlain(title, 110) }
    },
    header: {
      template: 'blue',
      title: { tag: 'plain_text', content: truncatePlain(title, 60) },
      subtitle: { tag: 'plain_text', content: truncatePlain(subtitle, 80) }
    },
    body: {
      direction: 'vertical',
      vertical_spacing: '6px',
      padding: '12px',
      elements
    }
  };
}

function formatAnsweredTimestamp(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function renderLarkAskUserQuestionAnsweredCard(
  input: BuildLarkAskAnsweredCardInput,
  limits: { maxPromptLen: number; maxOtherLen: number }
): Record<string, unknown> {
  const { payload, sessionId, webBaseUrl, previewBanner } = input;
  const locale = input.locale ?? getActiveServerLocale();
  const responder = payload.responderName?.trim() || payload.answeredBy?.trim();
  const sourceLabel = formatInteractionSourceBadge(payload.source, locale, { responderName: responder, variant: 'lark' });
  const actorPart = payload.source === 'assistant'
    ? ''
    : (payload.answeredBy?.trim() ? tShared(locale, 'lark.ask.answeredActor', { name: payload.answeredBy.trim() }) : '');
  const baseTitle = payload.title?.trim()
    ? tShared(locale, 'lark.ask.answeredTitleWithName', { title: payload.title.trim() })
    : tShared(locale, 'lark.ask.answeredTitleDefault');
  const title = previewBanner ? `${previewBanner} ${baseTitle}` : baseTitle;
  const subtitle = tShared(locale, 'lark.ask.answeredSubtitle', { source: sourceLabel, actor: actorPart });

  const elements: Array<Record<string, unknown>> = [];
  const answerBadgeEl = buildLarkSourceBadgeElement(
    input.sourceBadge ?? buildInteractionSourceLarkBadge(payload.source, locale, { responderName: responder }),
    {
      note: payload.source === 'assistant' ? undefined : payload.answeredBy?.trim() || undefined,
      margin: '0px 0px 4px 0px'
    }
  );
  if (answerBadgeEl) elements.push(answerBadgeEl);
  const multiQuestion = payload.answers.length > 1;
  const colon = locale === 'en-US' ? ':' : '：';
  const answerLabel = tShared(locale, 'lark.ask.answerLabel');

  payload.answers.forEach((item, index) => {
    if (index > 0) elements.push({ tag: 'hr', margin: '4px 0px' });
    const qPrefix = multiQuestion ? `Q${index + 1}` : tShared(locale, 'lark.ask.questionLabel');
    const tags = item.selectedLabels
      .map(label => `<text_tag color='green'>${escapeLarkTagText(label, locale)}</text_tag>`)
      .join(' ');
    const safePrompt = escapeLarkInlineMd(truncatePlain(item.prompt, limits.maxPromptLen));
    const safeOtherText = item.otherText?.trim()
      ? escapeLarkInlineMd(truncatePlain(item.otherText, limits.maxOtherLen))
      : '';
    const lines: string[] = [
      `**${qPrefix}${colon}** ${safePrompt}`
    ];
    if (tags && safeOtherText) {
      lines.push(`**${answerLabel}${colon}** ${tags}`);
      lines.push(`> ${tShared(locale, 'lark.ask.customSupplement', { text: safeOtherText })}`);
    } else if (tags) {
      lines.push(`**${answerLabel}${colon}** ${tags}`);
    } else if (safeOtherText) {
      lines.push(`**${answerLabel}${colon}** ${safeOtherText}`);
    } else {
      lines.push(`**${answerLabel}${colon}** <font color='grey'>${tShared(locale, 'lark.ask.unanswered')}</font>`);
    }
    elements.push({
      tag: 'markdown',
      content: lines.join('\n'),
      text_size: 'normal_v2',
      margin: '0px'
    });
  });

  elements.push({
    tag: 'markdown',
    content: `<font color='grey'>${tShared(locale, 'lark.ask.syncedContinue', { time: formatAnsweredTimestamp(payload.answeredAt) })}</font>`,
    text_size: 'x-small',
    margin: '6px 0px 0px 0px'
  });
  elements.push(...buildWebSessionFooter(locale, sessionId, webBaseUrl));

  return {
    schema: '2.0',
    config: {
      update_multi: true,
      width_mode: 'default',
      summary: { content: truncatePlain(locale === 'en-US' ? `${title} (${sourceLabel})` : `${title}（${sourceLabel}）`, 110) }
    },
    header: {
      template: 'green',
      title: { tag: 'plain_text', content: truncatePlain(title, 60) },
      subtitle: { tag: 'plain_text', content: truncatePlain(subtitle, 80) }
    },
    body: {
      direction: 'vertical',
      vertical_spacing: '6px',
      padding: '12px',
      elements
    }
  };
}

/**
 * 构建飞书「✅ 已回答」锁定回显卡片（展示原问题、所选答案/自定义输入、来源与作答人，移除全部交互控件）。
 * 内置与提问卡一致的 24KB 体积护栏，避免超长自定义补充文本（`otherText`）触发飞书 Schema 拒收。
 */
export function buildLarkAskUserQuestionAnsweredCard(input: BuildLarkAskAnsweredCardInput): Record<string, unknown> {
  let card = renderLarkAskUserQuestionAnsweredCard(input, {
    maxPromptLen: MAX_LARK_QUESTION_PROMPT_LENGTH,
    maxOtherLen: MAX_LARK_ANSWER_OTHER_TEXT_LENGTH
  });
  if (Buffer.byteLength(JSON.stringify(card), 'utf8') > MAX_LARK_ASK_CARD_BYTES) {
    card = renderLarkAskUserQuestionAnsweredCard(input, {
      maxPromptLen: 160,
      maxOtherLen: 240
    });
  }
  if (Buffer.byteLength(JSON.stringify(card), 'utf8') > MAX_LARK_ASK_CARD_BYTES) {
    card = buildLarkAskUserQuestionAnsweredFallbackCard(input);
  }
  return card;
}

/**
 * 极简「✅ 已回答」锁定兜底卡：当完整回显卡因特殊字符/体积触发飞书 `230099`/`230028` 时使用，
 * 保证原表单卡片依然能够可靠切入已提交只读锁定态。
 */
export function buildLarkAskUserQuestionAnsweredFallbackCard(input: BuildLarkAskAnsweredCardInput): Record<string, unknown> {
  const { payload, sessionId, webBaseUrl, previewBanner } = input;
  const locale = input.locale ?? getActiveServerLocale();
  const responder = payload.responderName?.trim() || payload.answeredBy?.trim();
  const sourceLabel = formatInteractionSourceBadge(payload.source, locale, { responderName: responder, variant: 'lark' });
  const actorPart = payload.source === 'assistant'
    ? ''
    : (payload.answeredBy?.trim() ? tShared(locale, 'lark.ask.answeredActor', { name: payload.answeredBy.trim() }) : '');
  const baseTitle = payload.title?.trim()
    ? tShared(locale, 'lark.ask.answeredTitleWithName', { title: payload.title.trim() })
    : tShared(locale, 'lark.ask.answeredTitleDefault');
  const title = previewBanner ? `${previewBanner} ${baseTitle}` : baseTitle;
  const subtitle = tShared(locale, 'lark.ask.answeredSubtitle', { source: sourceLabel, actor: actorPart });
  const colon = locale === 'en-US' ? ': ' : '：';

  const elements: Array<Record<string, unknown>> = [];
  const answerBadgeEl = buildLarkSourceBadgeElement(
    input.sourceBadge ?? buildInteractionSourceLarkBadge(payload.source, locale, { responderName: responder }),
    {
      note: payload.source === 'assistant' ? undefined : payload.answeredBy?.trim() || undefined,
      margin: '0px 0px 4px 0px'
    }
  );
  if (answerBadgeEl) elements.push(answerBadgeEl);

  const lines = payload.answers.slice(0, 8).map((item, idx) => {
    const labelPart = item.selectedLabels.map(v => truncatePlain(v, 36)).join(' / ');
    const otherPart = item.otherText?.trim() ? truncatePlain(item.otherText, 80) : '';
    const joined = [labelPart, otherPart].filter(Boolean).join(' · ') || tShared(locale, 'lark.ask.unanswered');
    const prefix = payload.answers.length > 1 ? `Q${idx + 1}` : tShared(locale, 'lark.ask.questionLabel');
    return `${prefix}${colon}${escapeLarkInlineMd(joined)}`;
  });

  elements.push({
    tag: 'markdown',
    content: lines.join('\n').slice(0, 3_000),
    text_size: 'normal_v2',
    margin: '0px'
  });
  elements.push({
    tag: 'markdown',
    content: `<font color='grey'>${tShared(locale, 'lark.ask.syncedContinue', { time: formatAnsweredTimestamp(payload.answeredAt) })}</font>`,
    text_size: 'x-small',
    margin: '6px 0px 0px 0px'
  });
  elements.push(...buildWebSessionFooter(locale, sessionId, webBaseUrl));

  return {
    schema: '2.0',
    config: {
      update_multi: true,
      width_mode: 'default',
      summary: { content: truncatePlain(locale === 'en-US' ? `${title} (${sourceLabel})` : `${title}（${sourceLabel}）`, 110) }
    },
    header: {
      template: 'green',
      title: { tag: 'plain_text', content: truncatePlain(title, 60) },
      subtitle: { tag: 'plain_text', content: truncatePlain(subtitle, 80) }
    },
    body: {
      direction: 'vertical',
      vertical_spacing: '6px',
      padding: '12px',
      elements
    }
  };
}

function normalizeFormSelectedValues(raw: unknown): string[] {
  if (Array.isArray(raw)) {
    return raw.map(item => String(item ?? '').trim()).filter(Boolean);
  }
  if (typeof raw === 'string') {
    const trimmed = raw.trim();
    if (!trimmed) return [];
    if (trimmed.startsWith('[')) {
      try {
        const parsed = JSON.parse(trimmed);
        if (Array.isArray(parsed)) return parsed.map(item => String(item ?? '').trim()).filter(Boolean);
      } catch { /* 按普通字符串处理 */ }
    }
    return [trimmed];
  }
  return [];
}

export type ParsedLarkAskAction =
  | { ok: true; answers: AskUserQuestionAnswerItem[] }
  | { ok: false; error: string };

/**
 * 解析飞书 `card.action.trigger` 回调中的 AskUserQuestion 作答内容。
 */
export function parseLarkAskUserQuestionAction(
  spec: AskUserQuestionSpec,
  action: string,
  value: Record<string, unknown>,
  formValue?: Record<string, unknown>,
  locale: Locale = getActiveServerLocale()
): ParsedLarkAskAction {
  if (action === LARK_ASK_ACTION_PICK) {
    const qId = String(value.question_id ?? '').trim();
    const optVal = String(value.option_value ?? '').trim();
    const question = spec.questions.find(item => item.id === qId) ?? spec.questions[0];
    if (!question) return { ok: false, error: tShared(locale, 'lark.ask.error.questionNotFound') };
    const option = buildQuestionOptionLookup(question.options).get(optVal);
    if (!option) return { ok: false, error: tShared(locale, 'lark.ask.error.optionNotFound') };
    return {
      ok: true,
      answers: [{
        questionId: question.id,
        prompt: question.prompt,
        selectedValues: [option.value],
        selectedLabels: [option.label]
      }]
    };
  }

  if (action === LARK_ASK_ACTION_OTHER) {
    const qId = String(value.question_id ?? '').trim();
    const question = spec.questions.find(item => item.id === qId) ?? spec.questions[0];
    if (!question) return { ok: false, error: tShared(locale, 'lark.ask.error.questionNotFound') };
    const otherText = String(formValue?.other_text ?? '').trim();
    if (!otherText) return { ok: false, error: tShared(locale, 'lark.ask.error.emptyOther') };
    return {
      ok: true,
      answers: [{
        questionId: question.id,
        prompt: question.prompt,
        selectedValues: [],
        selectedLabels: [],
        otherText
      }]
    };
  }

  if (action === LARK_ASK_ACTION_SUBMIT) {
    const answers: AskUserQuestionAnswerItem[] = [];
    for (let index = 0; index < spec.questions.length; index++) {
      const question = spec.questions[index]!;
      const rawSel = formValue?.[formSelectFieldName(index)];
      const rawOther = formValue?.[formOtherFieldName(index)];
      const selectedValues = normalizeFormSelectedValues(rawSel);
      const otherText = typeof rawOther === 'string' ? rawOther.trim() : '';

      const optionByValue = buildQuestionOptionLookup(question.options);
      const matchedOptions = selectedValues
        .map(val => optionByValue.get(val))
        .filter((opt): opt is AskUserQuestionOption => Boolean(opt));
      const validValues = matchedOptions.map(opt => opt.value);
      const selectedLabels = matchedOptions.map(opt => opt.label);

      if (!validValues.length && !otherText) {
        return {
          ok: false,
          error: spec.questions.length > 1
            ? tShared(locale, 'lark.ask.error.missingAnswerNth', { index: index + 1 })
            : tShared(locale, 'lark.ask.error.missingAnswerSingle')
        };
      }

      answers.push({
        questionId: question.id,
        prompt: question.prompt,
        selectedValues: validValues,
        selectedLabels,
        ...(otherText ? { otherText } : {})
      });
    }
    return { ok: true, answers };
  }

  return { ok: false, error: tShared(locale, 'lark.ask.error.unsupported') };
}
