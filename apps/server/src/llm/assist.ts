/**
 * 全站统一 LLM 文本辅助引擎（POST /api/llm/assist）。
 *
 * 覆盖六类核心辅助场景：
 * - prompt_write       从零撰写高质量结构化 Prompt（支持保留 {{var}} 变量）
 * - prompt_optimize    润色/精简/结构化已有 Prompt（严格保留原意与 {{var}} 变量）
 * - message_polish     润色口语化聊天消息 / Agent 指令（保留斜杠命令与技术细节）
 * - title_generate     根据会话消息/正文生成精准简短中文标题
 * - regex_generate     根据自然语言意图生成安全可用的 JS RegExp（返回 pattern/flags/explanation）
 * - description_polish 撰写/优化模板说明、定时任务/看板说明、卡片备注、回复署名等短文案
 *
 * 每类模式都通过 systemPrompt 施加严格约束，并做确定性后处理清理废话前缀与多余代码围栏，
 * 确保前端可以直接无损回填到输入框。
 */
import { z } from 'zod';
import { RuntimeError } from '@agent-dock/agent-dock-shared';
import type { LlmEndpointService } from './service.js';
import type { LlmFormat } from './types.js';

export const llmAssistModes = [
  'prompt_write',
  'prompt_optimize',
  'message_polish',
  'title_generate',
  'regex_generate',
  'description_polish'
] as const;
export type LlmAssistMode = (typeof llmAssistModes)[number];

export const llmAssistActions = [
  'write',
  'optimize',
  'concise',
  'structure',
  'generate'
] as const;
export type LlmAssistAction = (typeof llmAssistActions)[number];

const recentMessageSchema = z.object({
  role: z.string().max(40).optional(),
  text: z.string().max(2_000)
});

export const llmAssistContextSchema = z.object({
  /** 字段/输入框名称，例如「会话 System Prompt」「定时任务指令」 */
  field: z.string().max(120).optional(),
  /** 输入框用途说明 */
  purpose: z.string().max(1_000).optional(),
  /** 可用模板变量列表，如 ['项目', '验证命令'] */
  variables: z.array(z.string().max(80)).max(40).optional(),
  /** 工作目录 */
  cwd: z.string().max(500).optional(),
  /** Agent 名称 */
  agentName: z.string().max(120).optional(),
  /** 模型名称 */
  model: z.string().max(160).optional(),
  /** 当前会话/任务标题 */
  sessionTitle: z.string().max(200).optional(),
  /** 会话最近消息摘要（按时间正序） */
  recentMessages: z.array(recentMessageSchema).max(20).optional(),
  /** 飞书机器人或第三方配置上下文 */
  botContext: z.string().max(2_000).optional(),
  /** 群聊名称 */
  groupName: z.string().max(200).optional(),
  /** 正向示例消息（供正则生成参考） */
  sampleMessages: z.array(z.string().max(1_000)).max(20).optional(),
  /** 反向示例消息（供正则生成防误伤） */
  negativeSamples: z.array(z.string().max(1_000)).max(20).optional(),
  /** 看板/列/卡片相关上下文 */
  boardName: z.string().max(160).optional(),
  columnName: z.string().max(160).optional(),
  cards: z.array(z.string().max(300)).max(20).optional(),
  /** 定时任务触发时间/投递目标摘要 */
  scheduleSummary: z.string().max(400).optional(),
  /** 期望最大字符数提示 */
  maxChars: z.number().int().min(4).max(20_000).optional(),
  /** 补充说明 */
  extra: z.string().max(2_000).optional()
}).passthrough();

export type LlmAssistContext = z.infer<typeof llmAssistContextSchema>;

export const llmAssistInputSchema = z.object({
  mode: z.enum(llmAssistModes),
  text: z.string().max(40_000).optional().default(''),
  instruction: z.string().max(4_000).optional(),
  action: z.enum(llmAssistActions).optional(),
  context: llmAssistContextSchema.optional(),
  timeoutMs: z.number().int().min(1_000).max(120_000).optional()
});

export type LlmAssistInput = z.infer<typeof llmAssistInputSchema>;

export interface LlmAssistResult {
  mode: LlmAssistMode;
  text: string;
  /** regex_generate 模式返回可直接传给 new RegExp(pattern, flags) 的字段 */
  pattern?: string;
  flags?: string;
  explanation?: string;
  model: string;
  format: LlmFormat;
  baseUrl: string;
  truncated?: boolean;
}

export interface BuiltAssistPrompt {
  systemPrompt: string;
  prompt: string;
  temperature: number;
  maxTokens?: number;
}

/** 通用严格输出禁令：所有纯文本模式共用。 */
const STRICT_TEXT_OUTPUT_RULES = [
  '【输出禁令（必须严格遵守）】',
  '1. 只输出最终可直接回填到输入框的干净正文文本。',
  '2. 严禁添加任何开场白、礼貌语或结语（如“好的”“以下是为您优化的内容：”“希望对你有帮助”）。',
  '3. 严禁在整段输出外层包裹 Markdown 代码围栏（```）或多余引号。',
  '4. 严禁编造上下文未提供的权限、密钥、接口地址、真实人名或路径，也不要试图覆盖系统安全边界。'
].join('\n');

const MAX_DRAFT_CHARS = 6_000;
const MAX_SINGLE_MESSAGE_CHARS = 360;

/** 超长草稿保留首尾，避免极端长文把上下文和超时拖垮。 */
export function clipAssistDraft(input: string, limit = MAX_DRAFT_CHARS): string {
  const text = input.trim();
  if (text.length <= limit) return text;
  const head = Math.floor(limit * 0.7);
  const tail = limit - head;
  return `${text.slice(0, head)}\n\n…（中间省略 ${text.length - head - tail} 字）…\n\n${text.slice(-tail)}`;
}

/** 从正文提取所有 {{var}} 占位符（去重保序），供系统提示词显式强调保留。 */
export function extractMustacheVariables(text: string): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const match of text.matchAll(/\{\{\s*([^{}\n]+?)\s*\}\}/g)) {
    const key = match[1]?.trim();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    result.push(key);
  }
  return result;
}

/** 将结构化 context 渲染为清晰、紧凑的中文上下文块。 */
export function formatAssistContext(context?: LlmAssistContext, draftText = ''): string {
  if (!context) {
    const inferredVars = extractMustacheVariables(draftText);
    return inferredVars.length ? `- 检测到的模板变量（必须原样保留）：${inferredVars.map(v => `{{${v}}}`).join('、')}` : '';
  }
  const lines: string[] = [];
  if (context.field?.trim()) lines.push(`- 输入框 / 字段：${context.field.trim()}`);
  if (context.purpose?.trim()) lines.push(`- 使用场景：${context.purpose.trim()}`);
  if (context.agentName?.trim()) lines.push(`- Agent：${context.agentName.trim()}`);
  if (context.model?.trim()) lines.push(`- 模型：${context.model.trim()}`);
  if (context.cwd?.trim()) lines.push(`- 工作目录：${context.cwd.trim()}`);
  if (context.sessionTitle?.trim()) lines.push(`- 当前标题 / 主题：${context.sessionTitle.trim()}`);
  if (context.scheduleSummary?.trim()) lines.push(`- 定时规则与目标：${context.scheduleSummary.trim()}`);
  if (context.boardName?.trim()) lines.push(`- 所属看板：${context.boardName.trim()}`);
  if (context.columnName?.trim()) lines.push(`- 所属列：${context.columnName.trim()}`);
  if (context.groupName?.trim()) lines.push(`- 飞书群聊：${context.groupName.trim()}`);

  const mergedVars = [...new Set([
    ...(context.variables ?? []).map(v => v.trim()).filter(Boolean),
    ...extractMustacheVariables(draftText)
  ])];
  if (mergedVars.length) {
    lines.push(`- 模板变量占位符（必须原样保留花括号与变量名）：${mergedVars.map(v => `{{${v}}}`).join('、')}`);
  }

  if (context.cards?.length) {
    lines.push(`- 关联卡片：\n${context.cards.slice(0, 12).map(card => `  * ${card.trim()}`).join('\n')}`);
  }
  if (context.botContext?.trim()) {
    lines.push(`- 机器人配置上下文：\n${context.botContext.trim().split('\n').map(line => `  ${line}`).join('\n')}`);
  }
  if (context.sampleMessages?.length) {
    lines.push(`- 期望命中的示例消息：\n${context.sampleMessages.slice(0, 12).map((msg, i) => `  ${i + 1}. ${msg.trim().slice(0, 300)}`).join('\n')}`);
  }
  if (context.negativeSamples?.length) {
    lines.push(`- 不应命中的反向示例：\n${context.negativeSamples.slice(0, 12).map((msg, i) => `  ${i + 1}. ${msg.trim().slice(0, 300)}`).join('\n')}`);
  }
  if (context.recentMessages?.length) {
    const rendered = context.recentMessages
      .filter(item => item.text.trim())
      .slice(-12)
      .map(item => {
        const role = item.role?.trim() || '消息';
        const snippet = item.text.replace(/\s+/g, ' ').trim().slice(0, MAX_SINGLE_MESSAGE_CHARS);
        return `  - [${role}] ${snippet}`;
      });
    if (rendered.length) lines.push(`- 最近对话摘要：\n${rendered.join('\n')}`);
  }
  if (context.maxChars) lines.push(`- 建议长度上限：不超过 ${context.maxChars} 字`);
  if (context.extra?.trim()) lines.push(`- 补充信息：${context.extra.trim()}`);

  // 透传其他扩展字段（保留兼容性，跳过已知键与空值）
  const knownKeys = new Set([
    'field', 'purpose', 'variables', 'cwd', 'agentName', 'model', 'sessionTitle',
    'recentMessages', 'botContext', 'groupName', 'sampleMessages', 'negativeSamples',
    'boardName', 'columnName', 'cards', 'scheduleSummary', 'maxChars', 'extra'
  ]);
  for (const [key, value] of Object.entries(context)) {
    if (knownKeys.has(key) || value === undefined || value === null || value === '') continue;
    const text = typeof value === 'string' ? value.trim() : JSON.stringify(value);
    if (text && text !== '{}' && text !== '[]') {
      lines.push(`- ${key}：${text.slice(0, 400)}`);
    }
  }
  return lines.join('\n');
}

function actionDirective(mode: LlmAssistMode, action?: LlmAssistAction): string {
  if (!action) return '';
  switch (action) {
    case 'concise':
      return '处理偏好：极简提炼——在不丢失核心意图、关键参数、路径、命令与 {{变量}} 的前提下，大幅压缩冗余词句，短小干练。';
    case 'structure':
      return mode === 'description_polish'
        ? '处理偏好：结构化分点——按要点分条整理，重点清晰、便于一眼扫读。'
        : '处理偏好：结构化展开——用清晰的层次或分点（目标 / 约束与范围 / 执行要点 / 预期输出）重新组织，条理分明且不冗长。';
    case 'write':
      return '处理偏好：根据场景上下文和用户意图从零起草一份完整、高质量、可直接使用的版本。';
    case 'optimize':
      return '处理偏好：保留原核心意图与事实细节，让表达更清晰、精准、无歧义，去掉口语化啰嗦。';
    case 'generate':
      return '处理偏好：直接根据提供的上下文信息精准生成最终结果。';
  }
}

/** 构造各模式的系统提示词与用户输入块（纯函数，便于测试与审计）。 */
export function buildLlmAssistPrompt(input: LlmAssistInput): BuiltAssistPrompt {
  const mode = input.mode;
  const draft = clipAssistDraft(input.text ?? '');
  const instruction = input.instruction?.trim() ?? '';
  const contextBlock = formatAssistContext(input.context, draft);
  const actionNote = actionDirective(mode, input.action);
  const vars = [...new Set([
    ...(input.context?.variables ?? []).map(v => v.trim()).filter(Boolean),
    ...extractMustacheVariables(draft)
  ])];
  const varRule = vars.length
    ? `【变量保护铁律】下列模板占位符必须原样保留（精确字符与双花括号不可改动）：${vars.map(v => `{{${v}}}`).join('、')}。`
    : '若文本中存在 {{变量名}} 占位符，必须原样保留其精确名称与花括号格式，不得删除或翻译。';

  let systemPrompt: string;
  let temperature = 0.35;
  let maxTokens: number | undefined;

  switch (mode) {
    case 'prompt_write': {
      systemPrompt = [
        '你是 AgentDock 的资深 AI Prompt 工程师，专精为编程 Agent（Claude Code / Codex 等）、系统提示词（System Prompt）、飞书机器人预注入指令、提示词模板及定时自动化任务编写高质量、可直接落地的提示词。',
        '',
        '【撰写规范】',
        '- 紧扣输入框用途、注入上下文与用户需求；目标明确、边界清晰、具备可执行性。',
        '- 使用简洁自然的中文（除非用户明确要求英文或原文为英文），优先采用短段落或清晰分点，避免空话与官僚套话。',
        `- ${varRule}`,
        '- 若字段为飞书机器人预注入 Prompt 或系统提示词，控制篇幅精炼（默认 120–260 字，除非需求明确要求详尽规范），方便 Agent 每轮稳定遵循。',
        '- 若字段为定时任务指令，确保写成 Agent 在无历史对话背景下也能独立执行的完整任务说明（包含检查对象、执行动作与汇报格式）。',
        ...(actionNote ? ['', actionNote] : []),
        '',
        STRICT_TEXT_OUTPUT_RULES
      ].join('\n');
      temperature = 0.4;
      break;
    }

    case 'prompt_optimize': {
      systemPrompt = [
        '你是 AgentDock 的资深 Prompt 优化专家。你的任务是在忠实保留用户核心意图与全部技术约束的前提下，把已有草稿润色得更清晰、逻辑严密、边界明确、易于 Agent 一次执行到位。',
        '',
        '【优化规范】',
        '- 修正歧义、消除重复和口语化拖沓，补足隐含但不改变原意的执行衔接。',
        '- 严格保留原文中的所有文件路径、命令、专有名词、数字阈值、斜杠命令与条件判断。',
        `- ${varRule}`,
        '- 保持与原文一致的主要语言（中文输入输出中文，英文输入输出英文）。',
        '- 不要过度膨胀篇幅，追求高信息密度与可读性。',
        ...(actionNote ? ['', actionNote] : []),
        '',
        STRICT_TEXT_OUTPUT_RULES
      ].join('\n');
      temperature = 0.3;
      break;
    }

    case 'message_polish': {
      systemPrompt = [
        '你是 AgentDock 的智能输入润色助手。你的任务是把用户随手打出的口语化想法、碎片需求或聊天消息，润色成表达清晰、重点突出、无歧义且自然得体的消息文本。',
        '',
        '【润色规范】',
        '- 准确传达用户的真实意图：改掉语病、错漏与含糊指代，让接收方（AI Agent、主小猫或飞书同事）一眼明白背景与要做什么。',
        '- 严格保留原有斜杠命令前缀（如 /plan、/goal、/fast、/btw）、@提及、文件路径、代码片段、报错信息、URL 与数字细节。',
        '- 保持克制自然：简短问题润色成干练的一两句，复杂需求才适度分点；绝不要把一句日常指令写成长篇大论或官样文章。',
        '- 若原文为空且用户提供了简短意图，则结合当前会话/看板上下文直接起草一条即可发送的高质量消息。',
        ...(actionNote ? ['', actionNote] : []),
        '',
        STRICT_TEXT_OUTPUT_RULES
      ].join('\n');
      temperature = 0.35;
      break;
    }

    case 'title_generate': {
      const maxChars = input.context?.maxChars ?? 22;
      systemPrompt = [
        '你是 AgentDock 的精准标题命名助手。你的任务是根据会话内容、任务正文或模板上下文，提炼出一个简短、具体、一眼即可区分主题的中文标题。',
        '',
        '【命名规范】',
        `- 优先使用简明中文动宾或偏正短语（API/SQLite/React/Lark/SSH 等常见技术名词可保留英文），长度控制在 6–${Math.min(maxChars, 28)} 个字符内。`,
        '- 紧扣核心对象与具体事项（例如：「全站接入 LLM 辅助输入」「排查飞书群聊去重异常」「每日早报定时汇总」）。',
        '- 禁止泛泛无信息量的标题（如“问题咨询”“代码修改”“新建任务”“会话记录”）。',
        '- 若原标题已存在且用户要求重生成，尽量生成比原标题更贴切、更聚焦的表达。',
        ...(actionNote ? ['', actionNote] : []),
        '',
        '【输出禁令（极严格）】',
        '1. 只输出唯一一行纯标题文本，不要换行。',
        '2. 严禁加引号（""/「」/《》）、句号、序号、Markdown 标题符（#）或“标题：”前缀。',
        '3. 不要输出多个候选，也不要附带任何解释。'
      ].join('\n');
      temperature = 0.3;
      maxTokens = 96;
      break;
    }

    case 'regex_generate': {
      systemPrompt = [
        '你是精通 ECMAScript（JavaScript）正则表达式与 ReDoS 防护的专家。请根据用户的自然语言匹配意图、正/反示例消息及场景上下文，生成精准、安全、可直接传给 JavaScript `new RegExp(pattern, flags)` 的正则表达式。',
        '',
        '【正则工程规范】',
        '- 必须是标准 JavaScript RegExp 语法（不要使用 PCRE 专有语法如 (?i) 内联修饰符或占有量词 *+）。',
        '- 严格防范灾难性回溯（ReDoS）：禁止嵌套不确定量词（如 (a+)+、(.*x)+），优先使用明确字符类、非捕获分组 (?:...) 与边界约束。',
        '- flags 仅从合法 JS 标志（i / m / s / u）中按需选择（例如英文关键词匹配通常用 "i"，纯中文可为空串 ""）；**不要添加 g 标志**（RegExp.prototype.test 带 g 存在 lastIndex 复用状态陷阱）。',
        '- 若提供了「期望命中的示例消息」与「不应命中的反向示例」，务必确保正例全部命中、反例全部不误命中。',
        '- 若已有现成正则草稿且用户要求优化，保留其核心防护/匹配意图并修补漏洞或误报。',
        '',
        '【输出格式（极严格）】',
        '必须且只能输出单个合法 JSON 对象，不要包含 Markdown 代码围栏、不要有任何前后解释文字：',
        '{"pattern":"<可直接传给 new RegExp 的转义后正则源码>","flags":"<例如 i 或空串>","explanation":"<20–60 字简洁中文，说明匹配规则与边界>"}'
      ].join('\n');
      temperature = 0.15;
      maxTokens = 512;
      break;
    }

    case 'description_polish': {
      systemPrompt = [
        '你是 AgentDock 的协作文档与产品文案编辑助手。你负责为提示词模板说明、任务看板简介、看板卡片内容/备注、小猫督办批注或飞书回复署名撰写或润色精炼清晰、直观易读的文案。',
        '',
        '【文案规范】',
        '- 贴合字段定位与长度要求：单行说明/署名保持简短精炼（通常 10–45 字）；卡片备注/要点可分点列出重点与验收项。',
        '- 保留原文中的关键事实、编号、人名、路径与优先级标签，不胡乱编造未提及的进展或结论。',
        '- 语气克制、专业、自然，去掉啰嗦铺垫。',
        ...(actionNote ? ['', actionNote] : []),
        '',
        STRICT_TEXT_OUTPUT_RULES
      ].join('\n');
      temperature = 0.35;
      break;
    }
  }

  const sections: string[] = [];
  if (contextBlock) {
    sections.push(`【场景上下文】\n${contextBlock}`);
  }
  if (instruction) {
    sections.push(`【用户需求 / 补充指示】\n${instruction}`);
  }
  if (draft) {
    sections.push(`【当前输入框内容】\n${draft}`);
  } else {
    sections.push('【当前输入框内容】\n（空）');
  }
  sections.push(
    mode === 'regex_generate'
      ? '请严格按照 JSON 格式输出最终正则表达式结果。'
      : mode === 'title_generate'
        ? '请直接输出唯一一行最精准简短的标题。'
        : '请直接输出最终可直接回填到输入框的干净正文。'
  );

  return {
    systemPrompt,
    prompt: sections.join('\n\n'),
    temperature,
    ...(maxTokens !== undefined ? { maxTokens } : {})
  };
}

/** 去除模型偶发的礼貌前缀与整段外层代码围栏，不误伤正文内嵌代码块。 */
export function sanitizePlainAssistText(raw: string): string {
  let text = raw.replace(/\r\n/g, '\n').trim();
  if (!text) return '';

  // 去掉开头寒暄（仅在第一行以冒号收尾且紧跟换行时剥离，避免误删正文）
  text = text.replace(/^(?:好的|当然|没问题|明白了|以下是|这是|为您|已为您|优化后|润色后|生成结果)[^\n]{0,36}[：:]\s*\n+/, '').trim();

  // 若整段被单一外层 ```...``` 围栏包住，只剥外层围栏（中间还有围栏闭合就不剥，防止误切正文里的多段代码）
  const fenced = text.match(/^```[a-zA-Z0-9_-]*[ \t]*\n([\s\S]*?)\n```$/);
  if (fenced && !fenced[1]!.includes('\n```')) {
    text = fenced[1]!.trim();
  }
  return text.trim();
}

/** 标题专用后处理：只留单行，剥掉引号、编号、Markdown 标记与尾句号。 */
export function sanitizeTitleOutput(raw: string, maxChars = 60): string {
  const cleaned = sanitizePlainAssistText(raw);
  const firstLine = cleaned.split('\n').map(line => line.trim()).find(Boolean) ?? '';
  let title = firstLine
    .replace(/^#+\s*/, '')
    .replace(/^(?:[-•*]|\d+[.)\]])\s+/, '')
    .replace(/^(?:标题|会话标题|名称)[：:]\s*/, '')
    .trim();
  title = title.replace(/^\*\*([\s\S]+)\*\*$/, '$1').trim();
  // 剥去成对的外层引号/书名号
  const pairs: ReadonlyArray<[string, string]> = [
    ['"', '"'], ['\'', '\''], ['“', '”'], ['「', '」'], ['『', '』'], ['《', '》'], ['【', '】']
  ];
  for (const [open, close] of pairs) {
    if (title.startsWith(open) && title.endsWith(close) && title.length > open.length + close.length) {
      title = title.slice(open.length, -close.length).trim();
    }
  }
  title = title.replace(/[。！？!?.]+$/, '').replace(/\s+/g, ' ').trim();
  if (title.length > maxChars) title = title.slice(0, maxChars).trim();
  return title;
}

const VALID_JS_REGEX_FLAGS = new Set(['d', 'g', 'i', 'm', 's', 'u', 'v', 'y']);

function normalizeRegexFlags(raw: string | undefined): string {
  if (!raw) return '';
  const seen = new Set<string>();
  let result = '';
  for (const ch of raw) {
    if (!VALID_JS_REGEX_FLAGS.has(ch) || seen.has(ch)) continue;
    seen.add(ch);
    result += ch;
  }
  return result;
}

/** 简单静态检查明显的灾难性回溯（嵌套量词，如 (a+)+ / (.*)*）。 */
function hasObviousCatastrophicQuantifier(pattern: string): boolean {
  return /\((?:[^()\\]|\\.)*[+*](?:[^()\\]|\\.)*\)[+*{]/.test(pattern);
}

/** 解析并编译校验 regex_generate 的输出。 */
export function parseRegexAssistOutput(raw: string): { pattern: string; flags: string; explanation: string } {
  const cleaned = sanitizePlainAssistText(raw);
  if (!cleaned) {
    throw new RuntimeError('LLM_EMPTY_REPLY', '模型没有返回有效的正则表达式，请重试或补充匹配示例。', 502);
  }

  let pattern = '';
  let flags = '';
  let explanation = '';

  const tryJson = (candidate: string): boolean => {
    try {
      const parsed = JSON.parse(candidate) as Record<string, unknown>;
      if (!parsed || typeof parsed !== 'object') return false;
      if (typeof parsed.pattern !== 'string' || !parsed.pattern.trim()) return false;
      pattern = parsed.pattern.trim();
      flags = typeof parsed.flags === 'string' ? normalizeRegexFlags(parsed.flags) : '';
      explanation = typeof parsed.explanation === 'string' ? parsed.explanation.trim() : '';
      return true;
    } catch {
      return false;
    }
  };

  let parsed = tryJson(cleaned);
  if (!parsed) {
    const start = cleaned.indexOf('{');
    const end = cleaned.lastIndexOf('}');
    if (start >= 0 && end > start) {
      parsed = tryJson(cleaned.slice(start, end + 1));
    }
  }
  if (!parsed) {
    // 兜底：若模型直接回了 `/pattern/flags` 字面量或裸正则行
    const firstLine = cleaned.split('\n').map(line => line.trim()).find(Boolean) ?? '';
    const literal = firstLine.match(/^\/(.+)\/([a-z]*)$/i);
    if (literal) {
      pattern = literal[1]!.trim();
      flags = normalizeRegexFlags(literal[2]);
    } else {
      pattern = firstLine.replace(/^`+|`+$/g, '').trim();
    }
  }

  // 去掉意外包裹在 pattern 两端的 /.../
  if (!flags && pattern.length > 2 && pattern.startsWith('/') && /\/[a-z]*$/i.test(pattern)) {
    const literal = pattern.match(/^\/(.+)\/([a-z]*)$/i);
    if (literal) {
      pattern = literal[1]!.trim();
      flags = normalizeRegexFlags(literal[2]);
    }
  }

  if (!pattern) {
    throw new RuntimeError('LLM_INVALID_REGEX', '模型未生成可用的正则表达式内容，请补充更明确的匹配规则。', 422);
  }
  if (hasObviousCatastrophicQuantifier(pattern)) {
    throw new RuntimeError('LLM_UNSAFE_REGEX', `生成的正则存在回溯风险（${pattern}），请换一种更具体的描述重试。`, 422);
  }
  try {
    // 验证可直接用于 JS new RegExp(pattern, flags)
    new RegExp(pattern, flags);
  } catch (error) {
    throw new RuntimeError(
      'LLM_INVALID_REGEX',
      `模型生成的正则语法不合法（${error instanceof Error ? error.message : String(error)}），请重试。`,
      422
    );
  }

  return {
    pattern,
    flags,
    explanation: explanation || '已根据描述生成可直接用于 JavaScript RegExp 的匹配规则。'
  };
}

/** 校验输入是否至少携带了生成所需的有效信息，避免把空请求打给上游模型。 */
export function validateAssistContent(input: LlmAssistInput): void {
  const hasText = Boolean(input.text?.trim());
  const hasInstruction = Boolean(input.instruction?.trim());
  const ctx = input.context;
  const hasContext = Boolean(
    ctx && (
      ctx.purpose?.trim()
      || ctx.botContext?.trim()
      || ctx.sessionTitle?.trim()
      || ctx.scheduleSummary?.trim()
      || ctx.groupName?.trim()
      || ctx.boardName?.trim()
      || ctx.columnName?.trim()
      || ctx.extra?.trim()
      || ctx.recentMessages?.some(m => m.text.trim())
      || ctx.sampleMessages?.some(s => s.trim())
      || ctx.cards?.some(c => c.trim())
      || ctx.variables?.length
    )
  );

  if (input.mode === 'prompt_optimize' && !hasText && !hasInstruction) {
    throw new RuntimeError('INVALID_ASSIST_INPUT', '请先输入要优化的 Prompt，或填写生成需求。', 400);
  }
  if (input.mode === 'regex_generate' && !hasText && !hasInstruction && !ctx?.sampleMessages?.some(s => s.trim())) {
    throw new RuntimeError('INVALID_ASSIST_INPUT', '请描述需要匹配的内容或提供示例消息。', 400);
  }
  if (!hasText && !hasInstruction && !hasContext) {
    throw new RuntimeError('INVALID_ASSIST_INPUT', '请先输入文本、需求描述或提供场景上下文。', 400);
  }
}

/** 执行一次统一 AI 文本辅助请求。 */
export async function runLlmAssist(service: LlmEndpointService, rawInput: unknown): Promise<LlmAssistResult> {
  const parsed = llmAssistInputSchema.safeParse(rawInput);
  if (!parsed.success) {
    const detail = parsed.error.issues.map(issue => `${issue.path.join('.') || 'body'} ${issue.message}`).join('；');
    throw new RuntimeError('INVALID_ASSIST_INPUT', `AI 辅助参数不合法：${detail}`, 400);
  }
  const input = parsed.data;
  validateAssistContent(input);

  // 未配置 LLM 端点时返回明确的 503 与友好引导提示（不影响现有 /complete 的 409 契约）。
  const endpoint = await service.endpoint();
  if (!endpoint) {
    throw new RuntimeError(
      'LLM_NOT_CONFIGURED',
      '尚未配置 LLM 模型端点：请前往「设置 → Agent 设置 → 模型端点」完成配置后再使用 AI 辅助功能。',
      503
    );
  }

  const built = buildLlmAssistPrompt(input);
  const timeoutMs = Math.min(Math.max(input.timeoutMs ?? 60_000, 1_000), 120_000);
  const run = await service.run({
    prompt: built.prompt,
    systemPrompt: built.systemPrompt,
    temperature: built.temperature,
    ...(built.maxTokens !== undefined ? { maxTokens: built.maxTokens } : {}),
    timeoutMs
  });

  if (input.mode === 'regex_generate') {
    const regex = parseRegexAssistOutput(run.text);
    return {
      mode: input.mode,
      text: regex.pattern,
      pattern: regex.pattern,
      flags: regex.flags,
      explanation: regex.explanation,
      model: run.model,
      format: run.format,
      baseUrl: run.baseUrl,
      ...(run.truncated ? { truncated: true } : {})
    };
  }

  const text = input.mode === 'title_generate'
    ? sanitizeTitleOutput(run.text, input.context?.maxChars ? Math.max(input.context.maxChars, 32) : 60)
    : sanitizePlainAssistText(run.text);

  if (!text) {
    throw new RuntimeError('LLM_EMPTY_REPLY', '模型返回了空内容，请稍后重试或调整需求描述。', 502);
  }

  return {
    mode: input.mode,
    text,
    model: run.model,
    format: run.format,
    baseUrl: run.baseUrl,
    ...(run.truncated ? { truncated: true } : {})
  };
}
