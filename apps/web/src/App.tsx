import { DialogHost } from './DialogHost';
import type { ComposerEditorHandle } from './ComposerEditor';
import { closeAppDialog, openAppDialog } from './dialog-store';
import { SettingsMenu } from './SettingsMenu';
import { LarkQuickTriggerButton } from './LarkIcon';
import { SettingsCenterDialog } from './settings/SettingsCenterDialog';
import { QuickThemeToggleButton } from './ThemeToggle';
import { SidebarPwaInstallButton } from './SidebarPwaInstallButton';
import { triggerPwaInstall, usePwaInstall } from './pwa-install';
import { memo, useEffect, useMemo, useRef, useState, type DragEvent, type HTMLAttributes } from 'react';
import { useMount, useEventListener, useUpdateEffect, useLocalStorageState, useMemoizedFn } from 'ahooks';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, Archive, BarChart3, ChevronRight, Columns3, Folder, FolderPlus, GripVertical, LoaderCircle, Menu, MonitorDown, PanelLeftOpen, Pin, Plus, RefreshCw, RotateCcw, Search, Settings, Smartphone, X } from 'lucide-react';
import { api, WebAccessDeniedError, type Agent, type AssistantTask, type Project, type Session } from './api';
import { useDockStore, type PaneTabKind } from './store';
import { PaneHost } from './PaneHost';
import { AgentIcon } from './AgentIcon';
import { PaneTypeMenu } from './PaneTypeMenu';
import { shortcutLabel, useShortcuts, type Shortcut } from './useShortcuts';
import { useOutputPluginsCatalog } from './output-plugins/useOutputPlugins';
import { SessionOutputPluginsDialog } from './output-plugins/SessionOutputPluginsDialog';
import { DEFAULT_SIDE_CHAT_CONFIG, findReusableSideChatSession, resolveSideChatStartOptions } from './side-chat-config';
import { createClientMessageId } from './client-message-id';
import { sideChatParentId } from './side-chat-link';
import { ScheduleDialog } from './ScheduleDialog';
import { SessionRowLeadingIcons, shouldShowSessionRowAgentIcon } from './sidebar-session-icon';
import { ArchivedSessionsDialog } from './ArchivedSessionsDialog';
import { boardUrl, parseBoardRoute, parseRightParam, sessionUrl } from './session-url';
import { useVisualViewportShell } from './useVisualViewportShell';
import { useDismissOnOutsidePointer } from './useDismissOnOutsidePointer';
import { SessionFilterSelect } from './SessionFilterSelect';
import { SessionTitleEditor } from './SessionTitleEditor';
import { resolveQuickCreateSessionOptions } from './last-used-prefs';
import { groupSessions, groupSessionsByTime, relativeTimeLabel, sameSessionTree, sessionActivityTime, sessionLabel } from './session-groups';
import { mergeProjectGroups } from './project-groups';
import { isProjectPinned, isSessionPinned, pinnedFirst, splitPinned } from './sidebar-pins';
import { sessionPaneTab } from './pane-tab';
import { useDocumentTitle } from './useDocumentTitle';
import { EMPTY_ITEM_ORDER, applyOrder, moveInList, normalizeItemOrder, type SidebarItemOrder } from './sidebar-order';
import { SessionSearchDialog } from './SessionSearchDialog';
import { WebAccessDeniedPanel, shouldCancelOnAccessDenied } from './WebAccessDeniedPanel';
import { UsageDashboardDialog } from './UsageDashboardDialog';
import { useNotificationCenter } from './useNotificationCenter';
import { useLocalNotificationPrefs, useUnreadNotificationsStore, type UnreadSessionNotification } from './notifications-local';
import { HandoverDialog } from './HandoverDialog';
import { ImportSessionDialog } from './ImportSessionDialog';
import { ImportProjectDialog } from './ImportProjectDialog';
import { SystemPromptDialog } from './SystemPromptDialog';
import { ShareAppDialog } from './ShareAppDialog';
import { useThemeSync } from './themes';
import { useBi, useLocale, useLocaleSync, useT } from './i18n';
import { SessionPane } from './SessionPane';
import { TerminalPanel } from './TerminalPanel';
import { FileExplorerPanel } from './FileExplorerPanel';
import { RawLogPanel } from './RawLogPanel';
import { busyStates, sessionStateLabel, stateTextTone, stateTone } from './session-states';
import { ConfirmDialog, IconButton, SlidingSegmented } from './ui-controls';
import { Disclosure } from './Disclosure';
import { ExitGate } from './ExitGate';
import { HoverTooltip, HoverTooltipText, TooltipProvider } from './HoverTooltip';
import { SessionHoverCard } from './SessionHoverCard';
import { SessionContextMenu } from './SessionContextMenu';
import { createQuickArchiveController, type QuickArchiveSnapshot } from './quick-archive';
import { isContextMenuKeyboardEvent, shouldOpenSessionFromClick } from './session-context-menu';
import { useToast } from './Toast';
import { CompanionLayer } from './companion/CompanionLayer';
import { CompanionCard, CompanionStripButton } from './companion/CompanionCard';
import { HomeStage } from './companion/HomeStage';
import { CompanionNavProvider, useAssistantState, type CompanionNav } from './companion/useCompanion';
import { useCompanionStore } from './companion/companion-store';
import { isLineageSource } from './companion/lifecycle-model';
import { withViewTransition } from './companion/effects';
import { BrandLogo } from './BrandLogo';
import { BoardWorkspace } from './board/BoardWorkspace';

/** 工作区行「+」弹出的 agent 快速选择菜单；fixed 定位避免被列表的 overflow 裁切。 */
function AgentPickerMenu({ cwd, top, left, agents, creatingPair, onSelect, onClose }: { cwd: string; top: number; left: number; agents: Agent[]; creatingPair?: { agentId: string; cwd: string }; onSelect(agentId: string): void; onClose(): void }) {
  const L = useBi();
  const root = useRef<HTMLDivElement>(null);
  useDismissOnOutsidePointer(root, true, onClose);
  return <div ref={root} className="ui-popover fixed z-50 max-h-64 w-52 overflow-y-auto rounded-lg border border-zinc-200 bg-white p-1 shadow-[0_16px_40px_rgba(24,24,27,.16)]" style={{ top, left }}>
    <div className="px-2 py-1 text-[12px] text-zinc-400">{L('在此工作区新建会话', 'New session in workspace')}</div>
    {agents.length === 0 && <div className="px-2 py-2 text-[12px] text-zinc-400">{L('暂无可用 Agent', 'No available agents')}</div>}
    {agents.map(agent => {
      const busy = creatingPair?.agentId === agent.id && creatingPair.cwd === cwd;
      return <button key={agent.id} type="button" disabled={Boolean(creatingPair)} onClick={() => onSelect(agent.id)} className="flex h-8 w-full items-center gap-2 rounded-md px-2 text-left text-[12px] text-zinc-700 hover:bg-zinc-100 disabled:opacity-50">
        {busy ? <RefreshCw size={13} className="shrink-0 animate-spin text-zinc-500"/> : <AgentIcon agentId={agent.id} agentName={agent.name} size={14}/>}
        <span className="min-w-0 flex-1 truncate">{agent.name}</span>
      </button>;
    })}
  </div>;
}

type ItemDrag = { dragging: boolean; over: boolean; props: HTMLAttributes<HTMLDivElement> & { draggable?: boolean } };

/** 会话状态指示：忙碌中转圈（对齐 Codex 的运行态），其余用静态点。尺寸交给调用方定，
 * 这样完整行的行首点和「最近」行尾点可以共用同一套语义与配色。 */
function SessionStateIndicator({ session, size = 12 }: { session: Session; size?: number }) {
  const locale = useLocale();
  // 「等待授权」是卡在等人，不是在推进：给静态橙点，转圈会让人以为它在自己跑。
  if (busyStates.has(session.state) && session.state !== 'waiting_for_permission') {
    return <LoaderCircle size={size} aria-label={sessionStateLabel(session.state, session.interruptIntent, locale)} className={`shrink-0 animate-spin ${stateTextTone[session.state] ?? 'text-zinc-400'}`}/>;
  }
  return <span aria-label={sessionStateLabel(session.state, session.interruptIntent, locale)} className={`h-1.5 w-1.5 shrink-0 rounded-full ${stateTone[session.state] ?? 'bg-zinc-400'}`}/>;
}

const SessionRow = memo(function SessionRow({ session, agent, botName, parentLabel, active, unread, drag, noteOf, showAgentIcon = true, renameRequest, onSelect, onOpenContextMenu }: { session: Session; agent?: Agent; botName?: string; /** 侧边会话的父会话显示名，供 hover 卡片点出来处。 */ parentLabel?: string; active: boolean; /** 有未查看的新完成/待审批通知时展示柔和轻提示点，点击会话后自动清除。 */ unread?: UnreadSessionNotification; /** 传入即表示这一行可拖拽：项目树里用于排序，时间列表里只用于拖到副屏。 */ drag?: ItemDrag; /** 小猫（主会话）派出的侧边会话：行首叠放便签微角标，悬停提示是谁派的。 */ noteOf?: string; /** 是否在行首展示 Agent 图标（时间视图展示，项目视图同组会话由分组头承载）。 */ showAgentIcon?: boolean; /** 右键菜单发起改名的请求号。 */ renameRequest?: number; onSelect(sessionId: string): void; onOpenContextMenu(sessionId: string, point: { x: number; y: number }, anchor: HTMLElement): void }) {
  const locale = useLocale();
  const L = useBi();
  const agentName = agent?.name ?? session.agentId;
  const primary = sessionLabel(session, agent?.name);
  const hoverCard = <SessionHoverCard session={session} agentName={agentName} botName={botName} parentLabel={parentLabel} now={new Date()}/>;
  const attention = busyStates.has(session.state) || session.state === 'failed';
  const unreadDotTone = unread?.kind === 'waiting_approval'
    ? 'bg-orange-500 ui-live-dot'
    : unread?.kind === 'failed'
      ? 'bg-red-500'
      : unread?.kind === 'notify'
        ? 'bg-blue-500'
        : 'bg-emerald-500';
  const unreadLabel = unread?.kind === 'waiting_approval'
    ? L('等待处理', 'Needs attention')
    : unread?.kind === 'failed'
      ? L('运行失败', 'Run failed')
      : L('有新完成回复', 'New completed reply');
  const trailing = attention
    ? <SessionStateIndicator session={session} size={12}/>
    : unread
      ? <span className="flex items-center gap-1.5">
          <span className="text-[12px] tabular-nums text-zinc-400 max-md:hidden">{relativeTimeLabel(sessionActivityTime(session), Date.now(), locale)}</span>
          <span aria-label={unreadLabel} className={`h-2 w-2 shrink-0 rounded-full ${unreadDotTone}`}/>
        </span>
      : <span className="text-[12px] tabular-nums text-zinc-400 max-md:hidden">{relativeTimeLabel(sessionActivityTime(session), Date.now(), locale)}</span>;
  const rowRef = useRef<HTMLDivElement>(null);
  const longPress = useRef<{ timer?: ReturnType<typeof setTimeout>; start?: { x: number; y: number } }>({});
  const longPressed = useRef(false);
  // 移动端长按后浏览器仍会补一次 click，用它挡住「松手就打开会话」。
  const suppressClickUntil = useRef(0);
  const clearLongPress = () => {
    if (longPress.current.timer) clearTimeout(longPress.current.timer);
    longPress.current = {};
  };
  useEffect(() => () => clearLongPress(), []);
  const openContextMenu = (point: { x: number; y: number }) => {
    if (rowRef.current) onOpenContextMenu(session.id, point, rowRef.current);
  };
  const finishPointer = () => {
    // 按压多久都算：松手这一刻再刷新抑制窗口，避免长按超过 1 秒后补发的 click 打开会话。
    if (longPressed.current) suppressClickUntil.current = Date.now() + 900;
    longPressed.current = false;
    clearLongPress();
  };
  const row = <div
    ref={rowRef}
    onClick={() => { if (shouldOpenSessionFromClick(suppressClickUntil.current, Date.now())) onSelect(session.id); }}
    onContextMenu={event => { event.preventDefault(); openContextMenu({ x: event.clientX, y: event.clientY }); }}
    onPointerDown={event => {
      if (event.pointerType === 'mouse') return;
      clearLongPress();
      longPressed.current = false;
      const point = { x: event.clientX, y: event.clientY };
      longPress.current.start = point;
      longPress.current.timer = setTimeout(() => {
        longPress.current = {};
        longPressed.current = true;
        openContextMenu(point);
      }, 480);
    }}
    onPointerMove={event => {
      const start = longPress.current.start;
      if (start && Math.hypot(event.clientX - start.x, event.clientY - start.y) > 8) clearLongPress();
    }}
    onPointerUp={finishPointer}
    onPointerCancel={finishPointer}
    role="button"
    tabIndex={0}
    onKeyDown={event => {
      if (isContextMenuKeyboardEvent(event)) {
        event.preventDefault();
        const rect = event.currentTarget.getBoundingClientRect();
        openContextMenu({ x: rect.left + 16, y: rect.top + rect.height });
        return;
      }
      if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); onSelect(session.id); }
    }}
    {...(drag?.props ?? {})}
    className={`group relative flex h-[34px] w-full cursor-pointer items-center gap-2 rounded-lg px-2 text-left transition-[color,background-color,opacity] duration-150 ${active ? 'bg-zinc-100 text-zinc-900' : 'text-zinc-700 hover:bg-zinc-100/60'} ${drag?.dragging ? 'opacity-40' : ''} ${drag?.over ? 'ring-1 ring-zinc-300' : ''}`}
  >
    <SessionRowLeadingIcons session={session} agent={agent} noteOf={noteOf} showAgentIcon={showAgentIcon} active={active}/>
    {/* 行内不再放任何操作图标：重命名和归档都收进右键/长按菜单，避免 hover 时堆一排按钮。 */}
    <SessionTitleEditor session={session} label={primary} nameClassName="min-w-0 flex-1 truncate text-[14px]" editRequest={renameRequest}/>
    {session.pinnedAt && <Pin key="pinned" size={11} aria-label={L('已置顶', 'Pinned')} className="ui-icon-pop shrink-0 fill-current text-amber-500"/>}
    <span className="flex shrink-0 items-center justify-end">{trailing}</span>
  </div>;
  // 信息卡一律往右弹：锚点是**整行**（宽度铺满侧栏），而卡片有 320px 宽、十来行高，
  // 往上弹会盖住侧栏顶部（第一行的卡片实测压住 AgentDock 的 logo），往下弹又会压住
  // 它下面的会话行。往右正好落进主内容区的空白，侧栏一个字都不挡。
  // `align="start"` 让卡片顶边对齐行顶边，滚动到任意位置都不会有半个卡片飘在视口外。
  return <HoverTooltip content={hoverCard} side="right" align="start" hoverOnly>{row}</HoverTooltip>;
}, (prev, next) =>
  prev.session === next.session
  && prev.agent === next.agent
  && prev.botName === next.botName
  && prev.parentLabel === next.parentLabel
  && prev.active === next.active
  && prev.unread === next.unread
  && prev.noteOf === next.noteOf
  && prev.showAgentIcon === next.showAgentIcon
  && prev.renameRequest === next.renameRequest
  && prev.drag?.dragging === next.drag?.dragging
  && prev.drag?.over === next.drag?.over
);

export default function App() {
  const locale = useLocale();
  const t = useT();
  const L = useBi();
  const qc = useQueryClient(); const { primarySessionId, setSession, openTab, closeTab, activateTab, renameTab, restoreFromUrl, togglePane } = useDockStore();
  const mountedTabs = useDockStore(state => state.tabs);
  const tabs = useMemo(() => mountedTabs.filter(tab => tab.ownerSessionId === primarySessionId), [mountedTabs, primarySessionId]);
  const paneOpen = useDockStore(state => state.paneOpen);
  const activeTabId = useDockStore(state => state.activeTabId);
  const activeTab = tabs.find(tab => tab.id === activeTabId);
  const [webDenied, setWebDenied] = useState<WebAccessDeniedError>();
  // 本地 Web 访问门拒绝时（飞书卡片链接过期/被转发越权），整页替换为说明面板，避免数据区白屏。
  // 同时立刻掐掉全部轮询与在途请求：401 后继续 2s 一轮地打接口没有任何意义，只会刷一屏红。
  useEventListener('agentdock:web-access-denied', (event: Event) => {
    setWebDenied((event as CustomEvent<WebAccessDeniedError>).detail);
    void qc.cancelQueries({ predicate: shouldCancelOnAccessDenied });
  }, { target: () => window });
  const [sidebarOpen, setSidebarOpen] = useState(false); const [collapsedWorkspaces, setCollapsedWorkspaces] = useState<Set<string>>(new Set()); const [collapsedAgentGroups, setCollapsedAgentGroups] = useState<Set<string>>(new Set()); const [sessionFilter, setSessionFilter] = useState('all');
  const [boardRoute, setBoardRoute] = useState<{ active: boolean; boardId?: string }>(() => {
    const parsed = parseBoardRoute(window.location.pathname);
    return parsed ? { active: true, ...(parsed.boardId ? { boardId: parsed.boardId } : {}) } : { active: false };
  });
  const pwa = usePwaInstall();
  // iOS 键盘弹出不缩小 layout viewport，100dvh 仍是全高 → 整页可滚。
  // 根容器的高度与位移由 useVisualViewportShell 直接在事件回调里命令式写入（不走 state，
  // 否则重渲染跟不上键盘动画，顶栏会先滚出去再被拽回来）：锁高度防整页橡皮筋滚动，
  // translateY(offsetTop) 让根容器跟随上移的可视视口，否则键盘弹出时 composer 栏
  // 与可视窗口底部之间会空出 offsetTop 高的一条空白。
  // 这两个值只作用在根容器这一层，#root 外壳恒为 100dvh：页面高度不随键盘变化，
  // 浏览器就不会重算并夹取 offsetTop，与这里的 translateY 互相打架。
  // 因此根容器不能带 style prop——React 不管辖内联样式，重渲染才不会覆盖上面的赋值。
  const shellRef = useVisualViewportShell<HTMLDivElement>();
  const agents = useQuery({ queryKey: ['agents'], queryFn: () => api.agents(), enabled: !webDenied }); const sessions = useQuery({ queryKey: ['sessions'], queryFn: api.sessions, enabled: !webDenied, refetchInterval: webDenied ? false : 2_000, refetchIntervalInBackground: true }); const larkConfig = useQuery({ queryKey: ['lark-config'], queryFn: api.larkConfig, enabled: !webDenied, refetchInterval: webDenied ? false : 5_000 }); const systemCapabilities = useQuery({ queryKey: ['system-capabilities'], queryFn: api.systemCapabilities, enabled: !webDenied }); const assistantState = useAssistantState(!webDenied);
  const projects = useQuery({ queryKey: ['projects'], queryFn: api.projects, enabled: !webDenied, refetchInterval: webDenied ? false : 30_000 });
  const taskRecoveryConfigQuery = useQuery({ queryKey: ['task-recovery-config'], queryFn: api.taskRecoveryConfig, enabled: !webDenied, staleTime: 30_000, refetchOnWindowFocus: false });
  // 地址栏 → store：首次挂载读一次；浏览器前进/后退再读一次。
  const applyUrlToStore = () => {
    const board = parseBoardRoute(window.location.pathname);
    if (board) {
      setBoardRoute({ active: true, ...(board.boardId ? { boardId: board.boardId } : {}) });
      return;
    }
    setBoardRoute({ active: false });
    const match = window.location.pathname.match(/^\/sessions\/([^/]+)$/);
    const primary = match?.[1] ? decodeURIComponent(match[1]) : undefined;
    const right = parseRightParam(window.location.search, primary);
    if (!right || !primary) { restoreFromUrl(primary); return; }
    if (right.kind === 'session') { if (right.sessionId) restoreFromUrl(primary, sessionPaneTab(primary, right.sessionId, right.sessionId)); return; }
    restoreFromUrl(primary, { id: `${right.kind}:${primary}`, kind: right.kind, anchorSessionId: primary, title: right.kind === 'terminal' ? L('终端', 'Terminal') : right.kind === 'files' ? L('文件', 'Files') : L('原始日志', 'Raw Logs') });
  };
  useMount(applyUrlToStore);
  useEventListener('popstate', applyUrlToStore);
  // store → 地址栏：主屏 / 右栏活跃标签 / 看板视图变化时 replaceState 同步，刷新与分享链接可恢复。
  useUpdateEffect(() => {
    if (boardRoute.active) {
      window.history.replaceState(null, '', boardUrl(boardRoute.boardId));
      return;
    }
    window.history.replaceState(null, '', sessionUrl(primarySessionId, paneOpen ? activeTab : undefined));
  }, [boardRoute.active, boardRoute.boardId, primarySessionId, activeTabId, tabs, paneOpen]);
  // 默认按「最后一次对话时间」倒序。updatedAt 会被状态切换（工具、授权、归档）刷新，
  // 用它排会把「最近动过的」压过「最近聊过的」，所以改用 lastMessageAt，旧数据回退 updatedAt。
  const sortedSessions = useMemo(() => [...(sessions.data ?? [])].sort((left, right) => sessionActivityTime(right).localeCompare(sessionActivityTime(left))), [sessions.data]);
  const visibleSessions = useMemo(() => sortedSessions.filter(session => session.id !== assistantState.data?.mainSessionId && !session.archivedAt && (sessionFilter === 'all' || sessionFilter === 'local' ? sessionFilter === 'all' || session.source !== 'lark' : session.source === 'lark' && session.sourceId?.startsWith(`${sessionFilter}:`))), [sortedSessions, sessionFilter, assistantState.data?.mainSessionId]);
  const archivedSessions = useMemo(() => sortedSessions.filter(session => session.archivedAt), [sortedSessions]);
  const workspaceGroups = useMemo(() => groupSessions(visibleSessions, agents.data ?? []), [visibleSessions, agents.data]);
  const { pinned: pinnedSessions, rest: unpinnedSessions } = useMemo(() => splitPinned(visibleSessions, isSessionPinned), [visibleSessions]);
  const mainSessionId = assistantState.data?.mainSessionId ?? undefined;
  // 工作区 / Agent / 会话 三层的手动排序覆盖，持久化。
  const [itemOrder, setItemOrder] = useLocalStorageState<SidebarItemOrder>('agentdock:sidebar-item-order', { defaultValue: EMPTY_ITEM_ORDER });
  // 手动排序覆盖：没排过的层保持 groupSessions 给的时间默认序，排过的按保存顺序，新项浮到最前。
  // 先 memo 归一化后的顺序，否则 normalizeItemOrder 每轮返回新对象会让下面的 useMemo 白跑。
  const order = useMemo(() => normalizeItemOrder(itemOrder), [itemOrder]);
  const orderedGroups = useMemo(() => applyOrder(workspaceGroups, order.workspaces, workspace => workspace.cwd).map(workspace => ({
    ...workspace,
    agents: applyOrder(workspace.agents, order.agents[workspace.cwd], group => group.agentId).map(group => ({
      ...group,
      sessions: applyOrder(group.sessions, order.sessions[`${workspace.cwd}\0${group.agentId}`], session => session.id)
    }))
  })), [workspaceGroups, order]);
  /**
   * 项目视图 = 会话派生出的工作区 + 已登记但没有会话的导入项目。
   * 所有分组仍套用既有手动排序；置顶只把分组提到最前，组内顺序不动。
   */
  const baseProjectGroups = useMemo(() => {
    const orderedByCwd = new Map(orderedGroups.map(group => [group.cwd, group]));
    return applyOrder(mergeProjectGroups(workspaceGroups, projects.data ?? []), order.workspaces, group => group.cwd)
      .map(group => {
        const ordered = orderedByCwd.get(group.cwd);
        return ordered ? { ...group, agents: ordered.agents } : group;
      });
  }, [workspaceGroups, orderedGroups, projects.data, order.workspaces]);
  const orderedProjectGroups = useMemo(() => pinnedFirst(baseProjectGroups, isProjectPinned), [baseProjectGroups]);
  // 手动排序是否真的在生效：比较渲染结果，陈旧 id 不算数（否则按钮会一直挂着）。
  const manualOrder = useMemo(() => !sameSessionTree(workspaceGroups, orderedGroups), [workspaceGroups, orderedGroups]);
  // 侧栏默认按时间分组；「项目」视图复用 groupSessions 的工作区树。选择持久化。
  const [sidebarGrouping, setSidebarGrouping] = useLocalStorageState<'time' | 'project'>('agentdock:sidebar-grouping', { defaultValue: 'time' });
  // localStorage 可能残留旧值，未知值一律回到时间分组，而不是渲染出空白列表。
  const sidebarGroupingMode = sidebarGrouping === 'project' ? 'project' : 'time';
  // 新建对话：回到空态首页，由 DraftComposer 在提交时才创建 Session；不再弹选择框。
  // 输入框可能本帧才挂载，放到下一帧再聚焦。
  const draftTextareaRef = useRef<ComposerEditorHandle | null>(null);
  const startNewConversation = useMemoizedFn(() => {
    // 「新建对话」就是新对话：首页的发送目标不能还停在「交给小猫」。
    useCompanionStore.getState().setHomeTarget('new');
    setBoardRoute({ active: false });
    setSession(undefined); setSidebarCollapsed(false); setSidebarOpen(false); setPaneMenuAnchor(undefined);
    requestAnimationFrame(() => draftTextareaRef.current?.focus());
  });
  const openBoard = useMemoizedFn((boardId?: string) => {
    useCompanionStore.getState().closeDrawer();
    setBoardRoute(cur => ({ active: true, ...(boardId ? { boardId } : cur.boardId ? { boardId: cur.boardId } : {}) }));
    setSidebarOpen(false);
    setPaneMenuAnchor(undefined);
  });
  const toggleBoard = useMemoizedFn(() => {
    setBoardRoute(cur => cur.active ? { active: false, ...(cur.boardId ? { boardId: cur.boardId } : {}) } : { active: true, ...(cur.boardId ? { boardId: cur.boardId } : {}) });
    setSidebarOpen(false);
    setPaneMenuAnchor(undefined);
  });
  // ⌘K / Ctrl+K 全局搜索会话；⌘⇧B / Ctrl+Shift+B 秒切看板模式。
  const openSearch = useMemoizedFn(() => { setSidebarOpen(false); openAppDialog('search'); });
  useEventListener('keydown', event => {
    if ((event.metaKey || event.ctrlKey) && !event.shiftKey && event.key.toLowerCase() === 'k') {
      event.preventDefault();
      openSearch();
    } else if ((event.metaKey || event.ctrlKey) && event.shiftKey && event.key.toLowerCase() === 'b') {
      event.preventDefault();
      toggleBoard();
    }
  });
  const toggleWorkspace = (cwd: string) => setCollapsedWorkspaces(current => {
    const next = new Set(current);
    if (next.has(cwd)) next.delete(cwd); else next.add(cwd);
    return next;
  });
  // agent 子分组的折叠态独立于工作区：key 是 cwd + agentId，跨列表刷新稳定。
  const toggleAgentGroup = (key: string) => setCollapsedAgentGroups(current => {
    const next = new Set(current);
    if (next.has(key)) next.delete(key); else next.add(key);
    return next;
  });
  // 首次拿到分组时只展开最近一个工作区，其余折叠；之后用户的开合选择不再被覆盖。
  const workspacesInitialized = useRef(false);
  useUpdateEffect(() => {
    if (workspacesInitialized.current || !workspaceGroups.length) return;
    workspacesInitialized.current = true;
    setCollapsedWorkspaces(new Set(workspaceGroups.slice(1).map(workspace => workspace.cwd)));
  }, [workspaceGroups]);
  const primarySession = sortedSessions.find(session => session.id === primarySessionId);
  const unreadBySession = useUnreadNotificationsStore(state => state.unreadBySession);
  const [localNotifyPrefs] = useLocalNotificationPrefs();
  const unreadEntries = useMemo(() => Object.values(unreadBySession), [unreadBySession]);
  // 标签页标题跟主会话走，并在后台存在未读完成/审批会话时温和交替提示。
  useDocumentTitle(
    primarySession ? sessionLabel(primarySession, agents.data?.find(agent => agent.id === primarySession.agentId)?.name) : undefined,
    {
      unreadCount: unreadEntries.length,
      hasUrgent: unreadEntries.some(entry => entry.kind === 'waiting_approval' || entry.kind === 'failed'),
      flashEnabled: localNotifyPrefs.tabTitleBadge
    }
  );
  const selectSession = useMemoizedFn((id: string) => {
    useUnreadNotificationsStore.getState().clearSession(id);
    setBoardRoute(cur => ({ active: false, ...(cur.boardId ? { boardId: cur.boardId } : {}) }));
    setSession(id);
    setSidebarOpen(false);
    setPaneMenuAnchor(undefined);
  });
  const handleSessionContextMenu = useMemoizedFn((sessionId: string, point: { x: number; y: number }, anchor: HTMLElement) => {
    setSessionMenu({ sessionId, point, anchor });
  });
  useNotificationCenter({
    enabled: !webDenied,
    primarySessionId,
    secondaryActiveSessionId: paneOpen ? activeTab?.sessionId : undefined,
    onNavigateSession: id => selectSession(id)
  });
  useThemeSync({ enabled: !webDenied });
  useLocaleSync({ enabled: !webDenied });
  /**
   * 把一个**已有**会话放进副屏。此前副屏只有「新建侧边聊天」一条创建路径（sideChat），
   * 标签一关就再也回不来——会话还在，但没有任何入口能把它放回右栏。
   *
   * 用 sortedSessions 查（含已归档），与 App 渲染副屏标签时同一口径。
   * 主会话自己不进副屏：URL 解析侧有同样的守卫，否则右栏会重复显示主会话。
   */
  const openSessionInPane = (sessionId: string) => {
    if (!primarySessionId || sessionId === primarySessionId) return;
    const session = sortedSessions.find(item => item.id === sessionId);
    if (!session) return;
    openTab(sessionPaneTab(primarySessionId, sessionId, sessionLabel(session, agents.data?.find(agent => agent.id === session.agentId)?.name)), primarySessionId);
  };
  // 会话标签的标题以会话为准：URL 还原时只能拿会话 id 兜底，会话数据到位后回填；
  // 顺带让首条消息生成标题后标签名跟着更新。
  useUpdateEffect(() => {
    for (const tab of mountedTabs) {
      if (tab.kind !== 'session' && tab.kind !== 'side-chat') continue;
      const session = sortedSessions.find(item => item.id === tab.sessionId);
      if (session) renameTab(tab.id, sessionLabel(session, agents.data?.find(agent => agent.id === session.agentId)?.name));
    }
  }, [mountedTabs, sortedSessions, agents.data]);
  // ---- 右栏面板 ----
  const openRawLog = useMemoizedFn((sessionId: string) => {
    if (!primarySessionId) return;
    openTab({ id: `raw:${sessionId}`, kind: 'raw', anchorSessionId: sessionId, title: sessionId === primarySessionId ? L('原始日志', 'Raw Logs') : L('侧边日志', 'Side Logs') }, primarySessionId);
  });
  // 终端与文件依附主会话；原始日志依附当前选中的会话标签。
  const openPaneKind = useMemoizedFn((kind: PaneTabKind) => {
    setPaneMenuAnchor(undefined);
    if (!primarySessionId) return;
    if (kind === 'raw') {
      const active = tabs.find(tab => tab.id === activeTabId);
      openRawLog(active?.sessionId ?? active?.anchorSessionId ?? primarySessionId);
      return;
    }
    if (kind === 'terminal' || kind === 'files') {
      openTab({ id: `${kind}:${primarySessionId}`, kind, anchorSessionId: primarySessionId, title: kind === 'terminal' ? L('终端', 'Terminal') : L('文件', 'Files') });
      return;
    }
    // 侧边聊天要在右栏新开一个会话，由 mutation 完成（建会话需要请求）。
    if (primarySession) sideChat.mutate({ source: primarySession });
  });

  const sideChatConfigQuery = useQuery({
    queryKey: ['side-chat-config'],
    queryFn: api.sideChatConfig,
    staleTime: 60_000,
    refetchOnWindowFocus: false
  });
  const sideChatConfig = sideChatConfigQuery.data?.config ?? DEFAULT_SIDE_CHAT_CONFIG;
  const outputPluginsCatalog = useOutputPluginsCatalog(!webDenied);
  const askUserQuestionXmlEnabled = outputPluginsCatalog.askUserQuestionGlobalEnabled;

  /**
   * 侧边聊天统一入口（副屏按钮、⌘⇧S、/btw 共用同一份 sideChatConfig）：
   * - 按配置选择跟随当前会话还是指定独立 Agent/模型/思考深度；
   * - /btw 配置为复用时优先复用当前会话最近活跃的侧边会话；
   * - 按配置在右侧副屏并排打开或直接切换到侧边会话；
   * - 若带初始问题（来自 `/btw <问题>`），自动发送到该侧边会话，不污染主会话上下文。
   */
  const sideChat = useMutation({
    mutationFn: async (input: { source: Session; initialPrompt?: string; fromBtw?: boolean }) => {
      const config = sideChatConfigQuery.data?.config ?? DEFAULT_SIDE_CHAT_CONFIG;
      const reusable = input.fromBtw && config.btwSessionReuse === 'reuse_latest'
        ? findReusableSideChatSession(input.source.id, sortedSessions, tabs)
        : undefined;
      const target = reusable ?? await api.create(resolveSideChatStartOptions(input.source, config, agents.data ?? []));
      return { target, reused: Boolean(reusable), config, source: input.source, initialPrompt: input.initialPrompt };
    },
    onSuccess: async ({ target, reused, config, source, initialPrompt }) => {
      if (!reused) void qc.invalidateQueries({ queryKey: ['sessions'] });
      if (config.openMode === 'switch_session') {
        selectSession(target.id);
      } else {
        const anchorId = primarySessionId ?? source.id;
        const title = reused
          ? sessionLabel(target, agents.data?.find(agent => agent.id === target.agentId)?.name)
          : L('侧边聊天', 'Side Chat');
        openTab({ id: `side-chat:${target.id}`, kind: 'side-chat', sessionId: target.id, title }, anchorId);
      }
      if (initialPrompt?.trim()) {
        try {
          await api.send(target.id, initialPrompt, 'queue', undefined, createClientMessageId());
          void qc.invalidateQueries({ queryKey: ['tasks', target.id] });
        } catch (error) {
          setActionError(error instanceof Error ? error.message : String(error));
        }
      }
    },
    onError: error => setActionError(error instanceof Error ? error.message : String(error))
  });

  const handleSessionSideChat = useMemoizedFn(async (source: Session, options?: { initialPrompt?: string; fromBtw?: boolean }) => {
    await sideChat.mutateAsync({ source, ...options });
  });

  const shortcuts: Shortcut[] = [
    { key: 't', label: shortcutLabel('t'), description: L('终端', 'Terminal'), run: () => openPaneKind('terminal') },
    { key: 's', shift: true, label: shortcutLabel('s', true), description: L('侧边聊天', 'Side Chat'), run: () => openPaneKind('side-chat') },
    { key: 'p', label: shortcutLabel('p'), description: L('文件', 'Files'), run: () => openPaneKind('files') }
  ];
  useShortcuts(shortcuts);



  // 侧边栏桌面端拖拽调宽 / 收起：拖到 180 以下自动收成 44px 细条；移动端始终走抽屉，不受影响。
  const [sidebarWidth, setSidebarWidth] = useLocalStorageState<number>('agentdock:sidebar-width', { defaultValue: 268 });
  const [sidebarCollapsed, setSidebarCollapsed] = useLocalStorageState<boolean>('agentdock:sidebar-collapsed', { defaultValue: false });
  // 三层共用一个拖拽态：scope 区分层级（workspaces / agents:<cwd> / sessions:<cwd>\0<agentId>）。
  // sessionId 是「拖到副屏」的载荷，与排序用的 scope 正交：排序拖拽顺带带上它，
  // 不参与排序的会话行（侧边会话、时间列表）只带它。
  const [dragItem, setDragItem] = useState<{ scope: string; id: string; sessionId?: string }>();
  const [dragOverItem, setDragOverItem] = useState<{ scope: string; id: string }>();
  const [resizingSidebar, setResizingSidebar] = useState(false);
  const resizeStart = useRef({ x: 0, width: 268 });
  const clampedSidebarWidth = Math.min(480, Math.max(200, sidebarWidth ?? 268));
  useEventListener('pointermove', (event: PointerEvent) => {
    if (!resizingSidebar) return;
    const next = Math.min(560, Math.max(140, resizeStart.current.width + (event.clientX - resizeStart.current.x)));
    setSidebarWidth(next);
  }, { target: () => document, enable: resizingSidebar });
  useEventListener('pointerup', () => {
    if (!resizingSidebar) return;
    setResizingSidebar(false);
    if ((sidebarWidth ?? 268) < 180) setSidebarCollapsed(true);
  }, { target: () => document, enable: resizingSidebar });

  // 工作区行「+」：弹出 agent 选择后建会话；agent 分组行「+」：用该 agent 直接建。
  const [agentPicker, setAgentPicker] = useState<{ cwd: string; top: number; left: number } | null>(null);
  const [creatingPair, setCreatingPair] = useState<{ agentId: string; cwd: string }>();
  /** 「新建面板」类型菜单的锚点元素；undefined 表示菜单关闭。 */
  const [paneMenuAnchor, setPaneMenuAnchor] = useState<HTMLElement | undefined>();
  /** 右栏面板自己的错误（建侧边会话失败之类）。会话内的错误由 SessionPane 自己管。 */
  const [actionError, setActionError] = useState<string>();
  // 快速归档只有一个确认框：状态由纯控制器管，右键/长按菜单只负责 open(sessionId)。
  const [quickArchive, setQuickArchive] = useState<QuickArchiveSnapshot>({ status: 'closed' });
  // 右键菜单与归档确认共用同一份控制器；菜单只负责把 action 交回 App。
  const [sessionMenu, setSessionMenu] = useState<{ sessionId: string; point: { x: number; y: number }; anchor: HTMLElement }>();
  // 右键菜单选中「重命名会话」后，用递增请求号让对应行进入就地编辑。
  const [renameRequest, setRenameRequest] = useState<{ sessionId: string; nonce: number }>();
  const copyToast = useToast(1_800);
  const quickArchiveController = useMemo(() => createQuickArchiveController({
    archive: async id => {
      const archived = await api.archive(id);
      qc.setQueryData<Session[]>(['sessions'], current => current?.map(item => item.id === archived.id ? archived : item));
      return archived;
    },
    onChange: setQuickArchive
  }), [qc]);
  const quickCreate = useMutation({
    mutationFn: ({ agentId, cwd }: { agentId: string; cwd: string }) => api.create(resolveQuickCreateSessionOptions(agentId, cwd)),
    onMutate: pair => setCreatingPair(pair),
    onSuccess: session => {
      void qc.invalidateQueries({ queryKey: ['sessions'] });
      setCreatingPair(undefined);
      setAgentPicker(null);
      selectSession(session.id);
    },
    onError: () => setCreatingPair(undefined)
  });
  /** 会话置顶只改时间视图；项目置顶只改项目视图，两个 mutation 分开而不是共用一个开关。 */
  const toggleSessionPin = useMutation({
    mutationFn: ({ id, pinned }: { id: string; pinned: boolean }) => api.setSessionPinned(id, pinned),
    onSuccess: (updated, vars) => {
      qc.setQueryData<Session[]>(['sessions'], current => current?.map(item => item.id === updated.id ? { ...item, ...updated } : item));
      copyToast.show(vars.pinned ? L('已置顶会话', 'Session pinned') : L('已取消置顶', 'Session unpinned'), 'success');
    },
    onError: error => setActionError(error instanceof Error ? error.message : String(error))
  });
  const toggleProjectPin = useMutation({
    mutationFn: ({ cwd, pinned }: { cwd: string; pinned: boolean }) => api.setProjectPinned(cwd, pinned),
    onSuccess: (updated, vars) => {
      qc.setQueryData<Project[]>(['projects'], current => current?.map(item => item.cwd === updated.cwd ? { ...item, ...updated } : item));
      copyToast.show(vars.pinned ? L('已置顶项目', 'Project pinned') : L('已取消项目置顶', 'Project unpinned'), 'success');
    },
    onError: error => setActionError(error instanceof Error ? error.message : String(error))
  });

  // ---- 小猫（主会话）的导航：侧栏卡片、右缘、首页、便签都通过它跳转 ----
  const goAdopt = useMemoizedFn(() => {
    useCompanionStore.getState().requestAdoption();
    setBoardRoute(cur => ({ active: false, ...(cur.boardId ? { boardId: cur.boardId } : {}) }));
    setSession(undefined); setSidebarOpen(false); setPaneMenuAnchor(undefined);
  });
  const openMain = useMemoizedFn((sessionId?: string) => {
    const id = sessionId ?? mainSessionId;
    if (!id) { goAdopt(); return; }
    useCompanionStore.getState().closeDrawer();
    if (!boardRoute.active && primarySessionId === id) { setSidebarOpen(false); return; }
    // 首页 / 侧栏的小猫形变到主会话标题栏的头像位。
    withViewTransition(() => selectSession(id));
  });
  const openTask = useMemoizedFn((task: AssistantTask, where: 'auto' | 'primary' | 'pane' = 'auto') => {
    if (!task.sessionId) { useCompanionStore.getState().openDrawer({ highlight: task.id }); return; }
    const target = sortedSessions.find(item => item.id === task.sessionId);
    // 正在看主会话时，便签对应的侧边会话放进副屏并排看；否则直接切过去。
    const inPane = where === 'pane' || (where === 'auto' && !boardRoute.active && Boolean(primarySessionId) && primarySessionId === mainSessionId);
    if (inPane && primarySessionId && target && task.sessionId !== primarySessionId) { openSessionInPane(task.sessionId); return; }
    selectSession(task.sessionId);
  });
  const openAssistantSettings = useMemoizedFn(() => { setSidebarOpen(false); openAppDialog('assistant'); });
  const openSessionById = useMemoizedFn((id: string) => { useCompanionStore.getState().closeDrawer(); selectSession(id); });
  const companionNav = useMemo<CompanionNav>(() => ({ openMain, openTask, goAdopt, openSettings: openAssistantSettings, openSession: openSessionById, openBoard }), [openMain, openTask, goAdopt, openAssistantSettings, openSessionById, openBoard]);
  const companionView = boardRoute.active ? 'board' : !primarySession ? 'home' : primarySession.id === mainSessionId ? 'main' : 'session';
  const boardRunningCount = useMemo(() => visibleSessions.filter(s => busyStates.has(s.state)).length, [visibleSessions]);

  if (webDenied) return <WebAccessDeniedPanel denied={webDenied}/>;
  /**
   * 工作区 / Agent / 会话三层共用的拖拽。scope 隔离层级：只有同一层的元素能互相落点，
   * 避免把会话拖到工作区头上。拖到目标上即视为「插到目标原来的位置」。
   */
  const itemDrag = (scope: string, id: string, onReorder: (from: string, to: string) => void, sessionId?: string): ItemDrag => {
    const dragging = dragItem?.scope === scope && dragItem.id === id;
    const over = dragOverItem?.scope === scope && dragOverItem.id === id;
    return {
      dragging, over,
      props: {
        draggable: true,
        onDragStart: (event: DragEvent<HTMLDivElement>) => { setDragItem({ scope, id, ...(sessionId ? { sessionId } : {}) }); event.dataTransfer.effectAllowed = 'move'; },
        onDragEnd: () => { setDragItem(undefined); setDragOverItem(undefined); },
        onDragOver: (event: DragEvent<HTMLDivElement>) => {
          if (!dragItem || dragItem.scope !== scope || dragItem.id === id) return;
          event.preventDefault();
          event.dataTransfer.dropEffect = 'move';
          setDragOverItem(current => (current?.scope === scope && current.id === id ? current : { scope, id }));
        },
        onDragLeave: () => setDragOverItem(current => (current?.scope === scope && current.id === id ? undefined : current)),
        onDrop: (event: DragEvent<HTMLDivElement>) => {
          event.preventDefault();
          if (dragItem && dragItem.scope === scope && dragItem.id !== id) onReorder(dragItem.id, id);
          setDragItem(undefined);
          setDragOverItem(undefined);
        }
      }
    };
  };
  /**
   * 只用于「拖到副屏」的拖拽源：侧边会话行和「最近」行不参与排序，
   * 但仍然要能被拖进右栏——所以单独一个 scope，不触发任何 reorder。
   */
  const sessionDrag = (sessionId: string): ItemDrag => ({
    dragging: dragItem?.scope === 'session-pane' && dragItem.id === sessionId,
    over: false,
    props: {
      draggable: true,
      onDragStart: (event: DragEvent<HTMLDivElement>) => { setDragItem({ scope: 'session-pane', id: sessionId, sessionId }); event.dataTransfer.effectAllowed = 'copy'; },
      onDragEnd: () => { setDragItem(undefined); setDragOverItem(undefined); }
    }
  });
  // 落点即目标原槽位。保存当前渲染出来的整层 id 顺序（不是只存被拖的那个），
  // 这样「拖过一次」就等于把这一层钉死，之后新增的项再从最前浮上来。
  const reorderWorkspaces = (from: string, to: string) => setItemOrder(current => {
    // 用未按置顶分组的顺序保存，避免「置顶」把用户拖出来的相对位置写进持久化排序。
    const ids = baseProjectGroups.map(workspace => workspace.cwd);
    return { ...normalizeItemOrder(current), workspaces: moveInList(ids, from, to) };
  });
  const reorderAgents = (cwd: string, from: string, to: string) => setItemOrder(current => {
    const ids = (orderedGroups.find(workspace => workspace.cwd === cwd)?.agents ?? []).map(group => group.agentId);
    const normalized = normalizeItemOrder(current);
    return { ...normalized, agents: { ...normalized.agents, [cwd]: moveInList(ids, from, to) } };
  });
  const reorderSessions = (key: string, from: string, to: string) => setItemOrder(current => {
    const [cwd, agentId] = key.split('\0');
    const ids = (orderedGroups.find(workspace => workspace.cwd === cwd)?.agents.find(group => group.agentId === agentId)?.sessions ?? []).map(session => session.id);
    const normalized = normalizeItemOrder(current);
    return { ...normalized, sessions: { ...normalized.sessions, [key]: moveInList(ids, from, to) } };
  });
  const renderSessionRow = (session: Session, drag?: ItemDrag, options?: { showAgentIcon?: boolean }) => {
    // 侧边会话的父标题在这儿查好再传下去，卡片自己不去翻会话列表（它只是展示层）。
    // 父会话被归档或不在当前筛选里就查不到，卡片会降级成不带出处。
    const parent = session.sourceId ? sortedSessions.find(item => item.id === session.sourceId) : undefined;
    // 交接后，前几代小猫派出的侧边会话仍是这只猫家的便签。
    const noteOf = mainSessionId && isLineageSource(session.sourceId, mainSessionId, assistantState.data?.lifecycle?.ancestorSessionIds) && sideChatParentId(session) ? assistantState.data?.companion?.name ?? L('小猫', 'Kitten') : undefined;
    return <SessionRow key={session.id} session={session} drag={drag} noteOf={noteOf} showAgentIcon={options?.showAgentIcon ?? true} agent={agents.data?.find(item => item.id === session.agentId)} botName={larkConfig.data?.bots.find(bot => session.sourceId?.startsWith(`${bot.appId}:`))?.name} parentLabel={parent ? sessionLabel(parent, agents.data?.find(item => item.id === parent.agentId)?.name) : undefined} active={primarySessionId === session.id || tabs.some(tab => (tab.kind === 'session' || tab.kind === 'side-chat') && tab.sessionId === session.id)} unread={localNotifyPrefs.sidebarUnreadDot ? unreadBySession[session.id] : undefined} renameRequest={renameRequest?.sessionId === session.id ? renameRequest.nonce : undefined} onSelect={selectSession} onOpenContextMenu={handleSessionContextMenu}/>;
  };
  // TooltipProvider 必须挂在根部：Radix 用它统一管理「同一时刻只显示一个提示」与交错延迟。
  return <TooltipProvider><CompanionNavProvider value={companionNav}><div ref={shellRef} className="ui-shell relative flex h-full overflow-hidden bg-canvas font-sans text-zinc-900">
    <button
      type="button"
      aria-label={L('关闭会话列表', 'Close sidebar')}
      aria-hidden={!sidebarOpen}
      tabIndex={sidebarOpen ? 0 : -1}
      data-open={sidebarOpen ? 'true' : 'false'}
      onClick={() => setSidebarOpen(false)}
      className={`ui-mobile-scrim fixed inset-0 z-40 bg-zinc-950/25 md:hidden ${sidebarOpen ? 'visible opacity-100 pointer-events-auto' : 'invisible opacity-0 pointer-events-none'}`}
    />
    <aside style={{ ['--sb-w' as string]: `${clampedSidebarWidth}px` }} className={`ui-sidebar-safe fixed inset-y-0 left-0 z-50 flex shrink-0 flex-col overflow-hidden border-r border-zinc-200 bg-rail shadow-[12px_0_36px_rgba(24,24,27,.08)] transition-transform duration-[260ms] ease-[cubic-bezier(.16,1,.3,1)] w-[286px] md:static md:z-20 md:translate-x-0 md:shadow-none ${sidebarOpen ? 'translate-x-0' : '-translate-x-full'} ${sidebarCollapsed ? 'md:w-11' : 'md:w-[var(--sb-w)]'}`}>
      {!sidebarCollapsed && <div onPointerDown={event => { event.preventDefault(); resizeStart.current = { x: event.clientX, width: clampedSidebarWidth }; setResizingSidebar(true); }} title={L('拖拽调整宽度，拖到最窄可收起', 'Drag to resize; drag narrowest to collapse')} className="absolute inset-y-0 right-0 z-20 hidden w-1.5 cursor-col-resize touch-none bg-transparent hover:bg-blue-400/30 md:block"/>}
      <div className={`flex h-full w-full min-w-0 flex-col ${sidebarCollapsed ? 'md:hidden' : ''}`}>
      <div className="flex h-14 w-full min-w-[200px] items-center gap-1 pl-2 pr-2.5">
        <HoverTooltip content={L('回到首页', 'Back to Home')} side="bottom" align="start" hoverOnly>
          <button type="button" onClick={() => { setBoardRoute({ active: false }); setSession(undefined); setSidebarOpen(false); setPaneMenuAnchor(undefined); }} aria-label={L('回到首页', 'Back to Home')} className="ui-press flex h-10 min-w-0 flex-1 items-center rounded-lg px-2 text-left hover:bg-zinc-100/70 active:bg-zinc-200/60"><BrandLogo iconSize={28} wordmarkHeight={14}/></button>
        </HoverTooltip>
        <SidebarPwaInstallButton pwa={pwa}/>
      </div>
      <div className="flex min-w-0 flex-col gap-1 px-2.5">
        <button onClick={startNewConversation} aria-label={L('新建对话', 'New Chat')} className="ui-press flex h-9 w-full min-w-0 items-center gap-2 whitespace-nowrap rounded-lg px-2.5 text-[14px] font-medium text-zinc-700 hover:bg-zinc-100 active:bg-zinc-200/60"><Plus size={16} className="shrink-0"/><span className="truncate">{L('新建对话', 'New Chat')}</span></button>
        <button
          type="button"
          onClick={() => openBoard()}
          aria-current={boardRoute.active ? 'page' : undefined}
          aria-label={L('任务看板（⌘⇧B）', 'Task Board (⌘⇧B)')}
          className={`ui-press flex h-9 w-full min-w-0 items-center gap-2 whitespace-nowrap rounded-lg px-2.5 text-[14px] font-medium ${
            boardRoute.active
              ? 'bg-accent text-accent-fg shadow-sm'
              : 'text-zinc-700 hover:bg-zinc-100 active:bg-zinc-200/60'
          }`}
        >
          <Columns3 size={16} className="shrink-0"/>
          <span className="truncate">{L('任务看板', 'Board')}</span>
          {boardRunningCount > 0 && (
            <span className={`ml-1 inline-flex h-4 min-w-4 shrink-0 items-center justify-center rounded-full px-1 text-[10.5px] font-semibold tabular-nums ${boardRoute.active ? 'bg-blue-500 text-white' : 'bg-blue-100 text-blue-700'}`}>
              {boardRunningCount}
            </span>
          )}
          <span className={`ml-auto shrink-0 rounded border px-1 py-0.5 font-sans text-[11px] leading-none ${boardRoute.active ? 'border-white/20 bg-white/10 text-white/80' : 'border-zinc-200 bg-zinc-50 text-zinc-400'}`}>
            ⌘⇧B
          </span>
        </button>
        <div className="flex min-w-0 items-center gap-1.5">
          <button type="button" onClick={openSearch} aria-label={L('搜索会话（⌘K）', 'Search Sessions (⌘K)')} className="ui-press flex h-9 min-w-0 flex-1 items-center gap-2 whitespace-nowrap rounded-lg border border-zinc-200 bg-white px-2.5 text-[13px] text-zinc-500 hover:border-zinc-300 hover:text-zinc-700"><Search size={14} className="shrink-0"/><span className="truncate">{L('搜索会话', 'Search')}</span><span className="ml-auto shrink-0 rounded border border-zinc-200 bg-zinc-50 px-1 py-0.5 font-sans text-[12px] leading-none text-zinc-400">⌘K</span></button>
          <SessionFilterSelect compact value={sessionFilter} bots={larkConfig.data?.bots ?? []} agents={agents.data ?? []} onChange={setSessionFilter}/>
        </div>
      </div>
      {/* 小猫（主会话）常驻在会话列表上方：点它进主会话，右边的按钮划出便签。 */}
      <div className="mt-3 min-w-0 px-2"><CompanionCard active={Boolean(mainSessionId) && primarySessionId === mainSessionId}/></div>
      <div className="mt-3 flex min-w-0 items-center justify-between gap-1.5 pl-3.5 pr-2">
        <span className="truncate whitespace-nowrap text-[12px] font-medium text-zinc-500">{L('会话列表', 'Sessions')}</span>
        <div className="flex shrink-0 items-center gap-1">
          {sidebarGroupingMode === 'project' && manualOrder && (
            <HoverTooltip content={L('恢复默认排序（按最近对话时间）', 'Reset to default order (recent activity)')} side="top">
              <button type="button" aria-label={L('恢复默认排序', 'Reset default order')} onClick={() => setItemOrder(EMPTY_ITEM_ORDER)} className="ui-press grid h-6 w-6 place-items-center rounded text-zinc-400 hover:bg-zinc-100 hover:text-zinc-700"><RotateCcw size={12}/></button>
            </HoverTooltip>
          )}
          <SlidingSegmented
            ariaLabel={L('会话分组视图', 'Session grouping view')}
            size="xs"
            value={sidebarGroupingMode}
            onChange={mode => setSidebarGrouping(mode)}
            options={[
              { value: 'time', label: L('时间', 'Time') },
              { value: 'project', label: L('项目', 'Project') }
            ]}
          />
        </div>
      </div>
      {sidebarGroupingMode === 'project' && <div className="ui-view-fade mt-1 min-w-0 px-2">
        <button type="button" onClick={() => openAppDialog('project-import')} className="ui-press flex h-7 w-full items-center gap-1.5 whitespace-nowrap rounded-md border border-dashed border-zinc-300 px-2 text-[12px] font-medium text-zinc-600 hover:border-zinc-400 hover:bg-zinc-100 hover:text-zinc-800"><FolderPlus size={12} className="shrink-0"/><span className="truncate">{L('导入项目', 'Import Project')}</span></button>
      </div>}
      {/* 来源筛选从一张大卡片收成搜索框右侧的图标 + 一行「来源：… ✕」标签；不选时不占地方。 */}
      {sessionFilter !== 'all' && <div className="ui-status-banner-in mt-1 flex min-w-0 items-center gap-1.5 px-3.5"><div className="flex h-6 min-w-0 flex-1 items-center gap-1 rounded-md bg-zinc-100 px-2 text-[12px] text-zinc-600"><span className="min-w-0 flex-1 truncate">{L('来源：', 'Source: ')}{sessionFilter === 'local' ? L('本地', 'Local') : `${L('飞书', 'Lark')} · ${larkConfig.data?.bots.find(bot => bot.appId === sessionFilter)?.name ?? L('机器人', 'Bot')}`}</span><HoverTooltip content={L('清除来源筛选', 'Clear source filter')} side="top"><button type="button" aria-label={L('清除来源筛选', 'Clear source filter')} onClick={() => setSessionFilter('all')} className="ui-press grid h-4 w-4 shrink-0 place-items-center rounded text-zinc-400 hover:bg-zinc-200 hover:text-zinc-700"><X size={12}/></button></HoverTooltip></div></div>}
      <div className="mt-1 flex min-h-0 min-w-0 flex-1 flex-col px-2">
        {sessions.isLoading
          ? <div className="space-y-1 px-2 pt-1"><div className="h-[34px] ui-skeleton rounded-lg bg-zinc-200/70"/><div className="h-[34px] ui-skeleton rounded-lg bg-zinc-200/50"/><div className="h-[34px] ui-skeleton rounded-lg bg-zinc-200/40"/></div>
          : (sidebarGroupingMode === 'project' ? orderedProjectGroups.length > 0 : visibleSessions.length > 0)
            ? <div key={sidebarGroupingMode} className="ui-view-fade min-h-0 flex-1 overflow-y-auto pb-2">
              {sidebarGroupingMode === 'time'
                ? <>
                    {pinnedSessions.length > 0 && <section className="mb-2">
                      <div className="flex h-7 items-center gap-1 px-2 text-[12px] font-medium text-amber-600"><Pin size={11} className="fill-current"/>{L('置顶', 'Pinned')}</div>
                      {pinnedSessions.map(session => renderSessionRow(session, sessionDrag(session.id)))}
                    </section>}
                    {groupSessionsByTime(unpinnedSessions, new Date(), locale).map(group => <section key={group.key} className="mb-2">
                      <div className="flex h-7 items-center px-2 text-[12px] font-medium text-zinc-400">{group.label}</div>
                      {group.sessions.map(session => renderSessionRow(session, sessionDrag(session.id)))}
                    </section>)}
                  </>
                : orderedProjectGroups.map(workspace => {
                  const collapsed = collapsedWorkspaces.has(workspace.cwd);
                  const workspaceDrag = itemDrag('workspaces', workspace.cwd, reorderWorkspaces);
                  const busyCount = workspace.agents.reduce((count, group) => count + group.sessions.filter(session => busyStates.has(session.state)).length, 0);
                  return <div key={workspace.cwd} className="mb-0.5">
                    <div role="button" tabIndex={0} {...workspaceDrag.props} onClick={() => toggleWorkspace(workspace.cwd)} onKeyDown={event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); toggleWorkspace(workspace.cwd); } }} title={L(`${workspace.cwd}（拖拽可换位）`, `${workspace.cwd} (Drag to reorder)`)} className={`group sticky top-0 z-[1] flex h-7 w-full cursor-pointer items-center gap-1.5 rounded-lg bg-rail pl-2 pr-1 text-left transition-[background-color,opacity] duration-150 hover:bg-zinc-100/70 ${workspaceDrag.dragging ? 'opacity-40' : ''} ${workspaceDrag.over ? 'ring-1 ring-zinc-300' : ''}`}>
                      <ChevronRight size={12} className={`shrink-0 text-zinc-400 transition-transform duration-[220ms] ease-[cubic-bezier(.16,1,.3,1)] ${collapsed ? '' : 'rotate-90'}`}/>
                      <Folder size={12} className="shrink-0 text-zinc-400"/>
                      <HoverTooltipText content={workspace.cwd} className="min-w-0 flex-1 truncate text-[12px] font-medium text-zinc-600">{workspace.label}</HoverTooltipText>
                      {workspace.missing && <HoverTooltip content={L('路径不可用（可能已被删除或移动）', 'Path unavailable (may have been moved or deleted)')} side="top"><span aria-label={L('项目路径不可用', 'Project path unavailable')} className="inline-flex shrink-0"><AlertTriangle size={11} className="shrink-0 text-amber-500"/></span></HoverTooltip>}
                      <HoverTooltip content={workspace.pinnedAt ? L('取消置顶项目', 'Unpin project') : L('置顶项目', 'Pin project')} side="top">
                        <button type="button" aria-label={workspace.pinnedAt ? L('取消置顶项目', 'Unpin project') : L('置顶项目', 'Pin project')} aria-pressed={Boolean(workspace.pinnedAt)} onClick={event => { event.stopPropagation(); toggleProjectPin.mutate({ cwd: workspace.cwd, pinned: !workspace.pinnedAt }); }} className={`ui-press grid h-5 w-5 shrink-0 place-items-center rounded hover:bg-zinc-200 hover:text-zinc-800 focus:opacity-100 max-md:opacity-100 ${workspace.pinnedAt ? 'text-amber-500 opacity-100' : 'text-zinc-400 opacity-0 group-hover:opacity-100'}`}><Pin key={workspace.pinnedAt ? 'pinned' : 'unpinned'} size={11} className={workspace.pinnedAt ? 'ui-icon-pop fill-current' : ''}/></button>
                      </HoverTooltip>
                      {busyCount > 0 && <span className="ui-status-pulse h-1.5 w-1.5 shrink-0 rounded-full bg-blue-500"/>}
                      <HoverTooltip content={L('在此工作区新建会话', 'New session in workspace')} side="top">
                        <span role="button" tabIndex={-1} aria-label={L('在此工作区新建会话', 'New session in workspace')} onClick={event => { event.stopPropagation(); const rect = (event.currentTarget as HTMLElement).getBoundingClientRect(); setAgentPicker({ cwd: workspace.cwd, top: rect.bottom + 4, left: Math.min(rect.left, window.innerWidth - 224) }); }} className="ui-press grid h-5 w-5 shrink-0 place-items-center rounded text-zinc-400 opacity-0 hover:bg-zinc-200 hover:text-zinc-800 focus:opacity-100 group-hover:opacity-100 max-md:opacity-100"><Plus size={12}/></span>
                      </HoverTooltip>
                      <GripVertical size={11} className="shrink-0 cursor-grab text-zinc-300 opacity-0 transition-opacity group-hover:opacity-100"/>
                      <span className="shrink-0 text-[12px] tabular-nums text-zinc-400">{workspace.agents.reduce((count, group) => count + group.sessions.length, 0)}</span>
                    </div>
                    <Disclosure open={!collapsed}><div className="ml-1.5 border-l border-zinc-200 pl-1">{workspace.agents.length ? workspace.agents.map(group => {
                      const groupKey = `${workspace.cwd}\0${group.agentId}`;
                      const agentCollapsed = collapsedAgentGroups.has(groupKey);
                      const agentDrag = itemDrag(`agents:${workspace.cwd}`, group.agentId, (from, to) => reorderAgents(workspace.cwd, from, to));
                      const agentBusy = group.sessions.some(session => busyStates.has(session.state));
                      return <div key={`${workspace.cwd}:${group.agentId}`} className="group/agent">
                        <div role="button" tabIndex={0} {...agentDrag.props} onClick={() => toggleAgentGroup(groupKey)} onKeyDown={event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); toggleAgentGroup(groupKey); } }} title={agentCollapsed ? L(`展开 ${group.agentName}（拖拽可换位）`, `Expand ${group.agentName} (Drag to reorder)`) : L(`收起 ${group.agentName}（拖拽可换位）`, `Collapse ${group.agentName} (Drag to reorder)`)} className={`flex h-7 w-full cursor-pointer items-center gap-1.5 rounded-lg px-2 text-left text-[12px] text-zinc-500 transition-[background-color,color,opacity] duration-150 hover:bg-zinc-100/70 hover:text-zinc-700 ${agentDrag.dragging ? 'opacity-40' : ''} ${agentDrag.over ? 'ring-1 ring-zinc-300' : ''}`}>
                          <ChevronRight size={11} className={`shrink-0 transition-transform duration-[220ms] ease-[cubic-bezier(.16,1,.3,1)] ${agentCollapsed ? '' : 'rotate-90'}`}/>
                          <AgentIcon agentId={group.agentId} agentName={group.agentName} size={14}/>
                          <span className="min-w-0 flex-1 truncate">{group.agentName}</span>
                          {agentBusy && !agentCollapsed && <span className="ui-status-pulse h-1.5 w-1.5 shrink-0 rounded-full bg-blue-500"/>}
                          <HoverTooltip content={L(`用 ${group.agentName} 在此工作区新建会话`, `New ${group.agentName} session in workspace`)} side="top">
                            <button type="button" aria-label={L(`用 ${group.agentName} 在此工作区新建会话`, `New ${group.agentName} session in workspace`)} disabled={Boolean(creatingPair)} onClick={event => { event.stopPropagation(); quickCreate.mutate({ agentId: group.agentId, cwd: workspace.cwd }); }} className="ui-press grid h-4 w-4 shrink-0 place-items-center rounded opacity-0 hover:bg-zinc-200 hover:text-zinc-800 focus:opacity-100 group-hover/agent:opacity-100 max-md:opacity-100 disabled:opacity-50">{creatingPair?.agentId === group.agentId && creatingPair.cwd === workspace.cwd ? <RefreshCw size={10} className="animate-spin"/> : <Plus size={10}/>}</button>
                          </HoverTooltip>
                          <GripVertical size={10} className="shrink-0 cursor-grab text-zinc-300 opacity-0 transition-opacity group-hover/agent:opacity-100"/>
                          <span className="shrink-0 tabular-nums">{group.sessions.length}</span>
                        </div>
                        <Disclosure open={!agentCollapsed}><div className="ml-1.5 border-l border-zinc-200 pl-1">{group.sessions.map(session => <div key={session.id}>
                          {renderSessionRow(session, itemDrag(`sessions:${groupKey}`, session.id, (from, to) => reorderSessions(groupKey, from, to), session.id), { showAgentIcon: shouldShowSessionRowAgentIcon('project', session.agentId, group.agentId) })}
                          {/* 侧边会话只出现一次：项目视图里跟在父会话下面，时间视图里按活跃时间平铺并带前缀图标。 */}
                          {(group.sideChats.get(session.id) ?? []).map(child => renderSessionRow(child, sessionDrag(child.id), { showAgentIcon: shouldShowSessionRowAgentIcon('project', child.agentId, group.agentId) }))}
                        </div>)}</div></Disclosure>
                      </div>;
                    }) : <div className="px-2 py-1.5 text-[12px] text-zinc-400">{L('还没有会话，点上面的 + 新建', 'No sessions yet — click + above to create one')}</div>}</div></Disclosure>
                  </div>;
                })}
            </div>
            : <div className="px-3 py-6 text-xs leading-5 text-zinc-500">
                {sidebarGroupingMode === 'project'
                  ? <div className="space-y-2"><p>{L('还没有导入项目。', 'No imported projects yet.')}</p><button type="button" onClick={() => openAppDialog('project-import')} className="inline-flex h-7 items-center gap-1.5 rounded-md border border-zinc-300 bg-white px-2.5 text-[12px] font-medium text-zinc-700 hover:bg-zinc-50"><FolderPlus size={12}/>{L('导入项目', 'Import Project')}</button></div>
                  : L('当前分类暂无会话。', 'No sessions in this view.')}
              </div>}
      </div>
      {/* 底部极简入口：直达统一设置中心 + 飞书与协同直达 + 浅/暗一键切换 + 手机扫码 */}
      <SettingsMenu
        webDenied={Boolean(webDenied)}
        larkConfig={larkConfig.data}
        onOpenSettings={() => { setSidebarOpen(false); openAppDialog('settings'); }}
        onOpenLark={() => { setSidebarOpen(false); openAppDialog('lark'); }}
        onShare={() => { setSidebarOpen(false); openAppDialog('share'); }}
      />
      </div>
      {/* 收起态细条（仅桌面）：展开 + 快捷新建 + 精简设置与飞书/工具入口 */}
      <div data-testid="collapsed-sidebar-strip" className={`hidden h-full w-full flex-col items-center gap-1 py-3 ${sidebarCollapsed ? 'md:flex' : ''}`}>
        <HoverTooltip content={L('展开会话列表', 'Expand sidebar')} side="right"><button type="button" onClick={() => setSidebarCollapsed(false)} aria-label={L('展开会话列表', 'Expand sidebar')} className="ui-press grid h-8 w-8 place-items-center rounded-lg text-zinc-600 hover:bg-white hover:text-zinc-900"><PanelLeftOpen size={16}/></button></HoverTooltip>
        <HoverTooltip content={L('新建对话', 'New Chat')} side="right"><button type="button" onClick={startNewConversation} aria-label={L('新建对话', 'New Chat')} className="ui-press grid h-8 w-8 place-items-center rounded-lg text-zinc-600 hover:bg-white hover:text-zinc-900"><Plus size={16}/></button></HoverTooltip>
        <HoverTooltip content={L('任务看板（⌘⇧B）', 'Task Board (⌘⇧B)')} side="right"><button type="button" onClick={() => openBoard()} aria-label={L('任务看板', 'Task Board')} aria-current={boardRoute.active ? 'page' : undefined} className={`ui-press grid h-8 w-8 place-items-center rounded-lg transition-colors ${boardRoute.active ? 'bg-zinc-900 text-white' : 'text-zinc-600 hover:bg-white hover:text-zinc-900'}`}><Columns3 size={16}/></button></HoverTooltip>
        <HoverTooltip content={L('搜索会话（⌘K）', 'Search Sessions (⌘K)')} side="right"><button type="button" onClick={openSearch} aria-label={L('搜索会话', 'Search Sessions')} className="ui-press grid h-8 w-8 place-items-center rounded-lg text-zinc-600 hover:bg-white hover:text-zinc-900"><Search size={16}/></button></HoverTooltip>
        <CompanionStripButton/>

        <span className="mt-auto flex flex-col items-center gap-1">
          <HoverTooltip content={t('settings.center.footer.usageTooltip')} side="right"><button type="button" onClick={() => openAppDialog('usage')} aria-label={t('settings.center.footer.usage')} className="ui-press grid h-8 w-8 place-items-center rounded-lg text-zinc-500 hover:bg-white hover:text-zinc-900"><BarChart3 size={15}/></button></HoverTooltip>
          <HoverTooltip content={archivedSessions.length > 0 ? t('settings.center.footer.archivedTooltip', { count: archivedSessions.length }) : L('归档会话（查看或恢复历史对话）', 'Archived Sessions (Browse or restore archived chats)')} side="right"><button type="button" onClick={() => openAppDialog('archived')} aria-label={L('归档会话', 'Archived Sessions')} className="ui-press grid h-8 w-8 place-items-center rounded-lg text-zinc-500 hover:bg-white hover:text-zinc-900"><Archive size={15}/></button></HoverTooltip>
          <LarkQuickTriggerButton compact side="right" larkConfig={larkConfig.data} onClick={() => openAppDialog('lark')} testId="collapsed-lark-trigger"/>
          <QuickThemeToggleButton compact side="right"/>
          <HoverTooltip content={t('settings.menu.tooltipDefault')} side="right"><button type="button" data-testid="collapsed-settings-trigger" aria-haspopup="dialog" onClick={() => openAppDialog('settings')} aria-label={L('打开设置中心', 'Open Settings Center')} className="ui-press grid h-8 w-8 place-items-center rounded-lg text-zinc-500 hover:bg-white hover:text-zinc-900"><Settings size={15}/></button></HoverTooltip>
          {pwa.visible && pwa.canPrompt && <HoverTooltip content={pwa.installing ? L('等待确认安装…', 'Waiting for install confirmation…') : L('安装为桌面应用（独立窗口运行 PWA）', 'Install as Desktop App (Standalone PWA window)')} side="right"><button type="button" disabled={pwa.installing} onClick={() => void triggerPwaInstall()} aria-label={L('安装为桌面应用', 'Install as Desktop App')} className="ui-press grid h-8 w-8 place-items-center rounded-lg text-zinc-500 hover:bg-white hover:text-zinc-900 disabled:opacity-50"><MonitorDown size={15}/></button></HoverTooltip>}
          <HoverTooltip content={t('settings.menu.shareTooltip')} side="right"><button type="button" onClick={() => openAppDialog('share')} aria-label={t('settings.menu.shareAria')} className="ui-press grid h-8 w-8 place-items-center rounded-lg text-zinc-500 hover:bg-white hover:text-zinc-900"><Smartphone size={15}/></button></HoverTooltip>
        </span>
      </div>
    </aside>
    <main className="flex min-w-0 flex-1 bg-canvas">
      {boardRoute.active ? (
        <div key="view-board" className="ui-view-enter flex min-w-0 flex-1">
          <BoardWorkspace
            routeBoardId={boardRoute.boardId}
            agents={agents.data ?? []}
            sessions={sortedSessions}
            tasks={assistantState.data?.tasks ?? []}
            draggingSidebarSessionId={dragItem?.sessionId}
            onClearSidebarDrag={() => { setDragItem(undefined); setDragOverItem(undefined); }}
            onBoardRouteChange={boardId => setBoardRoute(cur => (cur.active && cur.boardId === boardId ? cur : { active: true, boardId }))}
            onOpenFullSession={selectSession}
            onOpenSidebar={() => setSidebarOpen(true)}
          />
        </div>
      ) : primarySession ? <>
        {/* lg 以下右栏全屏覆盖主区（小屏不并排）；lg 以上并排、宽度可拖拽（PaneHost 负责）。 */}
        <div className={`flex min-w-0 flex-1 ${paneOpen ? 'max-lg:hidden' : ''}`}><SessionPane key={`primary:${primarySession.id}`} session={primarySession} agent={agents.data?.find(agent => agent.id === primarySession.agentId)} pane="primary" onOpenSidebar={() => setSidebarOpen(true)} paneOpen={paneOpen} onTogglePane={() => { setPaneMenuAnchor(undefined); togglePane(); }} btwEnabled={sideChatConfig.btwEnabled} btwTriggerPrefix={sideChatConfig.triggerPrefix} askUserQuestionXmlEnabled={askUserQuestionXmlEnabled} outputPluginItems={outputPluginsCatalog.plugins} outputPluginsGlobalConfig={outputPluginsCatalog.globalConfig} outputPluginRegistry={outputPluginsCatalog.registry} onSideChat={handleSessionSideChat}/></div>
        {(paneOpen || mountedTabs.length > 0) && <PaneHost tabs={tabs} mountedTabs={mountedTabs} activeTabId={activeTabId} visible={paneOpen} shortcuts={shortcuts} acceptsDrop={Boolean(dragItem?.sessionId)} onDropSession={() => { const dropped = dragItem?.sessionId; setDragItem(undefined); setDragOverItem(undefined); if (dropped) openSessionInPane(dropped); }} onActivate={activateTab} onClose={closeTab} onAdd={anchor => setPaneMenuAnchor(anchor)} onPick={openPaneKind} onHide={() => { setPaneMenuAnchor(undefined); togglePane(); }}>
          {Object.fromEntries(mountedTabs.map(tab => [tab.id,
            // 终端与文件锚定主会话；会话类标签用自己的 sessionId。三者都是廉价组件
            // （终端/文件只读会话的 cwd，不启进程），所以可以全部常驻挂载。
            tab.kind === 'terminal' ? <TerminalPanel key={tab.id} sessionId={tab.anchorSessionId ?? primarySession.id} sshHost={(sortedSessions.find(item => item.id === tab.anchorSessionId) ?? primarySession).sshHost}/>
            : tab.kind === 'files' ? <FileExplorerPanel key={tab.id} sessionId={tab.anchorSessionId ?? primarySession.id} cwd={sortedSessions.find(item => item.id === tab.anchorSessionId)?.cwd ?? primarySession.cwd} initialPath={tab.filePath} targetLine={tab.fileLine} targetEndLine={tab.fileEndLine} previewNonce={tab.filePreviewNonce} onClose={() => { setPaneMenuAnchor(undefined); togglePane(); }} disabledReason={(sortedSessions.find(item => item.id === tab.anchorSessionId) ?? primarySession).sshHost ? L(`SSH 远端会话（${(sortedSessions.find(item => item.id === tab.anchorSessionId) ?? primarySession).sshHost}）暂不支持文件浏览；终端面板可以直接连到远端。`, `File explorer is not yet supported for SSH remote sessions (${(sortedSessions.find(item => item.id === tab.anchorSessionId) ?? primarySession).sshHost}); use the Terminal panel to connect directly.`) : undefined}/>
            : tab.kind === 'raw' ? <RawLogPanel key={tab.id} sessionId={tab.anchorSessionId ?? primarySession.id} active={paneOpen && tab.id === activeTabId}/>
            : (() => { const session = sortedSessions.find(item => item.id === tab.sessionId); return session ? <SessionPane key={tab.id} session={session} agent={agents.data?.find(agent => agent.id === session.agentId)} pane="secondary" onOpenSidebar={() => setSidebarOpen(true)} onOpenRawLog={openRawLog} btwEnabled={sideChatConfig.btwEnabled} btwTriggerPrefix={sideChatConfig.triggerPrefix} askUserQuestionXmlEnabled={askUserQuestionXmlEnabled} outputPluginItems={outputPluginsCatalog.plugins} outputPluginsGlobalConfig={outputPluginsCatalog.globalConfig} outputPluginRegistry={outputPluginsCatalog.registry} onSideChat={handleSessionSideChat}/> : <div className="grid h-full place-items-center text-[12px] text-zinc-400">{L('会话已不存在。', 'Session no longer exists.')}</div>; })()
          ]))}
        </PaneHost>}
        {/* 副屏整个收起时它带着 hidden、收不到 dragover，所以拖拽期间单独在右缘补一个落点。
            只在拖拽进行中出现，不提前改 paneOpen，避免拖到一半放弃却把副屏留开。 */}
        {dragItem?.sessionId && !paneOpen && <div onDragOver={event => event.preventDefault()} onDrop={event => { event.preventDefault(); const dropped = dragItem?.sessionId; setDragItem(undefined); setDragOverItem(undefined); if (dropped) openSessionInPane(dropped); }} className="fixed inset-y-0 right-0 z-40 flex w-20 items-center justify-center border-l-2 border-dashed border-zinc-400 bg-zinc-900/5">
          <span className="text-[12px] font-medium text-zinc-600 [writing-mode:vertical-rl]">{L('放到这里，在副屏打开', 'Drop here to open in side pane')}</span>
        </div>}
      </> : <div className="ui-page relative flex flex-1 justify-center overflow-y-auto px-4 pt-[calc(3.25rem+env(safe-area-inset-top))] pb-[max(1.25rem,env(safe-area-inset-bottom))] sm:px-8 md:py-6"><span className="absolute left-[max(0.75rem,env(safe-area-inset-left))] top-[max(0.75rem,env(safe-area-inset-top))] z-10 md:hidden"><IconButton label={L('打开会话列表', 'Open sidebar')} onClick={() => setSidebarOpen(true)}><Menu size={17}/></IconButton></span><HomeStage editorRef={draftTextareaRef} agents={agents.data ?? []} sessions={sessions.data ?? []} askUserQuestionXmlEnabled={askUserQuestionXmlEnabled} outputPluginItems={outputPluginsCatalog.plugins} outputPluginsGlobalConfig={outputPluginsCatalog.globalConfig} onCreated={session => selectSession(session.id)}/></div>}
    </main>
    <ExitGate open={Boolean(paneMenuAnchor)} ms={150}>{paneMenuAnchor && <PaneTypeMenu anchor={paneMenuAnchor} shortcuts={shortcuts} onPick={openPaneKind} onClose={() => setPaneMenuAnchor(undefined)}/>}</ExitGate>
    {sessionMenu && (() => {
      const session = sortedSessions.find(item => item.id === sessionMenu.sessionId);
      if (!session) return null;
      return <SessionContextMenu
        session={session}
        agentName={agents.data?.find(agent => agent.id === session.agentId)?.name}
        point={sessionMenu.point}
        origin={window.location.origin}
        anchor={sessionMenu.anchor}
        onClose={() => setSessionMenu(undefined)}
        onRename={() => { setSessionMenu(undefined); setRenameRequest(current => ({ sessionId: session.id, nonce: (current?.nonce ?? 0) + 1 })); }}
        onArchive={() => { setSessionMenu(undefined); quickArchiveController.open(session.id); }}
        onTogglePin={() => { setSessionMenu(undefined); toggleSessionPin.mutate({ id: session.id, pinned: !session.pinnedAt }); }}
        onNotice={text => copyToast.show(text, 'success')}
      />;
    })()}
    {copyToast.toast}
    {actionError && <div className="fixed bottom-4 left-1/2 z-50 -translate-x-1/2 rounded-lg border border-red-200 bg-red-50 px-3.5 py-2 text-[12px] text-red-700 shadow-[0_12px_32px_rgba(24,24,27,.12)]"><button type="button" onClick={() => setActionError(undefined)} className="mr-2 font-medium underline">{t('common.close')}</button>{actionError}</div>}
    {/* 弹窗开关在 dialog-store 里：打开它们不会重渲染整棵会话树。 */}
    <DialogHost
      settingsCenter={target => (
        <SettingsCenterDialog
          initialCategory={target.category}
          initialSubTab={target.subTab}
          webDenied={Boolean(webDenied)}
          agents={agents.data ?? []}
          sessions={sortedSessions}
          {...(mainSessionId ? { mainSessionId } : {})}
          archivedCount={archivedSessions.length}
          outputPluginsEnabledCount={outputPluginsCatalog.enabledCount}
          outputPluginsTotalCount={outputPluginsCatalog.totalCount}
          taskRecoveryMode={taskRecoveryConfigQuery.data?.config.mode}
          onClose={closeAppDialog}
          onOpenSession={id => { closeAppDialog(); selectSession(id); }}
          onOpenMain={() => { closeAppDialog(); openMain(); }}
          onAdopt={() => { closeAppDialog(); goAdopt(); }}
          onOpenUsage={() => openAppDialog('usage')}
          onOpenArchived={() => openAppDialog('archived')}
          onOpenImport={() => openAppDialog('import')}
          onOpenShare={() => openAppDialog('share')}
        />
      )}
      dialogs={{
        usage: <UsageDashboardDialog agents={agents.data ?? []} onClose={closeAppDialog} onOpenSession={selectSession}/>,
        'session-output-plugins': sessionId => {
          const session = sessionId ? sortedSessions.find(item => item.id === sessionId) : undefined;
          return session ? (
            <SessionOutputPluginsDialog
              session={session}
              agent={agents.data?.find(item => item.id === session.agentId)}
              outputPluginItems={outputPluginsCatalog.plugins}
              outputPluginsGlobalConfig={outputPluginsCatalog.globalConfig}
              askUserQuestionXmlEnabled={askUserQuestionXmlEnabled}
              onClose={closeAppDialog}
              onOpenGlobalCenter={() => openAppDialog('output-plugins')}
            />
          ) : null;
        },
        schedule: sessionId => <ScheduleDialog {...(sessionId ? { session: sortedSessions.find(item => item.id === sessionId) } : {})} sessions={sortedSessions} {...(mainSessionId ? { mainSessionId } : {})} onClose={closeAppDialog} onOpenSession={selectSession}/>,
        handover: sessionId => {
          const session = sessionId ? sortedSessions.find(item => item.id === sessionId) : undefined;
          return session ? <HandoverDialog session={session} agent={agents.data?.find(item => item.id === session.agentId)} onClose={closeAppDialog}/> : null;
        },
        'system-prompt': sessionId => {
          const session = sessionId ? sortedSessions.find(item => item.id === sessionId) : undefined;
          return session?.systemPrompt ? <SystemPromptDialog session={session} onClose={closeAppDialog}/> : null;
        },
        share: <ShareAppDialog onClose={closeAppDialog}/>,
        archived: <ArchivedSessionsDialog sessions={archivedSessions} agents={agents.data ?? []} mainSessionId={mainSessionId} onClose={closeAppDialog} onOpenSession={id => { closeAppDialog(); selectSession(id); }}/>,
        import: <ImportSessionDialog agents={agents.data ?? []} onClose={closeAppDialog} onImported={session => selectSession(session.id)}/>,
        'project-import': <ImportProjectDialog onClose={closeAppDialog} onImported={(project, duplicate) => {
          closeAppDialog();
          setSidebarGrouping('project');
          setSidebarCollapsed(false);
          setSidebarOpen(false);
          // 重复导入不造第二条记录，用全局 toast 明确告诉用户点的是哪一个。
          if (duplicate) copyToast.show(L(`项目已存在：${project.cwd}`, `Project already exists: ${project.cwd}`), 'info');
        }}/>,
        search: <SessionSearchDialog agents={agents.data ?? []} sessions={sessions.data ?? []} onClose={closeAppDialog} onOpen={session => { closeAppDialog(); selectSession(session.id); }}/>
      }}
    />
    {(() => {
      const target = quickArchive.status === 'closed' ? undefined : sortedSessions.find(session => session.id === quickArchive.sessionId);
      const targetName = target ? sessionLabel(target, agents.data?.find(agent => agent.id === target.agentId)?.name) : L('该会话', 'this session');
      return <ConfirmDialog
        open={quickArchive.status !== 'closed'}
        tone="warning"
        title={L(`归档「${targetName}」？`, `Archive "${targetName}"?`)}
        description={L(
          '归档后，该会话会从会话列表移入「归档会话」，历史消息和执行记录都会保留，不会被删除。正在运行的会话会先停止。之后可在侧栏设置里的「归档会话」中找回并查看。',
          'Archiving moves this session into Archived Sessions without deleting its message history or logs. Any running task will be stopped first. You can restore it anytime from Settings → Archived Sessions.'
        )}
        confirmLabel={L('确认归档', 'Archive')}
        busy={quickArchive.status === 'archiving'}
        error={quickArchive.status === 'error' ? quickArchive.message : undefined}
        onCancel={() => quickArchiveController.cancel()}
        onConfirm={() => void quickArchiveController.confirm()}
      />;
    })()}
    <ExitGate open={Boolean(agentPicker)} ms={150}>{agentPicker && <AgentPickerMenu cwd={agentPicker.cwd} top={agentPicker.top} left={agentPicker.left} agents={agents.data ?? []} creatingPair={creatingPair} onSelect={agentId => quickCreate.mutate({ agentId, cwd: agentPicker.cwd })} onClose={() => setAgentPicker(null)}/>}</ExitGate>
    <CompanionLayer view={companionView}/>
  </div></CompanionNavProvider></TooltipProvider>;
}
