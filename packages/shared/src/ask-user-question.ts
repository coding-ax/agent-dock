import { z } from 'zod';
import {
  decodeXmlEntities,
  detectPendingStreamingXmlTag,
  extractTrailingXmlBlock,
  fnv1aHex,
  maskProtectedMarkdown,
  parseBooleanAttr,
  parseXmlAttributes
} from './output-plugins/xml-utils.js';

export { maskProtectedMarkdown };

export const ASK_USER_QUESTION_XML_TAG = 'agentdock-ask-user-question';
export const ASK_USER_QUESTION_ANSWER_ORIGIN = 'ask-user-question-answer';
export const ASK_USER_QUESTION_CONFIG_KEY = 'ask_user_question.config';

export const askUserQuestionConfigSchema = z.object({
  askUserQuestionXmlEnabled: z.boolean().default(true)
});

export interface AskUserQuestionConfig {
  askUserQuestionXmlEnabled: boolean;
}

export const DEFAULT_ASK_USER_QUESTION_CONFIG: AskUserQuestionConfig = {
  askUserQuestionXmlEnabled: true
};

/**
 * 统一解析当前会话的 AskUserQuestion XML 协议生效状态：
 * - `sessionOverride === true | false`：本会话显式覆写；
 * - `sessionOverride === null | undefined`：跟随全局默认开关。
 */
export function resolveAskUserQuestionEnabled(
  sessionOverride: boolean | null | undefined,
  globalDefault: boolean = DEFAULT_ASK_USER_QUESTION_CONFIG.askUserQuestionXmlEnabled
): boolean {
  if (typeof sessionOverride === 'boolean') return sessionOverride;
  return globalDefault;
}

export interface AskUserQuestionOption {
  value: string;
  label: string;
  description?: string;
  recommended?: boolean;
}

export interface AskUserQuestionItem {
  id: string;
  prompt: string;
  multi: boolean;
  allowOther: boolean;
  otherPlaceholder?: string;
  options: AskUserQuestionOption[];
}

export interface AskUserQuestionSpec {
  id: string;
  title?: string;
  description?: string;
  questions: AskUserQuestionItem[];
}

export interface ExtractedAskUserQuestion {
  proseText: string;
  spec: AskUserQuestionSpec;
  rawXml: string;
  startIndex: number;
  endIndex: number;
}

export type StreamingAskUserQuestionSplit =
  | { kind: 'none'; proseText: string }
  | { kind: 'pending'; proseText: string; partialTitle?: string }
  | { kind: 'complete'; proseText: string; spec: AskUserQuestionSpec; rawXml: string };

export const askUserQuestionSources = ['web', 'lark'] as const;
export type AskUserQuestionSource = (typeof askUserQuestionSources)[number];

export const askUserQuestionAnswerItemSchema = z.object({
  questionId: z.string().min(1).max(120),
  prompt: z.string().min(1).max(2_000),
  selectedValues: z.array(z.string().max(400)).default([]),
  selectedLabels: z.array(z.string().max(400)).default([]),
  otherText: z.string().max(4_000).optional()
});

export type AskUserQuestionAnswerItem = z.infer<typeof askUserQuestionAnswerItemSchema>;

export const askUserQuestionAnswerPayloadSchema = z.object({
  version: z.literal(1),
  questionId: z.string().min(1).max(200),
  title: z.string().max(300).optional(),
  source: z.enum(askUserQuestionSources),
  answeredBy: z.string().max(200).optional(),
  answeredAt: z.string().min(1),
  answers: z.array(askUserQuestionAnswerItemSchema).min(1)
});

export type AskUserQuestionAnswerPayload = z.infer<typeof askUserQuestionAnswerPayloadSchema>;

/** 简明 XML 协议提示词：仅在真正需要用户拍板/多选一/确认偏好时才在回答最末尾输出。 */
export function buildAskUserQuestionPromptGuidance(): string {
  return `[AgentDock 用户询问卡片协议]
仅在真正需要用户拍板、多选一、或确认关键偏好/参数才能继续时，才在你本轮回答的**最末尾**附带一个 \`<${ASK_USER_QUESTION_XML_TAG}>\` XML 块；常规问答、闲聊或无需决策时绝不使用，也不要在正文中复述 XML 语法。
格式（必须位于回复最后，不要放进代码块）：
<${ASK_USER_QUESTION_XML_TAG} id="简短唯一ID" title="可选卡片标题">
  <question id="q1" multi="false" allow-other="true">
    <prompt>具体问题</prompt>
    <option value="opt_a" recommended="true" description="可选简短说明">选项文案</option>
    <option value="opt_b" description="可选简短说明">选项文案</option>
  </question>
</${ASK_USER_QUESTION_XML_TAG}>
规则：id/value 简短且唯一；支持 1~4 个 <question>；multi="true" 允许多选；allow-other="true" 允许自定义填写；单选最多标记 1 个 recommended="true"。`;
}

/** 开关关闭后对已注入过协议的活跃会话下发的一次性短提醒。 */
export function buildAskUserQuestionDisabledNotice(): string {
  return `[AgentDock] 用户询问卡片协议已关闭，请不要再输出 <${ASK_USER_QUESTION_XML_TAG}> XML 块，直接用自然语言提问即可。`;
}

function parseQuestionBlock(attrsRaw: string, bodyRaw: string, index: number): AskUserQuestionItem | null {
  const attrs = parseXmlAttributes(attrsRaw);
  const promptMatch = /<prompt\b[^>]*>([\s\S]*?)<\/prompt>/i.exec(bodyRaw);
  const prompt = decodeXmlEntities(promptMatch?.[1] ?? '').trim();
  if (!prompt) return null;

  const multi = parseBooleanAttr(attrs.multi, false);
  const allowOther = parseBooleanAttr(attrs['allow-other'] ?? attrs.allowOther, true);
  const otherPlaceholder = (attrs['other-placeholder'] ?? attrs.otherPlaceholder)?.trim() || undefined;
  const id = attrs.id?.trim() || `q${index + 1}`;

  const options: AskUserQuestionOption[] = [];
  const seenValues = new Set<string>();
  const optionPattern = /<option\b([^>]*)>([\s\S]*?)<\/option>/gi;
  let optMatch: RegExpExecArray | null;
  let seenRecommended = false;

  while ((optMatch = optionPattern.exec(bodyRaw)) !== null) {
    const optAttrs = parseXmlAttributes(optMatch[1] ?? '');
    const label = decodeXmlEntities(optMatch[2] ?? '').trim();
    const rawValue = (optAttrs.value ?? label).trim();
    if (!label && !rawValue) continue;
    const resolvedLabel = label || rawValue;
    let value = rawValue || resolvedLabel;
    if (seenValues.has(value)) {
      let suffix = 2;
      while (seenValues.has(`${value}_${suffix}`)) suffix++;
      value = `${value}_${suffix}`;
    }
    seenValues.add(value);
    const description = optAttrs.description?.trim() || undefined;
    let recommended = parseBooleanAttr(optAttrs.recommended, false);
    if (!multi && recommended) {
      if (seenRecommended) recommended = false;
      else seenRecommended = true;
    }
    options.push({
      value,
      label: resolvedLabel,
      ...(description ? { description } : {}),
      ...(recommended ? { recommended: true } : {})
    });
  }

  if (!options.length && !allowOther) return null;

  return {
    id,
    prompt,
    multi,
    allowOther,
    ...(otherPlaceholder ? { otherPlaceholder } : {}),
    options
  };
}

function parseAskUserQuestionSpec(
  rootAttrs: Record<string, string>,
  inner: string,
  rawXml: string
): AskUserQuestionSpec | null {
  // 先剔除 <question>...</question> 再找顶层 <description>，避免误匹配问题内部标签。
  const withoutQuestions = inner.replace(/<question\b[^>]*>[\s\S]*?<\/question>/gi, '');
  const descMatch = /<description\b[^>]*>([\s\S]*?)<\/description>/i.exec(withoutQuestions);
  const description = (descMatch ? decodeXmlEntities(descMatch[1] ?? '').trim() : '')
    || rootAttrs.description?.trim()
    || undefined;
  const title = rootAttrs.title?.trim() || undefined;

  const questions: AskUserQuestionItem[] = [];
  const seenQuestionIds = new Set<string>();
  const questionPattern = /<question\b([^>]*)>([\s\S]*?)<\/question>/gi;
  let qMatch: RegExpExecArray | null;
  let idx = 0;
  while ((qMatch = questionPattern.exec(inner)) !== null) {
    const item = parseQuestionBlock(qMatch[1] ?? '', qMatch[2] ?? '', idx);
    if (item) {
      let uniqueId = item.id;
      if (seenQuestionIds.has(uniqueId)) {
        let suffix = 2;
        while (seenQuestionIds.has(`${uniqueId}_${suffix}`)) suffix++;
        uniqueId = `${uniqueId}_${suffix}`;
      }
      seenQuestionIds.add(uniqueId);
      questions.push({ ...item, id: uniqueId });
      idx++;
    }
  }

  if (!questions.length) return null;

  const id = rootAttrs.id?.trim() || `ask_${fnv1aHex(rawXml.trim())}`;
  return {
    id,
    ...(title ? { title } : {}),
    ...(description ? { description } : {}),
    questions
  };
}

/**
 * 严格提取助手最终输出**末尾**的完整 `<agentdock-ask-user-question>` XML 块。
 *
 * - 自动忽略 Markdown 围栏代码块（``` / ~~~）与行内代码（`...`）中的示例 XML；
 * - 闭合标签后仅允许空白字符，正文中段讨论不会误触发；
 * - 解析失败或缺少有效题目/选项时返回 null。
 */
export function extractTrailingAskUserQuestion(
  text: string | null | undefined,
  precomputedMasked?: string
): ExtractedAskUserQuestion | null {
  const block = extractTrailingXmlBlock(text, ASK_USER_QUESTION_XML_TAG, precomputedMasked);
  if (!block) return null;
  const spec = parseAskUserQuestionSpec(block.rootAttrs, block.innerXml, block.rawXml);
  if (!spec) return null;
  return {
    proseText: block.proseText,
    spec,
    rawXml: block.rawXml,
    startIndex: block.startIndex,
    endIndex: block.endIndex
  };
}

/**
 * 流式/终态通用拆分器：
 * - 末尾已有完整有效 XML 块 → `kind: 'complete'`
 * - 流式输出中末尾出现未闭合 `<agentdock-ask-user-question` 或其前缀（如 `<agentd...`）→ `kind: 'pending'`
 * - 其他情况（含代码块内示例 XML）→ `kind: 'none'`
 */
export function splitStreamingAskUserQuestion(
  text: string | null | undefined,
  streaming: boolean,
  precomputedMasked?: string
): StreamingAskUserQuestionSplit {
  if (!text) return { kind: 'none', proseText: '' };

  const extracted = extractTrailingAskUserQuestion(text, precomputedMasked);
  if (extracted) {
    return {
      kind: 'complete',
      proseText: extracted.proseText,
      spec: extracted.spec,
      rawXml: extracted.rawXml
    };
  }

  if (!streaming) return { kind: 'none', proseText: text };

  const pending = detectPendingStreamingXmlTag(text, ASK_USER_QUESTION_XML_TAG, precomputedMasked);
  if (pending) {
    return {
      kind: 'pending',
      proseText: pending.proseText,
      ...(pending.partialTitle ? { partialTitle: pending.partialTitle } : {})
    };
  }

  return { kind: 'none', proseText: text };
}

export function serializeAskUserQuestionAnswer(payload: AskUserQuestionAnswerPayload): string {
  return JSON.stringify(payload);
}

export function parseAskUserQuestionAnswer(raw: string | null | undefined): AskUserQuestionAnswerPayload | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (!trimmed.startsWith('{')) return null;
  try {
    const parsed = JSON.parse(trimmed);
    const result = askUserQuestionAnswerPayloadSchema.safeParse(parsed);
    return result.success ? result.data : null;
  } catch {
    return null;
  }
}

export function formatAskUserQuestionAnswerForAgent(payload: AskUserQuestionAnswerPayload): string {
  const sourceLabel = payload.source === 'lark' ? '飞书' : '网页端';
  const actorSuffix = payload.answeredBy?.trim() ? ` · ${payload.answeredBy.trim()}` : '';
  const titlePart = payload.title?.trim() ? `「${payload.title.trim()}」` : '';
  const lines: string[] = [
    `用户已回答你刚才的询问${titlePart}（来源：${sourceLabel}${actorSuffix}）：`
  ];

  payload.answers.forEach((item, index) => {
    const selectedDisplay = item.selectedLabels.map((label, idx) => {
      const value = item.selectedValues[idx];
      return value && value !== label ? `${label} (${value})` : label;
    });
    const parts: string[] = [];
    if (selectedDisplay.length) parts.push(selectedDisplay.join('、'));
    if (item.otherText?.trim()) {
      parts.push(selectedDisplay.length ? `自定义补充：${item.otherText.trim()}` : item.otherText.trim());
    }
    const answerText = parts.length ? parts.join('；') : '（未作答）';
    lines.push('');
    lines.push(`${index + 1}. 问题：${item.prompt}`);
    lines.push(`   回答：${answerText}`);
  });

  lines.push('');
  lines.push('请基于以上用户的明确选择继续执行下一步。');
  return lines.join('\n');
}

export function summarizeAskUserQuestionAnswer(payload: AskUserQuestionAnswerPayload): string {
  const snippets = payload.answers.map(item => {
    const parts = [
      ...item.selectedLabels,
      ...(item.otherText?.trim() ? [item.otherText.trim()] : [])
    ].filter(Boolean);
    return parts.join('、');
  }).filter(Boolean);
  const joined = snippets.join(' / ');
  const prefix = payload.title?.trim() ? `已回复「${payload.title.trim()}」` : '已回复询问';
  if (!joined) return prefix;
  const full = `${prefix}：${joined}`;
  return full.length > 80 ? `${full.slice(0, 79)}…` : full;
}

/** 供时间线搜索（Cmd+F）提取可见问答文本，避免命中底层 JSON 字段名或裸 XML 标签。 */
export function extractAskUserQuestionSearchText(spec: AskUserQuestionSpec): string {
  const parts: string[] = [];
  if (spec.title) parts.push(spec.title);
  if (spec.description) parts.push(spec.description);
  for (const question of spec.questions) {
    parts.push(question.prompt);
    for (const option of question.options) {
      parts.push(option.label);
      if (option.description) parts.push(option.description);
    }
  }
  return parts.join('\n');
}

export function extractAskUserQuestionAnswerSearchText(payload: AskUserQuestionAnswerPayload): string {
  const parts: string[] = ['已回复询问', payload.source === 'lark' ? '飞书' : '网页端'];
  if (payload.title) parts.push(payload.title);
  if (payload.answeredBy) parts.push(payload.answeredBy);
  for (const item of payload.answers) {
    parts.push(item.prompt);
    for (const label of item.selectedLabels) parts.push(label);
    if (item.otherText) parts.push(item.otherText);
  }
  return parts.join('\n');
}
