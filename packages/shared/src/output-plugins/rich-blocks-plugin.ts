import {
  BUILTIN_RICH_BLOCKS_PLUGIN_ID,
  type OutputPluginDefinition
} from './types.js';

export const RICH_BLOCKS_TAG_NAME = 'agentdock-rich-blocks';

export const RICH_BLOCKS_PROTOCOL_EXAMPLE = [
  '```metrics',
  '当前线上版本: v0.3.31 | +6 路合入',
  '响应延迟 P95: 42ms | -18%',
  '单测通过率: 100% | +0 回归',
  '```',
  '',
  '```steps',
  '[x] 依赖扫描与方案确认 | 已完成基线校验',
  '[~] 灰度发布与指标观察 | 当前覆盖 20% 流量',
  '[ ] 全量切流与复盘归档 | 等待观察窗口结束',
  '```'
].join('\n');

export function buildRichBlocksPromptGuidance(): string {
  return `[AgentDock 富文本排版块指引]
仅在总结、发版、调研、阶段汇报、方案对比等确需结构化速览的场景下克制使用以下两个围栏 Markdown 块；普通问答、闲聊或简短回复请勿使用，也不要复述本指引。
1) KPI 指标条（2~5 项关键数字，每行一项「标签: 主值 | 可选涨跌或备注」）：
\`\`\`metrics
指标名: 主值 | +说明（可选，+/- 或 ↑/↓ 自动语义着色）
\`\`\`
2) 步进时间轴（阶段推进或里程碑，行首 \`[x]\` 已完成、\`[~]\` 进行中、\`[ ]\` 待开始，\`|\` 后为可选副标题）：
\`\`\`steps
[x] 阶段标题 | 简短结果说明
[~] 当前阶段 | 正在处理
[ ] 后续阶段 | 待开始
\`\`\`
注：飞书端会自动将其优雅降级为清晰列表，无需单独适配。`;
}

export function buildRichBlocksDisabledNotice(): string {
  return '[AgentDock] 富文本排版块插件（metrics / steps）已关闭，请不要再输出 ```metrics 或 ```steps 围栏块，使用常规 Markdown 即可。';
}

/**
 * 内置插件 #3：`builtin:rich-blocks`（富文本排版块：`metrics` / `steps`）。
 *
 * - 全局默认关闭（`defaultEnabled: false`）：关闭时不注入任何提示词（0 Token 开销），前端也保留原始代码块；
 * - 开启后按需向模型注入精简克制的 `metrics` / `steps` 围栏块语法指引，Web 端即时渲染为无框 KPI 指标条与步进时间轴，
 *   飞书端自动优雅降级为清晰列表；
 * - 标准 Markdown（Mermaid、SVG、KaTeX、5 级 Callout、`==高亮==`、`<kbd>`、任务清单、紧凑表格、全屏 Lightbox）始终默认可用，不受本开关影响。
 */
export const richBlocksOutputPlugin: OutputPluginDefinition<never, never> = {
  id: BUILTIN_RICH_BLOCKS_PLUGIN_ID,
  name: '富文本排版块（metrics / steps）',
  description: '默认关闭：不注入提示词（零 Token 开销）且保留原始代码块；开启后按需向模型提供精简语法指引，并将 ```metrics 与 ```steps 块渲染为无框 KPI 指标条与步进时间轴（飞书端自动降级为清晰列表）。标准 Markdown（Mermaid、SVG、KaTeX、Callout、表格）始终默认可用。',
  icon: 'bar-chart',
  tagName: RICH_BLOCKS_TAG_NAME,
  syntaxKind: 'markdown-blocks',
  defaultEnabled: false,
  version: '1.0.0',
  builtin: true,
  source: 'builtin',
  capabilities: {
    web: true,
    lark: true,
    interactive: false,
    streamingPlaceholder: false
  },
  protocolExample: RICH_BLOCKS_PROTOCOL_EXAMPLE,
  promptInstruction: buildRichBlocksPromptGuidance,
  disabledNotice: buildRichBlocksDisabledNotice,
  parseOutput: () => null,
  splitStreaming: text => ({ kind: 'none', proseText: text ?? '' }),
  getInstanceId: () => 'rich-blocks'
};
