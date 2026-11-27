import {
  normalizeOutputPluginId,
  type DeclarativeOutputPluginInteractionPayload,
  type DeclarativeOutputPluginSpec,
  type OutputPluginAccentTone,
  type OutputPluginDefinition
} from '@agent-dock/agent-dock-shared';
import { webAccessSessionToken } from '../../web-access.js';
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

function escapeLarkTagText(value: string): string {
  return truncatePlain(value.replace(/[<>&'"]/g, ''), 40) || '已响应';
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

function buildWebSessionFooter(sessionId?: string, webBaseUrl?: string): Array<Record<string, unknown>> {
  if (!webBaseUrl) return [];
  const base = webBaseUrl.replace(/\/$/, '');
  let url = sessionId ? `${base}/sessions/${sessionId}` : `${base}/sessions`;
  const token = sessionId ? webAccessSessionToken(sessionId) : undefined;
  if (token) url += `?t=${token}`;
  return [{
    tag: 'markdown',
    content: `<font color='grey'>[在 AgentDock 查看会话](${url})</font>`,
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
    streamingPlaceholderText: defaults?.streamingPlaceholderText || `⏳ 正在生成「${plugin.name}」卡片…`,

    handlesAction(action, value): boolean {
      if (!LARK_DECLARATIVE_PLUGIN_ACTIONS.has(action)) return false;
      const targetId = typeof value.plugin_id === 'string' ? normalizeOutputPluginId(value.plugin_id) : '';
      return !targetId || targetId === canonicalId;
    },

    isPreviewAction(action): boolean {
      return action === LARK_OUTPUT_PLUGIN_ACTION_PREVIEW;
    },

    buildCard({ cardId, spec, sessionId, webBaseUrl, previewBanner, previewMode }) {
      const baseTitle = spec.title?.trim() || plugin.name;
      const title = previewBanner ? `${previewBanner} ${baseTitle}` : baseTitle;
      const subtitle = previewMode
        ? `AgentDock · ${plugin.name} 飞书预览`
        : spec.kind === 'info-card'
          ? `AgentDock · ${plugin.name}`
          : spec.kind === 'form-card'
            ? `AgentDock · ${plugin.name}（填写后提交）`
            : `AgentDock · ${plugin.name}（点击按钮直接响应）`;

      const elements: Array<Record<string, unknown>> = [];

      if (spec.status?.trim()) {
        elements.push({
          tag: 'markdown',
          content: `<text_tag color='${headerTemplateForTone(spec.tone)}'>${escapeLarkTagText(spec.status)}</text_tag>`,
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
          return `• **${escapeLarkInlineMd(field.label)}**：${val}`;
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
                placeholder: { tag: 'plain_text', content: '选择操作（带备注提交）' },
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
                label: { tag: 'plain_text', content: '补充说明' },
                label_position: 'top',
                placeholder: {
                  tag: 'plain_text',
                  content: truncatePlain(spec.notePlaceholder || '输入补充说明后提交…', 60)
                },
                required: true
              },
              {
                tag: 'button',
                name: 'outp_note_submit',
                form_action_type: 'submit',
                type: 'default',
                width: 'fill',
                text: { tag: 'plain_text', content: '附带说明提交' },
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
              placeholder: { tag: 'plain_text', content: truncatePlain(field.placeholder || `请选择${field.label}`, 60) },
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
              placeholder: { tag: 'plain_text', content: truncatePlain(field.placeholder || `请输入${field.label}`, 60) },
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
          text: { tag: 'plain_text', content: truncatePlain(spec.submitLabel || '提交', 40) },
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

      elements.push(...buildWebSessionFooter(sessionId, webBaseUrl));

      return {
        schema: '2.0',
        config: {
          update_multi: true,
          width_mode: 'default',
          summary: { content: truncatePlain(`${title}${spec.summary ? `：${spec.summary}` : ''}`, 110) }
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

    buildAnsweredCard({ payload, sessionId, webBaseUrl, previewBanner }) {
      const sourceLabel = payload.source === 'web' ? '网页端' : '飞书';
      const actorPart = payload.actedBy?.trim() ? ` · 操作人：${payload.actedBy.trim()}` : '';
      const baseTitle = payload.title?.trim()
        ? `✅ ${payload.title.trim()}（已响应）`
        : `✅ ${plugin.name}（已响应）`;
      const title = previewBanner ? `${previewBanner} ${baseTitle}` : baseTitle;
      const subtitle = `来源：${sourceLabel}${actorPart}`;

      const elements: Array<Record<string, unknown>> = [];
      const lines: string[] = [];
      if (payload.actionLabel || payload.actionValue) {
        lines.push(`**操作：** <text_tag color='green'>${escapeLarkTagText(payload.actionLabel || payload.actionValue!)}</text_tag>`);
      }
      for (const field of payload.fields) {
        lines.push(`**${escapeLarkInlineMd(field.label)}：** ${escapeLarkInlineMd(field.displayValue || field.value)}`);
      }
      if (payload.note?.trim()) {
        lines.push(`> 补充说明：${escapeLarkInlineMd(payload.note)}`);
      }
      elements.push({
        tag: 'markdown',
        content: lines.join('\n') || '已确认响应。',
        text_size: 'normal_v2',
        margin: '0px'
      });
      elements.push({
        tag: 'markdown',
        content: `<font color='grey'>已同步至 AgentDock 会话并继续执行 · ${formatTimestamp(payload.actedAt)}</font>`,
        text_size: 'x-small',
        margin: '6px 0px 0px 0px'
      });
      elements.push(...buildWebSessionFooter(sessionId, webBaseUrl));

      return {
        schema: '2.0',
        config: {
          update_multi: true,
          width_mode: 'default',
          summary: { content: truncatePlain(`${title}（${sourceLabel}）`, 110) }
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

    parseAction(spec, action, value, formValue) {
      if (action === LARK_OUTPUT_PLUGIN_ACTION_CLICK) {
        const actionValue = String(value.action_value ?? '').trim();
        const matched = spec.actions.find(item => item.value === actionValue);
        if (!matched) return { ok: false, error: '未找到对应的操作选项' };
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
        if (!matched) return { ok: false, error: '未找到对应的操作选项' };
        if (!note) return { ok: false, error: '请先填写补充说明后再提交' };
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
            return { ok: false, error: `请先填写「${field.label}」` };
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
          return { ok: false, error: '请至少填写一项后再提交' };
        }
        return {
          ok: true,
          interaction: {
            actionValue: 'submit',
            actionLabel: spec.submitLabel || '提交',
            fields
          }
        };
      }

      return { ok: false, error: '不支持的插件卡片操作' };
    }
  };
}
