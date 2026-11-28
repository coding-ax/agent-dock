import {
  formatInteractionSourceBadge,
  normalizeOutputPluginId,
  tShared,
  type DeclarativeOutputPluginInteractionPayload,
  type DeclarativeOutputPluginSpec,
  type Locale,
  type OutputPluginAccentTone,
  type OutputPluginDefinition
} from '@agent-dock/agent-dock-shared';
import { getActiveServerLocale } from '../../locale-service.js';
import { webAccessSessionToken } from '../../web-access.js';
import {
  buildInteractionSourceLarkBadge,
  buildLarkInteractiveDefaultSourceBadge,
  buildLarkSourceBadgeElement
} from '../service.js';
import type { LarkOutputPluginAdapter } from './types.js';

export const LARK_OUTPUT_PLUGIN_CARD_CHANNEL = 'output-plugin:lark-card';
export const LARK_OUTPUT_PLUGIN_ACTION_CLICK = 'output_plugin_action';
export const LARK_OUTPUT_PLUGIN_ACTION_FORM = 'output_plugin_form_submit';
export const LARK_OUTPUT_PLUGIN_ACTION_NOTE = 'output_plugin_note_submit';
export const LARK_OUTPUT_PLUGIN_ACTION_PREVIEW = 'output_plugin_preview';

export const LARK_DECLARATIVE_PLUGIN_ACTIONS = new Set([
  LARK_OUTPUT_PLUGIN_ACTION_CLICK,
  LARK_OUTPUT_PLUGIN_ACTION_FORM,
  LARK_OUTPUT_PLUGIN_ACTION_NOTE,
  LARK_OUTPUT_PLUGIN_ACTION_PREVIEW
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
  return truncatePlain(value.replace(/[<>&'"]/g, ''), 40) || tShared(locale, 'lark.declarative.tagFallback');
}

function headerTemplateForTone(tone: OutputPluginAccentTone): string {
  switch (tone) {
    case 'emerald': return 'green';
    case 'amber': return 'orange';
    case 'rose': return 'red';
    case 'violet': return 'purple';
    case 'zinc': return 'grey';
    case 'sky':
    default:
      return 'blue';
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

export const declarativeFormFieldKey = (index: number) => `f_${index}`;

/**
 * 为任意声明式纯 XML 插件（`action-card` / `form-card` / `info-card`）自动生成飞书 Schema 2.0 适配器：
 * - `action-card`：展示摘要、只读字段 + 一键动作按钮（支持 primary / danger / default）+ 可选备注表单；
 * - `form-card`：展示 Schema 2.0 `form`（`select_static` / `input`）+ 统一提交按钮；
 * - `info-card`：展示结构化状态标签、字段摘要与安全外链按钮/Markdown 链接；
 * - 任一端响应后原地锁定为绿色「✅ 已响应」卡片。
 */
export function createDeclarativeLarkAdapter(
  plugin: OutputPluginDefinition
): LarkOutputPluginAdapter<DeclarativeOutputPluginSpec, DeclarativeOutputPluginInteractionPayload> {
  const canonicalId = normalizeOutputPluginId(plugin.id);
  const defaults = plugin.declarative?.card;

  return {
    pluginId: canonicalId,
    trailingHintMarkdown: defaults?.trailingHintMarkdown
      || (plugin.capabilities.interactive
        ? `<font color='grey'>👇 请在下方「${plugin.name}」交互卡片中操作</font>`
        : `<font color='grey'>👇 请在下方查看「${plugin.name}」详情卡片</font>`),
    getTrailingHintMarkdown(locale) {
      if (defaults?.trailingHintMarkdown) return defaults.trailingHintMarkdown;
      const key = plugin.capabilities.interactive ? 'lark.declarative.trailingInteractive' : 'lark.declarative.trailingInfo';
      return `<font color='grey'>${tShared(locale, key, { name: plugin.name })}</font>`;
    },
    streamingPlaceholderText: defaults?.streamingPlaceholderText || `⏳ 正在生成「${plugin.name}」卡片…`,
    getStreamingPlaceholderText(locale) {
      return defaults?.streamingPlaceholderText || tShared(locale, 'lark.declarative.streamingPlaceholder', { name: plugin.name });
    },

    handlesAction(action, value): boolean {
      if (!LARK_DECLARATIVE_PLUGIN_ACTIONS.has(action)) return false;
      const targetId = typeof value.plugin_id === 'string' ? normalizeOutputPluginId(value.plugin_id) : '';
      return !targetId || targetId === canonicalId;
    },

    isPreviewAction(action): boolean {
      return action === LARK_OUTPUT_PLUGIN_ACTION_PREVIEW;
    },

    buildCard({ cardId, spec, sessionId, webBaseUrl, previewBanner, previewMode, sourceBadge, locale: explicitLocale }) {
      const locale = explicitLocale ?? getActiveServerLocale();
      const baseTitle = spec.title?.trim() || plugin.name;
      const title = previewBanner ? `${previewBanner} ${baseTitle}` : baseTitle;
      const subtitle = previewMode
        ? tShared(locale, 'lark.declarative.subtitlePreview', { name: plugin.name })
        : spec.kind === 'info-card'
          ? `AgentDock · ${plugin.name}`
          : spec.kind === 'form-card'
            ? tShared(locale, 'lark.declarative.subtitleForm', { name: plugin.name })
            : tShared(locale, 'lark.declarative.subtitleAction', { name: plugin.name });
      const colon = locale === 'en-US' ? ': ' : '：';

      const elements: Array<Record<string, unknown>> = [];
      const badgeEl = buildLarkSourceBadgeElement(
        sourceBadge ?? buildLarkInteractiveDefaultSourceBadge(locale, Boolean(previewMode)),
        { margin: '0px 0px 4px 0px' }
      );
      if (badgeEl) elements.push(badgeEl);

      if (spec.status?.trim()) {
        elements.push({
          tag: 'markdown',
          content: `<text_tag color='${headerTemplateForTone(spec.tone)}'>${escapeLarkTagText(spec.status, locale)}</text_tag>`,
          text_size: 'notation',
          margin: '0px 0px 4px 0px'
        });
      }

      if (spec.summary?.trim()) {
        elements.push({
          tag: 'markdown',
          content: escapeLarkInlineMd(spec.summary),
          text_size: 'normal_v2',
          margin: '0px 0px 4px 0px'
        });
      }

      if (spec.kind !== 'form-card' && spec.fields.length > 0) {
        const lines = spec.fields.map(field => {
          const val = field.value?.trim() ? escapeLarkInlineMd(field.value) : '—';
          return `• **${escapeLarkInlineMd(field.label)}**${colon}${val}`;
        });
        elements.push({
          tag: 'markdown',
          content: lines.join('\n'),
          text_size: 'notation',
          margin: '2px 0px 6px 0px'
        });
      }

      if (spec.links.length > 0) {
        const linkMd = spec.links
          .map(link => `[${escapeLarkInlineMd(link.label)}](${link.href})`)
          .join('  ·  ');
        elements.push({
          tag: 'markdown',
          content: linkMd,
          text_size: 'notation',
          margin: '2px 0px 6px 0px'
        });
      }

      if (spec.kind === 'action-card') {
        spec.actions.forEach((act, idx) => {
          elements.push({
            tag: 'button',
            element_id: `outp_act_${idx}`,
            text: { tag: 'plain_text', content: truncatePlain(act.label, 40) },
            type: act.style === 'primary' ? 'primary' : act.style === 'danger' ? 'danger' : 'default',
            width: 'fill',
            margin: idx === 0 ? '4px 0px 0px 0px' : '6px 0px 0px 0px',
            behaviors: [{
              type: 'callback',
              value: {
                action: previewMode ? LARK_OUTPUT_PLUGIN_ACTION_PREVIEW : LARK_OUTPUT_PLUGIN_ACTION_CLICK,
                plugin_id: canonicalId,
                card_id: cardId,
                action_value: act.value
              }
            }]
          });
        });

        if (spec.allowNote) {
          elements.push({ tag: 'hr', margin: '10px 0px 8px 0px' });
          elements.push({
            tag: 'form',
            name: 'outp_note_form',
            element_id: 'outp_note_form',
            direction: 'vertical',
            vertical_spacing: '8px',
            elements: [
              {
                tag: 'select_static',
                name: 'action_value',
                width: 'fill',
                placeholder: { tag: 'plain_text', content: tShared(locale, 'lark.declarative.noteActionPlaceholder') },
                options: spec.actions.map(act => ({
                  text: { tag: 'plain_text', content: truncatePlain(act.label, 40) },
                  value: act.value
                })),
                ...(spec.actions[0] ? { initial_option: spec.actions[0].value } : {}),
                required: true
              },
              {
                tag: 'input',
                name: 'note_text',
                width: 'fill',
                label: { tag: 'plain_text', content: tShared(locale, 'lark.declarative.noteLabel') },
                label_position: 'top',
                placeholder: {
                  tag: 'plain_text',
                  content: truncatePlain(spec.notePlaceholder || tShared(locale, 'lark.declarative.notePlaceholder'), 60)
                },
                required: true
              },
              {
                tag: 'button',
                name: 'outp_note_submit',
                form_action_type: 'submit',
                type: 'default',
                width: 'fill',
                text: { tag: 'plain_text', content: tShared(locale, 'lark.declarative.noteSubmit') },
                behaviors: [{
                  type: 'callback',
                  value: {
                    action: previewMode ? LARK_OUTPUT_PLUGIN_ACTION_PREVIEW : LARK_OUTPUT_PLUGIN_ACTION_NOTE,
                    plugin_id: canonicalId,
                    card_id: cardId
                  }
                }]
              }
            ]
          });
        }
      } else if (spec.kind === 'form-card') {
        const formElements: Array<Record<string, unknown>> = [];
        spec.fields.forEach((field, idx) => {
          const fieldKey = declarativeFormFieldKey(idx);
          if (field.type === 'select' && field.options.length > 0) {
            formElements.push({
              tag: 'markdown',
              content: `**${escapeLarkInlineMd(field.label)}**${field.required ? ' *' : ''}`,
              text_size: 'normal_v2',
              margin: idx === 0 ? '0px' : '4px 0px 0px 0px'
            });
            formElements.push({
              tag: 'select_static',
              name: fieldKey,
              width: 'fill',
              placeholder: { tag: 'plain_text', content: truncatePlain(field.placeholder || tShared(locale, 'lark.declarative.selectFieldPlaceholder', { label: field.label }), 60) },
              options: field.options.map(opt => ({
                text: { tag: 'plain_text', content: truncatePlain(opt.label, 40) },
                value: opt.value
              })),
              ...(field.value && field.options.some(opt => opt.value === field.value)
                ? { initial_option: field.value }
                : {}),
              required: field.required
            });
          } else {
            formElements.push({
              tag: 'input',
              name: fieldKey,
              width: 'fill',
              label: { tag: 'plain_text', content: truncatePlain(field.label, 40) },
              label_position: 'top',
              ...(field.value ? { default_value: field.value } : {}),
              placeholder: { tag: 'plain_text', content: truncatePlain(field.placeholder || tShared(locale, 'lark.declarative.inputFieldPlaceholder', { label: field.label }), 60) },
              required: field.required
            });
          }
        });

        formElements.push({
          tag: 'button',
          name: 'outp_form_submit',
          form_action_type: 'submit',
          type: 'primary',
          width: 'fill',
          margin: '4px 0px 0px 0px',
          text: { tag: 'plain_text', content: truncatePlain(spec.submitLabel || tShared(locale, 'lark.declarative.submitDefault'), 40) },
          behaviors: [{
            type: 'callback',
            value: {
              action: previewMode ? LARK_OUTPUT_PLUGIN_ACTION_PREVIEW : LARK_OUTPUT_PLUGIN_ACTION_FORM,
              plugin_id: canonicalId,
              card_id: cardId
            }
          }]
        });

        elements.push({
          tag: 'form',
          name: 'outp_form',
          element_id: 'outp_form',
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
          summary: { content: truncatePlain(`${title}${spec.summary ? `${colon}${spec.summary}` : ''}`, 110) }
        },
        header: {
          template: headerTemplateForTone(spec.tone),
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
      const responder = payload.responderName?.trim() || payload.actedBy?.trim();
      const sourceLabel = formatInteractionSourceBadge(payload.source, locale, { responderName: responder, variant: 'lark' });
      const actorPart = payload.source === 'assistant'
        ? ''
        : (payload.actedBy?.trim() ? tShared(locale, 'lark.confirm.answeredActor', { name: payload.actedBy.trim() }) : '');
      const baseTitle = tShared(locale, 'lark.declarative.answeredTitle', { title: payload.title?.trim() || plugin.name });
      const title = previewBanner ? `${previewBanner} ${baseTitle}` : baseTitle;
      const subtitle = tShared(locale, 'lark.confirm.answeredSubtitle', { source: sourceLabel, actor: actorPart });
      const colon = locale === 'en-US' ? ':' : '：';

      const elements: Array<Record<string, unknown>> = [];
      const answerBadgeEl = buildLarkSourceBadgeElement(
        sourceBadge ?? buildInteractionSourceLarkBadge(payload.source, locale, { responderName: responder }),
        {
          note: payload.source === 'assistant' ? undefined : payload.actedBy?.trim() || undefined,
          margin: '0px 0px 4px 0px'
        }
      );
      if (answerBadgeEl) elements.push(answerBadgeEl);
      const lines: string[] = [];
      if (payload.actionLabel || payload.actionValue) {
        lines.push(`**${tShared(locale, 'lark.declarative.actionLabel')}${colon}** <text_tag color='green'>${escapeLarkTagText(payload.actionLabel || payload.actionValue!, locale)}</text_tag>`);
      }
      for (const field of payload.fields) {
        lines.push(`**${escapeLarkInlineMd(truncatePlain(field.label, 80))}${colon}** ${escapeLarkInlineMd(truncatePlain(field.displayValue || field.value, 400))}`);
      }
      if (payload.note?.trim()) {
        lines.push(`> ${tShared(locale, 'lark.declarative.notePrefix', { text: escapeLarkInlineMd(truncatePlain(payload.note, 800)) })}`);
      }
      elements.push({
        tag: 'markdown',
        content: (lines.join('\n') || tShared(locale, 'lark.declarative.confirmedFallback')).slice(0, 12_000),
        text_size: 'normal_v2',
        margin: '0px'
      });
      elements.push({
        tag: 'markdown',
        content: `<font color='grey'>${tShared(locale, 'lark.ask.syncedContinue', { time: formatTimestamp(payload.actedAt) })}</font>`,
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
    },

    parseAction(spec, action, value, formValue, explicitLocale) {
      const locale = explicitLocale ?? getActiveServerLocale();
      if (action === LARK_OUTPUT_PLUGIN_ACTION_CLICK) {
        const actionValue = String(value.action_value ?? '').trim();
        const matched = spec.actions.find(item => item.value === actionValue);
        if (!matched) return { ok: false, error: tShared(locale, 'lark.declarative.error.actionNotFound') };
        return {
          ok: true,
          interaction: {
            actionValue: matched.value,
            actionLabel: matched.label
          }
        };
      }

      if (action === LARK_OUTPUT_PLUGIN_ACTION_NOTE) {
        const actionValue = String(formValue?.action_value ?? value.action_value ?? '').trim();
        const note = String(formValue?.note_text ?? '').trim();
        const matched = spec.actions.find(item => item.value === actionValue) ?? spec.actions[0];
        if (!matched) return { ok: false, error: tShared(locale, 'lark.declarative.error.actionNotFound') };
        if (!note) return { ok: false, error: tShared(locale, 'lark.declarative.error.emptyNote') };
        return {
          ok: true,
          interaction: {
            actionValue: matched.value,
            actionLabel: matched.label,
            note
          }
        };
      }

      if (action === LARK_OUTPUT_PLUGIN_ACTION_FORM) {
        const fields: Array<{ name: string; label: string; value: string; displayValue?: string }> = [];
        for (let idx = 0; idx < spec.fields.length; idx++) {
          const field = spec.fields[idx]!;
          const raw = formValue?.[declarativeFormFieldKey(idx)];
          const textVal = typeof raw === 'string' ? raw.trim() : raw !== undefined && raw !== null ? String(raw).trim() : '';
          if (field.required && !textVal) {
            return { ok: false, error: tShared(locale, 'lark.declarative.error.requiredField', { label: field.label }) };
          }
          if (!textVal) continue;
          const optLabel = field.options.find(opt => opt.value === textVal)?.label;
          fields.push({
            name: field.name,
            label: field.label,
            value: textVal,
            ...(optLabel && optLabel !== textVal ? { displayValue: optLabel } : {})
          });
        }
        if (!fields.length) {
          return { ok: false, error: tShared(locale, 'lark.declarative.error.emptyForm') };
        }
        return {
          ok: true,
          interaction: {
            actionValue: 'submit',
            actionLabel: spec.submitLabel || tShared(locale, 'lark.declarative.submitDefault'),
            fields
          }
        };
      }

      return { ok: false, error: tShared(locale, 'lark.declarative.error.unsupported') };
    }
  };
}
