import { randomUUID } from 'node:crypto';
import vm from 'node:vm';
import safeRegex from 'safe-regex2';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { ConfigRepository } from '@agent-dock/agent-dock-shared';
import { readLarkConfig, readLarkConfigs, type StoredLarkConfig } from './config.js';
import { parseLarkMessageContent } from './message-content.js';
import { LarkServiceError, type LarkCardService, type LarkChat, type LarkChatMessage, type LarkChatsResult } from './service.js';

export const larkRegexTriggersConfigKey = 'lark.regex_triggers.rules';
export const larkRegexTriggerHitsConfigKey = 'lark.regex_triggers.hits';

export const LARK_REGEX_MAX_PATTERN_LENGTH = 1_024;
export const LARK_REGEX_MAX_TEXT_LENGTH = 8_000;
export const LARK_REGEX_MAX_MATCHES_PER_MESSAGE = 50;
export const LARK_REGEX_MAX_HITS_LEDGER = 2_000;
export const LARK_REGEX_MAX_BACKFILL_BATCH = 20;
export const LARK_REGEX_DEFAULT_FLAGS = 'i';
const allowedRegexFlags = new Set(['i', 'm', 's', 'u']);
const flagOrder = ['i', 'm', 's', 'u'] as const;

export type LarkRegexReplyMode = 'thread' | 'main';
export type LarkRegexTriggerHitType = 'realtime' | 'backfill';

export interface LarkRegexTriggerRule {
  id: string;
  name: string;
  enabled: boolean;
  botId: string;
  chatId: string;
  chatName: string;
  pattern: string;
  flags: string;
  replyMode: LarkRegexReplyMode;
  promptTemplate: string;
  presetId?: string;
  ignoreBotMessages: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface LarkRegexTriggerRuleWithStats extends LarkRegexTriggerRule {
  hitCount: number;
  lastTriggeredAt?: string;
}

export interface LarkRegexTriggerHit {
  id: string;
  ruleId: string;
  botId: string;
  chatId: string;
  messageId: string;
  sessionId?: string;
  cardMessageId?: string;
  matchedText: string;
  senderName?: string;
  messagePreview?: string;
  triggerType: LarkRegexTriggerHitType;
  status: 'triggered' | 'failed';
  error?: string;
  triggeredAt: string;
}

export interface LarkRegexMatchSpan {
  start: number;
  end: number;
  text: string;
}

export interface LarkPreviewChatMessage {
  messageId: string;
  chatId: string;
  threadId?: string;
  rootId?: string;
  parentId?: string;
  senderId?: string;
  senderName: string;
  senderType: string;
  text: string;
  msgType: string;
  createTime: string;
  createdAt: string;
  deleted?: boolean;
  mentions?: Array<{ key?: string; name?: string; id?: string }>;
}

export interface LarkRegexPromptTemplate {
  id: string;
  name: string;
  badge: string;
  description: string;
  suggestedPattern: string;
  suggestedFlags: string;
  suggestedReplyMode: LarkRegexReplyMode;
  promptTemplate: string;
}

export interface LarkRegexTemplateVariable {
  key: string;
  token: string;
  label: string;
  description: string;
}

export const LARK_REGEX_TEMPLATE_VARIABLES: readonly LarkRegexTemplateVariable[] = [
  { key: 'chatName', token: '{{chatName}}', label: '群聊名称', description: '触发消息所在飞书群的名称' },
  { key: 'chatId', token: '{{chatId}}', label: '群聊 ID', description: '飞书群聊 oc_ 开头的唯一标识' },
  { key: 'botName', token: '{{botName}}', label: '机器人名称', description: '当前负责响应的飞书机器人名称' },
  { key: 'ruleName', token: '{{ruleName}}', label: '规则名称', description: '命中的正则监听规则名称' },
  { key: 'pattern', token: '{{pattern}}', label: '正则表达式', description: '命中该消息的正则表达式文本' },
  { key: 'senderName', token: '{{senderName}}', label: '发送人', description: '发送该条群聊消息的成员姓名' },
  { key: 'messageTime', token: '{{messageTime}}', label: '消息时间', description: '该条消息在群内发出的时间' },
  { key: 'messageText', token: '{{messageText}}', label: '原始消息', description: '解析后的群聊消息完整正文' },
  { key: 'matchedText', token: '{{matchedText}}', label: '命中片段', description: '正则表达式实际命中的子串内容' }
] as const;

export const LARK_REGEX_PROMPT_TEMPLATES: readonly LarkRegexPromptTemplate[] = [
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
  },
  {
    id: 'concise-direct',
    name: '简洁直达',
    badge: '通用轻模板',
    description: '保持极简指令，完全由自动附带的群聊与消息基础上下文驱动',
    suggestedPattern: '(?:紧急|请处理|跟进一下)',
    suggestedFlags: 'i',
    suggestedReplyMode: 'thread',
    promptTemplate: '请查看群聊「{{chatName}}」中 {{senderName}} 发出的命中消息，结合基础上下文直接给出简洁、准确的处理结论。'
  }
] as const;

export type RegexValidationResult =
  | { valid: true; normalizedFlags: string }
  | { valid: false; error: string; normalizedFlags: string };

/** 检查复杂/易引发 ReDoS 的正则结构：嵌套分组深度、量化反向引用、嵌套量化先行断言。 */
function detectRiskyRegexStructure(pattern: string): string | undefined {
  let depth = 0;
  let maxDepth = 0;
  let inClass = false;
  let escaped = false;
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i]!;
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === '\\') {
      escaped = true;
      continue;
    }
    if (ch === '[' && !inClass) {
      inClass = true;
      continue;
    }
    if (ch === ']' && inClass) {
      inClass = false;
      continue;
    }
    if (inClass) continue;
    if (ch === '(') {
      depth++;
      if (depth > maxDepth) maxDepth = depth;
    } else if (ch === ')') {
      depth = Math.max(0, depth - 1);
    }
  }
  if (maxDepth > 12) {
    return '正则表达式分组嵌套过深（最多 12 层），请简化表达式';
  }
  if (/\\[1-9]\s*(?:[*+?]|{\d+,)/.test(pattern)) {
    return '正则表达式包含带量词的反向引用，可能造成灾难性回溯，请改写';
  }
  if (/\(\?[=!<][^)]*(?:[*+]|{\d+,})[^)]*\)\s*(?:[*+?]|{\d+,})/.test(pattern)) {
    return '正则表达式包含复杂量化的断言结构，可能引发回溯风险，请简化';
  }
  return undefined;
}

export function validateLarkTriggerRegex(pattern: string, rawFlags = LARK_REGEX_DEFAULT_FLAGS): RegexValidationResult {
  const source = typeof pattern === 'string' ? pattern : '';
  const flagsInput = typeof rawFlags === 'string' ? rawFlags.trim() : LARK_REGEX_DEFAULT_FLAGS;
  const seen = new Set<string>();
  const invalidChars: string[] = [];
  for (const ch of flagsInput) {
    if (ch === 'g') continue; // 匹配扫描会自动附加 g，规则中不持久化 g
    if (allowedRegexFlags.has(ch)) seen.add(ch);
    else invalidChars.push(ch);
  }
  const normalizedFlags = flagOrder.filter(flag => seen.has(flag)).join('');
  if (invalidChars.length > 0) {
    return {
      valid: false,
      normalizedFlags,
      error: `不支持的正则标志位：${[...new Set(invalidChars)].join('、')}（仅支持 i、m、s、u）`
    };
  }
  if (!source.trim()) {
    return { valid: false, normalizedFlags, error: '请输入正则表达式' };
  }
  if (source.length > LARK_REGEX_MAX_PATTERN_LENGTH) {
    return { valid: false, normalizedFlags, error: `正则表达式过长（最多 ${LARK_REGEX_MAX_PATTERN_LENGTH} 个字符）` };
  }
  try {
    // 先验证语法合法性
    new RegExp(source, normalizedFlags);
  } catch (error) {
    return {
      valid: false,
      normalizedFlags,
      error: `正则表达式语法错误：${error instanceof Error ? error.message : String(error)}`
    };
  }
  const structureIssue = detectRiskyRegexStructure(source);
  if (structureIssue) {
    return { valid: false, normalizedFlags, error: structureIssue };
  }
  if (!safeRegex(source)) {
    return {
      valid: false,
      normalizedFlags,
      error: '正则表达式可能造成灾难性回溯（ReDoS），请避免嵌套量词或重叠分支'
    };
  }
  return { valid: true, normalizedFlags };
}

export interface LarkRegexPreviewMessageInput {
  messageId: string;
  text: string;
  senderType?: string;
}

export interface LarkRegexPreviewItemResult {
  messageId: string;
  matched: boolean;
  skippedBot?: boolean;
  matches: LarkRegexMatchSpan[];
  timedOut?: boolean;
}

export interface LarkRegexPreviewResult {
  valid: boolean;
  error?: string;
  normalizedFlags: string;
  totalCount: number;
  matchedCount: number;
  results: LarkRegexPreviewItemResult[];
  messages?: LarkPreviewChatMessage[];
}

const VM_BATCH_MATCH_SCRIPT = new vm.Script(`
(() => {
  const re = new RegExp(__pattern, __flags);
  const out = [];
  for (let i = 0; i < __texts.length; i++) {
    const raw = __texts[i];
    if (raw === null) {
      out.push({ matched: false, matches: [] });
      continue;
    }
    const text = raw.length > __maxTextLen ? raw.slice(0, __maxTextLen) : raw;
    re.lastIndex = 0;
    const spans = [];
    let matched = false;
    let guard = 0;
    while (guard < __maxMatches) {
      const m = re.exec(text);
      if (!m) break;
      matched = true;
      const value = m[0];
      const start = m.index;
      const end = start + value.length;
      if (value.length > 0) {
        spans.push({ start, end, text: value });
      }
      if (value.length === 0) {
        if (re.lastIndex >= text.length) break;
        re.lastIndex += 1;
      }
      guard += 1;
    }
    out.push({ matched, matches: spans });
  }
  return out;
})();
`);

export function matchLarkTriggerMessages(
  pattern: string,
  flags: string,
  messages: readonly LarkRegexPreviewMessageInput[],
  options: { ignoreBotMessages?: boolean; timeoutMs?: number; maxMatchesPerMessage?: number } = {}
): LarkRegexPreviewResult {
  const validation = validateLarkTriggerRegex(pattern, flags);
  if (!validation.valid) {
    return {
      valid: false,
      error: validation.error,
      normalizedFlags: validation.normalizedFlags,
      totalCount: messages.length,
      matchedCount: 0,
      results: []
    };
  }
  const ignoreBots = options.ignoreBotMessages === true;
  const maxMatches = Math.min(LARK_REGEX_MAX_MATCHES_PER_MESSAGE, Math.max(1, options.maxMatchesPerMessage ?? LARK_REGEX_MAX_MATCHES_PER_MESSAGE));
  const timeoutMs = Math.min(500, Math.max(20, options.timeoutMs ?? 150));
  const scanFlags = validation.normalizedFlags.includes('g') ? validation.normalizedFlags : `${validation.normalizedFlags}g`;
  const skippedFlags = messages.map(item => ignoreBots && (item.senderType === 'app' || item.senderType === 'bot'));
  const texts = messages.map((item, index) => (skippedFlags[index] ? null : String(item.text ?? '')));

  try {
    const context = vm.createContext({
      __pattern: pattern,
      __flags: scanFlags,
      __texts: texts,
      __maxTextLen: LARK_REGEX_MAX_TEXT_LENGTH,
      __maxMatches: maxMatches
    });
    const rawResults = VM_BATCH_MATCH_SCRIPT.runInContext(context, { timeout: timeoutMs }) as Array<{
      matched: boolean;
      matches: LarkRegexMatchSpan[];
    }>;
    let matchedCount = 0;
    const results: LarkRegexPreviewItemResult[] = messages.map((item, index) => {
      if (skippedFlags[index]) {
        return { messageId: item.messageId, matched: false, skippedBot: true, matches: [] };
      }
      const entry = rawResults[index] ?? { matched: false, matches: [] };
      if (entry.matched) matchedCount += 1;
      return {
        messageId: item.messageId,
        matched: entry.matched,
        matches: entry.matches
      };
    });
    return {
      valid: true,
      normalizedFlags: validation.normalizedFlags,
      totalCount: messages.length,
      matchedCount,
      results
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const isTimeout = /timed out/i.test(message);
    return {
      valid: false,
      error: isTimeout
        ? '正则匹配超时，可能存在回溯性能风险，请简化正则表达式'
        : `正则执行失败：${message}`,
      normalizedFlags: validation.normalizedFlags,
      totalCount: messages.length,
      matchedCount: 0,
      results: []
    };
  }
}

export function matchLarkTriggerText(
  pattern: string,
  flags: string,
  text: string,
  options: { timeoutMs?: number } = {}
): { valid: boolean; matched: boolean; matches: LarkRegexMatchSpan[]; matchedText: string; error?: string } {
  const preview = matchLarkTriggerMessages(
    pattern,
    flags,
    [{ messageId: '_single', text }],
    { timeoutMs: options.timeoutMs ?? 50 }
  );
  if (!preview.valid) {
    return { valid: false, matched: false, matches: [], matchedText: '', error: preview.error };
  }
  const first = preview.results[0];
  const matches = first?.matches ?? [];
  const matchedText = matches.map(span => span.text).filter(Boolean).slice(0, 5).join(' | ');
  return {
    valid: true,
    matched: Boolean(first?.matched),
    matches,
    matchedText
  };
}

export interface BuildRegexTriggerPromptInput {
  promptTemplate?: string;
  chatName?: string;
  chatId: string;
  botName?: string;
  botId: string;
  ruleName?: string;
  pattern: string;
  flags?: string;
  replyMode: LarkRegexReplyMode;
  senderName?: string;
  senderId?: string;
  messageId: string;
  messageTime?: string;
  messageText: string;
  matchedText?: string;
  triggerType: LarkRegexTriggerHitType;
}

export function formatLarkMessageTime(rawTime?: string): string {
  const trimmed = String(rawTime ?? '').trim();
  if (!trimmed) return new Date().toLocaleString('zh-CN', { hour12: false });
  if (/^\d{10,13}$/.test(trimmed)) {
    const ms = trimmed.length === 10 ? Number(trimmed) * 1000 : Number(trimmed);
    const date = new Date(ms);
    if (!Number.isNaN(date.getTime())) {
      return date.toLocaleString('zh-CN', { hour12: false });
    }
  }
  const parsed = new Date(trimmed);
  if (!Number.isNaN(parsed.getTime())) {
    return parsed.toLocaleString('zh-CN', { hour12: false });
  }
  return trimmed;
}

export function larkCreateTimeToIso(rawTime?: string): string {
  const trimmed = String(rawTime ?? '').trim();
  if (/^\d{10,13}$/.test(trimmed)) {
    const ms = trimmed.length === 10 ? Number(trimmed) * 1000 : Number(trimmed);
    const date = new Date(ms);
    if (!Number.isNaN(date.getTime())) return date.toISOString();
  }
  if (trimmed) {
    const parsed = new Date(trimmed);
    if (!Number.isNaN(parsed.getTime())) return parsed.toISOString();
  }
  return new Date(0).toISOString();
}

/**
 * 组装发给 Agent 的实际 Prompt：
 * 1. 对用户模板做 {{var}} 安全替换（函数替换避免 $&/$1 误解析）；
 * 2. 无论模板是否为空，始终结构化自动附带基础群聊与消息上下文块，确保 Agent 信息完备。
 */
export function buildRegexTriggerPrompt(input: BuildRegexTriggerPromptInput): string {
  const chatName = input.chatName?.trim() || input.chatId;
  const botName = input.botName?.trim() || input.botId;
  const ruleName = input.ruleName?.trim() || '临时正则补偿';
  const senderName = input.senderName?.trim() || input.senderId?.trim() || '群成员';
  const messageTime = formatLarkMessageTime(input.messageTime);
  const messageText = input.messageText.trim() || '（空消息）';
  const matchedText = input.matchedText?.trim() || '（正则命中）';
  const flags = input.flags ?? LARK_REGEX_DEFAULT_FLAGS;

  const vars: Record<string, string> = {
    chatName,
    chatId: input.chatId,
    botName,
    ruleName,
    pattern: input.pattern,
    senderName,
    messageTime,
    messageText,
    matchedText
  };

  const template = (input.promptTemplate ?? '').trim();
  const renderedTemplate = template
    ? template.replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (full, key: string) => (
      Object.prototype.hasOwnProperty.call(vars, key) ? vars[key]! : full
    ))
    : '';

  const triggerLabel = input.triggerType === 'backfill' ? '历史消息补偿触发' : '实时群聊监听自动触发';
  const replyModeLabel = input.replyMode === 'thread'
    ? '话题内唤起（reply_in_thread 回复原消息）'
    : '主线程唤起（在群聊主线程回复并定位原消息）';
  const senderDetail = input.senderId && input.senderId !== senderName
    ? `${senderName}（${input.senderId}）`
    : senderName;

  const baseContextBlock = [
    '[群聊正则自动唤起 · 基础上下文]',
    `- 触发方式：${triggerLabel}`,
    `- 所在群聊：${chatName}（chat_id: ${input.chatId}）`,
    `- 所属机器人：${botName}（app_id: ${input.botId}）`,
    `- 命中规则：${ruleName}（/${input.pattern}/${flags}）`,
    `- 唤起模式：${replyModeLabel}`,
    `- 消息发送人：${senderDetail}`,
    `- 消息时间：${messageTime}`,
    `- 消息 ID：${input.messageId}`,
    `- 正则命中片段：${matchedText}`,
    '- 原始群聊消息：',
    messageText
  ].join('\n');

  return renderedTemplate ? `${renderedTemplate}\n\n${baseContextBlock}` : baseContextBlock;
}

function normalizeRule(raw: unknown): LarkRegexTriggerRule | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const item = raw as Partial<LarkRegexTriggerRule>;
  const id = String(item.id ?? '').trim();
  const botId = String(item.botId ?? '').trim();
  const chatId = String(item.chatId ?? '').trim();
  const pattern = String(item.pattern ?? '');
  if (!id || !botId || !chatId.startsWith('oc_') || !pattern.trim()) return undefined;
  const replyMode: LarkRegexReplyMode = item.replyMode === 'main' ? 'main' : 'thread';
  const flags = typeof item.flags === 'string' ? item.flags : LARK_REGEX_DEFAULT_FLAGS;
  const now = new Date().toISOString();
  return {
    id,
    name: String(item.name ?? '').trim() || '未命名正则规则',
    enabled: item.enabled !== false,
    botId,
    chatId,
    chatName: String(item.chatName ?? '').trim() || chatId,
    pattern,
    flags,
    replyMode,
    promptTemplate: String(item.promptTemplate ?? ''),
    ...(item.presetId ? { presetId: String(item.presetId).trim() } : {}),
    ignoreBotMessages: item.ignoreBotMessages !== false,
    createdAt: String(item.createdAt ?? now),
    updatedAt: String(item.updatedAt ?? now)
  };
}

function normalizeHit(raw: unknown): LarkRegexTriggerHit | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const item = raw as Partial<LarkRegexTriggerHit>;
  const ruleId = String(item.ruleId ?? '').trim();
  const botId = String(item.botId ?? '').trim();
  const chatId = String(item.chatId ?? '').trim();
  const messageId = String(item.messageId ?? '').trim();
  if (!ruleId || !botId || !chatId || !messageId) return undefined;
  return {
    id: String(item.id ?? `${ruleId}:${messageId}`),
    ruleId,
    botId,
    chatId,
    messageId,
    ...(item.sessionId ? { sessionId: String(item.sessionId) } : {}),
    ...(item.cardMessageId ? { cardMessageId: String(item.cardMessageId) } : {}),
    matchedText: String(item.matchedText ?? ''),
    ...(item.senderName ? { senderName: String(item.senderName) } : {}),
    ...(item.messagePreview ? { messagePreview: String(item.messagePreview) } : {}),
    triggerType: item.triggerType === 'backfill' ? 'backfill' : 'realtime',
    status: item.status === 'failed' ? 'failed' : 'triggered',
    ...(item.error ? { error: String(item.error) } : {}),
    triggeredAt: String(item.triggeredAt ?? new Date().toISOString())
  };
}

async function readRulesState(repository?: ConfigRepository): Promise<{ raw: string | undefined; rules: LarkRegexTriggerRule[] }> {
  const raw = await repository?.get(larkRegexTriggersConfigKey);
  if (!raw) return { raw, rules: [] };
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return { raw, rules: [] };
    return {
      raw,
      rules: parsed.map(normalizeRule).filter((item): item is LarkRegexTriggerRule => Boolean(item))
    };
  } catch {
    return { raw, rules: [] };
  }
}

async function writeRulesState(repository: ConfigRepository, raw: string | undefined, rules: LarkRegexTriggerRule[]): Promise<boolean> {
  const serialized = JSON.stringify(rules);
  if (repository.compareAndSet) return repository.compareAndSet(larkRegexTriggersConfigKey, raw, serialized);
  await repository.set(larkRegexTriggersConfigKey, serialized);
  return true;
}

async function readHitsState(repository?: ConfigRepository): Promise<{ raw: string | undefined; hits: LarkRegexTriggerHit[] }> {
  const raw = await repository?.get(larkRegexTriggerHitsConfigKey);
  if (!raw) return { raw, hits: [] };
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return { raw, hits: [] };
    return {
      raw,
      hits: parsed.map(normalizeHit).filter((item): item is LarkRegexTriggerHit => Boolean(item))
    };
  } catch {
    return { raw, hits: [] };
  }
}

async function writeHitsState(repository: ConfigRepository, raw: string | undefined, hits: LarkRegexTriggerHit[]): Promise<boolean> {
  const bounded = hits.length > LARK_REGEX_MAX_HITS_LEDGER ? hits.slice(-LARK_REGEX_MAX_HITS_LEDGER) : hits;
  const serialized = JSON.stringify(bounded);
  if (repository.compareAndSet) return repository.compareAndSet(larkRegexTriggerHitsConfigKey, raw, serialized);
  await repository.set(larkRegexTriggerHitsConfigKey, serialized);
  return true;
}

export async function readLarkRegexTriggerRules(repository?: ConfigRepository): Promise<LarkRegexTriggerRule[]> {
  return (await readRulesState(repository)).rules;
}

export async function readLarkRegexTriggerHits(repository?: ConfigRepository): Promise<LarkRegexTriggerHit[]> {
  return (await readHitsState(repository)).hits;
}

export async function listLarkRegexTriggerRulesWithStats(repository?: ConfigRepository): Promise<LarkRegexTriggerRuleWithStats[]> {
  const [rules, hits] = await Promise.all([readLarkRegexTriggerRules(repository), readLarkRegexTriggerHits(repository)]);
  const stats = new Map<string, { count: number; lastTriggeredAt?: string }>();
  for (const hit of hits) {
    if (hit.status !== 'triggered') continue;
    const current = stats.get(hit.ruleId) ?? { count: 0 };
    current.count += 1;
    if (!current.lastTriggeredAt || hit.triggeredAt > current.lastTriggeredAt) {
      current.lastTriggeredAt = hit.triggeredAt;
    }
    stats.set(hit.ruleId, current);
  }
  return rules.map(rule => {
    const stat = stats.get(rule.id);
    return {
      ...rule,
      hitCount: stat?.count ?? 0,
      ...(stat?.lastTriggeredAt ? { lastTriggeredAt: stat.lastTriggeredAt } : {})
    };
  });
}

export interface SaveLarkRegexTriggerInput {
  name?: string;
  enabled?: boolean;
  botId?: string;
  chatId?: string;
  chatName?: string;
  pattern?: string;
  flags?: string;
  replyMode?: LarkRegexReplyMode;
  promptTemplate?: string;
  presetId?: string | null;
  ignoreBotMessages?: boolean;
}

export async function createLarkRegexTriggerRule(
  repository: ConfigRepository | undefined,
  bots: readonly StoredLarkConfig[],
  input: SaveLarkRegexTriggerInput
): Promise<LarkRegexTriggerRule> {
  if (!repository) throw new LarkServiceError('LARK_CONFIG_STORAGE_UNAVAILABLE', '持久化存储不可用，无法保存正则规则', 503);
  const botId = String(input.botId ?? '').trim();
  if (!botId) throw new LarkServiceError('INVALID_REGEX_RULE', '请选择飞书机器人', 400);
  if (!bots.some(bot => bot.appId === botId)) {
    throw new LarkServiceError('LARK_BOT_NOT_FOUND', `未找到飞书机器人：${botId}`, 404);
  }
  const chatId = String(input.chatId ?? '').trim();
  if (!chatId.startsWith('oc_')) {
    throw new LarkServiceError('INVALID_CHAT_ID', '请选择有效的飞书群聊（chatId 须以 oc_ 开头）', 400);
  }
  const replyMode: LarkRegexReplyMode = input.replyMode === 'main' ? 'main' : input.replyMode === 'thread' || input.replyMode === undefined ? 'thread' : (() => {
    throw new LarkServiceError('INVALID_REPLY_MODE', '唤起模式仅支持 thread（话题）或 main（主线程）', 400);
  })();
  const pattern = String(input.pattern ?? '');
  const validation = validateLarkTriggerRegex(pattern, input.flags ?? LARK_REGEX_DEFAULT_FLAGS);
  if (!validation.valid) {
    throw new LarkServiceError('INVALID_REGEX_PATTERN', validation.error, 400);
  }
  const chatName = String(input.chatName ?? '').trim() || chatId;
  const name = String(input.name ?? '').trim() || `${chatName} 正则唤起`;
  const now = new Date().toISOString();
  const rule: LarkRegexTriggerRule = {
    id: `lrt_${randomUUID().slice(0, 12)}`,
    name,
    enabled: input.enabled !== false,
    botId,
    chatId,
    chatName,
    pattern,
    flags: validation.normalizedFlags,
    replyMode,
    promptTemplate: String(input.promptTemplate ?? ''),
    ...(input.presetId ? { presetId: String(input.presetId).trim() } : {}),
    ignoreBotMessages: input.ignoreBotMessages !== false,
    createdAt: now,
    updatedAt: now
  };
  for (let attempt = 0; attempt < 5; attempt++) {
    const { raw, rules } = await readRulesState(repository);
    if (await writeRulesState(repository, raw, [...rules, rule])) return rule;
  }
  throw new LarkServiceError('LARK_CONFIG_CONFLICT', '规则正在被并发更新，请重试', 409);
}

export async function updateLarkRegexTriggerRule(
  repository: ConfigRepository | undefined,
  bots: readonly StoredLarkConfig[],
  id: string,
  patch: SaveLarkRegexTriggerInput
): Promise<LarkRegexTriggerRule> {
  if (!repository) throw new LarkServiceError('LARK_CONFIG_STORAGE_UNAVAILABLE', '持久化存储不可用，无法更新正则规则', 503);
  const targetId = id.trim();
  for (let attempt = 0; attempt < 5; attempt++) {
    const { raw, rules } = await readRulesState(repository);
    const index = rules.findIndex(item => item.id === targetId);
    if (index < 0) throw new LarkServiceError('REGEX_RULE_NOT_FOUND', `未找到正则监听规则：${targetId}`, 404);
    const current = rules[index]!;
    const botId = patch.botId === undefined ? current.botId : String(patch.botId).trim();
    if (!botId || !bots.some(bot => bot.appId === botId)) {
      throw new LarkServiceError('LARK_BOT_NOT_FOUND', `未找到飞书机器人：${botId || '(空)'}`, 404);
    }
    const chatId = patch.chatId === undefined ? current.chatId : String(patch.chatId).trim();
    if (!chatId.startsWith('oc_')) {
      throw new LarkServiceError('INVALID_CHAT_ID', '请选择有效的飞书群聊（chatId 须以 oc_ 开头）', 400);
    }
    let replyMode: LarkRegexReplyMode = current.replyMode;
    if (patch.replyMode !== undefined) {
      if (patch.replyMode !== 'thread' && patch.replyMode !== 'main') {
        throw new LarkServiceError('INVALID_REPLY_MODE', '唤起模式仅支持 thread（话题）或 main（主线程）', 400);
      }
      replyMode = patch.replyMode;
    }
    const pattern = patch.pattern === undefined ? current.pattern : String(patch.pattern);
    const rawFlags = patch.flags === undefined ? current.flags : String(patch.flags);
    const validation = validateLarkTriggerRegex(pattern, rawFlags);
    if (!validation.valid) {
      throw new LarkServiceError('INVALID_REGEX_PATTERN', validation.error, 400);
    }
    const presetId = patch.presetId === undefined
      ? current.presetId
      : patch.presetId
        ? String(patch.presetId).trim()
        : undefined;
    const updated: LarkRegexTriggerRule = {
      ...current,
      name: patch.name === undefined ? current.name : (String(patch.name).trim() || current.name),
      enabled: patch.enabled === undefined ? current.enabled : Boolean(patch.enabled),
      botId,
      chatId,
      chatName: patch.chatName === undefined ? current.chatName : (String(patch.chatName).trim() || chatId),
      pattern,
      flags: validation.normalizedFlags,
      replyMode,
      promptTemplate: patch.promptTemplate === undefined ? current.promptTemplate : String(patch.promptTemplate),
      ...(presetId ? { presetId } : {}),
      ignoreBotMessages: patch.ignoreBotMessages === undefined ? current.ignoreBotMessages : Boolean(patch.ignoreBotMessages),
      updatedAt: new Date().toISOString()
    };
    if (!presetId) delete updated.presetId;
    const next = [...rules];
    next[index] = updated;
    if (await writeRulesState(repository, raw, next)) return updated;
  }
  throw new LarkServiceError('LARK_CONFIG_CONFLICT', '规则正在被并发更新，请重试', 409);
}

export async function deleteLarkRegexTriggerRule(repository: ConfigRepository | undefined, id: string): Promise<{ deleted: true; id: string }> {
  if (!repository) throw new LarkServiceError('LARK_CONFIG_STORAGE_UNAVAILABLE', '持久化存储不可用，无法删除正则规则', 503);
  const targetId = id.trim();
  for (let attempt = 0; attempt < 5; attempt++) {
    const { raw, rules } = await readRulesState(repository);
    const next = rules.filter(item => item.id !== targetId);
    if (next.length === rules.length) throw new LarkServiceError('REGEX_RULE_NOT_FOUND', `未找到正则监听规则：${targetId}`, 404);
    if (await writeRulesState(repository, raw, next)) return { deleted: true, id: targetId };
  }
  throw new LarkServiceError('LARK_CONFIG_CONFLICT', '规则正在被并发更新，请重试', 409);
}

export async function findLarkRegexTriggerHit(
  repository: ConfigRepository | undefined,
  query: { ruleId?: string; botId?: string; chatId?: string; messageId: string }
): Promise<LarkRegexTriggerHit | undefined> {
  const hits = await readLarkRegexTriggerHits(repository);
  for (let i = hits.length - 1; i >= 0; i--) {
    const item = hits[i]!;
    if (item.status !== 'triggered') continue;
    if (item.messageId !== query.messageId) continue;
    if (query.ruleId && item.ruleId === query.ruleId) return item;
    if (!query.ruleId && query.botId && query.chatId && item.botId === query.botId && item.chatId === query.chatId) return item;
  }
  return undefined;
}

export async function recordLarkRegexTriggerHit(
  repository: ConfigRepository | undefined,
  input: Omit<LarkRegexTriggerHit, 'id' | 'triggeredAt'> & { triggeredAt?: string }
): Promise<LarkRegexTriggerHit> {
  const hit: LarkRegexTriggerHit = {
    ...input,
    id: `${input.ruleId}:${input.messageId}`,
    triggeredAt: input.triggeredAt ?? new Date().toISOString()
  };
  if (!repository) return hit;
  for (let attempt = 0; attempt < 5; attempt++) {
    const { raw, hits } = await readHitsState(repository);
    // 同一 ruleId + messageId 只保留最新一条，避免失败后重试留下重复脏记录
    const filtered = hits.filter(item => !(item.ruleId === hit.ruleId && item.messageId === hit.messageId));
    if (await writeHitsState(repository, raw, [...filtered, hit])) return hit;
  }
  return hit;
}

export interface RealtimeRegexMatchOutcome {
  rule: LarkRegexTriggerRule;
  matchedText: string;
  matches: LarkRegexMatchSpan[];
}

/**
 * 实时消息监听路径上的正则命中判定。
 * - 硬性忽略机器人自己发出的消息（isSelfBot=true）防止自激死循环；
 * - 按规则 ignoreBotMessages 过滤其他机器人消息；
 * - 对同一 ruleId + messageId 查重避免重连/补推重复唤起。
 */
export async function findMatchingRealtimeRegexTrigger(
  repository: ConfigRepository | undefined,
  input: {
    botId: string;
    chatId: string;
    messageId: string;
    messageText: string;
    senderType?: string;
    isSelfBot?: boolean;
  }
): Promise<RealtimeRegexMatchOutcome | undefined> {
  if (!repository || input.isSelfBot) return undefined;
  const rules = await readLarkRegexTriggerRules(repository);
  const candidates = rules.filter(rule => rule.enabled && rule.botId === input.botId && rule.chatId === input.chatId);
  if (!candidates.length) return undefined;

  const isBotSender = input.senderType === 'app' || input.senderType === 'bot';
  const hits = await readLarkRegexTriggerHits(repository);
  const triggeredKeys = new Set(
    hits.filter(hit => hit.status === 'triggered' && hit.messageId === input.messageId).map(hit => hit.ruleId)
  );

  for (const rule of candidates) {
    if (rule.ignoreBotMessages && isBotSender) continue;
    if (triggeredKeys.has(rule.id)) continue;
    const match = matchLarkTriggerText(rule.pattern, rule.flags, input.messageText, { timeoutMs: 50 });
    if (match.valid && match.matched) {
      return {
        rule,
        matchedText: match.matchedText,
        matches: match.matches
      };
    }
  }
  return undefined;
}

/** 脱敏并转译飞书 OpenAPI 常见错误，严禁暴露 appSecret 或 tenant_access_token。 */
export function formatLarkOpenApiError(error: unknown, scopeHint: 'chats' | 'messages' | 'reply'): LarkServiceError {
  if (error instanceof LarkServiceError) {
    const upstreamCode = Number(error.details?.upstreamCode);
    const consoleUrl = typeof error.details?.consoleUrl === 'string' ? error.details.consoleUrl : undefined;
    const violations = Array.isArray(error.details?.permissionViolations) ? error.details?.permissionViolations : [];
    const isPermission = upstreamCode === 99991672 || upstreamCode === 99991668 || upstreamCode === 230027 || violations.length > 0 || /permission|scope|privilege|权限/i.test(error.message);
    if (isPermission) {
      const requiredPerm = scopeHint === 'chats'
        ? 'im:chat:read（读取机器人所在群聊列表）'
        : scopeHint === 'messages'
          ? 'im:message:readonly、im:message.group_msg（读取群聊历史消息）'
          : 'im:message:send_as_bot（以机器人身份回复群消息）';
      const detail = consoleUrl ? `，请前往飞书开放平台开通权限：${consoleUrl}` : '，请前往飞书开放平台开通权限后重试';
      return new LarkServiceError(
        'LARK_PERMISSION_DENIED',
        `飞书权限不足：缺少 ${requiredPerm}${detail}`,
        403,
        { ...(consoleUrl ? { consoleUrl } : {}), ...(Number.isFinite(upstreamCode) ? { upstreamCode } : {}) }
      );
    }
    const safeMessage = error.message
      .replace(/Bearer\s+[A-Za-z0-9._-]+/gi, 'Bearer [REDACTED]')
      .replace(/t-[A-Za-z0-9._-]{8,}/g, '[REDACTED_TOKEN]');
    return new LarkServiceError(error.code, safeMessage, error.statusCode);
  }
  const raw = error instanceof Error ? error.message : String(error);
  const safe = raw
    .replace(/Bearer\s+[A-Za-z0-9._-]+/gi, 'Bearer [REDACTED]')
    .replace(/t-[A-Za-z0-9._-]{8,}/g, '[REDACTED_TOKEN]');
  return new LarkServiceError('LARK_OPENAPI_ERROR', safe, 502);
}

/** 将消息中的 @_user_1 等占位符替换为可读的 @姓名。 */
function renderMessageMentions(text: string, mentions: LarkChatMessage['mentions']): string {
  let rendered = text;
  for (const mention of mentions) {
    const key = mention.key?.trim();
    const name = mention.name?.trim();
    if (!key) continue;
    rendered = rendered.split(key).join(name ? `@${name}` : '@成员');
  }
  return rendered;
}

/** 短缓存拉取机器人所在群聊，支持 all=1 自动多页汇总（最多 5 页 / 500 个群）。 */
export class LarkBotChatCache {
  private readonly cache = new Map<string, { value: LarkChatsResult; expiresAt: number }>();

  constructor(private readonly ttlMs = 20_000) {}

  invalidate(appId?: string) {
    if (!appId) { this.cache.clear(); return; }
    for (const key of this.cache.keys()) {
      if (key.startsWith(`${appId}:`)) this.cache.delete(key);
    }
  }

  async list(
    appId: string,
    service: Pick<LarkCardService, 'listChats'>,
    options: { pageToken?: string; all?: boolean; refresh?: boolean } = {}
  ): Promise<LarkChatsResult> {
    const cacheKey = `${appId}:${options.all ? 'all' : 'page'}:${options.pageToken ?? ''}`;
    if (!options.refresh) {
      const cached = this.cache.get(cacheKey);
      if (cached && cached.expiresAt > Date.now()) return cached.value;
    }
    try {
      let result: LarkChatsResult;
      if (options.all && !options.pageToken) {
        const items: LarkChat[] = [];
        const seen = new Set<string>();
        let pageToken: string | undefined;
        let hasMore = false;
        for (let page = 0; page < 5; page++) {
          const batch = await service.listChats(pageToken);
          for (const chat of batch.items) {
            if (seen.has(chat.chatId)) continue;
            seen.add(chat.chatId);
            items.push(chat);
          }
          hasMore = batch.hasMore;
          pageToken = batch.hasMore ? batch.pageToken : undefined;
          if (!pageToken) break;
        }
        result = { items, hasMore, ...(pageToken ? { pageToken } : {}) };
      } else {
        result = await service.listChats(options.pageToken);
      }
      if (this.cache.size >= 100) this.cache.delete(this.cache.keys().next().value!);
      this.cache.set(cacheKey, { value: result, expiresAt: Date.now() + this.ttlMs });
      return result;
    } catch (error) {
      throw formatLarkOpenApiError(error, 'chats');
    }
  }
}

export async function fetchLarkChatMessagesForPreview(
  service: Pick<LarkCardService, 'listChatMessages' | 'getUserName' | 'getMessageItems'>,
  input: {
    botId: string;
    chatId: string;
    limit?: number;
    pageToken?: string;
    repository?: ConfigRepository;
    ruleId?: string;
  }
): Promise<{
  botId: string;
  chatId: string;
  items: LarkPreviewChatMessage[];
  hasMore: boolean;
  pageToken?: string;
  hitsByMessageId: Record<string, LarkRegexTriggerHit[]>;
}> {
  const chatId = input.chatId.trim();
  if (!chatId.startsWith('oc_')) {
    throw new LarkServiceError('INVALID_CHAT_ID', 'chatId 必须以 oc_ 开头', 400);
  }
  const limit = Math.min(100, Math.max(1, Math.floor(input.limit ?? 50)));
  const rawMessages: LarkChatMessage[] = [];
  let pageToken = input.pageToken;
  let hasMore = false;
  try {
    const maxPages = limit > 50 ? 2 : 1;
    for (let page = 0; page < maxPages && rawMessages.length < limit; page++) {
      const remaining = limit - rawMessages.length;
      const batch = await service.listChatMessages({
        chatId,
        order: 'desc',
        pageSize: Math.min(50, remaining),
        ...(pageToken ? { pageToken } : {})
      });
      rawMessages.push(...batch.items);
      hasMore = batch.hasMore;
      pageToken = batch.hasMore ? batch.pageToken : undefined;
      if (!pageToken) break;
    }
  } catch (error) {
    throw formatLarkOpenApiError(error, 'messages');
  }

  // 解析缺失的人类发送人姓名（去重 + 限量 + 忽略权限错误降级）
  const unresolvedOpenIds = [...new Set(
    rawMessages
      .filter(item => !item.sender.name && item.sender.id?.startsWith('ou_') && item.sender.type !== 'app' && item.sender.type !== 'bot')
      .map(item => item.sender.id!)
  )].slice(0, 25);

  const resolvedNames = new Map<string, string>();
  if (unresolvedOpenIds.length && typeof service.getUserName === 'function') {
    await Promise.all(unresolvedOpenIds.map(async openId => {
      try {
        const name = await service.getUserName(openId);
        if (name) resolvedNames.set(openId, name);
      } catch {
        // 缺少通讯录权限时静默降级为 open_id
      }
    }));
  }

  const parsedItems = await Promise.all(rawMessages.map(async (item): Promise<LarkPreviewChatMessage> => {
    const parsed = await parseLarkMessageContent(item.messageType, item.rawContent, {
      messageId: item.messageId
    }).catch(() => ({ text: item.rawContent || '', resources: [] }));
    const text = renderMessageMentions(parsed.text, item.mentions).trim();
    const senderType = item.sender.type || 'unknown';
    const fallbackName = senderType === 'app' || senderType === 'bot'
      ? (item.sender.id || '飞书机器人')
      : (item.sender.id || '群成员');
    const senderName = item.sender.name?.trim()
      || (item.sender.id ? resolvedNames.get(item.sender.id) : undefined)
      || fallbackName;
    const createdAt = larkCreateTimeToIso(item.createTime);
    return {
      messageId: item.messageId,
      chatId: item.chatId || chatId,
      ...(item.threadId ? { threadId: item.threadId } : {}),
      ...(item.rootId ? { rootId: item.rootId } : {}),
      ...(item.parentId ? { parentId: item.parentId } : {}),
      ...(item.sender.id ? { senderId: item.sender.id } : {}),
      senderName,
      senderType,
      text: item.deleted ? '（该消息已撤回）' : text,
      msgType: item.messageType,
      createTime: item.createTime,
      createdAt,
      ...(item.deleted ? { deleted: true } : {}),
      ...(item.mentions.length ? { mentions: item.mentions.map(m => ({ ...(m.key ? { key: m.key } : {}), ...(m.name ? { name: m.name } : {}), ...(m.id ? { id: m.id } : {}) })) } : {})
    };
  }));

  // 按时间正序（旧消息在上、新消息在下），与飞书聊天记录一致
  parsedItems.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.messageId.localeCompare(b.messageId));

  const hits = await readLarkRegexTriggerHits(input.repository);
  const hitsByMessageId: Record<string, LarkRegexTriggerHit[]> = {};
  for (const hit of hits) {
    if (hit.botId !== input.botId || hit.chatId !== chatId) continue;
    if (input.ruleId && hit.ruleId !== input.ruleId) continue;
    const list = hitsByMessageId[hit.messageId] ?? [];
    list.push(hit);
    hitsByMessageId[hit.messageId] = list;
  }

  return {
    botId: input.botId,
    chatId,
    items: parsedItems,
    hasMore,
    ...(pageToken ? { pageToken } : {}),
    hitsByMessageId
  };
}

export interface LarkRegexBackfillMessageInput {
  messageId: string;
  text: string;
  senderId?: string;
  senderName?: string;
  senderType?: string;
  threadId?: string;
  rootId?: string;
  parentId?: string;
  msgType?: string;
  createTime?: string;
  createdAt?: string;
}

export interface LarkRegexBackfillRequest {
  ruleId?: string;
  ruleName?: string;
  botId: string;
  chatId: string;
  chatName?: string;
  pattern: string;
  flags?: string;
  replyMode?: LarkRegexReplyMode;
  promptTemplate?: string;
  ignoreBotMessages?: boolean;
  force?: boolean;
  messages: LarkRegexBackfillMessageInput[];
}

export interface LarkRegexBackfillItemResult {
  messageId: string;
  status: 'triggered' | 'skipped' | 'failed';
  sessionId?: string;
  cardMessageId?: string;
  matchedText?: string;
  alreadyTriggered?: boolean;
  reason?: string;
}

export interface LarkRegexTriggerDispatchInput {
  botConfig: StoredLarkConfig;
  rule: {
    id: string;
    name: string;
    chatId: string;
    chatName: string;
    pattern: string;
    flags: string;
    replyMode: LarkRegexReplyMode;
    promptTemplate: string;
  };
  message: LarkRegexBackfillMessageInput;
  matchedText: string;
  triggerType: LarkRegexTriggerHitType;
}

export interface LarkRegexTriggerRoutesDeps {
  config?: ConfigRepository;
  resolveService: (appId: string) => Promise<LarkCardService>;
  dispatchBackfillTurn: (input: LarkRegexTriggerDispatchInput) => Promise<{ sessionId?: string; cardMessageId?: string }>;
  chatCache?: LarkBotChatCache;
}

export function registerLarkRegexTriggerRoutes(app: FastifyInstance, deps: LarkRegexTriggerRoutesDeps) {
  const handleError = <Req extends FastifyRequest>(handler: (request: Req, reply: FastifyReply) => Promise<unknown>) =>
    async (request: Req, reply: FastifyReply) => {
      try {
        return await handler(request, reply);
      } catch (error) {
        if (error instanceof LarkServiceError) {
          return reply.code(error.statusCode).send({
            error: {
              code: error.code,
              message: error.message,
              ...(error.details?.consoleUrl ? { consoleUrl: error.details.consoleUrl } : {})
            }
          });
        }
        throw error;
      }
    };

  // 读取机器人所在群聊的历史消息（用于正则预览、高亮筛选与历史补偿）
  app.get<{
    Params: { appId: string; chatId: string };
    Querystring: { limit?: string; pageToken?: string; ruleId?: string };
  }>('/api/lark/bots/:appId/chats/:chatId/messages', handleError(async request => {
    const appId = request.params.appId.trim();
    const chatId = request.params.chatId.trim();
    const limit = request.query.limit ? Number(request.query.limit) : 50;
    const service = await deps.resolveService(appId);
    return fetchLarkChatMessagesForPreview(service, {
      botId: appId,
      chatId,
      limit: Number.isFinite(limit) ? limit : 50,
      ...(request.query.pageToken ? { pageToken: request.query.pageToken } : {}),
      repository: deps.config,
      ...(request.query.ruleId ? { ruleId: request.query.ruleId.trim() } : {})
    });
  }));

  // 获取所有正则监听规则 + 统计 + 预置 Prompt 模板与变量目录
  app.get('/api/lark/regex-triggers', handleError(async () => ({
    rules: await listLarkRegexTriggerRulesWithStats(deps.config),
    templates: LARK_REGEX_PROMPT_TEMPLATES,
    variables: LARK_REGEX_TEMPLATE_VARIABLES
  })));

  // 创建正则监听规则
  app.post<{ Body: SaveLarkRegexTriggerInput }>('/api/lark/regex-triggers', handleError(async (request, reply) => {
    const bots = await readLarkConfigs(deps.config);
    const rule = await createLarkRegexTriggerRule(deps.config, bots, request.body ?? {});
    return reply.code(201).send({ rule: { ...rule, hitCount: 0 } });
  }));

  // 更新正则监听规则
  app.patch<{ Params: { id: string }; Body: SaveLarkRegexTriggerInput }>('/api/lark/regex-triggers/:id', handleError(async request => {
    const bots = await readLarkConfigs(deps.config);
    const rule = await updateLarkRegexTriggerRule(deps.config, bots, request.params.id, request.body ?? {});
    const allWithStats = await listLarkRegexTriggerRulesWithStats(deps.config);
    const enriched = allWithStats.find(item => item.id === rule.id) ?? { ...rule, hitCount: 0 };
    return { rule: enriched };
  }));

  // 删除正则监听规则
  app.delete<{ Params: { id: string } }>('/api/lark/regex-triggers/:id', handleError(async request => (
    deleteLarkRegexTriggerRule(deps.config, request.params.id)
  )));

  // 查询全局或筛选后的命中账本
  app.get<{ Querystring: { botId?: string; chatId?: string; ruleId?: string; limit?: string } }>('/api/lark/regex-triggers/hits', handleError(async request => {
    const hits = await readLarkRegexTriggerHits(deps.config);
    const limit = Math.min(200, Math.max(1, Number(request.query.limit ?? 100) || 100));
    const filtered = hits
      .filter(item => (!request.query.botId || item.botId === request.query.botId)
        && (!request.query.chatId || item.chatId === request.query.chatId)
        && (!request.query.ruleId || item.ruleId === request.query.ruleId))
      .reverse()
      .slice(0, limit);
    return { hits: filtered };
  }));

  // 查询某条规则的命中与补偿历史
  app.get<{ Params: { id: string }; Querystring: { limit?: string } }>('/api/lark/regex-triggers/:id/hits', handleError(async request => {
    const hits = await readLarkRegexTriggerHits(deps.config);
    const limit = Math.min(200, Math.max(1, Number(request.query.limit ?? 100) || 100));
    return {
      hits: hits.filter(item => item.ruleId === request.params.id).reverse().slice(0, limit)
    };
  }));

  // 正则预匹配预览（支持直接传入已拉取消息，或按 botId + chatId 由服务端拉取并匹配）
  app.post<{
    Body: {
      pattern?: string;
      flags?: string;
      ignoreBotMessages?: boolean;
      messages?: LarkRegexPreviewMessageInput[];
      botId?: string;
      chatId?: string;
      limit?: number;
    };
  }>('/api/lark/regex-triggers/preview', handleError(async request => {
    const body = request.body ?? {};
    const pattern = String(body.pattern ?? '');
    const flags = typeof body.flags === 'string' ? body.flags : LARK_REGEX_DEFAULT_FLAGS;
    const ignoreBotMessages = body.ignoreBotMessages === true;

    let messages = Array.isArray(body.messages) ? body.messages : undefined;
    let fetchedMessages: LarkPreviewChatMessage[] | undefined;

    if (!messages) {
      const botId = String(body.botId ?? '').trim();
      const chatId = String(body.chatId ?? '').trim();
      if (!botId || !chatId) {
        throw new LarkServiceError('INVALID_PREVIEW_REQUEST', '请提供 messages 列表，或同时提供 botId 与 chatId', 400);
      }
      const service = await deps.resolveService(botId);
      const fetched = await fetchLarkChatMessagesForPreview(service, {
        botId,
        chatId,
        limit: body.limit ?? 50,
        repository: deps.config
      });
      fetchedMessages = fetched.items;
      messages = fetched.items.map(item => ({
        messageId: item.messageId,
        text: item.text,
        senderType: item.senderType
      }));
    }

    const preview = matchLarkTriggerMessages(pattern, flags, messages, { ignoreBotMessages });
    return {
      ...preview,
      ...(fetchedMessages ? { messages: fetchedMessages } : {})
    };
  }));

  // 历史命中消息单条/批量补偿：100% 复用所选机器人的飞书设置发起轮次，带幂等查重与 force 选项
  app.post<{ Body: LarkRegexBackfillRequest }>('/api/lark/regex-triggers/backfill', handleError(async request => {
    const body = request.body ?? ({} as LarkRegexBackfillRequest);
    const botId = String(body.botId ?? '').trim();
    const chatId = String(body.chatId ?? '').trim();
    if (!botId) throw new LarkServiceError('INVALID_BACKFILL_REQUEST', 'botId 必填', 400);
    if (!chatId.startsWith('oc_')) throw new LarkServiceError('INVALID_CHAT_ID', 'chatId 必须以 oc_ 开头', 400);

    const botConfig = await readLarkConfig(deps.config, botId);
    if (!botConfig) throw new LarkServiceError('LARK_BOT_NOT_FOUND', `未找到飞书机器人：${botId}`, 404);
    if (!botConfig.defaultAgentId) {
      throw new LarkServiceError('LARK_BOT_INCOMPLETE', '该机器人尚未配置默认 Agent，请先在「飞书设置」中完成 Agent 配置后再发起轮次', 409);
    }

    const replyMode: LarkRegexReplyMode = body.replyMode === 'main' ? 'main' : 'thread';
    const pattern = String(body.pattern ?? '');
    const validation = validateLarkTriggerRegex(pattern, body.flags ?? LARK_REGEX_DEFAULT_FLAGS);
    if (!validation.valid) {
      throw new LarkServiceError('INVALID_REGEX_PATTERN', validation.error, 400);
    }

    const messages = Array.isArray(body.messages) ? body.messages : [];
    if (!messages.length) {
      throw new LarkServiceError('INVALID_BACKFILL_REQUEST', '请至少选择一条要补偿的历史消息', 400);
    }
    if (messages.length > LARK_REGEX_MAX_BACKFILL_BATCH) {
      throw new LarkServiceError('BACKFILL_BATCH_TOO_LARGE', `单次最多批量补偿 ${LARK_REGEX_MAX_BACKFILL_BATCH} 条消息`, 400);
    }

    // 如果提供了 ruleId，优先读取已保存规则补齐缺失的元信息
    const savedRule = body.ruleId
      ? (await readLarkRegexTriggerRules(deps.config)).find(item => item.id === body.ruleId)
      : undefined;
    const effectiveRuleId = savedRule?.id ?? body.ruleId?.trim() ?? `adhoc:${botId}:${chatId}`;
    const effectiveRuleName = body.ruleName?.trim() || savedRule?.name || '历史补偿触发';
    const effectiveChatName = body.chatName?.trim() || savedRule?.chatName || chatId;
    const effectivePromptTemplate = body.promptTemplate !== undefined
      ? String(body.promptTemplate)
      : (savedRule?.promptTemplate ?? '');
    const force = body.force === true;

    const results: LarkRegexBackfillItemResult[] = [];
    let triggeredCount = 0;
    let skippedCount = 0;
    let failedCount = 0;

    for (const message of messages) {
      const messageId = String(message?.messageId ?? '').trim();
      if (!messageId) {
        failedCount += 1;
        results.push({ messageId: '', status: 'failed', reason: '缺少有效的 messageId' });
        continue;
      }

      // 幂等检查：若该规则或该机器人+群已触发过此消息且未开启 force，则跳过并返回原会话
      if (!force) {
        const existing = await findLarkRegexTriggerHit(deps.config, {
          ruleId: savedRule?.id || body.ruleId?.trim() || undefined,
          botId,
          chatId,
          messageId
        });
        if (existing) {
          skippedCount += 1;
          results.push({
            messageId,
            status: 'skipped',
            alreadyTriggered: true,
            ...(existing.sessionId ? { sessionId: existing.sessionId } : {}),
            ...(existing.cardMessageId ? { cardMessageId: existing.cardMessageId } : {}),
            matchedText: existing.matchedText,
            reason: '该消息已触发过唤起，已跳过重复执行'
          });
          continue;
        }
      }

      const text = String(message.text ?? '');
      const match = matchLarkTriggerText(pattern, validation.normalizedFlags, text);
      if (!match.valid) {
        failedCount += 1;
        results.push({ messageId, status: 'failed', reason: match.error || '正则匹配失败' });
        continue;
      }
      if (!match.matched && !force) {
        skippedCount += 1;
        results.push({ messageId, status: 'skipped', reason: '该消息未命中当前正则表达式' });
        continue;
      }

      const matchedText = match.matchedText || text.slice(0, 80);
      try {
        const dispatched = await deps.dispatchBackfillTurn({
          botConfig,
          rule: {
            id: effectiveRuleId,
            name: effectiveRuleName,
            chatId,
            chatName: effectiveChatName,
            pattern,
            flags: validation.normalizedFlags,
            replyMode,
            promptTemplate: effectivePromptTemplate
          },
          message: {
            ...message,
            messageId,
            text
          },
          matchedText,
          triggerType: 'backfill'
        });

        await recordLarkRegexTriggerHit(deps.config, {
          ruleId: effectiveRuleId,
          botId,
          chatId,
          messageId,
          ...(dispatched.sessionId ? { sessionId: dispatched.sessionId } : {}),
          ...(dispatched.cardMessageId ? { cardMessageId: dispatched.cardMessageId } : {}),
          matchedText,
          ...(message.senderName ? { senderName: message.senderName } : {}),
          messagePreview: text.slice(0, 120),
          triggerType: 'backfill',
          status: 'triggered'
        });

        triggeredCount += 1;
        results.push({
          messageId,
          status: 'triggered',
          ...(dispatched.sessionId ? { sessionId: dispatched.sessionId } : {}),
          ...(dispatched.cardMessageId ? { cardMessageId: dispatched.cardMessageId } : {}),
          matchedText
        });
      } catch (error) {
        const formatted = formatLarkOpenApiError(error, 'reply');
        await recordLarkRegexTriggerHit(deps.config, {
          ruleId: effectiveRuleId,
          botId,
          chatId,
          messageId,
          matchedText,
          ...(message.senderName ? { senderName: message.senderName } : {}),
          messagePreview: text.slice(0, 120),
          triggerType: 'backfill',
          status: 'failed',
          error: formatted.message
        });
        failedCount += 1;
        results.push({
          messageId,
          status: 'failed',
          matchedText,
          reason: formatted.message
        });
      }
    }

    return {
      ruleId: effectiveRuleId,
      botId,
      chatId,
      replyMode,
      triggeredCount,
      skippedCount,
      failedCount,
      results
    };
  }));
}
