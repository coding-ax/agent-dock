import {
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
  locale?: Locale;
}

export interface BuildLarkAskAnsweredCardInput {
  payload: AskUserQuestionAnswerPayload;
  sessionId?: string;
  webBaseUrl?: string;
  previewBanner?: string;
  locale?: Locale;
}

export const formSelectFieldName = (index: number) => `q_${index}_sel`;
export const formOtherFieldName = (index: number) => `q_${index}_other`;

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
  if (!option.recommended) return label;
  return /推荐|recommended/i.test(label) ? `★ ${label}` : tShared(locale, 'lark.ask.recommendedSuffix', { label });
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

function buildOptionDescriptionsMarkdown(options: AskUserQuestionOption[], locale: Locale): string | undefined {
  const described = options.filter(opt => Boolean(opt.description?.trim()));
  if (!described.length) return undefined;
  const sep = locale === 'en-US' ? ': ' : '：';
  return described.map(opt => {
    const rec = opt.recommended ? ` <text_tag color='blue'>${tShared(locale, 'lark.ask.recommendedTag')}</text_tag>` : '';
    return `• **${escapeLarkInlineMd(opt.label)}**${rec}${sep}<font color='grey'>${escapeLarkInlineMd(opt.description!)}</font>`;
  }).join('\n');
}

/**
 * 构建飞书卡片 JSON 2.0 交互式询问卡片。
 *
 * - 单题单选且有预设选项：直接展示一键可点按钮（推荐项用 primary 高亮）+ 可选「其他回答」内联表单；
 * - 多选 / 多题 / 纯自由输入：使用单个 Schema 2.0 `form` 容器包裹 `select_static` / `multi_select_static` / `input` + 提交按钮。
 */
export function buildLarkAskUserQuestionCard(input: BuildLarkAskCardInput): Record<string, unknown> {
  const { cardId, spec, sessionId, webBaseUrl, previewBanner, previewMode } = input;
  const locale = input.locale ?? getActiveServerLocale();
  const isSingleQuickPick = spec.questions.length === 1
    && !spec.questions[0]!.multi
    && spec.questions[0]!.options.length > 0;

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

  if (spec.description?.trim()) {
    elements.push({
      tag: 'markdown',
      content: `<font color='grey'>${escapeLarkInlineMd(spec.description)}</font>`,
      text_size: 'notation',
      margin: '0px 0px 4px 0px'
    });
  }

  if (isSingleQuickPick) {
    const question = spec.questions[0]!;
    elements.push({
      tag: 'markdown',
      content: `**${escapeLarkInlineMd(question.prompt)}**`,
      text_size: 'normal_v2',
      margin: '0px 0px 4px 0px'
    });

    const descMd = buildOptionDescriptionsMarkdown(question.options, locale);
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
            option_value: option.value
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
      const prefix = spec.questions.length > 1 ? `${index + 1}. ` : '';
      const modeTag = question.multi
        ? ` <text_tag color='wathet'>${tShared(locale, 'lark.ask.tagMulti')}</text_tag>`
        : question.options.length > 0
          ? ` <text_tag color='neutral'>${tShared(locale, 'lark.ask.tagSingle')}</text_tag>`
          : '';
      formElements.push({
        tag: 'markdown',
        content: `**${prefix}${escapeLarkInlineMd(question.prompt)}**${modeTag}`,
        text_size: 'normal_v2',
        margin: '0px'
      });

      const descMd = buildOptionDescriptionsMarkdown(question.options, locale);
      if (descMd) {
        formElements.push({
          tag: 'markdown',
          content: descMd,
          text_size: 'notation',
          margin: '0px'
        });
      }

      if (question.options.length > 0) {
        const recommendedOption = question.options.find(opt => opt.recommended);
        if (question.multi) {
          formElements.push({
            tag: 'multi_select_static',
            name: formSelectFieldName(index),
            width: 'fill',
            placeholder: { tag: 'plain_text', content: tShared(locale, 'lark.ask.placeholderMulti') },
            options: question.options.map(opt => ({
              text: { tag: 'plain_text', content: formatOptionLabel(opt, locale) },
              value: opt.value
            })),
            required: !question.allowOther
          });
        } else {
          formElements.push({
            tag: 'select_static',
            name: formSelectFieldName(index),
            width: 'fill',
            placeholder: { tag: 'plain_text', content: tShared(locale, 'lark.ask.placeholderSingle') },
            options: question.options.map(opt => ({
              text: { tag: 'plain_text', content: formatOptionLabel(opt, locale) },
              value: opt.value
            })),
            ...(recommendedOption ? { initial_option: recommendedOption.value } : {}),
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
              question.otherPlaceholder || (question.options.length ? tShared(locale, 'lark.ask.placeholderOptionalOther') : tShared(locale, 'lark.ask.placeholderFreeText')),
              60
            )
          },
          required: question.options.length === 0
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

function formatAnsweredTimestamp(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/**
 * 构建飞书「✅ 已回答」锁定回显卡片（展示原问题、所选答案/自定义输入、来源与作答人，移除全部交互控件）。
 */
export function buildLarkAskUserQuestionAnsweredCard(input: BuildLarkAskAnsweredCardInput): Record<string, unknown> {
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
  const multiQuestion = payload.answers.length > 1;
  const colon = locale === 'en-US' ? ':' : '：';
  const answerLabel = tShared(locale, 'lark.ask.answerLabel');

  payload.answers.forEach((item, index) => {
    if (index > 0) elements.push({ tag: 'hr', margin: '4px 0px' });
    const qPrefix = multiQuestion ? `Q${index + 1}` : tShared(locale, 'lark.ask.questionLabel');
    const tags = item.selectedLabels
      .map(label => `<text_tag color='green'>${escapeLarkTagText(label, locale)}</text_tag>`)
      .join(' ');
    const lines: string[] = [
      `**${qPrefix}${colon}** ${escapeLarkInlineMd(item.prompt)}`
    ];
    if (tags && item.otherText?.trim()) {
      lines.push(`**${answerLabel}${colon}** ${tags}`);
      lines.push(`> ${tShared(locale, 'lark.ask.customSupplement', { text: escapeLarkInlineMd(item.otherText) })}`);
    } else if (tags) {
      lines.push(`**${answerLabel}${colon}** ${tags}`);
    } else if (item.otherText?.trim()) {
      lines.push(`**${answerLabel}${colon}** ${escapeLarkInlineMd(item.otherText)}`);
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
    const option = question.options.find(opt => opt.value === optVal);
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

      const optionByValue = new Map(question.options.map(opt => [opt.value, opt]));
      const validValues = selectedValues.filter(val => optionByValue.has(val));
      const selectedLabels = validValues.map(val => optionByValue.get(val)!.label);

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
