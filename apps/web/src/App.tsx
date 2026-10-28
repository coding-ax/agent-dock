import { LarkRegistrationDialog } from './LarkRegistrationDialog';
import { SuggestedValueInput } from './SuggestedValueInput';
import { WebBaseUrlInput } from './WebBaseUrlInput';
import { KeyboardEvent, lazy, Suspense, useEffect, useMemo, useRef, useState, type DragEvent, type HTMLAttributes } from 'react';
import { useMount, useEventListener, useUpdateEffect, useLocalStorageState, useMemoizedFn } from 'ahooks';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlarmClock, AlertTriangle, Archive, Bot, Check, ChevronDown, ChevronRight, ExternalLink, Eye, EyeOff, Folder, FolderOpen, GripVertical, History, Layers3, LoaderCircle, Menu, MessageSquare, PanelLeftOpen, Plus, RefreshCw, Search, RotateCcw, Settings2, Trash2, Wrench, X } from 'lucide-react';
import { Input, InputNumber, Select, Switch } from 'antd';
import { defaultLarkTraceLimit, validateHighRiskPattern } from '@agent-dock/agent-dock-shared';
import { api, WebAccessDeniedError, type Agent, type Session } from './api';
import { canSaveHardGate, canToggleHardGate, resolveReasoningEffort, withSavedOption } from './lark-config-form';
import { useDockStore, type PaneTabKind } from './store';
import { PaneHost } from './PaneHost';
import { AgentIcon, BotAvatar } from './AgentIcon';
import { PaneTypeMenu } from './PaneTypeMenu';
import { shortcutLabel, useShortcuts, type Shortcut } from './useShortcuts';
import { buildSideSessionSeed } from './side-session';
import { sideChatSource } from './side-chat-link';
import { ScheduleDialog } from './ScheduleDialog';
import { isScheduledSession } from './schedule-view';
import { ArchivedSessionsDialog } from './ArchivedSessionsDialog';
import { parseRightParam, sessionUrl } from './session-url';
import { useVisualViewportShell } from './useVisualViewportShell';
import { useDismissOnOutsidePointer } from './useDismissOnOutsidePointer';
import { CompactSelect, type CompactOption } from './CompactSelect';
import { SessionFilterSelect } from './SessionFilterSelect';
import { SessionTitleEditor } from './SessionTitleEditor';
import { useSyncFormFromRemote } from './useSyncFormFromRemote';
import { agentModelsQueryKey, loadAgentModels, readCachedAgentModels } from './model-cache';
import { groupSessions, recentSessions, sameSessionTree, sessionActivityTime, sessionLabel } from './session-groups';
import { sessionPaneTab } from './pane-tab';
import { useDocumentTitle } from './useDocumentTitle';
import { DEFAULT_SECTION_ORDER, normalizeSectionOrder, reorderSections, type SidebarSectionKey } from './sidebar-sections';
import { EMPTY_ITEM_ORDER, applyOrder, moveInList, normalizeItemOrder, type SidebarItemOrder } from './sidebar-order';
import { DraftComposer } from './DraftComposer';
import { SessionSearchDialog } from './SessionSearchDialog';
import { WebAccessDeniedPanel, shouldCancelOnAccessDenied } from './WebAccessDeniedPanel';
import { AgentConfigDialog } from './AgentConfigDialog';
import { ImportSessionDialog } from './ImportSessionDialog';
import { SelfUpdateNotice } from './SelfUpdateNotice';
import { SessionPane } from './SessionPane';
import { TerminalPanel } from './TerminalPanel';
import { FileExplorerPanel } from './FileExplorerPanel';
import { RawLogPanel } from './RawLogPanel';
import { busyStates, stateLabels, stateTextTone, stateTone } from './session-states';
import { ConfirmDialog, IconButton } from './ui-controls';
import { HoverTooltip, HoverTooltipText, TooltipProvider } from './HoverTooltip';
import { SessionHoverCard } from './SessionHoverCard';

const PromptEditor = lazy(() => import('./PromptEditor'));

const parseMemberNames = (value: string) => [...new Set(value.split(/[\n,，]/).map(item => item.trim()).filter(Boolean))];

function AgentDockIcon({ className = '' }: { className?: string }) {
  return <img src="/agent-dock.svg" alt="" aria-hidden="true" className={className}/>;
}

/** 工作区行「+」弹出的 agent 快速选择菜单；fixed 定位避免被列表的 overflow 裁切。 */
function AgentPickerMenu({ cwd, top, left, agents, creatingPair, onSelect, onClose }: { cwd: string; top: number; left: number; agents: Agent[]; creatingPair?: { agentId: string; cwd: string }; onSelect(agentId: string): void; onClose(): void }) {
  const root = useRef<HTMLDivElement>(null);
  useDismissOnOutsidePointer(root, true, onClose);
  return <div ref={root} className="ui-popover fixed z-50 max-h-64 w-52 overflow-y-auto rounded-lg border border-zinc-200 bg-white p-1 shadow-[0_16px_40px_rgba(24,24,27,.16)]" style={{ top, left }}>
    <div className="px-2 py-1 text-[10px] text-zinc-400">在此工作区新建会话</div>
    {agents.length === 0 && <div className="px-2 py-2 text-[11px] text-zinc-400">暂无可用 Agent</div>}
    {agents.map(agent => {
      const busy = creatingPair?.agentId === agent.id && creatingPair.cwd === cwd;
      return <button key={agent.id} type="button" disabled={Boolean(creatingPair)} onClick={() => onSelect(agent.id)} className="flex h-8 w-full items-center gap-2 rounded-md px-2 text-left text-[12px] text-zinc-700 hover:bg-zinc-100 disabled:opacity-50">
        {busy ? <RefreshCw size={13} className="shrink-0 animate-spin text-zinc-500"/> : <AgentIcon agentId={agent.id} agentName={agent.name} size={14}/>}
        <span className="min-w-0 flex-1 truncate">{agent.name}</span>
      </button>;
    })}
  </div>;
}

function InlineSelect({ options, value, onChange }: { options: CompactOption[]; value: string; onChange(value: string): void }) {
  return <Select className="ml-auto shrink-0" size="small" popupMatchSelectWidth={false} value={value} onChange={onChange} options={options.map(option => ({ value: option.value, label: option.label }))}/>;
}

function AgentSelect({ agents, value, disabled, onChange }: { agents: Agent[]; value: string; disabled?: boolean; onChange(value: string): void }) {
  return <CompactSelect options={agents.map(agent => ({ value: agent.id, label: agent.name, meta: agent.version, agentId: agent.id }))} value={value} placeholder="选择 Agent" disabledText="未扫描到可用 Agent" disabled={disabled} onChange={onChange}/>;
}

function MemberNameTagInput({ value, placeholder, onChange }: { value: string[]; placeholder: string; onChange(value: string[]): void }) {
  const [draft, setDraft] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  const commit = (raw = draft) => {
    const additions = parseMemberNames(raw);
    if (additions.length) onChange([...new Set([...value, ...additions])]);
    setDraft('');
  };
  const remove = (name: string) => onChange(value.filter(item => item !== name));
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.nativeEvent.isComposing) return;
    if (event.key === 'Enter' || event.key === ',' || event.key === '，') { event.preventDefault(); commit(); }
    else if (event.key === 'Backspace' && !draft && value.length) remove(value[value.length - 1]!);
  };
  return <div role="group" aria-label="成员真实姓名" onClick={() => inputRef.current?.focus()} className="mt-2 flex min-h-11 cursor-text flex-wrap items-center gap-x-2 gap-y-2 rounded-lg border border-zinc-300 bg-zinc-50/70 p-2 ui-field-within focus-within:bg-white">
    {value.map(item => <span key={item} title={item} className="flex h-7 max-w-full items-center rounded-md border border-zinc-200 bg-white pl-2.5 pr-1 text-[11px] font-medium text-zinc-700 shadow-[0_1px_1px_rgba(24,24,27,.04)]">
      <span className="min-w-0 truncate">{item}</span>
      <button type="button" aria-label={`移除 ${item}`} onPointerDown={event => event.preventDefault()} onClick={() => remove(item)} className="ml-1.5 grid h-5 w-5 shrink-0 place-items-center rounded text-zinc-400 transition-colors hover:bg-zinc-100 hover:text-zinc-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-zinc-300"><X size={11}/></button>
    </span>)}
    <input ref={inputRef} aria-label="输入成员真实姓名" value={draft} onChange={event => setDraft(event.target.value)} onKeyDown={onKeyDown} onBlur={() => commit()} onPaste={event => { const text = event.clipboardData.getData('text'); if (/[\n,，]/.test(text)) { event.preventDefault(); commit(`${draft}\n${text}`); } }} placeholder={value.length ? '继续添加成员…' : placeholder} className="h-7 min-w-36 flex-[1_0_9rem] border-0 bg-transparent px-1 text-[12px] text-zinc-800 outline-none placeholder:text-zinc-400"/>
  </div>;
}

function LarkConfigModal({ agents, onClose }: { agents: Agent[]; onClose(): void }) {
  const [registrationOpen, setRegistrationOpen] = useState(false);
  const qc = useQueryClient();
  const config = useQuery({ queryKey: ['lark-config'], queryFn: api.larkConfig });
  const capabilities = useQuery({ queryKey: ['system-capabilities'], queryFn: api.systemCapabilities });
  const [confirmation, setConfirmation] = useState<'incomplete' | 'discard' | 'delete'>();
  const hydratedSelection = useRef<string | null>(null);
  const [selectedAppId, setSelectedAppId] = useState<string | null>(null); const [step, setStep] = useState<1 | 2>(1); const [name, setName] = useState(''); const [workspace, setWorkspace] = useState(''); const [webBaseUrl, setWebBaseUrl] = useState(''); const [appId, setAppId] = useState(''); const [appSecret, setAppSecret] = useState(''); const [restrictUsers, setRestrictUsers] = useState(false); const [allowedUserNames, setAllowedUserNames] = useState<string[]>([]); const [allowedBotNames, setAllowedBotNames] = useState<string[]>([]); const [peerBotsAllowed, setPeerBotsAllowed] = useState(true); const [defaultAgentId, setDefaultAgentId] = useState(''); const [defaultModel, setDefaultModel] = useState(''); const [defaultReasoningEffort, setDefaultReasoningEffort] = useState(''); const [preInjectPrompt, setPreInjectPrompt] = useState(''); const [groupToolsEnabled, setGroupToolsEnabled] = useState(false); const [groupToolsAllowSend, setGroupToolsAllowSend] = useState(false); const [groupSessionScope, setGroupSessionScope] = useState<'user' | 'chat'>('user'); const [highRiskAllowedUserNames, setHighRiskAllowedUserNames] = useState<string[]>([]); const [highRiskPattern, setHighRiskPattern] = useState(''); const [gateEnabled, setGateEnabled] = useState(false); const [hardGateEnabled, setHardGateEnabled] = useState(false); const [hookTrustConfirmed, setHookTrustConfirmed] = useState(false); const [showSecret, setShowSecret] = useState(false); const [listening, setListening] = useState(false); const [pushIntervalMs, setPushIntervalMs] = useState(1000); const [traceLimit, setTraceLimit] = useState(String(defaultLarkTraceLimit)); const [quietReply, setQuietReply] = useState(false);
  const current = config.data?.bots.find(bot => bot.appId === selectedAppId);
  const defaultWorkspace = agents.find(agent => agent.id === defaultAgentId)?.cwd || capabilities.data?.workingDirectory;
  const agentSelectionSaved = Boolean(current?.setupComplete && current.defaultAgentId === defaultAgentId);
  const defaultAgentLocked = Boolean(hardGateEnabled || current?.hardGateEnabled);
  const highRiskPatternValidation = useMemo(() => validateHighRiskPattern(highRiskPattern), [highRiskPattern]);
  const hookStatus = useQuery({ queryKey: ['lark-hook-status', current?.appId, defaultAgentId], queryFn: () => api.larkHookStatus(current!.appId), enabled: Boolean(agentSelectionSaved && gateEnabled && step === 2) });
  const agentOptions = useQuery({ queryKey: agentModelsQueryKey(defaultAgentId, defaultModel), queryFn: () => loadAgentModels(defaultAgentId, defaultModel || undefined), enabled: Boolean(defaultAgentId), initialData: () => readCachedAgentModels(defaultAgentId, defaultModel || undefined), initialDataUpdatedAt: 0, refetchOnMount: 'always', staleTime: 5 * 60_000 });
  const refreshAgentOptions = useMutation({
    mutationFn: (input: { agentId: string; model?: string }) => loadAgentModels(input.agentId, input.model, true),
    onSuccess: (data, input) => qc.setQueryData(agentModelsQueryKey(input.agentId, input.model), data)
  });
  const hardGateFormState = { enabled: hardGateEnabled, persisted: Boolean(current?.hardGateEnabled), agentSelectionSaved, hookInstalled: Boolean(hookStatus.data?.installed) };
  const hardGateReadyToSave = canSaveHardGate(hardGateFormState);
  const hardGateCanToggle = canToggleHardGate(hardGateFormState);
  const hardGateHookMissing = Boolean(hardGateEnabled && current?.hardGateEnabled && hookStatus.isSuccess && !hookStatus.data.installed);
  const legacyHighRiskNeedsMigration = Boolean(gateEnabled && current?.highRiskAllowedEmails.length && !highRiskAllowedUserNames.length);
  // 换 Agent / 换模型后，旧的推理强度可能已不在新列表里。这是可以在渲染期算出来的派生值，
  // 不该用 Effect 去「事后纠正」state——那会多渲染一帧，并让 state 短暂处于非法值。
  const effectiveDefaultReasoningEffort = resolveReasoningEffort(defaultReasoningEffort, agentOptions.data?.warning ? undefined : agentOptions.data, agentOptions.isFetching);
  // 配置拉回来后选中第一个机器人。用具名 hook 把「远端数据 → 本地表单」的
  // 一次性灌入意图写清楚，而不是散落的裸 useEffect。
  useSyncFormFromRemote(config.data, () => {
    if (selectedAppId !== null) return;
    const firstBot = config.data!.bots[0];
    setSelectedAppId(firstBot?.appId ?? '');
    setStep(firstBot && !firstBot.setupComplete ? 2 : 1);
  });
  // source 必须能区分「未初始化」和「新增机器人」：后者 selectedAppId 是空串，
  // 用 config.data && selectedAppId 会得到 '' 而被 truthy 判定挡掉，
  // 表单就不会切到新建态、残留上一个机器人的值。
  useSyncFormFromRemote(config.data && selectedAppId !== null ? selectedAppId : null, () => {
    if (selectedAppId === null) return;
    if (hydratedSelection.current === selectedAppId) return;
    hydratedSelection.current = selectedAppId;
    const bot = config.data!.bots.find(item => item.appId === selectedAppId);
    setName(bot?.name ?? ''); setWorkspace(bot?.workspace ?? ''); setWebBaseUrl(bot?.webBaseUrl ?? ''); setAppId(bot?.appId ?? ''); setAppSecret(''); setRestrictUsers(Boolean(bot?.allowedUsers.length || bot?.allowedEmails.length || bot?.allowedUserNames?.length)); setAllowedUserNames(bot?.allowedUserNames?.length ? bot.allowedUserNames : (bot?.allowedUsers ?? []).map(user => user.name)); setAllowedBotNames(bot?.allowedBotNames?.length ? bot.allowedBotNames : (bot?.allowedBots ?? []).map(b => b.name)); setPeerBotsAllowed(bot?.peerBotsAllowed !== false);
    setDefaultAgentId(agents.some(agent => agent.id === bot?.defaultAgentId) ? bot?.defaultAgentId ?? '' : agents[0]?.id ?? '');
    setDefaultModel(bot?.defaultModel ?? ''); setDefaultReasoningEffort(bot?.defaultReasoningEffort ?? ''); setListening(bot?.listening ?? false); setPushIntervalMs(bot?.pushIntervalMs ?? 1000); setTraceLimit((bot?.traceLimit ?? defaultLarkTraceLimit).toString()); setQuietReply(bot?.quietReply ?? false);
    setPreInjectPrompt(bot?.preInjectPrompt ?? ''); setGroupToolsEnabled(bot?.groupToolsEnabled ?? false); setGroupToolsAllowSend(bot?.groupToolsAllowSend ?? false); setGroupSessionScope(bot?.groupSessionScope ?? 'user'); setHighRiskAllowedUserNames(bot?.highRiskAllowedUserNames?.length ? bot.highRiskAllowedUserNames : (bot?.highRiskAllowedUsers ?? []).map(user => user.name)); setHighRiskPattern(bot?.highRiskPattern ?? ''); setGateEnabled(bot?.gateEnabled ?? false); setHardGateEnabled(bot?.hardGateEnabled ?? false); setHookTrustConfirmed(bot?.hookTrustConfirmed ?? false);
  });
  const inspect = useMutation({ mutationFn: () => api.inspectLarkBot({ appId: appId.trim(), appSecret: appSecret.trim() }), onSuccess: result => setName(result.appName) });
  const save = useMutation({
    mutationFn: () => step === 1
      ? api.saveLarkConfig({ stage: 'lark', ...(current ? { originalAppId: current.appId } : {}), appId: appId.trim(), ...(appSecret.trim() ? { appSecret: appSecret.trim() } : {}), workspace: workspace.trim(), webBaseUrl: webBaseUrl.trim(), allowedUserNames: restrictUsers ? allowedUserNames : [], allowedEmails: [], allowedBotNames: peerBotsAllowed ? [] : allowedBotNames, peerBotsAllowed, listening, pushIntervalMs, traceLimit: Number(traceLimit), quietReply })
      : api.saveLarkConfig({ stage: 'agent', originalAppId: current!.appId, defaultAgentId, defaultModel, defaultReasoningEffort: effectiveDefaultReasoningEffort, preInjectPrompt, groupToolsEnabled, groupToolsAllowSend, groupSessionScope, highRiskAllowedUserNames, highRiskAllowedEmails: [], highRiskPattern, gateEnabled, softGateEnabled: gateEnabled, hardGateEnabled, hookTrustConfirmed }),
    onSuccess: data => { qc.setQueryData(['lark-config'], data); const savedId = appId.trim(); setSelectedAppId(savedId); setAppSecret(''); void qc.invalidateQueries({ queryKey: ['lark-hook-status', savedId] }); if (step === 1) setStep(2); else onClose(); }
  });
  const installHook = useMutation({
    mutationFn: async () => {
      const saved = await api.saveLarkConfig({ stage: 'agent', originalAppId: current!.appId, defaultAgentId, defaultModel, defaultReasoningEffort: effectiveDefaultReasoningEffort, preInjectPrompt, listening, groupToolsEnabled, groupToolsAllowSend, groupSessionScope, highRiskAllowedUserNames, highRiskAllowedEmails: [], highRiskPattern, gateEnabled: true, softGateEnabled: true, hardGateEnabled: false, hookTrustConfirmed: false });
      qc.setQueryData(['lark-config'], saved);
      return api.installLarkHook(current!.appId, highRiskPattern);
    },
    onSuccess: result => { qc.setQueryData(['lark-hook-status', current!.appId, defaultAgentId], result); setGateEnabled(true); setHardGateEnabled(false); setHookTrustConfirmed(true); void qc.invalidateQueries({ queryKey: ['lark-config'] }); }
  });
  const remove = useMutation({ mutationFn: () => api.deleteLarkConfig(current!.appId), onSuccess: data => { qc.setQueryData(['lark-config'], data); const firstBot = data.bots[0]; setSelectedAppId(firstBot?.appId ?? ''); setStep(firstBot && !firstBot.setupComplete ? 2 : 1); setConfirmation(undefined); } });
  const pickWorkspace = useMutation({ mutationFn: api.selectDirectory, onSuccess: result => setWorkspace(result.path) });
  const agentCapabilitiesPending = step === 2 && Boolean(defaultAgentId) && !agentOptions.data && (agentOptions.isLoading || agentOptions.isFetching);
  const agentCapabilitiesReady = step !== 2 || Boolean(agentOptions.data);
  const canSave = step === 1
    ? Boolean(appId.trim() && (current || appSecret.trim()) && (!restrictUsers || allowedUserNames.length) && (peerBotsAllowed || allowedBotNames.length) && (quietReply || (Number.isInteger(pushIntervalMs) && pushIntervalMs >= 500 && pushIntervalMs <= 20000)))
    : Boolean(current && defaultAgentId && agentCapabilitiesReady && (!gateEnabled || highRiskPatternValidation.valid) && !legacyHighRiskNeedsMigration && hardGateReadyToSave);
  const larkCredentialsReady = Boolean(current || (appId.trim() && appSecret.trim()));
  const formError = refreshAgentOptions.error ?? save.error ?? remove.error ?? pickWorkspace.error ?? inspect.error ?? installHook.error ?? (agentOptions.data ? undefined : agentOptions.error) ?? config.error;
  const permissionSettingsUrl = /^cli_[\w-]+$/.test(appId.trim()) ? `https://open.larkoffice.com/app/${encodeURIComponent(appId.trim())}/auth` : undefined;
  const permissionRelatedError = Boolean(formError && /权限|permission|通讯录|邮箱|open[_ ]?id|资源点|visible range/i.test(formError.message));
  const requestClose = () => {
    const incompleteDraft = Boolean(current && !current.setupComplete);
    const unsavedNewBot = !current && selectedAppId === '' && Boolean(appId.trim() || appSecret.trim() || workspace.trim());
    if (incompleteDraft || unsavedNewBot) { setConfirmation(incompleteDraft ? 'incomplete' : 'discard'); return; }
    onClose();
  };
  return <>{registrationOpen && <LarkRegistrationDialog onClose={() => { setRegistrationOpen(false); void qc.invalidateQueries({ queryKey: ['lark-config'] }); }} onComplete={result => {
    qc.setQueryData(['lark-config'], result.config);
    setSelectedAppId(result.appId);
    setStep(1);
    setRegistrationOpen(false);
  }}/>}<div inert={registrationOpen} aria-hidden={registrationOpen || undefined} className="ui-overlay fixed inset-0 z-30 grid place-items-center bg-zinc-950/25 p-4 backdrop-blur-[2px]" onMouseDown={event => { if (event.currentTarget === event.target) requestClose(); }}>
    <form onSubmit={event => { event.preventDefault(); if (canSave) save.mutate(); }} className="ui-dialog flex max-h-[calc(100dvh-2rem)] w-full max-w-[640px] flex-col overflow-hidden rounded-xl border border-zinc-200 bg-white shadow-[0_20px_64px_rgba(24,24,27,.18)]">
      <div className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-y-2 border-b border-zinc-100 px-4 py-3"><div className="min-w-0"><h2 className="text-[14px] font-semibold text-zinc-900">飞书机器人</h2><p className="mt-0.5 truncate text-[11px] text-zinc-500">每个机器人拥有独立工作区和会话</p></div><div className="col-span-2 row-start-2 flex min-w-0 flex-wrap items-center justify-end gap-0.5"><a href="https://open.larkoffice.com/app" target="_blank" rel="noreferrer" className="flex h-8 items-center gap-1.5 whitespace-nowrap rounded-lg px-2.5 text-[11px] font-medium text-zinc-500 transition-colors hover:bg-zinc-100 hover:text-zinc-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-zinc-400/50">飞书开发者后台<ExternalLink size={12}/></a><a href="https://open.larkoffice.com/page/launcher?from=backend_oneclick" target="_blank" rel="noreferrer" className="flex h-8 items-center gap-1.5 whitespace-nowrap rounded-lg px-2.5 text-[11px] font-medium text-zinc-600 transition-colors hover:bg-zinc-100 hover:text-zinc-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-zinc-400/50">快速创建机器人<ExternalLink size={12}/></a><button type="button" onClick={() => setRegistrationOpen(true)} disabled={!config.data || save.isPending} className="flex h-8 items-center gap-1.5 whitespace-nowrap rounded-lg px-2.5 text-[11px] font-medium text-zinc-700 transition-colors hover:bg-zinc-100 disabled:opacity-40">扫码创建机器人<Plus size={12}/></button></div><span className="col-start-2 row-start-1 ml-1"><IconButton label="关闭" onClick={requestClose}><X size={15}/></IconButton></span></div>
      <div className="flex shrink-0 gap-1 overflow-x-auto border-b border-zinc-100 bg-zinc-50/70 px-3 py-2">
        {config.data?.bots.map(bot => <button key={bot.appId} type="button" onClick={() => { setSelectedAppId(bot.appId); setStep(bot.setupComplete ? 1 : 2); }} className={`flex h-8 max-w-[250px] shrink-0 items-center gap-1.5 rounded-lg px-2.5 text-[11px] font-medium transition-colors ${selectedAppId === bot.appId ? 'bg-white text-zinc-900 shadow-sm ring-1 ring-zinc-200' : 'text-zinc-500 hover:bg-white/70 hover:text-zinc-800'}`}>{bot.avatarUrl ? <BotAvatar url={bot.avatarUrl} size={13} className="h-[13px] w-[13px] shrink-0 rounded-sm object-cover"/> : <Bot size={13} className="shrink-0"/>}<span title={bot.name} className="min-w-0 max-w-32 truncate">{bot.tabLabel}</span>{bot.setupComplete ? <span title="配置完成" className="flex shrink-0 items-center gap-0.5 rounded bg-emerald-50 px-1 py-0.5 text-[9px] font-medium text-emerald-700"><Check size={9}/>已配置</span> : <span className="shrink-0 rounded bg-amber-100 px-1 py-0.5 text-[9px] text-amber-700">待配置</span>}{bot.activeListening && <span title="长连接已连接" className="h-1.5 w-1.5 shrink-0 rounded-full bg-emerald-500"/>}</button>)}
        <button type="button" onClick={() => { setSelectedAppId(''); setStep(1); }} className={`flex h-8 shrink-0 items-center gap-1 rounded-lg px-2.5 text-[11px] font-medium ${selectedAppId === '' ? 'bg-white text-zinc-900 shadow-sm ring-1 ring-zinc-200' : 'text-zinc-500 hover:bg-white/70 hover:text-zinc-800'}`}><Plus size={13}/>新增机器人</button>
      </div>
      <div className="space-y-3.5 overflow-y-auto px-4 py-4">
        {config.isLoading ? <div className="space-y-2.5"><div className="h-9 animate-pulse rounded-md bg-zinc-100"/><div className="h-9 animate-pulse rounded-md bg-zinc-100"/><div className="h-9 animate-pulse rounded-md bg-zinc-100"/></div> : <>
          <div className="mb-1 grid grid-cols-2 rounded-lg bg-zinc-100 p-1"><button type="button" onClick={() => setStep(1)} className={`rounded-md px-3 py-2 text-[11px] font-medium transition-colors ${step === 1 ? 'bg-white text-zinc-900 shadow-sm' : 'text-zinc-500'}`}><span className="mr-1.5 inline-grid h-4 w-4 place-items-center rounded-full bg-zinc-900 text-[9px] text-white">1</span>飞书与白名单</button><button type="button" disabled={!current} onClick={() => { if (step === 1 && canSave) save.mutate(); else if (step !== 2) setStep(2); }} className={`rounded-md px-3 py-2 text-[11px] font-medium transition-colors disabled:opacity-40 ${step === 2 ? 'bg-white text-zinc-900 shadow-sm' : 'text-zinc-500'}`}><span className="mr-1.5 inline-grid h-4 w-4 place-items-center rounded-full bg-zinc-900 text-[9px] text-white">2</span>Agent 与门禁</button></div>
          <p className="-mt-1 text-[10px] leading-4 text-zinc-400">{step === 1 ? '先保存机器人配置；指定成员和机器人的姓名在实际使用时再校验。' : 'Agent 配置不影响长连接；收到消息时才会校验运行配置。'}</p>
          {step === 1 ? <>
          <div className="grid gap-3 sm:grid-cols-2"><label className="block"><span className="text-[11px] font-medium text-zinc-700">机器人名称</span><Input size="large" value={name} readOnly variant="filled" placeholder="校验凭证后自动识别" className="mt-1.5 font-mono text-[12px]"/></label><label className="block"><span className="text-[11px] font-medium text-zinc-700">App ID</span><Input size="large" value={appId} onChange={event => { setAppId(event.target.value); setName(''); }} placeholder="cli_xxx" autoComplete="off" className="mt-1.5 font-mono text-[12px]"/></label></div>
          <label className="block"><span className="flex items-center text-[11px] font-medium text-zinc-700">App Secret{current && <span className="ml-2 font-normal text-zinc-400">留空不修改</span>}</span><Input.Password size="large" value={appSecret} onChange={event => setAppSecret(event.target.value)} visibilityToggle={{ visible: showSecret, onVisibleChange: setShowSecret }} iconRender={visible => visible ? <EyeOff size={13}/> : <Eye size={13}/>} placeholder={current ? '已保存' : '输入 App Secret'} autoComplete="new-password" className="mt-1.5 font-mono text-[12px]"/></label>
          <div><span className="text-[11px] font-medium text-zinc-700">工作区 <span className="font-normal text-zinc-400">可选</span></span><div className="flex items-start gap-2"><div className="min-w-0 flex-1"><SuggestedValueInput value={workspace} onChange={setWorkspace} label="工作区" placeholder="留空使用默认工作目录" suggestion={defaultWorkspace} suggestionLabel="使用默认工作目录"/></div><button type="button" disabled={!capabilities.data?.directoryPicker || pickWorkspace.isPending} onClick={() => pickWorkspace.mutate()} className="mt-1.5 flex h-9 shrink-0 items-center gap-1.5 rounded-md border border-zinc-300 bg-white px-3 text-[11px] font-medium text-zinc-700 hover:bg-zinc-50 disabled:cursor-not-allowed disabled:opacity-40"><FolderOpen size={13}/>{capabilities.data?.directoryPicker ? '选择' : '仅支持 Mac'}</button></div><p className="mt-1 text-[10px] leading-4 text-zinc-400">留空时使用所选 Agent 的默认工作目录；路径位于 AgentDock 服务所在机器。</p></div>
          <div className="block"><span className="text-[11px] font-medium text-zinc-700">Web 访问地址 <span className="font-normal text-zinc-400">可选</span></span><WebBaseUrlInput value={webBaseUrl} onChange={setWebBaseUrl}/><p className="mt-1 text-[10px] leading-4 text-zinc-400">配置后，飞书卡片底部会显示“查看详情”链接，指向该域名下的会话 Trace 页面。</p></div>
          {!current && <button type="button" disabled={!appId.trim() || !appSecret.trim() || inspect.isPending} onClick={() => inspect.mutate()} className="flex h-9 w-full items-center justify-center gap-2 rounded-md border border-zinc-300 bg-white text-[11px] font-medium text-zinc-700 hover:bg-zinc-50 disabled:opacity-40">{inspect.isPending ? <RefreshCw size={12} className="animate-spin"/> : <Bot size={12}/>}校验凭证并识别机器人名称</button>}
          <div className="border-t border-zinc-100 pt-3.5">
            <div className="flex items-start justify-between gap-3"><div><div className="text-[11px] font-medium text-zinc-700">可使用机器人的成员</div><p className="mt-0.5 text-[10px] leading-4 text-zinc-400">输入飞书真实姓名；收到消息时再解析为稳定的 open_id，不读取邮箱。</p></div><div className="flex shrink-0 rounded-md bg-zinc-100 p-0.5"><button type="button" onClick={() => setRestrictUsers(false)} className={`h-7 rounded px-2 text-[10px] font-medium ${!restrictUsers ? 'bg-white text-zinc-900 shadow-sm' : 'text-zinc-500'}`}>所有人</button><button type="button" onClick={() => setRestrictUsers(true)} className={`h-7 rounded px-2 text-[10px] font-medium ${restrictUsers ? 'bg-white text-zinc-900 shadow-sm' : 'text-zinc-500'}`}>指定成员</button></div></div>
            {restrictUsers && <div className="mt-3 space-y-2.5">
              {Boolean(current?.allowedEmails.length && !current.allowedUsers.length) && <div className="border-l-2 border-amber-400 bg-amber-50 px-2.5 py-2 text-[10px] leading-4 text-amber-800">检测到旧邮箱白名单。请重新填写真实姓名；保存后改用姓名白名单，使用时解析 open_id，停止查询通讯录。</div>}
              <div><div className="text-[10px] font-medium text-zinc-500">成员真实姓名</div><MemberNameTagInput value={allowedUserNames} onChange={setAllowedUserNames} placeholder="输入姓名后按 Enter"/><p className="mt-1 text-[10px] leading-4 text-zinc-400">支持 Enter、逗号或粘贴多行生成标签。保存时不查询群成员；使用时精确匹配，找不到或重名时拒绝访问。</p></div>
            </div>}
          </div>
          <div className="border-t border-zinc-100 pt-3.5">
            <div className="flex items-start justify-between gap-3"><div><div className="text-[11px] font-medium text-zinc-700">可调用机器人的其他机器人</div><p className="mt-0.5 text-[10px] leading-4 text-zinc-400">输入机器人名称；收到调用时再在群成员中解析 open_id。</p></div><div className="flex shrink-0 rounded-md bg-zinc-100 p-0.5"><button type="button" onClick={() => setPeerBotsAllowed(true)} className={`h-7 rounded px-2 text-[10px] font-medium ${peerBotsAllowed ? 'bg-white text-zinc-900 shadow-sm' : 'text-zinc-500'}`}>所有机器人</button><button type="button" onClick={() => setPeerBotsAllowed(false)} className={`h-7 rounded px-2 text-[10px] font-medium ${!peerBotsAllowed ? 'bg-white text-zinc-900 shadow-sm' : 'text-zinc-500'}`}>指定机器人</button></div></div>
            {!peerBotsAllowed && <div className="mt-3 space-y-2.5">
              <div><div className="text-[10px] font-medium text-zinc-500">机器人名称</div><MemberNameTagInput value={allowedBotNames} onChange={setAllowedBotNames} placeholder="输入机器人名称后按 Enter"/></div>
            </div>}
          </div>
          <div className="rounded-lg border border-zinc-200 bg-white px-3 py-2.5">
            <div className="flex items-center"><div className="min-w-0"><div className="text-[12px] font-medium text-zinc-800">Trace 卡片</div><div className="mt-0.5 text-[10px] leading-4 text-zinc-400">控制任务过程中推送的 trace 卡片如何渲染与刷新。</div></div></div>
            <div className="mt-3 flex items-center border-t border-zinc-100 pt-3"><div className="min-w-0"><div className="text-[11px] font-medium text-zinc-800">静默回复（不显示 trace 卡片）</div><div className="mt-0.5 text-[10px] leading-4 text-zinc-400">不发送 trace 卡片，任务结束时由服务自动把最终回复以文本发送到会话；Agent 会被提示如何在本模式下 @ 他人。</div></div><Switch size="small" className="!ml-auto shrink-0" checked={quietReply} onChange={() => setQuietReply(value => !value)}/></div>
            {!quietReply && <div className="mt-3 grid gap-3 border-t border-zinc-100 pt-3 sm:grid-cols-2"><label className="block"><span className="flex items-center text-[11px] font-medium text-zinc-700">飞书推送间隔<span className="ml-2 font-normal text-zinc-400">500-20000 ms</span></span><InputNumber<number> size="large" min={500} max={20000} step={100} value={pushIntervalMs} onChange={value => setPushIntervalMs(value ?? 1000)} suffix="ms" className="!mt-1.5 !w-full font-mono"/></label><label className="block"><span className="flex items-center text-[11px] font-medium text-zinc-700">Trace 阶段上限<span className="ml-2 font-normal text-zinc-400">默认 {defaultLarkTraceLimit}</span></span><InputNumber size="large" min={1} max={200} step={1} precision={0} value={traceLimit === '' ? null : Number(traceLimit)} onChange={value => setTraceLimit(value == null ? '' : String(value))} className="!mt-1.5 !w-full font-mono"/><p className="mt-1 text-[10px] leading-4 text-zinc-400">心跳渲染时最多保留最近 N 个执行阶段；超过飞书 24KB / 180 组件限制时仍会自动裁剪较早记录。</p></label></div>}
          </div>
          <div className="border-t border-zinc-100 pt-3.5">
            <div className={`flex items-center ${config.data?.listeningDisabled || !larkCredentialsReady ? 'opacity-50' : ''}`}><div className="min-w-0"><div className="text-[12px] font-medium text-zinc-800">监听飞书消息</div><div className="mt-0.5 text-[10px] leading-4 text-zinc-400">{config.data?.listeningDisabled ? '本次启动已通过 --no-lark-listen 禁用，保存值不受影响' : !larkCredentialsReady ? '请先填写飞书凭证' : current?.activeListening ? '长连接已连接' : !current?.setupComplete ? '可先监听；收到消息时再校验 Agent 运行配置' : '使用长连接接收机器人消息'}</div></div><Switch size="small" className="!ml-auto shrink-0" checked={listening && !config.data?.listeningDisabled} disabled={config.data?.listeningDisabled || !larkCredentialsReady} onChange={() => setListening(value => !value)}/></div>
          </div>
          </> : <>
          <div><span className="flex items-center text-[11px] font-medium text-zinc-700">默认 Agent{defaultAgentLocked && <span className="ml-2 font-normal text-zinc-400">硬门禁已开启，保存关闭后解锁</span>}</span><AgentSelect agents={agents} value={defaultAgentId} disabled={defaultAgentLocked} onChange={value => { setDefaultAgentId(value); setDefaultModel(''); setDefaultReasoningEffort(''); setHardGateEnabled(false); setHookTrustConfirmed(false); }}/></div>
          <div className="space-y-2.5">
            <div className="flex items-center justify-between gap-2"><span className="text-[10px] text-zinc-400">{agentOptions.isFetching || refreshAgentOptions.isPending ? '正在读取 Agent 配置…' : '模型与推理强度由 Agent 提供'}</span><button type="button" disabled={!defaultAgentId || agentOptions.isFetching || refreshAgentOptions.isPending} onClick={() => refreshAgentOptions.mutate({ agentId: defaultAgentId, model: defaultModel || undefined })} className="flex items-center gap-1 rounded px-1.5 py-1 text-[10px] text-zinc-500 hover:bg-zinc-100 disabled:opacity-40"><RefreshCw size={11}/>重新读取</button></div>
            <div><span className="text-[11px] font-medium text-zinc-700">默认模型</span><CompactSelect options={[{ value: '', label: agentOptions.data?.defaultModel ? `Agent 默认 (${agentOptions.data.defaultModel})` : '使用 Agent 默认模型' }, ...withSavedOption(agentOptions.data?.models ?? [], defaultModel).map(item => ({ value: item.id, label: item.name, meta: item.name === item.id ? undefined : item.id }))]} value={defaultModel} placeholder="选择默认模型" disabled={!agentOptions.data?.models.length} disabledText="" onChange={value => { setDefaultModel(value); setDefaultReasoningEffort(''); }}/>{!agentOptions.isFetching && !agentOptions.data?.models.length && <p className="mt-1 text-[10px] text-zinc-400">暂未取得可选模型，保留当前配置；可尝试重新读取。</p>}</div>
            <div><span className="text-[11px] font-medium text-zinc-700">推理强度</span><CompactSelect options={[{ value: '', label: agentOptions.data?.defaultReasoningEffort ? `Agent 默认 (${agentOptions.data.defaultReasoningEffort})` : '使用 Agent 默认强度' }, ...withSavedOption(agentOptions.data?.reasoningEfforts ?? [], effectiveDefaultReasoningEffort).map(item => ({ value: item.id, label: item.name }))]} value={effectiveDefaultReasoningEffort} placeholder="选择推理强度" disabled={!agentOptions.data?.reasoningEfforts.length} disabledText="" onChange={setDefaultReasoningEffort}/>{!agentOptions.isFetching && !agentOptions.data?.reasoningEfforts.length && <p className="mt-1 text-[10px] leading-4 text-zinc-400">该 Agent / 模型暂未提供可选强度，保留当前配置。</p>}</div>
            {(agentOptions.data?.warning || agentOptions.isError || refreshAgentOptions.isError) && <p role="status" className="border-l-2 border-amber-300 bg-amber-50 px-2 py-1.5 text-[10px] leading-4 text-amber-800">{agentOptions.data?.warning ?? 'Agent 配置请求失败，请检查服务连接后重新读取。'}</p>}
          </div>
          <div><span className="text-[11px] font-medium text-zinc-700">预注入 Prompt <span className="font-normal text-zinc-400">可选，Markdown</span></span><Suspense fallback={<div className="mt-1.5 rounded-md border border-zinc-200 bg-zinc-50 p-3 text-[11px] text-zinc-400">正在加载编辑器…</div>}><PromptEditor value={preInjectPrompt} onChange={setPreInjectPrompt}/></Suspense><p className="mt-1 text-[10px] leading-4 text-zinc-400">每轮飞书对话都会在用户请求前隐式注入，不会在 Agent 聊天记录中重复显示为用户消息。</p></div>
          <div className="rounded-lg border border-zinc-200 bg-white px-3 py-2.5"><div className="flex items-center"><div className="min-w-0"><div className="text-[12px] font-medium text-zinc-800">启用 Agent 群协作工具</div><div className="mt-0.5 text-[10px] leading-4 text-zinc-400">允许 Agent 在当前飞书群发现其他已配置 Agent，并读取增量消息</div></div><Switch size="small" className="!ml-auto shrink-0" checked={groupToolsEnabled} onChange={() => setGroupToolsEnabled(value => !value)}/></div>{groupToolsEnabled && <div className="mt-3 flex items-center border-t border-zinc-100 pt-3"><div className="min-w-0"><div className="text-[11px] font-medium text-zinc-800">允许 Agent 发消息与 @交接</div><div className="mt-0.5 text-[10px] leading-4 text-zinc-400">关闭后仅保留 self、peers、messages 和 wait 只读能力</div></div><Switch size="small" className="!ml-auto shrink-0" checked={groupToolsAllowSend} onChange={() => setGroupToolsAllowSend(value => !value)}/></div>}{groupToolsEnabled && <div className="mt-3 flex items-center border-t border-zinc-100 pt-3"><div className="min-w-0"><div className="text-[11px] font-medium text-zinc-800">群聊主流消息的会话隔离</div><div className="mt-0.5 text-[10px] leading-4 text-zinc-400">话题内消息始终按话题隔离；此处仅影响群主流（非话题）消息</div></div><InlineSelect value={groupSessionScope} onChange={v => setGroupSessionScope(v as 'user' | 'chat')} options={[{ value: 'user', label: '按发送人隔离' }, { value: 'chat', label: '全群共享' }]} /></div>}<p className="mt-2 text-[10px] leading-4 text-zinc-400">缺少群成员、消息或发消息权限时，Agent 会停止对应操作并给出管理员授权链接；不会索要 App Secret。</p></div>
          <div className="flex items-center rounded-lg border border-zinc-200 bg-white px-3 py-2.5"><div className="min-w-0"><div className="text-[12px] font-medium text-zinc-800">启用高危操作门禁</div><div className="mt-0.5 text-[10px] leading-4 text-zinc-400">启用后强制开启软门禁，并可继续配置 Hook 硬门禁</div></div><Switch size="small" className="!ml-auto shrink-0" checked={gateEnabled} onChange={() => { const next = !gateEnabled; setGateEnabled(next); if (!next) setHardGateEnabled(false); }}/></div>
          {gateEnabled && <div className="rounded-lg border border-zinc-200 bg-zinc-50/70 p-3"><div className="text-[12px] font-semibold text-zinc-800">高危操作门禁</div><p className="mt-1 text-[10px] leading-4 text-zinc-500">不在允许名单内的发送人会收到软门禁 Prompt；开启硬门禁后，再通过 ACP 权限层和 Agent 原生工具调用 Hook 拦截。</p>
            <div className="mt-3"><div className="text-[11px] font-medium text-zinc-700">允许执行高危操作的成员 <span className="font-normal text-zinc-400">留空则继承普通成员名单</span></div><p className="mt-0.5 text-[10px] leading-4 text-zinc-400">输入真实姓名，保存时解析为 open_id。</p>
              {legacyHighRiskNeedsMigration && <div className="mt-2 border-l-2 border-amber-400 bg-amber-50 px-2.5 py-2 text-[10px] leading-4 text-amber-800">检测到旧高危邮箱名单。请重新选择成员后再保存，避免意外扩大高危权限。</div>}
              <MemberNameTagInput value={highRiskAllowedUserNames} onChange={setHighRiskAllowedUserNames} placeholder="输入姓名后按 Enter"/>
            </div>
            <label className="mt-3 block"><span className="text-[11px] font-medium text-zinc-700">高危操作正则表达式</span><Input.TextArea value={highRiskPattern} onChange={event => setHighRiskPattern(event.target.value)} autoSize={{ minRows: 4, maxRows: 10 }} status={highRiskPatternValidation.valid ? undefined : 'error'} className="mt-1.5 font-mono text-[11px] leading-5"/>{!highRiskPatternValidation.valid && <p className="mt-1.5 flex items-start gap-1 text-[10px] leading-4 text-red-600"><AlertTriangle size={11} className="mt-0.5 shrink-0"/>{highRiskPatternValidation.error}</p>}</label>
            <div className="mt-3 flex items-center"><div><div className="text-[11px] font-medium text-zinc-800">软门禁</div><div className="text-[10px] leading-4 text-zinc-400">门禁启用后固定开启，隐式注入禁止绕过的安全 Prompt</div></div><Switch size="small" className="!ml-auto shrink-0" checked disabled/></div>
            <div className={`mt-3 flex items-center ${!hookStatus.data?.installed && !hardGateEnabled ? 'opacity-60' : ''}`}><div><div className="text-[11px] font-medium text-zinc-800">硬门禁</div><div className="text-[10px] leading-4 text-zinc-400">{hookStatus.data?.installed ? 'Hook 已配置，可以开启硬门禁' : agentSelectionSaved ? hookStatus.data?.reason ?? '请先检测并配置 Hook' : '点击下方按钮会先保存当前默认 Agent，再检测并配置 Hook'}</div></div><Switch size="small" className="!ml-auto shrink-0" checked={hardGateEnabled} disabled={!hardGateCanToggle} onChange={() => setHardGateEnabled(value => !value)}/></div>
            {hardGateHookMissing && <div className="mt-2 rounded-md border border-amber-200 bg-amber-50 px-2.5 py-2 text-[10px] leading-4 text-amber-800">已保存的硬门禁 Hook 当前未检测到。其他设置仍可保存；如需恢复硬门禁，请先关闭上方开关，再重新检测并配置 Hook。</div>}
            <button type="button" disabled={!current || hardGateEnabled || installHook.isPending || legacyHighRiskNeedsMigration || !workspace.trim() || !highRiskPatternValidation.valid || hookStatus.data?.supported === false} onClick={() => installHook.mutate()} className="mt-3 flex h-9 w-full items-center justify-center gap-2 rounded-md border border-zinc-300 bg-white text-[11px] font-medium text-zinc-700 hover:bg-zinc-50 disabled:cursor-not-allowed disabled:opacity-40"><Wrench size={12}/>{installHook.isPending ? '正在检测并配置 Hook' : hookStatus.data?.installed ? '重新检测并配置 Hook' : '检测并配置 Hook'}</button>
            {hookStatus.data?.supported === false && <div className="mt-2 rounded-md border border-amber-200 bg-amber-50 px-2.5 py-2 text-[10px] leading-4 text-amber-800">{hookStatus.data.reason}</div>}
            {hookStatus.data?.trustInstructions && <div className="mt-2 rounded-md border border-zinc-200 bg-white px-3 py-2 text-[10px] leading-4 text-zinc-500">{hookStatus.data.trustInstructions}</div>}
          </div>}
          </>}
        </>}
        {formError && <div className="rounded-md border border-red-100 bg-red-50 px-2.5 py-2 text-[11px] leading-4 text-red-700"><div>{formError.message}</div>{permissionRelatedError && permissionSettingsUrl && <a href={permissionSettingsUrl} target="_blank" rel="noreferrer" className="mt-2 inline-flex items-center gap-1 font-medium text-red-800 underline decoration-red-300 underline-offset-2 hover:text-red-950">打开当前机器人的权限配置<ExternalLink size={11}/></a>}</div>}
      </div>
      <div className="flex items-center border-t border-zinc-100 px-4 py-3">{current ? <button type="button" onClick={() => { remove.reset(); setConfirmation('delete'); }} className="flex items-center gap-1.5 rounded-md px-2 py-1.5 text-[11px] font-medium text-red-600 hover:bg-red-50"><Trash2 size={13}/>删除配置</button> : <span className="text-[10px] text-zinc-400">App ID 将作为唯一主键，不能重复配置</span>}{step === 2 && <button type="button" onClick={() => setStep(1)} className="ml-auto rounded-md px-3 py-1.5 text-xs font-medium text-zinc-600 hover:bg-zinc-100">上一步</button>}<button type="button" onClick={requestClose} className={`${step === 2 ? '' : 'ml-auto'} rounded-md px-3 py-1.5 text-xs font-medium text-zinc-600 hover:bg-zinc-100`}>{step === 2 && current && !current.setupComplete ? '稍后完成' : '取消'}</button><button type="submit" disabled={!canSave || save.isPending} className="ml-1 min-w-20 rounded-md bg-zinc-900 px-3 py-1.5 text-xs font-medium text-white hover:bg-zinc-700 active:scale-[.98] disabled:cursor-not-allowed disabled:opacity-35">{save.isPending ? (step === 1 ? '验证中' : '保存中') : agentCapabilitiesPending ? '读取模型中' : step === 1 ? '下一步' : '完成配置'}</button></div>
    </form>
  </div><ConfirmDialog
    open={Boolean(confirmation)}
    tone={confirmation === 'delete' ? 'danger' : 'warning'}
    title={confirmation === 'delete' ? '删除机器人配置？' : confirmation === 'incomplete' ? '稍后再完成配置？' : '放弃未保存的配置？'}
    description={confirmation === 'delete' ? `将删除“${current?.name ?? '当前机器人'}”的凭证、监听和门禁配置。已有会话记录不会删除。` : confirmation === 'incomplete' ? 'Agent 配置尚未完成。若已开启监听，机器人仍会接收消息，并提示发送人补充运行配置。' : '当前填写的机器人信息尚未保存，关闭后需要重新填写。'}
    confirmLabel={confirmation === 'delete' ? '确认删除' : confirmation === 'incomplete' ? '稍后完成' : '放弃修改'}
    busy={confirmation === 'delete' && remove.isPending}
    error={confirmation === 'delete' && remove.error ? remove.error.message : undefined}
    onCancel={() => { if (!remove.isPending) setConfirmation(undefined); }}
    onConfirm={() => { if (confirmation === 'delete') remove.mutate(); else { setConfirmation(undefined); onClose(); } }}
  /></>;
}

type ItemDrag = { dragging: boolean; over: boolean; props: HTMLAttributes<HTMLDivElement> & { draggable?: boolean } };

/** 会话状态指示：忙碌中转圈（对齐 Codex 的运行态），其余用静态点。尺寸交给调用方定，
 * 这样完整行的行首点和「最近」行尾点可以共用同一套语义与配色。 */
function SessionStateIndicator({ session, size = 12 }: { session: Session; size?: number }) {
  // 「等待授权」是卡在等人，不是在推进：给静态橙点，转圈会让人以为它在自己跑。
  if (busyStates.has(session.state) && session.state !== 'waiting_for_permission') {
    return <LoaderCircle size={size} aria-label={stateLabels[session.state]} className={`shrink-0 animate-spin ${stateTextTone[session.state] ?? 'text-zinc-400'}`}/>;
  }
  return <span aria-label={stateLabels[session.state]} className={`h-1.5 w-1.5 shrink-0 rounded-full ${stateTone[session.state] ?? 'bg-zinc-400'}`}/>;
}

function SessionRow({ session, agent, botName, parentLabel, active, nested = false, compact = false, drag, onClick }: { session: Session; agent?: Agent; botName?: string; /** 侧边会话的父会话显示名，供 hover 卡片点出来处。 */ parentLabel?: string; active: boolean; /** 侧边会话：缩进挂在主会话下面。 */ nested?: boolean; /** 「最近」用的单行密排样式（对齐 Codex）：无卡片描边、无副标题。 */ compact?: boolean; /** 传入即表示这一行可拖拽：项目树的完整行用于排序，不参与排序的行只用于拖到副屏。 */ drag?: ItemDrag; onClick(): void }) {
  const lark = session.source === 'lark';
  // 定时任务新建的会话也是 side-chat，不加标记就和手动开的侧边会话混在一起。
  const scheduled = isScheduledSession(session);
  const agentName = agent?.name ?? session.agentId;
  const primary = sessionLabel(session, agent?.name);
  // 整行一个 hover 目标：一行只该有一个提示。信息卡里已经含完整 cwd，所以副标题那个
  // 单独的 cwd tooltip 一并撤掉——同一行挂两个不同内容的提示，用户不知道该信哪个。
  const hoverCard = <SessionHoverCard session={session} agentName={agent?.name} botName={botName} parentLabel={parentLabel} now={new Date()}/>;
  const cwdLabel = session.cwd.split(/[\\/]/).filter(Boolean).pop() || session.cwd;
  const subtitle = session.archivedAt
    ? '已归档，只读'
    : session.title
      ? `${agentName} · ${lark ? '飞书对话记录' : cwdLabel}`
      : lark ? '飞书对话记录' : session.cwd;
  // 「最近」的单行形态：标题 + 状态点，状态点只在需要关注时出现——一屏几十条里
  // 每行都挂一个绿点/灰点，等于没有信息，反而看不出哪条真的要处理。
  if (compact) {
    const attention = busyStates.has(session.state) || session.state === 'failed';
    const compactRow = <div onClick={onClick} role="button" tabIndex={0} onKeyDown={event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); onClick(); } }} {...(drag?.props ?? {})} className={`group flex w-full cursor-pointer items-center gap-2 rounded-lg px-2 py-1.5 text-left transition-colors ${active ? 'bg-white text-zinc-900 shadow-[0_1px_2px_rgba(24,24,27,.05)]' : 'text-zinc-600 hover:bg-white/75 hover:text-zinc-900'} ${drag?.dragging ? 'opacity-40' : ''}`}>
      {scheduled && <AlarmClock size={11} aria-label="定时任务会话" className="shrink-0 text-zinc-400"/>}
      <SessionTitleEditor session={session} label={primary} nameClassName="min-w-0 flex-1 truncate text-[12px]"/>
      {lark && <span className="max-w-20 shrink-0 truncate rounded bg-zinc-100 px-1 py-0.5 text-[9px] text-zinc-500">{botName ?? '飞书'}</span>}
      {attention && <SessionStateIndicator session={session} size={12}/>}
    </div>;
    return nested ? <div className="relative ml-3 border-l border-zinc-200 pl-1.5"><HoverTooltip content={hoverCard} side="right" align="start">{compactRow}</HoverTooltip></div> : <HoverTooltip content={hoverCard} side="right" align="start">{compactRow}</HoverTooltip>;
  }
  const row = <div onClick={onClick} role="button" tabIndex={0} onKeyDown={event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); onClick(); } }} {...(drag?.props ?? {})} className={`ui-session-row group relative mb-1 w-full cursor-pointer rounded-xl border px-3 py-2.5 text-left transition-[background-color,border-color,box-shadow,transform,opacity] duration-200 active:scale-[.99] ${active ? 'border-zinc-200/80 bg-white shadow-[0_2px_8px_rgba(24,24,27,.055)]' : 'border-transparent hover:border-zinc-200/60 hover:bg-white/65'} ${drag?.dragging ? 'opacity-40' : ''} ${drag?.over ? 'border-zinc-300 ring-1 ring-zinc-300' : ''}`}>
    {drag && <GripVertical size={11} className="absolute right-1.5 top-1/2 -translate-y-1/2 shrink-0 cursor-grab rounded bg-white/90 px-0.5 text-zinc-300 opacity-0 shadow-[0_1px_2px_rgba(24,24,27,.06)] transition-opacity group-hover:opacity-100"/>}
    <div className="flex items-center gap-2"><span className="grid h-3 w-3 shrink-0 place-items-center"><SessionStateIndicator session={session} size={12}/></span>{scheduled && <AlarmClock size={12} aria-label="定时任务会话" className="shrink-0 text-zinc-400"/>}<SessionTitleEditor session={session} label={primary} nameClassName="min-w-0 flex-1 truncate text-[13px] font-medium text-zinc-800"/>{lark ? <span className="max-w-24 shrink-0 truncate rounded-md bg-zinc-100 px-1.5 py-0.5 text-[9px] font-medium text-zinc-500">{botName ?? '飞书'}</span> : <span className="text-[10px] text-zinc-400 opacity-0 transition-opacity group-hover:opacity-100">{stateLabels[session.state]}</span>}</div>
    <div className="mt-1 flex min-w-0 items-center gap-1.5 pl-3.5 text-[11px] text-zinc-500">{lark && <MessageSquare size={10} className="shrink-0 text-zinc-400"/>}<span className="min-w-0 truncate">{subtitle}</span></div>
  </div>;

  // 侧边会话缩进一级：左侧一条细线连回主会话。用 wrapper 而不是改 row 自己的类，
  // 否则缩进后的行看起来像另一个层级的组件（圆角与描边都会显得突兀）。
  //
  // 信息卡一律往右弹：锚点是**整行**（宽度铺满侧栏），而卡片有 320px 宽、十来行高，
  // 往上弹会盖住侧栏顶部（第一行的卡片实测压住 AgentDock 的 logo），往下弹又会压住
  // 它下面的会话行。往右正好落进主内容区的空白，侧栏一个字都不挡。
  // `align="start"` 让卡片顶边对齐行顶边，滚动到任意位置都不会有半个卡片飘在视口外。
  return <HoverTooltip content={hoverCard} side="right" align="start">{nested ? <div className="relative ml-4 border-l border-zinc-200 pl-1.5">{row}</div> : row}</HoverTooltip>;
}

export default function App() {
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
  const [sidebarOpen, setSidebarOpen] = useState(false); const [searchOpen, setSearchOpen] = useState(false); const [collapsedWorkspaces, setCollapsedWorkspaces] = useState<Set<string>>(new Set()); const [collapsedAgentGroups, setCollapsedAgentGroups] = useState<Set<string>>(new Set()); const [larkOpen, setLarkOpen] = useState(false); const [agentConfigOpen, setAgentConfigOpen] = useState(false); const [importOpen, setImportOpen] = useState(false); const [archivedOpen, setArchivedOpen] = useState(false); const [scheduleOpen, setScheduleOpen] = useState(false); const [sessionFilter, setSessionFilter] = useState('all');
  // iOS 键盘弹出不缩小 layout viewport，100dvh 仍是全高 → 整页可滚。
  // 根容器的高度与位移由 useVisualViewportShell 直接在事件回调里命令式写入（不走 state，
  // 否则重渲染跟不上键盘动画，顶栏会先滚出去再被拽回来）：锁高度防整页橡皮筋滚动，
  // translateY(offsetTop) 让根容器跟随上移的可视视口，否则键盘弹出时 composer 栏
  // 与可视窗口底部之间会空出 offsetTop 高的一条空白。
  // 这两个值只作用在根容器这一层，#root 外壳恒为 100dvh：页面高度不随键盘变化，
  // 浏览器就不会重算并夹取 offsetTop，与这里的 translateY 互相打架。
  // 因此根容器不能带 style prop——React 不管辖内联样式，重渲染才不会覆盖上面的赋值。
  const shellRef = useVisualViewportShell<HTMLDivElement>();
  const agents = useQuery({ queryKey: ['agents'], queryFn: () => api.agents(), enabled: !webDenied }); const sessions = useQuery({ queryKey: ['sessions'], queryFn: api.sessions, enabled: !webDenied, refetchInterval: webDenied ? false : 2_000, refetchIntervalInBackground: true }); const larkConfig = useQuery({ queryKey: ['lark-config'], queryFn: api.larkConfig, enabled: !webDenied, refetchInterval: webDenied ? false : 5_000 }); const systemCapabilities = useQuery({ queryKey: ['system-capabilities'], queryFn: api.systemCapabilities, enabled: !webDenied });
  // 地址栏 → store：首次挂载读一次；浏览器前进/后退再读一次。
  const applyUrlToStore = () => {
    const match = window.location.pathname.match(/^\/sessions\/([^/]+)$/);
    const primary = match?.[1] ? decodeURIComponent(match[1]) : undefined;
    const right = parseRightParam(window.location.search, primary);
    if (!right || !primary) { restoreFromUrl(primary); return; }
    if (right.kind === 'session') { if (right.sessionId) restoreFromUrl(primary, sessionPaneTab(primary, right.sessionId, right.sessionId)); return; }
    restoreFromUrl(primary, { id: `${right.kind}:${primary}`, kind: right.kind, anchorSessionId: primary, title: right.kind === 'terminal' ? '终端' : right.kind === 'files' ? '文件' : '原始日志' });
  };
  useMount(applyUrlToStore);
  useEventListener('popstate', applyUrlToStore);
  // store → 地址栏：主屏 / 右栏活跃标签变化时 replaceState 同步，刷新与分享链接可恢复。
  useUpdateEffect(() => {
    window.history.replaceState(null, '', sessionUrl(primarySessionId, paneOpen ? activeTab : undefined));
  }, [primarySessionId, activeTabId, tabs, paneOpen]);
  // 默认按「最后一次对话时间」倒序。updatedAt 会被状态切换（工具、授权、归档）刷新，
  // 用它排会把「最近动过的」压过「最近聊过的」，所以改用 lastMessageAt，旧数据回退 updatedAt。
  const sortedSessions = useMemo(() => [...(sessions.data ?? [])].sort((left, right) => sessionActivityTime(right).localeCompare(sessionActivityTime(left))), [sessions.data]);
  const visibleSessions = useMemo(() => sortedSessions.filter(session => !session.archivedAt && (sessionFilter === 'all' || sessionFilter === 'local' ? sessionFilter === 'all' || session.source !== 'lark' : session.source === 'lark' && session.sourceId?.startsWith(`${sessionFilter}:`))), [sortedSessions, sessionFilter]);
  const archivedSessions = useMemo(() => sortedSessions.filter(session => session.archivedAt), [sortedSessions]);
  const workspaceGroups = useMemo(() => groupSessions(visibleSessions, agents.data ?? []), [visibleSessions, agents.data]);
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
  // 手动排序是否真的在生效：比较渲染结果，陈旧 id 不算数（否则按钮会一直挂着）。
  const manualOrder = useMemo(() => !sameSessionTree(workspaceGroups, orderedGroups), [workspaceGroups, orderedGroups]);
  // 「最近操作」置顶区：筛选后的会话里按最后一次对话时间取最近 N 条，扁平、不参与工作区分组。
  // 走 visibleSessions，所以来源筛选对它同样生效——筛选决定候选集，置顶区只是候选集里最近的一截。
  const recent = useMemo(() => recentSessions(visibleSessions), [visibleSessions]);
  // 新建对话：回到空态首页，由 DraftComposer 在提交时才创建 Session；不再弹选择框。
  // 输入框可能本帧才挂载，放到下一帧再聚焦。
  const draftTextareaRef = useRef<HTMLTextAreaElement | null>(null);
  const startNewConversation = useMemoizedFn(() => {
    setSession(undefined); setSidebarCollapsed(false); setSidebarOpen(false); setPaneMenuAnchor(undefined);
    requestAnimationFrame(() => draftTextareaRef.current?.focus());
  });
  // ⌘K / Ctrl+K 全局搜索会话。带 meta/ctrl 前缀，输入框中也不会与普通打字冲突。
  const openSearch = useMemoizedFn(() => { setSidebarOpen(false); setSearchOpen(true); });
  useEventListener('keydown', event => {
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
      event.preventDefault();
      openSearch();
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
  // 标签页标题跟主会话走。用 sessionLabel 而不是 session.title：没标题的会话要有 Agent 名兜底，
  // 否则标签页会变成 `undefined - AgentDock`。
  useDocumentTitle(primarySession ? sessionLabel(primarySession, agents.data?.find(agent => agent.id === primarySession.agentId)?.name) : undefined);
  const selectSession = (id: string) => { setSession(id); setSidebarOpen(false); setPaneMenuAnchor(undefined); };
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
    openTab({ id: `raw:${sessionId}`, kind: 'raw', anchorSessionId: sessionId, title: sessionId === primarySessionId ? '原始日志' : '侧边日志' }, primarySessionId);
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
      openTab({ id: `${kind}:${primarySessionId}`, kind, anchorSessionId: primarySessionId, title: kind === 'terminal' ? '终端' : '文件' });
      return;
    }
    // 侧边聊天要在右栏新开一个会话，由 mutation 完成（建会话需要请求）。
    if (primarySession) sideChat.mutate(primarySession);
  });

  /**
   * 侧边聊天：同 agent / 同 cwd 建一个全新会话，把「门牌号 + 取数方式」通过
   * **会话级 systemPrompt** 注入——不出现在时间线里。早先是当第一条用户消息发的，
   * 用户会看到一坨自己没打过的字。
   */
  const sideChat = useMutation({
    mutationFn: async (source: Session) => api.create({ agentId: source.agentId, cwd: source.cwd, systemPrompt: buildSideSessionSeed(source.id), source: sideChatSource, sourceId: source.id }),
    onSuccess: (created, source) => {
      void qc.invalidateQueries({ queryKey: ['sessions'] });
      openTab({ id: `side-chat:${created.id}`, kind: 'side-chat', sessionId: created.id, title: '侧边聊天' }, source.id);
    },
    onError: error => setActionError(error instanceof Error ? error.message : String(error))
  });

  const shortcuts: Shortcut[] = [
    { key: 't', label: shortcutLabel('t'), description: '终端', run: () => openPaneKind('terminal') },
    { key: 's', shift: true, label: shortcutLabel('s', true), description: '侧边聊天', run: () => openPaneKind('side-chat') },
    { key: 'p', label: shortcutLabel('p'), description: '文件', run: () => openPaneKind('files') }
  ];
  useShortcuts(shortcuts);



  // 侧边栏桌面端拖拽调宽 / 收起：拖到 180 以下自动收成 44px 细条；移动端始终走抽屉，不受影响。
  const [sidebarWidth, setSidebarWidth] = useLocalStorageState<number>('agentdock:sidebar-width', { defaultValue: 268 });
  const [sidebarCollapsed, setSidebarCollapsed] = useLocalStorageState<boolean>('agentdock:sidebar-collapsed', { defaultValue: false });
  const [recentCollapsed, setRecentCollapsed] = useLocalStorageState<boolean>('agentdock:recent-collapsed', { defaultValue: false });
  const [projectsCollapsed, setProjectsCollapsed] = useLocalStorageState<boolean>('agentdock:projects-collapsed', { defaultValue: false });
  // 最近 / 项目 两块可以拖拽互换，顺序持久化。localStorage 可能被旧版本或手改写成脏值，
  // 所以每次用之前先归一化，而不是只信 defaultValue。
  const [sectionOrder, setSectionOrder] = useLocalStorageState<SidebarSectionKey[]>('agentdock:sidebar-section-order', { defaultValue: DEFAULT_SECTION_ORDER });
  const orderedSections = normalizeSectionOrder(sectionOrder);
  const sectionOrderIndex = (key: SidebarSectionKey) => orderedSections.indexOf(key);
  const [draggingSection, setDraggingSection] = useState<SidebarSectionKey>();
  const [dragOverSection, setDragOverSection] = useState<SidebarSectionKey>();
  const secondSection = orderedSections[1];
  // 只有两块都在（有最近会话）时才需要分隔线；谁在下面谁带。
  const bothSectionsVisible = recent.length > 0;
  // 三层共用一个拖拽态：scope 区分层级（workspaces / agents:<cwd> / sessions:<cwd>\0<agentId>）。
  // sessionId 是「拖到副屏」的载荷，与排序用的 scope 正交：排序拖拽顺带带上它，
  // 不参与排序的会话行（侧边会话、最近）只带它。
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
  const quickCreate = useMutation({
    mutationFn: ({ agentId, cwd }: { agentId: string; cwd: string }) => api.create({ agentId, cwd }),
    onMutate: pair => setCreatingPair(pair),
    onSuccess: session => {
      void qc.invalidateQueries({ queryKey: ['sessions'] });
      setCreatingPair(undefined);
      setAgentPicker(null);
      selectSession(session.id);
    },
    onError: () => setCreatingPair(undefined)
  });

  if (webDenied) return <WebAccessDeniedPanel denied={webDenied}/>;
  // 分区表头拖拽互换。只有两块，所以不做落点计算：拖到另一块上就是对调。
  const sectionDragProps = (key: SidebarSectionKey) => ({
    draggable: true,
    onDragStart: (event: DragEvent<HTMLDivElement>) => { setDraggingSection(key); event.dataTransfer.effectAllowed = 'move'; },
    onDragEnd: () => { setDraggingSection(undefined); setDragOverSection(undefined); },
    onDragOver: (event: DragEvent<HTMLDivElement>) => {
      if (!draggingSection || draggingSection === key) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = 'move';
      setDragOverSection(key);
    },
    onDragLeave: () => setDragOverSection(current => (current === key ? undefined : current)),
    onDrop: (event: DragEvent<HTMLDivElement>) => {
      event.preventDefault();
      if (draggingSection) setSectionOrder(current => reorderSections(normalizeSectionOrder(current), draggingSection, key));
      setDraggingSection(undefined);
      setDragOverSection(undefined);
    }
  });
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
    const ids = orderedGroups.map(workspace => workspace.cwd);
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
  const renderSessionRow = (session: Session, nested = false, compact = false, drag?: ItemDrag) => {
    // 侧边会话的父标题在这儿查好再传下去，卡片自己不去翻会话列表（它只是展示层）。
    // 父会话被归档或不在当前筛选里就查不到，卡片会降级成不带出处。
    const parent = session.sourceId ? sortedSessions.find(item => item.id === session.sourceId) : undefined;
    return <SessionRow key={session.id} session={session} nested={nested} compact={compact} drag={drag} agent={agents.data?.find(item => item.id === session.agentId)} botName={larkConfig.data?.bots.find(bot => session.sourceId?.startsWith(`${bot.appId}:`))?.name} parentLabel={parent ? sessionLabel(parent, agents.data?.find(item => item.id === parent.agentId)?.name) : undefined} active={primarySessionId === session.id || tabs.some(tab => (tab.kind === 'session' || tab.kind === 'side-chat') && tab.sessionId === session.id)} onClick={() => selectSession(session.id)}/>;
  };
  // TooltipProvider 必须挂在根部：Radix 用它统一管理「同一时刻只显示一个提示」与交错延迟。
  return <TooltipProvider><div ref={shellRef} className="relative flex h-full overflow-hidden bg-[#f7f8fa] font-sans text-zinc-900">
    {sidebarOpen && <button type="button" aria-label="关闭会话列表" onClick={() => setSidebarOpen(false)} className="ui-overlay fixed inset-0 z-40 bg-zinc-950/20 backdrop-blur-[1px] md:hidden"/>}
    <aside style={{ ['--sb-w' as string]: `${clampedSidebarWidth}px` }} className={`fixed inset-y-0 left-0 z-50 flex shrink-0 flex-col overflow-hidden border-r border-zinc-200 bg-[#f1f3f5] shadow-[12px_0_36px_rgba(24,24,27,.08)] transition-transform duration-300 ease-[cubic-bezier(.16,1,.3,1)] w-[286px] md:static md:z-20 md:translate-x-0 md:shadow-none ${sidebarOpen ? 'translate-x-0' : '-translate-x-full'} ${sidebarCollapsed ? 'md:w-11' : 'md:w-[var(--sb-w)]'}`}>
      {!sidebarCollapsed && <div onPointerDown={event => { event.preventDefault(); resizeStart.current = { x: event.clientX, width: clampedSidebarWidth }; setResizingSidebar(true); }} title="拖拽调整宽度，拖到最窄可收起" className="absolute inset-y-0 right-0 z-20 hidden w-1.5 cursor-col-resize touch-none bg-transparent hover:bg-blue-400/30 md:block"/>}
      <div className={`flex h-full flex-col ${sidebarCollapsed ? 'md:hidden' : ''}`}>
      <button type="button" onClick={() => { setSession(undefined); setSidebarOpen(false); setPaneMenuAnchor(undefined); }} title="回到首页" aria-label="回到首页" className="flex h-14 min-w-[268px] items-center gap-2.5 px-4 text-left transition-colors hover:bg-zinc-100/70 active:bg-zinc-200/60"><AgentDockIcon className="h-7 w-7 shrink-0"/><span className="text-sm font-semibold tracking-[-.02em]">AgentDock</span></button>
      <div className="min-w-[268px] px-2.5 flex flex-col gap-1"><button onClick={startNewConversation} aria-label="新建对话" className="flex h-9 w-full items-center gap-2 rounded-xl border border-zinc-200 bg-white px-3 text-[13px] font-medium shadow-[0_1px_2px_rgba(24,24,27,.06)] hover:bg-zinc-50 active:scale-[.99]"><Plus size={15}/>新建对话</button><button type="button" onClick={openSearch} aria-label="搜索会话（⌘K）" className="flex h-9 w-full items-center gap-2 rounded-xl px-3 text-[12px] font-medium text-zinc-600 transition-[background-color,color,transform] duration-200 hover:bg-white/75 hover:text-zinc-900 active:scale-[.99]"><Search size={14}/>搜索会话<span className="ml-auto rounded-md border border-zinc-200 bg-zinc-50 px-1.5 py-0.5 font-sans text-[10px] font-normal text-zinc-400">⌘K</span></button></div>
      <div className="mt-5 min-w-[268px] px-4 text-[10px] font-semibold uppercase tracking-[.12em] text-zinc-500">会话列表</div>
      <div className="mt-2 min-w-0 px-3 pb-1"><SessionFilterSelect value={sessionFilter} bots={larkConfig.data?.bots ?? []} agents={agents.data ?? []} onChange={setSessionFilter}/></div>
      <div className="mt-1 min-w-[268px] flex min-h-0 flex-1 flex-col px-2">{sessions.isLoading ? <div className="space-y-2 px-2"><div className="h-14 animate-pulse rounded-xl bg-zinc-200/70"/><div className="h-14 animate-pulse rounded-xl bg-zinc-200/50"/></div> : visibleSessions.length ? <>
        {/* 最近在上、项目在下：最近回答「刚用过的在哪」，项目回答「它归属哪个工作区」。两块都能折。 */}
        {recent.length > 0 && <section style={{ order: sectionOrderIndex('recent') }} className={`flex min-h-0 flex-col ${recentCollapsed ? 'shrink-0' : 'flex-1'} ${bothSectionsVisible && secondSection === 'recent' ? 'mt-2 border-t border-zinc-200/70 pt-1' : ''}`}>
          <div role="button" tabIndex={0} {...sectionDragProps('recent')} onClick={() => setRecentCollapsed(value => !value)} onKeyDown={event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); setRecentCollapsed(value => !value); } }} title={recentCollapsed ? '展开最近（拖拽可换位）' : '收起最近（拖拽可换位）'} className={`group/sec flex h-7 w-full shrink-0 cursor-pointer items-center gap-1.5 rounded-lg px-2 text-left transition-opacity hover:bg-white/70 ${draggingSection === 'recent' ? 'opacity-40' : ''} ${dragOverSection === 'recent' ? 'ring-1 ring-zinc-300' : ''}`}>
            {recentCollapsed ? <ChevronRight size={11} className="shrink-0 text-zinc-400"/> : <ChevronDown size={11} className="shrink-0 text-zinc-400"/>}
            <History size={11} className="shrink-0 text-zinc-400"/>
            <span className="min-w-0 flex-1 truncate text-[10px] font-semibold tracking-[.12em] text-zinc-400">最近</span>
            <span className="shrink-0 text-[10px] tabular-nums text-zinc-400">{recent.length}</span>
            <GripVertical size={11} className="shrink-0 cursor-grab text-zinc-300 opacity-0 transition-opacity group-hover/sec:opacity-100"/>
          </div>
          {/* 每段自己的滚动条：最近与项目各占一半（折叠的那段把空间让出来）。 */}
          {!recentCollapsed && <div className="mt-0.5 min-h-0 flex-1 overflow-y-auto">{recent.map(({ session, sideChats }) => <div key={session.id}>
            {renderSessionRow(session, false, true, sessionDrag(session.id))}
            {sideChats.map(child => renderSessionRow(child, true, true, sessionDrag(child.id)))}
          </div>)}</div>}
        </section>}
        <section style={{ order: sectionOrderIndex('projects') }} className={`flex min-h-0 flex-col ${projectsCollapsed ? 'shrink-0' : 'flex-1'} ${bothSectionsVisible && secondSection === 'projects' ? 'mt-2 border-t border-zinc-200/70 pt-1' : ''}`}>
        <div role="button" tabIndex={0} {...sectionDragProps('projects')} onClick={() => setProjectsCollapsed(value => !value)} onKeyDown={event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); setProjectsCollapsed(value => !value); } }} title={projectsCollapsed ? '展开项目（拖拽可换位）' : '收起项目（拖拽可换位）'} className={`group/sec flex h-7 w-full shrink-0 cursor-pointer items-center gap-1.5 rounded-lg px-2 text-left transition-opacity hover:bg-white/70 ${draggingSection === 'projects' ? 'opacity-40' : ''} ${dragOverSection === 'projects' ? 'ring-1 ring-zinc-300' : ''}`}>
          {projectsCollapsed ? <ChevronRight size={11} className="shrink-0 text-zinc-400"/> : <ChevronDown size={11} className="shrink-0 text-zinc-400"/>}
          <Layers3 size={11} className="shrink-0 text-zinc-400"/>
          <span className="min-w-0 flex-1 truncate text-[10px] font-semibold tracking-[.12em] text-zinc-400">项目</span>
          <span className="shrink-0 text-[10px] tabular-nums text-zinc-400">{orderedGroups.length}</span>
          <GripVertical size={11} className="shrink-0 cursor-grab text-zinc-300 opacity-0 transition-opacity group-hover/sec:opacity-100"/>
          {manualOrder && <button type="button" title="恢复默认排序（按最近对话时间）" onClick={event => { event.stopPropagation(); setItemOrder(EMPTY_ITEM_ORDER); }} className="grid h-4 w-4 shrink-0 place-items-center rounded text-zinc-400 opacity-0 transition-opacity hover:bg-zinc-200 hover:text-zinc-800 focus:opacity-100 group-hover/sec:opacity-100"><RotateCcw size={10}/></button>}
        </div>
        {!projectsCollapsed && <div className="min-h-0 flex-1 overflow-y-auto">
        {orderedGroups.map(workspace => {
        const collapsed = collapsedWorkspaces.has(workspace.cwd);
        const workspaceDrag = itemDrag('workspaces', workspace.cwd, reorderWorkspaces);
        const busyCount = workspace.agents.reduce((count, group) => count + group.sessions.filter(session => busyStates.has(session.state)).length, 0);
        return <div key={workspace.cwd} className="mb-0.5">
          <div role="button" tabIndex={0} {...workspaceDrag.props} onClick={() => toggleWorkspace(workspace.cwd)} onKeyDown={event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); toggleWorkspace(workspace.cwd); } }} title={`${workspace.cwd}（拖拽可换位）`} className={`group sticky top-0 z-[1] flex h-8 w-full cursor-pointer items-center gap-1.5 rounded-lg bg-[#f1f3f5]/95 pl-2.5 pr-1 text-left backdrop-blur-sm transition-opacity hover:bg-white/70 ${workspaceDrag.dragging ? 'opacity-40' : ''} ${workspaceDrag.over ? 'ring-1 ring-zinc-300' : ''}`}>
            {collapsed ? <ChevronRight size={12} className="shrink-0 text-zinc-400"/> : <ChevronDown size={12} className="shrink-0 text-zinc-400"/>}
            <Folder size={12} className="shrink-0 text-zinc-400"/>
            <HoverTooltipText content={workspace.cwd} className="min-w-0 flex-1 truncate text-[11px] font-semibold text-zinc-700">{workspace.label}</HoverTooltipText>
            {busyCount > 0 && <span className="ui-status-pulse h-1.5 w-1.5 shrink-0 rounded-full bg-blue-500"/>}
            <span role="button" tabIndex={-1} onClick={event => { event.stopPropagation(); const rect = (event.currentTarget as HTMLElement).getBoundingClientRect(); setAgentPicker({ cwd: workspace.cwd, top: rect.bottom + 4, left: Math.min(rect.left, window.innerWidth - 224) }); }} className="grid h-5 w-5 shrink-0 place-items-center rounded text-zinc-400 opacity-0 transition-opacity hover:bg-zinc-200 hover:text-zinc-800 focus:opacity-100 group-hover:opacity-100 max-md:opacity-100"><Plus size={12}/></span>
            <GripVertical size={11} className="shrink-0 cursor-grab text-zinc-300 opacity-0 transition-opacity group-hover:opacity-100"/>
            <span className="shrink-0 text-[10px] tabular-nums text-zinc-400">{workspace.agents.reduce((count, group) => count + group.sessions.length, 0)}</span>
          </div>
          {!collapsed && <div className="ml-3 border-l border-zinc-200/80 pl-1.5">{workspace.agents.map(group => {
            const groupKey = `${workspace.cwd}\0${group.agentId}`;
            const agentCollapsed = collapsedAgentGroups.has(groupKey);
            const agentDrag = itemDrag(`agents:${workspace.cwd}`, group.agentId, (from, to) => reorderAgents(workspace.cwd, from, to));
            const agentBusy = group.sessions.some(session => busyStates.has(session.state));
            return <div key={`${workspace.cwd}:${group.agentId}`} className="group/agent">
            <div role="button" tabIndex={0} {...agentDrag.props} onClick={() => toggleAgentGroup(groupKey)} onKeyDown={event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); toggleAgentGroup(groupKey); } }} title={agentCollapsed ? `展开 ${group.agentName}（拖拽可换位）` : `收起 ${group.agentName}（拖拽可换位）`} className={`flex h-7 w-full cursor-pointer items-center gap-1 rounded-lg px-2 pb-0.5 pt-1 text-left text-[10px] font-medium text-zinc-400 transition-opacity hover:bg-white/70 hover:text-zinc-600 ${agentDrag.dragging ? 'opacity-40' : ''} ${agentDrag.over ? 'ring-1 ring-zinc-300' : ''}`}>{agentCollapsed ? <ChevronRight size={11} className="shrink-0"/> : <ChevronDown size={11} className="shrink-0"/>}<AgentIcon agentId={group.agentId} agentName={group.agentName} size={12}/><span className="min-w-0 flex-1 truncate">{group.agentName}</span>{agentBusy && !agentCollapsed && <span className="ui-status-pulse h-1.5 w-1.5 shrink-0 rounded-full bg-blue-500"/>}<button type="button" title={`用 ${group.agentName} 在此工作区新建会话`} disabled={Boolean(creatingPair)} onClick={event => { event.stopPropagation(); quickCreate.mutate({ agentId: group.agentId, cwd: workspace.cwd }); }} className="grid h-4 w-4 shrink-0 place-items-center rounded opacity-0 transition-opacity hover:bg-zinc-200 hover:text-zinc-800 focus:opacity-100 group-hover/agent:opacity-100 max-md:opacity-100 disabled:opacity-50">{creatingPair?.agentId === group.agentId && creatingPair.cwd === workspace.cwd ? <RefreshCw size={10} className="animate-spin"/> : <Plus size={10}/>}</button><GripVertical size={10} className="shrink-0 cursor-grab text-zinc-300 opacity-0 transition-opacity group-hover/agent:opacity-100"/><span className="shrink-0 tabular-nums">{group.sessions.length}</span></div>
            {!agentCollapsed && <div className="ml-3 border-l border-zinc-200/70 pl-1.5">{group.sessions.map(session => <div key={session.id}>
              {renderSessionRow(session, false, false, itemDrag(`sessions:${groupKey}`, session.id, (from, to) => reorderSessions(groupKey, from, to), session.id))}
              {/* 侧边会话缩进挂在主会话下面——归属关系比时间序更重要，
                  否则用户在一长串同名会话里找不到自己从哪个会话派生的。 */}
              {(group.sideChats.get(session.id) ?? []).map(child => renderSessionRow(child, true, false, sessionDrag(child.id)))}
            </div>)}</div>}
          </div>;
          })}</div>}
        </div>;
      })}
        </div>}
        </section>
      </> : <div className="px-3 py-6 text-xs leading-5 text-zinc-500">当前分类暂无会话。</div>}
      </div>
      {/* 两个入口都开弹窗：归档列表早先挂在会话树最底部，点了要滚到底才看得见，看起来像点不开。 */}
      <div className="min-w-[268px] px-2 pb-1 flex flex-col gap-1"><button type="button" onClick={() => { setSidebarOpen(false); setScheduleOpen(true); }} className="flex h-9 w-full items-center gap-2.5 rounded-xl px-3 text-[12px] font-medium text-zinc-600 transition-[background-color,color,transform] duration-200 hover:bg-white/75 hover:text-zinc-900 active:scale-[.99]"><AlarmClock size={14}/><span>定时任务</span></button><button type="button" onClick={() => { setSidebarOpen(false); setArchivedOpen(true); }} className="flex h-9 w-full items-center gap-2.5 rounded-xl px-3 text-[12px] font-medium text-zinc-600 transition-[background-color,color,transform] duration-200 hover:bg-white/75 hover:text-zinc-900 active:scale-[.99]"><Archive size={14}/><span>归档会话</span><span className="ml-auto text-[10px] tabular-nums text-zinc-400">{archivedSessions.length}</span></button></div>

      <div className="min-w-[268px] px-2 pb-2 flex flex-col gap-1"><button type="button" onClick={() => { setSidebarOpen(false); setImportOpen(true); }} className="flex h-9 w-full items-center gap-2.5 rounded-xl px-3 text-[12px] font-medium text-zinc-600 transition-[background-color,color,transform] duration-200 hover:bg-white/75 hover:text-zinc-900 active:scale-[.99]"><FolderOpen size={14}/><span>导入外部会话</span></button><button type="button" onClick={() => setAgentConfigOpen(true)} className="flex h-9 w-full items-center gap-2.5 rounded-xl px-3 text-[12px] font-medium text-zinc-600 transition-[background-color,color,transform] duration-200 hover:bg-white/75 hover:text-zinc-900 active:scale-[.99]"><Bot size={14}/><span>Agent 设置</span></button><button type="button" onClick={() => setLarkOpen(true)} className="flex h-9 w-full items-center gap-2.5 rounded-xl px-3 text-[12px] font-medium text-zinc-600 transition-[background-color,color,transform] duration-200 hover:bg-white/75 hover:text-zinc-900 active:scale-[.99]"><Settings2 size={14}/><span>飞书设置</span></button></div>
      <div className="min-w-[268px] border-t border-zinc-200 px-4 py-2.5 text-[10px] text-zinc-400"><SelfUpdateNotice enabled={!webDenied}/></div>
      </div>
      {/* 收起态细条（仅桌面）：展开 + 快捷新建 + 两个设置入口 */}
      <div className={`hidden h-full w-full flex-col items-center gap-1 py-3 ${sidebarCollapsed ? 'md:flex' : ''}`}>
        <HoverTooltip content="展开会话列表"><button type="button" onClick={() => setSidebarCollapsed(false)} aria-label="展开会话列表" className="grid h-8 w-8 place-items-center rounded-lg text-zinc-600 hover:bg-white hover:text-zinc-900"><PanelLeftOpen size={16}/></button></HoverTooltip>
        <HoverTooltip content="新建对话"><button type="button" onClick={startNewConversation} aria-label="新建对话" className="grid h-8 w-8 place-items-center rounded-lg text-zinc-600 hover:bg-white hover:text-zinc-900"><Plus size={16}/></button></HoverTooltip>
        <HoverTooltip content="搜索会话（⌘K）"><button type="button" onClick={openSearch} aria-label="搜索会话" className="grid h-8 w-8 place-items-center rounded-lg text-zinc-600 hover:bg-white hover:text-zinc-900"><Search size={16}/></button></HoverTooltip>

        <span className="mt-auto flex flex-col items-center gap-1">
          <HoverTooltip content="定时任务"><button type="button" onClick={() => setScheduleOpen(true)} aria-label="定时任务" className="grid h-8 w-8 place-items-center rounded-lg text-zinc-500 hover:bg-white hover:text-zinc-900"><AlarmClock size={15}/></button></HoverTooltip><HoverTooltip content="归档会话"><button type="button" onClick={() => setArchivedOpen(true)} aria-label="归档会话" className="grid h-8 w-8 place-items-center rounded-lg text-zinc-500 hover:bg-white hover:text-zinc-900"><Archive size={15}/></button></HoverTooltip>
          <HoverTooltip content="导入外部会话"><button type="button" onClick={() => { setSidebarCollapsed(false); setImportOpen(true); }} aria-label="导入外部会话" className="grid h-8 w-8 place-items-center rounded-lg text-zinc-500 hover:bg-white hover:text-zinc-900"><FolderOpen size={15}/></button></HoverTooltip><HoverTooltip content="Agent 设置"><button type="button" onClick={() => { setSidebarCollapsed(false); setAgentConfigOpen(true); }} aria-label="Agent 设置" className="grid h-8 w-8 place-items-center rounded-lg text-zinc-500 hover:bg-white hover:text-zinc-900"><Bot size={15}/></button></HoverTooltip>
          <HoverTooltip content="飞书设置"><button type="button" onClick={() => { setSidebarCollapsed(false); setLarkOpen(true); }} aria-label="飞书设置" className="grid h-8 w-8 place-items-center rounded-lg text-zinc-500 hover:bg-white hover:text-zinc-900"><Settings2 size={15}/></button></HoverTooltip>
        </span>
      </div>
    </aside>
    <main className="flex min-w-0 flex-1">
      {primarySession ? <>
        {/* lg 以下右栏全屏覆盖主区（小屏不并排）；lg 以上并排、宽度可拖拽（PaneHost 负责）。 */}
        <div className={`flex min-w-0 flex-1 ${paneOpen ? 'max-lg:hidden' : ''}`}><SessionPane key={`primary:${primarySession.id}`} session={primarySession} agent={agents.data?.find(agent => agent.id === primarySession.agentId)} pane="primary" onOpenSidebar={() => setSidebarOpen(true)} paneOpen={paneOpen} onTogglePane={() => { setPaneMenuAnchor(undefined); togglePane(); }}/></div>
        {(paneOpen || mountedTabs.length > 0) && <PaneHost tabs={tabs} mountedTabs={mountedTabs} activeTabId={activeTabId} visible={paneOpen} shortcuts={shortcuts} acceptsDrop={Boolean(dragItem?.sessionId)} onDropSession={() => { const dropped = dragItem?.sessionId; setDragItem(undefined); setDragOverItem(undefined); if (dropped) openSessionInPane(dropped); }} onActivate={activateTab} onClose={closeTab} onAdd={anchor => setPaneMenuAnchor(anchor)} onPick={openPaneKind} onHide={() => { setPaneMenuAnchor(undefined); togglePane(); }}>
          {Object.fromEntries(mountedTabs.map(tab => [tab.id,
            // 终端与文件锚定主会话；会话类标签用自己的 sessionId。三者都是廉价组件
            // （终端/文件只读会话的 cwd，不启进程），所以可以全部常驻挂载。
            tab.kind === 'terminal' ? <TerminalPanel key={tab.id} sessionId={tab.anchorSessionId ?? primarySession.id}/>
            : tab.kind === 'files' ? <FileExplorerPanel key={tab.id} sessionId={tab.anchorSessionId ?? primarySession.id} cwd={sortedSessions.find(item => item.id === tab.anchorSessionId)?.cwd ?? primarySession.cwd} initialPath={tab.filePath}/>
            : tab.kind === 'raw' ? <RawLogPanel key={tab.id} sessionId={tab.anchorSessionId ?? primarySession.id} active={paneOpen && tab.id === activeTabId}/>
            : (() => { const session = sortedSessions.find(item => item.id === tab.sessionId); return session ? <SessionPane key={tab.id} session={session} agent={agents.data?.find(agent => agent.id === session.agentId)} pane="secondary" onOpenSidebar={() => setSidebarOpen(true)} onOpenRawLog={openRawLog}/> : <div className="grid h-full place-items-center text-[12px] text-zinc-400">会话已不存在。</div>; })()
          ]))}
        </PaneHost>}
        {/* 副屏整个收起时它带着 hidden、收不到 dragover，所以拖拽期间单独在右缘补一个落点。
            只在拖拽进行中出现，不提前改 paneOpen，避免拖到一半放弃却把副屏留开。 */}
        {dragItem?.sessionId && !paneOpen && <div onDragOver={event => event.preventDefault()} onDrop={event => { event.preventDefault(); const dropped = dragItem?.sessionId; setDragItem(undefined); setDragOverItem(undefined); if (dropped) openSessionInPane(dropped); }} className="fixed inset-y-0 right-0 z-40 flex w-20 items-center justify-center border-l-2 border-dashed border-zinc-400 bg-zinc-900/5">
          <span className="text-[11px] font-medium text-zinc-600 [writing-mode:vertical-rl]">放到这里，在副屏打开</span>
        </div>}
      </> : <div className="relative flex flex-1 items-center justify-center overflow-y-auto px-4 py-8 sm:px-8"><span className="absolute left-3 top-3 md:hidden"><IconButton label="打开会话列表" onClick={() => setSidebarOpen(true)}><Menu size={17}/></IconButton></span><DraftComposer textareaRef={draftTextareaRef} agents={agents.data ?? []} sessions={sessions.data ?? []} onCreated={session => selectSession(session.id)}/></div>}
    </main>
    {paneMenuAnchor && <PaneTypeMenu anchor={paneMenuAnchor} shortcuts={shortcuts} onPick={openPaneKind} onClose={() => setPaneMenuAnchor(undefined)}/>}
    {actionError && <div className="fixed bottom-4 left-1/2 z-50 -translate-x-1/2 rounded-lg border border-red-200 bg-red-50 px-3.5 py-2 text-[12px] text-red-700 shadow-[0_12px_32px_rgba(24,24,27,.12)]"><button type="button" onClick={() => setActionError(undefined)} className="mr-2 font-medium underline">关闭</button>{actionError}</div>}
    {larkOpen && <LarkConfigModal agents={agents.data ?? []} onClose={() => setLarkOpen(false)}/>}
    {agentConfigOpen && <AgentConfigDialog onClose={() => setAgentConfigOpen(false)}/>}
    {scheduleOpen && <ScheduleDialog sessions={sortedSessions} onClose={() => setScheduleOpen(false)} onOpenSession={selectSession}/>}
    {archivedOpen && <ArchivedSessionsDialog sessions={archivedSessions} agents={agents.data ?? []} onClose={() => setArchivedOpen(false)} onOpenSession={id => { setArchivedOpen(false); selectSession(id); }}/>}
    {importOpen && <ImportSessionDialog agents={agents.data ?? []} onClose={() => setImportOpen(false)} onImported={session => selectSession(session.id)}/>}
    {agentPicker && <AgentPickerMenu cwd={agentPicker.cwd} top={agentPicker.top} left={agentPicker.left} agents={agents.data ?? []} creatingPair={creatingPair} onSelect={agentId => quickCreate.mutate({ agentId, cwd: agentPicker.cwd })} onClose={() => setAgentPicker(null)}/>}
    {searchOpen && <SessionSearchDialog agents={agents.data ?? []} sessions={sessions.data ?? []} onClose={() => setSearchOpen(false)} onOpen={session => { setSearchOpen(false); selectSession(session.id); }}/>}
  </div></TooltipProvider>;
}
