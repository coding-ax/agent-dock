import { stripRecoveryVisiblePrefix, type TaskRecoveryDecisionSource, type TaskRecoveryRecord } from '@agent-dock/agent-dock-shared';
import { webAccessSessionToken } from '../web-access.js';

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

function formatTimestamp(iso: string | null | undefined): string {
  if (!iso) return '刚刚';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function buildWebSessionFooter(sessionId: string, webBaseUrl?: string): Array<Record<string, unknown>> {
  if (!webBaseUrl?.trim()) return [];
  const base = webBaseUrl.trim().replace(/\/$/, '');
  let url = `${base}/sessions/${sessionId}`;
  const token = webAccessSessionToken(sessionId);
  if (token) url += `?t=${token}`;
  return [{
    tag: 'markdown',
    content: `<font color='grey'>[在 AgentDock 查看会话](${url})</font>`,
    text_size: 'x-small',
    margin: '6px 0px 0px 0px'
  }];
}

function formatSourceActor(source?: TaskRecoveryDecisionSource | null, decidedBy?: string | null): string {
  const actor = decidedBy?.trim();
  if (source === 'lark') return actor ? `飞书 · ${actor}` : '飞书';
  if (source === 'web') return actor ? `网页端 · ${actor}` : '网页端';
  return '自动恢复';
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
}): Record<string, unknown> {
  const { record, cardId, webBaseUrl } = input;
  const excerpt = truncatePlain(stripRecoveryVisiblePrefix(record.originalPrompt) || '未记录原始请求文本', 160);
  const interruptedLabel = formatTimestamp(record.interruptedAt);

  const elements: Array<Record<string, unknown>> = [
    {
      tag: 'markdown',
      content: `<text_tag color='orange'>服务重启中断</text_tag>  该任务在 **${escapeLarkInlineMd(interruptedLabel)}** 因 AgentDock 服务重启被动中断，是否继续执行？`,
      text_size: 'normal_v2',
      margin: '0px 0px 6px 0px'
    },
    {
      tag: 'markdown',
      content: `> **中断前请求**：${escapeLarkInlineMd(excerpt)}`,
      text_size: 'notation',
      margin: '2px 0px 6px 0px'
    },
    {
      tag: 'markdown',
      content: "<font color='grey'>继续执行前 Agent 会先核对工作区与已完成进度，不重复发消息、发版或删文件等副作用操作。</font>",
      text_size: 'x-small',
      margin: '0px 0px 8px 0px'
    },
    {
      tag: 'button',
      element_id: 'task_recovery_resume',
      text: { tag: 'plain_text', content: '继续执行（断点自检续跑）' },
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
      text: { tag: 'plain_text', content: '放弃 / 取消' },
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
    ...buildWebSessionFooter(record.sessionId, webBaseUrl)
  ];

  return {
    schema: '2.0',
    config: {
      update_multi: true,
      width_mode: 'default',
      summary: { content: truncatePlain(`任务因服务重启中断，是否继续：${excerpt}`, 110) }
    },
    header: {
      template: 'orange',
      title: { tag: 'plain_text', content: '任务因服务重启中断' },
      subtitle: { tag: 'plain_text', content: 'AgentDock · 请确认是否继续执行' }
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
}): Record<string, unknown> {
  const { record, webBaseUrl } = input;
  const resumed = record.status === 'resumed';
  const excerpt = truncatePlain(stripRecoveryVisiblePrefix(record.originalPrompt) || '未记录原始请求文本', 140);
  const actor = formatSourceActor(record.decidedSource, record.decidedBy);
  const decidedAt = formatTimestamp(record.decidedAt ?? record.updatedAt);

  const elements: Array<Record<string, unknown>> = [
    {
      tag: 'markdown',
      content: resumed
        ? `<text_tag color='green'>已继续执行</text_tag>  已通过 **${escapeLarkInlineMd(actor)}** 触发断点自检续跑。`
        : `<text_tag color='neutral'>已放弃续跑</text_tag>  已通过 **${escapeLarkInlineMd(actor)}** 放弃本次恢复并锁定。`,
      text_size: 'normal_v2',
      margin: '0px 0px 6px 0px'
    },
    {
      tag: 'markdown',
      content: `> **原请求**：${escapeLarkInlineMd(excerpt)}`,
      text_size: 'notation',
      margin: '2px 0px 4px 0px'
    },
    {
      tag: 'markdown',
      content: `<font color='grey'>处理时间：${escapeLarkInlineMd(decidedAt)}</font>`,
      text_size: 'x-small',
      margin: '0px 0px 2px 0px'
    },
    ...buildWebSessionFooter(record.sessionId, webBaseUrl)
  ];

  return {
    schema: '2.0',
    config: {
      update_multi: true,
      width_mode: 'default',
      summary: { content: truncatePlain(`${resumed ? '已继续执行' : '已放弃续跑'}：${excerpt}`, 110) }
    },
    header: {
      template: resumed ? 'green' : 'grey',
      title: { tag: 'plain_text', content: resumed ? '已确认继续执行' : '已放弃断点续跑' },
      subtitle: { tag: 'plain_text', content: resumed ? `AgentDock · ${actor}已触发续跑` : `AgentDock · ${actor}已归档锁定` }
    },
    body: {
      direction: 'vertical',
      vertical_spacing: '6px',
      padding: '12px',
      elements
    }
  };
}
