import { ExitGate } from './ExitGate';
import { PanelRight, AlarmClock, ArrowDown, BookOpen, Bot, ExternalLink, Menu, MessageSquare, Puzzle, Search, SlidersHorizontal, StickyNote, Sunset, Archive, X, RefreshCw, RotateCcw, ScrollText, MoreHorizontal } from 'lucide-react';
import { memo, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useDebounce } from 'ahooks';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ASK_USER_QUESTION_ANSWER_ORIGIN,
  BUILTIN_ASK_USER_QUESTION_PLUGIN_ID,
  defaultOutputPluginRegistry,
  mergeSessionOutputPluginsPatch,
  outputPluginInstanceKey,
  TASK_RECOVERY_ORIGIN,
  type AskUserQuestionAnswerItem,
  type DeclarativeInteractionField,
  type OutputPluginCatalogItem,
  type OutputPluginMetadata,
  type OutputPluginRegistry,
  type OutputPluginsGlobalConfig,
  type TaskRecoveryRecord
} from '@agent-dock/agent-dock-shared';
import { api, type Agent, type DockEvent, type LlmAssistContext, type Session, type Task } from './api';
import { AiTextAssistControl, useAiFlash } from './AiTextAssist';
import { awaitsFirstOutput, bindOptimisticTask, buildTimeline, buildTimelineSections, EMOJI_TRIGGER_ORIGIN, groupTimelineSections, isStreamingSection, isTurnOngoing, optimisticRowKeys, startsImmediately, timelineRowKey, turnTimeBadge, waitingQueuedTasks, type OptimisticMessage } from './timeline';
import { ActivityPanel, SystemPromptBubble, TimelineItem } from './TimelineItems';
import { shouldRenderRecoveryCard, TaskRecoveryConfirmCard } from './TaskRecoveryTimeline';
import { TimelineTurn } from './SendTimeHint';
import { Composer, type ComposerOutputPluginItem } from './Composer';
import {
  buildEffectiveGlobalPluginsConfig,
  buildFallbackOutputPluginCatalogItems,
  buildSessionOutputPluginItems
} from './output-plugins/useOutputPlugins';
import type { ComposerEditorHandle } from './ComposerEditor';
import { elapsedText, resolveElapsed } from './elapsed';
import { buildPrompt, commandsFromEvents, contextStatsFromEvents, getModelReadiness, parsePromptToDraft, queuedImageThumbnailUrl, resolveActiveSteeringTaskId, type ComposerReference } from './composer-utils';
import { computeLiveStreamTps, latestTurnUsageEventTps } from './live-tps';
import { useTimelineAutoScroll } from './useTimelineAutoScroll';
import { useHealOnFocus } from './useHealOnFocus';
import { useBufferedEventStream } from './useBufferedEventStream';
import { healBoundary, mergeEventBatch, replaceEventTail } from './event-buffer';
import { agentModelsQueryKey, loadAgentModels, readInitialAgentModels, writeCachedAgentModels } from './model-cache';
import { createSessionConfigSwitchLane } from './session-config-switch';
import { sessionStateLabel, stateLabels, stateTone, busyStates } from './session-states';
import { ConfirmDialog, IconButton } from './ui-controls';
import { HoverTooltip, HoverTooltipText } from './HoverTooltip';
import { SessionAgentUsagePopover } from './SessionAgentUsagePopover';
import { getActiveAppDialog, openAppDialog } from './dialog-store';
import { shortcutLabel } from './useShortcuts';
import { TimelineSearchBar } from './TimelineSearchBar';
import { isTimelineFindShortcut, normalizeSearchQuery, searchTimeline, shouldHandleTimelineFindShortcut, stepSearchIndex, SYSTEM_PROMPT_SEARCH_KEY } from './timeline-search';
import { applyTimelineSearchHighlights, clearTimelineSearchHighlights, findTextRangesInElement, scrollMatchIntoView } from './timeline-search-highlight';
import { larkSessionAppLink } from './lark-session-link';
import { fetchTaskSnapshot, mergeTaskSnapshots, upsertTask } from './task-snapshots';
import { sessionLabel, workspaceLabel } from './session-groups';
import { useDismissOnOutsidePointer } from './useDismissOnOutsidePointer';
import { useDockStore, type PaneKind } from './store';
import { createOptimisticMessageId } from './optimistic-message-id';
import { createClientMessageId } from './client-message-id';
import { useToast } from './Toast';
import { CompanionHeader, CompanionWelcome, useMainSessionId } from './companion/CompanionHeader';
import { useCompanion } from './companion/useCompanion';
import { useCompanionStore } from './companion/companion-store';
import { openRetireCeremony, retireEntry } from './companion/lifecycle-model';
import { sessionPaneTab } from './pane-tab';
import { DEFAULT_SIDE_CHAT_TRIGGER_PREFIX, matchSideChatTrigger, sideChatBuiltinCommand } from './side-chat-config';
import { clearSessionDraft, getBrowserDraftStorage, loadSessionDraft, MAX_DRAFT_CHARS, saveSessionDraft } from './session-drafts';
import { useSessionDraftWriter } from './use-session-draft';
import { useElapsedNow } from './useElapsedNow';
import { SelectionQuotePopover } from './SelectionQuotePopover';
import { normalizeQuotedText } from './selection-quote';
import { getSessionStarterPrompts } from './prompt-templates';
import { useBi, useLocale } from './i18n';

/** 主会话输入框的占位：单独成组件，小猫改名时只重渲染这一小块，不拖着整条时间线。 */
function CompanionPlaceholder() {
  const L = useBi();
  const { name } = useCompanion();
  return <><span className="hidden sm:inline">{L("跟", "Ask ")}{name}{L("说说要做什么，Enter 发送；它会拆成便签派出去", " what to do (Enter to send; it will break it into tasks)")}</span><span className="sm:hidden">{L("跟", "Ask ")}{name}{L("说说要做什么", " what to do")}</span></>;
}

type SendMode = 'queue' | 'interrupt';
/** 表情触发的轮次不能出现在「等待发送」面板：它不是用户可编辑的消息。 */
// 整理轮次、交接说明与问答提交轮次不进「等待发送」编辑面板，避免系统指令或结构化 JSON 暴露成可编辑草稿。
const BASE_HIDDEN_QUEUE_ORIGINS: ReadonlyArray<string> = [EMOJI_TRIGGER_ORIGIN, 'maintenance', 'handoff', ASK_USER_QUESTION_ANSWER_ORIGIN, TASK_RECOVERY_ORIGIN];

/**
 * 会话标题栏的副屏开关。空副屏里直接展示可打开的面板类型。
 */
function PaneToggleButton({ open, onToggle }: { open: boolean; onToggle(): void }) {
  const L = useBi();
  return <IconButton label={open ? L("隐藏副屏", "Hide Side Pane") : L("显示副屏", "Show Side Pane")} active={open} onClick={onToggle}><PanelRight size={15}/></IconButton>;
}

type SessionMenuItem = { id: string; label: string; icon: ReactNode; trailing?: ReactNode; danger?: boolean; disabled?: boolean; onSelect(): void };
type SessionMenuGroup = { items: SessionMenuItem[] };
type MenuIndicatorTone = 'alert' | 'warning' | 'active';

const menuIndicatorDotClass: Record<MenuIndicatorTone, string> = {
  alert: 'bg-red-500',
  warning: 'bg-amber-500',
  active: 'bg-emerald-500'
};

/** 会话标题栏的 ⋯ 菜单：分组收纳所有会话级与主会话辅助操作，支持上下键、回车、Esc 与轻微状态点感知。 */
function SessionMenu({ groups, indicator, tooltip }: { groups: SessionMenuGroup[]; indicator?: MenuIndicatorTone; tooltip?: string }) {
  const L = useBi();
  const resolvedTooltip = tooltip ?? L("更多操作", "More Actions");
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const close = () => setOpen(false);
  useDismissOnOutsidePointer(root, open, close);
  useEffect(() => {
    if (!open) return;
    menu.current?.querySelector<HTMLButtonElement>('[role="menuitem"]:not(:disabled)')?.focus();
  }, [open]);
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); close(); trigger.current?.focus(); return; }
      if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
      const items = [...(menu.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not(:disabled)') ?? [])];
      if (!items.length) return;
      event.preventDefault();
      const index = items.indexOf(document.activeElement as HTMLButtonElement);
      const next = index < 0 ? (event.key === 'ArrowDown' ? 0 : items.length - 1) : (index + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
      items[next]?.focus();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open]);
  return <div ref={root} className="relative">
    <HoverTooltip content={open ? undefined : resolvedTooltip} hoverOnly>
      <button ref={trigger} type="button" aria-haspopup="menu" aria-expanded={open} aria-label={resolvedTooltip} onClick={() => setOpen(value => !value)} className={`ui-press relative grid h-8 w-8 place-items-center rounded-lg hover:bg-zinc-100 hover:text-zinc-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-zinc-400/50 ${open ? 'bg-zinc-100 text-zinc-900' : 'text-zinc-500'}`}>
        <MoreHorizontal size={16}/>
        {indicator && <span aria-hidden="true" data-menu-indicator={indicator} className={`absolute right-1.5 top-1.5 h-1.5 w-1.5 rounded-full ring-2 ring-canvas ${menuIndicatorDotClass[indicator]}`}/>}
      </button>
    </HoverTooltip>
    <ExitGate open={open} ms={150}>
      <div ref={menu} role="menu" aria-label={L("会话操作", "Session Actions")} data-placement="top-end" className="ui-popover absolute right-0 top-[calc(100%+6px)] z-50 w-72 max-w-[calc(100vw-1.5rem)] rounded-xl border border-zinc-200 bg-white p-1.5 shadow-[0_16px_48px_rgba(0,0,0,.16)]">
        {groups.map((group, index) => <div key={index}>
          {index > 0 && <div className="my-1 border-t border-zinc-100"/>}
          {group.items.map(item => <button key={item.id} type="button" role="menuitem" data-testid={`session-menu-item-${item.id}`} disabled={item.disabled} onClick={() => { close(); item.onSelect(); }} className={`ui-press flex h-[34px] w-full items-center gap-2.5 rounded-lg px-2.5 text-left text-[13.5px] disabled:cursor-not-allowed disabled:opacity-40 ${item.danger ? 'text-red-600 hover:bg-red-50' : 'text-zinc-700 hover:bg-zinc-100'}`}>
            <span className={`shrink-0 ${item.danger ? 'text-red-500' : 'text-zinc-500'}`}>{item.icon}</span>
            <span className="min-w-0 flex-1 truncate">{item.label}</span>
            {item.trailing}
          </button>)}
        </div>)}
      </div>
    </ExitGate>
  </div>;
}

/**
 * 主会话专属的「更多」菜单桥接：单独订阅 useCompanion，避免便签轮询触发整条时间线重渲染。
 * 把退休/交接与便签墙辅助入口克制收进 ⋯ 菜单，并通过轻微状态点保持感知。
 */
function MainSessionMoreMenu({
  regularGroups,
  dangerGroups,
  baseIndicator,
  baseTooltip
}: {
  regularGroups: SessionMenuGroup[];
  dangerGroups: SessionMenuGroup[];
  baseIndicator?: MenuIndicatorTone;
  baseTooltip?: string;
}) {
  const L = useBi();
  const info = useCompanion();
  const retire = retireEntry({ isMain: true, handoff: info.lifecycle?.handoff });
  const attention = info.counts.needsUser + info.counts.planned + info.pendingDrafts;
  const retireLabel = retire.progress
    ? (info.lifecycle?.handoff?.state === 'proposed' ? L("查看交接提议", "View Handover Proposal") : L("查看交接进度", "View Handover Progress"))
    : L("提前退休并交接", "Retire & Hand Over Early");

  const mainGroup: SessionMenuGroup = {
    items: [
      {
        id: 'companion-notes',
        label: L("便签墙", "Sticky Wall"),
        icon: <StickyNote size={16}/>,
        ...(info.counts.open > 0 || info.pendingDrafts > 0
          ? {
            trailing: <span className={`shrink-0 rounded-full px-1.5 py-0.5 text-[11px] font-medium tabular-nums ${info.counts.needsUser > 0 ? 'bg-red-100 text-red-700' : 'bg-zinc-100 text-zinc-500'}`}>
              {info.counts.open + info.pendingDrafts}
            </span>
          }
          : {}),
        onSelect: () => useCompanionStore.getState().toggleDrawer()
      },
      ...(retire.visible ? [{
        id: 'companion-retire',
        label: retireLabel,
        icon: <Sunset size={16}/>,
        ...(retire.progress ? { trailing: <span className="h-2 w-2 shrink-0 rounded-full bg-amber-500"/> } : {}),
        onSelect: () => openRetireCeremony(retire, id => useCompanionStore.getState().openCeremony(id))
      } satisfies SessionMenuItem] : [])
    ]
  };

  const indicator: MenuIndicatorTone | undefined = info.counts.needsUser > 0
    ? 'alert'
    : (retire.progress || attention > 0)
      ? 'warning'
      : baseIndicator;

  const tooltip = info.counts.needsUser > 0
    ? L(`更多操作（${info.counts.needsUser} 件便签需要你）`, `More Actions (${info.counts.needsUser} notes need you)`)
    : retire.progress
      ? L(`更多操作（${retire.label}）`, `More Actions (${retire.label})`)
      : attention > 0
        ? L(`更多操作（${attention} 项待确认）`, `More Actions (${attention} pending)`)
        : baseTooltip;

  const allGroups = [...regularGroups, mainGroup, ...dangerGroups].filter(group => group.items.length > 0);
  return <SessionMenu groups={allGroups} indicator={indicator} tooltip={tooltip}/>;
}

export const SessionPane = memo(function SessionPane({ session, agent, pane, onOpenSidebar, paneOpen, onTogglePane, onOpenRawLog, btwEnabled = false, btwTriggerPrefix = DEFAULT_SIDE_CHAT_TRIGGER_PREFIX, askUserQuestionXmlEnabled = true, outputPluginItems, outputPluginsGlobalConfig, outputPluginRegistry = defaultOutputPluginRegistry, onSideChat }: {
  session: Session;
  agent?: Agent;
  pane: PaneKind;
  onOpenSidebar(): void;
  paneOpen?: boolean;
  onTogglePane?(): void;
  onOpenRawLog?(sessionId: string): void;
  btwEnabled?: boolean;
  btwTriggerPrefix?: string;
  askUserQuestionXmlEnabled?: boolean;
  outputPluginItems?: OutputPluginCatalogItem[];
  outputPluginsGlobalConfig?: OutputPluginsGlobalConfig;
  outputPluginRegistry?: OutputPluginRegistry;
  onSideChat?(source: Session, options?: { initialPrompt?: string; fromBtw?: boolean }): Promise<void> | void;
}) {
  const L = useBi();
  const locale = useLocale();
  const qc = useQueryClient();
  const { setSession, closeTab } = useDockStore();
  const secondary = pane === 'secondary';
  const [prompt, setPrompt] = useState(() => loadSessionDraft(getBrowserDraftStorage(), session.id)); const [composerReferences, setComposerReferences] = useState<ComposerReference[]>([]); const [quotedText, setQuotedText] = useState<string>(); const [sendMode, setSendMode] = useState<SendMode>('queue');
  useEffect(() => { setQuotedText(undefined); }, [session.id]);
  const [optimisticMessages, setOptimisticMessages] = useState<OptimisticMessage[]>([]);
  const [optimisticPluginInteractions, setOptimisticPluginInteractions] = useState<Record<string, unknown>>({});
  const [submittingPluginKey, setSubmittingPluginKey] = useState<string>();
  const [pluginSubmitErrors, setPluginSubmitErrors] = useState<Record<string, string>>({});
  const [heldSteeringTaskId, setHeldSteeringTaskId] = useState<string>();
  const steerInFlight = useRef(false);
  useEffect(() => {
    steerInFlight.current = false;
    setHeldSteeringTaskId(undefined);
    setOptimisticPluginInteractions({});
    setSubmittingPluginKey(undefined);
    setPluginSubmitErrors({});
  }, [session.id]);
  const [actionError, setActionError] = useState<string>(); const [archiveConfirm, setArchiveConfirm] = useState(false); const [mainArchiveBlocked, setMainArchiveBlocked] = useState(false);
  const composerTextarea = useRef<ComposerEditorHandle>(null);
  const promptRef = useRef(prompt);
  promptRef.current = prompt;
  // 发送/失败恢复都以编辑器当前文档为准：受控 prompt 比编辑器晚 200ms 才更新。
  const readLiveDraft = () => composerTextarea.current?.getValue() ?? promptRef.current;
  // 这个面板是不是主会话（小猫）。只订阅主会话 id，不随便签轮询重渲染。
  const mainSessionId = useMainSessionId();
  const isMain = session.id === mainSessionId;
  // 主会话被归档，或者恢复时 Agent 没起来留下 stopped/failed，都要能从这里重试；
  // 否则归档标记清掉后横幅就消失，输入框却还是禁用，仍然是个死角。
  const mainNeedsRestart = isMain && (Boolean(session.archivedAt) || session.state === 'stopped' || session.state === 'failed');
  // 便签上的「问问它」：把便签带进主会话输入框，接着聚焦。
  const mainDraft = useCompanionStore(store => (isMain && !secondary ? store.mainDraft : undefined));
  const injectedDraft = useDockStore(store => store.sessionDrafts[session.id]);
  useEffect(() => {
    if (!mainDraft) return;
    setPrompt(current => current.trim() ? `${current.trimEnd()}\n\n${mainDraft.text}` : mainDraft.text);
    useCompanionStore.getState().consumeMainDraft();
    requestAnimationFrame(() => composerTextarea.current?.focus());
  }, [mainDraft]);
  useEffect(() => {
    if (!injectedDraft) return;
    setPrompt(current => current.trim() ? `${current.trimEnd()}\n\n${injectedDraft}` : injectedDraft);
    useDockStore.getState().clearSessionDraft(session.id);
    requestAnimationFrame(() => composerTextarea.current?.focus());
  }, [injectedDraft, session.id]);

  // 增量拉取是 append-only，无法修正已缓存的过期条目；focus 之后的那次拉取改走自愈：
  // 重拉缓存里最后一轮并整段替换（见 healBoundary），不再重拉整段历史。
  // 每个 pane 各自持有一个布尔 ref，两个 pane 都会独立触发自愈。
  const healNextFetch = useHealOnFocus();
  const events = useQuery({
    queryKey: ['events', session.id],
    queryFn: async ({ queryKey }) => {
      const sessionId = queryKey[1] as string;
      const heal = healNextFetch.current;
      healNextFetch.current = false;
      const cached = qc.getQueryData<DockEvent[]>(queryKey) ?? [];
      const after = heal ? healBoundary(cached) : cached.reduce((max, event) => Math.max(max, event.sequence), 0);
      const fresh = await api.events(sessionId, after || undefined);
      const live = qc.getQueryData<DockEvent[]>(queryKey) ?? cached;
      if (heal || !after) return replaceEventTail(live, after, fresh);
      return mergeEventBatch(live, fresh);
    },
    enabled: true
  });
  // 轮询请求可能先发出、后返回，把已经切成 running 的任务又写回 queued（见 task-snapshots.ts）。
  const tasks = useQuery({
    queryKey: ['tasks', session.id],
    queryFn: () => fetchTaskSnapshot(() => qc.getQueryData<Task[]>(['tasks', session.id]), () => api.tasks(session.id)),
    refetchInterval: 2_000,
    refetchIntervalInBackground: true
  });
  const systemCapabilities = useQuery({ queryKey: ['system-capabilities'], queryFn: api.systemCapabilities, staleTime: 300_000 });
  const syncToast = useToast();
  const syncToastRef = useRef(syncToast);
  syncToastRef.current = syncToast;
  // 切换模型与思考深度采用「乐观更新 + 序列号 last-write-wins + 失败回滚 & Toast + 完成微反馈」：
  // 连续快切时旧请求晚到绝不覆盖新选择，且切换进行中不提前触发未预热的 /models 重查。
  const [pendingModel, setPendingModel] = useState<string>();
  const [pendingReasoningEffort, setPendingReasoningEffort] = useState<string>();
  const [modelJustSwitched, setModelJustSwitched] = useState(false);
  const [reasoningJustSwitched, setReasoningJustSwitched] = useState(false);
  const [switchingPluginId, setSwitchingPluginId] = useState<string>();
  const [pluginsJustSwitched, setPluginsJustSwitched] = useState(false);
  const modelSwitchLaneRef = useRef(createSessionConfigSwitchLane());
  const reasoningSwitchLaneRef = useRef(createSessionConfigSwitchLane());
  const pluginSwitchVersionRef = useRef(0);
  const pluginSwitchInFlightRef = useRef(false);
  const modelSavedTimerRef = useRef<number | undefined>(undefined);
  const reasoningSavedTimerRef = useRef<number | undefined>(undefined);
  const pluginSavedTimerRef = useRef<number | undefined>(undefined);

  const effectivePluginCatalog = useMemo<OutputPluginCatalogItem[]>(
    () => (outputPluginItems?.length ? outputPluginItems : buildFallbackOutputPluginCatalogItems()),
    [outputPluginItems]
  );
  const effectiveGlobalPluginsConfig = useMemo<OutputPluginsGlobalConfig>(
    () => buildEffectiveGlobalPluginsConfig(effectivePluginCatalog, outputPluginsGlobalConfig, askUserQuestionXmlEnabled),
    [effectivePluginCatalog, outputPluginsGlobalConfig, askUserQuestionXmlEnabled]
  );

  const composerOutputPlugins = useMemo<ComposerOutputPluginItem[]>(
    () => buildSessionOutputPluginItems(
      effectivePluginCatalog,
      effectiveGlobalPluginsConfig,
      session.outputPlugins,
      session.askUserQuestionEnabled
    ),
    [effectivePluginCatalog, effectiveGlobalPluginsConfig, session.outputPlugins, session.askUserQuestionEnabled]
  );

  const enabledOutputPluginIds = useMemo(
    () => new Set(composerOutputPlugins.filter(item => item.enabled).map(item => item.id)),
    [composerOutputPlugins]
  );
  const effectiveAskUserQuestionEnabled = enabledOutputPluginIds.has(BUILTIN_ASK_USER_QUESTION_PLUGIN_ID);

  const outputLabel = session.model ?? agent?.name ?? session.agentId ?? 'Agent';
  // 切换模型请求在途时先稳住目录查询 key，待服务端返回内联 discoveredModels 并写入 fresh 缓存后再切 key，
  // 避免 PATCH 与未命中的 GET /models 并发撞车触发多余 CLI 探测。
  const modelsQueryModel = pendingModel !== undefined ? modelSwitchLaneRef.current.rollbackValue : session.model;
  const models = useQuery({
    queryKey: agentModelsQueryKey(session.agentId, modelsQueryModel, session.sshHost),
    queryFn: () => loadAgentModels(session.agentId, modelsQueryModel, false, session.sshHost),
    enabled: !session.archivedAt,
    initialData: () => session.sshHost ? undefined : readInitialAgentModels(session.agentId, modelsQueryModel),
    initialDataUpdatedAt: 0,
    // 同 Agent 切换模型时沿用上一份目录占位，下拉秒开、不闪回「模型加载中…」，后台 SWR 静默刷新新模型支持的思考深度。
    placeholderData: (previous, previousQuery) => (previousQuery?.queryKey?.[1] === session.agentId && previousQuery?.queryKey?.[3] === (session.sshHost ?? 'local') ? previous : undefined),
    refetchOnMount: true,
    staleTime: 60_000
  });
  // Skills are read from the local filesystem; a remote session's cwd is a
  // remote path, so scanning it locally would return another project's skills.
  const skills = useQuery({ queryKey: ['skills', session.cwd], queryFn: () => api.skills(session.cwd), enabled: !session.archivedAt && !session.sshHost, staleTime: 60_000 });
  const composerContext = useMemo(() => contextStatsFromEvents(events.data), [events.data]);
  const advertisedCommands = useMemo(() => commandsFromEvents(events.data), [events.data]);
  const sessionUsage = useQuery({ queryKey: ['session-usage', session.id], queryFn: () => api.sessionUsage(session.id), staleTime: 10_000, refetchOnWindowFocus: false });
  const turnUsageEvents = useMemo(() => (events.data ?? []).filter(item => item.type === 'status' && item.data?.state === 'turn_usage').length, [events.data]);
  useEffect(() => {
    if (turnUsageEvents > 0) void qc.invalidateQueries({ queryKey: ['session-usage', session.id] });
  }, [qc, session.id, turnUsageEvents]);
  const sessionBusy = busyStates.has(session.state);
  const liveTpsTick = useElapsedNow(sessionBusy, 500);
  const liveStreamTps = useMemo(() => computeLiveStreamTps(events.data, liveTpsTick, sessionBusy), [events.data, liveTpsTick, sessionBusy]);
  const latestEventTps = useMemo(() => latestTurnUsageEventTps(events.data), [events.data]);
  const effectiveSessionUsage = useMemo(() => {
    if (!sessionUsage.data) return undefined;
    if (latestEventTps === null || sessionUsage.data.totals.lastTps === latestEventTps) return sessionUsage.data;
    return {
      ...sessionUsage.data,
      totals: { ...sessionUsage.data.totals, lastTps: latestEventTps }
    };
  }, [sessionUsage.data, latestEventTps]);
  // 会话头部一直显示「本轮」耗时：任务完成后仍按最后一次运行时间定格。
  // 旧记录没有 startedAt 时由 elapsed.ts 退化到 createdAt，并标「约」。
  const latestRuntimeTask = useMemo(() => [...(tasks.data ?? [])]
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt))
    .at(-1), [tasks.data]);
  const headerElapsedTick = useElapsedNow(
    latestRuntimeTask?.status === 'running' || latestRuntimeTask?.status === 'queued',
    latestRuntimeTask?.status === 'running' ? 1_000 : 30_000
  );
  const headerElapsed = latestRuntimeTask
    ? elapsedText(resolveElapsed({
        state: latestRuntimeTask.status,
        createdAt: latestRuntimeTask.createdAt,
        updatedAt: latestRuntimeTask.updatedAt
      }, headerElapsedTick))
    : undefined;
  // 标题栏时钟上的高亮：只算启用中的。和弹窗共用同一个缓存键，弹窗里的增删改会自动刷新这里。
  const schedules = useQuery({ queryKey: ['schedules', session.id], queryFn: () => api.schedules(session.id), enabled: !session.archivedAt, staleTime: 30_000 });
  const activeSchedules = schedules.data?.filter(item => item.enabled).length ?? 0;
  const sessionRecoveries = useQuery({
    queryKey: ['session-recoveries', session.id],
    queryFn: () => api.sessionRecoveries(session.id),
    staleTime: 5_000,
    refetchOnWindowFocus: true
  });
  const [submittingRecovery, setSubmittingRecovery] = useState<{ id: string; decision: 'resume' | 'dismiss' } | null>(null);
  const [recoveryErrors, setRecoveryErrors] = useState<Record<string, string>>({});
  const recoveryRecords = sessionRecoveries.data?.items ?? [];
  const recoveryByRecoveryTaskId = useMemo(() => {
    const map = new Map<string, TaskRecoveryRecord>();
    for (const rec of recoveryRecords) {
      if (rec.recoveryTaskId) map.set(rec.recoveryTaskId, rec);
    }
    return map;
  }, [recoveryRecords]);
  const visibleRecoveryCards = useMemo(
    () => recoveryRecords.filter(shouldRenderRecoveryCard),
    [recoveryRecords]
  );
  const handleDecideRecovery = useCallback(async (recoveryId: string, decision: 'resume' | 'dismiss') => {
    if (session.archivedAt) return;
    setSubmittingRecovery({ id: recoveryId, decision });
    setRecoveryErrors(current => {
      if (!(recoveryId in current)) return current;
      const next = { ...current };
      delete next[recoveryId];
      return next;
    });
    try {
      const result = await api.decideSessionRecovery(session.id, recoveryId, decision);
      qc.setQueryData<{ items: TaskRecoveryRecord[] }>(['session-recoveries', session.id], current => {
        const list = current?.items ?? [];
        const exists = list.some(item => item.id === result.record.id);
        return {
          items: exists
            ? list.map(item => (item.id === result.record.id ? result.record : item))
            : [...list, result.record]
        };
      });
      void qc.invalidateQueries({ queryKey: ['task-recovery-records'] });
      if (decision === 'resume') {
        void tasks.refetch();
        void qc.invalidateQueries({ queryKey: ['sessions'] });
      }
    } catch (error) {
      setRecoveryErrors(current => ({
        ...current,
        [recoveryId]: error instanceof Error ? error.message : L("操作失败，请稍后重试", "Action failed. Please try again.")
      }));
    } finally {
      setSubmittingRecovery(current => (current?.id === recoveryId ? null : current));
    }
  }, [qc, session.archivedAt, session.id, tasks]);
  const timeline = useMemo(() => buildTimeline(events.data, tasks.data, optimisticMessages), [events.data, tasks.data, optimisticMessages]); const timelineSections = useMemo(() => buildTimelineSections(timeline, tasks.data), [timeline, tasks.data]);
  const timelineTurns = useMemo(() => groupTimelineSections(timelineSections), [timelineSections]);
  const sentPromptByTaskId = useMemo(() => {
    const map = new Map<string, string>();
    for (const task of tasks.data ?? []) if (task.sentPrompt) map.set(task.id, task.sentPrompt);
    return map;
  }, [tasks.data]);
  const pluginInteractionsByKey = useMemo(() => {
    const map = new Map<string, unknown>();
    for (const event of timeline) {
      if (event.type === 'text') {
        const parsed = outputPluginRegistry.parseInteractionEvent(event.data.origin, event.data.text);
        if (parsed) {
          map.set(outputPluginInstanceKey(parsed.plugin.id, parsed.instanceId), parsed.payload);
        }
      }
    }
    for (const [key, payload] of Object.entries(optimisticPluginInteractions)) {
      if (!map.has(key)) map.set(key, payload);
    }
    return map;
  }, [timeline, optimisticPluginInteractions, outputPluginRegistry]);
  const rowKeys = useMemo(() => optimisticRowKeys(optimisticMessages), [optimisticMessages]);
  let latestUserIndex = -1;
  for (let index = timeline.length - 1; index >= 0; index--) if (timeline[index].type === 'text' && timeline[index].data.role === 'user') { latestUserIndex = index; break; }
  // 页面挂载时刻：时间戳早于它的行是「打开页面之前就存在的历史」，刷新时不重播。
  // 为什么不按「第几批 payload」判断：刷新后的 SSE 补发也会把旧内容带回来，按批次判会把
  // 已经显示过的整段当成新内容重播一遍——那正是「每次刷新都重新跑一遍」的来源。
  const mountedAt = useRef(new Date().toISOString()).current;
  const hiddenQueueOrigins = useMemo(() => {
    const set = new Set<string>(BASE_HIDDEN_QUEUE_ORIGINS);
    for (const plugin of outputPluginRegistry.list()) {
      if (plugin.interactionOrigin) set.add(plugin.interactionOrigin);
    }
    return set;
  }, [outputPluginRegistry]);
  const queuedTasks = useMemo(() => waitingQueuedTasks(tasks.data, sessionBusy, optimisticMessages, hiddenQueueOrigins), [tasks.data, sessionBusy, optimisticMessages, hiddenQueueOrigins]);
  const hasOngoingActivity = timelineSections.some(section => isTurnOngoing(section, sessionBusy));
  const showFirstOutputPlaceholder = awaitsFirstOutput(timeline[latestUserIndex], tasks.data, sessionBusy, hasOngoingActivity);
  const timelineScroll = useTimelineAutoScroll(session.id, timeline, sessionBusy);
  // 只对「回到底部」按钮的显隐做 120ms 去抖：滞回阈值已经消除边界翻转，
  // 这里再兜一层，避免快速抖动/极窄视口下按钮闪一下又消失。跟随逻辑本身不去抖。
  const showScrollToBottom = useDebounce(!timelineScroll.isFollowing, { wait: 120 });

  // 对话流内搜索（Cmd/Ctrl+F 或顶栏/菜单按钮唤起）：按会话隔离，切会话自动重置。
  const paneRootRef = useRef<HTMLDivElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const debouncedSearchQuery = useDebounce(searchQuery, { wait: 80 });
  const [searchIndex, setSearchIndex] = useState(0);
  const searchPaneKey = `${pane}:${session.id}`;
  const effectiveSearchQuery = searchOpen ? normalizeSearchQuery(debouncedSearchQuery) : '';
  const searchMatches = useMemo(
    () => (effectiveSearchQuery ? searchTimeline({ turns: timelineTurns, rowKeys, systemPrompt: session.systemPrompt, query: effectiveSearchQuery, outputPluginRegistry }) : []),
    [effectiveSearchQuery, timelineTurns, rowKeys, session.systemPrompt, outputPluginRegistry]
  );
  const clampedSearchIndex = searchMatches.length ? Math.min(searchIndex, searchMatches.length - 1) : -1;
  const activeSearchMatch = clampedSearchIndex >= 0 ? searchMatches[clampedSearchIndex] : undefined;

  const openTimelineSearch = useCallback(() => {
    setSearchOpen(true);
    requestAnimationFrame(() => {
      const input = searchInputRef.current;
      if (!input) return;
      input.focus();
      input.select();
    });
  }, []);

  const closeTimelineSearch = useCallback(() => {
    setSearchOpen(false);
    setSearchQuery('');
    setSearchIndex(0);
    clearTimelineSearchHighlights(searchPaneKey);
  }, [searchPaneKey]);

  const goToNextMatch = useCallback(() => {
    setSearchIndex(current => stepSearchIndex(current, searchMatches.length, 1));
  }, [searchMatches.length]);

  const goToPrevMatch = useCallback(() => {
    setSearchIndex(current => stepSearchIndex(current, searchMatches.length, -1));
  }, [searchMatches.length]);

  useEffect(() => {
    setSearchOpen(false);
    setSearchQuery('');
    setSearchIndex(0);
    clearTimelineSearchHighlights(searchPaneKey);
    return () => clearTimelineSearchHighlights(searchPaneKey);
  }, [session.id, searchPaneKey]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
      if (event.isComposing || event.keyCode === 229) return;
      if (!isTimelineFindShortcut(event)) return;
      const target = event.target instanceof Node ? event.target : document.activeElement;
      const paneRoot = paneRootRef.current;
      const targetInsidePane = Boolean(paneRoot && target && paneRoot.contains(target));
      const targetEl = target instanceof Element ? target : target?.parentElement;
      const targetInsideSecondaryPane = Boolean(targetEl?.closest('[data-session-pane="secondary"]'));
      const canHandle = shouldHandleTimelineFindShortcut({
        hasActiveDialog: getActiveAppDialog() !== null,
        hasAriaModal: Boolean(document.querySelector('[aria-modal="true"]')),
        pane,
        targetInsidePane,
        targetInsideSecondaryPane
      });
      if (!canHandle) return;
      event.preventDefault();
      openTimelineSearch();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [pane, openTimelineSearch]);

  useEffect(() => {
    if (!searchOpen || !effectiveSearchQuery) {
      clearTimelineSearchHighlights(searchPaneKey);
      return;
    }
    const content = timelineScroll.contentRef.current;
    const container = timelineScroll.containerRef.current;
    if (!content || !container) return;

    const escapeAttr = (value: string) =>
      typeof CSS !== 'undefined' && typeof CSS.escape === 'function'
        ? CSS.escape(value)
        : value.replace(/["\\]/g, '\\$&');

    const syncHighlightAndScroll = (shouldScroll: boolean) => {
      const allRanges = findTextRangesInElement(content, effectiveSearchQuery);
      let activeRange: Range | null = null;
      let fallbackTarget: Element | null = null;

      if (activeSearchMatch) {
        const itemEl = content.querySelector(`[data-search-item-key="${escapeAttr(activeSearchMatch.itemKey)}"]`);
        const stepEl = activeSearchMatch.stepId && itemEl
          ? itemEl.querySelector(`[data-search-step-id="${escapeAttr(activeSearchMatch.stepId)}"]`)
          : null;
        const scopeEl = stepEl ?? itemEl;
        fallbackTarget = scopeEl;
        if (scopeEl) {
          const scopeRanges = findTextRangesInElement(scopeEl, effectiveSearchQuery);
          if (scopeRanges.length) {
            const targetRange = scopeRanges[Math.min(activeSearchMatch.occurrenceIndex, scopeRanges.length - 1)]!;
            activeRange = allRanges.find(range =>
              range.startContainer === targetRange.startContainer
              && range.startOffset === targetRange.startOffset
              && range.endContainer === targetRange.endContainer
              && range.endOffset === targetRange.endOffset
            ) ?? targetRange;
          }
        }
      }

      applyTimelineSearchHighlights(searchPaneKey, allRanges, activeRange);
      if (shouldScroll && activeSearchMatch) {
        timelineScroll.pauseFollowing();
        const scrollTarget = activeRange ?? fallbackTarget;
        if (scrollTarget) scrollMatchIntoView(container, scrollTarget);
      }
    };

    const frame = requestAnimationFrame(() => syncHighlightAndScroll(true));
    // 折叠的过程块 / System Prompt 自动展开有 200ms 过渡，展开后再补一次高亮与居中定位。
    const needsExpandFollowup = activeSearchMatch?.sectionKind === 'activity' || activeSearchMatch?.sectionKind === 'system-prompt';
    const timer = needsExpandFollowup ? window.setTimeout(() => syncHighlightAndScroll(true), 230) : undefined;
    return () => {
      cancelAnimationFrame(frame);
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [searchOpen, effectiveSearchQuery, activeSearchMatch, timelineTurns, searchPaneKey, timelineScroll]);

  // in-flight 单飞：网络卡住时 send.isPending 会一直是 true，光靠它挡不住同一帧里的
  // 两次触发（Enter + 点击）；重复请求最终由服务端的 clientMessageId 兜底。
  const sendInFlight = useRef(false);
  const send = useMutation({
    mutationFn: ({ message, mode, clientMessageId }: { message: string; mode: SendMode; placement: OptimisticMessage['placement']; draft: string; references: ComposerReference[]; quote?: string; optimisticId: string; clientMessageId: string }) => api.send(session.id, message, mode, undefined, clientMessageId),
    onMutate: variables => {
      setActionError(undefined);
      setOptimisticMessages(current => [...current, { id: variables.optimisticId, prompt: variables.message, createdAt: new Date().toISOString(), placement: variables.placement, ...(variables.mode === 'interrupt' ? { interrupting: true } : {}) }]);
      setPrompt('');
      setComposerReferences([]);
      setQuotedText(undefined);
      setSendMode('queue');
    },
    onSuccess: (result, variables) => {
      const liveDraft = readLiveDraft();
      const keptNewDraft = Boolean(liveDraft.trim()) && liveDraft !== variables.draft;
      // 无论有没有新内容，都先让发送前的防抖写入失效；否则卸载/切会话的 flush
      // 会把刚发出去的内容写回草稿。新内容再同步落盘一次，不依赖 400ms 防抖。
      draftWriter.cancel();
      if (keptNewDraft) {
        saveSessionDraft(getBrowserDraftStorage(), session.id, liveDraft);
        setPrompt(current => current === liveDraft ? current : liveDraft);
      } else {
        clearSessionDraft(getBrowserDraftStorage(), session.id);
      }
      const existing = qc.getQueryData<Task[]>(['tasks', session.id])?.find(task => task.id === result.task.id);
      const task = existing ? mergeTaskSnapshots([existing], [result.task])[0]! : result.task;
      qc.setQueryData<Task[]>(['tasks', session.id], current => upsertTask(current, task));
      // 提交时以为会马上执行，服务端却说前面还有任务（别处的消息、定时任务抢先一步）：改进面板。
      // 留在时间线里的话，前面那一轮的输出会全挂到这条气泡下面。
      const queuedAhead = (result.task as Task & { queuedAhead?: number }).queuedAhead ?? 0;
      const waits = variables.mode === 'queue' && task.status === 'queued' && queuedAhead > 0;
      setOptimisticMessages(current => {
        const bound = bindOptimisticTask(current, task, variables.optimisticId);
        return waits ? bound.map(item => item.id === variables.optimisticId ? { ...item, placement: 'queue' } : item) : bound;
      });
    },
    onError: (error, variables) => {
      setOptimisticMessages(current => current.filter(item => item.id !== variables.optimisticId));
      const liveDraft = readLiveDraft();
      const keptNewDraft = Boolean(liveDraft.trim()) && liveDraft !== variables.draft;
      if (keptNewDraft) {
        // 等待期间用户已经打了新内容：保留它，不要把失败的那条盖回输入框。
        setPrompt(liveDraft);
      } else {
        setPrompt(variables.draft);
        setComposerReferences(current => current.length ? current : variables.references);
        setQuotedText(current => current ?? variables.quote);
        setSendMode(variables.mode);
      }
      setActionError(error.message);
    },
    onSettled: () => { sendInFlight.current = false; }
  });
  // 乐观清屏写入的是空串，但请求还没成功，不能据此删掉已落盘的草稿；
  // 成功/失败后 isPending 变化会再触发一次，成功清空、失败把草稿写回去。
  const draftWriter = useSessionDraftWriter(session.id, prompt, { skipEmptyValue: send.isPending, enabled: !session.archivedAt });
  const cancelQueued = useMutation({
    mutationFn: (taskId: string) => api.cancelQueued(session.id, taskId),
    onSuccess: result => {
      qc.setQueryData<Task[]>(['tasks', session.id], current => upsertTask(current, result));
      setOptimisticMessages(current => bindOptimisticTask(current, result));
    },
    onError: error => setActionError(error.message)
  });
  const steerQueued = useMutation({
    mutationFn: (taskId: string) => api.steerQueued(session.id, taskId),
    onMutate: taskId => {
      setActionError(undefined);
      setHeldSteeringTaskId(taskId);
    },
    onSuccess: () => {
      setActionError(undefined);
      void qc.invalidateQueries({ queryKey: ['tasks', session.id] });
      void qc.invalidateQueries({ queryKey: ['sessions'] });
    },
    onError: error => {
      setHeldSteeringTaskId(undefined);
      setActionError(error.message);
    },
    onSettled: () => { steerInFlight.current = false; }
  });
  const activeSteeringTaskId = resolveActiveSteeringTaskId(steerQueued.isPending ? steerQueued.variables : undefined, heldSteeringTaskId, queuedTasks);
  useEffect(() => {
    if (!heldSteeringTaskId || steerQueued.isPending) return;
    if (!queuedTasks.some(task => task.id === heldSteeringTaskId)) {
      setHeldSteeringTaskId(undefined);
      return;
    }
    const timer = window.setTimeout(() => setHeldSteeringTaskId(undefined), 4_000);
    return () => window.clearTimeout(timer);
  }, [heldSteeringTaskId, queuedTasks, steerQueued.isPending]);
  const handleSteerQueued = (taskId: string) => {
    if (steerInFlight.current || steerQueued.isPending || activeSteeringTaskId) return;
    steerInFlight.current = true;
    timelineScroll.scrollToBottom();
    steerQueued.mutate(taskId);
  };
  const editQueued = useMutation({
    mutationFn: (taskId: string) => api.cancelQueued(session.id, taskId),
    onSuccess: result => {
      setActionError(undefined);
      qc.setQueryData<Task[]>(['tasks', session.id], current => upsertTask(current, result));
      setOptimisticMessages(current => bindOptimisticTask(current, result));
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
  // 旧版本允许直接归档主会话；恢复入口必须能从主会话面板直接点到，不能只留在归档列表里。
  const restoreMain = useMutation({
    mutationFn: () => api.assistantRestoreMain(session.id),
    onSuccess: result => {
      setActionError(undefined);
      qc.setQueryData<Session[]>(['sessions'], current => current?.map(item => item.id === result.session.id ? result.session : item));
      void qc.invalidateQueries({ queryKey: ['assistant-state'] });
      void qc.invalidateQueries({ queryKey: ['assistant-lifecycle'] });
    },
    onError: error => setActionError(error.message)
  });
  const refreshModels = useMutation({ mutationFn: ({ agentId, currentModel }: { agentId: string; currentModel?: string }) => loadAgentModels(agentId, currentModel, true, session.sshHost), onSuccess: (result, variables) => { setActionError(undefined); qc.setQueryData(agentModelsQueryKey(variables.agentId, variables.currentModel, session.sshHost), result); }, onError: error => setActionError(error.message) });

  useEffect(() => {
    // 切换会话时重置本会话的切换态与计时器。
    modelSwitchLaneRef.current.reset();
    reasoningSwitchLaneRef.current.reset();
    pluginSwitchVersionRef.current += 1;
    pluginSwitchInFlightRef.current = false;
    setPendingModel(undefined);
    setPendingReasoningEffort(undefined);
    setModelJustSwitched(false);
    setReasoningJustSwitched(false);
    setSwitchingPluginId(undefined);
    setPluginsJustSwitched(false);
    window.clearTimeout(modelSavedTimerRef.current);
    window.clearTimeout(reasoningSavedTimerRef.current);
    window.clearTimeout(pluginSavedTimerRef.current);
  }, [session.id]);

  useEffect(() => () => {
    modelSwitchLaneRef.current.reset();
    reasoningSwitchLaneRef.current.reset();
    pluginSwitchVersionRef.current += 1;
    pluginSwitchInFlightRef.current = false;
    window.clearTimeout(modelSavedTimerRef.current);
    window.clearTimeout(reasoningSavedTimerRef.current);
    window.clearTimeout(pluginSavedTimerRef.current);
  }, []);

  const handleModelChange = useCallback((nextModel: string) => {
    void modelSwitchLaneRef.current.submit(nextModel, {
      currentValue: session.model,
      request: target => api.setSessionModel(session.id, target),
      onOptimistic: target => {
        setActionError(undefined);
        setModelJustSwitched(false);
        window.clearTimeout(modelSavedTimerRef.current);
        setPendingModel(target);
        qc.setQueryData<Session[]>(['sessions'], current => current?.map(item => item.id === session.id ? { ...item, model: target } : item));
      },
      onSuccess: result => {
        const { discoveredModels, ...updatedSession } = result;
        if (discoveredModels) {
          qc.setQueryData(agentModelsQueryKey(session.agentId, updatedSession.model, session.sshHost), discoveredModels);
          if (!session.sshHost && !discoveredModels.warning) {
            writeCachedAgentModels(session.agentId, updatedSession.model, discoveredModels);
          }
        }
        setPendingModel(undefined);
        const activeReasoning = reasoningSwitchLaneRef.current.pending;
        qc.setQueryData<Session[]>(['sessions'], current => current?.map(item => item.id === updatedSession.id ? {
          ...updatedSession,
          ...(activeReasoning !== undefined ? { reasoningEffort: activeReasoning } : {})
        } : item));
        setModelJustSwitched(true);
        modelSavedTimerRef.current = window.setTimeout(() => setModelJustSwitched(false), 1200);
      },
      onRollback: (previousValue, message) => {
        setPendingModel(undefined);
        qc.setQueryData<Session[]>(['sessions'], current => current?.map(item => item.id === session.id ? { ...item, model: previousValue } : item));
        setActionError(message);
        syncToastRef.current.show(L(`切换模型失败：${message}`, `Failed to switch model: ${message}`), 'error');
      }
    });
  }, [qc, session.agentId, session.id, session.model, session.sshHost]);

  const handleReasoningEffortChange = useCallback((nextReasoningEffort: string) => {
    void reasoningSwitchLaneRef.current.submit(nextReasoningEffort, {
      currentValue: session.reasoningEffort,
      request: target => api.setSessionReasoningEffort(session.id, target),
      onOptimistic: target => {
        setActionError(undefined);
        setReasoningJustSwitched(false);
        window.clearTimeout(reasoningSavedTimerRef.current);
        setPendingReasoningEffort(target);
        qc.setQueryData<Session[]>(['sessions'], current => current?.map(item => item.id === session.id ? { ...item, reasoningEffort: target } : item));
      },
      onSuccess: result => {
        const { discoveredModels, ...updatedSession } = result;
        if (discoveredModels) {
          qc.setQueryData(agentModelsQueryKey(session.agentId, updatedSession.model, session.sshHost), discoveredModels);
          if (!session.sshHost && !discoveredModels.warning) {
            writeCachedAgentModels(session.agentId, updatedSession.model, discoveredModels);
          }
        }
        setPendingReasoningEffort(undefined);
        const activeModel = modelSwitchLaneRef.current.pending;
        qc.setQueryData<Session[]>(['sessions'], current => current?.map(item => item.id === updatedSession.id ? {
          ...updatedSession,
          ...(activeModel !== undefined ? { model: activeModel } : {})
        } : item));
        setReasoningJustSwitched(true);
        reasoningSavedTimerRef.current = window.setTimeout(() => setReasoningJustSwitched(false), 1200);
      },
      onRollback: (previousValue, message) => {
        setPendingReasoningEffort(undefined);
        qc.setQueryData<Session[]>(['sessions'], current => current?.map(item => item.id === session.id ? { ...item, reasoningEffort: previousValue } : item));
        setActionError(message);
        syncToastRef.current.show(L(`切换思考深度失败：${message}`, `Failed to switch reasoning effort: ${message}`), 'error');
      }
    });
  }, [qc, session.agentId, session.id, session.reasoningEffort, session.sshHost]);

  const handlePatchOutputPlugins = useCallback((patch: Record<string, boolean | null>, activePluginId?: string) => {
    if (session.archivedAt) return;
    if (!Object.keys(patch).length) return;
    const latestSession = qc.getQueryData<Session[]>(['sessions'])?.find(item => item.id === session.id) ?? session;
    const previousPlugins = latestSession.outputPlugins;
    const previousAsk = typeof latestSession.askUserQuestionEnabled === 'boolean' ? latestSession.askUserQuestionEnabled : null;
    const merged = mergeSessionOutputPluginsPatch(previousPlugins, patch, previousAsk);
    const nextAsk = typeof merged[BUILTIN_ASK_USER_QUESTION_PLUGIN_ID] === 'boolean'
      ? merged[BUILTIN_ASK_USER_QUESTION_PLUGIN_ID]
      : null;

    const version = ++pluginSwitchVersionRef.current;
    pluginSwitchInFlightRef.current = true;
    setActionError(undefined);
    setSwitchingPluginId(activePluginId);
    setPluginsJustSwitched(true);
    window.clearTimeout(pluginSavedTimerRef.current);
    pluginSavedTimerRef.current = window.setTimeout(() => setPluginsJustSwitched(false), 900);
    qc.setQueryData<Session[]>(['sessions'], current => current?.map(item => (
      item.id === session.id
        ? { ...item, outputPlugins: Object.keys(merged).length ? merged : undefined, askUserQuestionEnabled: nextAsk }
        : item
    )));
    void api.setSessionOutputPlugins(session.id, patch).then(updatedSession => {
      if (pluginSwitchVersionRef.current !== version) return;
      pluginSwitchInFlightRef.current = false;
      setSwitchingPluginId(undefined);
      const activeModel = modelSwitchLaneRef.current.pending;
      const activeReasoning = reasoningSwitchLaneRef.current.pending;
      qc.setQueryData<Session[]>(['sessions'], current => current?.map(item => item.id === updatedSession.id ? {
        ...updatedSession,
        ...(activeModel !== undefined ? { model: activeModel } : {}),
        ...(activeReasoning !== undefined ? { reasoningEffort: activeReasoning } : {})
      } : item));
    }).catch(error => {
      if (pluginSwitchVersionRef.current !== version) return;
      pluginSwitchInFlightRef.current = false;
      setSwitchingPluginId(undefined);
      setPluginsJustSwitched(false);
      qc.setQueryData<Session[]>(['sessions'], current => current?.map(item => (
        item.id === session.id
          ? { ...item, outputPlugins: previousPlugins, askUserQuestionEnabled: previousAsk }
          : item
      )));
      const message = error instanceof Error ? error.message : String(error);
      setActionError(message);
      syncToastRef.current.show(L(`切换交互插件失败：${message}`, `Failed to toggle output plugin: ${message}`), 'error');
    });
  }, [qc, session.archivedAt, session.askUserQuestionEnabled, session.id, session.outputPlugins]);

  const handleSetOutputPlugin = useCallback((pluginId: string, next: boolean | null) => {
    handlePatchOutputPlugins({ [pluginId]: next }, pluginId);
  }, [handlePatchOutputPlugins]);

  const handleResetAllOutputPlugins = useCallback(() => {
    const patch: Record<string, null> = {};
    for (const item of composerOutputPlugins) {
      if (item.override !== null) patch[item.id] = null;
    }
    if (Object.keys(patch).length) handlePatchOutputPlugins(patch);
  }, [composerOutputPlugins, handlePatchOutputPlugins]);

  const switchingModel = pendingModel !== undefined;
  const switchingReasoningEffort = pendingReasoningEffort !== undefined;
  const modelReadiness = getModelReadiness({ loaded: models.data !== undefined, loading: models.data === undefined && (models.isPending || models.isFetching || refreshModels.isPending), switching: switchingModel, failed: models.data === undefined && models.isError });

  useBufferedEventStream({
    sessionId: session.id,
    enabled: events.isSuccess,
    runId: session.runId,
    queryClient: qc,
    onReconnect: () => {
      // 断线期间漏掉的 task/status 事件不会补发：重连后立刻重取任务、会话状态并自愈本轮事件。
      void tasks.refetch();
      void sessionRecoveries.refetch();
      void qc.invalidateQueries({ queryKey: ['sessions'] });
      healNextFetch.current = true;
      void events.refetch();
    },
    onRecoveryEvent: record => {
      qc.setQueryData<{ items: TaskRecoveryRecord[] }>(['session-recoveries', session.id], current => {
        const list = current?.items ?? [];
        const exists = list.some(item => item.id === record.id);
        return {
          items: exists
            ? list.map(item => (item.id === record.id ? record : item))
            : [...list, record]
        };
      });
      void qc.invalidateQueries({ queryKey: ['task-recovery-records'] });
    },
    onSidecarEvent: event => {
      // 改名（用户手改 / Agent 推来）也是走 status 事件的，和 model / reasoningEffort 同一个通道。
      // title 为 null 表示这一档没有名字（回落链的另一档接手），所以显式赋 null 而不是跳过。
      if (event.type === 'status' && 'title' in event.data) qc.setQueryData<Session[]>(['sessions'], current => current?.map(item => item.id === session.id ? { ...item, title: event.data.title ?? undefined, titleSource: event.data.titleSource ?? undefined } : item));
      if (event.type === 'status' && Object.hasOwn(stateLabels, event.data.state)) qc.setQueryData<Session[]>(['sessions'], current => current?.map(item => item.id === session.id ? {
        ...item,
        state: event.data.state,
        error: typeof event.data.error === 'string' ? event.data.error : undefined,
        ...(Object.hasOwn(event.data, 'interruptIntent')
          ? { interruptIntent: typeof event.data.interruptIntent === 'string' ? event.data.interruptIntent : undefined }
          : event.data.state !== 'interrupted' ? { interruptIntent: undefined } : {}),
        ...(typeof event.data.model === 'string' && !modelSwitchLaneRef.current.pending ? { model: event.data.model } : {}),
        ...(typeof event.data.reasoningEffort === 'string' && !reasoningSwitchLaneRef.current.pending ? { reasoningEffort: event.data.reasoningEffort } : {}),
        ...(Object.hasOwn(event.data, 'askUserQuestionEnabled') && !pluginSwitchInFlightRef.current
          ? { askUserQuestionEnabled: typeof event.data.askUserQuestionEnabled === 'boolean' ? event.data.askUserQuestionEnabled : null }
          : {}),
        ...(Object.hasOwn(event.data, 'outputPlugins') && !pluginSwitchInFlightRef.current
          ? {
              outputPlugins: event.data.outputPlugins && typeof event.data.outputPlugins === 'object' && Object.keys(event.data.outputPlugins).length > 0
                ? event.data.outputPlugins
                : undefined
            }
          : {})
      } : item));
      if (event.type === 'task' && event.data.task) {
        const task = event.data.task as Task;
        qc.setQueryData<Task[]>(['tasks', session.id], current => upsertTask(current, task));
        // SSE 可能比 send 响应先到：这里同样认领、并在任务开始后把乐观消息标成 settled。
        setOptimisticMessages(current => bindOptimisticTask(current, task));
      }
    }
  });

  const handleQuoteReply = (text: string) => {
    const normalized = normalizeQuotedText(text);
    if (!normalized) return;
    setQuotedText(normalized);
    requestAnimationFrame(() => composerTextarea.current?.focus());
  };

  const handleInteractOutputPlugin = useCallback(async (
    plugin: OutputPluginMetadata,
    spec: unknown,
    input: unknown
  ) => {
    if (session.archivedAt) return;
    const def = outputPluginRegistry.get(plugin.id);
    const instanceId = def ? def.getInstanceId(spec) : String((spec as { id?: string })?.id ?? '');
    if (!instanceId) return;
    const title = def?.getTitle?.(spec);
    const key = outputPluginInstanceKey(plugin.id, instanceId);

    setSubmittingPluginKey(current => (current ? current : key));
    setPluginSubmitErrors(current => {
      if (!(key in current)) return current;
      const next = { ...current };
      delete next[key];
      return next;
    });
    try {
      const payloadInput = (input ?? {}) as {
        answers?: AskUserQuestionAnswerItem[];
        decision?: 'confirm' | 'cancel';
        decisionLabel?: string;
        risk?: 'low' | 'medium' | 'high';
        comment?: string;
        actionValue?: string;
        actionLabel?: string;
        fields?: DeclarativeInteractionField[];
        note?: string;
      };
      const result = await api.interactOutputPlugin(session.id, plugin.id, {
        instanceId,
        ...(title ? { title } : {}),
        ...(payloadInput.answers ? { answers: payloadInput.answers } : {}),
        ...(payloadInput.decision ? { decision: payloadInput.decision } : {}),
        ...(payloadInput.decisionLabel ? { decisionLabel: payloadInput.decisionLabel } : {}),
        ...(payloadInput.risk ? { risk: payloadInput.risk } : {}),
        ...(payloadInput.comment ? { comment: payloadInput.comment } : {}),
        ...(payloadInput.actionValue ? { actionValue: payloadInput.actionValue } : {}),
        ...(payloadInput.actionLabel ? { actionLabel: payloadInput.actionLabel } : {}),
        ...(payloadInput.fields ? { fields: payloadInput.fields } : {}),
        ...(payloadInput.note ? { note: payloadInput.note } : {}),
        clientMessageId: createClientMessageId()
      });
      if ('alreadySubmitted' in result) {
        setOptimisticPluginInteractions(current => ({ ...current, [key]: result.existing }));
        syncToastRef.current.show(L("该交互卡片已在其他端完成响应，已同步最新结果", "Already responded from another client; synced latest result"), 'info');
        void events.refetch();
        void tasks.refetch();
        return;
      }
      setOptimisticPluginInteractions(current => ({ ...current, [key]: result.payload }));
      qc.setQueryData<Task[]>(['tasks', session.id], current => upsertTask(current, result.task));
      timelineScroll.scrollToBottom();
      void events.refetch();
      void tasks.refetch();
    } catch (error) {
      const message = error instanceof Error ? error.message : L("提交操作失败，请重试", "Failed to submit action. Please retry.");
      setPluginSubmitErrors(current => ({ ...current, [key]: message }));
    } finally {
      setSubmittingPluginKey(current => (current === key ? undefined : current));
    }
  }, [events, outputPluginRegistry, qc, session.archivedAt, session.id, tasks, timelineScroll]);

  const submit = (submittedValue: string) => {
    if (modelReadiness.kind === 'blocked' || send.isPending || sendInFlight.current) return;
    if (btwEnabled && onSideChat) {
      const btw = matchSideChatTrigger(submittedValue, btwTriggerPrefix);
      if (btw.matched) {
        const references = composerReferences;
        const quote = quotedText;
        const initialPrompt = buildPrompt(btw.prompt, references, [], quote) || undefined;
        composerTextarea.current?.setValue('');
        setPrompt('');
        setComposerReferences([]);
        setQuotedText(undefined);
        setActionError(undefined);
        draftWriter.cancel();
        clearSessionDraft(getBrowserDraftStorage(), session.id);
        void Promise.resolve(onSideChat(session, { ...(initialPrompt ? { initialPrompt } : {}), fromBtw: true })).catch(error => {
          const liveDraft = readLiveDraft();
          if (!liveDraft.trim()) {
            setPrompt(submittedValue);
            setComposerReferences(current => current.length ? current : references);
            setQuotedText(current => current ?? quote);
          }
          setActionError(error instanceof Error ? error.message : String(error));
        });
        return;
      }
    }
    // 唯一来源是点击/回车那一刻编辑器的文档快照，而不是可能还停在上一拍的 prompt。
    const quote = quotedText;
    const message = buildPrompt(submittedValue, composerReferences, advertisedCommands.map(command => command.name), quote);
    if (!message) return;
    const mode = busyStates.has(session.state) ? sendMode : 'queue';
    // 落点在提交时就定：马上执行的进时间线并回到底部；要排队的只进「等待发送」面板，时间线不动。
    const placement = startsImmediately(session.state, mode, tasks.data) ? 'timeline' : 'queue';
    if (placement === 'timeline') timelineScroll.scrollToBottom();
    // 直接清编辑器，不能只等 setPrompt('')：如果 200ms 防抖还没把刚输入的文本同步到
    // state，prompt 本来就是空串，setPrompt('') 不产生新值，编辑器永远不会被清空；
    // 随后迟到的 onChange 还会把已发送文本写回输入框和草稿。
    composerTextarea.current?.setValue('');
    setPrompt('');
    sendInFlight.current = true;
    // 每次提交一个 id；同一次提交被浏览器重放时请求体不变，服务端据此去重。
    send.mutate({ message, mode, placement, draft: submittedValue, references: composerReferences, quote, optimisticId: createOptimisticMessageId(), clientMessageId: createClientMessageId() });
  };
  // 飞书来源会话：sourceId 里带 chatId，可以生成 applink 直接跳回该群/私聊。
  // 话题会话没有官方 thread 级直达链接，退化为「进群」，用 exact 标记给个提示。
  const larkLink = session.source === 'lark' ? larkSessionAppLink(session.sourceId) : undefined;
  // 已经托管给机器人后，托管群就是唯一的飞书入口：隐藏原来的飞书来源链接，避免看起来有两个通道。
  const handover = useQuery({ queryKey: ['session-handover', session.id], queryFn: () => api.sessionHandover(session.id), staleTime: 30_000 });
  const handoverInfo = handover.data?.handover ?? undefined;
  const larkBinding = handover.data?.larkBinding ?? undefined;
  const larkTurnSyncEnabled = larkBinding?.effectiveTurnSync?.enabled ?? handoverInfo?.effectiveTurnSync?.enabled;

  // 导入会话从外部 Agent 同步新轮次：用户在 Codex 等原客户端里续聊后，一键把 AgentDock 还没有的轮次补进来。
  // 其他会话的本地同步由 SSE + 聚焦自愈重拉兼顾，不再放按钮。
  const externalName = agent?.name ?? session.agentId;
  const syncExternal = useMutation({
    mutationFn: () => api.syncExternal(session.id),
    onSuccess: async result => {
      const summary = result.added ? L(`已从 ${externalName} 同步 ${result.added} 轮新消息`, `Synced ${result.added} new turn(s) from ${externalName}`) : L(`${externalName} 里没有新消息`, `No new messages in ${externalName}`);
      // 两边交替聊时夹在中间的外部轮次放不进时间线中间，只提示数量。
      syncToast.show(result.skipped ? L(`${summary}；另有 ${result.skipped} 轮是在本会话消息之间发的，无法插入时间线，需要完整历史请重新导入`, `${summary}; ${result.skipped} interleaved turn(s) could not be inserted — re-import for full history`) : summary, 'info');
      // 新轮次已经经 SSE 推过来；再自愈重拉一次兜底（新轮次都在末尾，从最后一轮重拉即可覆盖），避免流断过时漏条。
      healNextFetch.current = true;
      await Promise.all([events.refetch(), tasks.refetch(), qc.invalidateQueries({ queryKey: ['sessions'] })]);
    },
    onError: error => syncToast.show(error.message)
  });

  const act = async (action: string) => { try { setActionError(undefined); await api.action(session.id, action); } catch (error) { setActionError(error instanceof Error ? error.message : String(error)); } };

  const titleFlash = useAiFlash();
  const [editingHeaderTitle, setEditingHeaderTitle] = useState(false);
  const [headerTitleDraft, setHeaderTitleDraft] = useState('');
  useEffect(() => {
    setEditingHeaderTitle(false);
    setHeaderTitleDraft('');
  }, [session.id]);

  const saveHeaderTitle = useMutation({
    mutationFn: (title: string | null) => api.setSessionTitle(session.id, title),
    onSuccess: updated => {
      qc.setQueryData<Session[]>(['sessions'], current => current?.map(item => item.id === updated.id ? updated : item));
      setEditingHeaderTitle(false);
    },
    onError: error => setActionError(error instanceof Error ? error.message : String(error))
  });

  const commitHeaderTitle = () => {
    if (saveHeaderTitle.isPending) return;
    const next = headerTitleDraft.replace(/\s+/g, ' ').trim();
    if (next === (session.customTitle ?? '')) {
      setEditingHeaderTitle(false);
      return;
    }
    saveHeaderTitle.mutate(next || null);
  };

  const buildSessionAiContext = useCallback((): LlmAssistContext => {
    const textEntries = timeline
      .filter(item => item.type === 'text' && typeof item.data.text === 'string' && item.data.text.trim())
      .map(item => ({
        role: item.data.role === 'user' ? 'user' : 'assistant',
        text: String(item.data.text).replace(/\s+/g, ' ').trim().slice(0, 320)
      }));
    const recentMessages = textEntries.length <= 8
      ? textEntries
      : [...textEntries.slice(0, 2), ...textEntries.slice(-6)];
    return {
      sessionTitle: sessionLabel(session, agent?.name),
      agentName: agent?.name ?? session.agentId,
      cwd: session.cwd,
      ...(session.model ? { model: session.model } : {}),
      ...(recentMessages.length ? { recentMessages } : {}),
      ...(session.systemPrompt?.trim() ? { extra: L(`会话 System Prompt 摘要：${session.systemPrompt.trim().slice(0, 260)}`, `Session System Prompt: ${session.systemPrompt.trim().slice(0, 260)}`) } : {})
    };
  }, [timeline, session, agent?.name]);

  const buildTitleAiContext = useCallback((): LlmAssistContext => ({
    ...buildSessionAiContext(),
    field: L("会话标题", "Session Title"),
    purpose: L("根据会话消息与工作区提炼一个简短直观的中文会话标题", "Summarize a short, clear English session title from the conversation and workspace"),
    maxChars: 20
  }), [buildSessionAiContext]);

  // ⋯ 菜单：统一收纳当前会话级操作（交互插件、定时任务、系统提示词、飞书托管、同步、归档等），
  // 顶栏只保留搜索、副屏与「更多」，零重复、高呼吸感。
  const enabledPluginsCount = enabledOutputPluginIds.size;
  const totalPluginsCount = composerOutputPlugins.length;
  const hasPluginOverrides = composerOutputPlugins.some(item => item.override !== null);
  const larkSyncStatusBadge = typeof larkTurnSyncEnabled === 'boolean' ? (
    <span className={`shrink-0 rounded-full border px-1.5 py-0.5 text-[11px] font-medium ${
      larkTurnSyncEnabled
        ? 'border-emerald-200 bg-emerald-50 text-emerald-700'
        : 'border-zinc-200 bg-zinc-100 text-zinc-500'
    }`}>
      {larkTurnSyncEnabled ? L("已开启", "Enabled") : L("已关闭", "Disabled")}
    </span>
  ) : undefined;
  const regularMenuGroups: SessionMenuGroup[] = [
    { items: [
      ...(!session.archivedAt && totalPluginsCount > 0 ? [{
        id: 'session-output-plugins',
        label: L("交互插件", "Output Plugins"),
        icon: <Puzzle size={16} className={enabledPluginsCount > 0 ? 'text-sky-600 dark:text-sky-400' : undefined}/>,
        trailing: (
          <span
            data-testid="session-menu-output-plugins-badge"
            data-override={hasPluginOverrides ? 'true' : 'false'}
            className={`shrink-0 rounded-full border px-1.5 py-0.5 text-[11px] font-medium tabular-nums ${
              hasPluginOverrides
                ? 'border-amber-200 bg-amber-50 text-amber-700 dark:text-amber-300'
                : enabledPluginsCount > 0
                  ? 'border-sky-200 bg-sky-50 text-sky-700 dark:text-sky-300'
                  : 'border-zinc-200 bg-zinc-100 text-zinc-500'
            }`}
          >
            {L(`${enabledPluginsCount}/${totalPluginsCount} 启用`, `${enabledPluginsCount}/${totalPluginsCount} On`)}{hasPluginOverrides ? L(" · 覆写", " · Custom") : ''}
          </span>
        ),
        onSelect: () => openAppDialog('session-output-plugins', { sessionId: session.id })
      } satisfies SessionMenuItem] : []),
      ...(!session.archivedAt ? [{
        id: 'schedules', label: L("定时任务", "Schedules"), icon: <AlarmClock size={16}/>,
        ...(activeSchedules ? { trailing: <span className="shrink-0 rounded-full bg-zinc-100 px-1.5 py-0.5 text-[11px] font-medium tabular-nums text-zinc-500">{activeSchedules}</span> } : {}),
        onSelect: () => openAppDialog('schedule', { sessionId: session.id })
      } satisfies SessionMenuItem] : []),
      ...(session.systemPrompt ? [{ id: 'system-prompt', label: L("查看系统提示词", "View System Prompt"), icon: <BookOpen size={16}/>, onSelect: () => openAppDialog('system-prompt', { sessionId: session.id }) } satisfies SessionMenuItem] : []),
      ...(secondary && onOpenRawLog ? [{ id: 'raw-log', label: L("原始日志", "Raw Logs"), icon: <ScrollText size={16}/>, onSelect: () => onOpenRawLog(session.id) } satisfies SessionMenuItem] : [])
    ] },
    { items: [
      ...(handoverInfo ? [
        { id: 'handover-open', label: L(`已托管：${handoverInfo.name}`, `Hosted: ${handoverInfo.name}`), icon: <Bot size={16} className="text-emerald-600"/>, onSelect: () => window.open(handoverInfo.url, '_blank', 'noopener,noreferrer') } satisfies SessionMenuItem,
        { id: 'handover-settings', label: L("飞书同步设置", "Lark Sync Settings"), icon: <SlidersHorizontal size={16}/>, ...(larkSyncStatusBadge ? { trailing: larkSyncStatusBadge } : {}), onSelect: () => openAppDialog('handover', { sessionId: session.id }) } satisfies SessionMenuItem
      ] : []),
      ...(!session.archivedAt && !handoverInfo && session.source !== 'lark' ? [{ id: 'handover', label: L("托管到飞书机器人", "Host in Lark Bot"), icon: <Bot size={16}/>, onSelect: () => openAppDialog('handover', { sessionId: session.id }) } satisfies SessionMenuItem] : []),
      ...(!handoverInfo && larkLink ? [{ id: 'lark-open', label: larkLink.exact ? L("在飞书中打开", "Open in Lark") : L("在飞书中打开该话题", "Open Thread in Lark"), icon: <ExternalLink size={16}/>, onSelect: () => window.open(larkLink.url, '_blank', 'noopener,noreferrer') } satisfies SessionMenuItem] : []),
      ...(!handoverInfo && larkBinding ? [{ id: 'lark-sync-settings', label: L("飞书同步设置", "Lark Sync Settings"), icon: <SlidersHorizontal size={16}/>, ...(larkSyncStatusBadge ? { trailing: larkSyncStatusBadge } : {}), onSelect: () => openAppDialog('handover', { sessionId: session.id }) } satisfies SessionMenuItem] : []),
      ...(!session.archivedAt && session.source === 'import' ? [{ id: 'sync', label: syncExternal.isPending ? L(`正在从 ${externalName} 同步…`, `Syncing from ${externalName}…`) : L(`从 ${externalName} 同步新消息`, `Sync from ${externalName}`), icon: <RefreshCw size={16}/>, disabled: syncExternal.isPending || busyStates.has(session.state), onSelect: () => syncExternal.mutate() } satisfies SessionMenuItem] : [])
    ] }
  ];
  const dangerMenuGroups: SessionMenuGroup[] = !session.archivedAt ? [{ items: [{
    id: 'archive',
    // 主会话在岗时后端会硬拦；这里先把文案改掉，点开给解释和直达交接的入口。
    label: isMain ? L("归档会话（主会话需先交接）", "Archive Session (Hand over main first)") : L("归档会话", "Archive Session"),
    icon: <Archive size={16}/>, danger: !isMain, disabled: archive.isPending,
    onSelect: () => { archive.reset(); if (isMain) setMainArchiveBlocked(true); else setArchiveConfirm(true); }
  } satisfies SessionMenuItem] }] : [];
  const menuGroups: SessionMenuGroup[] = [...regularMenuGroups, ...dangerMenuGroups];
  const baseMenuIndicator: MenuIndicatorTone | undefined = handoverInfo
    ? 'active'
    : larkBinding && larkTurnSyncEnabled
      ? 'active'
      : activeSchedules > 0
        ? 'active'
        : undefined;
  const baseMenuTooltip = handoverInfo
    ? L(`更多操作（已托管：${handoverInfo.name}）`, `More Actions (Hosted: ${handoverInfo.name})`)
    : larkBinding
      ? L(`更多操作（已绑定${larkBinding.chatType === 'p2p' ? '飞书私聊' : '飞书群聊'}${larkTurnSyncEnabled ? ' · 同步已开启' : ''}）`, `More Actions (Bound to ${larkBinding.chatType === 'p2p' ? 'Lark DM' : 'Lark Group'}${larkTurnSyncEnabled ? ' · Sync On' : ''})`)
      : activeSchedules > 0
        ? L(`更多操作（${activeSchedules} 个定时任务启用中）`, `More Actions (${activeSchedules} active schedule(s))`)
        : L("更多操作", "More Actions");

  const agentUsageTrigger = (
    <SessionAgentUsagePopover
      sessionId={session.id}
      agentId={session.agentId}
      agentName={agent?.name}
      currentModel={session.model ?? models.data?.defaultModel}
      context={composerContext}
      sessionUsage={effectiveSessionUsage}
      liveTps={liveStreamTps}
    />
  );

  // h-full w-full：本组件既被当作并排的 flex 子项（主区），也被塞进 PaneHost 的
  // absolute inset-0 容器（右栏标签）。后者不是 flex 上下文，只写 flex-1 会撑不满，
  // 表现为右栏内容只占左上角一块。
  return <div ref={paneRootRef} data-session-pane={pane} className={`flex h-full min-w-0 w-full ${secondary ? 'border-l border-zinc-200' : ''}`}>
    <section className="flex min-w-0 flex-1 flex-col">
      <header className="ui-session-topbar flex shrink-0 items-center gap-1.5 border-b border-zinc-200 bg-canvas px-3 sm:px-4">
        <span className="mr-0.5 md:hidden"><IconButton label={L("打开会话列表", "Open Session List")} onClick={onOpenSidebar}><Menu size={16}/></IconButton></span>
        {isMain ? <CompanionHeader agentId={session.agentId} agentName={agent?.name} agentSlot={agentUsageTrigger}/> : <div className="min-w-0 flex-1 overflow-hidden">
          <div className="flex min-w-0 items-center gap-1.5">
            {editingHeaderTitle ? (
              <input
                autoFocus
                value={headerTitleDraft}
                maxLength={120}
                disabled={saveHeaderTitle.isPending}
                onChange={event => setHeaderTitleDraft(event.target.value)}
                onBlur={commitHeaderTitle}
                onKeyDown={event => {
                  if (event.key === 'Enter') { event.preventDefault(); commitHeaderTitle(); }
                  else if (event.key === 'Escape') { event.preventDefault(); setEditingHeaderTitle(false); }
                }}
                placeholder={sessionLabel(session, agent?.name)}
                aria-label={L("编辑会话标题", "Edit Session Title")}
                className={`ui-field h-6 min-w-0 flex-1 rounded-md border border-zinc-300 bg-white px-2 text-[13px] font-semibold text-zinc-900 ${titleFlash.flashClass}`}
              />
            ) : (
              <div
                onDoubleClick={() => {
                  setHeaderTitleDraft(session.customTitle ?? '');
                  setEditingHeaderTitle(true);
                }}
                className={`min-w-0 truncate rounded px-0.5 text-[14px] font-semibold leading-tight text-zinc-900 ${titleFlash.flashClass}`}
              >
                {sessionLabel(session, agent?.name)}
              </div>
            )}
            <AiTextAssistControl
              mode="title_generate"
              interaction="instant"
              variant="inline"
              size="xs"
              compactUndo
              value={editingHeaderTitle ? headerTitleDraft : (session.customTitle ?? '')}
              onChange={next => {
                if (editingHeaderTitle) setHeaderTitleDraft(next);
              }}
              manualApply={!editingHeaderTitle}
              onResult={async result => {
                const nextTitle = result.text.trim();
                if (!nextTitle) return;
                if (editingHeaderTitle) {
                  setHeaderTitleDraft(nextTitle);
                  return;
                }
                await saveHeaderTitle.mutateAsync(nextTitle);
              }}
              onUndo={async previous => {
                if (editingHeaderTitle) {
                  setHeaderTitleDraft(previous);
                  return;
                }
                await saveHeaderTitle.mutateAsync(previous.trim() || null);
              }}
              context={buildTitleAiContext}
              resetKey={session.id}
              onFlash={titleFlash.triggerFlash}
              disabled={saveHeaderTitle.isPending}
              ariaLabel={L("AI 生成会话标题", "Generate Title with AI")}
              tooltip={L("AI 根据会话内容生成标题（生成后可一键撤销）", "Generate a title from conversation context (one-click undo)")}
              testId="session-title-ai-assist"
            />
            {session.sshHost && <HoverTooltip content={L(`通过 SSH 在 ${session.sshHost} 上运行`, `Running over SSH on ${session.sshHost}`)}><span className="shrink-0 rounded border border-sky-200 bg-sky-50 px-1 py-px text-[11px] font-medium leading-4 text-sky-700 max-sm:hidden">SSH · {session.sshHost}</span></HoverTooltip>}
          </div>
          <div className="mt-0.5 flex min-w-0 items-center gap-1.5 text-[12px] leading-4 text-zinc-500">
            {agentUsageTrigger}
            <span className="shrink-0 text-zinc-300">·</span>
            <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${stateTone[session.state] ?? 'bg-zinc-400'} ${sessionBusy ? 'ui-live-ring' : ''}`}/>
            <span className="shrink-0">{sessionStateLabel(session.state, session.interruptIntent)}</span>
            {headerElapsed && <span className="hidden shrink-0 items-center gap-1.5 sm:inline-flex">
              <span className="text-zinc-300">·</span>
              <HoverTooltip content={L("本轮执行耗时；刷新或重连后按服务端时间重新计算", "Current turn duration; recalculated from server timestamps after refresh or reconnect")}><span className="tabular-nums">{headerElapsed}</span></HoverTooltip>
            </span>}
            <span className="hidden min-w-0 items-center gap-1.5 md:inline-flex">
              <span className="shrink-0 text-zinc-300">·</span>
              <HoverTooltipText content={session.cwd} className="min-w-0 truncate">{workspaceLabel(session.cwd)}</HoverTooltipText>
            </span>
          </div>
        </div>}
        <div className="ml-auto flex shrink-0 items-center gap-0.5">
          <IconButton label={L(`搜索对话内容（${shortcutLabel('f')}）`, `Search conversation (${shortcutLabel('f')})`)} active={searchOpen} onClick={() => { if (searchOpen) closeTimelineSearch(); else openTimelineSearch(); }}><Search size={15}/></IconButton>
          {!secondary && onTogglePane && <PaneToggleButton open={Boolean(paneOpen)} onToggle={onTogglePane}/>}
          {isMain
            ? <MainSessionMoreMenu regularGroups={regularMenuGroups} dangerGroups={dangerMenuGroups} baseIndicator={baseMenuIndicator} baseTooltip={baseMenuTooltip}/>
            : <SessionMenu groups={menuGroups.filter(group => group.items.length)} indicator={baseMenuIndicator} tooltip={baseMenuTooltip}/>}
        </div>
      </header>
      {actionError && <div className="flex items-center border-b border-red-200 bg-red-50 px-4 py-2 text-xs text-red-700"><span className="min-w-0 truncate">{actionError}</span><button className="ml-2 shrink-0" onClick={() => setActionError(undefined)} aria-label={L("关闭错误提示", "Dismiss error")}><X size={13}/></button></div>}
      <div className="flex min-h-0 flex-1">
        <div className="flex min-w-0 flex-1 flex-col">
      <div className="relative min-h-0 flex-1"><div ref={timelineScroll.containerRef} onScroll={timelineScroll.onScroll} onClickCapture={event => { if (event.target instanceof Element && event.target.closest('[data-timeline-disclosure]')) timelineScroll.pauseFollowing(); }} className="absolute inset-0 overscroll-contain overflow-y-auto [overflow-anchor:none]"><div ref={timelineScroll.contentRef} className={`ui-view-fade mx-auto w-full max-w-[760px] px-4 py-6 sm:px-6 sm:py-8 ${!events.isLoading && !timeline.length ? 'flex min-h-full flex-col justify-center' : ''}`}>
        {events.isLoading ? <div className="space-y-5"><div className="h-4 w-3/4 ui-skeleton rounded bg-zinc-200"/><div className="h-4 w-1/2 ui-skeleton rounded bg-zinc-200"/><div className="h-20 ui-skeleton rounded-xl bg-zinc-100"/></div> : (timeline.length || visibleRecoveryCards.length > 0) ? <>{session.systemPrompt?.trim() && <div data-search-item-key={SYSTEM_PROMPT_SEARCH_KEY} data-search-active={activeSearchMatch?.itemKey === SYSTEM_PROMPT_SEARCH_KEY ? 'true' : undefined} className={activeSearchMatch?.itemKey === SYSTEM_PROMPT_SEARCH_KEY ? 'ui-search-active-item' : undefined}><SystemPromptBubble prompt={session.systemPrompt.trim()} forceOpen={activeSearchMatch?.itemKey === SYSTEM_PROMPT_SEARCH_KEY}/></div>}{(() => {
          const matchedRecoveryIds = new Set<string>();
          const renderRecoveryCard = (rec: TaskRecoveryRecord) => (
            <TaskRecoveryConfirmCard
              key={rec.id}
              record={rec}
              disabled={Boolean(session.archivedAt) || mainNeedsRestart}
              disabledReason={session.archivedAt ? L("该会话已归档，无法操作", "This session is archived and read-only") : mainNeedsRestart ? L("请先恢复主会话后再操作", "Please restore the main session first") : undefined}
              submittingDecision={submittingRecovery?.id === rec.id ? submittingRecovery.decision : null}
              error={recoveryErrors[rec.id]}
              onDecide={handleDecideRecovery}
            />
          );
          return <>
            {timelineTurns.map(turn => {
              const time = turnTimeBadge(turn);
              const turnTaskIds = new Set<string>();
              for (const section of turn.sections) {
                if (section.kind === 'event' && typeof section.event.data?.taskId === 'string') {
                  turnTaskIds.add(section.event.data.taskId);
                }
              }
              const turnRecoveries = visibleRecoveryCards.filter(rec => turnTaskIds.has(rec.interruptedTaskId));
              for (const rec of turnRecoveries) matchedRecoveryIds.add(rec.id);
              return <div key={turn.turnId}>
                <TimelineTurn turnId={turn.turnId} time={time}>
                  {turn.sections.map(section => {
                    if (section.kind === 'event') {
                      const itemKey = timelineRowKey(section.event, rowKeys);
                      const isSearchActive = activeSearchMatch?.itemKey === itemKey;
                      const taskId = typeof section.event.data.taskId === 'string' ? section.event.data.taskId : undefined;
                      return <div key={itemKey} data-search-item-key={itemKey} data-search-active={isSearchActive ? 'true' : undefined} className={isSearchActive ? 'ui-search-active-item' : undefined}>
                        <TimelineItem
                          event={section.event}
                          sentPrompt={taskId ? sentPromptByTaskId.get(taskId) : undefined}
                          recoveryRecord={taskId ? recoveryByRecoveryTaskId.get(taskId) : undefined}
                          final={section.final}
                          streaming={isStreamingSection(section, sessionBusy, section === timelineSections.at(-1))}
                          replay={section.event.timestamp < mountedAt}
                          assistantLabel={outputLabel}
                          sessionId={session.id}
                          askUserQuestionXmlEnabled={effectiveAskUserQuestionEnabled}
                          outputPluginRegistry={outputPluginRegistry}
                          enabledOutputPluginIds={enabledOutputPluginIds}
                          pluginInteractionsByKey={pluginInteractionsByKey}
                          submittingPluginKey={submittingPluginKey}
                          pluginSubmitErrors={pluginSubmitErrors}
                          askDisabled={Boolean(session.archivedAt) || mainNeedsRestart}
                          askDisabledReason={session.archivedAt ? L("该会话已归档，无法提交操作", "This session is archived and cannot accept actions") : mainNeedsRestart ? L("请先恢复主会话后再操作", "Please restore the main session first") : undefined}
                          onInteractOutputPlugin={handleInteractOutputPlugin}
                        />
                      </div>;
                    }
                    const isSearchActive = activeSearchMatch?.itemKey === section.id;
                    return <div key={section.id} data-search-item-key={section.id} data-search-active={isSearchActive ? 'true' : undefined} className={isSearchActive ? 'ui-search-active-item' : undefined}>
                      <ActivityPanel groups={section.groups} replay={Boolean(section.startedAt && section.startedAt < mountedAt)} sessionId={session.id} hasAnswer={section.hasAnswer} taskStatus={section.taskStatus} ongoing={isTurnOngoing(section, sessionBusy)} modelLabel={outputLabel} startedAt={section.startedAt} completedAt={section.completedAt} forceOpen={isSearchActive} activeStepId={isSearchActive ? activeSearchMatch?.stepId : undefined} askUserQuestionXmlEnabled={effectiveAskUserQuestionEnabled} outputPluginRegistry={outputPluginRegistry} enabledOutputPluginIds={enabledOutputPluginIds}/>
                    </div>;
                  })}
                </TimelineTurn>
                {turnRecoveries.map(renderRecoveryCard)}
              </div>;
            })}
            {visibleRecoveryCards.filter(rec => !matchedRecoveryIds.has(rec.id)).map(renderRecoveryCard)}
          </>;
        })()}{showFirstOutputPlaceholder && <ActivityPanel groups={[]} sessionId={session.id} ongoing modelLabel={outputLabel} startedAt={timeline[latestUserIndex]?.timestamp}/>}</> : isMain ? <CompanionWelcome onPick={text => { setPrompt(text); requestAnimationFrame(() => composerTextarea.current?.focus()); }}/> : <div className="ui-empty-state flex flex-col items-center justify-center text-center"><div className="grid h-12 w-12 place-items-center rounded-2xl border border-zinc-200/80 bg-white/80 text-zinc-600 shadow-[0_3px_12px_rgba(24,24,27,.05)]"><MessageSquare size={19}/></div><p className="mt-5 text-[12px] font-medium tracking-[.08em] text-zinc-400">{L("工作区已就绪", "Workspace Ready")}</p><h2 className="mt-1.5 text-[18px] font-semibold tracking-tight text-zinc-800">{L("从一个问题开始", "Start with a question")}</h2><p className="mt-2 max-w-xs leading-5 text-xs text-zinc-500">{L("让 Agent 检查代码、实现改动或讲解当前项目。", "Ask the Agent to inspect code, implement changes, or explain this project.")}</p><div className="mt-6 flex max-w-sm flex-wrap justify-center gap-2">{getSessionStarterPrompts(locale).map(suggestion => <button key={suggestion.id} type="button" onClick={() => { if (composerTextarea.current) composerTextarea.current.setValue(suggestion.prompt); else setPrompt(suggestion.prompt); requestAnimationFrame(() => composerTextarea.current?.focus()); }} className="rounded-full border border-zinc-200/90 bg-white/75 px-3 py-1.5 text-[12px] text-zinc-600 transition-colors hover:border-zinc-300 hover:bg-white hover:text-zinc-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-zinc-400/50">{suggestion.label}</button>)}</div></div>}
        </div></div><ExitGate open={searchOpen} ms={150}><TimelineSearchBar inputRef={searchInputRef} query={searchQuery} hasQuery={Boolean(normalizeSearchQuery(searchQuery))} activeIndex={clampedSearchIndex} total={searchMatches.length} onQueryChange={next => { setSearchQuery(next); setSearchIndex(0); }} onNext={goToNextMatch} onPrev={goToPrevMatch} onClear={() => { setSearchQuery(''); setSearchIndex(0); }} onClose={closeTimelineSearch}/></ExitGate><ExitGate open={showScrollToBottom} ms={150}><div className="pointer-events-none absolute inset-x-0 bottom-3 z-10 flex justify-center"><button type="button" onClick={timelineScroll.scrollToBottom} className="ui-fab-in ui-press pointer-events-auto grid h-8 w-8 place-items-center rounded-full border border-zinc-200 bg-white text-zinc-600 shadow-[0_6px_18px_rgba(0,0,0,.13)] hover:-translate-y-0.5 hover:border-zinc-300 hover:text-zinc-900 active:scale-95" aria-label={L("回到最新消息", "Jump to latest")}><ArrowDown size={15}/></button></div></ExitGate><SelectionQuotePopover containerRef={timelineScroll.containerRef} enabled={!session.archivedAt && !mainNeedsRestart} onQuote={handleQuoteReply}/></div>
      {!session.archivedAt && prompt.length > MAX_DRAFT_CHARS && <div role="status" className="border-t border-amber-200 bg-amber-50 px-4 py-2 text-center text-[12px] text-amber-700">{L("草稿超过", "Draft exceeds ")} {MAX_DRAFT_CHARS.toLocaleString()}  {L("字符，超出部分不会保存，刷新后会丢失。", " chars; the excess will not be saved across refresh.")}</div>}
      {session.archivedAt || mainNeedsRestart
        ? mainNeedsRestart
          ? <div className="flex flex-wrap items-center justify-center gap-2 border-t border-amber-200 bg-amber-50/80 px-4 py-3 text-center text-xs text-amber-800">
            <span>{session.archivedAt ? L("当前主会话被归档了：现在既不能继续对话，也不能发起交接。", "The current main session is archived: you cannot continue chatting or initiate a handover.") : L("主会话已停止，输入框不可用；重新启动后可以继续对话。", "The main session is stopped. Restart it to continue chatting.")}</span>
            <button type="button" disabled={restoreMain.isPending} onClick={() => restoreMain.mutate()} className="inline-flex h-7 items-center gap-1 rounded-md border border-amber-300 bg-white px-2.5 text-[12px] font-medium text-amber-900 hover:bg-amber-100 disabled:opacity-50">
              <RotateCcw size={12} className={restoreMain.isPending ? 'animate-spin' : ''}/>{restoreMain.isPending ? L("正在恢复…", "Restoring…") : session.archivedAt ? L("恢复主会话", "Restore Main Session") : L("重新启动", "Restart")}
            </button>
          </div>
          : <div className="border-t border-zinc-200 bg-white/75 px-4 py-3 text-center text-xs text-zinc-500">{L("该会话已归档，仅支持查看。", "This session is archived and read-only.")}</div>
        : <Composer sessionId={session.id} state={session.state} {...(isMain ? { placeholder: <CompanionPlaceholder/> } : {})} homeDirectory={systemCapabilities.data?.homeDirectory} value={prompt} references={composerReferences} quotedText={quotedText} onClearQuote={() => setQuotedText(undefined)} sending={send.isPending} sendingMode={send.isPending ? send.variables?.mode : undefined} mode={sendMode} queuedTasks={queuedTasks} cancellingTaskId={cancelQueued.isPending ? cancelQueued.variables : undefined} steeringTaskId={activeSteeringTaskId} editingTaskId={editQueued.isPending ? editQueued.variables : undefined} skills={skills.data ?? []} models={models.data?.models ?? []} reasoningEfforts={models.data?.reasoningEfforts ?? []} currentModel={session.model ?? models.data?.defaultModel} currentReasoningEffort={session.reasoningEffort ?? models.data?.defaultReasoningEffort} advertisedCommands={advertisedCommands} builtinCommands={btwEnabled && onSideChat ? (sideChatBuiltinCommand(btwTriggerPrefix) ? [sideChatBuiltinCommand(btwTriggerPrefix)!] : []) : []} modelReadiness={modelReadiness} switchingModel={switchingModel} switchingReasoningEffort={switchingReasoningEffort} pendingModel={pendingModel} pendingReasoningEffort={pendingReasoningEffort} modelJustSwitched={modelJustSwitched} reasoningJustSwitched={reasoningJustSwitched} refreshingModels={models.isFetching || refreshModels.isPending} editorRef={composerTextarea} aiContext={buildSessionAiContext} outputPlugins={composerOutputPlugins} outputPluginsScope="session" switchingOutputPluginId={switchingPluginId} outputPluginsJustSwitched={pluginsJustSwitched} onSetOutputPlugin={handleSetOutputPlugin} onResetAllOutputPlugins={handleResetAllOutputPlugins} onOpenOutputPluginsCenter={() => openAppDialog('output-plugins')} onChange={setPrompt} onReferencesChange={setComposerReferences} onModeChange={setSendMode} onSubmit={submit} onInterrupt={() => void act('interrupt')} onCancelQueued={taskId => cancelQueued.mutate(taskId)} onSteerQueued={handleSteerQueued} onEditQueued={task => editQueued.mutate(task.id)} onModelChange={handleModelChange} onReasoningEffortChange={handleReasoningEffortChange} onRefreshModels={() => refreshModels.mutate({ agentId: session.agentId, currentModel: session.model })}/>}
        </div>
      </div>
    </section>

    {syncToast.toast}
    <ConfirmDialog open={archiveConfirm} tone="danger" title={L("归档此会话？", "Archive this session?")} description={L("归档后会话将变为只读且无法恢复。历史消息和执行记录会保留在归档列表中。", "Archived sessions become read-only and cannot be unarchived. History remains in the Archive list.")} confirmLabel={L("确认归档", "Archive")} busy={archive.isPending} error={archive.error?.message} onCancel={() => { if (!archive.isPending) setArchiveConfirm(false); }} onConfirm={() => archive.mutate()}/>
    <ConfirmDialog open={mainArchiveBlocked} tone="warning" title={L("主会话不能直接归档", "Main Session Cannot Be Archived Directly")} description={L("主会话还在岗，归档后会停掉对话，也不能再发起交接。请先「退休并交接」：交接完成后旧主会话会自动归档，新主会话会收到完整交接包。如果只是想暂时停下，可以在设置里「让它休息」。", "The main session is active. Please use \"Retire & Hand Over\" first so the previous main session archives automatically once the new one receives the full handover package. To pause temporarily, use \"Put to rest\" in Settings.")}
      confirmLabel={L("去交接 / 退休", "Retire / Hand Over")}
      onCancel={() => setMainArchiveBlocked(false)}
      onConfirm={() => { setMainArchiveBlocked(false); useCompanionStore.getState().openCeremony(); }}/>
  </div>;
  // 会话数据更新（流式消息、任务轮询）会带着新的 props 渲染本组件。不在这里兜住的话，
  // 长会话会把整条时间线上千个节点全部重新 diff 一遍。弹窗开关已移到 dialog-store，
  // 打开弹窗不再经过 App/SessionPane；这里只兜住父子数据更新。
}, (prev, next) => prev.session === next.session && prev.agent === next.agent && prev.pane === next.pane && prev.paneOpen === next.paneOpen && prev.btwEnabled === next.btwEnabled && prev.btwTriggerPrefix === next.btwTriggerPrefix && prev.askUserQuestionXmlEnabled === next.askUserQuestionXmlEnabled && prev.outputPluginItems === next.outputPluginItems && prev.outputPluginsGlobalConfig === next.outputPluginsGlobalConfig && prev.outputPluginRegistry === next.outputPluginRegistry);
