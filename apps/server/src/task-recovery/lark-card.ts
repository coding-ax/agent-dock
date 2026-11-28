import {
  stripRecoveryVisiblePrefix,
  tShared,
  type Locale,
  type TaskRecoveryDecisionSource,
  type TaskRecoveryRecord
} from '@agent-dock/agent-dock-shared';
import { getActiveServerLocale } from '../locale-service.js';
import { webAccessSessionToken } from '../web-access.js';
import {
  buildInteractionSourceLarkBadge,
  buildLarkSourceBadgeElement,
  type LarkCardSourceBadge
} from '../lark/service.js';

export const LARK_TASK_RECOVERY_DECIDE_ACTION = 'task_recovery_decide';

export interface ParsedTaskRecoveryCardAction {
  recoveryId: string;
  cardId?: string;
  decision: 'resume' | 'dismiss';
}

function parseRawActionValue(value: unknown): Record<string, unknown> | undefined {
  let raw = value;
  if (typeof raw === 'string') {
    try { raw = JSON.parse(raw); } catch { return undefined; }
  }
  if (!raw || typeof raw !== 'object') return undefined;
  return raw as Record<string, unknown>;
}

export function isTaskRecoveryCardAction(value: unknown): boolean {
  const parsed = parseRawActionValue(value);
  return parsed?.action === LARK_TASK_RECOVERY_DECIDE_ACTION;
}

export function parseTaskRecoveryCardAction(value: unknown): ParsedTaskRecoveryCardAction | undefined {
  const parsed = parseRawActionValue(value);
  if (!parsed || parsed.action !== LARK_TASK_RECOVERY_DECIDE_ACTION) return undefined;
  const recoveryId = typeof parsed.recovery_id === 'string'
    ? parsed.recovery_id.trim()
    : typeof parsed.recoveryId === 'string'
      ? parsed.recoveryId.trim()
      : '';
  const decision = parsed.decision === 'resume' || parsed.decision === 'dismiss'
    ? parsed.decision
    : undefined;
  if (!recoveryId || !decision) return undefined;
  const cardId = typeof parsed.card_id === 'string' && parsed.card_id.trim()
    ? parsed.card_id.trim()
    : undefined;
  return { recoveryId, ...(cardId ? { cardId } : {}), decision };
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

function formatTimestamp(iso: string | null | undefined, locale: Locale): string {
  if (!iso) return tShared(locale, 'lark.recovery.justNow');
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function buildWebSessionFooter(sessionId: string, locale: Locale, webBaseUrl?: string): Array<Record<string, unknown>> {
  if (!webBaseUrl?.trim()) return [];
  const base = webBaseUrl.trim().replace(/\/$/, '');
  let url = `${base}/sessions/${sessionId}`;
  const token = webAccessSessionToken(sessionId);
  if (token) url += `?t=${token}`;
  return [{
    tag: 'markdown',
    content: `<font color='grey'>[${tShared(locale, 'lark.card.footer.viewSession')}](${url})</font>`,
    text_size: 'x-small',
    margin: '6px 0px 0px 0px'
  }];
}

function formatSourceActor(locale: Locale, source?: TaskRecoveryDecisionSource | null, decidedBy?: string | null): string {
  const actor = decidedBy?.trim();
  if (source === 'lark') {
    const label = tShared(locale, 'source.lark');
    return actor ? tShared(locale, 'lark.recovery.actorFormat', { source: label, actor }) : label;
  }
  if (source === 'web') {
    const label = tShared(locale, 'source.web');
    return actor ? tShared(locale, 'lark.recovery.actorFormat', { source: label, actor }) : label;
  }
  return tShared(locale, 'source.auto');
}

/**
 * 构建普通会话任务因服务重启中断时的飞书 Schema 2.0 交互确认卡片：
 * - 清晰标注中断时间与原请求摘要；
 * - 提供「继续执行」与「放弃 / 取消」两个回调按钮；
 * - 任一端（Web 或飞书）点击后原地锁定为只读结果卡。
 */
export function buildTaskRecoveryConfirmCard(input: {
  record: TaskRecoveryRecord;
  cardId: string;
  webBaseUrl?: string;
  sourceBadge?: LarkCardSourceBadge;
  locale?: Locale;
}): Record<string, unknown> {
  const { record, cardId, webBaseUrl } = input;
  const locale = input.locale ?? getActiveServerLocale();
  const excerpt = truncatePlain(stripRecoveryVisiblePrefix(record.originalPrompt) || tShared(locale, 'lark.recovery.noOriginalPrompt'), 160);
  const interruptedLabel = formatTimestamp(record.interruptedAt, locale);
  const colon = locale === 'en-US' ? ': ' : '：';
  const badgeEl = buildLarkSourceBadgeElement(
    input.sourceBadge ?? { label: tShared(locale, 'lark.sync.badge.recovery'), color: 'wathet' },
    { margin: '0px 0px 4px 0px' }
  );

  const elements: Array<Record<string, unknown>> = [
    ...(badgeEl ? [badgeEl] : []),
    {
      tag: 'markdown',
      content: `<text_tag color='orange'>${tShared(locale, 'lark.recovery.tagInterrupted')}</text_tag>  ${tShared(locale, 'lark.recovery.bodyPrompt', { time: escapeLarkInlineMd(interruptedLabel) })}`,
      text_size: 'normal_v2',
      margin: '0px 0px 6px 0px'
    },
    {
      tag: 'markdown',
      content: `> **${tShared(locale, 'lark.recovery.previousRequest')}**${colon}${escapeLarkInlineMd(excerpt)}`,
      text_size: 'notation',
      margin: '2px 0px 6px 0px'
    },
    {
      tag: 'markdown',
      content: `<font color='grey'>${tShared(locale, 'lark.recovery.guardrailHint')}</font>`,
      text_size: 'x-small',
      margin: '0px 0px 8px 0px'
    },
    {
      tag: 'button',
      element_id: 'task_recovery_resume',
      text: { tag: 'plain_text', content: tShared(locale, 'lark.recovery.btnResume') },
      type: 'primary',
      width: 'fill',
      margin: '4px 0px 0px 0px',
      behaviors: [{
        type: 'callback',
        value: {
          action: LARK_TASK_RECOVERY_DECIDE_ACTION,
          recovery_id: record.id,
          card_id: cardId,
          decision: 'resume'
        }
      }]
    },
    {
      tag: 'button',
      element_id: 'task_recovery_dismiss',
      text: { tag: 'plain_text', content: tShared(locale, 'lark.recovery.btnDismiss') },
      type: 'default',
      width: 'fill',
      margin: '6px 0px 0px 0px',
      behaviors: [{
        type: 'callback',
        value: {
          action: LARK_TASK_RECOVERY_DECIDE_ACTION,
          recovery_id: record.id,
          card_id: cardId,
          decision: 'dismiss'
        }
      }]
    },
    ...buildWebSessionFooter(record.sessionId, locale, webBaseUrl)
  ];

  return {
    schema: '2.0',
    config: {
      update_multi: true,
      width_mode: 'default',
      summary: { content: truncatePlain(tShared(locale, 'lark.recovery.summaryConfirm', { excerpt }), 110) }
    },
    header: {
      template: 'orange',
      title: { tag: 'plain_text', content: tShared(locale, 'lark.recovery.headerTitle') },
      subtitle: { tag: 'plain_text', content: tShared(locale, 'lark.recovery.headerSubtitle') }
    },
    body: {
      direction: 'vertical',
      vertical_spacing: '6px',
      padding: '12px',
      elements
    }
  };
}

/** Web 或飞书任一端完成决策后，原地将飞书确认卡锁定为只读结果卡。 */
export function buildTaskRecoveryResolvedCard(input: {
  record: TaskRecoveryRecord;
  webBaseUrl?: string;
  sourceBadge?: LarkCardSourceBadge;
  locale?: Locale;
}): Record<string, unknown> {
  const { record, webBaseUrl } = input;
  const locale = input.locale ?? getActiveServerLocale();
  const resumed = record.status === 'resumed';
  const excerpt = truncatePlain(stripRecoveryVisiblePrefix(record.originalPrompt) || tShared(locale, 'lark.recovery.noOriginalPrompt'), 140);
  const actor = formatSourceActor(locale, record.decidedSource, record.decidedBy);
  const decidedAt = formatTimestamp(record.decidedAt ?? record.updatedAt, locale);
  const colon = locale === 'en-US' ? ': ' : '：';
  const badgeEl = buildLarkSourceBadgeElement(
    input.sourceBadge ?? buildInteractionSourceLarkBadge(record.decidedSource ?? 'auto', locale),
    { note: record.decidedBy?.trim() || undefined, margin: '0px 0px 4px 0px' }
  );

  const elements: Array<Record<string, unknown>> = [
    ...(badgeEl ? [badgeEl] : []),
    {
      tag: 'markdown',
      content: resumed
        ? `<text_tag color='green'>${tShared(locale, 'lark.recovery.tagResumed')}</text_tag>  ${tShared(locale, 'lark.recovery.bodyResumed', { actor: escapeLarkInlineMd(actor) })}`
        : `<text_tag color='neutral'>${tShared(locale, 'lark.recovery.tagDismissed')}</text_tag>  ${tShared(locale, 'lark.recovery.bodyDismissed', { actor: escapeLarkInlineMd(actor) })}`,
      text_size: 'normal_v2',
      margin: '0px 0px 6px 0px'
    },
    {
      tag: 'markdown',
      content: `> **${tShared(locale, 'lark.recovery.originalRequest')}**${colon}${escapeLarkInlineMd(excerpt)}`,
      text_size: 'notation',
      margin: '2px 0px 4px 0px'
    },
    {
      tag: 'markdown',
      content: `<font color='grey'>${tShared(locale, 'lark.recovery.handledAt', { time: escapeLarkInlineMd(decidedAt) })}</font>`,
      text_size: 'x-small',
      margin: '0px 0px 2px 0px'
    },
    ...buildWebSessionFooter(record.sessionId, locale, webBaseUrl)
  ];

  const statusTag = resumed ? tShared(locale, 'lark.recovery.tagResumed') : tShared(locale, 'lark.recovery.tagDismissed');

  return {
    schema: '2.0',
    config: {
      update_multi: true,
      width_mode: 'default',
      summary: { content: truncatePlain(`${statusTag}${colon}${excerpt}`, 110) }
    },
    header: {
      template: resumed ? 'green' : 'grey',
      title: { tag: 'plain_text', content: resumed ? tShared(locale, 'lark.recovery.resolvedTitleResumed') : tShared(locale, 'lark.recovery.resolvedTitleDismissed') },
      subtitle: { tag: 'plain_text', content: resumed ? tShared(locale, 'lark.recovery.resolvedSubtitleResumed', { actor }) : tShared(locale, 'lark.recovery.resolvedSubtitleDismissed', { actor }) }
    },
    body: {
      direction: 'vertical',
      vertical_spacing: '6px',
      padding: '12px',
      elements
    }
  };
}
