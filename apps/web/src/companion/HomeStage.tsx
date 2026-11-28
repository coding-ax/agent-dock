import { useEffect, useMemo, useRef, useState, type RefObject } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Dices, FolderOpen, LoaderCircle, MessageSquarePlus, PawPrint, RefreshCw } from 'lucide-react';
import type { OutputPluginCatalogItem, OutputPluginsGlobalConfig } from '@agent-dock/agent-dock-shared';
import { api, type Agent, type AssistantState, type Session } from '../api';
import { AgentIcon } from '../AgentIcon';
import { CompactSelect } from '../CompactSelect';
import type { ComposerEditorHandle } from '../ComposerEditor';
import { workspaceLabel } from '../composer-utils';
import { DraftComposer } from '../DraftComposer';
import { agentModelsQueryKey, loadAgentModels, readCachedAgentModels } from '../model-cache';
import { Kitten } from './Kitten';
import { greeting, pickKittenName, type KittenMood } from './companion-model';
import { anchorRect, burst, KITTEN_TRANSITION_NAME, prefersReducedMotion, useAnchor } from './effects';
import { DEFAULT_KITTEN_NAME, useCompanion, useCompanionNav, type CompanionInfo } from './useCompanion';
import { useCompanionStore, type HomeTarget } from './companion-store';
import { bi, useBi } from '../i18n';

type Phase = 'idle' | 'invite' | 'form' | 'adopting' | 'celebrate';

/** 上次认领时选的 Agent：换新实例、清掉主会话后仍默认回到它，而不是列表里第一个（可能是没登录的）。 */
const LAST_AGENT_KEY = 'agentdock:adopt-agent';

function lastAdoptedAgent(): string {
  try { return typeof window === 'undefined' ? '' : window.localStorage.getItem(LAST_AGENT_KEY) || ''; } catch { return ''; }
}

/** Agent 没登录时 ACP 只回一句 Authentication required；翻译成用户能照着做的提示。 */
function adoptErrorMessage(error: unknown, agentName: string) {
  const raw = error instanceof Error ? error.message : String(error);
  if (/authentication required|not authenticated|unauthorized|\b401\b/i.test(raw)) {
    return bi(`${agentName} 还没在这台机器上登录，暂时开不了工。换一个已登录的 Agent，或先在终端完成 ${agentName} 的登录再回来认领。`, `${agentName} is not signed in on this machine yet. Pick a signed-in Agent or sign in to ${agentName} in your terminal first.`);
  }
  return raw;
}

function PawWalk() {
  const paw = <svg viewBox="0 0 24 24" width="11" height="11" fill="currentColor" aria-hidden="true"><ellipse cx="12" cy="16" rx="5" ry="4.2"/><circle cx="6" cy="9.5" r="2.2"/><circle cx="10" cy="6" r="2.2"/><circle cx="14" cy="6" r="2.2"/><circle cx="18" cy="9.5" r="2.2"/></svg>;
  return <span className="ui-paw-walk">{paw}{paw}{paw}{paw}</span>;
}

function stageLine(info: CompanionInfo) {
  const hello = greeting();
  if (info.mood === 'error') return bi(`${hello}～遇到点小状况，点我进来一起排查吧`, `${hello}~ Hit a small snag — click to troubleshoot together`);
  if (info.counts.needsUser) return bi(`${hello}～有 ${info.counts.needsUser} 件事等你拍板，右边的便签里看看吧`, `${hello}~ ${info.counts.needsUser} item(s) need your decision in the sticky drawer`);
  if (info.counts.planned) return bi(`${hello}～有 ${info.counts.planned} 张计划等你点头，右边的便签里看看`, `${hello}~ ${info.counts.planned} plan(s) await your approval in the sticky drawer`);
  if (info.pendingDrafts) return bi(`${hello}～有 ${info.pendingDrafts} 份草稿等你确认发送`, `${hello}~ ${info.pendingDrafts} draft(s) await your confirmation`);
  if (info.mood === 'tidying') return bi(`${hello}～我正在收拾便签和记忆，马上整理好`, `${hello}~ Tidying up sticky notes and memory, almost done`);
  if (info.busy) return bi(`${hello}～我正在忙，有新想法也可以先丢给我`, `${hello}~ Working on things — feel free to drop new ideas anytime`);
  if (info.counts.review) return bi(`${hello}～${info.counts.review} 张便签做完了，我在验收`, `${hello}~ ${info.counts.review} task(s) finished — reviewing now`);
  if (info.counts.running >= 2) return bi(`${hello}～我正并行盯着 ${info.counts.running} 张便签，有进展会叫你`, `${hello}~ Tracking ${info.counts.running} parallel task(s) — I'll ping you on updates`);
  if (info.counts.running) return bi(`${hello}～我在盯着 ${info.counts.running} 张便签，有进展会叫你`, `${hello}~ Tracking ${info.counts.running} task(s) — I'll ping you on updates`);
  if (info.mood === 'night') return bi(`${hello}～我是${info.name}，点着小月光陪你慢慢来`, `${hello}~ I'm ${info.name}, here with you tonight`);
  return bi(`${hello}～我是${info.name}，有事交给我，我派人去办`, `${hello}~ I'm ${info.name} — tell me what to tackle`);
}

function TargetToggle({ value, name, onChange }: { value: HomeTarget; name: string; onChange(value: HomeTarget): void }) {
  const L = useBi();
  return <div className="ui-target mt-4" data-value={value} role="group" aria-label={L("这条消息发给谁", "Who should receive this message")}>
    <span className="ui-target-pill" aria-hidden="true"/>
    <button type="button" aria-pressed={value === 'new'} onClick={() => onChange('new')} className="ui-target-option"><MessageSquarePlus size={13}/>{L("新对话", "New Chat")}</button>
    <button type="button" aria-pressed={value === 'companion'} onClick={() => onChange('companion')} className="ui-target-option ui-cat-hover-host"><PawPrint size={13}/><span className="max-w-[9rem] truncate">{L("交给", "Send to ")}{name}</span></button>
  </div>;
}

/**
 * 首页：一只等你认领的小猫。
 *
 * 没认领：小猫歪着头问「带我回家吧？」→ 认领卡片（起名、选 Agent）→ 带回家：
 * 小猫蹦一下、冒爱心、项圈一笔画上、名牌荡出来，然后形变进主会话的头像位。
 * 认领后：首页的大猫戴着项圈打招呼，点它进主会话；输入框可以直接「交给它」。
 */
export function HomeStage({ agents, sessions, editorRef, onCreated, askUserQuestionXmlEnabled, outputPluginItems, outputPluginsGlobalConfig }: {
  agents: Agent[];
  sessions: Session[];
  editorRef?: RefObject<ComposerEditorHandle | null>;
  onCreated(session: Session): void;
  askUserQuestionXmlEnabled?: boolean;
  outputPluginItems?: OutputPluginCatalogItem[];
  outputPluginsGlobalConfig?: OutputPluginsGlobalConfig;
}) {
  const L = useBi();
  const qc = useQueryClient();
  const info = useCompanion();
  const nav = useCompanionNav();
  const adoptPending = useCompanionStore(store => store.adoptPending);
  const inviteDismissed = useCompanionStore(store => store.inviteDismissed);
  const homeTarget = useCompanionStore(store => store.homeTarget);
  const celebrateNonce = useCompanionStore(store => store.celebrateNonce);
  const [phase, setPhase] = useState<Phase>('idle');
  const [name, setName] = useState(DEFAULT_KITTEN_NAME);
  const [agentId, setAgentId] = useState(lastAdoptedAgent);
  const [cwd, setCwd] = useState('');
  const [model, setModel] = useState('');
  const [reasoningEffort, setReasoningEffort] = useState('');
  const [error, setError] = useState<string>();
  const [moodOverride, setMoodOverride] = useState<KittenMood>();
  const [adoptedName, setAdoptedName] = useState('');
  const anchor = useAnchor<HTMLDivElement>('kitten-hero');
  const nameInput = useRef<HTMLInputElement>(null);
  const card = useRef<HTMLDivElement>(null);
  const capabilities = useQuery({ queryKey: ['system-capabilities'], queryFn: api.systemCapabilities });

  // 别处（侧栏、右缘、设置）请求认领：到了首页就展开卡片。
  useEffect(() => {
    if (!adoptPending || !info.loaded) return;
    useCompanionStore.getState().consumeAdoption();
    if (!info.adopted) setPhase('form');
  }, [adoptPending, info.loaded, info.adopted]);
  useEffect(() => {
    if (phase !== 'form') return;
    const timer = window.setTimeout(() => { nameInput.current?.focus(); nameInput.current?.select(); }, 260);
    return () => window.clearTimeout(timer);
  }, [phase]);
  useEffect(() => {
    if (!moodOverride) return;
    const timer = window.setTimeout(() => setMoodOverride(undefined), 1_800);
    return () => window.clearTimeout(timer);
  }, [moodOverride]);

  const usableAgents = useMemo(() => agents.filter(agent => !agent.disabled), [agents]);
  const effectiveAgentId = usableAgents.some(agent => agent.id === agentId)
    ? agentId
    : sessions.find(session => !session.archivedAt && usableAgents.some(agent => agent.id === session.agentId))?.agentId || usableAgents[0]?.id || '';
  const selectedAgent = usableAgents.find(agent => agent.id === effectiveAgentId);
  const defaultWorkspace = selectedAgent?.cwd || capabilities.data?.workingDirectory;
  const homeDirectory = capabilities.data?.homeDirectory;
  const workspaceOptions = useMemo(() => {
    const seen = new Set<string>();
    const list: string[] = [];
    for (const path of [defaultWorkspace, ...sessions.map(session => session.cwd)]) {
      if (!path || seen.has(path)) continue;
      seen.add(path);
      list.push(path);
    }
    return list.slice(0, 20);
  }, [defaultWorkspace, sessions]);

  // 认领时就选好模型和思考深度：默认跟随 Agent，也可以当场定下来。
  // 模型目录取决于 Agent（换 Agent 后模型 id 不通用），所以换 Agent 时要清空重查。
  const models = useQuery({
    queryKey: agentModelsQueryKey(effectiveAgentId, model),
    queryFn: () => loadAgentModels(effectiveAgentId, model || undefined),
    enabled: Boolean(effectiveAgentId) && (phase === 'form' || phase === 'adopting'),
    initialData: () => readCachedAgentModels(effectiveAgentId, model || undefined),
    initialDataUpdatedAt: 0,
    refetchOnMount: 'always',
    staleTime: 60_000
  });
  useEffect(() => { setModel(''); setReasoningEffort(''); }, [effectiveAgentId]);
  const defaultModelName = models.data?.models.find(item => item.id === models.data?.defaultModel)?.name ?? models.data?.defaultModel;
  const defaultReasoningName = models.data?.reasoningEfforts.find(item => item.id === models.data?.defaultReasoningEffort)?.name ?? models.data?.defaultReasoningEffort;
  const modelOptions = useMemo(() => models.data?.models.length ? [
    { value: '', label: defaultModelName ? L(`Agent 默认 · ${defaultModelName}`, `Agent Default · ${defaultModelName}`) : L("Agent 默认", "Agent Default") },
    ...models.data.models.map(item => ({ value: item.id, label: item.name, meta: item.name === item.id ? undefined : item.id }))
  ] : [], [defaultModelName, models.data]);
  const reasoningOptions = useMemo(() => models.data?.reasoningEfforts.length ? [
    { value: '', label: defaultReasoningName ? L(`Agent 默认 · ${defaultReasoningName}`, `Agent Default · ${defaultReasoningName}`) : L("Agent 默认", "Agent Default") },
    ...models.data.reasoningEfforts.map(item => ({ value: item.id, label: item.name }))
  ] : [], [defaultReasoningName, models.data]);
  const modelsLoading = models.isPending || models.isFetching;
  const pickDirectory = useMutation({
    mutationFn: api.selectDirectory,
    onSuccess: result => { setCwd(result.path); setError(undefined); },
    onError: err => setError(err instanceof Error ? err.message : String(err))
  });

  const adopt = useMutation({
    mutationFn: () => api.assistantSetMain({
      agentId: effectiveAgentId,
      name: name.trim() || DEFAULT_KITTEN_NAME,
      ...(cwd.trim() ? { cwd: cwd.trim() } : {}),
      ...(model ? { model } : {}),
      ...(reasoningEffort ? { reasoningEffort } : {})
    }),
    onMutate: () => { setError(undefined); setPhase('adopting'); },
    onSuccess: result => {
      try { window.localStorage.setItem(LAST_AGENT_KEY, effectiveAgentId); } catch { /* 隐私模式下不记住，不影响认领 */ }
      const finalName = result.companion?.name ?? (name.trim() || DEFAULT_KITTEN_NAME);
      setAdoptedName(finalName);
      // 先把结果写进缓存：跳转主会话时侧栏、标题栏立刻就是新小猫，不等下一次轮询。
      qc.setQueryData<AssistantState>(['assistant-state'], current => current
        ? { ...current, mainSessionId: result.session.id, mainSession: result.session, companion: result.companion ?? { name: finalName, adoptedAt: new Date().toISOString() } }
        : current);
      qc.setQueryData<Session[]>(['sessions'], current => current ? [result.session, ...current.filter(item => item.id !== result.session.id)] : current);
      void qc.invalidateQueries({ queryKey: ['assistant-state'] });
      void qc.invalidateQueries({ queryKey: ['sessions'] });
      const store = useCompanionStore.getState();
      store.dismissInvite(false);
      store.celebrate();
      setPhase('celebrate');
      window.setTimeout(() => { if (card.current) burst(card.current.getBoundingClientRect(), 'confetti', 18); }, 120);
      window.setTimeout(() => nav.openMain(result.session.id), prefersReducedMotion() ? 900 : 2_300);
    },
    onError: err => {
      setPhase('form');
      setError(adoptErrorMessage(err, selectedAgent?.name ?? effectiveAgentId));
    }
  });

  const startAdopt = () => {
    const nextCwd = cwd.trim();
    if (nextCwd && !nextCwd.startsWith('/')) {
      setError(L("工作目录请填绝对路径，例如 /Users/you/project", "Enter an absolute directory path, e.g., /Users/you/project"));
      return;
    }
    adopt.mutate();
  };

  const declineInvite = () => {
    useCompanionStore.getState().dismissInvite();
    setMoodOverride('sad');
    setPhase('idle');
  };

  const adopted = info.adopted && phase !== 'celebrate';
  const companionMode = adopted && homeTarget === 'companion' && Boolean(info.mainId);
  const showInvite = !info.adopted && info.loaded && (phase === 'invite' || (phase === 'idle' && !inviteDismissed));
  const adopting = phase === 'form' || phase === 'adopting' || phase === 'celebrate';
  const mood: KittenMood = moodOverride ?? (phase === 'celebrate' ? 'celebrating' : phase === 'adopting' ? 'busy' : adopted ? (info.mood === 'curious' ? 'idle' : info.mood) : 'curious');

  const kitten = <div ref={anchor} className="ui-stage-kitten">
    <Kitten size={phase === 'form' || phase === 'adopting' ? 76 : 88} mood={mood} stage={adopted ? info.stage : undefined} collar={adopted || phase === 'celebrate'} drawCollar={phase === 'celebrate'} track typingAware celebrateKey={celebrateNonce} viewTransitionName={KITTEN_TRANSITION_NAME}
      label={adopted ? L(`进入主会话（${info.name}）`, `Open Main Session (${info.name})`) : L("小猫", "Companion")}
      onClick={() => {
        if (adopted) nav.openMain();
        else if (phase === 'idle') setPhase('invite');
      }}/>
  </div>;

  let hero;
  if (adopted) {
    const counts = info.counts;
    hero = <div className="ui-stage">
      <div key={stageLine(info)} className="ui-speech text-center">{stageLine(info)}</div>
      {kitten}
      <span className="ui-name-tag">{info.name}</span>
      <div className="mt-3 flex flex-wrap justify-center gap-1.5">
        {counts.needsUser > 0 && <button type="button" className="ui-status-chip" onClick={() => useCompanionStore.getState().openDrawer({ filter: 'needs_user' })}><span className="ui-note-swatch ui-note-paper-needs"/>{counts.needsUser}  {L("件需要你", " need you")}</button>}
        {counts.planned > 0 && <button type="button" className="ui-status-chip" onClick={() => useCompanionStore.getState().openDrawer({ filter: 'needs_user' })}><span className="ui-note-swatch ui-note-paper-plan"/>{counts.planned}  {L("张计划等你点头", " plan(s) to approve")}</button>}
        {counts.review > 0 && <button type="button" className="ui-status-chip" onClick={() => useCompanionStore.getState().openDrawer({ filter: 'review' })}><span className="ui-note-swatch ui-note-paper-review"/>{counts.review}  {L("张待验收", " to review")}</button>}
        {counts.running > 0 && <button type="button" className="ui-status-chip" onClick={() => useCompanionStore.getState().openDrawer({ filter: 'running' })}><span className="ui-note-swatch ui-note-paper-running"/>{counts.running}  {L("张进行中", " running")}</button>}
        {!counts.open && <button type="button" className="ui-status-chip" onClick={() => useCompanionStore.getState().toggleDrawer()}><span className="ui-note-swatch ui-note-paper-done"/>{counts.closed ? L(`${counts.closed} 张已完成`, `${counts.closed} done`) : L("便签墙", "Sticky Wall")}</button>}
      </div>
      <h1 className="ui-empty-state ui-hero-title mt-5 text-[22px] font-semibold tracking-[-.02em]">{companionMode ? L(`交给${info.name}吧`, `Send to ${info.name}`) : L("有什么要做的？", "What would you like to build?")}</h1>
      <TargetToggle value={homeTarget} name={info.name} onChange={target => { useCompanionStore.getState().setHomeTarget(target); requestAnimationFrame(() => editorRef?.current?.focus()); }}/>
    </div>;
  } else {
    hero = <div className="ui-stage">
      {showInvite && <div className="ui-speech text-center">
        <p className="text-[14px] font-medium text-zinc-900">{L("喵～带我回家吧？", "Meow~ Adopt me as your companion?")}</p>
        <p className="mt-0.5 text-[12.5px] leading-5 text-zinc-500">{L("认领后我就是你的主会话：你说要做什么，我派侧边会话去干、盯进度、做完帮你验收，每件事都贴成便签。", "Once adopted, I'll be your main session: tell me what you need, and I'll dispatch side sessions, track progress, and review results as sticky notes.")}</p>
        <div className="mt-2.5 flex justify-center gap-2">
          <button type="button" onClick={() => setPhase('form')} className="inline-flex h-8 items-center gap-1.5 rounded-full bg-zinc-900 px-3.5 text-[12.5px] font-medium text-white transition-[background-color,transform] hover:bg-zinc-700 active:scale-95"><PawPrint size={13}/>{L("认领它", "Adopt")}</button>
          <button type="button" onClick={declineInvite} className="inline-flex h-8 items-center rounded-full px-3 text-[12.5px] text-zinc-500 transition-colors hover:bg-zinc-100 hover:text-zinc-800">{L("先不了", "Not now")}</button>
        </div>
      </div>}
      {phase === 'celebrate' && <div className="ui-speech text-center">
        <p className="text-[14px] font-medium text-zinc-900">{L("喵！我是", "Meow! I'm ")}{adoptedName}{L("，以后请多指教～", ", ready to help!")}</p>
        <p className="mt-1 inline-flex items-center gap-1.5 text-[12px] text-zinc-500"><PawWalk/>{L("正在去主会话…", "Opening main session…")}</p>
      </div>}
      {kitten}
      {phase === 'celebrate' && <span className="ui-name-tag">{adoptedName}</span>}
      {(phase === 'form' || phase === 'adopting') && <div ref={card} className="ui-adopt-card mt-4">
        <form className="min-w-0" onSubmit={event => { event.preventDefault(); if (!adopt.isPending && effectiveAgentId) startAdopt(); }}>
          <div className="min-w-0 px-5 pt-5">
            <label className="block min-w-0">
              <span className="text-[14px] font-semibold text-zinc-900">{L("给它起个名字", "Give it a name")}</span>
              <span className="mt-2 flex min-w-0 items-center gap-2">
                <input ref={nameInput} value={name} maxLength={16} disabled={phase === 'adopting'} onChange={event => setName(event.target.value)} placeholder={DEFAULT_KITTEN_NAME} aria-label={L("小猫的名字", "Companion name")} className="ui-field h-10 min-w-0 flex-1 rounded-xl border border-zinc-300 bg-white px-3 text-[15px] font-semibold text-zinc-900 outline-none placeholder:font-normal placeholder:text-zinc-400 disabled:opacity-60"/>
                <button type="button" disabled={phase === 'adopting'} onClick={() => setName(current => pickKittenName(current.trim()))} aria-label={L("随机换一个名字", "Randomize name")} title={L("随机换一个名字", "Randomize name")} className="ui-dice grid h-10 w-10 shrink-0 place-items-center rounded-xl border border-zinc-200 text-zinc-500 hover:border-zinc-300 hover:text-zinc-900 disabled:opacity-50"><Dices size={17}/></button>
              </span>
            </label>
            <div className="mt-4 text-[12.5px] font-medium text-zinc-600">{L("它用哪个 Agent 思考", "Which Agent powers it")}</div>
            <div className="mt-2 flex min-w-0 max-w-full flex-wrap gap-1.5">
              {usableAgents.map(agent => <button key={agent.id} type="button" disabled={phase === 'adopting'} aria-pressed={agent.id === effectiveAgentId} onClick={() => { setAgentId(agent.id); setModel(''); setReasoningEffort(''); setError(undefined); }} className="ui-pill-choice"><AgentIcon agentId={agent.id} agentName={agent.name} size={13}/><span className="min-w-0 truncate">{agent.name}</span></button>)}
              {!usableAgents.length && <span className="text-[12.5px] text-zinc-400">{L("还没有可用的 Agent，先到设置里配一个。", "No available Agents yet. Configure one in Settings first.")}</span>}
            </div>
            <div className="mt-4 grid min-w-0 grid-cols-[minmax(0,1fr)] gap-3">
              <div className="min-w-0">
                <div className="text-[12.5px] font-medium text-zinc-600">{L("模型", "Model")} <span className="font-normal text-zinc-400">{L("可选", "Optional")}</span></div>
                <CompactSelect size="sm" options={modelOptions} value={model} placeholder={L("Agent 默认", "Agent Default")} disabledText={modelsLoading ? L("正在读取模型…", "Loading models…") : models.isError ? L("模型列表读取失败，可先不选", "Failed to load models; leave blank for default") : L("这个 Agent 没有提供模型选项", "This Agent provides no model options")} disabled={phase === 'adopting'} onChange={value => { setModel(value); setReasoningEffort(''); }}/>
              </div>
              <div className="min-w-0">
                <div className="text-[12.5px] font-medium text-zinc-600">{L("思考深度", "Reasoning")} <span className="font-normal text-zinc-400">{L("可选", "Optional")}</span></div>
                <CompactSelect size="sm" options={reasoningOptions} value={reasoningEffort} placeholder={L("Agent 默认", "Agent Default")} disabledText={modelsLoading ? L("正在读取…", "Loading…") : models.isError ? L("读取失败，可先不选", "Failed to load; leave blank for default") : L("这个模型没有思考深度选项", "No reasoning options for this model")} disabled={phase === 'adopting'} onChange={setReasoningEffort}/>
              </div>
            </div>
            {models.data?.warning && <p className="mt-1.5 break-words text-[11px] leading-4 text-amber-600 [overflow-wrap:anywhere]">{L("这个 Agent 的配置没读出来：", "Could not read Agent config:")}{models.data.warning}  {L("如果一直这样，先检查它是否已登录。", "If this persists, verify the Agent CLI is logged in.")}</p>}
            <div className="mt-4 text-[12.5px] font-medium text-zinc-600">{L("常驻目录", "Default Workspace")} <span className="font-normal text-zinc-400">{L("可选，派活时仍可指定别的目录", "Optional; you can still pick another directory per task")}</span></div>
            <div className="mt-2 flex min-w-0 max-w-full items-center gap-1.5">
              <input list="adopt-workspaces" value={cwd} disabled={phase === 'adopting'} onChange={event => setCwd(event.target.value)} placeholder={defaultWorkspace ?? L("绝对路径，例如 /Users/you/project", "Absolute path, e.g., /Users/you/project")} aria-label={L("常驻目录", "Default Workspace")} title={cwd.trim() || defaultWorkspace || undefined} spellCheck={false} className="ui-field h-9 w-0 min-w-0 max-w-full flex-1 truncate rounded-xl border border-zinc-300 bg-white px-3 font-mono text-[12.5px] text-zinc-800 outline-none placeholder:font-sans placeholder:text-zinc-400 disabled:opacity-60"/>
              {capabilities.data?.directoryPicker && <button type="button" disabled={phase === 'adopting' || pickDirectory.isPending} onClick={() => pickDirectory.mutate()} title={pickDirectory.isPending ? L("选择中…", "Selecting…") : L("选择目录", "Browse")} aria-label={L("选择目录", "Browse")} className="grid h-9 w-9 shrink-0 place-items-center rounded-xl border border-zinc-200 text-zinc-500 transition-colors hover:border-zinc-300 hover:text-zinc-900 disabled:opacity-50">{pickDirectory.isPending ? <RefreshCw size={14} className="animate-spin"/> : <FolderOpen size={14}/>}</button>}
            </div>
            {cwd.trim() && <p className="mt-1.5 break-all font-mono text-[11.5px] leading-4 text-zinc-400" title={cwd.trim()}>{cwd.trim()}</p>}
            <datalist id="adopt-workspaces">{workspaceOptions.map(path => <option key={path} value={path}>{workspaceLabel(path, homeDirectory)}</option>)}</datalist>
            <p className="mt-1.5 text-[11.5px] leading-4 text-zinc-400">{L("可以直接粘贴任意绝对路径，或从最近用过的目录里挑；留空就用 Agent 自己的默认目录。", "Paste any absolute path or pick a recent folder; leave blank for the Agent's default directory.")}</p>
            <p className="mt-4 rounded-xl bg-zinc-50 px-3 py-2.5 text-[12px] leading-5 text-zinc-500">{L("它会成为你的", "It becomes your ")}<b className="font-medium text-zinc-700">{L("主会话", "Main Session")}</b>{L("：听你说要做什么，派侧边会话去干、盯进度、验收结果。派出去的每件事都是一张便签，贴在屏幕右边，随时划出来看。", ": tell it what you need, and it dispatches side sessions, tracks progress, and reviews results as sticky notes on the right.")}</p>
            {error && <p role="alert" className="mt-3 break-words text-[12px] text-red-600 [overflow-wrap:anywhere]">{error}</p>}
          </div>
          <div className="mt-4 flex min-w-0 flex-wrap items-center justify-end gap-2 border-t border-zinc-100 px-4 py-3">
            <button type="button" disabled={phase === 'adopting'} onClick={() => setPhase(inviteDismissed ? 'idle' : 'invite')} className="h-9 rounded-full px-3.5 text-[13px] text-zinc-500 transition-colors hover:bg-zinc-100 hover:text-zinc-800 disabled:opacity-50">{L("先不了", "Not now")}</button>
            <button type="submit" disabled={phase === 'adopting' || !effectiveAgentId} className="inline-flex h-9 min-w-[8.5rem] items-center justify-center gap-1.5 rounded-full bg-zinc-900 px-4 text-[13px] font-medium text-white transition-[background-color,transform] hover:bg-zinc-700 active:scale-95 disabled:opacity-60">{phase === 'adopting' ? <><PawWalk/>{L("正在带它回家…", "Adopting…")}</> : <><PawPrint size={14}/>{L("带它回家", "Adopt Companion")}</>}</button>
          </div>
        </form>
      </div>}
      {!adopting && <h1 className="ui-empty-state ui-hero-title mt-4 text-[22px] font-semibold tracking-[-.02em]">{L("有什么要做的？", "What would you like to build?")}</h1>}
    </div>;
  }

  return <DraftComposer editorRef={editorRef} agents={agents} sessions={sessions} onCreated={onCreated} hero={hero} collapsed={adopting && !adopted} askUserQuestionXmlEnabled={askUserQuestionXmlEnabled} outputPluginItems={outputPluginItems} outputPluginsGlobalConfig={outputPluginsGlobalConfig}
    companion={companionMode && info.mainSession ? {
      sessionId: info.mainSession.id,
      agentId: info.mainSession.agentId,
      name: info.name,
      onSent: () => {
        // 交出去的那一刻小猫接住：冒一把星星，再形变进主会话。
        const rect = anchorRect(['kitten-hero']);
        if (rect) burst(rect, 'sparkles', 6);
        window.setTimeout(() => nav.openMain(), prefersReducedMotion() ? 0 : 260);
      }
    } : undefined}/>;
}
