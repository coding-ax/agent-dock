import type { Locale } from '@agent-dock/agent-dock-shared';
import type { LlmAssistAction, LlmAssistMode } from './api';
import { bi, getCurrentLocale } from './i18n';

export const LLM_UNCONFIGURED_TOOLTIP = '配置 LLM 模型端点后即可使用 AI 辅助写作与优化（前往 设置 → Agent 与能力 → 模型端点）';

export function getLlmUnconfiguredTooltip(locale: Locale = getCurrentLocale()): string {
  return bi(
    LLM_UNCONFIGURED_TOOLTIP,
    'Configure an LLM endpoint to enable AI writing & polish (Settings → Agents & Capabilities → Model Endpoints)',
    locale
  );
}

export const MAX_AI_UNDO_STEPS = 20;

export interface AiTextUndoEntry {
  value: string;
  label?: string;
  timestamp: number;
}

export interface AiTextUndoState {
  stack: AiTextUndoEntry[];
  lastAppliedLabel?: string;
}

export function createAiTextUndoState(): AiTextUndoState {
  return { stack: [] };
}

/**
 * 写入 AI 新文本前压入原值快照。
 * 若新旧值完全相同则不入栈，避免污染多步回撤历史。
 */
export function pushAiTextSnapshot(
  state: AiTextUndoState,
  previousValue: string,
  nextValue: string,
  label?: string,
  timestamp = Date.now()
): AiTextUndoState {
  if (previousValue === nextValue) return state;
  const entry: AiTextUndoEntry = {
    value: previousValue,
    ...(label ? { label } : {}),
    timestamp
  };
  const nextStack = [...state.stack, entry].slice(-MAX_AI_UNDO_STEPS);
  return {
    stack: nextStack,
    ...(label ? { lastAppliedLabel: label } : {})
  };
}

/** 弹出最近一条快照并返回恢复值；空栈时返回 restored: undefined。 */
export function popAiTextSnapshot(state: AiTextUndoState): {
  state: AiTextUndoState;
  restored?: AiTextUndoEntry;
} {
  if (state.stack.length === 0) return { state };
  const restored = state.stack[state.stack.length - 1]!;
  const remaining = state.stack.slice(0, -1);
  const previousTop = remaining[remaining.length - 1];
  return {
    state: {
      stack: remaining,
      ...(previousTop?.label ? { lastAppliedLabel: previousTop.label } : {})
    },
    restored
  };
}

export interface AiAssistPreset {
  id: string;
  label: string;
  description: string;
  mode: LlmAssistMode;
  action: LlmAssistAction;
  resultLabel?: string;
}

export interface AiModeMeta {
  title: string;
  emptyButtonLabel: string;
  filledButtonLabel: string;
  placeholder: string;
  busyText: string;
  allowEmptyRun: boolean;
  /** 面板中可切换的关联模式（如 写 Prompt <-> 润色优化） */
  switchableModes?: Array<{ mode: LlmAssistMode; label: string }>;
}

export function getAiModeMeta(mode: LlmAssistMode, locale: Locale = getCurrentLocale()): AiModeMeta {
  switch (mode) {
    case 'prompt_write':
      return {
        title: bi('AI 写 / 优化提示词', 'AI Write / Polish Prompt', locale),
        emptyButtonLabel: bi('AI 帮写', 'AI Write', locale),
        filledButtonLabel: bi('AI 优化', 'AI Polish', locale),
        placeholder: bi('输入一句话需求，例如：帮我写发布前回归检查提示词…', 'Describe what you need, e.g. pre-release checklist prompt…', locale),
        busyText: bi('正在构思并生成提示词…', 'Drafting prompt…', locale),
        allowEmptyRun: true,
        switchableModes: [
          { mode: 'prompt_write', label: bi('AI 写 Prompt', 'Draft prompt', locale) },
          { mode: 'prompt_optimize', label: bi('AI 优化润色', 'Polish prompt', locale) }
        ]
      };
    case 'prompt_optimize':
      return {
        title: bi('AI 优化提示词', 'AI Polish Prompt', locale),
        emptyButtonLabel: bi('AI 帮写', 'AI Write', locale),
        filledButtonLabel: bi('AI 优化', 'AI Polish', locale),
        placeholder: bi('补充优化要求（可选），例如：更简洁、突出验收清单…', 'Optional instructions, e.g. more concise, highlight checklist…', locale),
        busyText: bi('正在润色并优化结构…', 'Polishing & structuring…', locale),
        allowEmptyRun: false,
        switchableModes: [
          { mode: 'prompt_optimize', label: bi('AI 优化润色', 'Polish prompt', locale) },
          { mode: 'prompt_write', label: bi('AI 从零起草', 'Draft new', locale) }
        ]
      };
    case 'message_polish':
      return {
        title: bi('AI 润色与帮写', 'AI Polish & Write', locale),
        emptyButtonLabel: bi('AI 帮写', 'AI Write', locale),
        filledButtonLabel: bi('AI 润色', 'AI Polish', locale),
        placeholder: bi('输入一句话需求，Enter 帮你写成清晰条理的消息…', 'Describe your message, press Enter to draft clearly…', locale),
        busyText: bi('正在润色清晰表达…', 'Polishing message…', locale),
        allowEmptyRun: false,
        switchableModes: [
          { mode: 'message_polish', label: bi('润色消息', 'Polish message', locale) },
          { mode: 'prompt_write', label: bi('写成 Prompt', 'As prompt', locale) }
        ]
      };
    case 'title_generate':
      return {
        title: bi('AI 生成标题', 'AI Generate Title', locale),
        emptyButtonLabel: bi('AI 生成标题', 'AI Title', locale),
        filledButtonLabel: bi('AI 重生成标题', 'Regenerate Title', locale),
        placeholder: bi('可选：指定风格或重点，例如：偏技术排查、突出版本…', 'Optional: style or focus, e.g. technical triage, highlight version…', locale),
        busyText: bi('正在提炼精准标题…', 'Generating title…', locale),
        allowEmptyRun: true
      };
    case 'regex_generate':
      return {
        title: bi('AI 生成正则表达式', 'AI Generate Regex', locale),
        emptyButtonLabel: bi('AI 写正则', 'AI Regex', locale),
        filledButtonLabel: bi('AI 优化正则', 'AI Polish Regex', locale),
        placeholder: bi('描述匹配规则，例如：命中“告警/报错/P0”且忽略大小写…', 'Describe match rule, e.g. match "alert/error/P0" case-insensitively…', locale),
        busyText: bi('正在生成并校验正则…', 'Generating & validating regex…', locale),
        allowEmptyRun: true
      };
    case 'description_polish':
      return {
        title: bi('AI 撰写 / 优化文案', 'AI Write / Polish Copy', locale),
        emptyButtonLabel: bi('AI 帮写', 'AI Write', locale),
        filledButtonLabel: bi('AI 优化', 'AI Polish', locale),
        placeholder: bi('输入要点或要求，Enter 生成精炼文案…', 'Enter key points, press Enter for concise copy…', locale),
        busyText: bi('正在撰写精炼文案…', 'Writing concise copy…', locale),
        allowEmptyRun: true
      };
  }
}

export function getAiAssistPresets(mode: LlmAssistMode, hasText: boolean, locale: Locale = getCurrentLocale()): AiAssistPreset[] {
  if (mode === 'regex_generate') {
    return hasText
      ? [
          { id: 'regex-opt', label: bi('优化清晰', 'Improve clarity', locale), description: bi('简化并加固现有正则，避免误伤与回溯', 'Simplify and harden the regex to avoid false matches and backtracking', locale), mode: 'regex_generate', action: 'optimize', resultLabel: bi('已优化清晰', 'Clarity improved', locale) },
          { id: 'regex-gen', label: bi('按上下文重写', 'Rewrite from context', locale), description: bi('结合群名与示例消息重新生成安全正则', 'Regenerate a safe regex from group name and sample messages', locale), mode: 'regex_generate', action: 'generate', resultLabel: bi('已重写', 'Rewritten', locale) }
        ]
      : [
          { id: 'regex-gen', label: bi('根据示例生成', 'Generate from samples', locale), description: bi('结合上下文和示例消息自动生成安全正则', 'Generate a safe regex from context and sample messages', locale), mode: 'regex_generate', action: 'generate', resultLabel: bi('已根据示例生成', 'Generated', locale) }
        ];
  }

  if (mode === 'title_generate') {
    return [
      { id: 'title-gen', label: hasText ? bi('重新提炼标题', 'Regenerate title', locale) : bi('智能生成标题', 'Generate title', locale), description: bi('结合上下文提炼简短直观的中文标题', 'Distill a short, clear title from context', locale), mode: 'title_generate', action: 'generate', resultLabel: hasText ? bi('已重新提炼标题', 'Title regenerated', locale) : bi('已智能生成标题', 'Title generated', locale) },
      { id: 'title-concise', label: bi('更简短精炼', 'Make shorter', locale), description: bi('压缩为 6–12 字的紧凑短标题', 'Compress into a tight, punchy title', locale), mode: 'title_generate', action: 'concise', resultLabel: bi('已更简短精炼', 'Shortened', locale) }
    ];
  }

  if (!hasText) {
    if (mode === 'prompt_write' || mode === 'prompt_optimize') {
      return [
        { id: 'prompt-write', label: bi('按场景自动起草', 'Auto-draft', locale), description: bi('结合当前上下文生成可直接使用的结构化 Prompt', 'Generate a ready-to-use structured prompt from context', locale), mode: 'prompt_write', action: 'write', resultLabel: bi('已自动起草', 'Drafted', locale) },
        { id: 'prompt-concise', label: bi('写一版极简提示词', 'Minimal draft', locale), description: bi('短小克制，适合作为轻量约束', 'Brief and restrained, ideal for lightweight rules', locale), mode: 'prompt_write', action: 'concise', resultLabel: bi('已写一版极简提示词', 'Minimal draft ready', locale) }
      ];
    }
    if (mode === 'description_polish') {
      return [
        { id: 'desc-write', label: bi('按上下文自动生成', 'Auto-generate', locale), description: bi('根据已有标题与场景自动起草简短说明', 'Draft a concise description from the title and context', locale), mode: 'description_polish', action: 'write', resultLabel: bi('已自动生成', 'Generated', locale) }
      ];
    }
    // message_polish 空输入时不提供空跑预设，直接引导在输入框敲一句话回车生成
    return [];
  }

  if (mode === 'prompt_write' || mode === 'prompt_optimize') {
    return [
      { id: 'opt', label: bi('优化清晰', 'Improve clarity', locale), description: bi('理顺逻辑、补齐边界，保留 {{变量}}', 'Clarify logic and edge cases while keeping {{variables}}', locale), mode: 'prompt_optimize', action: 'optimize', resultLabel: bi('已优化清晰', 'Polished', locale) },
      { id: 'concise', label: bi('精简提炼', 'Make concise', locale), description: bi('压缩冗余措辞，提高信息密度', 'Cut redundancy and tighten phrasing', locale), mode: 'prompt_optimize', action: 'concise', resultLabel: bi('已精简提炼', 'Condensed', locale) },
      { id: 'structure', label: bi('结构化展开', 'Structure', locale), description: bi('按目标/约束/步骤/输出清晰分层', 'Organize into clear goals, constraints, steps, and output', locale), mode: 'prompt_optimize', action: 'structure', resultLabel: bi('已结构化展开', 'Structured', locale) }
    ];
  }

  if (mode === 'description_polish') {
    return [
      { id: 'opt', label: bi('优化清晰', 'Improve clarity', locale), description: bi('润色表达，精炼易读', 'Polish phrasing for readability', locale), mode: 'description_polish', action: 'optimize', resultLabel: bi('已优化清晰', 'Polished', locale) },
      { id: 'concise', label: bi('精简提炼', 'Make concise', locale), description: bi('收拢为一句话核心说明', 'Condense into a single core sentence', locale), mode: 'description_polish', action: 'concise', resultLabel: bi('已精简提炼', 'Condensed', locale) },
      { id: 'structure', label: bi('分点整理', 'Bullet list', locale), description: bi('整理成条理清晰的要点清单', 'Format as a clear bulleted list', locale), mode: 'description_polish', action: 'structure', resultLabel: bi('已分点整理', 'Formatted', locale) }
    ];
  }

  // message_polish with text
  return [
    { id: 'opt', label: bi('优化清晰', 'Improve clarity', locale), description: bi('消除口语含糊，准确传达诉求', 'Remove ambiguity and state your request clearly', locale), mode: 'message_polish', action: 'optimize', resultLabel: bi('已优化清晰', 'Polished', locale) },
    { id: 'concise', label: bi('精简提炼', 'Make concise', locale), description: bi('浓缩成直击重点的简短表达', 'Condense to a brief, direct message', locale), mode: 'message_polish', action: 'concise', resultLabel: bi('已精简提炼', 'Condensed', locale) },
    { id: 'structure', label: bi('结构化展开', 'Structure', locale), description: bi('拆分为清晰的背景/目标/要求清单', 'Break down into clear context, goals, and requirements', locale), mode: 'message_polish', action: 'structure', resultLabel: bi('已结构化展开', 'Structured', locale) }
  ];
}

export interface PopoverRect {
  top: number;
  bottom: number;
  left: number;
  right: number;
  width: number;
  height: number;
}

export function placeAiPopover(
  anchor: PopoverRect,
  popover: { width: number; height: number },
  viewport: { width: number; height: number },
  preferred: { side?: 'top' | 'bottom'; align?: 'start' | 'end' } = {}
): { top: number; left: number; side: 'top' | 'bottom'; maxWidth: number } {
  const margin = 8;
  const gap = 8;
  const maxWidth = Math.max(240, Math.min(popover.width, viewport.width - margin * 2));
  const preferredSide = preferred.side ?? 'bottom';
  const preferredAlign = preferred.align ?? 'end';

  const spaceBelow = viewport.height - anchor.bottom - gap - margin;
  const spaceAbove = anchor.top - gap - margin;
  let side: 'top' | 'bottom' = preferredSide;
  if (preferredSide === 'bottom' && spaceBelow < popover.height && spaceAbove > spaceBelow) {
    side = 'top';
  } else if (preferredSide === 'top' && spaceAbove < popover.height && spaceBelow > spaceAbove) {
    side = 'bottom';
  }

  const rawTop = side === 'bottom' ? anchor.bottom + gap : anchor.top - gap - popover.height;
  const top = Math.max(margin, Math.min(rawTop, Math.max(margin, viewport.height - popover.height - margin)));

  const rawLeft = preferredAlign === 'start' ? anchor.left : anchor.right - maxWidth;
  const left = Math.max(margin, Math.min(rawLeft, Math.max(margin, viewport.width - maxWidth - margin)));

  return { top, left, side, maxWidth };
}
