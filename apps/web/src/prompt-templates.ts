/**
 * 首页的提示词模板。
 *
 * 模板正文用 `{{变量名}}` 标记需要用户填的空；预置模板自带字段定义，自定义模板从正文里
 * 自动提取变量。这样用户只需要写一段完整提示词，不必再维护一套字段结构。
 */

export type PromptTemplateIcon = 'repeat' | 'sparkles' | 'bug' | 'review' | 'test' | 'compass' | 'custom';

export interface PromptTemplateField {
  key: string;
  label: string;
  placeholder?: string;
  multiline?: boolean;
  optional?: boolean;
  defaultValue?: string;
}

export interface PromptTemplate {
  id: string;
  title: string;
  description: string;
  icon: PromptTemplateIcon;
  body: string;
  fields: PromptTemplateField[];
  builtin: boolean;
}

export const PROMPT_TEMPLATE_STORAGE_KEY = 'agentdock.prompt-templates.v1';
const MAX_TITLE = 40;
const MAX_DESCRIPTION = 120;
const MAX_BODY = 20_000;
const MAX_CUSTOM_TEMPLATES = 50;

const ralphBody = `你是一个持续迭代的开发 Agent。请按「计划 → 执行 → 验证 → 记录」循环推进，直到目标达成或达到轮次上限。

目标：{{目标}}
验收命令：{{验收命令}}
轮次上限：{{轮次上限}}

每轮规则：
1. 先读取仓库里的 AGENTS.md / CLAUDE.md 和任务计划文件（如 TASKS.md / IMPLEMENTATION_PLAN.md）。
2. 只做一个最小、可独立验证的增量，不要顺手重构无关代码。
3. 执行验收命令；失败就定位根因并修复，再重跑。
4. 把已完成项、剩余项和阻塞写回任务计划文件；不要删除或弱化失败测试。
5. 一轮结束后重新开始，直到验收命令通过或达到轮次上限。

停止条件：
- 验收命令全部通过：输出 DONE，并总结改动与验证结果。
- 达到轮次上限仍未通过：停下，列出失败项、已尝试方案和下一步建议，不要继续硬试。
- 需要产品决策或缺少凭证：立即停下提问，不要猜测。`;

const featureBody = `请实现下面的功能。先给出简短计划（涉及文件、数据流、风险），再开始改代码。

需求：{{需求}}
验收标准：{{验收标准}}
约束：{{约束}}

要求：
- 先阅读相关代码和测试，沿用现有模式；不要引入不必要的新依赖。
- 保持改动最小，不顺手重构无关模块。
- 为关键路径补测试，并运行相关测试与类型检查。
- 最后总结改动、验证命令和仍然存在的风险。`;

const bugBody = `请修复下面的 Bug。先复现并找到根因，再改代码；不要靠吞异常或放宽断言让测试变绿。

现象：{{现象}}
复现步骤：{{复现步骤}}
期望结果：{{期望结果}}
错误日志 / 堆栈（可选）：{{错误日志}}

要求：
1. 先写一个能稳定失败的测试（或最小复现脚本）。
2. 用两三句话说明根因，再给出最小修复。
3. 运行相关测试和类型检查，确认修复且没有引入回归。
4. 不做无关重构；如果根因涉及更大的设计问题，先停下说明。
5. 最后总结根因、改动和验证结果。`;

const reviewBody = `请审查以下范围的改动：{{审查范围}}
重点关注：{{重点关注}}

要求：
- 逐个文件阅读 diff 和必要上下文，不要只看改动片段。
- 按严重程度列出问题，每条给出 file:line、触发条件、实际后果；没有把握的标注为「待确认」。
- 重点检查：正确性、边界条件、并发/异步错误、资源清理、鉴权与敏感信息、回归风险。
- 不要为了凑数报风格问题；风格问题放在最后单独一节。
- 最后给出是否可以合并的结论和必须修复项。`;

const testBody = `请为 {{目标模块}} 补充测试。

测试命令：{{测试命令}}
重点场景：{{重点场景}}

要求：
- 先阅读现有测试，沿用同样的框架、命名和断言风格。
- 覆盖正常路径、边界条件、错误路径和回归风险；不要重复已有用例。
- 测试必须是确定性的：不依赖真实网络、当前时间、执行顺序或用户环境。
- 运行测试命令，确认新增用例通过且没有破坏原有测试。
- 总结新增了哪些用例、为什么选这些场景。`;

const onboardingBody = `请带我快速上手这个仓库：{{想了解的问题}}
关注目录：{{关注目录}}

要求：
- 先不要改任何文件。阅读 README、构建脚本、入口文件和关键模块，画出模块关系与主要数据流。
- 说明本地如何启动、如何跑测试、常见的坑。
- 找出 3 个最值得先读的文件，并解释原因。
- 最后用一条最小命令验证你给出的启动方式确实可用；如果不可用，说明卡在哪里。`;

export const builtinPromptTemplates: PromptTemplate[] = [
  {
    id: 'builtin-ralph-loop',
    title: 'Ralph 循环',
    description: '按验收命令反复迭代，直到通过或到轮次上限',
    icon: 'repeat',
    body: ralphBody,
    builtin: true,
    fields: [
      { key: '目标', label: '要达成的目标', placeholder: '例如：让 pnpm test 全绿，并保持现有 API 不变', multiline: true },
      { key: '验收命令', label: '验收命令', placeholder: '例如：pnpm test && pnpm typecheck', defaultValue: 'pnpm test' },
      { key: '轮次上限', label: '轮次上限', defaultValue: '10' }
    ]
  },
  {
    id: 'builtin-feature',
    title: '新功能',
    description: '从需求到可验证的最小增量实现',
    icon: 'sparkles',
    body: featureBody,
    builtin: true,
    fields: [
      { key: '需求', label: '要实现什么', placeholder: '描述用户可见的行为和输入输出', multiline: true },
      { key: '验收标准', label: '怎么算完成', placeholder: '可观察、可测试的验收条件', multiline: true },
      { key: '约束', label: '约束（可选）', placeholder: '例如：不改公开 API、不引入新依赖', defaultValue: '无特殊约束', optional: true }
    ]
  },
  {
    id: 'builtin-bug',
    title: '修 Bug',
    description: '先复现，再定位根因，最后用测试锁住',
    icon: 'bug',
    body: bugBody,
    builtin: true,
    fields: [
      { key: '现象', label: '出了什么问题', placeholder: '一句话描述实际行为', multiline: true },
      { key: '复现步骤', label: '怎么复现', placeholder: '1. …\n2. …\n3. …', multiline: true },
      { key: '期望结果', label: '期望结果', placeholder: '正确时应该发生什么', multiline: true },
      { key: '错误日志', label: '错误日志 / 堆栈（可选）', placeholder: '粘贴完整堆栈，不要截断', multiline: true, optional: true }
    ]
  },
  {
    id: 'builtin-review',
    title: '代码审查',
    description: '按清单审查 diff，给出带文件行号的发现',
    icon: 'review',
    body: reviewBody,
    builtin: true,
    fields: [
      { key: '审查范围', label: '审查范围', placeholder: '例如：git diff main...HEAD', defaultValue: 'git diff main...HEAD' },
      { key: '重点关注', label: '重点关注（可选）', placeholder: '例如：并发、鉴权、错误处理', defaultValue: '正确性、边界条件、回归风险', optional: true }
    ]
  },
  {
    id: 'builtin-test',
    title: '补测试',
    description: '为目标模块补齐关键路径和边界用例',
    icon: 'test',
    body: testBody,
    builtin: true,
    fields: [
      { key: '目标模块', label: '目标模块 / 文件', placeholder: '例如：packages/storage/src/index.ts', multiline: true },
      { key: '测试命令', label: '测试命令', defaultValue: 'pnpm test' },
      { key: '重点场景', label: '重点场景（可选）', placeholder: '例如：空输入、并发写入、失败重试', defaultValue: '正常路径、边界条件、错误路径', optional: true }
    ]
  },
  {
    id: 'builtin-onboarding',
    title: '项目上手',
    description: '先画出代码地图，再做一次最小验证',
    icon: 'compass',
    body: onboardingBody,
    builtin: true,
    fields: [
      { key: '想了解的问题', label: '想了解什么', placeholder: '例如：一次请求从入口到存储经过了哪些模块？', multiline: true },
      { key: '关注目录', label: '关注目录（可选）', placeholder: '例如：apps/server/src', defaultValue: '整个仓库', optional: true }
    ]
  }
];

/** 按出现顺序提取 `{{变量}}`，重复的只保留一次。 */
export function extractTemplateFields(body: string): PromptTemplateField[] {
  const seen = new Set<string>();
  const fields: PromptTemplateField[] = [];
  for (const match of body.matchAll(/\{\{\s*([^{}]+?)\s*\}\}/g)) {
    const key = match[1]!.trim();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    fields.push({ key, label: key, multiline: true });
  }
  return fields;
}

/**
 * 把变量填进模板。所有变量都是可选的：没填的保留 `{{变量}}` 占位，
 * 让用户能在输入框里直接看到还差什么，而不是被必填校验挡在表单里。
 */
export function applyPromptTemplate(template: PromptTemplate, values: Record<string, string>): string {
  return template.body.replace(/\{\{\s*([^{}]+?)\s*\}\}/g, (_match, rawKey: string) => {
    const key = rawKey.trim();
    return values[key]?.trim() || `{{${key}}}`;
  });
}

/** localStorage 是外部输入：只接受结构正确的条目，长度也在这里收口。 */
export function parseCustomTemplates(raw: string | null | undefined): PromptTemplate[] {
  if (!raw) return [];
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { return []; }
  if (!Array.isArray(parsed)) return [];
  const result: PromptTemplate[] = [];
  const ids = new Set<string>();
  for (const value of parsed) {
    if (!value || typeof value !== 'object') continue;
    const record = value as Record<string, unknown>;
    if (typeof record.id !== 'string' || !record.id.trim() || ids.has(record.id)) continue;
    if (typeof record.title !== 'string' || !record.title.trim()) continue;
    if (typeof record.body !== 'string' || !record.body.trim()) continue;
    const title = record.title.trim().slice(0, MAX_TITLE);
    const description = typeof record.description === 'string' && record.description.trim()
      ? record.description.trim().slice(0, MAX_DESCRIPTION)
      : '自定义提示词模板';
    const body = record.body.slice(0, MAX_BODY);
    ids.add(record.id);
    result.push({
      id: record.id, title, description, body, icon: 'custom', builtin: false,
      fields: extractTemplateFields(body)
    });
    if (result.length >= MAX_CUSTOM_TEMPLATES) break;
  }
  return result;
}

export function serializeCustomTemplates(templates: PromptTemplate[]): string {
  return JSON.stringify(templates.map(template => ({
    id: template.id,
    title: template.title.slice(0, MAX_TITLE),
    description: template.description.slice(0, MAX_DESCRIPTION),
    body: template.body.slice(0, MAX_BODY)
  })));
}

export interface CustomTemplateInput {
  title: string;
  description: string;
  body: string;
}

export function customTemplateFromInput(input: CustomTemplateInput, id?: string): PromptTemplate {
  const title = input.title.trim().slice(0, MAX_TITLE);
  const body = input.body.trim().slice(0, MAX_BODY);
  if (!title) throw new Error('模板名称不能为空');
  if (!body) throw new Error('模板内容不能为空');
  return {
    id: id ?? `custom_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
    title,
    description: input.description.trim().slice(0, MAX_DESCRIPTION) || '自定义提示词模板',
    icon: 'custom',
    body,
    builtin: false,
    fields: extractTemplateFields(body)
  };
}

export function loadCustomTemplates(): PromptTemplate[] {
  try {
    return parseCustomTemplates(window.localStorage.getItem(PROMPT_TEMPLATE_STORAGE_KEY));
  } catch { return []; }
}

export function saveCustomTemplates(templates: PromptTemplate[]): void {
  try {
    window.localStorage.setItem(PROMPT_TEMPLATE_STORAGE_KEY, serializeCustomTemplates(templates));
  } catch { /* 隐私模式或存储已满：本次会话内仍然可用 */ }
}
