import type {
  LarkPreviewChatMessage,
  LarkRegexMatchSpan,
  LarkRegexPromptTemplate,
  LarkRegexTemplateVariable,
  LarkRegexTriggerHit
} from './api';
import { bi } from './i18n';

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

const RAW_REGEX_QUICK_PROMPTS = [
  {
    label: 'P0/P1 告警或线上报错',
    labelEn: 'P0/P1 Alerts & Prod Errors',
    instruction: '匹配包含 P0/P1 告警、线上报错、5xx、timeout 或 OOM 的群聊消息',
    instructionEn: 'Match group messages containing P0/P1 alerts, 5xx errors, timeouts, or OOM'
  },
  {
    label: '需求 / 工单提报',
    labelEn: 'Feature / Issue Reports',
    instruction: '匹配群里提交需求、工单、BUG、缺陷或 ISSUE 编号的消息',
    instructionEn: 'Match messages reporting bugs, tickets, or ISSUE-123 references'
  },
  {
    label: '部署与发布通知',
    labelEn: 'Deploy & Release Notices',
    instruction: '匹配包含上线通知、发布完成、回滚或灰度发布的播报消息',
    instructionEn: 'Match release announcements, rollouts, rollbacks, or canary notices'
  },
  {
    label: '关键词技术答疑',
    labelEn: 'Technical Q&A Keywords',
    instruction: '匹配群成员询问如何配置、怎么接入、文档在哪或报错怎么解决的提问',
    instructionEn: 'Match group questions asking how to configure, integrate, or fix errors'
  }
];

export const DEFAULT_REGEX_QUICK_PROMPTS: Array<{ label: string; instruction: string }> = RAW_REGEX_QUICK_PROMPTS.map(item => ({
  get label() { return bi(item.label, item.labelEn); },
  get instruction() { return bi(item.instruction, item.instructionEn); }
}));

const RAW_TEMPLATE_VARIABLES = [
  { key: 'chatName', token: '{{chatName}}', label: '群聊名称', labelEn: 'Group Name', description: '触发消息所在飞书群的名称', descriptionEn: 'Name of the Lark group where the message occurred' },
  { key: 'chatId', token: '{{chatId}}', label: '群聊 ID', labelEn: 'Group ID', description: '飞书群聊 oc_ 开头的唯一标识', descriptionEn: 'Unique Lark chat ID starting with oc_' },
  { key: 'botName', token: '{{botName}}', label: '机器人名称', labelEn: 'Bot Name', description: '当前负责响应的飞书机器人名称', descriptionEn: 'Name of the responding Lark bot' },
  { key: 'ruleName', token: '{{ruleName}}', label: '规则名称', labelEn: 'Rule Name', description: '命中的正则监听规则名称', descriptionEn: 'Name of the matched regex trigger rule' },
  { key: 'pattern', token: '{{pattern}}', label: '正则表达式', labelEn: 'Regex Pattern', description: '命中该消息的正则表达式文本', descriptionEn: 'Regex pattern that matched the message' },
  { key: 'senderName', token: '{{senderName}}', label: '发送人', labelEn: 'Sender', description: '发送该条群聊消息的成员姓名', descriptionEn: 'Name of the group member who sent the message' },
  { key: 'messageTime', token: '{{messageTime}}', label: '消息时间', labelEn: 'Message Time', description: '该条消息在群内发出的时间', descriptionEn: 'Timestamp when the message was sent' },
  { key: 'messageText', token: '{{messageText}}', label: '原始消息', labelEn: 'Message Text', description: '解析后的群聊消息完整正文', descriptionEn: 'Full parsed text of the group message' },
  { key: 'matchedText', token: '{{matchedText}}', label: '命中片段', labelEn: 'Matched Text', description: '正则表达式实际命中的子串内容', descriptionEn: 'Exact substring matched by the regex' }
];

export const FALLBACK_TEMPLATE_VARIABLES: readonly LarkRegexTemplateVariable[] = RAW_TEMPLATE_VARIABLES.map(item => ({
  key: item.key,
  token: item.token,
  get label() { return bi(item.label, item.labelEn); },
  get description() { return bi(item.description, item.descriptionEn); }
}));

const RAW_PROMPT_TEMPLATES = [
  {
    id: 'incident-triage',
    name: '告警 / 故障自动排查',
    nameEn: 'Incident & Alert Triage',
    badge: '告警运维',
    badgeEn: 'Ops / Alerts',
    description: '自动识别 P0/P1 告警、5xx 或线上异常，快速输出影响判断、根因假设与止血建议',
    descriptionEn: 'Detects P0/P1 alerts, 5xx, or outages and outputs impact assessment, root-cause hypotheses, and mitigation steps',
    suggestedPattern: '(?:P[01]|告警|报警|线上异常|报错|50[0234]|timeout|OOM|panic)',
    suggestedPatternEn: '(?:P[01]|alert|outage|error|50[0234]|timeout|OOM|panic)',
    suggestedFlags: 'i',
    suggestedReplyMode: 'thread' as const,
    promptTemplate: [
      '你正在响应飞书群「{{chatName}}」中的一条告警/故障消息（命中片段：{{matchedText}}），请按以下顺序快速处理：',
      '1. 先用 1-2 句话提炼故障现象、受影响模块与紧急程度。',
      '2. 结合当前工作区代码或日志线索，列出最可能的 2-3 个根因假设及排查命令。',
      '3. 给出立即可执行的止血/降级/回滚建议，结论先行、避免冗长寒暄。'
    ].join('\n'),
    promptTemplateEn: [
      'You are triaging an alert in Lark group "{{chatName}}" (matched: {{matchedText}}). Respond concisely:',
      '1. Summarize symptoms, affected components, and severity in 1–2 sentences.',
      '2. Inspect workspace code/logs and list the top 2–3 root-cause hypotheses with diagnostic commands.',
      '3. Provide immediate mitigation, fallback, or rollback actions — lead with conclusions.'
    ].join('\n')
  },
  {
    id: 'ticket-breakdown',
    name: '需求 / 工单拆解响应',
    nameEn: 'Ticket & Spec Breakdown',
    badge: '产研协作',
    badgeEn: 'Product / Eng',
    description: '命中需求、工单或缺陷提报时，自动拆解上下文、验收标准与待澄清问题',
    descriptionEn: 'Breaks down incoming bug reports or feature requests into subtasks, acceptance criteria, and open questions',
    suggestedPattern: '(?:需求|工单|BUG|缺陷|ISSUE-\\d+|帮忙排查|麻烦看下)',
    suggestedPatternEn: '(?:feature|ticket|BUG|defect|ISSUE-\\d+|please check)',
    suggestedFlags: 'i',
    suggestedReplyMode: 'thread' as const,
    promptTemplate: [
      '群成员 {{senderName}} 在「{{chatName}}」提交了一条需求/工单相关消息，请协助快速响应：',
      '1. 概括核心诉求、目标对象与已知约束。',
      '2. 拆解可执行子任务与验收要点；若关键信息缺失，列出最多 3 个最需要补充确认的问题。',
      '3. 输出简洁清晰的 Markdown 要点，方便团队直接在话题内接力推进。'
    ].join('\n'),
    promptTemplateEn: [
      '{{senderName}} posted a ticket/request in "{{chatName}}". Help respond quickly:',
      '1. Summarize core goals, scope, and known constraints.',
      '2. Break down actionable subtasks and acceptance checks; list up to 3 clarifying questions if needed.',
      '3. Keep the reply crisp in Markdown so the team can follow up directly in the thread.'
    ].join('\n')
  },
  {
    id: 'group-qa',
    name: '群聊关键词答疑',
    nameEn: 'Group Technical Q&A',
    badge: '知识答疑',
    badgeEn: 'Knowledge Q&A',
    description: '命中常见技术或业务提问关键词时，结合工作区文档与源码给出可验证回答',
    descriptionEn: 'Answers recurring technical questions using workspace docs and source code',
    suggestedPattern: '(?:怎么配置|如何接入|文档在哪|报错怎么解决|怎么用|有没有人知道)',
    suggestedPatternEn: '(?:how to configure|how to integrate|where are docs|how to fix|anyone know)',
    suggestedFlags: 'i',
    suggestedReplyMode: 'thread' as const,
    promptTemplate: [
      '请结合当前工作区代码和文档，准确回答群聊「{{chatName}}」中 {{senderName}} 的提问：',
      '- 优先给出直接结论与可复现的操作步骤（附关键文件路径或命令）。',
      '- 如上下文不足以确认答案，请明确说明不确定之处，切勿编造接口、参数或内部流程。'
    ].join('\n'),
    promptTemplateEn: [
      'Answer {{senderName}}\'s question in "{{chatName}}" using the current workspace code and docs:',
      '- Lead with a direct answer and reproducible steps (include relevant file paths or commands).',
      '- If context is insufficient, state uncertainties clearly instead of guessing APIs or behavior.'
    ].join('\n')
  },
  {
    id: 'monitor-digest',
    name: '监控摘要记录',
    nameEn: 'Monitoring Digest',
    badge: '巡检摘要',
    badgeEn: 'Digest',
    description: '命中发布完成、巡检报告或指标播报时，提取关键指标与需跟进风险项',
    descriptionEn: 'Extracts key metrics and follow-up risks from release notices and status reports',
    suggestedPattern: '(?:发布完成|上线通知|巡检报告|日报|周报|指标波动|SLA)',
    suggestedPatternEn: '(?:release complete|deploy notice|health report|daily digest|SLA)',
    suggestedFlags: 'i',
    suggestedReplyMode: 'main' as const,
    promptTemplate: [
      '请对「{{chatName}}」在 {{messageTime}} 收到的播报/监控消息生成结构化摘要：',
      '- 核心事件与变更范围',
      '- 关键指标或核心结论（用精炼要点或表格列出）',
      '- 需要人工跟进的风险/异常项（无则注明「暂无明显风险」）'
    ].join('\n'),
    promptTemplateEn: [
      'Generate a structured digest for the status broadcast in "{{chatName}}" at {{messageTime}}:',
      '- Key event and change scope',
      '- Core metrics or takeaways (bullet list or compact table)',
      '- Risks/anomalies requiring follow-up (or state "No immediate risks")'
    ].join('\n')
  }
];

export const FALLBACK_PROMPT_TEMPLATES: readonly LarkRegexPromptTemplate[] = RAW_PROMPT_TEMPLATES.map(item => ({
  id: item.id,
  suggestedFlags: item.suggestedFlags,
  suggestedReplyMode: item.suggestedReplyMode,
  get name() { return bi(item.name, item.nameEn); },
  get badge() { return bi(item.badge, item.badgeEn); },
  get description() { return bi(item.description, item.descriptionEn); },
  get suggestedPattern() { return bi(item.suggestedPattern, item.suggestedPatternEn); },
  get promptTemplate() { return bi(item.promptTemplate, item.promptTemplateEn); }
}));
