import {
  BUILTIN_CONFIRM_ACTION_PLUGIN_ID,
  formatInteractionSourceBadge,
  tShared,
  type ConfirmActionDecision,
  type ConfirmActionInteractionPayload,
  type ConfirmActionRisk,
  type ConfirmActionSpec,
  type Locale
} from '@agent-dock/agent-dock-shared';
import { getActiveServerLocale } from '../../locale-service.js';
import { webAccessSessionToken } from '../../web-access.js';
import {
  buildInteractionSourceLarkBadge,
  buildLarkInteractiveDefaultSourceBadge,
  buildLarkSourceBadgeElement
} from '../service.js';
import type { LarkOutputPluginAdapter } from './types.js';

export const LARK_CONFIRM_ACTION_DECIDE = 'confirm_action_decide';
export const LARK_CONFIRM_ACTION_COMMENT = 'confirm_action_comment';
export const LARK_CONFIRM_ACTION_PREVIEW = 'confirm_action_preview';

export const LARK_CONFIRM_ACTIONS = new Set([
  LARK_CONFIRM_ACTION_DECIDE,
  LARK_CONFIRM_ACTION_COMMENT,
  LARK_CONFIRM_ACTION_PREVIEW
]);

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
  return truncatePlain(value.replace(/[<>&'"]/g, ''), 40) || tShared(locale, 'lark.confirm.tagFallback');
}

function riskHeaderTemplate(risk: ConfirmActionRisk): string {
  switch (risk) {
    case 'high': return 'red';
    case 'low': return 'blue';
    case 'medium':
    default:
      return 'orange';
  }
}

function riskTagMeta(risk: ConfirmActionRisk, locale: Locale): { color: string; label: string } {
  switch (risk) {
    case 'high': return { color: 'red', label: tShared(locale, 'lark.confirm.risk.high') };
    case 'low': return { color: 'blue', label: tShared(locale, 'lark.confirm.risk.low') };
    case 'medium':
    default:
      return { color: 'orange', label: tShared(locale, 'lark.confirm.risk.medium') };
  }
}

function formatTimestamp(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
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

/**
 * 内置插件 #2（`builtin:confirm-action`）的专属飞书 Schema 2.0 适配器：
 * - 根据风险级别（low/medium/high）呈现蓝色/橙色/红色顶栏与风险徽标；
 * - 提供一键「确认执行」与「取消」按钮；
 * - 若 `allowComment=true`，附带可选「带补充意见提交」内联 Schema 2.0 表单；
 * - 任一端响应后原地锁定为绿色（已确认）或灰色（已取消）只读卡片。
 */
export const confirmActionLarkAdapter: LarkOutputPluginAdapter<
  ConfirmActionSpec,
  ConfirmActionInteractionPayload
> = {
  pluginId: BUILTIN_CONFIRM_ACTION_PLUGIN_ID,
  trailingHintMarkdown: "<font color='grey'>👇 请在下方「操作确认卡」中确认或取消</font>",
  getTrailingHintMarkdown: locale => `<font color='grey'>${tShared(locale, 'lark.confirm.trailingHint')}</font>`,
  streamingPlaceholderText: '⏳ 正在生成操作确认卡…',
  getStreamingPlaceholderText: locale => tShared(locale, 'lark.confirm.streamingPlaceholder'),

  handlesAction(action: string): boolean {
    return LARK_CONFIRM_ACTIONS.has(action);
  },

  isPreviewAction(action: string): boolean {
    return action === LARK_CONFIRM_ACTION_PREVIEW;
  },

  buildCard({ cardId, spec, sessionId, webBaseUrl, previewBanner, previewMode, sourceBadge, locale: explicitLocale }) {
    const locale = explicitLocale ?? getActiveServerLocale();
    const baseTitle = spec.title?.trim() || tShared(locale, 'lark.confirm.defaultTitle');
    const title = previewBanner ? `${previewBanner} ${baseTitle}` : baseTitle;
    const riskMeta = riskTagMeta(spec.risk, locale);
    const subtitle = previewMode
      ? tShared(locale, 'lark.confirm.subtitlePreview')
      : tShared(locale, 'lark.confirm.subtitle', { risk: riskMeta.label });
    const colon = locale === 'en-US' ? ': ' : '：';

    const elements: Array<Record<string, unknown>> = [];
    const badgeEl = buildLarkSourceBadgeElement(
      sourceBadge ?? buildLarkInteractiveDefaultSourceBadge(locale, Boolean(previewMode)),
      { margin: '0px 0px 4px 0px' }
    );
    if (badgeEl) elements.push(badgeEl);

    elements.push({
      tag: 'markdown',
      content: `<text_tag color='${riskMeta.color}'>${riskMeta.label}</text_tag>${spec.summary ? `  ${escapeLarkInlineMd(spec.summary)}` : ''}`,
      text_size: 'normal_v2',
      margin: '0px 0px 4px 0px'
    });

    if (spec.details.length > 0) {
      elements.push({
        tag: 'markdown',
        content: spec.details
          .map(item => `• **${escapeLarkInlineMd(item.label)}**${colon}${escapeLarkInlineMd(item.value)}`)
          .join('\n'),
        text_size: 'notation',
        margin: '2px 0px 6px 0px'
      });
    }

    if (spec.command?.trim()) {
      elements.push({
        tag: 'markdown',
        content: `\`\`\`sh\n${spec.command.trim()}\n\`\`\``,
        text_size: 'notation',
        margin: '2px 0px 8px 0px'
      });
    }

    elements.push({
      tag: 'button',
      element_id: 'confirm_action_ok',
      text: { tag: 'plain_text', content: truncatePlain(spec.confirmLabel, 38) },
      type: spec.risk === 'high' ? 'danger' : 'primary',
      width: 'fill',
      margin: '4px 0px 0px 0px',
      behaviors: [{
        type: 'callback',
        value: {
          action: previewMode ? LARK_CONFIRM_ACTION_PREVIEW : LARK_CONFIRM_ACTION_DECIDE,
          plugin_id: BUILTIN_CONFIRM_ACTION_PLUGIN_ID,
          card_id: cardId,
          decision: 'confirm'
        }
      }]
    });

    elements.push({
      tag: 'button',
      element_id: 'confirm_action_cancel',
      text: { tag: 'plain_text', content: truncatePlain(spec.cancelLabel, 38) },
      type: 'default',
      width: 'fill',
      margin: '6px 0px 0px 0px',
      behaviors: [{
        type: 'callback',
        value: {
          action: previewMode ? LARK_CONFIRM_ACTION_PREVIEW : LARK_CONFIRM_ACTION_DECIDE,
          plugin_id: BUILTIN_CONFIRM_ACTION_PLUGIN_ID,
          card_id: cardId,
          decision: 'cancel'
        }
      }]
    });

    if (spec.allowComment) {
      elements.push({ tag: 'hr', margin: '10px 0px 8px 0px' });
      elements.push({
        tag: 'form',
        name: 'confirm_comment_form',
        element_id: 'confirm_comment_form',
        direction: 'vertical',
        vertical_spacing: '8px',
        elements: [
          {
            tag: 'select_static',
            name: 'decision',
            width: 'fill',
            placeholder: { tag: 'plain_text', content: tShared(locale, 'lark.confirm.commentDecisionPlaceholder') },
            options: [
              { text: { tag: 'plain_text', content: truncatePlain(spec.confirmLabel, 38) }, value: 'confirm' },
              { text: { tag: 'plain_text', content: truncatePlain(spec.cancelLabel, 38) }, value: 'cancel' }
            ],
            initial_option: 'confirm',
            required: true
          },
          {
            tag: 'input',
            name: 'comment_text',
            width: 'fill',
            label: { tag: 'plain_text', content: tShared(locale, 'lark.confirm.commentLabel') },
            label_position: 'top',
            placeholder: {
              tag: 'plain_text',
              content: truncatePlain(spec.commentPlaceholder || tShared(locale, 'lark.confirm.commentPlaceholder'), 60)
            },
            required: true
          },
          {
            tag: 'button',
            name: 'confirm_comment_submit',
            form_action_type: 'submit',
            type: 'default',
            width: 'fill',
            text: { tag: 'plain_text', content: tShared(locale, 'lark.confirm.commentSubmit') },
            behaviors: [{
              type: 'callback',
              value: {
                action: previewMode ? LARK_CONFIRM_ACTION_PREVIEW : LARK_CONFIRM_ACTION_COMMENT,
                plugin_id: BUILTIN_CONFIRM_ACTION_PLUGIN_ID,
                card_id: cardId
              }
            }]
          }
        ]
      });
    }

    elements.push(...buildWebSessionFooter(locale, sessionId, webBaseUrl));

    return {
      schema: '2.0',
      config: {
        update_multi: true,
        width_mode: 'default',
        summary: { content: truncatePlain(`${title}${spec.summary ? `${colon}${spec.summary}` : ''}`, 110) }
      },
      header: {
        template: riskHeaderTemplate(spec.risk),
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
  },

  buildAnsweredCard({ payload, sessionId, webBaseUrl, previewBanner, sourceBadge, locale: explicitLocale }) {
    const locale = explicitLocale ?? getActiveServerLocale();
    const confirmed = payload.decision === 'confirm';
    const responder = payload.responderName?.trim() || payload.decidedBy?.trim();
    const sourceLabel = formatInteractionSourceBadge(payload.source, locale, { responderName: responder, variant: 'lark' });
    const actorPart = payload.source === 'assistant'
      ? ''
      : (payload.decidedBy?.trim() ? tShared(locale, 'lark.confirm.answeredActor', { name: payload.decidedBy.trim() }) : '');
    const statusText = confirmed ? tShared(locale, 'lark.confirm.statusConfirmed') : tShared(locale, 'lark.confirm.statusCancelled');
    const icon = confirmed ? '✅' : '⛔';
    const baseTitle = payload.title?.trim()
      ? tShared(locale, 'lark.confirm.answeredTitleWithName', { icon, title: payload.title.trim(), status: statusText })
      : tShared(locale, 'lark.confirm.answeredTitleDefault', { icon, status: statusText });
    const title = previewBanner ? `${previewBanner} ${baseTitle}` : baseTitle;
    const subtitle = tShared(locale, 'lark.confirm.answeredSubtitle', { source: sourceLabel, actor: actorPart });
    const colon = locale === 'en-US' ? ':' : '：';

    const lines: string[] = [
      `**${tShared(locale, 'lark.confirm.resultLabel')}${colon}** <text_tag color='${confirmed ? 'green' : 'neutral'}'>${escapeLarkTagText(payload.decisionLabel, locale)}</text_tag>`
    ];
    if (payload.comment?.trim()) {
      lines.push(`> ${tShared(locale, 'lark.confirm.commentNote', { text: escapeLarkInlineMd(truncatePlain(payload.comment, 800)) })}`);
    }

    const answerBadgeEl = buildLarkSourceBadgeElement(
      sourceBadge ?? buildInteractionSourceLarkBadge(payload.source, locale, { responderName: responder }),
      {
        note: payload.source === 'assistant' ? undefined : payload.decidedBy?.trim() || undefined,
        margin: '0px 0px 4px 0px'
      }
    );

    const elements: Array<Record<string, unknown>> = [
      ...(answerBadgeEl ? [answerBadgeEl] : []),
      {
        tag: 'markdown',
        content: lines.join('\n'),
        text_size: 'normal_v2',
        margin: '0px'
      },
      {
        tag: 'markdown',
        content: `<font color='grey'>${tShared(locale, 'lark.confirm.syncedNotify', { time: formatTimestamp(payload.decidedAt) })}</font>`,
        text_size: 'x-small',
        margin: '6px 0px 0px 0px'
      },
      ...buildWebSessionFooter(locale, sessionId, webBaseUrl)
    ];

    return {
      schema: '2.0',
      config: {
        update_multi: true,
        width_mode: 'default',
        summary: { content: truncatePlain(locale === 'en-US' ? `${title} (${sourceLabel})` : `${title}（${sourceLabel}）`, 110) }
      },
      header: {
        template: confirmed ? 'green' : 'grey',
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
  },

  parseAction(spec, action, value, formValue, explicitLocale) {
    const locale = explicitLocale ?? getActiveServerLocale();
    if (action === LARK_CONFIRM_ACTION_DECIDE) {
      const decision = String(value.decision ?? '').trim() as ConfirmActionDecision;
      if (decision !== 'confirm' && decision !== 'cancel') {
        return { ok: false, error: tShared(locale, 'lark.confirm.error.invalidDecision') };
      }
      return {
        ok: true,
        interaction: {
          decision,
          decisionLabel: decision === 'confirm' ? spec.confirmLabel : spec.cancelLabel,
          risk: spec.risk
        }
      };
    }

    if (action === LARK_CONFIRM_ACTION_COMMENT) {
      const decision = String(formValue?.decision ?? value.decision ?? 'confirm').trim() as ConfirmActionDecision;
      if (decision !== 'confirm' && decision !== 'cancel') {
        return { ok: false, error: tShared(locale, 'lark.confirm.error.chooseDecision') };
      }
      const comment = String(formValue?.comment_text ?? '').trim();
      if (!comment) {
        return { ok: false, error: tShared(locale, 'lark.confirm.error.emptyComment') };
      }
      return {
        ok: true,
        interaction: {
          decision,
          decisionLabel: decision === 'confirm' ? spec.confirmLabel : spec.cancelLabel,
          risk: spec.risk,
          comment
        }
      };
    }

    return { ok: false, error: tShared(locale, 'lark.confirm.error.unsupported') };
  }
};
