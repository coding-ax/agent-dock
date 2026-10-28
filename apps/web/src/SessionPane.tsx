import { PanelRight, AlarmClock, BookOpen, Bot, ExternalLink, Menu, MessageSquare, Square, Archive, X, Folder, RefreshCw, ScrollText } from 'lucide-react';
import { useMemo, useRef, useState } from 'react';
import { useDebounce } from 'ahooks';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, type Agent, type DockEvent, type Session, type Task } from './api';
import { buildTimeline, buildTimelineSections, isStreamingSection, isTurnOngoing, startsImmediately, waitingQueuedTasks, type OptimisticMessage } from './timeline';
import { ActivityPanel, TimelineItem } from './TimelineItems';
import { Composer } from './Composer';
import { AgentIcon } from './AgentIcon';
import { buildPrompt, commandsFromEvents, contextStatsFromEvents, getModelReadiness, parsePromptToDraft, queuedImageThumbnailUrl, type ComposerReference } from './composer-utils';
import { useTimelineAutoScroll } from './useTimelineAutoScroll';
import { useRefetchFullOnFocus } from './useRefetchFullOnFocus';
import { useBufferedEventStream } from './useBufferedEventStream';
import { mergeEventBatch } from './event-buffer';
import { agentModelsQueryKey, loadAgentModels, readCachedAgentModels } from './model-cache';
import { stateLabels, stateTone, busyStates } from './session-states';
import { ConfirmDialog, IconButton } from './ui-controls';
import { ScheduleDialog } from './ScheduleDialog';
import { HandoverDialog } from './HandoverDialog';
import { larkSessionAppLink } from './lark-session-link';
import { useDockStore, type PaneKind } from './store';
import { createOptimisticMessageId } from './optimistic-message-id';
import { useToast } from './Toast';

type SendMode = 'queue' | 'interrupt';

/**
 * 会话标题栏的副屏开关。空副屏里直接展示可打开的面板类型。
 */
function PaneToggleButton({ open, onToggle }: { open: boolean; onToggle(): void }) {
  return <IconButton label={open ? '隐藏副屏' : '显示副屏'} active={open} onClick={onToggle}><PanelRight size={15}/></IconButton>;
}

export function SessionPane({ session, agent, pane, onOpenSidebar, paneOpen, onTogglePane, onOpenRawLog }: {
  session: Session;
  agent?: Agent;
  pane: PaneKind;
  onOpenSidebar(): void;
  paneOpen?: boolean;
  onTogglePane?(): void;
  onOpenRawLog?(sessionId: string): void;
}) {
  const qc = useQueryClient();
  const { setSession, closeTab } = useDockStore();
  const secondary = pane === 'secondary';
  const [prompt, setPrompt] = useState(''); const [composerReferences, setComposerReferences] = useState<ComposerReference[]>([]); const [sendMode, setSendMode] = useState<SendMode>('queue');
  const [optimisticMessages, setOptimisticMessages] = useState<OptimisticMessage[]>([]);
  const [actionError, setActionError] = useState<string>(); const [archiveConfirm, setArchiveConfirm] = useState(false); const [scheduleOpen, setScheduleOpen] = useState(false); const [systemPromptOpen, setSystemPromptOpen] = useState(false); const [handoverOpen, setHandoverOpen] = useState(false);
  const composerTextarea = useRef<HTMLTextAreaElement>(null);

  // 增量拉取是 append-only，无法修正已缓存的过期条目；focus 时退回一次全量拉取以自愈。
  // 每个 pane 各自持有一个布尔 ref，两个 pane 都会独立触发全量 refetch。
  const refetchFull = useRefetchFullOnFocus();
  const events = useQuery({
    queryKey: ['events', session.id],
    queryFn: async ({ queryKey }) => {
      const sessionId = queryKey[1] as string;
      const full = refetchFull.current;
      refetchFull.current = false;
      const cached = full ? [] : qc.getQueryData<DockEvent[]>(queryKey) ?? [];
      const after = cached.reduce((max, event) => Math.max(max, event.sequence), 0);
      const fresh = await api.events(sessionId, after || undefined);
      const live = qc.getQueryData<DockEvent[]>(queryKey) ?? cached;
      if (full || !after) {
        const newest = fresh.reduce((max, event) => Math.max(max, event.sequence), 0);
        return mergeEventBatch(fresh, live.filter(event => event.sequence > newest));
      }
      return mergeEventBatch(live, fresh);
    },
    enabled: true
  });
  const tasks = useQuery({ queryKey: ['tasks', session.id], queryFn: () => api.tasks(session.id), refetchInterval: 2_000, refetchIntervalInBackground: true });
  const outputLabel = session.model ?? agent?.name ?? session.agentId ?? 'Agent';
  const models = useQuery({ queryKey: agentModelsQueryKey(session.agentId, session.model), queryFn: () => loadAgentModels(session.agentId, session.model), enabled: !session.archivedAt, initialData: () => readCachedAgentModels(session.agentId, session.model), initialDataUpdatedAt: 0, refetchOnMount: 'always', staleTime: 60_000 });
  const skills = useQuery({ queryKey: ['skills', session.cwd], queryFn: () => api.skills(session.cwd), enabled: !session.archivedAt, staleTime: 60_000 });
  const composerContext = useMemo(() => contextStatsFromEvents(events.data), [events.data]);
  const advertisedCommands = useMemo(() => commandsFromEvents(events.data), [events.data]);
  const sessionBusy = busyStates.has(session.state);
  // 标题栏时钟上的高亮：只算启用中的。和弹窗共用同一个缓存键，弹窗里的增删改会自动刷新这里。
  const schedules = useQuery({ queryKey: ['schedules', session.id], queryFn: () => api.schedules(session.id), enabled: !session.archivedAt, staleTime: 30_000 });
  const activeSchedules = schedules.data?.filter(item => item.enabled).length ?? 0;
  const sessions = useQuery({ queryKey: ['sessions'], queryFn: api.sessions, enabled: scheduleOpen });
  const timeline = useMemo(() => buildTimeline(events.data, tasks.data, optimisticMessages, sessionBusy), [events.data, tasks.data, optimisticMessages, sessionBusy]); const timelineSections = useMemo(() => buildTimelineSections(timeline, tasks.data), [timeline, tasks.data]);
  let latestUserIndex = -1;
  for (let index = timeline.length - 1; index >= 0; index--) if (timeline[index].type === 'text' && timeline[index].data.role === 'user') { latestUserIndex = index; break; }
  // 页面挂载时刻：时间戳早于它的行是「打开页面之前就存在的历史」，刷新时不重播。
  // 为什么不按「第几批 payload」判断：刷新后的 SSE 补发也会把旧内容带回来，按批次判会把
  // 已经显示过的整段当成新内容重播一遍——那正是「每次刷新都重新跑一遍」的来源。
  const mountedAt = useRef(new Date().toISOString()).current;
  const queuedTasks = useMemo(() => waitingQueuedTasks(tasks.data, sessionBusy), [tasks.data, sessionBusy]);
  const hasOngoingActivity = timelineSections.some(section => isTurnOngoing(section, sessionBusy));
  const timelineScroll = useTimelineAutoScroll(session.id, timeline, sessionBusy);
  // 只对「回到底部」按钮的显隐做 120ms 去抖：滞回阈值已经消除边界翻转，
  // 这里再兜一层，避免快速抖动/极窄视口下按钮闪一下又消失。跟随逻辑本身不去抖。
  const showScrollToBottom = useDebounce(!timelineScroll.isFollowing, { wait: 120 });

  const send = useMutation({
    mutationFn: ({ message, mode }: { message: string; mode: SendMode; draft: string; references: ComposerReference[]; optimisticId: string }) => api.send(session.id, message, mode),
    onMutate: variables => {
      setActionError(undefined);
      setOptimisticMessages(current => [...current, { id: variables.optimisticId, prompt: variables.message, createdAt: new Date().toISOString() }]);
      setPrompt('');
      setComposerReferences([]);
      setSendMode('queue');
    },
    onSuccess: (result, variables) => {
      const existing = qc.getQueryData<Task[]>(['tasks', session.id])?.find(task => task.id === result.task.id);
      const task = existing && existing.status !== 'queued' ? existing : result.task;
      qc.setQueryData<Task[]>(['tasks', session.id], current => [...(current ?? []).filter(item => item.id !== task.id), task]);
      setOptimisticMessages(current => task.status === 'queued'
        ? current.map(item => item.id === variables.optimisticId ? { ...item, taskId: task.id } : item)
        : current.filter(item => item.id !== variables.optimisticId));
    },
    onError: (error, variables) => {
      setOptimisticMessages(current => current.filter(item => item.id !== variables.optimisticId));
      setPrompt(current => current || variables.draft);
      setComposerReferences(current => current.length ? current : variables.references);
      setActionError(error.message);
    }
  });
  const cancelQueued = useMutation({ mutationFn: (taskId: string) => api.cancelQueued(session.id, taskId), onSuccess: result => qc.setQueryData<Task[]>(['tasks', session.id], current => current?.map(task => task.id === result.id ? result : task)), onError: error => setActionError(error.message) });
  const steerQueued = useMutation({ mutationFn: (taskId: string) => api.steerQueued(session.id, taskId), onSuccess: () => { setActionError(undefined); void qc.invalidateQueries({ queryKey: ['tasks', session.id] }); }, onError: error => setActionError(error.message) });
  const editQueued = useMutation({
    mutationFn: (taskId: string) => api.cancelQueued(session.id, taskId),
    onSuccess: result => {
      setActionError(undefined);
      qc.setQueryData<Task[]>(['tasks', session.id], current => current?.map(task => task.id === result.id ? result : task));
      const { text, references } = parsePromptToDraft(result.prompt, advertisedCommands.map(command => command.name));
      const restored = references.map(reference => {
        if (reference.kind !== 'image') return reference;
        const url = queuedImageThumbnailUrl(reference.value);
        return url ? { ...reference, url } : reference;
      });
      setComposerReferences(current => {
        const existing = new Set(current.map(item => item.id));
        return [...current, ...restored.filter(item => !existing.has(item.id))];
      });
      setPrompt(current => [current.trim(), text].filter(Boolean).join('\n\n'));
      requestAnimationFrame(() => composerTextarea.current?.focus());
    },
    onError: error => setActionError(error.message)
  });
  const archive = useMutation({ mutationFn: () => api.archive(session.id), onSuccess: result => { qc.setQueryData<Session[]>(['sessions'], current => current?.map(item => item.id === result.id ? result : item)); setArchiveConfirm(false); if (secondary) useDockStore.getState().tabs.filter(tab => tab.sessionId === session.id).forEach(tab => closeTab(tab.id)); else setSession(undefined); }, onError: error => setActionError(error.message) });
  const refreshModels = useMutation({ mutationFn: ({ agentId, currentModel }: { agentId: string; currentModel?: string }) => loadAgentModels(agentId, currentModel, true), onSuccess: (result, variables) => { setActionError(undefined); qc.setQueryData(agentModelsQueryKey(variables.agentId, variables.currentModel), result); }, onError: error => setActionError(error.message) });
  const switchModel = useMutation({ mutationFn: (nextModel: string) => api.setSessionModel(session.id, nextModel), onSuccess: result => { setActionError(undefined); qc.setQueryData<Session[]>(['sessions'], current => current?.map(item => item.id === result.id ? result : item)); void models.refetch(); }, onError: error => setActionError(error.message) });
  const switchReasoningEffort = useMutation({ mutationFn: (nextReasoningEffort: string) => api.setSessionReasoningEffort(session.id, nextReasoningEffort), onSuccess: result => { setActionError(undefined); qc.setQueryData<Session[]>(['sessions'], current => current?.map(item => item.id === result.id ? result : item)); }, onError: error => setActionError(error.message) });
  const modelReadiness = getModelReadiness({ loaded: models.data !== undefined, loading: models.data === undefined && (models.isPending || models.isFetching || refreshModels.isPending), switching: switchModel.isPending, failed: models.data === undefined && models.isError });

  useBufferedEventStream({
    sessionId: session.id,
    enabled: events.isSuccess,
    runId: session.runId,
    queryClient: qc,
    onSidecarEvent: event => {
      // 改名（用户手改 / Agent 推来）也是走 status 事件的，和 model / reasoningEffort 同一个通道。
      // title 为 null 表示这一档没有名字（回落链的另一档接手），所以显式赋 null 而不是跳过。
      if (event.type === 'status' && 'title' in event.data) qc.setQueryData<Session[]>(['sessions'], current => current?.map(item => item.id === session.id ? { ...item, title: event.data.title ?? undefined, titleSource: event.data.titleSource ?? undefined } : item));
      if (event.type === 'status' && Object.hasOwn(stateLabels, event.data.state)) qc.setQueryData<Session[]>(['sessions'], current => current?.map(item => item.id === session.id ? { ...item, state: event.data.state, ...(typeof event.data.model === 'string' ? { model: event.data.model } : {}), ...(typeof event.data.reasoningEffort === 'string' ? { reasoningEffort: event.data.reasoningEffort } : {}) } : item));
      if (event.type === 'task' && event.data.task) {
        qc.setQueryData<Task[]>(['tasks', session.id], current => [...(current ?? []).filter(task => task.id !== event.data.task.id), event.data.task]);
        if (event.data.task.status !== 'queued') setOptimisticMessages(current => current.filter(item => item.taskId !== event.data.task.id));
      }
    }
  });

  const submit = () => { if (modelReadiness.kind === 'blocked' || send.isPending) return; const message = buildPrompt(prompt, composerReferences, advertisedCommands.map(command => command.name)); if (message) { const mode = busyStates.has(session.state) ? sendMode : 'queue'; if (startsImmediately(session.state, mode, tasks.data)) timelineScroll.scrollToBottom(); send.mutate({ message, mode, draft: prompt, references: composerReferences, optimisticId: createOptimisticMessageId() }); } };
  // 飞书来源会话：sourceId 里带 chatId，可以生成 applink 直接跳回该群/私聊。
  // 话题会话没有官方 thread 级直达链接，退化为「进群」，用 exact 标记给个提示。
  const larkLink = session.source === 'lark' ? larkSessionAppLink(session.sourceId) : undefined;
  // 已经托管给机器人后，托管群就是唯一的飞书入口：隐藏原来的飞书来源链接，避免看起来有两个通道。
  const handover = useQuery({ queryKey: ['session-handover', session.id], queryFn: () => api.sessionHandover(session.id), staleTime: 30_000 });
  const handoverInfo = handover.data?.handover ?? undefined;

  // 导入会话从外部 Agent 同步新轮次：用户在 Codex 等原客户端里续聊后，一键把 AgentDock 还没有的轮次补进来。
  // 其他会话的本地同步由 SSE + 聚焦全量重拉兼顾，不再放按钮。
  const syncToast = useToast();
  const externalName = agent?.name ?? session.agentId;
  const syncExternal = useMutation({
    mutationFn: () => api.syncExternal(session.id),
    onSuccess: async result => {
      const summary = result.added ? `已从 ${externalName} 同步 ${result.added} 轮新消息` : `${externalName} 里没有新消息`;
      // 两边交替聊时夹在中间的外部轮次放不进时间线中间，只提示数量。
      syncToast.show(result.skipped ? `${summary}；另有 ${result.skipped} 轮是在本会话消息之间发的，无法插入时间线，需要完整历史请重新导入` : summary, 'info');
      // 新轮次已经经 SSE 推过来；再全量重拉一次兜底，避免流断过时漏条。
      refetchFull.current = true;
      await Promise.all([events.refetch(), tasks.refetch(), qc.invalidateQueries({ queryKey: ['sessions'] })]);
    },
    onError: error => syncToast.show(error.message)
  });

  const act = async (action: string) => { try { setActionError(undefined); await api.action(session.id, action); } catch (error) { setActionError(error instanceof Error ? error.message : String(error)); } };

  // h-full w-full：本组件既被当作并排的 flex 子项（主区），也被塞进 PaneHost 的
  // absolute inset-0 容器（右栏标签）。后者不是 flex 上下文，只写 flex-1 会撑不满，
  // 表现为右栏内容只占左上角一块。
  return <div className={`flex h-full min-w-0 w-full ${secondary ? 'border-l border-zinc-200' : ''}`}>
    <section className="flex min-w-0 flex-1 flex-col">
      <header className="flex h-14 shrink-0 items-center gap-1 border-b border-zinc-200 bg-white/80 px-3 backdrop-blur sm:px-4">
        <span className="mr-1 md:hidden"><IconButton label="打开会话列表" onClick={onOpenSidebar}><Menu size={16}/></IconButton></span>
        <div className="min-w-0"><div className="flex items-center gap-2 text-[13px] font-semibold"><AgentIcon agentId={session.agentId} agentName={agent?.name} size={16}/><span className="truncate">{agent?.name ?? session.agentId}</span><span className={`h-1.5 w-1.5 shrink-0 rounded-full ${stateTone[session.state] ?? 'bg-zinc-400'}`}/><span className="shrink-0 text-[11px] font-normal text-zinc-500">{stateLabels[session.state] ?? session.state}</span></div><div className="mt-0.5 flex min-w-0 items-center gap-1.5 text-[10px] text-zinc-400"><Folder size={11} className="shrink-0"/><span title={session.cwd} className="truncate">{session.cwd}</span>{session.model && <span className="shrink-0">({session.model})</span>}</div></div>
        <div className="ml-auto flex shrink-0 items-center gap-0.5">{!session.archivedAt && busyStates.has(session.state) && <IconButton label="中断当前任务" onClick={() => void act('interrupt')}><Square size={14}/></IconButton>}{!session.archivedAt && <IconButton label={activeSchedules ? `定时任务（${activeSchedules} 个启用中）` : '定时任务'} active={activeSchedules > 0} onClick={() => setScheduleOpen(true)}><AlarmClock size={14}/></IconButton>}{session.systemPrompt && <IconButton label="查看系统提示词" onClick={() => setSystemPromptOpen(true)}><BookOpen size={14}/></IconButton>}{secondary && onOpenRawLog && <IconButton label="查看此侧边会话的原始日志" onClick={() => onOpenRawLog(session.id)}><ScrollText size={15}/></IconButton>}{!handoverInfo && larkLink && <IconButton label={larkLink.exact ? '在飞书中打开该会话' : '在飞书中打开该话题（若未定位请在群内查找）'} onClick={() => window.open(larkLink.url, '_blank', 'noopener,noreferrer')}><ExternalLink size={14}/></IconButton>}{handoverInfo && <IconButton label={`已托管：${handoverInfo.name}（打开托管群）`} onClick={() => window.open(handoverInfo.url, '_blank', 'noopener,noreferrer')}><Bot size={14} className="text-emerald-600"/></IconButton>}{!session.archivedAt && !handoverInfo && session.source !== 'lark' && <IconButton label="托管给机器人" onClick={() => setHandoverOpen(true)}><Bot size={14}/></IconButton>}{!session.archivedAt && session.source === 'import' && <IconButton label={syncExternal.isPending ? `正在从 ${externalName} 同步…` : `从 ${externalName} 同步新消息：把你在 ${externalName} 里续聊的新轮次补进本会话`} disabled={syncExternal.isPending || busyStates.has(session.state)} onClick={() => syncExternal.mutate()}><RefreshCw size={14} className={syncExternal.isPending ? 'animate-spin' : ''}/></IconButton>}{!session.archivedAt && <IconButton label="永久归档" disabled={archive.isPending} onClick={() => { archive.reset(); setArchiveConfirm(true); }}><Archive size={15}/></IconButton>}{!secondary && onTogglePane && <PaneToggleButton open={Boolean(paneOpen)} onToggle={onTogglePane}/>}
        </div>
      </header>
      {actionError && <div className="flex items-center border-b border-red-200 bg-red-50 px-4 py-2 text-xs text-red-700"><span className="min-w-0 truncate">{actionError}</span><button className="ml-2 shrink-0" onClick={() => setActionError(undefined)} aria-label="关闭错误提示"><X size={13}/></button></div>}
      <div className="flex min-h-0 flex-1">
        <div className="flex min-w-0 flex-1 flex-col">
      <div className="relative min-h-0 flex-1"><div ref={timelineScroll.containerRef} onScroll={timelineScroll.onScroll} onClickCapture={event => { if (event.target instanceof Element && event.target.closest('[data-timeline-disclosure]')) timelineScroll.pauseFollowing(); }} className="absolute inset-0 overscroll-contain overflow-y-auto [overflow-anchor:none]"><div ref={timelineScroll.contentRef} className={`mx-auto w-full max-w-[820px] px-5 py-8 sm:px-8 sm:py-10 ${!events.isLoading && !timeline.length ? 'flex min-h-full flex-col justify-center' : ''}`}>
        {events.isLoading ? <div className="space-y-5"><div className="h-4 w-3/4 animate-pulse rounded bg-zinc-200"/><div className="h-4 w-1/2 animate-pulse rounded bg-zinc-200"/><div className="h-20 animate-pulse rounded-xl bg-zinc-100"/></div> : timeline.length ? <>{timelineSections.map((section, index) => section.kind === 'event' ? <TimelineItem key={section.event.id} event={section.event} final={section.final} streaming={isStreamingSection(section, sessionBusy, index === timelineSections.length - 1)} replay={section.event.timestamp < mountedAt} assistantLabel={outputLabel} sessionId={session.id}/> : <ActivityPanel key={section.turnId} groups={section.groups} replay={Boolean(section.startedAt && section.startedAt < mountedAt)} sessionId={session.id} hasAnswer={section.hasAnswer} taskStatus={section.taskStatus} ongoing={isTurnOngoing(section, sessionBusy)} modelLabel={outputLabel} startedAt={section.startedAt} completedAt={section.completedAt}/>)}{sessionBusy && latestUserIndex >= 0 && !hasOngoingActivity && <ActivityPanel groups={[]} sessionId={session.id} ongoing modelLabel={outputLabel} startedAt={timeline[latestUserIndex]?.timestamp}/>}</> : <div className="ui-empty-state flex flex-col items-center justify-center text-center"><div className="grid h-12 w-12 place-items-center rounded-2xl border border-zinc-200/80 bg-white/80 text-zinc-600 shadow-[0_3px_12px_rgba(24,24,27,.05)]"><MessageSquare size={19}/></div><p className="mt-5 text-[11px] font-medium tracking-[.08em] text-zinc-400">工作区已就绪</p><h2 className="mt-1.5 text-[18px] font-semibold tracking-tight text-zinc-800">从一个问题开始</h2><p className="mt-2 max-w-xs leading-5 text-xs text-zinc-500">让 Agent 检查代码、实现改动或讲解当前项目。</p><div className="mt-6 flex max-w-sm flex-wrap justify-center gap-2">{['了解当前项目', '检查未提交改动', '帮我规划下一步'].map(suggestion => <button key={suggestion} type="button" onClick={() => { setPrompt(suggestion); composerTextarea.current?.focus(); }} className="rounded-full border border-zinc-200/90 bg-white/75 px-3 py-1.5 text-[11px] text-zinc-600 transition-colors hover:border-zinc-300 hover:bg-white hover:text-zinc-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-zinc-400/50">{suggestion}</button>)}</div></div>}
        </div></div>{showScrollToBottom && <button type="button" onClick={timelineScroll.scrollToBottom} className="absolute bottom-4 right-5 z-10 flex h-9 items-center gap-1.5 rounded-lg border border-zinc-200 bg-white px-3 text-[12px] font-medium text-zinc-700 shadow-[0_8px_24px_rgba(24,24,27,.12)] transition-colors hover:border-zinc-300 hover:bg-zinc-50" aria-label="回到最新消息">回到底部</button>}</div>
      {session.archivedAt ? <div className="border-t border-zinc-200 bg-white/75 px-4 py-3 text-center text-xs text-zinc-500">该会话已永久归档，仅支持查看。</div> : <Composer sessionId={session.id} state={session.state} value={prompt} references={composerReferences} sending={send.isPending} mode={sendMode} queuedTasks={queuedTasks} cancellingTaskId={cancelQueued.isPending ? cancelQueued.variables : undefined} steeringTaskId={steerQueued.isPending ? steerQueued.variables : undefined} editingTaskId={editQueued.isPending ? editQueued.variables : undefined} skills={skills.data ?? []} models={models.data?.models ?? []} reasoningEfforts={models.data?.reasoningEfforts ?? []} currentModel={session.model ?? models.data?.defaultModel} currentReasoningEffort={session.reasoningEffort ?? models.data?.defaultReasoningEffort} context={composerContext} advertisedCommands={advertisedCommands} modelReadiness={modelReadiness} switchingModel={switchModel.isPending} switchingReasoningEffort={switchReasoningEffort.isPending} refreshingModels={models.isFetching || refreshModels.isPending} textareaRef={composerTextarea} onChange={setPrompt} onReferencesChange={setComposerReferences} onModeChange={setSendMode} onSubmit={submit} onInterrupt={() => void act('interrupt')} onCancelQueued={taskId => cancelQueued.mutate(taskId)} onSteerQueued={taskId => { timelineScroll.scrollToBottom(); steerQueued.mutate(taskId); }} onEditQueued={task => editQueued.mutate(task.id)} onModelChange={nextModel => switchModel.mutate(nextModel)} onReasoningEffortChange={nextReasoningEffort => switchReasoningEffort.mutate(nextReasoningEffort)} onRefreshModels={() => refreshModels.mutate({ agentId: session.agentId, currentModel: session.model })}/>}
        </div>
      </div>
    </section>

    {syncToast.toast}
    {handoverOpen && <HandoverDialog session={session} agent={agent} onClose={() => setHandoverOpen(false)}/>}
    <ConfirmDialog open={archiveConfirm} tone="danger" title="归档此会话？" description="归档后会话将变为只读且无法恢复。历史消息和执行记录会保留在归档列表中。" confirmLabel="确认归档" busy={archive.isPending} error={archive.error?.message} onCancel={() => { if (!archive.isPending) setArchiveConfirm(false); }} onConfirm={() => archive.mutate()}/>
    {scheduleOpen && <ScheduleDialog session={session} sessions={sessions.data ?? []} onClose={() => setScheduleOpen(false)} onOpenSession={setSession}/>}
    {systemPromptOpen && session.systemPrompt && <div className="ui-overlay fixed inset-0 z-30 grid place-items-center bg-zinc-950/30 p-4 backdrop-blur-[2px]" onMouseDown={event => { if (event.currentTarget === event.target) setSystemPromptOpen(false); }}>
      <div className="ui-dialog flex max-h-[80dvh] w-full max-w-2xl flex-col overflow-hidden rounded-2xl border border-zinc-200 bg-white shadow-[0_24px_80px_rgba(24,24,27,.2)]">
        <div className="flex items-center border-b border-zinc-100 px-4 py-3"><div className="min-w-0"><h2 className="text-[14px] font-semibold text-zinc-900">系统提示词</h2><p className="mt-0.5 truncate text-[11px] text-zinc-500">创建时提示词</p></div><span className="ml-auto"><IconButton label="关闭" onClick={() => setSystemPromptOpen(false)}><X size={16}/></IconButton></span></div>
        <div className="space-y-5 overflow-y-auto px-4 py-4"><section><h3 className="mb-2 text-[11px] font-semibold text-zinc-500">创建时提示词</h3><pre className="m-0 whitespace-pre-wrap break-words font-mono text-[12px] leading-5 text-zinc-700">{session.systemPrompt}</pre></section></div>
      </div>
    </div>}
  </div>;
}
