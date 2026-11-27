import type {
  LarkPreviewChatMessage,
  LarkRegexMatchSpan,
  LarkRegexPromptTemplate,
  LarkRegexTemplateVariable,
  LarkRegexTriggerHit
} from './api';

export interface HighlightSegment {
  text: string;
  matched: boolean;
}

/**
 * 将原始消息文本按精确命中区间切分为普通片段与高亮片段。
 * 会自动排序、截断越界坐标并合并重叠区间，保证前端渲染绝不丢字或重复字。
 */
export function splitTextByMatchSpans(text: string, spans: readonly LarkRegexMatchSpan[]): HighlightSegment[] {
  if (!text) return [{ text: '', matched: false }];
  if (!spans.length) return [{ text, matched: false }];

  const normalized = spans
    .map(span => ({
      start: Math.max(0, Math.min(text.length, Math.floor(span.start))),
      end: Math.max(0, Math.min(text.length, Math.floor(span.end)))
    }))
    .filter(span => span.end > span.start)
    .sort((a, b) => a.start - b.start || a.end - b.end);

  if (!normalized.length) return [{ text, matched: false }];

  const merged: Array<{ start: number; end: number }> = [];
  for (const span of normalized) {
    const prev = merged[merged.length - 1];
    if (prev && span.start <= prev.end) {
      prev.end = Math.max(prev.end, span.end);
    } else {
      merged.push({ ...span });
    }
  }

  const segments: HighlightSegment[] = [];
  let cursor = 0;
  for (const span of merged) {
    if (span.start > cursor) {
      segments.push({ text: text.slice(cursor, span.start), matched: false });
    }
    segments.push({ text: text.slice(span.start, span.end), matched: true });
    cursor = span.end;
  }
  if (cursor < text.length) {
    segments.push({ text: text.slice(cursor), matched: false });
  }
  return segments;
}

/**
 * 在 Prompt 编辑器的当前光标处插入模板变量芯片，并返回新的文本与光标位置。
 */
export function insertVariableAtCursor(
  value: string,
  token: string,
  selectionStart?: number | null,
  selectionEnd?: number | null
): { nextValue: string; nextCursor: number } {
  const start = typeof selectionStart === 'number' && selectionStart >= 0 ? Math.min(selectionStart, value.length) : value.length;
  const end = typeof selectionEnd === 'number' && selectionEnd >= start ? Math.min(selectionEnd, value.length) : start;
  const nextValue = `${value.slice(0, start)}${token}${value.slice(end)}`;
  return { nextValue, nextCursor: start + token.length };
}

export function formatLarkMessageClock(createdAt?: string, createTime?: string): string {
  const tryDate = (raw?: string): Date | undefined => {
    const trimmed = String(raw ?? '').trim();
    if (!trimmed) return undefined;
    if (/^\d{10,13}$/.test(trimmed)) {
      const ms = trimmed.length === 10 ? Number(trimmed) * 1000 : Number(trimmed);
      const d = new Date(ms);
      return Number.isNaN(d.getTime()) ? undefined : d;
    }
    const d = new Date(trimmed);
    return Number.isNaN(d.getTime()) ? undefined : d;
  };
  const date = tryDate(createdAt) ?? tryDate(createTime);
  if (!date || date.getTime() <= 0) return '';
  const now = new Date();
  const sameDay = date.getFullYear() === now.getFullYear()
    && date.getMonth() === now.getMonth()
    && date.getDate() === now.getDate();
  return sameDay
    ? date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    : date.toLocaleString([], { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
}

export function normalizeRegexFlagSet(flags: string): string {
  const allowed = ['i', 'm', 's', 'u'] as const;
  const set = new Set(flags.split(''));
  return allowed.filter(flag => set.has(flag)).join('');
}

export function toggleRegexFlag(flags: string, flag: 'i' | 'm' | 's' | 'u'): string {
  const set = new Set(flags.split(''));
  if (set.has(flag)) set.delete(flag);
  else set.add(flag);
  return normalizeRegexFlagSet([...set].join(''));
}

export interface BackfillSelectionStats {
  matchedIds: string[];
  uncompensatedMatchedIds: string[];
  compensatedMatchedCount: number;
  selectedCount: number;
}

export function computeBackfillSelectionStats(
  messages: readonly LarkPreviewChatMessage[],
  matchById: ReadonlyMap<string, { matched: boolean; matches: LarkRegexMatchSpan[]; skippedBot?: boolean }>,
  hitsByMessageId: Record<string, LarkRegexTriggerHit[]>,
  localTriggeredIds: ReadonlySet<string>,
  selectedIds: ReadonlySet<string>
): BackfillSelectionStats {
  const matchedIds: string[] = [];
  const uncompensatedMatchedIds: string[] = [];
  let compensatedMatchedCount = 0;

  for (const msg of messages) {
    const preview = matchById.get(msg.messageId);
    if (!preview?.matched) continue;
    matchedIds.push(msg.messageId);
    const hasTriggeredHit = localTriggeredIds.has(msg.messageId)
      || Boolean(hitsByMessageId[msg.messageId]?.some(hit => hit.status === 'triggered'));
    if (hasTriggeredHit) {
      compensatedMatchedCount += 1;
    } else {
      uncompensatedMatchedIds.push(msg.messageId);
    }
  }

  let selectedCount = 0;
  for (const id of matchedIds) {
    if (selectedIds.has(id)) selectedCount += 1;
  }

  return {
    matchedIds,
    uncompensatedMatchedIds,
    compensatedMatchedCount,
    selectedCount
  };
}

export const DEFAULT_REGEX_QUICK_PROMPTS: Array<{ label: string; instruction: string }> = [
  { label: 'P0/P1 告警或线上报错', instruction: '匹配包含 P0/P1 告警、线上报错、5xx、timeout 或 OOM 的群聊消息' },
  { label: '需求 / 工单提报', instruction: '匹配群里提交需求、工单、BUG、缺陷或 ISSUE 编号的消息' },
  { label: '部署与发布通知', instruction: '匹配包含上线通知、发布完成、回滚或灰度发布的播报消息' },
  { label: '关键词技术答疑', instruction: '匹配群成员询问如何配置、怎么接入、文档在哪或报错怎么解决的提问' }
];

export const FALLBACK_TEMPLATE_VARIABLES: readonly LarkRegexTemplateVariable[] = [
  { key: 'chatName', token: '{{chatName}}', label: '群聊名称', description: '触发消息所在飞书群的名称' },
  { key: 'chatId', token: '{{chatId}}', label: '群聊 ID', description: '飞书群聊 oc_ 开头的唯一标识' },
  { key: 'botName', token: '{{botName}}', label: '机器人名称', description: '当前负责响应的飞书机器人名称' },
  { key: 'ruleName', token: '{{ruleName}}', label: '规则名称', description: '命中的正则监听规则名称' },
  { key: 'pattern', token: '{{pattern}}', label: '正则表达式', description: '命中该消息的正则表达式文本' },
  { key: 'senderName', token: '{{senderName}}', label: '发送人', description: '发送该条群聊消息的成员姓名' },
  { key: 'messageTime', token: '{{messageTime}}', label: '消息时间', description: '该条消息在群内发出的时间' },
  { key: 'messageText', token: '{{messageText}}', label: '原始消息', description: '解析后的群聊消息完整正文' },
  { key: 'matchedText', token: '{{matchedText}}', label: '命中片段', description: '正则表达式实际命中的子串内容' }
];

export const FALLBACK_PROMPT_TEMPLATES: readonly LarkRegexPromptTemplate[] = [
  {
    id: 'incident-triage',
    name: '告警 / 故障自动排查',
    badge: '告警运维',
    description: '自动识别 P0/P1 告警、5xx 或线上异常，快速输出影响判断、根因假设与止血建议',
    suggestedPattern: '(?:P[01]|告警|报警|线上异常|报错|50[0234]|timeout|OOM|panic)',
    suggestedFlags: 'i',
    suggestedReplyMode: 'thread',
    promptTemplate: [
      '你正在响应飞书群「{{chatName}}」中的一条告警/故障消息（命中片段：{{matchedText}}），请按以下顺序快速处理：',
      '1. 先用 1-2 句话提炼故障现象、受影响模块与紧急程度。',
      '2. 结合当前工作区代码或日志线索，列出最可能的 2-3 个根因假设及排查命令。',
      '3. 给出立即可执行的止血/降级/回滚建议，结论先行、避免冗长寒暄。'
    ].join('\n')
  },
  {
    id: 'ticket-breakdown',
    name: '需求 / 工单拆解响应',
    badge: '产研协作',
    description: '命中需求、工单或缺陷提报时，自动拆解上下文、验收标准与待澄清问题',
    suggestedPattern: '(?:需求|工单|BUG|缺陷|ISSUE-\\d+|帮忙排查|麻烦看下)',
    suggestedFlags: 'i',
    suggestedReplyMode: 'thread',
    promptTemplate: [
      '群成员 {{senderName}} 在「{{chatName}}」提交了一条需求/工单相关消息，请协助快速响应：',
      '1. 概括核心诉求、目标对象与已知约束。',
      '2. 拆解可执行子任务与验收要点；若关键信息缺失，列出最多 3 个最需要补充确认的问题。',
      '3. 输出简洁清晰的 Markdown 要点，方便团队直接在话题内接力推进。'
    ].join('\n')
  },
  {
    id: 'group-qa',
    name: '群聊关键词答疑',
    badge: '知识答疑',
    description: '命中常见技术或业务提问关键词时，结合工作区文档与源码给出可验证回答',
    suggestedPattern: '(?:怎么配置|如何接入|文档在哪|报错怎么解决|怎么用|有没有人知道)',
    suggestedFlags: 'i',
    suggestedReplyMode: 'thread',
    promptTemplate: [
      '请结合当前工作区代码和文档，准确回答群聊「{{chatName}}」中 {{senderName}} 的提问：',
      '- 优先给出直接结论与可复现的操作步骤（附关键文件路径或命令）。',
      '- 如上下文不足以确认答案，请明确说明不确定之处，切勿编造接口、参数或内部流程。'
    ].join('\n')
  },
  {
    id: 'monitor-digest',
    name: '监控摘要记录',
    badge: '巡检摘要',
    description: '命中发布完成、巡检报告或指标播报时，提取关键指标与需跟进风险项',
    suggestedPattern: '(?:发布完成|上线通知|巡检报告|日报|周报|指标波动|SLA)',
    suggestedFlags: 'i',
    suggestedReplyMode: 'main',
    promptTemplate: [
      '请对「{{chatName}}」在 {{messageTime}} 收到的播报/监控消息生成结构化摘要：',
      '- 核心事件与变更范围',
      '- 关键指标或核心结论（用精炼要点或表格列出）',
      '- 需要人工跟进的风险/异常项（无则注明「暂无明显风险」）'
    ].join('\n')
  }
];
