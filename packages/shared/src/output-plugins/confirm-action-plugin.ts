import { z } from 'zod';
import {
  BUILTIN_CONFIRM_ACTION_PLUGIN_ID,
  OUTPUT_PLUGIN_INTERACTION_ORIGIN_PREFIX,
  outputPluginInteractionSources,
  type OutputPluginDefinition,
  type OutputPluginParseResult,
  type OutputPluginStreamingSplit
} from './types.js';
import {
  decodeXmlEntities,
  detectPendingStreamingXmlTag,
  extractTrailingXmlBlock,
  fnv1aHex,
  parseBooleanAttr,
  parseXmlAttributes
} from './xml-utils.js';

export const CONFIRM_ACTION_XML_TAG = 'agentdock-confirm-action';
export const CONFIRM_ACTION_INTERACTION_ORIGIN = `${OUTPUT_PLUGIN_INTERACTION_ORIGIN_PREFIX}${BUILTIN_CONFIRM_ACTION_PLUGIN_ID}`;

export const confirmActionRisks = ['low', 'medium', 'high'] as const;
export type ConfirmActionRisk = (typeof confirmActionRisks)[number];

export const confirmActionDecisions = ['confirm', 'cancel'] as const;
export type ConfirmActionDecision = (typeof confirmActionDecisions)[number];

export interface ConfirmActionDetailItem {
  label: string;
  value: string;
}

export interface ConfirmActionSpec {
  id: string;
  title: string;
  summary?: string;
  risk: ConfirmActionRisk;
  command?: string;
  details: ConfirmActionDetailItem[];
  confirmLabel: string;
  cancelLabel: string;
  allowComment: boolean;
  commentPlaceholder?: string;
}

export const confirmActionInteractionPayloadSchema = z.object({
  version: z.literal(1),
  pluginId: z.literal(BUILTIN_CONFIRM_ACTION_PLUGIN_ID).default(BUILTIN_CONFIRM_ACTION_PLUGIN_ID),
  actionId: z.string().trim().min(1).max(200),
  title: z.string().trim().max(300).optional(),
  risk: z.enum(confirmActionRisks).optional(),
  decision: z.enum(confirmActionDecisions),
  decisionLabel: z.string().trim().min(1).max(120),
  comment: z.string().trim().max(4_000).optional(),
  source: z.enum(outputPluginInteractionSources),
  decidedBy: z.string().trim().max(200).optional(),
  responderName: z.string().trim().max(200).optional(),
  responderSessionId: z.string().trim().max(200).optional(),
  decidedAt: z.string().min(1)
});

export type ConfirmActionInteractionPayload = z.infer<typeof confirmActionInteractionPayloadSchema>;

export const CONFIRM_ACTION_PROTOCOL_EXAMPLE = `<${CONFIRM_ACTION_XML_TAG} id="deploy_prod_1" title="确认发布到生产环境" risk="high" confirm-label="确认执行" cancel-label="取消">
  <summary>即将部署 v0.3.28 到生产集群并执行数据库迁移。</summary>
  <detail label="目标集群">prod-cn-east</detail>
  <detail label="预计影响">API 节点滚动重启约 15 秒</detail>
  <command>pnpm deploy --env prod</command>
</${CONFIRM_ACTION_XML_TAG}>`;

export function buildConfirmActionPromptGuidance(): string {
  return `[AgentDock 操作确认卡片协议]
仅在即将执行高风险、不可逆、或需要用户明确拍板放行的关键操作（如生产部署、删库/清理数据、发版推送、批量修改）前，才在你本轮回答的**最末尾**附带一个 \`<${CONFIRM_ACTION_XML_TAG}>\` XML 块；常规安全操作、只读查询或无需确认时绝不使用，也不要在正文中复述 XML 语法。
格式（必须位于回复最后，不要放进代码块）：
<${CONFIRM_ACTION_XML_TAG} id="简短唯一ID" title="待确认操作标题" risk="low|medium|high" confirm-label="确认执行" cancel-label="取消" allow-comment="true">
  <summary>简明说明操作内容与潜在影响</summary>
  <detail label="关键维度">具体值（可写 0~6 条）</detail>
  <command>可选：即将执行的命令摘要</command>
</${CONFIRM_ACTION_XML_TAG}>
规则：id 简短且唯一；risk 默认 medium，破坏性或生产变更用 high；用户可一键确认、取消，也可附带补充意见。`;
}

export function buildConfirmActionDisabledNotice(): string {
  return `[AgentDock] 操作确认卡片协议已关闭，请不要再输出 <${CONFIRM_ACTION_XML_TAG}> XML 块，直接用自然语言确认即可。`;
}

function normalizeRisk(raw: string | undefined): ConfirmActionRisk {
  const normalized = raw?.trim().toLowerCase();
  if (normalized === 'low' || normalized === 'medium' || normalized === 'high') {
    return normalized;
  }
  return 'medium';
}

function parseConfirmActionSpec(
  rootAttrs: Record<string, string>,
  innerXml: string,
  rawXml: string
): ConfirmActionSpec | null {
  const withoutChildren = innerXml
    .replace(/<(?:detail|field)\b[^>]*>[\s\S]*?<\/(?:detail|field)>/gi, '')
    .replace(/<(?:detail|field)\b[^>]*\/>/gi, '')
    .replace(/<command\b[^>]*>[\s\S]*?<\/command>/gi, '');

  const summaryMatch = /<summary\b[^>]*>([\s\S]*?)<\/summary>/i.exec(withoutChildren);
  const summary = (summaryMatch ? decodeXmlEntities(summaryMatch[1] ?? '').trim() : '')
    || rootAttrs.summary?.trim()
    || undefined;

  const commandMatch = /<command\b[^>]*>([\s\S]*?)<\/command>/i.exec(innerXml);
  const command = (commandMatch ? decodeXmlEntities(commandMatch[1] ?? '').trim() : '')
    || rootAttrs.command?.trim()
    || undefined;

  const details: ConfirmActionDetailItem[] = [];
  const detailPattern = /<(?:detail|field)\b([^>]*?)(?:\/>|>([\s\S]*?)<\/(?:detail|field)>)/gi;
  let match: RegExpExecArray | null;
  while ((match = detailPattern.exec(innerXml)) !== null) {
    const attrs = parseXmlAttributes(match[1] ?? '');
    const body = decodeXmlEntities(match[2] ?? '').trim();
    const label = (attrs.label ?? attrs.name ?? '').trim();
    const value = body || attrs.value?.trim() || '';
    if (!label && !value) continue;
    details.push({
      label: label || '说明',
      value: value || '—'
    });
  }

  const title = rootAttrs.title?.trim() || '';
  if (!title && !summary && !command && details.length === 0) return null;

  const confirmLabel = (rootAttrs['confirm-label'] ?? rootAttrs.confirmLabel)?.trim() || '确认执行';
  const cancelLabel = (rootAttrs['cancel-label'] ?? rootAttrs.cancelLabel)?.trim() || '取消';
  const allowComment = parseBooleanAttr(rootAttrs['allow-comment'] ?? rootAttrs.allowComment, true);
  const commentPlaceholder = (rootAttrs['comment-placeholder'] ?? rootAttrs.commentPlaceholder)?.trim() || undefined;
  const id = rootAttrs.id?.trim() || `confirm_${fnv1aHex(rawXml.trim())}`;

  return {
    id,
    title: title || '确认执行操作',
    ...(summary ? { summary } : {}),
    risk: normalizeRisk(rootAttrs.risk),
    ...(command ? { command } : {}),
    details,
    confirmLabel,
    cancelLabel,
    allowComment,
    ...(commentPlaceholder ? { commentPlaceholder } : {})
  };
}

export function extractTrailingConfirmAction(
  text: string | null | undefined,
  precomputedMasked?: string
): OutputPluginParseResult<ConfirmActionSpec> | null {
  const block = extractTrailingXmlBlock(text, CONFIRM_ACTION_XML_TAG, precomputedMasked);
  if (!block) return null;
  const spec = parseConfirmActionSpec(block.rootAttrs, block.innerXml, block.rawXml);
  if (!spec) return null;
  return {
    pluginId: BUILTIN_CONFIRM_ACTION_PLUGIN_ID,
    tagName: CONFIRM_ACTION_XML_TAG,
    proseText: block.proseText,
    spec,
    rawXml: block.rawXml,
    startIndex: block.startIndex,
    endIndex: block.endIndex
  };
}

export function splitStreamingConfirmAction(
  text: string | null | undefined,
  streaming: boolean,
  precomputedMasked?: string
): OutputPluginStreamingSplit<ConfirmActionSpec> {
  if (!text) return { kind: 'none', proseText: '' };
  const extracted = extractTrailingConfirmAction(text, precomputedMasked);
  if (extracted) {
    return {
      kind: 'complete',
      pluginId: BUILTIN_CONFIRM_ACTION_PLUGIN_ID,
      tagName: CONFIRM_ACTION_XML_TAG,
      proseText: extracted.proseText,
      spec: extracted.spec,
      rawXml: extracted.rawXml
    };
  }
  if (!streaming) return { kind: 'none', proseText: text };
  const pending = detectPendingStreamingXmlTag(text, CONFIRM_ACTION_XML_TAG, precomputedMasked);
  if (pending) {
    return {
      kind: 'pending',
      pluginId: BUILTIN_CONFIRM_ACTION_PLUGIN_ID,
      tagName: CONFIRM_ACTION_XML_TAG,
      proseText: pending.proseText,
      ...(pending.partialTitle ? { partialTitle: pending.partialTitle } : {})
    };
  }
  return { kind: 'none', proseText: text };
}

export function serializeConfirmActionInteraction(payload: ConfirmActionInteractionPayload): string {
  return JSON.stringify(payload);
}

export function parseConfirmActionInteraction(raw: string | null | undefined): ConfirmActionInteractionPayload | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (!trimmed.startsWith('{')) return null;
  try {
    const parsed = confirmActionInteractionPayloadSchema.safeParse(JSON.parse(trimmed));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export function formatConfirmActionInteractionForAgent(payload: ConfirmActionInteractionPayload): string {
  const isAssistant = payload.source === 'assistant';
  const responder = payload.responderName?.trim() || payload.decidedBy?.trim();
  const sourceLabel = isAssistant ? '小猫代答' : payload.source === 'lark' ? '飞书' : '网页端';
  const actorSuffix = responder ? ` · ${responder}` : '';
  const titlePart = payload.title?.trim() ? `「${payload.title.trim()}」` : '';
  const verb = payload.decision === 'confirm' ? '确认放行' : '取消操作';

  const lines: string[] = [
    isAssistant
      ? `主会话小猫${responder ? `（${responder}）` : ''}已代用户对操作确认卡${titlePart}做出决定：${verb}（${payload.decisionLabel} / ${payload.decision}，来源：${sourceLabel}${actorSuffix}）。`
      : `用户已对操作确认卡${titlePart}做出决定：${verb}（${payload.decisionLabel} / ${payload.decision}，来源：${sourceLabel}${actorSuffix}）。`
  ];
  if (payload.comment?.trim()) {
    lines.push('');
    lines.push(`补充意见：${payload.comment.trim()}`);
  }
  lines.push('');
  lines.push(
    payload.decision === 'confirm'
      ? (isAssistant
        ? '请严格按照主会话代答确认的范围（如有补充意见请一并遵循）立即继续执行下一步。'
        : '请严格按照用户确认的范围（如有补充意见请一并遵循）立即继续执行下一步。')
      : (isAssistant
        ? '主会话已代用户取消该操作，请停止执行该动作，并结合补充意见调整方案或等待进一步指令。'
        : '用户已取消该操作，请停止执行该动作，并结合用户补充意见调整方案或等待进一步指令。')
  );
  return lines.join('\n');
}

export function summarizeConfirmActionInteraction(payload: ConfirmActionInteractionPayload): string {
  const verb = payload.source === 'assistant'
    ? (payload.decision === 'confirm' ? '小猫已代确认' : '小猫已代取消')
    : (payload.decision === 'confirm' ? '已确认' : '已取消');
  const titlePart = payload.title?.trim() ? `「${payload.title.trim()}」` : '操作确认';
  const commentPart = payload.comment?.trim() ? `：${payload.comment.trim()}` : '';
  const full = `${verb}${titlePart}${commentPart}`;
  return full.length > 80 ? `${full.slice(0, 79)}…` : full;
}

export function extractConfirmActionSearchText(spec: ConfirmActionSpec): string {
  const parts: string[] = [spec.title];
  if (spec.summary) parts.push(spec.summary);
  if (spec.command) parts.push(spec.command);
  for (const item of spec.details) {
    parts.push(item.label, item.value);
  }
  return parts.join('\n');
}

export function extractConfirmActionInteractionSearchText(payload: ConfirmActionInteractionPayload): string {
  const parts: string[] = [
    payload.decision === 'confirm' ? '已确认执行' : '已取消操作',
    payload.decisionLabel,
    payload.source === 'assistant' ? '小猫代答' : payload.source === 'lark' ? '飞书' : '网页端'
  ];
  if (payload.title) parts.push(payload.title);
  if (payload.responderName) parts.push(payload.responderName, `${payload.responderName}代答`);
  if (payload.decidedBy && payload.decidedBy !== payload.responderName) parts.push(payload.decidedBy);
  if (payload.comment) parts.push(payload.comment);
  return parts.join('\n');
}

/**
 * 内置插件 #2：`builtin:confirm-action`（操作确认卡）。
 *
 * 用于高风险操作或关键拍板前的「确认执行 / 取消 / 补充意见」双向交互：
 * - 默认开启（`defaultEnabled: true`）；
 * - Web 端渲染专属风险等级确认卡片与回显轮次；
 * - 飞书端渲染 Schema 2.0 一键确认/取消按钮与带补充意见表单，并支持双端实时锁定同步。
 */
export const confirmActionOutputPlugin: OutputPluginDefinition<
  ConfirmActionSpec,
  ConfirmActionInteractionPayload
> = {
  id: BUILTIN_CONFIRM_ACTION_PLUGIN_ID,
  name: '操作确认卡（ConfirmAction）',
  description: '在执行高风险操作、生产发布或关键不可逆步骤前，渲染「确认执行 / 取消 / 补充意见」交互卡片，Web 与飞书双端实时同步。',
  icon: 'shield-check',
  tagName: CONFIRM_ACTION_XML_TAG,
  defaultEnabled: true,
  version: '1.0.0',
  builtin: true,
  source: 'builtin',
  capabilities: {
    web: true,
    lark: true,
    interactive: true,
    streamingPlaceholder: true
  },
  protocolExample: CONFIRM_ACTION_PROTOCOL_EXAMPLE,
  interactionOrigin: CONFIRM_ACTION_INTERACTION_ORIGIN,
  promptInstruction: buildConfirmActionPromptGuidance,
  disabledNotice: buildConfirmActionDisabledNotice,
  parseOutput: extractTrailingConfirmAction,
  splitStreaming: splitStreamingConfirmAction,
  getInstanceId: spec => spec.id,
  getTitle: spec => spec.title,
  parseInteraction: parseConfirmActionInteraction,
  getInteractionInstanceId: payload => payload.actionId,
  serializeInteraction: serializeConfirmActionInteraction,
  formatInteractionForAgent: formatConfirmActionInteractionForAgent,
  summarizeInteraction: summarizeConfirmActionInteraction,
  extractSearchText: extractConfirmActionSearchText,
  extractInteractionSearchText: extractConfirmActionInteractionSearchText
};
