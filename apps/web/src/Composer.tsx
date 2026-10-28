import { type Dispatch, type KeyboardEvent, type RefObject, type SetStateAction, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useEventListener } from 'ahooks';
import { AlertCircle, Bot, BrainCircuit, Check, ChevronDown, CornerDownLeft, CornerDownRight, File, FilePenLine, Folder, FolderOpen, Gauge, ImageIcon, ListEnd, Paperclip, RefreshCw, Send, Sparkles, Square, Undo2, X, Zap } from 'lucide-react';
import type { Agent, AgentModel, SkillReference, Task } from './api';
import { AgentIcon } from './AgentIcon';
import { formatTokens, referenceFromUpload, replaceSlashQuery, shouldDismissComposerPanel, slashQuery, uploadSessionFile, workspaceBasename, type ComposerReference, type ContextStats, type ModelReadiness } from './composer-utils';

type SendMode = 'queue' | 'interrupt';
type ComposerCommand = { name: string; description: string };
type ComposerPanel = 'commands' | 'models' | 'reasoning' | 'agent' | 'workspace' | undefined;

const supportedCommands = new Set(['goal', 'plan', 'fast']);

function useAutoResizeTextarea(value: string) {
  const ref = useRef<HTMLTextAreaElement>(null);
  // 触屏小屏下全局把输入字号强制到 16px、且软键盘/方向变化会改变可用宽度，行高与换行都会变；
  // 仅在 value 变时重算会让高度停在旧值，出现「输入框变形/上下留白错乱」。这里把 resize / 横竖屏
  // 也纳入重算（ahooks 挂全局监听，避免裸 useEffect）。
  const recalc = () => {
    const textarea = ref.current;
    if (!textarea) return;
    textarea.style.height = '0px';
    textarea.style.height = `${Math.min(192, Math.max(44, textarea.scrollHeight))}px`;
  };
  useLayoutEffect(recalc, [value]);
  useEventListener('resize', recalc);
  useEventListener('orientationchange', recalc);
  return ref;
}

function useDismissComposerPanel(popover: RefObject<HTMLDivElement | null>, panel: ComposerPanel, setPanel: Dispatch<SetStateAction<ComposerPanel>>) {
  // capture 阶段监听：面板内的按钮会在 click 时改状态，冒泡阶段判断会慢一拍。
  // enable 交给 ahooks，省掉手写的「if (!panel) return」与增删监听。
  useEventListener('pointerdown', event => {
    const target = event.target;
    if (!(target instanceof Node)) return;
    const insidePopover = Boolean(popover.current?.contains(target));
    const onPanelTrigger = target instanceof Element && Boolean(target.closest('[data-composer-panel-trigger]'));
    if (shouldDismissComposerPanel({ insidePopover, onPanelTrigger })) setPanel(undefined);
  }, { target: () => document, capture: true, enable: Boolean(panel) });
}

/**
 * 队列只在末尾新增时滚到最新一条：刚发的消息要看得见。队首被取走、取消或编辑时不动，
 * 别把正在面板里翻的人拽走。
 */
function useScrollToNewestQueued(tasks: Task[]) {
  const ref = useRef<HTMLDivElement>(null);
  const newestId = tasks.at(-1)?.id;
  useLayoutEffect(() => {
    const list = ref.current;
    if (list && newestId) list.scrollTop = list.scrollHeight;
  }, [newestId]);
  return ref;
}

function QueuedTasks({ tasks, cancellingTaskId, steeringTaskId, editingTaskId, onCancel, onSteer, onEdit }: { tasks: Task[]; cancellingTaskId?: string; steeringTaskId?: string; editingTaskId?: string; onCancel(id: string): void; onSteer(id: string): void; onEdit(task: Task): void }) {
  const listRef = useScrollToNewestQueued(tasks);
  if (!tasks.length) return null;
  return <div className="mx-4 overflow-hidden rounded-t-2xl border border-b-0 border-zinc-200/80 bg-white/90 shadow-[0_-5px_18px_rgba(24,24,27,.025)] backdrop-blur">
    <div className="flex items-center gap-2 border-b border-zinc-100 px-3.5 py-2 text-[11px] font-medium text-zinc-500"><ListEnd size={13}/><span>等待发送</span><span className="rounded-full bg-zinc-100 px-1.5 py-0.5 text-[10px] tabular-nums">{tasks.length}</span></div>
    <div ref={listRef} className="max-h-28 overflow-y-auto">{tasks.map(task => <div key={task.id} className={`group flex items-center gap-2.5 px-3.5 py-2 text-[12px] ${editingTaskId === task.id ? 'bg-blue-50/80 ring-1 ring-inset ring-blue-200/70' : 'text-zinc-600 hover:bg-zinc-50'}`}>
      {editingTaskId === task.id ? <>
        <Undo2 size={13} className="shrink-0 text-blue-600"/>
        <span className="min-w-0 flex-1 truncate text-zinc-400 line-through decoration-zinc-300" title={task.prompt}>{task.prompt}</span>
        <span className="flex shrink-0 items-center gap-1 rounded-full bg-blue-600 px-2 py-0.5 text-[10px] font-medium text-white"><CornerDownLeft size={10}/>已退回输入框</span>
      </> : <>
        <CornerDownRight size={13} className="shrink-0 text-zinc-400"/>
        <span className="min-w-0 flex-1 truncate" title={task.prompt}>{task.prompt}</span>
        <span className="shrink-0 text-[10px] text-zinc-400">排队中</span>
        <button type="button" disabled={Boolean(cancellingTaskId) || Boolean(steeringTaskId) || Boolean(editingTaskId)} onClick={() => onEdit(task)} aria-label={`编辑：${task.prompt}`} title="退回输入框编辑" className="grid h-6 w-6 shrink-0 place-items-center rounded-md text-zinc-400 transition-colors hover:bg-zinc-200 hover:text-zinc-700 focus-visible:opacity-100 disabled:opacity-30"><FilePenLine size={12}/></button>
        <button type="button" disabled={Boolean(cancellingTaskId) || Boolean(steeringTaskId) || Boolean(editingTaskId)} onClick={() => onSteer(task.id)} className="h-6 shrink-0 rounded-md px-2 text-[10px] font-medium hover:bg-zinc-900 hover:text-white disabled:opacity-35">{steeringTaskId === task.id ? '处理中' : '立即发送'}</button>
        <button type="button" disabled={Boolean(cancellingTaskId) || Boolean(steeringTaskId) || Boolean(editingTaskId)} onClick={() => onCancel(task.id)} aria-label={`取消排队：${task.prompt}`} className="grid h-6 w-6 shrink-0 place-items-center rounded-md text-zinc-400 hover:bg-zinc-200 hover:text-zinc-700 disabled:opacity-30"><X size={12}/></button>
      </>}
    </div>)}</div>
  </div>;
}

export function Composer({ sessionId, state, value, references, sending, mode, queuedTasks, cancellingTaskId, steeringTaskId, editingTaskId, skills, models, reasoningEfforts, currentModel, currentReasoningEffort, context, advertisedCommands, modelReadiness, switchingModel, switchingReasoningEffort, refreshingModels, textareaRef: externalTextareaRef, draft, agents, currentAgentId, onAgentChange, workspace, onWorkspaceChange, workspaceSuggestion, workspaceOptions, directoryPickerAvailable, pickingDirectory, onPickDirectory, onAttachFile, onChange, onReferencesChange, onModeChange, onSubmit, onInterrupt, onCancelQueued, onSteerQueued, onEditQueued, onModelChange, onReasoningEffortChange, onRefreshModels }: {
  sessionId: string; state: string; value: string; references: ComposerReference[]; sending: boolean; mode: SendMode; queuedTasks: Task[]; cancellingTaskId?: string; steeringTaskId?: string; editingTaskId?: string;
  skills: SkillReference[]; models: AgentModel[]; reasoningEfforts: AgentModel[]; currentModel?: string; currentReasoningEffort?: string; context: ContextStats; advertisedCommands: Array<{ name: string; description: string }>; modelReadiness: ModelReadiness; switchingModel: boolean; switchingReasoningEffort: boolean; refreshingModels: boolean;
  /** 分屏时父级需要精确聚焦本 pane 的输入框（不能再用 document.querySelector）。 */
  textareaRef?: RefObject<HTMLTextAreaElement | null>;
  /** 草稿态：尚未创建会话。显示 Agent / 工作目录选择，隐藏排队 / 中断等会话内控件。 */
  draft?: boolean;
  agents?: Agent[];
  currentAgentId?: string;
  onAgentChange?(id: string): void;
  workspace?: string;
  onWorkspaceChange?(value: string): void;
  workspaceSuggestion?: string;
  /** 已知工作区（历史会话的 cwd）；草稿态的「工作目录」下拉用它。 */
  workspaceOptions?: string[];
  directoryPickerAvailable?: boolean;
  pickingDirectory?: boolean;
  onPickDirectory?(): void;
  /** 草稿态没有 sessionId：文件先交给上层暂存，返回一枚引用 chip 展示。 */
  onAttachFile?(file: File | Blob): Promise<ComposerReference | void>;
  onChange(value: string): void; onReferencesChange(value: ComposerReference[] | ((current: ComposerReference[]) => ComposerReference[])): void; onModeChange(mode: SendMode): void; onSubmit(): void; onInterrupt(): void; onCancelQueued(taskId: string): void; onSteerQueued(taskId: string): void; onEditQueued(task: Task): void; onModelChange(model: string): void; onReasoningEffortChange(reasoningEffort: string): void; onRefreshModels(): void;
}) {
  const [panel, setPanel] = useState<ComposerPanel>();
  const [uploadError, setUploadError] = useState<string>();
  const [uploading, setUploading] = useState<string[]>([]);
  const [modeOpen, setModeOpen] = useState(false);
  // 工作目录下拉里直接就能输入路径，不需要额外的「输入路径」模式；wsDraft 是那一格的编辑值。
  const [wsDraft, setWsDraft] = useState('');
  const workspacePath = workspace || workspaceSuggestion || '';
  const workspaceLabel = workspacePath ? workspaceBasename(workspacePath) : '工作目录';
  const currentAgent = (agents ?? []).find(agent => agent.id === currentAgentId);
  const textarea = useAutoResizeTextarea(value);
  const popover = useRef<HTMLDivElement>(null);
  const imageInput = useRef<HTMLInputElement>(null);
  useDismissComposerPanel(popover, panel, setPanel);
  const busy = ['starting', 'thinking', 'running_tool', 'waiting_for_permission', 'interrupting'].includes(state);
  // 只有 blocked（正在切换模型）才拦发送；模型列表还在加载或加载失败都不影响
  // 用当前模型发消息，详见 getModelReadiness。
  const canSend = modelReadiness.kind !== 'blocked' && (value.trim().length > 0 || references.length > 0) && !sending && (draft ? Boolean(currentAgentId) : !['starting', 'interrupting', 'stopped', 'failed'].includes(state));
  const modelLabel = modelReadiness.kind === 'ready' ? currentModel || '默认模型' : modelReadiness.label;
  const sendLabel = modelReadiness.kind === 'blocked' ? modelReadiness.reason : draft ? '创建会话并发送' : '发送消息';
  const query = slashQuery(value, textarea.current?.selectionStart ?? value.length);
  const commands = useMemo(() => {
    // ACP command updates vary by Agent: Codex advertises /plan, Claude advertises /fast.
    // Only offer a command when the active Agent actually reports it.
    return advertisedCommands.filter(command => supportedCommands.has(command.name));
  }, [advertisedCommands]);
  const visibleCommands = commands.filter(command => query === undefined || command.name.toLowerCase().includes(query) || command.description.toLowerCase().includes(query));
  const visibleSkills = skills.filter(skill => query === undefined || skill.name.toLowerCase().includes(query) || skill.description.toLowerCase().includes(query));
  const commandPanel = panel === 'commands' || (query !== undefined && panel === undefined);

  const insertText = (text: string) => {
    const caret = textarea.current?.selectionStart ?? value.length;
    const next = query === undefined
      ? `${value.slice(0, caret)}${caret > 0 && !/\s$/.test(value.slice(0, caret)) ? ' ' : ''}${text}${value.slice(caret)}`
      : replaceSlashQuery(value, text, caret);
    onChange(next);
    setPanel(undefined);
    requestAnimationFrame(() => textarea.current?.focus());
  };
  const insertCommand = (name: string) => {
    const withoutQuery = query === undefined ? value : replaceSlashQuery(value, '', textarea.current?.selectionStart ?? value.length);
    onChange(`/${name} ${withoutQuery.trimStart()}`);
    setPanel(undefined);
    requestAnimationFrame(() => textarea.current?.focus());
  };
  const chooseCommand = (command: ComposerCommand) => insertCommand(command.name);
  const chooseSkill = (name: string) => {
    // Local SKILL.md entries are not necessarily commands advertised by the Agent.
    // Keep those as plain text so the CLI cannot reject them as unknown slash commands.
    if (advertisedCommands.some(command => command.name === name)) insertCommand(name);
    else insertText(`请使用 ${name} 技能： `);
  };
  const addReference = (kind: ComposerReference['kind'], label: string, referenceValue: string) => {
    const normalized = referenceValue.trim();
    if (!normalized || references.some(reference => reference.kind === kind && reference.value === normalized)) return;
    onReferencesChange(current => [...current, { id: `${kind}-${normalized}`, kind, label, value: normalized }]);
    setPanel(undefined);
    requestAnimationFrame(() => textarea.current?.focus());
  };
  const keyboard = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.nativeEvent.isComposing || event.keyCode === 229) return;
    if (event.key === 'Escape' && (panel || query !== undefined)) { event.preventDefault(); setPanel(undefined); return; }
    if (event.key === 'Enter' && !event.shiftKey && commandPanel && (visibleCommands[0] || visibleSkills[0])) { event.preventDefault(); if (visibleCommands[0]) chooseCommand(visibleCommands[0]); else chooseSkill(visibleSkills[0]!.name); return; }
    if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); if (canSend) onSubmit(); }
  };

  const uploadFile = async (file: File | Blob) => {
    const name = 'name' in file ? file.name : '（未命名文件）';
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
      setUploadError(`文件上传失败：${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setUploading(current => current.filter(item => item !== name));
    }
  };

  const onPaste = (event: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const items = event.clipboardData?.items;
    if (!items) return;
    let hasFile = false;
    for (const item of items) {
      if (item.kind !== 'file') continue;
      const file = item.getAsFile();
      if (!file) continue;
      if (!hasFile) { event.preventDefault(); hasFile = true; }
      void uploadFile(file);
    }
  };

  const onDrop = (event: React.DragEvent<HTMLDivElement>) => {
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

  return <div className={draft ? 'w-full' : 'bg-gradient-to-t from-[#f7f8fa] via-[#f7f8fa] to-transparent px-4 pb-4 pt-3 sm:px-8 sm:pb-5 sm:pt-7'}><div className="mx-auto w-full max-w-[820px]">
    {!draft && <QueuedTasks tasks={queuedTasks} cancellingTaskId={cancellingTaskId} steeringTaskId={steeringTaskId} editingTaskId={editingTaskId} onCancel={onCancelQueued} onSteer={onSteerQueued} onEdit={onEditQueued}/>}
    <div onDrop={onDrop} onDragOver={onDragOver} className={`relative rounded-[18px] border border-zinc-950/[.07] bg-white/95 p-2 shadow-[0_1px_2px_rgba(24,24,27,.04),0_10px_30px_rgba(24,24,27,.055)] ring-1 ring-inset ring-white/80 backdrop-blur-sm transition-[transform,border-color,box-shadow,background-color] duration-300 ease-out hover:border-zinc-950/[.11] hover:shadow-[0_2px_4px_rgba(24,24,27,.05),0_14px_38px_rgba(24,24,27,.075)] focus-within:bg-white focus-within:shadow-[0_2px_4px_rgba(24,24,27,.045),0_16px_42px_rgba(24,24,27,.09)] sm:focus-within:-translate-y-0.5 ${queuedTasks.length ? 'rounded-t-[10px]' : ''}`}>
      {(commandPanel || panel === 'models' || panel === 'reasoning' || panel === 'agent' || panel === 'workspace') && <div ref={popover} className="ui-popover absolute bottom-[calc(100%+8px)] left-0 z-20 w-full overflow-hidden rounded-xl border border-zinc-200 bg-white shadow-[0_18px_55px_rgba(24,24,27,.16)] sm:left-2 sm:w-[460px]">
        {commandPanel && <div className="max-h-80 overflow-y-auto p-1.5">{visibleCommands.length > 0 && <div className="px-2.5 pb-1.5 pt-1 text-[10px] font-semibold text-zinc-400">命令</div>}{visibleCommands.map(command => <button key={command.name} type="button" onMouseDown={event => event.preventDefault()} onClick={() => chooseCommand(command)} className="flex w-full items-center gap-3 rounded-lg px-2.5 py-2 text-left hover:bg-zinc-100"><span className="grid h-7 w-7 place-items-center rounded-lg bg-zinc-100 font-mono text-[13px] text-zinc-700">/</span><span className="min-w-0"><span className="block text-[12px] font-medium text-zinc-800">/{command.name}</span><span className="block truncate text-[10px] text-zinc-500">{command.description || 'Agent 提供的命令'}</span></span></button>)}{visibleSkills.length > 0 && <div className="mx-2 mt-1 border-t border-zinc-100 px-0.5 pb-1 pt-2 text-[10px] font-semibold text-zinc-400">Skills</div>}{visibleSkills.map(skill => <button key={skill.path} type="button" onMouseDown={event => event.preventDefault()} onClick={() => chooseSkill(skill.name)} className="flex w-full items-center gap-3 rounded-lg px-2.5 py-2 text-left hover:bg-zinc-100"><span className="grid h-7 w-7 place-items-center rounded-lg bg-amber-50 text-amber-700"><Sparkles size={13}/></span><span className="min-w-0"><span className="block text-[12px] font-medium text-zinc-800">{skill.name}</span><span className="block truncate text-[10px] text-zinc-500">{skill.description || skill.path}</span></span></button>)}{!visibleCommands.length && !visibleSkills.length && <div className="px-3 py-5 text-center text-xs text-zinc-500">没有匹配项</div>}</div>}
        {panel === 'models' && <div><div className="flex items-center border-b border-zinc-100 px-3 py-2.5"><Gauge size={13} className="mr-2 text-zinc-500"/><span className="text-xs font-semibold">切换模型</span>{refreshingModels && <span className="ml-auto text-[10px] text-zinc-400">正在刷新…</span>}<button type="button" disabled={refreshingModels} onClick={onRefreshModels} className={`${refreshingModels ? 'ml-1' : 'ml-auto'} grid h-7 w-7 place-items-center rounded-md text-zinc-500 transition-colors hover:bg-zinc-100 disabled:cursor-wait disabled:text-zinc-400`} aria-label={refreshingModels ? '正在刷新模型列表' : '刷新模型列表'} title={refreshingModels ? '正在刷新模型列表' : '刷新模型列表'}><RefreshCw size={12} className={refreshingModels ? 'animate-spin' : ''}/></button></div><div className="max-h-72 overflow-y-auto p-1.5">{models.map(model => <button key={model.id} type="button" disabled={switchingModel || model.id === currentModel} onClick={() => { onModelChange(model.id); setPanel(undefined); }} className="flex w-full items-center rounded-lg px-2.5 py-2 text-left text-xs text-zinc-700 hover:bg-zinc-100 disabled:opacity-55"><span className="w-5">{model.id === currentModel && <Check size={12}/>}</span><span className="min-w-0 flex-1 truncate">{model.name}</span>{model.name !== model.id && <span className="ml-3 max-w-[48%] truncate font-mono text-[10px] text-zinc-400">{model.id}</span>}</button>)}{!models.length && <div className={`mx-1 my-1 rounded-lg px-3 py-5 text-center text-xs ${modelReadiness.kind === 'blocked' ? 'bg-red-50 text-red-700' : 'text-zinc-500'}`}>{modelReadiness.kind === 'ready' ? 'Agent 未提供可切换模型' : modelReadiness.reason}</div>}</div></div>}
        {panel === 'reasoning' && <div><div className="flex items-center border-b border-zinc-100 px-3 py-2.5"><BrainCircuit size={13} className="mr-2 text-zinc-500"/><span className="text-xs font-semibold">思考深度</span></div><div className="max-h-72 overflow-y-auto p-1.5">{reasoningEfforts.map(effort => <button key={effort.id} type="button" disabled={switchingReasoningEffort || effort.id === currentReasoningEffort} onClick={() => { onReasoningEffortChange(effort.id); setPanel(undefined); }} className="flex w-full items-center rounded-lg px-2.5 py-2 text-left text-xs text-zinc-700 hover:bg-zinc-100 disabled:opacity-55"><span className="w-5">{effort.id === currentReasoningEffort && <Check size={12}/>}</span><span className="min-w-0 flex-1 truncate">{effort.name}</span></button>)}{!reasoningEfforts.length && <div className="px-3 py-6 text-center text-xs text-zinc-500">当前模型未提供思考深度选项</div>}</div></div>}
        {panel === 'agent' && <div>
          <div className="flex items-center border-b border-zinc-100 px-3 py-2.5"><Bot size={13} className="mr-2 text-zinc-500"/><span className="text-xs font-semibold">选择 Agent</span></div>
          <div className="max-h-72 overflow-y-auto p-1.5">
            {(agents ?? []).map(agent => <button key={agent.id} type="button" onClick={() => { onAgentChange?.(agent.id); setPanel(undefined); }} className="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-xs text-zinc-700 hover:bg-zinc-100"><span className="w-5 shrink-0">{agent.id === currentAgentId && <Check size={12}/>}</span><AgentIcon agentId={agent.id} agentName={agent.name} size={14}/><span className="min-w-0 flex-1 truncate">{agent.name}</span></button>)}
            {!(agents ?? []).length && <div className="px-3 py-6 text-center text-xs text-zinc-500">没有可用 Agent</div>}
          </div>
        </div>}
        {panel === 'workspace' && <div>
          <div className="flex items-center border-b border-zinc-100 px-3 py-2.5"><FolderOpen size={13} className="mr-2 text-zinc-500"/><span className="text-xs font-semibold">工作目录</span><span className="ml-auto hidden text-[10px] text-zinc-400 sm:inline">回车应用</span></div>
          <div className="flex items-center gap-1.5 border-b border-zinc-100 px-2.5 py-2">
            <input autoFocus value={wsDraft} onChange={event => setWsDraft(event.target.value)} onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); onWorkspaceChange?.(wsDraft.trim()); setPanel(undefined); } }} placeholder={workspaceSuggestion ?? '/绝对路径'} spellCheck={false} className="h-8 min-w-0 flex-1 rounded-md border border-zinc-300 bg-white px-2 font-mono text-[11px] text-zinc-700 outline-none placeholder:text-zinc-400"/>
            {directoryPickerAvailable && <button type="button" disabled={pickingDirectory} onClick={() => { onPickDirectory?.(); setPanel(undefined); }} title={pickingDirectory ? '选择中…' : '选择目录'} aria-label="选择目录" className="grid h-8 w-8 shrink-0 place-items-center rounded-md text-zinc-500 hover:bg-zinc-100 hover:text-zinc-800 disabled:opacity-40">{pickingDirectory ? <RefreshCw size={13} className="animate-spin"/> : <FolderOpen size={13}/>}</button>}
          </div>
          <div className="max-h-72 overflow-y-auto p-1.5">
            <button type="button" onClick={() => { onWorkspaceChange?.(''); setPanel(undefined); }} className="flex w-full items-center gap-2 rounded-lg px-2.5 py-2.5 text-left hover:bg-zinc-100"><span className="w-4 shrink-0">{!workspacePath && <Check size={12}/>}</span><span className="min-w-0 flex-1 truncate text-[13px] text-zinc-700">使用 Agent 默认目录</span></button>
            {(workspaceOptions ?? []).map(path => <button key={path} type="button" onClick={() => { onWorkspaceChange?.(path); setPanel(undefined); }} className="flex w-full items-start gap-2 rounded-lg px-2.5 py-2 text-left hover:bg-zinc-100"><span className="mt-0.5 w-4 shrink-0">{workspacePath === path && <Check size={12}/>}</span><span className="min-w-0 flex-1"><span className="block truncate text-[13px] text-zinc-700">{workspaceBasename(path)}</span><span className="mt-0.5 block truncate font-mono text-[10px] text-zinc-400">{path}</span></span></button>)}
            {!(workspaceOptions ?? []).length && <div className="px-3 py-4 text-center text-[11px] text-zinc-400">还没有其他工作区</div>}
          </div>
        </div>}
      </div>}
      {uploadError && <div className="mx-2.5 mb-1 flex items-center gap-1.5 rounded-lg border border-red-100 bg-red-50 px-2.5 py-1.5 text-[11px] text-red-700"><AlertCircle size={12} className="shrink-0"/><span className="min-w-0 flex-1 truncate" title={uploadError}>{uploadError}</span><button type="button" onClick={() => setUploadError(undefined)} aria-label="关闭上传错误提示" className="shrink-0 text-red-400 hover:text-red-700"><X size={11}/></button></div>}
      {references.length > 0 && <div className="flex flex-wrap gap-1.5 px-2.5 pb-1.5 pt-1">{references.map(reference => <span key={reference.id} className="flex max-w-full items-center gap-1.5 rounded-lg border border-zinc-200 bg-zinc-50 px-2 py-1 text-[10px] text-zinc-600">{reference.kind === 'image' ? (reference.url ? <img src={reference.url} alt={reference.label} className="h-5 w-5 rounded object-cover" /> : <ImageIcon size={11}/>) : reference.kind === 'file' ? <File size={11}/> : <Sparkles size={11}/>}<span className="truncate font-mono">{reference.label}</span><button type="button" onClick={() => onReferencesChange(current => current.filter(item => item.id !== reference.id))} aria-label={`移除引用 ${reference.label}`} className="text-zinc-400 hover:text-zinc-800"><X size={10}/></button></span>)}</div>}
      {uploading.length > 0 && <div className="flex items-center gap-1.5 px-2.5 pb-1 text-[10px] text-zinc-500"><RefreshCw size={11} className="shrink-0 animate-spin text-zinc-400"/><span className="truncate">正在上传 {uploading.length > 1 ? `${uploading.length} 个文件` : uploading[0]}…</span></div>}
      <textarea ref={node => { textarea.current = node; if (externalTextareaRef) externalTextareaRef.current = node; }} aria-label="消息"value={value} onChange={event => { onChange(event.target.value); if (panel !== 'models' && panel !== 'reasoning') setPanel(undefined); }} onPaste={onPaste} onKeyDown={keyboard} placeholder="输入消息，使用 / 选择 Skill 或命令，可直接粘贴/拖入文件" rows={1} className="max-h-48 min-h-11 w-full resize-none overflow-y-auto border-0 bg-transparent px-2.5 py-1.5 text-[14px] leading-6 text-zinc-900 outline-none placeholder:text-zinc-400 focus-visible:outline-none sm:min-h-16 sm:py-2"/>
      <div className="flex min-w-0 items-center gap-0.5 px-1 pb-1 sm:gap-1"><button type="button" data-composer-panel-trigger onClick={() => setPanel(panel === 'commands' ? undefined : 'commands')} className="grid h-8 w-8 shrink-0 place-items-center rounded-lg font-mono text-[16px] text-zinc-500 hover:bg-zinc-100 hover:text-zinc-800" aria-label="打开命令与 Skill 菜单" title="命令与 Skill（/）">/</button><button type="button" onClick={() => imageInput.current?.click()} className="grid h-8 w-8 shrink-0 place-items-center rounded-lg text-zinc-500 hover:bg-zinc-100 hover:text-zinc-800" aria-label="上传文件" title={uploading.length ? '文件上传中…' : '上传文件'}>{uploading.length > 0 ? <RefreshCw size={14} className="animate-spin"/> : <Paperclip size={14}/>}</button><input ref={imageInput} type="file" multiple className="hidden" onChange={event => { const files = event.target.files; if (files) { for (const file of files) void uploadFile(file); } event.target.value = ''; }}/><div className="no-scrollbar flex min-w-0 flex-1 items-center gap-0.5 overflow-x-auto sm:gap-1">{draft && <button type="button" data-composer-panel-trigger onClick={() => setPanel(panel === 'agent' ? undefined : 'agent')} title={currentAgent?.name ?? '选择 Agent'} className="flex h-8 min-w-0 max-w-40 shrink-0 items-center gap-1.5 rounded-lg px-1.5 text-[10px] text-zinc-500 hover:bg-zinc-100 hover:text-zinc-800 sm:px-2"><AgentIcon agentId={currentAgentId} agentName={currentAgent?.name} size={12}/><span className="truncate">{currentAgent?.name ?? '选择 Agent'}</span><ChevronDown size={10}/></button>}{draft && <button type="button" data-composer-panel-trigger onClick={() => { setWsDraft(workspacePath); setPanel(panel === 'workspace' ? undefined : 'workspace'); }} title={workspacePath || '工作目录'} className="flex h-8 min-w-0 max-w-40 shrink-0 items-center gap-1.5 rounded-lg px-1.5 text-[10px] text-zinc-500 hover:bg-zinc-100 hover:text-zinc-800 sm:px-2"><Folder size={12}/><span className="truncate">{workspaceLabel}</span><ChevronDown size={10}/></button>}<button type="button" data-composer-panel-trigger onClick={() => setPanel(panel === 'models' ? undefined : 'models')} title={modelReadiness.kind === 'ready' ? '切换模型' : modelReadiness.reason} className={`${draft ? '' : ''}flex h-8 min-w-0 max-w-40 shrink-0 items-center gap-1.5 rounded-lg px-2 text-[10px] text-zinc-500 hover:bg-zinc-100 hover:text-zinc-800`}><Gauge size={12}/><span className="truncate">{modelLabel}</span><ChevronDown size={10}/></button><button type="button" data-composer-panel-trigger onClick={() => setPanel(panel === 'reasoning' ? undefined : 'reasoning')} className={`${draft ? '' : ''}flex h-8 min-w-0 shrink-0 items-center gap-1.5 rounded-lg px-2 text-[10px] text-zinc-500 hover:bg-zinc-100 hover:text-zinc-800`}><BrainCircuit size={12}/><span className="truncate">{currentReasoningEffort || '默认深度'}</span><ChevronDown size={10}/></button></div><div className="ml-auto flex min-w-0 items-center gap-1.5">{!draft && context.used !== undefined && <div className="hidden min-w-0 items-center gap-2 text-[10px] text-zinc-400 sm:flex"><span className="truncate">上下文 {formatTokens(context.used)}{context.size !== undefined ? ` / ${formatTokens(context.size)}` : ''}</span>{context.size !== undefined && <span className="h-1.5 w-12 overflow-hidden rounded-full bg-zinc-100"><span className="block h-full rounded-full bg-zinc-500" style={{ width: `${context.percentage ?? 0}%` }}/></span>}<span className="whitespace-nowrap">压缩 {formatTokens(context.compacted)}</span></div>}
        {!draft && busy && value.trim() && <button type="button" onClick={() => setModeOpen(open => !open)} className={`flex h-8 items-center gap-1 rounded-lg px-2 text-[10px] font-medium ${mode === 'interrupt' ? 'bg-orange-50 text-orange-700' : 'text-zinc-600 hover:bg-zinc-100'}`}>{mode === 'interrupt' ? <Zap size={12}/> : <ListEnd size={12}/>}<span>{mode === 'interrupt' ? '立即' : '排队'}</span><ChevronDown size={10}/></button>}
        {!draft && modeOpen && <div className="absolute bottom-12 right-10 z-20 w-56 rounded-xl border border-zinc-200 bg-white p-1.5 shadow-[0_16px_45px_rgba(24,24,27,.16)]"><button type="button" onClick={() => { onModeChange('queue'); setModeOpen(false); }} className="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-xs hover:bg-zinc-50"><ListEnd size={13}/>排队发送</button><button type="button" onClick={() => { onModeChange('interrupt'); setModeOpen(false); }} className="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-xs hover:bg-orange-50"><Zap size={13}/>打断并立即发送</button></div>}
        {!draft && busy && !value.trim() && !references.length ? <button type="button" onClick={onInterrupt} aria-label="中断当前任务" className="grid h-8 w-8 place-items-center rounded-full bg-zinc-900 text-white hover:bg-zinc-700"><Square size={11} fill="currentColor"/></button> : <span className="shrink-0" title={modelReadiness.kind === 'blocked' ? modelReadiness.reason : undefined}><button type="button" disabled={!canSend} onClick={onSubmit} aria-label={sendLabel} className={`grid h-8 w-8 place-items-center rounded-full text-white transition-[background-color,box-shadow,transform] duration-200 shadow-[0_1px_2px_rgba(24,24,27,.18)] active:scale-95 disabled:shadow-none disabled:cursor-not-allowed disabled:bg-zinc-200 disabled:text-zinc-400 ${busy && mode === 'interrupt' ? 'bg-orange-600 hover:bg-orange-500' : 'bg-zinc-900 hover:bg-zinc-700'}`}><Send size={13}/></button></span>}
      </div></div>
    </div></div></div>;
}
