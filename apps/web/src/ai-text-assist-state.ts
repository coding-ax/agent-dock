import type { LlmAssistAction, LlmAssistMode } from './api';

export const LLM_UNCONFIGURED_TOOLTIP = '配置 LLM 模型端点后即可使用 AI 辅助写作与优化（前往 设置 → Agent 设置 → 模型端点）';

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

export function getAiModeMeta(mode: LlmAssistMode): AiModeMeta {
  switch (mode) {
    case 'prompt_write':
      return {
        title: 'AI 写 / 优化提示词',
        emptyButtonLabel: 'AI 帮写',
        filledButtonLabel: 'AI 优化',
        placeholder: '输入一句话需求，例如：帮我写发布前回归检查提示词…',
        busyText: '正在构思并生成提示词…',
        allowEmptyRun: true,
        switchableModes: [
          { mode: 'prompt_write', label: 'AI 写 Prompt' },
          { mode: 'prompt_optimize', label: 'AI 优化润色' }
        ]
      };
    case 'prompt_optimize':
      return {
        title: 'AI 优化提示词',
        emptyButtonLabel: 'AI 帮写',
        filledButtonLabel: 'AI 优化',
        placeholder: '补充优化要求（可选），例如：更简洁、突出验收清单…',
        busyText: '正在润色并优化结构…',
        allowEmptyRun: false,
        switchableModes: [
          { mode: 'prompt_optimize', label: 'AI 优化润色' },
          { mode: 'prompt_write', label: 'AI 从零起草' }
        ]
      };
    case 'message_polish':
      return {
        title: 'AI 润色与帮写',
        emptyButtonLabel: 'AI 帮写',
        filledButtonLabel: 'AI 润色',
        placeholder: '输入一句话需求，Enter 帮你写成清晰条理的消息…',
        busyText: '正在润色清晰表达…',
        allowEmptyRun: false,
        switchableModes: [
          { mode: 'message_polish', label: '润色消息' },
          { mode: 'prompt_write', label: '写成 Prompt' }
        ]
      };
    case 'title_generate':
      return {
        title: 'AI 生成标题',
        emptyButtonLabel: 'AI 生成标题',
        filledButtonLabel: 'AI 重生成标题',
        placeholder: '可选：指定风格或重点，例如：偏技术排查、突出版本…',
        busyText: '正在提炼精准标题…',
        allowEmptyRun: true
      };
    case 'regex_generate':
      return {
        title: 'AI 生成正则表达式',
        emptyButtonLabel: 'AI 写正则',
        filledButtonLabel: 'AI 优化正则',
        placeholder: '描述匹配规则，例如：命中“告警/报错/P0”且忽略大小写…',
        busyText: '正在生成并校验正则…',
        allowEmptyRun: true
      };
    case 'description_polish':
      return {
        title: 'AI 撰写 / 优化文案',
        emptyButtonLabel: 'AI 帮写',
        filledButtonLabel: 'AI 优化',
        placeholder: '输入要点或要求，Enter 生成精炼文案…',
        busyText: '正在撰写精炼文案…',
        allowEmptyRun: true
      };
  }
}

export function getAiAssistPresets(mode: LlmAssistMode, hasText: boolean): AiAssistPreset[] {
  if (mode === 'regex_generate') {
    return hasText
      ? [
          { id: 'regex-opt', label: '优化清晰', description: '简化并加固现有正则，避免误伤与回溯', mode: 'regex_generate', action: 'optimize' },
          { id: 'regex-gen', label: '按上下文重写', description: '结合群名与示例消息重新生成安全正则', mode: 'regex_generate', action: 'generate' }
        ]
      : [
          { id: 'regex-gen', label: '根据示例生成', description: '结合上下文和示例消息自动生成安全正则', mode: 'regex_generate', action: 'generate' }
        ];
  }

  if (mode === 'title_generate') {
    return [
      { id: 'title-gen', label: hasText ? '重新提炼标题' : '智能生成标题', description: '结合上下文提炼简短直观的中文标题', mode: 'title_generate', action: 'generate' },
      { id: 'title-concise', label: '更简短精炼', description: '压缩为 6–12 字的紧凑短标题', mode: 'title_generate', action: 'concise' }
    ];
  }

  if (!hasText) {
    if (mode === 'prompt_write' || mode === 'prompt_optimize') {
      return [
        { id: 'prompt-write', label: '按场景自动起草', description: '结合当前上下文生成可直接使用的结构化 Prompt', mode: 'prompt_write', action: 'write' },
        { id: 'prompt-concise', label: '写一版极简提示词', description: '短小克制，适合作为轻量约束', mode: 'prompt_write', action: 'concise' }
      ];
    }
    if (mode === 'description_polish') {
      return [
        { id: 'desc-write', label: '按上下文自动生成', description: '根据已有标题与场景自动起草简短说明', mode: 'description_polish', action: 'write' }
      ];
    }
    // message_polish 空输入时不提供空跑预设，直接引导在输入框敲一句话回车生成
    return [];
  }

  if (mode === 'prompt_write' || mode === 'prompt_optimize') {
    return [
      { id: 'opt', label: '优化清晰', description: '理顺逻辑、补齐边界，保留 {{变量}}', mode: 'prompt_optimize', action: 'optimize' },
      { id: 'concise', label: '精简提炼', description: '压缩冗余措辞，提高信息密度', mode: 'prompt_optimize', action: 'concise' },
      { id: 'structure', label: '结构化展开', description: '按目标/约束/步骤/输出清晰分层', mode: 'prompt_optimize', action: 'structure' }
    ];
  }

  if (mode === 'description_polish') {
    return [
      { id: 'opt', label: '优化清晰', description: '润色表达，精炼易读', mode: 'description_polish', action: 'optimize' },
      { id: 'concise', label: '精简提炼', description: '收拢为一句话核心说明', mode: 'description_polish', action: 'concise' },
      { id: 'structure', label: '分点整理', description: '整理成条理清晰的要点清单', mode: 'description_polish', action: 'structure' }
    ];
  }

  // message_polish with text
  return [
    { id: 'opt', label: '优化清晰', description: '消除口语含糊，准确传达诉求', mode: 'message_polish', action: 'optimize' },
    { id: 'concise', label: '精简提炼', description: '浓缩成直击重点的简短表达', mode: 'message_polish', action: 'concise' },
    { id: 'structure', label: '结构化展开', description: '拆分为清晰的背景/目标/要求清单', mode: 'message_polish', action: 'structure' }
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
