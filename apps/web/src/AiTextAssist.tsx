import {
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type MouseEvent,
  type ReactNode
} from 'react';
import { createPortal } from 'react-dom';
import { QueryClient, QueryClientContext, useQuery } from '@tanstack/react-query';
import { AlertCircle, ArrowUp, Check, RotateCcw, Sparkles, Undo2, Wand2, X } from 'lucide-react';
import {
  api,
  type LlmAssistAction,
  type LlmAssistContext,
  type LlmAssistMode,
  type LlmAssistResult,
  type LlmEndpointState,
  type LlmFormat
} from './api';
import { ExitGate } from './ExitGate';
import { HoverTooltip } from './HoverTooltip';
import { SlidingSegmented } from './ui-controls';
import {
  LLM_UNCONFIGURED_TOOLTIP,
  createAiTextUndoState,
  getAiAssistPresets,
  getAiModeMeta,
  placeAiPopover,
  popAiTextSnapshot,
  pushAiTextSnapshot,
  type AiTextUndoEntry,
  type AiTextUndoState
} from './ai-text-assist-state';

export {
  LLM_UNCONFIGURED_TOOLTIP,
  createAiTextUndoState,
  getAiAssistPresets,
  getAiModeMeta,
  placeAiPopover,
  popAiTextSnapshot,
  pushAiTextSnapshot,
  type AiAssistPreset,
  type AiTextUndoEntry,
  type AiTextUndoState
} from './ai-text-assist-state';

/** 默认客户端超时略长于服务端，给慢推理模型留足响应余量。 */
const DEFAULT_ASSIST_TIMEOUT_MS = 90_000;

export interface LlmAvailability {
  configured: boolean;
  loading: boolean;
  model?: string;
  format?: LlmFormat;
  state?: LlmEndpointState;
}

/** 孤立单测未包 QueryClientProvider 时的静默兜底实例，不发起任何请求。 */
const fallbackLlmQueryClient = new QueryClient();

/**
 * 全局复用 React Query `['llm']` 缓存，读取当前 LLM 模型端点配置状态。
 * 与 LlmEndpointPanel 共用同一 queryKey：保存或清除端点后全站所有 AI 辅助按钮同步刷新。
 */
export function useLlmAvailability(): LlmAvailability {
  const contextClient = useContext(QueryClientContext);
  const query = useQuery({
    queryKey: ['llm'],
    queryFn: api.llm,
    enabled: Boolean(contextClient),
    staleTime: 60_000,
    refetchOnWindowFocus: false,
    retry: false
  }, contextClient ?? fallbackLlmQueryClient);
  return {
    configured: Boolean(query.data?.configured),
    loading: query.isLoading,
    model: query.data?.model,
    format: query.data?.format,
    state: query.data
  };
}

/**
 * AI 写入瞬间的柔和 highlight-flash 高亮过渡 Hook（严格尊重 prefers-reduced-motion）。
 */
export function useAiFlash(durationMs = 840) {
  const [flashing, setFlashing] = useState(false);
  const timerRef = useRef<number | null>(null);
  const frameRef = useRef<number | null>(null);

  const clearTimers = useCallback(() => {
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    if (frameRef.current !== null) {
      window.cancelAnimationFrame(frameRef.current);
      frameRef.current = null;
    }
  }, []);

  useEffect(() => clearTimers, [clearTimers]);

  const triggerFlash = useCallback(() => {
    clearTimers();
    setFlashing(false);
    frameRef.current = window.requestAnimationFrame(() => {
      frameRef.current = null;
      setFlashing(true);
      timerRef.current = window.setTimeout(() => {
        timerRef.current = null;
        setFlashing(false);
      }, durationMs);
    });
  }, [clearTimers, durationMs]);

  return {
    flashing,
    flashClass: flashing ? 'ui-ai-flash' : '',
    triggerFlash
  };
}

export interface UseUndoableAiTextOptions {
  value: string;
  getValue?: () => string;
  onChange: (nextValue: string) => void;
  onUndo?: (previousValue: string) => void | Promise<void>;
  resetKey?: string | number;
}

/**
 * 可多步回撤的 AI 文本写入 Hook。
 * 每次写入 AI 文本前压入原值快照，支持无损一键/多步回撤，并附带高亮闪烁状态。
 */
export function useUndoableAiText({
  value,
  getValue,
  onChange,
  onUndo,
  resetKey
}: UseUndoableAiTextOptions) {
  const [undoState, setUndoState] = useState<AiTextUndoState>(createAiTextUndoState);
  const undoStateRef = useRef<AiTextUndoState>(undoState);
  undoStateRef.current = undoState;
  const [undoing, setUndoing] = useState(false);
  const flash = useAiFlash();

  const latestRef = useRef({ value, getValue, onChange, onUndo });
  latestRef.current = { value, getValue, onChange, onUndo };

  const prevResetKey = useRef(resetKey);
  useEffect(() => {
    if (prevResetKey.current === resetKey) return;
    prevResetKey.current = resetKey;
    const cleared = createAiTextUndoState();
    undoStateRef.current = cleared;
    setUndoState(cleared);
  }, [resetKey]);

  const applyAiText = useCallback((
    nextValue: string,
    options?: { previousValue?: string; label?: string; skipOnChange?: boolean }
  ) => {
    const previousValue = options?.previousValue ?? latestRef.current.getValue?.() ?? latestRef.current.value;
    const nextState = pushAiTextSnapshot(undoStateRef.current, previousValue, nextValue, options?.label);
    undoStateRef.current = nextState;
    setUndoState(nextState);
    if (!options?.skipOnChange) {
      latestRef.current.onChange(nextValue);
    }
    flash.triggerFlash();
  }, [flash.triggerFlash]);

  const undo = useCallback(async (): Promise<AiTextUndoEntry | undefined> => {
    const { state: nextState, restored } = popAiTextSnapshot(undoStateRef.current);
    if (!restored) return undefined;
    undoStateRef.current = nextState;
    setUndoState(nextState);
    setUndoing(true);
    try {
      if (latestRef.current.onUndo) {
        await latestRef.current.onUndo(restored.value);
      } else {
        latestRef.current.onChange(restored.value);
      }
      flash.triggerFlash();
    } finally {
      setUndoing(false);
    }
    return restored;
  }, [flash.triggerFlash]);

  const clearUndo = useCallback(() => {
    const cleared = createAiTextUndoState();
    undoStateRef.current = cleared;
    setUndoState(cleared);
  }, []);

  return {
    canUndo: undoState.stack.length > 0,
    undoDepth: undoState.stack.length,
    lastLabel: undoState.lastAppliedLabel,
    undoing,
    applyAiText,
    undo,
    clearUndo,
    flashing: flash.flashing,
    flashClass: flash.flashClass,
    triggerFlash: flash.triggerFlash
  };
}

export interface AiUndoCapsuleProps {
  undoDepth: number;
  lastLabel?: string;
  undoing?: boolean;
  compact?: boolean;
  onUndo: () => void;
  onDismiss?: () => void;
  className?: string;
}

/** 写入后柔和滑出的可回撤胶囊（支持多步回撤计数与关闭）。 */
export function AiUndoCapsule({
  undoDepth,
  lastLabel,
  undoing = false,
  compact = false,
  onUndo,
  onDismiss,
  className = ''
}: AiUndoCapsuleProps) {
  if (undoDepth <= 0) return null;
  const tooltip = undoDepth > 1
    ? `撤销最近一次 AI 写入，恢复上一步原文（共 ${undoDepth} 步可回撤）`
    : '撤销本次 AI 写入，无损恢复原文本';

  return (
    <span
      data-testid="ai-undo-capsule"
      className={`ui-ai-undo-pill inline-flex shrink-0 items-center gap-1 rounded-full border border-amber-200/90 bg-amber-50/90 pl-2 pr-1 text-[11px] font-medium text-amber-800 shadow-[0_1px_2px_rgba(24,24,27,.04)] ${compact ? 'h-6' : 'h-6.5 py-0.5'} ${className}`}
    >
      {!compact && (
        <span className="inline-flex items-center gap-1 text-amber-700/90">
          <Sparkles size={10} className="shrink-0"/>
          <span>{lastLabel || '已生成'}</span>
          <span aria-hidden="true" className="text-amber-300">·</span>
        </span>
      )}
      <HoverTooltip content={tooltip} side="top">
        <button
          type="button"
          disabled={undoing}
          onClick={event => { event.stopPropagation(); onUndo(); }}
          aria-label={undoDepth > 1 ? `撤销 AI 写入（剩余 ${undoDepth} 步）` : '撤销 AI 写入'}
          className="inline-flex items-center gap-1 rounded-full px-1 py-0.5 text-[11px] font-semibold text-amber-900 transition-colors hover:bg-amber-200/60 disabled:opacity-50"
        >
          <Undo2 size={11} className="shrink-0"/>
          <span>撤销{undoDepth > 1 ? ` (${undoDepth})` : ''}</span>
        </button>
      </HoverTooltip>
      {onDismiss && (
        <HoverTooltip content="保留当前结果并隐藏撤销提示" side="top">
          <button
            type="button"
            onClick={event => { event.stopPropagation(); onDismiss(); }}
            aria-label="隐藏撤销提示"
            className="grid h-4 w-4 shrink-0 place-items-center rounded-full text-amber-600/75 transition-colors hover:bg-amber-200/60 hover:text-amber-900"
          >
            <X size={10}/>
          </button>
        </HoverTooltip>
      )}
    </span>
  );
}

export interface AiTextAssistProps {
  /** 后端辅助模式 */
  mode: LlmAssistMode;
  /** 当前文本值 */
  value: string;
  /** 可选实时读取函数（例如 Milkdown 编辑器存在防抖时读取实时文档） */
  getValue?: () => string;
  /** AI 生成或撤销时写回新文本 */
  onChange: (nextValue: string) => void;
  /** 场景上下文（支持静态对象或按需采集函数） */
  context?: LlmAssistContext | (() => LlmAssistContext);
  /** 生成完成后的附加回调（例如正则场景获取 flags/explanation，或标题场景落库） */
  onResult?: (result: LlmAssistResult, previousValue: string) => void | Promise<void>;
  /** 自定义撤销逻辑（例如标题回写服务端）；不传则直接调用 onChange(previousValue) */
  onUndo?: (previousValue: string) => void | Promise<void>;
  /** 设为 true 时不自动调 onChange，完全交由 onResult 接管写入 */
  manualApply?: boolean;
  /** 按钮外观：pill（带字胶囊）、icon（图标按钮）、inline（极紧凑行内图标） */
  variant?: 'icon' | 'pill' | 'inline';
  /** 尺寸 */
  size?: 'xs' | 'sm';
  /** 自定义按钮文案（pill 形态生效） */
  label?: string;
  /** 无障碍名称 */
  ariaLabel?: string;
  /** 已配置时的悬停提示 */
  tooltip?: string;
  /** 未配置时的悬停提示（默认统一文案） */
  unconfiguredTooltip?: string;
  /** 交互模式：popover（默认，展开轻盈快捷面板）或 instant（点击立即执行） */
  interaction?: 'popover' | 'instant';
  /** instant 模式使用的默认动作 */
  instantAction?: LlmAssistAction;
  /** Popover 首选弹出方向与对齐 */
  popoverSide?: 'top' | 'bottom';
  popoverAlign?: 'start' | 'end';
  /** Popover 内一句话需求输入框占位符 */
  instructionPlaceholder?: string;
  /** 外部禁用条件（叠加在 LLM 配置检查之上） */
  disabled?: boolean;
  /** 变化时重置撤销栈（如切换 sessionId、表单重置或消息已发送） */
  resetKey?: string | number;
  /** 文本写入或撤销后通知外部播放 highlight-flash 高亮动画 */
  onFlash?: () => void;
  /** 可选快捷需求芯片（如正则生成场景的常用规则示例） */
  quickPrompts?: Array<{ label: string; instruction: string }>;
  /** 撤销胶囊是否使用极简短文案（仅显示「撤销」） */
  compactUndo?: boolean;
  /** 隐藏内联撤销胶囊，改为通过 onUndoStateChange 交由外部槽位渲染（移动端超窄工具栏友好） */
  hideInlineUndo?: boolean;
  /** 通知外部撤销状态变化（供 Composer 等自定义撤销条位置使用） */
  onUndoStateChange?: (state: {
    canUndo: boolean;
    undoDepth: number;
    lastLabel?: string;
    undoing: boolean;
    undo: () => void;
    clearUndo: () => void;
  }) => void;
  /** 可选外部错误通知回调 */
  onError?: (message: string) => void;
  /** 额外容器样式 */
  className?: string;
  /** 测试/自定义数据标识 */
  testId?: string;
}

const POPOVER_DEFAULT_WIDTH = 340;
const POPOVER_ESTIMATED_HEIGHT = 236;

/**
 * 全站统一 AI 辅助输入组件。
 *
 * - 未配置 LLM 端点时：保留位置、克制置灰，外层 span 承接 Radix HoverTooltip 温和引导前往「模型端点」配置；
 * - 已配置 LLM 端点时：轻盈 ✨ 微光触发按钮，支持弹出快捷面板（优化清晰 / 精简提炼 / 结构化展开 / 一句话帮写）
 *   或一键直出，生成中展示细腻流光脉冲与取消按钮，写入瞬间触发高亮过渡并滑出可多步回撤的「撤销」胶囊。
 */
export function AiTextAssistControl({
  mode,
  value,
  getValue,
  onChange,
  context,
  onResult,
  onUndo,
  manualApply = false,
  variant = 'pill',
  size = 'xs',
  label,
  ariaLabel,
  tooltip,
  unconfiguredTooltip = LLM_UNCONFIGURED_TOOLTIP,
  interaction = 'popover',
  instantAction,
  popoverSide = 'bottom',
  popoverAlign = 'end',
  instructionPlaceholder,
  disabled = false,
  resetKey,
  onFlash,
  quickPrompts,
  compactUndo = false,
  hideInlineUndo = false,
  onUndoStateChange,
  onError,
  className = '',
  testId
}: AiTextAssistProps) {
  const availability = useLlmAvailability();
  const [open, setOpen] = useState(false);
  const [activeMode, setActiveMode] = useState<LlmAssistMode>(mode);
  const [instruction, setInstruction] = useState('');
  const [busy, setBusy] = useState(false);
  const [busyLabel, setBusyLabel] = useState<string>();
  const [error, setError] = useState<string>();
  const [regexHint, setRegexHint] = useState<string>();
  const [popoverStyle, setPopoverStyle] = useState<{ top: number; left: number; maxWidth: number; side: 'top' | 'bottom' }>();

  const triggerRef = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const instructionInputRef = useRef<HTMLInputElement>(null);
  const abortRef = useRef<AbortController | null>(null);

  const undoable = useUndoableAiText({
    value,
    getValue,
    onChange,
    onUndo,
    resetKey
  });

  useEffect(() => {
    setActiveMode(mode);
  }, [mode]);

  useEffect(() => {
    return () => {
      abortRef.current?.abort();
      abortRef.current = null;
    };
  }, []);

  // 同步撤销状态给需要自定义撤销条位置的父组件（例如 Composer）
  const undoCallbackRef = useRef(undoable.undo);
  const clearUndoRef = useRef(undoable.clearUndo);
  undoCallbackRef.current = undoable.undo;
  clearUndoRef.current = undoable.clearUndo;

  useEffect(() => {
    onUndoStateChange?.({
      canUndo: undoable.canUndo,
      undoDepth: undoable.undoDepth,
      lastLabel: undoable.lastLabel,
      undoing: undoable.undoing,
      undo: () => { void undoCallbackRef.current(); },
      clearUndo: () => clearUndoRef.current()
    });
  }, [onUndoStateChange, undoable.canUndo, undoable.undoDepth, undoable.lastLabel, undoable.undoing]);

  const liveText = getValue ? getValue() : value;
  const hasText = liveText.trim().length > 0;
  const modeMeta = useMemo(() => getAiModeMeta(activeMode), [activeMode]);
  const presets = useMemo(() => getAiAssistPresets(activeMode, hasText), [activeMode, hasText]);

  const resolvedButtonLabel = label ?? (hasText ? modeMeta.filledButtonLabel : modeMeta.emptyButtonLabel);
  const resolvedAriaLabel = ariaLabel ?? resolvedButtonLabel;
  const resolvedTooltip = tooltip ?? (
    interaction === 'instant'
      ? resolvedButtonLabel
      : `${resolvedButtonLabel}${availability.model ? ` · ${availability.model}` : ''}`
  );

  // 计算并保持 Popover 贴合视口安全边界（不溢出 390×844 移动端和各类 overflow-hidden 弹窗）
  const updatePosition = useCallback(() => {
    const anchor = triggerRef.current?.getBoundingClientRect();
    if (!anchor) return;
    const rect = popoverRef.current?.getBoundingClientRect();
    const placed = placeAiPopover(
      anchor,
      {
        width: rect?.width && rect.width > 0 ? Math.min(rect.width, POPOVER_DEFAULT_WIDTH) : POPOVER_DEFAULT_WIDTH,
        height: rect?.height && rect.height > 0 ? rect.height : POPOVER_ESTIMATED_HEIGHT
      },
      { width: window.innerWidth, height: window.innerHeight },
      { side: popoverSide, align: popoverAlign }
    );
    setPopoverStyle({ top: placed.top, left: placed.left, maxWidth: placed.maxWidth, side: placed.side });
  }, [popoverSide, popoverAlign]);

  useLayoutEffect(() => {
    if (!open) return;
    updatePosition();
    const frame = window.requestAnimationFrame(() => {
      updatePosition();
      instructionInputRef.current?.focus();
    });
    return () => window.cancelAnimationFrame(frame);
  }, [open, updatePosition, activeMode, busy, error, regexHint]);

  useEffect(() => {
    if (!open) return;
    const onResizeOrScroll = () => updatePosition();
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (popoverRef.current?.contains(target) || triggerRef.current?.contains(target)) return;
      setOpen(false);
    };
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      // 捕获阶段优先关闭 AI 浮层，避免把外层弹窗一并关掉。
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();
      setOpen(false);
      triggerRef.current?.focus();
    };
    window.addEventListener('resize', onResizeOrScroll);
    window.addEventListener('scroll', onResizeOrScroll, true);
    document.addEventListener('pointerdown', onPointerDown, true);
    window.addEventListener('keydown', onKeyDown, true);
    return () => {
      window.removeEventListener('resize', onResizeOrScroll);
      window.removeEventListener('scroll', onResizeOrScroll, true);
      document.removeEventListener('pointerdown', onPointerDown, true);
      window.removeEventListener('keydown', onKeyDown, true);
    };
  }, [open, updatePosition]);

  const cancel = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    setBusy(false);
    setBusyLabel(undefined);
  }, []);

  const executeAssist = useCallback(async (params: {
    runMode?: LlmAssistMode;
    action?: LlmAssistAction;
    customInstruction?: string;
    resultLabel?: string;
  }) => {
    if (!availability.configured || disabled) return;
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    const currentText = getValue ? getValue() : value;
    const resolvedMode = params.runMode ?? activeMode;
    const resolvedInstruction = (params.customInstruction ?? instruction).trim();
    const resolvedContext = typeof context === 'function' ? context() : context;

    setBusy(true);
    setBusyLabel(params.resultLabel ?? getAiModeMeta(resolvedMode).busyText);
    setError(undefined);
    setRegexHint(undefined);

    try {
      const result = await api.assistLlm({
        mode: resolvedMode,
        text: currentText,
        ...(resolvedInstruction ? { instruction: resolvedInstruction } : {}),
        ...(params.action ? { action: params.action } : {}),
        ...(resolvedContext ? { context: resolvedContext } : {}),
        timeoutMs: DEFAULT_ASSIST_TIMEOUT_MS
      }, { signal: controller.signal });

      if (controller.signal.aborted) return;

      const appliedText = resolvedMode === 'regex_generate'
        ? (result.pattern ?? result.text)
        : result.text;

      undoable.applyAiText(appliedText, {
        previousValue: currentText,
        label: params.resultLabel || '已生成',
        skipOnChange: manualApply
      });
      await onResult?.(result, currentText);
      onFlash?.();
      setInstruction('');
      if (resolvedMode === 'regex_generate' && result.explanation) {
        setRegexHint(result.explanation);
      } else {
        setOpen(false);
      }
    } catch (err) {
      if (controller.signal.aborted) return;
      const message = err instanceof Error ? err.message : String(err);
      setError(message);
      onError?.(message);
    } finally {
      if (abortRef.current === controller) {
        abortRef.current = null;
        setBusy(false);
        setBusyLabel(undefined);
      }
    }
  }, [
    availability.configured,
    disabled,
    getValue,
    value,
    activeMode,
    instruction,
    context,
    undoable,
    manualApply,
    onResult,
    onFlash,
    onError
  ]);

  const handleTriggerClick = (event: MouseEvent<HTMLButtonElement>) => {
    event.preventDefault();
    event.stopPropagation();
    if (!availability.configured || disabled) return;
    if (busy) return;
    if (interaction === 'instant') {
      void executeAssist({
        runMode: mode,
        action: instantAction ?? (mode === 'title_generate' ? 'generate' : hasText ? 'optimize' : 'write'),
        resultLabel: mode === 'title_generate' ? '已生成标题' : '已生成'
      });
      return;
    }
    setError(undefined);
    setOpen(prev => !prev);
  };

  const handleUndo = useCallback(() => {
    void undoable.undo().then(restored => {
      if (restored) onFlash?.();
    });
  }, [undoable, onFlash]);

  const handleInstructionSubmit = () => {
    const trimmed = instruction.trim();
    const currentText = (getValue ? getValue() : value).trim();
    if (!trimmed && !currentText && !modeMeta.allowEmptyRun) return;
    const action: LlmAssistAction = trimmed
      ? (currentText ? 'optimize' : 'write')
      : (activeMode === 'title_generate' || activeMode === 'regex_generate' ? 'generate' : currentText ? 'optimize' : 'write');
    void executeAssist({
      runMode: activeMode,
      action,
      customInstruction: trimmed,
      resultLabel: trimmed ? '已按需求生成' : '已生成'
    });
  };

  const handleInstructionKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.nativeEvent.isComposing) return;
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      event.stopPropagation();
      handleInstructionSubmit();
    }
  };

  const triggerSizing = variant === 'icon'
    ? (size === 'sm' ? 'h-8 w-8 rounded-lg' : 'h-7 w-7 rounded-lg')
    : variant === 'inline'
      ? (size === 'sm' ? 'h-7 w-7 rounded-md' : 'h-6 w-6 rounded-md')
      : (size === 'sm' ? 'h-7 gap-1.5 rounded-lg px-2.5 text-[12px]' : 'h-6 gap-1 rounded-md px-2 text-[11.5px]');

  const iconSize = variant === 'icon' ? (size === 'sm' ? 14 : 13) : (size === 'sm' ? 12.5 : 11.5);

  // 1. 未配置 LLM 端点态：保留占位、克制置灰，外层 span 承接 Radix HoverTooltip 温和提醒。
  if (!availability.configured) {
    return (
      <span className={`inline-flex shrink-0 items-center gap-1 ${className}`}>
        <HoverTooltip content={unconfiguredTooltip} side="top">
          <span
            tabIndex={0}
            data-ai-assist-unconfigured="true"
            data-testid={testId ? `${testId}-unconfigured` : 'ai-assist-unconfigured'}
            className="inline-flex shrink-0 cursor-not-allowed rounded-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-zinc-400/50"
          >
            <button
              type="button"
              disabled
              aria-disabled="true"
              aria-label={`${resolvedAriaLabel}（需先配置 LLM 模型端点）`}
              className={`pointer-events-none inline-flex shrink-0 items-center justify-center border border-zinc-200/80 bg-zinc-50/70 font-medium text-zinc-400 opacity-60 ${triggerSizing}`}
            >
              <Sparkles size={iconSize} className="shrink-0"/>
              {variant === 'pill' && <span className="whitespace-nowrap">{resolvedButtonLabel}</span>}
            </button>
          </span>
        </HoverTooltip>
      </span>
    );
  }

  const canSubmitInstruction = Boolean(instruction.trim() || hasText || modeMeta.allowEmptyRun);

  return (
    <span className={`inline-flex shrink-0 items-center gap-1.5 ${className}`}>
      {busy && !open ? (
        <span
          role="status"
          data-testid={testId ? `${testId}-busy` : 'ai-assist-busy'}
          className="ui-ai-trigger-busy inline-flex h-6.5 shrink-0 items-center gap-1.5 rounded-full border px-2 py-0.5 text-[11px] font-medium text-amber-800"
        >
          <Sparkles size={11} className="ui-ai-sparkle-busy shrink-0 text-amber-600"/>
          <span className="ui-shimmer-text max-w-[116px] truncate">{busyLabel || '生成中…'}</span>
          <HoverTooltip content="取消本次 AI 生成" side="top">
            <button
              type="button"
              onClick={event => { event.stopPropagation(); cancel(); }}
              aria-label="取消 AI 生成"
              className="grid h-4 w-4 shrink-0 place-items-center rounded-full text-amber-700 transition-colors hover:bg-amber-200/60 hover:text-amber-900"
            >
              <X size={10}/>
            </button>
          </HoverTooltip>
        </span>
      ) : (
        <HoverTooltip content={open ? undefined : resolvedTooltip} side="top">
          <button
            ref={triggerRef}
            type="button"
            disabled={disabled}
            aria-label={resolvedAriaLabel}
            aria-haspopup={interaction === 'popover' ? 'dialog' : undefined}
            aria-expanded={interaction === 'popover' ? open : undefined}
            data-testid={testId ?? 'ai-assist-trigger'}
            onClick={handleTriggerClick}
            className={`ui-ai-trigger group/ai inline-flex shrink-0 items-center justify-center border font-medium active:scale-[.96] disabled:cursor-not-allowed disabled:opacity-40 ${
              open
                ? 'border-amber-200 bg-amber-50 text-amber-800 shadow-[0_1px_6px_rgba(217,119,6,.12)]'
                : variant === 'pill'
                  ? 'border-zinc-200/90 bg-white text-zinc-700 hover:text-amber-800'
                  : 'border-transparent bg-transparent text-zinc-500 hover:border-amber-200/80 hover:text-amber-700'
            } ${triggerSizing}`}
          >
            <Sparkles
              size={iconSize}
              className={`shrink-0 transition-transform duration-200 ${open ? 'text-amber-600' : 'text-amber-600/85 group-hover/ai:rotate-12 group-hover/ai:scale-105'}`}
            />
            {variant === 'pill' && <span className="whitespace-nowrap">{resolvedButtonLabel}</span>}
          </button>
        </HoverTooltip>
      )}

      {!hideInlineUndo && undoable.canUndo && !busy && (
        <AiUndoCapsule
          undoDepth={undoable.undoDepth}
          lastLabel={undoable.lastLabel}
          undoing={undoable.undoing}
          compact={compactUndo}
          onUndo={handleUndo}
          onDismiss={undoable.clearUndo}
        />
      )}

      {interaction === 'instant' && error && !busy && (
        <span
          role="alert"
          className="inline-flex max-w-[200px] items-center gap-1 rounded-full border border-red-200 bg-red-50 px-2 py-0.5 text-[11px] text-red-700"
        >
          <AlertCircle size={11} className="shrink-0"/>
          <span className="truncate">{error}</span>
          <button
            type="button"
            aria-label="关闭错误提示"
            onClick={event => { event.stopPropagation(); setError(undefined); }}
            className="shrink-0 text-red-500 hover:text-red-800"
          >
            <X size={10}/>
          </button>
        </span>
      )}

      {typeof document !== 'undefined' && createPortal(
        <ExitGate open={open} ms={160}>
          <div
            ref={popoverRef}
            role="dialog"
            aria-label={modeMeta.title}
            data-ai-assist-portal="true"
            data-side={popoverStyle?.side ?? popoverSide}
            data-testid={testId ? `${testId}-popover` : 'ai-assist-popover'}
            onMouseDown={event => event.stopPropagation()}
            onClick={event => event.stopPropagation()}
            style={{
              position: 'fixed',
              top: popoverStyle?.top ?? -9999,
              left: popoverStyle?.left ?? -9999,
              width: popoverStyle?.maxWidth ?? POPOVER_DEFAULT_WIDTH,
              zIndex: 80
            }}
            className="ui-ai-popover overflow-hidden rounded-2xl border border-zinc-200 bg-white text-zinc-900"
          >
            {/* 顶栏：标题 + 模式切换 + 模型名 + 关闭 */}
            <div className="flex items-center gap-2 border-b border-zinc-100 px-3 py-2">
              <span className="grid h-6 w-6 shrink-0 place-items-center rounded-lg bg-amber-50 text-amber-600 ring-1 ring-amber-200/70">
                <Sparkles size={12.5} className={busy ? 'ui-ai-sparkle-busy' : ''}/>
              </span>
              <div className="min-w-0 flex-1">
                <div className="truncate text-[12.5px] font-semibold leading-tight text-zinc-900">{modeMeta.title}</div>
                {availability.model && (
                  <div className="truncate font-mono text-[10.5px] leading-4 text-zinc-400">{availability.model}</div>
                )}
              </div>
              <HoverTooltip content="关闭面板（Esc）" side="top">
                <button
                  type="button"
                  aria-label="关闭 AI 辅助面板"
                  onClick={() => setOpen(false)}
                  className="ui-press grid h-6 w-6 shrink-0 place-items-center rounded-md text-zinc-400 hover:bg-zinc-100 hover:text-zinc-800"
                >
                  <X size={13}/>
                </button>
              </HoverTooltip>
            </div>

            <div className="space-y-2.5 p-3">
              {/* 可选模式切换胶囊 */}
              {modeMeta.switchableModes && modeMeta.switchableModes.length > 1 && (
                <SlidingSegmented
                  size="xs"
                  ariaLabel="AI 辅助模式"
                  value={activeMode}
                  onChange={nextMode => { setActiveMode(nextMode); setError(undefined); }}
                  options={modeMeta.switchableModes.map(option => ({
                    value: option.mode,
                    label: option.label,
                    disabled: busy
                  }))}
                />
              )}

              {/* 一键快捷操作 */}
              {presets.length > 0 && (
                <div className="flex flex-wrap gap-1.5">
                  {presets.map(preset => (
                    <HoverTooltip key={preset.id} content={preset.description} side="top">
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => void executeAssist({
                          runMode: preset.mode,
                          action: preset.action,
                          resultLabel: `已${preset.label.replace(/^按上下文/, '').replace(/^按场景/, '')}`
                        })}
                        className="ui-press inline-flex h-7 items-center gap-1 rounded-lg border border-zinc-200/90 bg-zinc-50/70 px-2.5 text-[11.5px] font-medium text-zinc-700 hover:border-amber-200 hover:bg-amber-50/80 hover:text-amber-800 disabled:opacity-45"
                      >
                        <Wand2 size={11} className="shrink-0 text-amber-600/85"/>
                        <span>{preset.label}</span>
                      </button>
                    </HoverTooltip>
                  ))}
                </div>
              )}

              {/* 可选业务方快捷需求芯片 */}
              {quickPrompts && quickPrompts.length > 0 && (
                <div className="flex flex-wrap gap-1">
                  {quickPrompts.map(item => (
                    <button
                      key={item.label}
                      type="button"
                      disabled={busy}
                      onClick={() => void executeAssist({
                        runMode: activeMode,
                        action: hasText ? 'optimize' : 'write',
                        customInstruction: item.instruction,
                        resultLabel: `已${item.label}`
                      })}
                      className="ui-press rounded-md border border-zinc-200/70 bg-white px-2 py-0.5 text-[11px] text-zinc-600 hover:border-zinc-300 hover:bg-zinc-50 hover:text-zinc-900 disabled:opacity-45"
                    >
                      {item.label}
                    </button>
                  ))}
                </div>
              )}

              {/* 一句话意图输入框（按 Enter 直接生成） */}
              <div className="ui-field-within flex items-center gap-1.5 rounded-xl border border-zinc-200 bg-white p-1 pl-2.5">
                <input
                  ref={instructionInputRef}
                  type="text"
                  disabled={busy}
                  value={instruction}
                  onChange={event => { setInstruction(event.target.value); setError(undefined); }}
                  onKeyDown={handleInstructionKeyDown}
                  placeholder={instructionPlaceholder ?? modeMeta.placeholder}
                  aria-label="输入 AI 写作或优化需求"
                  className="h-7 min-w-0 flex-1 bg-transparent text-[12px] text-zinc-900 outline-none placeholder:text-zinc-400 disabled:opacity-50"
                />
                <HoverTooltip content="生成并写入（Enter）" side="top">
                  <button
                    type="button"
                    disabled={busy || !canSubmitInstruction}
                    onClick={handleInstructionSubmit}
                    aria-label="执行 AI 生成"
                    className="ui-press grid h-7 w-7 shrink-0 place-items-center rounded-lg bg-zinc-900 text-white hover:bg-zinc-700 active:scale-95 disabled:opacity-35"
                  >
                    <ArrowUp size={13} strokeWidth={2.2}/>
                  </button>
                </HoverTooltip>
              </div>

              {/* 流光生成中状态 + 取消 */}
              {busy && (
                <div role="status" className="ui-status-banner-in space-y-1.5 rounded-xl border border-amber-200/80 bg-amber-50/55 px-2.5 py-2">
                  <div className="ui-ai-shimmer-bar w-full"/>
                  <div className="flex items-center justify-between gap-2 text-[11.5px]">
                    <span className="inline-flex min-w-0 items-center gap-1.5 font-medium text-amber-800">
                      <Sparkles size={11.5} className="ui-ai-sparkle-busy shrink-0 text-amber-600"/>
                      <span className="ui-shimmer-text truncate">{busyLabel || modeMeta.busyText}</span>
                    </span>
                    <button
                      type="button"
                      onClick={cancel}
                      className="ui-press shrink-0 rounded-md border border-amber-200 bg-white px-2 py-0.5 text-[11px] font-medium text-amber-800 hover:bg-amber-100/70"
                    >
                      取消
                    </button>
                  </div>
                </div>
              )}

              {/* 正则生成成功后的简短解释 */}
              {regexHint && !busy && (
                <div className="ui-status-banner-in flex items-start gap-1.5 rounded-xl border border-emerald-200 bg-emerald-50/70 px-2.5 py-2 text-[11.5px] leading-4.5 text-emerald-800">
                  <Check size={12.5} className="ui-icon-pop mt-0.5 shrink-0 text-emerald-600"/>
                  <span className="min-w-0 flex-1 break-words">{regexHint}</span>
                </div>
              )}

              {/* 报错提示 + 重试 */}
              {error && !busy && (
                <div role="alert" className="ui-status-banner-in flex items-start gap-2 rounded-xl border border-red-200 bg-red-50 px-2.5 py-2 text-[11.5px] leading-4.5 text-red-700">
                  <AlertCircle size={13} className="mt-0.5 shrink-0 text-red-600"/>
                  <span className="min-w-0 flex-1 break-words">{error}</span>
                  <button
                    type="button"
                    onClick={handleInstructionSubmit}
                    className="ui-press inline-flex shrink-0 items-center gap-1 rounded-md border border-red-200 bg-white px-1.5 py-0.5 text-[11px] font-medium text-red-700 hover:bg-red-50"
                  >
                    <RotateCcw size={10}/>重试
                  </button>
                </div>
              )}

              {/* 底部安全回撤提示 */}
              <div className="flex items-center justify-between gap-2 pt-0.5 text-[10.5px] text-zinc-400">
                <span>写入后可随时一键撤销恢复原文</span>
                {undoable.canUndo && (
                  <button
                    type="button"
                    onClick={handleUndo}
                    className="ui-press inline-flex shrink-0 items-center gap-1 font-medium text-amber-700 hover:text-amber-900"
                  >
                    <Undo2 size={10.5}/>撤销上一步{undoable.undoDepth > 1 ? ` (${undoable.undoDepth})` : ''}
                  </button>
                )}
              </div>
            </div>
          </div>
        </ExitGate>,
        document.body
      )}
    </span>
  );
}

/**
 * 供紧凑场景或外部模块（如飞书群聊正则监听）直接复用的图标按钮快捷别名。
 */
export function AiTextAssistButton(props: AiTextAssistProps) {
  return <AiTextAssistControl variant="icon" {...props}/>;
}

/**
 * 表单字段标题行：左侧标题 + 右侧自动对齐的 AI 辅助控件，确保亮/暗主题与 390px 移动端不拥挤。
 */
export function AiFieldHeader({
  label,
  htmlFor,
  required,
  hint,
  assist,
  className = ''
}: {
  label: ReactNode;
  htmlFor?: string;
  required?: boolean;
  hint?: ReactNode;
  assist: ReactNode;
  className?: string;
}) {
  return (
    <div className={`flex flex-wrap items-center justify-between gap-x-2 gap-y-1 ${className}`}>
      <label htmlFor={htmlFor} className="inline-flex min-w-0 items-center gap-1 text-[12px] font-medium text-zinc-700">
        <span className="truncate">{label}</span>
        {required && <span className="text-red-500">*</span>}
        {hint && <span className="font-normal text-zinc-400">{hint}</span>}
      </label>
      <div className="flex shrink-0 items-center gap-1">{assist}</div>
    </div>
  );
}
