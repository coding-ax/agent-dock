import { type Dispatch, type ReactNode, type RefObject, type SetStateAction, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useEventListener } from 'ahooks';
import { AlertCircle, ArrowUp, BookOpen, Bot, BrainCircuit, Check, ChevronDown, CornerDownLeft, CornerDownRight, File, FilePenLine, Folder, FolderOpen, Gauge, ImageIcon, ListEnd, Paperclip, Puzzle, RefreshCw, RotateCcw, Search, Settings2, Sparkles, Square, Undo2, X, Zap } from 'lucide-react';
import { Switch } from 'antd';
import { ASK_USER_QUESTION_XML_TAG, BUILTIN_ASK_USER_QUESTION_PLUGIN_ID, localizeOutputPluginDisplay } from '@agent-dock/agent-dock-shared';
import type { Agent, AgentModel, LlmAssistContext, SessionUsageDetail, SkillReference, Task } from './api';
import type { QueuedTask } from './timeline';
import { AgentIcon } from './AgentIcon';
import { AiTextAssistControl, AiUndoCapsule, useAiFlash } from './AiTextAssist';
import { ComposerEditor, type ComposerEditorHandle } from './ComposerEditor';
import { ExitGate } from './ExitGate';
import { HoverTooltip } from './HoverTooltip';
import { Spinner } from './Loaders';
import { PluginIcon } from './output-plugins/PluginIcon';
import { composerKeyAction, createCompositionGuard } from './composer-keyboard';
import { composerSubmitValue, filterAgentModels, referenceFromUpload, replaceSlashQuery, shouldDismissComposerPanel, slashQuery, uploadSessionFile, workspaceLabel as displayWorkspaceLabel, type ComposerReference, type ContextStats, type ModelReadiness } from './composer-utils';
import type { LiveStreamTpsResult } from './live-tps';
import { useBi, useLocale } from './i18n';

export interface ComposerOutputPluginItem {
  id: string;
  name: string;
  description: string;
  icon: string;
  tagName: string;
  builtin: boolean;
  /** 本会话或草稿当前生效状态。 */
  enabled: boolean;
  /** 全局默认状态。 */
  globalEnabled: boolean;
  /** 本会话或草稿显式覆写（boolean = 覆写，null = 跟随全局默认）。 */
  override: boolean | null;
}

type SendMode = 'queue' | 'interrupt';
type ComposerCommand = { name: string; description: string };
type ComposerPanel = 'commands' | 'models' | 'reasoning' | 'agent' | 'workspace' | 'systemPrompt' | 'plugins' | undefined;

const supportedCommands = new Set(['goal', 'plan', 'fast']);

function useDismissComposerPanel(popover: RefObject<HTMLDivElement | null>, panel: ComposerPanel, setPanel: Dispatch<SetStateAction<ComposerPanel>>) {
  // capture 阶段监听：面板内的按钮会在 click 时改状态，冒泡阶段判断会慢一拍。
  // enable 交给 ahooks，省掉手写的「if (!panel) return」与增删监听。
  useEventListener('pointerdown', event => {
    const target = event.target;
    if (!(target instanceof Node)) return;
    const insidePopover = Boolean(popover.current?.contains(target))
      || (target instanceof Element && Boolean(target.closest('[data-ai-assist-portal]')));
    const onPanelTrigger = target instanceof Element && Boolean(target.closest('[data-composer-panel-trigger]'));
    if (shouldDismissComposerPanel({ insidePopover, onPanelTrigger })) setPanel(undefined);
  }, { target: () => document, capture: true, enable: Boolean(panel) });
}

/**
 * 队列只在末尾新增时滚到最新一条：刚发的消息要看得见。队首被取走、取消或编辑时不动，
 * 别把正在面板里翻的人拽走。
 */
function useScrollToNewestQueued(tasks: QueuedTask[]) {
  const ref = useRef<HTMLDivElement>(null);
  const newestId = tasks.at(-1)?.id;
  useLayoutEffect(() => {
    const list = ref.current;
    if (list && newestId) list.scrollTop = list.scrollHeight;
  }, [newestId]);
  return ref;
}

export function QueuedTasks({ tasks, cancellingTaskId, steeringTaskId, editingTaskId, onCancel, onSteer, onEdit }: { tasks: QueuedTask[]; cancellingTaskId?: string; steeringTaskId?: string; editingTaskId?: string; onCancel(id: string): void; onSteer(id: string): void; onEdit(task: Task): void }) {
  const L = useBi();
  const listRef = useScrollToNewestQueued(tasks);
  if (!tasks.length) return null;
  const busy = Boolean(cancellingTaskId) || Boolean(steeringTaskId) || Boolean(editingTaskId);
  return <div className="ui-queue-panel mx-4 overflow-hidden rounded-t-2xl border border-b-0 border-zinc-200/80 bg-white shadow-[0_-5px_18px_rgba(24,24,27,.025)]">
    <div className="flex items-center gap-2 border-b border-zinc-100 px-3.5 py-2 text-[12px] font-medium text-zinc-500">
      <ListEnd size={13} className="shrink-0"/>
      <span className="shrink-0">{L("等待发送", "Waiting to send")}</span>
      <span className="shrink-0 rounded-full bg-zinc-100 px-1.5 py-0.5 text-[12px] tabular-nums">{tasks.length}</span>
      {steeringTaskId && <span role="status" className="ml-auto inline-flex min-w-0 items-center gap-1.5 text-[11px] font-medium text-orange-700"><Spinner size={11} label={L("正在打断", "Interrupting")}/><span className="ui-shimmer-text truncate">{L("正在打断当前回复…", "Interrupting current reply…")}</span></span>}
    </div>
    <div ref={listRef} className="max-h-28 overflow-y-auto">{tasks.map(task => {
      // pending：刚提交、服务端还没确认，没有任务 id 可操作。按钮照常显示、只是点不动——
      // 这个状态通常只有几十毫秒，按钮先变灰再变亮反而像闪了一下。
      const isEditing = editingTaskId === task.id;
      const isSteering = steeringTaskId === task.id;
      const inert = busy || Boolean(task.pending);
      const dim = task.pending ? 'pointer-events-none' : 'disabled:opacity-30';
      const rowTone = isEditing
        ? 'bg-blue-50/80 ring-1 ring-inset ring-blue-200/70'
        : isSteering
          ? 'bg-orange-50/85 text-zinc-900 ring-1 ring-inset ring-orange-200/80'
          : 'text-zinc-600 hover:bg-zinc-50';
      return <div key={task.id} data-pending={task.pending ? '' : undefined} data-steering={isSteering ? '' : undefined} className={`ui-queue-row group flex items-center gap-2 px-3.5 py-2 text-[12px] transition-colors sm:gap-2.5 ${rowTone}`}>
        {isEditing ? <>
          <Undo2 size={13} className="shrink-0 text-blue-600"/>
          <span className="min-w-0 flex-1 truncate text-zinc-400 line-through decoration-zinc-300" title={task.prompt}>{task.prompt}</span>
          <span className="flex shrink-0 items-center gap-1 whitespace-nowrap rounded-full bg-blue-600 px-2 py-0.5 text-[12px] font-medium text-white"><CornerDownLeft size={10}/>{L("已退回输入框", "Returned to input")}</span>
        </> : isSteering ? <>
          <Zap size={13} className="shrink-0 animate-pulse text-orange-700"/>
          <span className="min-w-0 flex-1 truncate font-medium text-zinc-900" title={task.prompt}>{task.prompt}</span>
          <button type="button" disabled aria-busy="true" className="inline-flex h-6 shrink-0 cursor-wait items-center gap-1.5 whitespace-nowrap rounded-md bg-orange-100/90 px-2 text-[12px] font-medium text-orange-700"><Spinner size={11} label={L("正在打断", "Interrupting")}/><span>{L("正在打断…", "Interrupting…")}</span></button>
        </> : <>
          <CornerDownRight size={13} className="shrink-0 text-zinc-400"/>
          <span className="min-w-0 flex-1 truncate" title={task.prompt}>{task.prompt}</span>
          <span className="hidden shrink-0 text-[12px] text-zinc-400 sm:inline">{L("排队中", "Queued")}</span>
          <button type="button" disabled={inert} onClick={() => onEdit(task)} aria-label={L(`编辑：${task.prompt}`, `Edit: ${task.prompt}`)} title={L("退回输入框编辑", "Edit in input")} className={`ui-press grid h-6 w-6 shrink-0 place-items-center rounded-md text-zinc-400 hover:bg-zinc-200 hover:text-zinc-700 focus-visible:opacity-100 ${dim}`}><FilePenLine size={12}/></button>
          <button type="button" disabled={inert} onClick={() => onSteer(task.id)} className={`ui-press h-6 shrink-0 whitespace-nowrap rounded-md px-2 text-[12px] font-medium hover:bg-zinc-900 hover:text-white ${task.pending ? 'pointer-events-none' : 'disabled:opacity-35'}`}>{L("立即发送", "Send now")}</button>
          <button type="button" disabled={inert} onClick={() => onCancel(task.id)} aria-label={L(`取消排队：${task.prompt}`, `Cancel queued: ${task.prompt}`)} className={`ui-press grid h-6 w-6 shrink-0 place-items-center rounded-md text-zinc-400 hover:bg-zinc-200 hover:text-zinc-700 ${dim}`}><X size={12}/></button>
        </>}
      </div>;
    })}</div>
  </div>;
}

export function Composer({ sessionId, state, value, references, quotedText, onClearQuote, sending, sendingMode, mode, queuedTasks, cancellingTaskId, steeringTaskId, editingTaskId, skills, models, reasoningEfforts, currentModel, currentReasoningEffort, advertisedCommands, builtinCommands = [], modelReadiness, switchingModel, switchingReasoningEffort, pendingModel, pendingReasoningEffort, modelJustSwitched = false, reasoningJustSwitched = false, refreshingModels, editorRef: externalEditorRef, draft, placeholder, sendLabel: sendLabelOverride, lockedTarget, agents, currentAgentId, onAgentChange, workspace, onWorkspaceChange, workspaceSuggestion, workspaceOptions, homeDirectory, directoryPickerAvailable, pickingDirectory, onPickDirectory, onAttachFile, aiContext, systemPrompt, onSystemPromptChange, outputPlugins, outputPluginsScope, outputPluginsScopeName, switchingOutputPluginId, outputPluginsJustSwitched = false, onSetOutputPlugin, onResetAllOutputPlugins, onOpenOutputPluginsCenter, askUserQuestionEnabled, askUserQuestionOverride, switchingAskUserQuestion = false, askUserQuestionJustSwitched = false, onToggleAskUserQuestion, onChange, onReferencesChange, onModeChange, onSubmit, onInterrupt, onCancelQueued, onSteerQueued, onEditQueued, onModelChange, onReasoningEffortChange, onRefreshModels }: {
  sessionId: string; state: string; value: string; references: ComposerReference[]; quotedText?: string; onClearQuote?(): void; sending: boolean; sendingMode?: SendMode; mode: SendMode; queuedTasks: QueuedTask[]; cancellingTaskId?: string; steeringTaskId?: string; editingTaskId?: string;
  // 输入框由 CodeMirror 承载（Markdown 实时编辑）；光标位置由编辑器回报，用于 / 命令查询。
  skills: SkillReference[]; models: AgentModel[]; reasoningEfforts: AgentModel[]; currentModel?: string; currentReasoningEffort?: string; context?: ContextStats; sessionUsage?: SessionUsageDetail; liveTps?: LiveStreamTpsResult; advertisedCommands: Array<{ name: string; description: string }>; builtinCommands?: Array<{ name: string; description: string }>; modelReadiness: ModelReadiness; switchingModel: boolean; switchingReasoningEffort: boolean; pendingModel?: string; pendingReasoningEffort?: string; modelJustSwitched?: boolean; reasoningJustSwitched?: boolean; refreshingModels: boolean;
  /** 分屏时父级需要精确聚焦本 pane 的输入框（不能再用 document.querySelector）。 */
  editorRef?: RefObject<ComposerEditorHandle | null>;
  /** 草稿态：尚未创建会话。显示 Agent / 工作目录选择，隐藏排队 / 中断等会话内控件。 */
  draft?: boolean;
  /** 覆盖输入框的占位文案（主会话：「跟团子说说要做什么…」）。 */
  placeholder?: ReactNode;
  /** 覆盖发送按钮的无障碍名称。 */
  sendLabel?: string;
  /** 草稿态下把 Agent / 目录 / 模型 / 思考深度几枚 chip 换成一枚锁定标签（首页「交给小猫」）。 */
  lockedTarget?: ReactNode;
  agents?: Agent[];
  currentAgentId?: string;
  onAgentChange?(id: string): void;
  workspace?: string;
  onWorkspaceChange?(value: string): void;
  workspaceSuggestion?: string;
  /** 用户主目录；工作区 chip 对它显示「主目录」而不是用户名。 */
  homeDirectory?: string;
  /** 已知工作区（历史会话的 cwd）；草稿态的「工作目录」下拉用它。 */
  workspaceOptions?: string[];
  directoryPickerAvailable?: boolean;
  pickingDirectory?: boolean;
  onPickDirectory?(): void;
  /** 草稿态没有 sessionId：文件先交给上层暂存，返回一枚引用 chip 展示。 */
  onAttachFile?(file: File | Blob): Promise<ComposerReference | void>;
  /** 供全站 AI 润色/帮写使用的会话或草稿上下文。 */
  aiContext?: LlmAssistContext | (() => LlmAssistContext);
  /** 草稿态可选的系统提示词，创建会话时一并传入。 */
  systemPrompt?: string;
  onSystemPromptChange?(value: string): void;
  /** 当前会话（或新建草稿）可用的全部纯 XML 交互插件列表及其状态。 */
  outputPlugins?: ComposerOutputPluginItem[];
  /** 底栏交互插件 Popover 的作用范围：区分当前会话、新建草稿、首页主会话，避免与全局默认混淆。 */
  outputPluginsScope?: 'session' | 'draft' | 'companion';
  /** 可选作用域名称（如主会话小猫名）。 */
  outputPluginsScopeName?: string;
  switchingOutputPluginId?: string;
  outputPluginsJustSwitched?: boolean;
  /** 为单个插件设置本会话覆写（boolean = 显式覆写，null = 恢复跟随全局默认）。 */
  onSetOutputPlugin?(pluginId: string, enabled: boolean | null): void;
  /** 将本会话/草稿全部插件覆写清空，统一恢复跟随全局默认。 */
  onResetAllOutputPlugins?(): void;
  /** 从插件快捷面板直达设置页「交互插件中心」。 */
  onOpenOutputPluginsCenter?(): void;
  /** 向后兼容旧单插件 props（未传 `outputPlugins` 时自动合成为单个插件项）。 */
  askUserQuestionEnabled?: boolean;
  askUserQuestionOverride?: boolean | null;
  switchingAskUserQuestion?: boolean;
  askUserQuestionJustSwitched?: boolean;
  onToggleAskUserQuestion?(): void;
  onChange(value: string): void; onReferencesChange(value: ComposerReference[] | ((current: ComposerReference[]) => ComposerReference[])): void; onModeChange(mode: SendMode): void; onSubmit(value: string): void; onInterrupt(): void; onCancelQueued(taskId: string): void; onSteerQueued(taskId: string): void; onEditQueued(task: Task): void; onModelChange(model: string): void; onReasoningEffortChange(reasoningEffort: string): void; onRefreshModels(): void;
}) {
  const L = useBi();
  const locale = useLocale();
  const [panel, setPanel] = useState<ComposerPanel>();
  const [modelQuery, setModelQuery] = useState('');
  const [uploadError, setUploadError] = useState<string>();
  const [uploading, setUploading] = useState<string[]>([]);
  const [modeOpen, setModeOpen] = useState(false);
  const [submitEpoch, setSubmitEpoch] = useState(0);
  const [aiUndo, setAiUndo] = useState<{
    canUndo: boolean;
    undoDepth: number;
    lastLabel?: string;
    undoing: boolean;
    undo: () => void;
    clearUndo: () => void;
  }>();
  const composerFlash = useAiFlash();
  const systemPromptFlash = useAiFlash();
  const handleAiUndoState = useCallback((next: {
    canUndo: boolean;
    undoDepth: number;
    lastLabel?: string;
    undoing: boolean;
    undo: () => void;
    clearUndo: () => void;
  }) => {
    setAiUndo(next);
  }, []);
  // 工作目录下拉里直接就能输入路径，不需要额外的「输入路径」模式；wsDraft 是那一格的编辑值。
  const [wsDraft, setWsDraft] = useState('');
  const workspacePath = workspace || workspaceSuggestion || '';
  const workspaceLabel = displayWorkspaceLabel(workspacePath, homeDirectory);
  const currentAgent = (agents ?? []).find(agent => agent.id === currentAgentId);
  const editor = useRef<ComposerEditorHandle>(null);
  // 编辑器文档的「有无正文」由 ProseMirror 同步回报；不能只靠 200ms 防抖后的 value，
  // 否则刚打完字就按 Enter/点发送时按钮还是 disabled。
  const [editorHasContent, setEditorHasContent] = useState(() => value.trim().length > 0);
  // 输入法组合态由编辑器上的 composition 事件驱动，键盘处理读同一份状态。
  const [compositionGuard] = useState(createCompositionGuard);
  // 光标前当前文本块的纯文本。Milkdown 的文档位置与 Markdown 字符串偏移不是一回事，
  // 所以 / 查询只看光标前这段纯文本，替换动作也交给编辑器按文档位置做。
  const [beforeCaret, setBeforeCaret] = useState(value);
  const popover = useRef<HTMLDivElement>(null);
  const imageInput = useRef<HTMLInputElement>(null);
  useDismissComposerPanel(popover, panel, setPanel);
  // 每次打开「切换模型」都从空搜索词开始；关掉面板时也清掉，避免下次打开还带着上次的过滤。
  useEffect(() => { if (panel !== 'models') setModelQuery(''); }, [panel]);
  const busy = ['starting', 'thinking', 'running_tool', 'waiting_for_permission', 'interrupting'].includes(state);
  const interruptingSend = !draft && sending && sendingMode === 'interrupt';
  // 只有 blocked（正在切换模型）才拦发送；模型列表还在加载或加载失败都不影响
  // 用当前模型发消息，详见 getModelReadiness。
  const canSubmitWith = (hasText: boolean) => modelReadiness.kind !== 'blocked' && (hasText || references.length > 0) && !sending && (draft ? Boolean(currentAgentId) : !['starting', 'interrupting', 'stopped', 'failed'].includes(state));
  const canSendValue = (candidate: string) => canSubmitWith(candidate.trim().length > 0);
  const canSend = canSubmitWith(editorHasContent || value.trim().length > 0);
  const activeModelId = pendingModel ?? currentModel;
  const modelLabel = modelReadiness.kind === 'ready' ? activeModelId || L("默认模型", "Model") : modelReadiness.label;
  // 底栏优先展示模型的全名（如「Claude Opus 5.5」），拿不到目录时才退回 id；
  // 完整 id 放 title，反代前缀再长也不会把熟悉的名字截掉。
  const modelName = models.find(item => item.id === activeModelId)?.name;
  const triggerModelName = modelName?.replace(/\s*(?:\(recommended\)|（推荐）)\s*$/i, '').trim() || modelName;
  const pendingModelName = pendingModel ? (models.find(item => item.id === pendingModel)?.name || pendingModel) : undefined;
  const modelCatalogLoading = !switchingModel && (modelReadiness.kind === 'loading' || (refreshingModels && models.length === 0));
  const modelDisplay = switchingModel
    ? (pendingModelName ? L(`切换至 ${pendingModelName}…`, `Switching to ${pendingModelName}…`) : L("模型切换中…", "Switching model…"))
    : modelReadiness.kind === 'ready'
      ? (triggerModelName || modelLabel)
      : modelReadiness.kind === 'loading'
        ? L("模型加载中…", "Loading…")
        : modelReadiness.label;
  const modelCompactDisplay = switchingModel
    ? (pendingModelName ? `${pendingModelName}…` : L("切换中…", "Switching…"))
    : modelCatalogLoading
      ? L("模型…", "Models…")
      : modelDisplay;
  const modelTitle = switchingModel
    ? (pendingModelName ? L(`正在切换至 ${pendingModelName}…`, `Switching to ${pendingModelName}…`) : (modelReadiness.kind === 'ready' ? L("正在切换模型…", "Switching model…") : modelReadiness.reason))
    : modelReadiness.kind === 'ready'
      ? (activeModelId ? (modelName && modelName !== modelLabel ? `${modelName} · ${modelLabel}` : modelLabel) : L("默认模型", "Default Model"))
      : modelReadiness.reason;
  const activeReasoningId = pendingReasoningEffort ?? currentReasoningEffort;
  const reasoningDisplay = reasoningEfforts.find(item => item.id === activeReasoningId)?.name || activeReasoningId || L("默认深度", "Effort");
  const pendingReasoningName = pendingReasoningEffort
    ? (reasoningEfforts.find(item => item.id === pendingReasoningEffort)?.name || pendingReasoningEffort)
    : undefined;
  const reasoningCatalogLoading = !switchingReasoningEffort && refreshingModels && reasoningEfforts.length === 0 && !currentReasoningEffort;
  const reasoningTriggerDisplay = switchingReasoningEffort
    ? (pendingReasoningName ? `${pendingReasoningName}…` : L("切换中…", "Switching…"))
    : reasoningCatalogLoading
      ? L("读取中…", "Effort…")
      : reasoningDisplay;
  const reasoningTitle = switchingReasoningEffort
    ? L(`正在切换思考深度至 ${pendingReasoningName ?? '目标深度'}…`, `Switching reasoning effort to ${pendingReasoningName ?? 'target'}…`)
    : reasoningCatalogLoading
      ? L("正在读取可选思考深度…", "Loading reasoning efforts…")
      : L(`思考深度：${reasoningDisplay}`, `Reasoning: ${reasoningDisplay}`);
  const modelChipState = switchingModel ? 'switching' : modelCatalogLoading ? 'loading' : modelJustSwitched ? 'saved' : 'idle';
  const reasoningChipState = switchingReasoningEffort ? 'switching' : reasoningCatalogLoading ? 'loading' : reasoningJustSwitched ? 'saved' : 'idle';
  const effectiveOutputPlugins = useMemo<ComposerOutputPluginItem[]>(() => {
    if (outputPlugins && outputPlugins.length > 0) return outputPlugins;
    if (onToggleAskUserQuestion) {
      const enabled = Boolean(askUserQuestionEnabled);
      const override = typeof askUserQuestionOverride === 'boolean' ? askUserQuestionOverride : null;
      return [{
        id: BUILTIN_ASK_USER_QUESTION_PLUGIN_ID,
        name: L("询问卡片（AskUserQuestion）", "Question Card (AskUserQuestion)"),
        description: L("需要确认或决策时在回答末尾呈现交互选项卡片", "Render an interactive option card at the end of a reply when decisions are needed"),
        icon: 'message-circle-question',
        tagName: ASK_USER_QUESTION_XML_TAG,
        builtin: true,
        enabled,
        globalEnabled: override === null ? enabled : !override,
        override
      }];
    }
    return [];
  }, [outputPlugins, onToggleAskUserQuestion, askUserQuestionEnabled, askUserQuestionOverride]);
  const enabledPluginCount = effectiveOutputPlugins.filter(item => item.enabled).length;
  const overriddenPluginCount = effectiveOutputPlugins.filter(item => item.override !== null).length;
  const pluginsJustSwitched = outputPluginsJustSwitched || askUserQuestionJustSwitched;
  const pluginsBusy = Boolean(switchingOutputPluginId) || switchingAskUserQuestion;
  const effectivePluginsScope = outputPluginsScope ?? (draft ? 'draft' : 'session');
  const pluginsPopoverTitle = effectivePluginsScope === 'draft'
    ? L("新会话 · 交互插件", "New Session · Output Plugins")
    : effectivePluginsScope === 'companion'
      ? L("主会话 · 交互插件", "Main Session · Output Plugins")
      : L("当前会话 · 交互插件", "Session · Output Plugins");
  const pluginsScopeBannerText = effectivePluginsScope === 'draft'
    ? L("仅对即将创建的会话生效，不影响全局默认与其他会话；关闭的插件不注入 XML 协议，零 Token 消耗", "Applies only to the new session without changing global defaults; disabled plugins inject zero XML tokens")
    : effectivePluginsScope === 'companion'
      ? L(`仅对主会话${outputPluginsScopeName ? `（${outputPluginsScopeName}）` : ''}生效，不影响全局默认与其他会话；关闭的插件不注入 XML 协议，零 Token 消耗`, `Applies only to the main session${outputPluginsScopeName ? ` (${outputPluginsScopeName})` : ''}; disabled plugins inject zero XML tokens`)
      : L("仅对当前会话生效，不影响全局默认与其他会话；关闭的插件不注入 XML 协议，零 Token 消耗", "Applies only to this session without changing global defaults; disabled plugins inject zero XML tokens");
  const pluginsTriggerTooltip = effectiveOutputPlugins.length === 0
    ? L("交互插件", "Output Plugins")
    : effectivePluginsScope === 'draft'
      ? L(`交互插件：新会话已启用 ${enabledPluginCount} / ${effectiveOutputPlugins.length}${overriddenPluginCount ? `（含 ${overriddenPluginCount} 项自定义）` : ''}`, `Output Plugins: ${enabledPluginCount}/${effectiveOutputPlugins.length} enabled${overriddenPluginCount ? ` (${overriddenPluginCount} custom)` : ''}`)
      : effectivePluginsScope === 'companion'
        ? L(`交互插件：主会话已启用 ${enabledPluginCount} / ${effectiveOutputPlugins.length}${overriddenPluginCount ? `（含 ${overriddenPluginCount} 项独立覆写）` : ' · 跟随全局'}`, `Output Plugins (Main): ${enabledPluginCount}/${effectiveOutputPlugins.length} enabled${overriddenPluginCount ? ` (${overriddenPluginCount} overridden)` : ' · Global'}`)
        : L(`交互插件：本会话已启用 ${enabledPluginCount} / ${effectiveOutputPlugins.length}${overriddenPluginCount ? `（含 ${overriddenPluginCount} 项独立覆写）` : ' · 跟随全局'}`, `Output Plugins: ${enabledPluginCount}/${effectiveOutputPlugins.length} enabled${overriddenPluginCount ? ` (${overriddenPluginCount} overridden)` : ' · Global'}`);
  const handlePluginToggle = (plugin: ComposerOutputPluginItem, nextEnabled: boolean) => {
    if (onSetOutputPlugin) {
      onSetOutputPlugin(plugin.id, nextEnabled);
      return;
    }
    if (plugin.id === BUILTIN_ASK_USER_QUESTION_PLUGIN_ID && onToggleAskUserQuestion) {
      onToggleAskUserQuestion();
    }
  };
  const sendLabel = modelReadiness.kind === 'blocked' && !lockedTarget ? modelReadiness.reason : sendLabelOverride ?? (draft ? L("创建会话并发送", "Create & Send") : L("发送消息", "Send Message"));
  const query = slashQuery(beforeCaret, beforeCaret.length);
  const commands = useMemo(() => {
    // ACP command updates vary by Agent: Codex advertises /plan, Claude advertises /fast.
    // Only offer Agent commands when the active Agent actually reports them; platform builtin
    // commands (such as /btw) are merged in front and deduplicated by name.
    const seen = new Set<string>();
    const list: ComposerCommand[] = [];
    for (const command of builtinCommands) {
      if (seen.has(command.name)) continue;
      seen.add(command.name);
      list.push(command);
    }
    for (const command of advertisedCommands) {
      if (!supportedCommands.has(command.name) || seen.has(command.name)) continue;
      seen.add(command.name);
      list.push(command);
    }
    return list;
  }, [advertisedCommands, builtinCommands]);
  const visibleCommands = commands.filter(command => query === undefined || command.name.toLowerCase().includes(query) || command.description.toLowerCase().includes(query));
  const visibleSkills = skills.filter(skill => query === undefined || skill.name.toLowerCase().includes(query) || skill.description.toLowerCase().includes(query));
  const commandPanel = panel === 'commands' || (query !== undefined && panel === undefined);
  const visibleModels = useMemo(() => filterAgentModels(models, modelQuery), [models, modelQuery]);

  const insertText = (text: string) => {
    const target = editor.current;
    if (!target) {
      onChange(`${value}${value && !/\s$/.test(value) ? ' ' : ''}${text}`);
    } else if (!target.replaceSlashWith(text)) {
      // 没有 `/查询` 就按普通文本插入；编辑器自己判断要不要补前导空格。
      target.insertAtCaret(text);
    }
    setPanel(undefined);
    requestAnimationFrame(() => editor.current?.focus());
  };
  const insertCommand = (name: string) => {
    const target = editor.current;
    if (target) {
      // 先按文档位置删掉光标前的 /查询，再把命令挪到整条消息开头。
      target.replaceSlashWith('');
      target.setValue(`/${name} ${target.getValue().trimStart()}`);
    } else {
      const withoutQuery = query === undefined ? value : replaceSlashQuery(value, '', value.length);
      onChange(`/${name} ${withoutQuery.trimStart()}`);
    }
    setPanel(undefined);
    requestAnimationFrame(() => editor.current?.focus());
  };
  const chooseCommand = (command: ComposerCommand) => insertCommand(command.name);
  const chooseSkill = (name: string) => {
    // Local SKILL.md entries are not necessarily commands advertised by the Agent.
    // Keep those as plain text so the CLI cannot reject them as unknown slash commands.
    if (advertisedCommands.some(command => command.name === name)) insertCommand(name);
    else insertText(L(`请使用 ${name} 技能： `, `Use the ${name} skill: `));
  };
  const addReference = (kind: ComposerReference['kind'], label: string, referenceValue: string) => {
    const normalized = referenceValue.trim();
    if (!normalized || references.some(reference => reference.kind === kind && reference.value === normalized)) return;
    onReferencesChange(current => [...current, { id: `${kind}-${normalized}`, kind, label, value: normalized }]);
    setPanel(undefined);
    requestAnimationFrame(() => editor.current?.focus());
  };
  // 返回 true = 已处理，由编辑器阻止默认行为。
  // Enter 发送；Shift+Enter 换行。命令面板打开时，Enter 选择第一项。
  const keyboard = (event: KeyboardEvent): boolean => {
    // 读输入框此刻的文档，而不是 may-be-200ms 前的 controlled value。
    const currentValue = composerSubmitValue(editor.current?.getValue(), value);
    const action = composerKeyAction(event, {
      guard: compositionGuard,
      panelOpen: Boolean(panel || query !== undefined),
      commandPanel,
      hasCommand: Boolean(visibleCommands[0]),
      hasSkill: Boolean(visibleSkills[0]),
      canSend: canSendValue(currentValue)
    });
    switch (action.type) {
      case 'ignore':
      case 'newline':
      case 'pass':
        return false;
      case 'dismiss':
        setPanel(undefined);
        return true;
      // 命令面板打开时，无修饰键的 Enter 仍然选择第一项；其余情况 Enter 发送。
      case 'choose-command':
        chooseCommand(visibleCommands[0]!);
        return true;
      case 'choose-skill':
        chooseSkill(visibleSkills[0]!.name);
        return true;
      case 'send':
        setSubmitEpoch(epoch => epoch + 1);
        onSubmit(currentValue);
        return true;
      // Enter 一律吞掉，不能在发送失败时偷偷换行。
      case 'handled':
        return true;
    }
  };

  const uploadFile = async (file: File | Blob) => {
    const name = 'name' in file ? file.name : L("（未命名文件）", "(Untitled file)");
    setUploading(current => [...current, name]);
    try {
      // 草稿态没有可上传的 sessionId：交给上层暂存，先展示一枚引用 chip。
      if (onAttachFile) {
        const reference = await onAttachFile(file);
        if (reference) onReferencesChange(current => [...current, reference]);
        setUploadError(undefined);
        return;
      }
      const result = await uploadSessionFile(sessionId, file);
      // 用函数式更新：并行上传时避免读到过期的 references 互相覆盖。
      onReferencesChange(current => [...current, referenceFromUpload(result, file.type.startsWith('image/'))]);
      setUploadError(undefined);
    } catch (error) {
      console.error('File upload failed', error);
      setUploadError(L(`文件上传失败：${error instanceof Error ? error.message : String(error)}`, `Upload failed: ${error instanceof Error ? error.message : String(error)}`));
    } finally {
      setUploading(current => current.filter(item => item !== name));
    }
  };

  // 编辑器内部的文件粘贴 / 拖放由 ComposerEditor 处理（它会 preventDefault，避免 CodeMirror 把文件当文本读入）。
  // 这里兜底处理落在卡片其他区域（内边距、底栏）的拖放。
  const onDrop = (event: React.DragEvent<HTMLDivElement>) => {
    if (event.defaultPrevented) return;
    event.preventDefault();
    const files = event.dataTransfer?.files;
    if (!files) return;
    for (const file of files) {
      void uploadFile(file);
    }
  };

  const onDragOver = (event: React.DragEvent<HTMLDivElement>) => {
    if (event.dataTransfer?.types?.includes('Files')) {
      event.preventDefault();
    }
  };

  const resolvedComposerAiContext = useCallback((): LlmAssistContext => {
    const base = typeof aiContext === 'function' ? aiContext() : (aiContext ?? {});
    return {
      field: draft ? L("新会话首条消息", "First message for new session") : L("会话消息输入框", "Session message input"),
      ...(currentAgent?.name ? { agentName: currentAgent.name } : {}),
      ...(workspacePath ? { cwd: workspacePath } : {}),
      ...(currentModel ? { model: currentModel } : {}),
      ...base
    };
  }, [aiContext, draft, currentAgent?.name, workspacePath, currentModel]);

  const applyComposerAiText = useCallback((next: string) => {
    if (editor.current) {
      editor.current.setValue(next);
      requestAnimationFrame(() => editor.current?.focus());
    } else {
      onChange(next);
    }
  }, [onChange]);

  return <div className={draft ? 'w-full' : 'bg-gradient-to-t from-canvas via-canvas to-transparent px-3 pb-[max(1rem,env(safe-area-inset-bottom))] pt-3 sm:px-8 sm:pb-[max(1.25rem,env(safe-area-inset-bottom))] sm:pt-7'}><div className="mx-auto w-full max-w-[760px]">
    {!draft && <QueuedTasks tasks={queuedTasks} cancellingTaskId={cancellingTaskId} steeringTaskId={steeringTaskId} editingTaskId={editingTaskId} onCancel={onCancelQueued} onSteer={onSteerQueued} onEdit={onEditQueued}/>}
    <div onDrop={onDrop} onDragOver={onDragOver} data-interrupting-send={interruptingSend ? '' : undefined} className={`relative rounded-[20px] border bg-white p-1.5 shadow-[0_1px_2px_rgba(0,0,0,.04)] transition-[border-color,box-shadow,background-color] duration-150 ease-out sm:p-2 ${interruptingSend ? 'border-orange-200 ring-1 ring-orange-200/70' : 'border-zinc-200 hover:border-zinc-300 focus-within:border-zinc-400'} ${queuedTasks.length ? 'rounded-t-[10px]' : ''} ${composerFlash.flashClass}`}>
      <ExitGate open={Boolean(commandPanel || panel === 'models' || panel === 'reasoning' || panel === 'agent' || panel === 'workspace' || panel === 'systemPrompt' || panel === 'plugins')} ms={150}><div ref={popover} data-placement="top" className="ui-popover absolute bottom-[calc(100%+8px)] left-0 z-20 w-full overflow-hidden rounded-xl border border-zinc-200 bg-white shadow-[0_18px_55px_rgba(24,24,27,.16)] sm:left-2 sm:w-[460px]">
        {commandPanel && <div className="max-h-80 overflow-y-auto p-1.5">{visibleCommands.length > 0 && <div className="px-2.5 pb-1.5 pt-1 text-[12px] font-semibold text-zinc-400">{L("命令", "Commands")}</div>}{visibleCommands.map(command => <button key={command.name} type="button" onMouseDown={event => event.preventDefault()} onClick={() => chooseCommand(command)} className="flex w-full items-center gap-3 rounded-lg px-2.5 py-2 text-left hover:bg-zinc-100"><span className="grid h-7 w-7 place-items-center rounded-lg bg-zinc-100 font-mono text-[13px] text-zinc-700">/</span><span className="min-w-0"><span className="block text-[12px] font-medium text-zinc-800">/{command.name}</span><span className="block truncate text-[12px] text-zinc-500">{command.description || L("Agent 提供的命令", "Commands provided by Agent")}</span></span></button>)}{visibleSkills.length > 0 && <div className="mx-2 mt-1 border-t border-zinc-100 px-0.5 pb-1 pt-2 text-[12px] font-semibold text-zinc-400">Skills</div>}{visibleSkills.map(skill => <button key={skill.path} type="button" onMouseDown={event => event.preventDefault()} onClick={() => chooseSkill(skill.name)} className="flex w-full items-center gap-3 rounded-lg px-2.5 py-2 text-left hover:bg-zinc-100"><span className="grid h-7 w-7 place-items-center rounded-lg bg-amber-50 text-amber-700"><Sparkles size={13}/></span><span className="min-w-0"><span className="block text-[12px] font-medium text-zinc-800">{skill.name}</span><span className="block truncate text-[12px] text-zinc-500">{skill.description || skill.path}</span></span></button>)}{!visibleCommands.length && !visibleSkills.length && <div className="px-3 py-5 text-center text-xs text-zinc-500">{L("没有匹配项", "No matches")}</div>}</div>}
        {panel === 'models' && <div><div className="flex items-center border-b border-zinc-100 px-3 py-2.5"><Gauge size={13} className="mr-2 text-zinc-500"/><span className="text-xs font-semibold">{L("切换模型", "Switch Model")}</span>{refreshingModels && <span className="ml-auto text-[12px] text-zinc-400">{L("正在刷新…", "Refreshing…")}</span>}<button type="button" disabled={refreshingModels} onClick={onRefreshModels} className={`${refreshingModels ? 'ml-1' : 'ml-auto'} grid h-7 w-7 place-items-center rounded-md text-zinc-500 transition-colors hover:bg-zinc-100 disabled:cursor-wait disabled:text-zinc-400`} aria-label={refreshingModels ? L("正在刷新模型列表", "Refreshing models") : L("刷新模型列表", "Refresh models")} title={refreshingModels ? L("正在刷新模型列表", "Refreshing models") : L("刷新模型列表", "Refresh models")}><RefreshCw size={12} className={refreshingModels ? 'animate-spin' : ''}/></button></div>
          <div className="flex items-center gap-1.5 border-b border-zinc-100 px-2.5 py-2"><Search size={13} className="shrink-0 text-zinc-400"/><input autoFocus value={modelQuery} onChange={event => setModelQuery(event.target.value)} onKeyDown={event => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); if (modelQuery) setModelQuery(''); else setPanel(undefined); } else if (event.key === 'Enter') { event.preventDefault(); if (visibleModels[0]) { onModelChange(visibleModels[0].id); setPanel(undefined); } } }} placeholder={L("搜索名称或模型 ID", "Search name or model ID")} aria-label={L("搜索模型", "Search models")} spellCheck={false} className="h-8 min-w-0 flex-1 rounded-md border border-zinc-300 bg-white px-2 text-[12px] text-zinc-700 outline-none placeholder:text-zinc-400 focus:border-zinc-400"/>{modelQuery && <button type="button" onClick={() => setModelQuery('')} aria-label={L("清空模型搜索", "Clear model search")} className="grid h-6 w-6 shrink-0 place-items-center rounded-md text-zinc-400 hover:bg-zinc-100 hover:text-zinc-700"><X size={12}/></button>}</div>
          <div className="max-h-72 overflow-y-auto p-1.5">{visibleModels.map(model => {
            const isSelected = model.id === activeModelId;
            const isPendingRow = switchingModel && model.id === pendingModel;
            return <button key={model.id} type="button" disabled={isSelected} onClick={() => { onModelChange(model.id); setPanel(undefined); }} className="ui-press flex w-full items-center rounded-lg px-2.5 py-2 text-left text-xs text-zinc-700 hover:bg-zinc-100 disabled:opacity-60"><span className="flex w-5 shrink-0 items-center">{isPendingRow ? <Spinner size={11} label={L("切换中", "Switching")} className="text-sky-600"/> : isSelected ? <Check size={12}/> : null}</span><span className="min-w-0 flex-1 truncate">{model.name}</span>{isPendingRow ? <span className="ml-2 shrink-0 text-[11px] font-medium text-sky-600">{L("切换中…", "Switching…")}</span> : model.name !== model.id ? <span className="ml-3 max-w-[48%] truncate font-mono text-[12px] text-zinc-400">{model.id}</span> : null}</button>;
          })}{!visibleModels.length && <div className={`mx-1 my-1 rounded-lg px-3 py-5 text-center text-xs ${modelReadiness.kind === 'blocked' ? 'bg-red-50 text-red-700' : 'text-zinc-500'}`}>{modelQuery.trim() ? L("没有匹配的模型", "No matching models") : modelReadiness.kind === 'ready' ? L("Agent 未提供可切换模型", "No switchable models from Agent") : modelReadiness.reason}</div>}</div></div>}
        {panel === 'reasoning' && <div><div className="flex items-center border-b border-zinc-100 px-3 py-2.5"><BrainCircuit size={13} className="mr-2 text-zinc-500"/><span className="text-xs font-semibold">{L("思考深度", "Reasoning")}</span>{refreshingModels && <span className="ml-auto inline-flex items-center gap-1 text-[11px] text-zinc-400"><Spinner size={11} label={L("正在刷新", "Refreshing")}/>{L("刷新中…", "Refreshing…")}</span>}</div><div className="max-h-72 overflow-y-auto p-1.5">{reasoningEfforts.map(effort => {
            const isSelected = effort.id === activeReasoningId;
            const isPendingRow = switchingReasoningEffort && effort.id === pendingReasoningEffort;
            return <button key={effort.id} type="button" disabled={isSelected} onClick={() => { onReasoningEffortChange(effort.id); setPanel(undefined); }} className="ui-press flex w-full items-center rounded-lg px-2.5 py-2 text-left text-xs text-zinc-700 hover:bg-zinc-100 disabled:opacity-60"><span className="flex w-5 shrink-0 items-center">{isPendingRow ? <Spinner size={11} label={L("切换中", "Switching")} className="text-sky-600"/> : isSelected ? <Check size={12}/> : null}</span><span className="min-w-0 flex-1 truncate">{effort.name}</span>{isPendingRow && <span className="ml-2 shrink-0 text-[11px] font-medium text-sky-600">{L("切换中…", "Switching…")}</span>}</button>;
          })}{!reasoningEfforts.length && <div className="px-3 py-6 text-center text-xs text-zinc-500">{refreshingModels ? L("正在读取可选思考深度…", "Loading reasoning efforts…") : L("当前模型未提供思考深度选项", "No reasoning options for this model")}</div>}</div></div>}
        {panel === 'agent' && <div>
          <div className="flex items-center border-b border-zinc-100 px-3 py-2.5"><Bot size={13} className="mr-2 text-zinc-500"/><span className="text-xs font-semibold">{L("选择 Agent", "Select Agent")}</span></div>
          <div className="max-h-72 overflow-y-auto p-1.5">
            {(agents ?? []).map(agent => <button key={agent.id} type="button" onClick={() => { onAgentChange?.(agent.id); setPanel(undefined); }} className="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-xs text-zinc-700 hover:bg-zinc-100"><span className="w-5 shrink-0">{agent.id === currentAgentId && <Check size={12}/>}</span><AgentIcon agentId={agent.id} agentName={agent.name} size={14}/><span className="min-w-0 flex-1 truncate">{agent.name}</span></button>)}
            {!(agents ?? []).length && <div className="px-3 py-6 text-center text-xs text-zinc-500">{L("没有可用 Agent", "No available Agents")}</div>}
          </div>
        </div>}
        {panel === 'workspace' && <div>
          <div className="flex items-center border-b border-zinc-100 px-3 py-2.5"><FolderOpen size={13} className="mr-2 text-zinc-500"/><span className="text-xs font-semibold">{L("工作目录", "Workspace")}</span><span className="ml-auto hidden text-[12px] text-zinc-400 sm:inline">{L("回车应用", "Enter to apply")}</span></div>
          <div className="flex items-center gap-1.5 border-b border-zinc-100 px-2.5 py-2">
            <input autoFocus value={wsDraft} onChange={event => setWsDraft(event.target.value)} onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); onWorkspaceChange?.(wsDraft.trim()); setPanel(undefined); } }} placeholder={workspaceSuggestion ?? L("/绝对路径", "/absolute/path")} spellCheck={false} className="h-8 min-w-0 flex-1 rounded-md border border-zinc-300 bg-white px-2 font-mono text-[12px] text-zinc-700 outline-none placeholder:text-zinc-400"/>
            {directoryPickerAvailable && <button type="button" disabled={pickingDirectory} onClick={() => { onPickDirectory?.(); setPanel(undefined); }} title={pickingDirectory ? L("选择中…", "Selecting…") : L("选择目录", "Browse")} aria-label={L("选择目录", "Browse")} className="grid h-8 w-8 shrink-0 place-items-center rounded-md text-zinc-500 hover:bg-zinc-100 hover:text-zinc-800 disabled:opacity-40">{pickingDirectory ? <RefreshCw size={13} className="animate-spin"/> : <FolderOpen size={13}/>}</button>}
          </div>
          <div className="max-h-72 overflow-y-auto p-1.5">
            <button type="button" onClick={() => { onWorkspaceChange?.(''); setPanel(undefined); }} className="flex w-full items-center gap-2 rounded-lg px-2.5 py-2.5 text-left hover:bg-zinc-100"><span className="w-4 shrink-0">{!workspacePath && <Check size={12}/>}</span><span className="min-w-0 flex-1 truncate text-[13px] text-zinc-700">{L("使用 Agent 默认目录", "Use Agent default directory")}</span></button>
            {(workspaceOptions ?? []).map(path => <button key={path} type="button" onClick={() => { onWorkspaceChange?.(path); setPanel(undefined); }} className="flex w-full items-start gap-2 rounded-lg px-2.5 py-2 text-left hover:bg-zinc-100"><span className="mt-0.5 w-4 shrink-0">{workspacePath === path && <Check size={12}/>}</span><span className="min-w-0 flex-1"><span className="block truncate text-[13px] text-zinc-700">{displayWorkspaceLabel(path, homeDirectory)}</span><span className="mt-0.5 block truncate font-mono text-[12px] text-zinc-400">{path}</span></span></button>)}
            {!(workspaceOptions ?? []).length && <div className="px-3 py-4 text-center text-[12px] text-zinc-400">{L("还没有其他工作区", "No other workspaces yet")}</div>}
          </div>
        </div>}
        {panel === 'systemPrompt' && onSystemPromptChange && <div>
          <div className="flex flex-wrap items-center gap-2 border-b border-zinc-100 px-3 py-2">
            <BookOpen size={13} className="shrink-0 text-zinc-500"/>
            <span className="text-xs font-semibold text-zinc-900">{L("会话 System Prompt", "Session System Prompt")}</span>
            <div className="ml-auto flex items-center gap-1.5">
              <AiTextAssistControl
                mode="prompt_write"
                variant="pill"
                size="xs"
                popoverSide="top"
                popoverAlign="end"
                value={systemPrompt ?? ''}
                onChange={onSystemPromptChange}
                onFlash={systemPromptFlash.triggerFlash}
                context={() => ({
                  field: L("新会话 System Prompt", "New Session System Prompt"),
                  purpose: L("创建会话时隐式注入给 Agent 的系统提示词，约束角色、工作规范与输出风格", "System prompt implicitly injected at session creation to guide role, rules, and output style"),
                  ...(currentAgent?.name ? { agentName: currentAgent.name } : {}),
                  ...(workspacePath ? { cwd: workspacePath } : {}),
                  ...(currentModel ? { model: currentModel } : {})
                })}
                testId="draft-system-prompt-ai"
              />
            </div>
          </div>
          <div className="space-y-2 p-3">
            <textarea
              autoFocus
              rows={5}
              value={systemPrompt ?? ''}
              onChange={event => onSystemPromptChange(event.target.value)}
              onKeyDown={event => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); setPanel(undefined); } }}
              placeholder={L("可选：为本会话设定角色、编码约束或输出要求，创建会话时自动写入 Agent System Prompt…", "Optional: define role, coding rules, or output style for this session…")}
              aria-label={L("会话 System Prompt", "Session System Prompt")}
              className={`ui-field w-full resize-y rounded-lg border border-zinc-200 bg-white px-2.5 py-2 font-mono text-[12px] leading-5 text-zinc-800 outline-none placeholder:text-zinc-400 ${systemPromptFlash.flashClass}`}
            />
            <div className="flex items-center justify-between gap-2 text-[11.5px] text-zinc-400">
              <span className="tabular-nums">{(systemPrompt ?? '').length}  {L("字 · 创建会话时注入", " chars · Injected on creation")}</span>
              <div className="flex items-center gap-1.5">
                {Boolean(systemPrompt?.trim()) && <button type="button" onClick={() => onSystemPromptChange('')} className="rounded-md px-2 py-1 text-zinc-500 hover:bg-zinc-100 hover:text-zinc-800">{L("清空", "Clear")}</button>}
                <button type="button" onClick={() => setPanel(undefined)} className="rounded-md bg-zinc-900 px-2.5 py-1 font-medium text-white hover:bg-zinc-700">{L("完成", "Done")}</button>
              </div>
            </div>
          </div>
        </div>}
        {panel === 'plugins' && effectiveOutputPlugins.length > 0 && <div data-testid="composer-output-plugins-popover" data-scope={effectivePluginsScope}>
          <div className="flex flex-wrap items-center gap-2 border-b border-zinc-100 px-3 py-2.5">
            <Puzzle size={13} className="shrink-0 text-sky-600 dark:text-sky-400"/>
            <span className="text-xs font-semibold text-zinc-900">{pluginsPopoverTitle}</span>
            <span className="rounded-full border border-zinc-200 bg-zinc-50 px-1.5 py-px text-[10.5px] font-medium tabular-nums text-zinc-500">
              {enabledPluginCount} / {effectiveOutputPlugins.length}  {L("已启用", "Enabled")}
            </span>
            <div className="ml-auto flex shrink-0 items-center gap-1">
              {overriddenPluginCount > 0 && onResetAllOutputPlugins && (
                <button
                  type="button"
                  data-testid="composer-plugins-reset-all"
                  onClick={() => onResetAllOutputPlugins()}
                  className="ui-press inline-flex h-6 items-center gap-1 rounded-md px-2 text-[11px] font-medium text-zinc-500 hover:bg-zinc-100 hover:text-zinc-800"
                >
                  <RotateCcw size={11}/>
                  <span>{L("恢复默认", "Reset Defaults")}</span>
                </button>
              )}
              {onOpenOutputPluginsCenter && (
                <button
                  type="button"
                  data-testid="composer-plugins-open-center"
                  onClick={() => { setPanel(undefined); onOpenOutputPluginsCenter(); }}
                  className="ui-press inline-flex h-6 items-center gap-1 rounded-md px-2 text-[11px] font-medium text-zinc-500 hover:bg-zinc-100 hover:text-zinc-800"
                >
                  <Settings2 size={11}/>
                  <span>{L("全局插件中心", "Plugin Center")}</span>
                </button>
              )}
            </div>
          </div>
          <div data-testid="composer-plugins-scope-banner" className="border-b border-zinc-100 bg-zinc-50/60 px-3 py-1.5 text-[11px] leading-4 text-zinc-500">
            {pluginsScopeBannerText}
          </div>
          <div className="max-h-72 divide-y divide-zinc-100 overflow-y-auto p-1.5">
            {effectiveOutputPlugins.map(plugin => {
              const localizedPlugin = localizeOutputPluginDisplay(plugin, locale);
              const rowPending = switchingOutputPluginId === plugin.id
                || (plugin.id === BUILTIN_ASK_USER_QUESTION_PLUGIN_ID && switchingAskUserQuestion);
              const isOverridden = plugin.override !== null;
              const overrideText = plugin.override === true
                ? (effectivePluginsScope === 'draft' ? L("新会话开启", "On for new session") : effectivePluginsScope === 'companion' ? L("仅主会话开启", "On for main only") : L("仅本会话开启", "On for session only"))
                : (effectivePluginsScope === 'draft' ? L("新会话关闭", "Off for new session") : effectivePluginsScope === 'companion' ? L("仅主会话关闭", "Off for main only") : L("仅本会话关闭", "Off for session only"));
              const overrideBadgeClass = plugin.override === true
                ? 'border-emerald-200 bg-emerald-50 text-emerald-700 dark:text-emerald-300'
                : 'border-amber-200 bg-amber-50 text-amber-700 dark:text-amber-300';
              return (
                <div
                  key={plugin.id}
                  data-testid={`composer-plugin-row-${plugin.id}`}
                  data-plugin-id={plugin.id}
                  data-state={plugin.enabled ? 'on' : 'off'}
                  data-override={isOverridden ? 'explicit' : 'inherit'}
                  className="flex items-start gap-2.5 rounded-lg px-2 py-2 transition-colors hover:bg-zinc-50"
                >
                  <span className={`mt-0.5 grid h-7 w-7 shrink-0 place-items-center rounded-lg border ${
                    plugin.enabled
                      ? 'border-sky-200/90 bg-sky-50 text-sky-700 dark:text-sky-300'
                      : 'border-zinc-200 bg-zinc-50 text-zinc-400'
                  }`}>
                    <PluginIcon name={plugin.icon} size={13}/>
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <span className="truncate text-[12.5px] font-medium text-zinc-900">{localizedPlugin.name}</span>
                      {!plugin.builtin && (
                        <span className="shrink-0 rounded-full border border-amber-200 bg-amber-50 px-1.5 py-px text-[10px] font-medium text-amber-700 dark:text-amber-300">
                          
                          {L("扩展", "Custom")}
                        </span>
                      )}
                      {isOverridden ? (
                        <span className={`inline-flex shrink-0 items-center gap-1 rounded-full border px-1.5 py-px text-[10px] font-medium ${overrideBadgeClass}`}>
                          <span>{overrideText}</span>
                          {onSetOutputPlugin && (
                            <button
                              type="button"
                              aria-label={L(`恢复「${localizedPlugin.name}」跟随全局默认`, `Reset "${localizedPlugin.name}" to global default`)}
                              onClick={() => onSetOutputPlugin(plugin.id, null)}
                              className="ml-0.5 underline opacity-80 hover:opacity-100"
                            >
                              
                              {L("重置", "Reset")}
                            </button>
                          )}
                        </span>
                      ) : (
                        <span className="shrink-0 text-[10.5px] text-zinc-400">
                          
                          {L("跟随全局", "Follow Global")}
                        </span>
                      )}
                    </div>
                    <p className="mb-0 mt-0.5 line-clamp-1 text-[11px] leading-4 text-zinc-500">
                      {localizedPlugin.description}
                    </p>
                  </div>
                  <Switch
                    size="small"
                    className="mt-1 shrink-0"
                    aria-label={L(`切换插件：${localizedPlugin.name}`, `Toggle plugin: ${localizedPlugin.name}`)}
                    checked={plugin.enabled}
                    loading={rowPending}
                    disabled={sending}
                    onChange={checked => handlePluginToggle(plugin, checked)}
                  />
                </div>
              );
            })}
          </div>
        </div>}
      </div></ExitGate>
      {uploadError && <div className="ui-status-banner-in mx-2.5 mb-1 flex items-center gap-1.5 rounded-lg border border-red-100 bg-red-50 px-2.5 py-1.5 text-[12px] text-red-700"><AlertCircle size={12} className="shrink-0"/><span className="min-w-0 flex-1 truncate" title={uploadError}>{uploadError}</span><button type="button" onClick={() => setUploadError(undefined)} aria-label={L("关闭上传错误提示", "Dismiss upload error")} className="shrink-0 text-red-400 hover:text-red-700"><X size={11}/></button></div>}
      {quotedText && <div data-testid="composer-quote-bar" className="ui-status-banner-in mx-1.5 mb-1 mt-0.5 flex items-start gap-2 rounded-xl border border-zinc-200/80 bg-zinc-50/90 px-2.5 py-2 text-[12px] leading-[1.45] text-zinc-600">
        <span aria-hidden="true" className="mt-0.5 w-[2.5px] shrink-0 self-stretch rounded-full bg-zinc-400"/>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1 text-[11px] font-medium text-zinc-400"><CornerDownRight size={11} className="shrink-0"/><span>{L("引用回复", "Quoted Reply")}</span></div>
          <p className="mt-0.5 line-clamp-2 whitespace-pre-wrap break-words text-[12px] text-zinc-700" title={quotedText}>{quotedText}</p>
        </div>
        {onClearQuote && <button type="button" data-testid="composer-quote-clear" onClick={onClearQuote} aria-label={L("取消引用", "Remove quote")} className="grid h-5 w-5 shrink-0 place-items-center rounded-md text-zinc-400 transition-colors hover:bg-zinc-200/80 hover:text-zinc-800"><X size={12}/></button>}
      </div>}
      {references.length > 0 && <div className="flex flex-wrap gap-1.5 px-2.5 pb-1.5 pt-1">{references.map(reference => <span key={reference.id} className="flex max-w-full items-center gap-1.5 rounded-lg border border-zinc-200 bg-zinc-50 px-2 py-1 text-[12px] text-zinc-600">{reference.kind === 'image' ? (reference.url ? <img src={reference.url} alt={reference.label} className="h-5 w-5 rounded object-cover" /> : <ImageIcon size={11}/>) : reference.kind === 'file' ? <File size={11}/> : <Sparkles size={11}/>}<span className="truncate font-mono">{reference.label}</span><button type="button" onClick={() => onReferencesChange(current => current.filter(item => item.id !== reference.id))} aria-label={L(`移除引用 ${reference.label}`, `Remove reference ${reference.label}`)} className="text-zinc-400 hover:text-zinc-800"><X size={10}/></button></span>)}</div>}
      {uploading.length > 0 && <div className="flex items-center gap-1.5 px-2.5 pb-1 text-[12px] text-zinc-500"><RefreshCw size={11} className="shrink-0 animate-spin text-zinc-400"/><span className="truncate">{L("正在上传", "Uploading")} {uploading.length > 1 ? L(`${uploading.length} 个文件`, `${uploading.length} file(s)`) : uploading[0]}…</span></div>}
      <ComposerEditor ref={node => { editor.current = node; if (externalEditorRef) externalEditorRef.current = node; }} value={value} ariaLabel={L("消息", "Message")} placeholder={placeholder ?? <><span className="hidden sm:inline">{L("输入消息，Enter 发送，Shift+Enter 换行；/ 选择 Skill 或命令，可粘贴/拖入文件", "Type a message (Enter to send, Shift+Enter for newline; / for Skills or commands, paste/drop files)")}</span><span className="sm:hidden">{L("输入消息，/ 选择命令", "Type a message, / for commands")}</span></>} onChange={next => { onChange(next); if (panel !== 'models' && panel !== 'reasoning' && panel !== 'systemPrompt' && panel !== 'plugins') setPanel(undefined); }} onCaretChange={setBeforeCaret} onContentChange={setEditorHasContent} onKeydown={keyboard} compositionGuard={compositionGuard} onFiles={files => { for (const file of files) void uploadFile(file); }}/>
      {aiUndo?.canUndo && <div className="mx-1.5 mb-1 flex items-center justify-end">
        <AiUndoCapsule undoDepth={aiUndo.undoDepth} lastLabel={aiUndo.lastLabel} undoing={aiUndo.undoing} onUndo={aiUndo.undo} onDismiss={aiUndo.clearUndo}/>
      </div>}
      <div className={`flex min-w-0 items-center gap-x-0.5 gap-y-1 px-0.5 pb-1 sm:flex-nowrap sm:gap-1 sm:px-1 ${draft && !lockedTarget ? 'flex-wrap' : ''}`}><button type="button" data-composer-panel-trigger onClick={() => setPanel(panel === 'commands' ? undefined : 'commands')} className="ui-press grid h-8 w-7 shrink-0 place-items-center rounded-lg font-mono text-[16px] text-zinc-500 hover:bg-zinc-100 hover:text-zinc-800 sm:w-8" aria-label={L("打开命令与 Skill 菜单", "Open commands & Skills menu")} title={L("命令与 Skill（/）", "Commands & Skills (/)")}>/</button><button type="button" onClick={() => imageInput.current?.click()} className="ui-press grid h-8 w-7 shrink-0 place-items-center rounded-lg text-zinc-500 hover:bg-zinc-100 hover:text-zinc-800 sm:w-8" aria-label={L("上传文件", "Upload File")} title={uploading.length ? L("文件上传中…", "Uploading files…") : L("上传文件", "Upload File")}>{uploading.length > 0 ? <RefreshCw size={14} className="animate-spin"/> : <Paperclip size={14}/>}</button><input ref={imageInput} type="file" multiple className="hidden" onChange={event => { const files = event.target.files; if (files) { for (const file of files) void uploadFile(file); } event.target.value = ''; }}/><div className={draft && !lockedTarget ? 'order-first flex w-full min-w-0 flex-wrap items-center gap-1 border-b border-zinc-100 pb-1 sm:order-none sm:w-auto sm:flex-1 sm:flex-nowrap sm:gap-1 sm:overflow-x-auto sm:border-b-0 sm:pb-0 no-scrollbar' : 'no-scrollbar flex min-w-0 flex-1 items-center gap-0.5 overflow-x-auto sm:gap-1'}>{lockedTarget}{!lockedTarget && <>{draft && <button type="button" data-composer-panel-trigger onClick={() => setPanel(panel === 'agent' ? undefined : 'agent')} title={currentAgent?.name ?? L("选择 Agent", "Select Agent")} className={`ui-press flex h-7 min-w-0 max-w-[136px] shrink-0 items-center gap-1 rounded-lg px-1.5 text-[12px] hover:bg-zinc-100 hover:text-zinc-800 sm:h-8 sm:max-w-[8rem] sm:gap-1 sm:px-1.5 ${panel === 'agent' ? 'bg-zinc-100 text-zinc-900' : 'text-zinc-500'}`}><AgentIcon agentId={currentAgentId} agentName={currentAgent?.name} size={12}/><span className="truncate">{currentAgent?.name ?? L("选择 Agent", "Select Agent")}</span><ChevronDown size={10} className={`shrink-0 transition-transform duration-150 ${panel === 'agent' ? 'rotate-180' : ''}`}/></button>}{draft && <button type="button" data-composer-panel-trigger onClick={() => { setWsDraft(workspacePath); setPanel(panel === 'workspace' ? undefined : 'workspace'); }} title={workspacePath || L("工作目录", "Workspace")} className={`ui-press flex h-7 min-w-0 max-w-[116px] shrink-0 items-center gap-1 rounded-lg px-1.5 text-[12px] hover:bg-zinc-100 hover:text-zinc-800 sm:h-8 sm:max-w-[5.75rem] sm:gap-1 sm:px-1.5 ${panel === 'workspace' ? 'bg-zinc-100 text-zinc-900' : 'text-zinc-500'}`}><Folder size={12} className="shrink-0"/><span className="truncate">{workspaceLabel}</span><ChevronDown size={10} className={`shrink-0 transition-transform duration-150 ${panel === 'workspace' ? 'rotate-180' : ''}`}/></button>}<button type="button" data-composer-panel-trigger data-testid="composer-model-trigger" data-state={modelChipState} aria-busy={switchingModel || modelCatalogLoading || undefined} onClick={() => { setModelQuery(''); setPanel(current => current === 'models' ? undefined : 'models'); }} title={modelTitle} className={`ui-press flex h-7 min-w-0 shrink-0 items-center rounded-lg border text-[12px] transition-colors sm:h-8 ${draft ? 'gap-1 px-1.5 sm:max-w-[8.25rem] sm:gap-1 sm:px-1.5' : 'gap-0.5 px-1 sm:max-w-[16rem] sm:gap-1.5 sm:px-2'} ${switchingModel ? 'ui-chip-loading max-w-[112px]' : modelJustSwitched ? (draft ? 'ui-chip-saved max-w-[112px]' : 'ui-chip-saved max-w-[88px]') : modelCatalogLoading ? 'max-w-[104px] border-zinc-200/80 bg-zinc-50 text-zinc-500' : panel === 'models' ? (draft ? 'max-w-[112px] border-transparent bg-zinc-100 text-zinc-900' : 'max-w-[88px] border-transparent bg-zinc-100 text-zinc-900') : (draft ? 'max-w-[112px] border-transparent text-zinc-500 hover:bg-zinc-100 hover:text-zinc-800' : 'max-w-[88px] border-transparent text-zinc-500 hover:bg-zinc-100 hover:text-zinc-800')}`}>{switchingModel ? <Spinner size={12} label={L("正在切换模型", "Switching model")} className="shrink-0 text-sky-600"/> : modelCatalogLoading ? <Spinner size={12} label={L("正在读取模型列表", "Loading models")} className="shrink-0 text-zinc-400"/> : modelJustSwitched ? <Check key="model-saved" size={12} className="ui-icon-pop shrink-0 text-emerald-600"/> : <Gauge size={12} className="shrink-0"/>}<span className="truncate sm:hidden">{modelCompactDisplay}</span><span className="hidden truncate sm:inline">{modelDisplay}</span><ChevronDown size={10} className={`shrink-0 transition-transform duration-150 ${panel === 'models' ? 'rotate-180' : ''}`}/></button><button type="button" data-composer-panel-trigger data-testid="composer-reasoning-trigger" data-state={reasoningChipState} aria-busy={switchingReasoningEffort || reasoningCatalogLoading || undefined} onClick={() => setPanel(panel === 'reasoning' ? undefined : 'reasoning')} title={reasoningTitle} className={`ui-press flex h-7 min-w-0 shrink-0 items-center rounded-lg border text-[12px] transition-colors sm:h-8 ${draft ? 'gap-1 px-1.5 sm:max-w-[6.25rem] sm:gap-1 sm:px-1.5' : 'gap-0.5 px-1 sm:max-w-[10rem] sm:gap-1.5 sm:px-2'} ${switchingReasoningEffort ? 'ui-chip-loading max-w-[92px]' : reasoningJustSwitched ? (draft ? 'ui-chip-saved max-w-[104px]' : 'ui-chip-saved max-w-[88px]') : reasoningCatalogLoading ? 'max-w-[92px] border-zinc-200/80 bg-zinc-50 text-zinc-500' : panel === 'reasoning' ? (draft ? 'max-w-[104px] border-transparent bg-zinc-100 text-zinc-900' : 'max-w-[88px] border-transparent bg-zinc-100 text-zinc-900') : (draft ? 'max-w-[104px] border-transparent text-zinc-500 hover:bg-zinc-100 hover:text-zinc-800' : 'max-w-[88px] border-transparent text-zinc-500 hover:bg-zinc-100 hover:text-zinc-800')}`}>{switchingReasoningEffort ? <Spinner size={12} label={L("正在切换思考深度", "Switching reasoning effort")} className="shrink-0 text-sky-600"/> : reasoningCatalogLoading ? <Spinner size={12} label={L("正在读取思考深度", "Loading reasoning effort")} className="shrink-0 text-zinc-400"/> : reasoningJustSwitched ? <Check key="reasoning-saved" size={12} className="ui-icon-pop shrink-0 text-emerald-600"/> : <BrainCircuit size={12} className="shrink-0"/>}<span className="truncate">{reasoningTriggerDisplay}</span><ChevronDown size={10} className={`shrink-0 transition-transform duration-150 ${panel === 'reasoning' ? 'rotate-180' : ''}`}/></button>{draft && onSystemPromptChange && <HoverTooltip content={L("会话 System Prompt", "Session System Prompt")} side="top"><button type="button" data-composer-panel-trigger data-testid="draft-system-prompt-trigger" onClick={() => setPanel(panel === 'systemPrompt' ? undefined : 'systemPrompt')} className={`ui-press flex h-7 min-w-0 shrink-0 items-center gap-1 rounded-lg px-1.5 text-[12px] sm:h-8 sm:gap-1 sm:px-1.5 ${panel === 'systemPrompt' || systemPrompt?.trim() ? 'bg-zinc-100 text-zinc-900' : 'text-zinc-500 hover:bg-zinc-100 hover:text-zinc-800'}`}><BookOpen size={12} className="shrink-0"/><span className="whitespace-nowrap">{L("系统提示词", "System Prompt")}</span>{Boolean(systemPrompt?.trim()) && <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-emerald-500"/>}</button></HoverTooltip>}</>}</div><div className="ml-auto flex shrink-0 items-center gap-0.5 sm:gap-1.5">
        {effectiveOutputPlugins.length > 0 && <HoverTooltip content={pluginsTriggerTooltip} side="top"><button type="button" data-composer-panel-trigger data-testid="composer-output-plugins-trigger" data-state={enabledPluginCount > 0 ? 'on' : 'off'} data-enabled-count={enabledPluginCount} data-override-count={overriddenPluginCount} aria-haspopup="dialog" aria-expanded={panel === 'plugins'} aria-busy={pluginsBusy || undefined} aria-label={pluginsTriggerTooltip} disabled={sending} onClick={() => setPanel(current => current === 'plugins' ? undefined : 'plugins')} className={`ui-press relative inline-flex h-7 shrink-0 items-center justify-center gap-1 rounded-lg border px-1.5 text-[11.5px] font-medium transition-[background-color,border-color,color,box-shadow] duration-150 sm:h-8 sm:px-2 disabled:opacity-45 ${panel === 'plugins' ? 'border-sky-300 bg-sky-100/80 text-sky-800 dark:text-sky-200' : enabledPluginCount > 0 ? 'border-sky-200/90 bg-sky-50/85 text-sky-700 shadow-[0_0_0_1px_rgba(14,165,233,0.08)] hover:border-sky-300 hover:bg-sky-100/80 hover:text-sky-800 dark:text-sky-300' : 'border-transparent text-zinc-400 hover:bg-zinc-100 hover:text-zinc-700'}`}><Puzzle key={pluginsJustSwitched ? `plugins-${enabledPluginCount}` : 'plugins-idle'} size={14} className={`shrink-0 ${pluginsJustSwitched ? 'ui-icon-pop' : ''}`}/>{enabledPluginCount > 0 && <span className="tabular-nums text-[11px] font-semibold leading-none">{enabledPluginCount}</span>}{overriddenPluginCount > 0 && <span aria-hidden="true" className="pointer-events-none absolute right-0.5 top-0.5 h-1.5 w-1.5 rounded-full bg-sky-500"/>}</button></HoverTooltip>}
        <AiTextAssistControl
          mode="message_polish"
          variant="icon"
          size="sm"
          popoverSide="top"
          popoverAlign="end"
          value={value}
          getValue={() => composerSubmitValue(editor.current?.getValue(), value)}
          onChange={applyComposerAiText}
          context={resolvedComposerAiContext}
          resetKey={`${sessionId}:${submitEpoch}`}
          hideInlineUndo
          onUndoStateChange={handleAiUndoState}
          onFlash={composerFlash.triggerFlash}
          disabled={sending}
          ariaLabel={L("AI 润色或帮写消息", "AI polish or draft message")}
          testId="composer-ai-assist"
        />
        {!draft && busy && value.trim() && !interruptingSend && <button type="button" disabled={sending} onClick={() => setModeOpen(open => !open)} title={L(`发送方式：${mode === 'interrupt' ? '打断并发送' : '排队发送'}`, `Send mode: ${mode === 'interrupt' ? 'Interrupt & Send' : 'Queue'}`)} aria-haspopup="menu" aria-expanded={modeOpen} className={`ui-press flex h-8 shrink-0 items-center gap-1 rounded-lg px-2 text-[12px] font-medium disabled:opacity-50 ${mode === 'interrupt' ? 'bg-orange-50 text-orange-700' : 'text-zinc-600 hover:bg-zinc-100'}`}>{mode === 'interrupt' ? <Zap size={12}/> : <ListEnd size={12}/>}<span>{mode === 'interrupt' ? L("打断", "Interrupt") : L("排队", "Queue")}</span><ChevronDown size={10} className={`transition-transform duration-150 ${modeOpen ? 'rotate-180' : ''}`}/></button>}
        <ExitGate open={!draft && modeOpen && !interruptingSend} ms={150}><div role="menu" data-placement="top" className="ui-popover absolute bottom-12 right-10 z-20 w-52 rounded-xl border border-zinc-200 bg-white p-1.5 shadow-[0_16px_45px_rgba(24,24,27,.16)]"><button type="button" role="menuitemradio" aria-checked={mode === 'queue'} onClick={() => { onModeChange('queue'); setModeOpen(false); }} className="ui-press flex h-8 w-full items-center gap-2 rounded-lg px-2.5 text-[12px] hover:bg-zinc-100"><ListEnd size={13}/><span className="flex-1 text-left">{L("排队发送", "Queue Message")}</span>{mode === 'queue' && <Check size={12} className="ui-icon-pop"/>}</button><button type="button" role="menuitemradio" aria-checked={mode === 'interrupt'} onClick={() => { onModeChange('interrupt'); setModeOpen(false); }} className="ui-press flex h-8 w-full items-center gap-2 rounded-lg px-2.5 text-[12px] hover:bg-zinc-100"><Zap size={13}/><span className="flex-1 text-left">{L("打断并发送", "Interrupt & Send")}</span>{mode === 'interrupt' && <Check size={12} className="ui-icon-pop"/>}</button></div></ExitGate>
        {interruptingSend
          ? <button type="button" disabled aria-busy="true" aria-label={L("正在打断并发送", "Interrupting & sending")} className="inline-flex h-8 shrink-0 cursor-wait items-center gap-1.5 whitespace-nowrap rounded-full bg-orange-100 px-3 text-[12px] font-medium text-orange-700"><Spinner size={12} label={L("正在打断", "Interrupting")}/><span>{L("正在打断…", "Interrupting…")}</span></button>
          : !draft && busy && !value.trim() && !references.length
            ? <button type="button" onClick={onInterrupt} aria-label={L("中断当前任务", "Stop current task")} className="ui-press grid h-8 w-8 place-items-center rounded-full bg-zinc-900 text-white hover:bg-zinc-700 active:scale-95"><Square size={12} fill="currentColor"/></button>
            : <span className="shrink-0" title={modelReadiness.kind === 'blocked' ? modelReadiness.reason : undefined}><button type="button" disabled={!canSend} onClick={() => { setSubmitEpoch(epoch => epoch + 1); onSubmit(composerSubmitValue(editor.current?.getValue(), value)); }} aria-label={sendLabel} aria-keyshortcuts="Enter" title={L(`${sendLabel}（Enter 发送，Shift+Enter 换行）`, `${sendLabel} (Enter to send, Shift+Enter for newline)`)} className="ui-press grid h-8 w-8 place-items-center rounded-full bg-accent text-accent-fg shadow-[0_1px_2px_rgba(0,0,0,.16)] hover:opacity-90 active:scale-95 disabled:cursor-not-allowed disabled:bg-zinc-200 disabled:text-zinc-400 disabled:opacity-100 disabled:shadow-none"><ArrowUp size={15} strokeWidth={2.2}/></button></span>}
      </div></div>
    </div></div></div>;
}
