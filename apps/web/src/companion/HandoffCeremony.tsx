import { useEffect, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowRight, ChevronDown, CircleAlert, CircleCheck, Dices, Eye, LoaderCircle, PawPrint, RefreshCw, RotateCcw, Send, X } from 'lucide-react';
import { api, type Agent, type AgentModel, type HandoffSuccessorConfig, type HandoffView, type LifecycleReason } from '../api';
import { CompactSelect } from '../CompactSelect';
import { agentModelsQueryKey, loadAgentModels, readCachedAgentModels } from '../model-cache';
import { useModalFocusTrap } from '../useModalFocusTrap';
import { Kitten } from './Kitten';
import { pickKittenName } from './companion-model';
import { burst } from './effects';
import {
  ceremonyPhase, ceremonyPhaseTitle, ceremonySteps, formatReason, generationLabel, handoffInvite, isCeremonyFinal,
  isCeremonyRunning, outcomeLabel, outcomeTone, stageCatLabel, transferKindLabel, transferStatusLabel, transferSummary,
  triggerLabel, type CeremonyPhase
} from './lifecycle-model';
import { useCompanion, useCompanionNav, useLifecycleOverview } from './useCompanion';
import { useCompanionStore } from './companion-store';
import { bi, useBi } from '../i18n';

const errorText = (error: unknown) => error instanceof Error ? error.message : bi("操作失败", "Action failed");
const NOTE_COLORS = ['#fde68a', '#bfdbfe', '#fecaca'];

/**
 * 交接仪式：状态机直接驱动画面。
 * 邀请（为什么 + 起名 + 确认）→ 老猫告别、打包 → 新猫蹦出来 → 便签飞过去 → 老猫戴上帽子走远 → 完成。
 * 仪式在服务端后台执行，这里只轮询进度；关掉弹窗不会打断仪式，失败时服务端自动回滚。
 */
export function HandoffCeremony() {
  const ceremony = useCompanionStore(store => store.ceremony);
  if (!ceremony) return null;
  return <CeremonyDialog key={ceremony.nonce} initialId={ceremony.handoffId}/>;
}

function CeremonyDialog({ initialId }: { initialId?: string }) {
  const L = useBi();
  const qc = useQueryClient();
  const info = useCompanion();
  const nav = useCompanionNav();
  const panelRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const close = () => useCompanionStore.getState().closeCeremony();
  useModalFocusTrap({ panel: panelRef, initial: closeRef, dismissible: true, onDismiss: close });

  const [handoffId, setHandoffId] = useState<string | undefined>(initialId ?? info.lifecycle?.handoff?.id);
  const [name, setName] = useState(info.name);
  const [successor, setSuccessor] = useState<HandoffSuccessorConfig>({});
  const [customized, setCustomized] = useState(false);
  const [error, setError] = useState<string>();
  const [syncNotice, setSyncNotice] = useState<{ ok: boolean; message: string }>();
  const overview = useLifecycleOverview();
  const detail = useQuery({
    queryKey: ['assistant-handoff', handoffId],
    queryFn: () => api.assistantHandoff(handoffId!),
    enabled: Boolean(handoffId),
    retry: false,
    refetchInterval: query => {
      const state = query.state.data?.handoff.state;
      return isCeremonyRunning(state) ? 700 : isCeremonyFinal(state) ? false : 4_000;
    }
  });
  const handoff: HandoffView | undefined = detail.data?.handoff ?? (handoffId ? undefined : overview.data?.handoff ?? undefined);
  const phase = ceremonyPhase(handoff?.state);
  const currentAgentId = handoff?.fromCat?.agentId ?? overview.data?.cat?.agentId ?? info.mainSession?.agentId ?? '';
  const agentId = successor.agentId ?? currentAgentId;
  const agentChanged = Boolean(agentId && currentAgentId && agentId !== currentAgentId);
  const agentsQuery = useQuery({ queryKey: ['agents'], queryFn: () => api.agents(), enabled: phase === 'invite', staleTime: 60_000 });
  const modelsQuery = useQuery({
    queryKey: agentModelsQueryKey(agentId),
    queryFn: () => loadAgentModels(agentId),
    enabled: phase === 'invite' && Boolean(agentId),
    initialData: () => agentId ? readCachedAgentModels(agentId) : undefined,
    initialDataUpdatedAt: 0,
    staleTime: 60_000
  });
  const model = successor.model !== undefined
    ? successor.model
    : agentChanged ? modelsQuery.data?.defaultModel ?? '' : overview.data?.cat?.model ?? info.mainSession?.model ?? '';
  const reasoningEffort = successor.reasoningEffort !== undefined
    ? successor.reasoningEffort
    : agentChanged ? modelsQuery.data?.defaultReasoningEffort ?? '' : overview.data?.cat?.reasoningEffort ?? info.mainSession?.reasoningEffort ?? '';

  // 拿到交接/档案时把当前配置填进选择器；用户改过之后不再被轮询覆盖。
  useEffect(() => {
    if (customized) return;
    const cat = overview.data?.cat;
    const source: HandoffSuccessorConfig | undefined = handoff?.successorConfig
      ?? (cat ? { ...(cat.agentId ? { agentId: cat.agentId } : {}), ...(cat.model ? { model: cat.model } : {}), ...(cat.reasoningEffort ? { reasoningEffort: cat.reasoningEffort } : {}) } : undefined);
    if (!source) return;
    setSuccessor(current => JSON.stringify(current) === JSON.stringify(source) ? current : source);
  }, [customized, handoff?.successorConfig, overview.data?.cat]);

  // 仪式结束：主会话、便签、会话列表都变了，刷新一遍。
  const finalState = isCeremonyFinal(handoff?.state) ? handoff?.state : undefined;
  useEffect(() => {
    if (!finalState) return;
    void qc.invalidateQueries({ queryKey: ['assistant-state'] });
    void qc.invalidateQueries({ queryKey: ['assistant-lifecycle'] });
    void qc.invalidateQueries({ queryKey: ['sessions'] });
  }, [finalState, qc]);

  const refresh = (view: HandoffView) => {
    setHandoffId(view.id);
    qc.setQueryData(['assistant-handoff', view.id], { handoff: view });
    void qc.invalidateQueries({ queryKey: ['assistant-state'] });
  };
  const start = useMutation({
    mutationFn: async () => {
      const trimmed = name.trim();
      const config = customized ? { agentId, model, reasoningEffort } : {};
      const proposal = handoff?.state === 'proposed' ? handoff : (await api.assistantProposeHandoff({ reason: L("你在网页上发起了交接仪式", "Handover ceremony initiated from Web"), ...config })).handoff;
      setHandoffId(proposal.id);
      return (await api.assistantConfirmHandoff(proposal.id, { ...(trimmed && trimmed !== info.name ? { name: trimmed } : {}), ...config })).handoff;
    },
    onSuccess: view => { setError(undefined); refresh(view); },
    onError: value => setError(errorText(value))
  });
  const decline = useMutation({
    mutationFn: () => api.assistantCancelHandoff(handoff!.id),
    onSuccess: view => { refresh(view.handoff); close(); },
    onError: value => setError(errorText(value))
  });
  const resend = useMutation({
    mutationFn: () => api.assistantResendHandoff(handoff!.id),
    onSuccess: view => refresh(view.handoff),
    onError: value => setError(errorText(value))
  });
  // 换代完成后把飞书机器人名称/头像同步成新猫；不支持时后端会带原因回来，这里原样展示。
  const syncBot = useMutation({
    mutationFn: () => api.handoverSyncBot(handoff!.fromSessionId),
    onSuccess: result => setSyncNotice({ ok: result.ok, message: result.message }),
    onError: value => setSyncNotice({ ok: false, message: errorText(value) })
  });

  const reasons: LifecycleReason[] = handoff?.reasons?.length ? handoff.reasons : (overview.data?.reasons ?? []).filter(reason => reason.level === 'handoff');
  const oldStage = handoff?.fromCat?.lifeStage ?? info.stage ?? 'adult';
  const generation = handoff?.fromCat?.generation ?? info.generation ?? 1;
  const successorName = handoff?.successorName ?? (name.trim() || info.name);
  const agentOptions = (agentsQuery.data ?? []).filter(agent => !agent.disabled);
  const pickAgent = (next: string) => { setCustomized(true); setSuccessor({ agentId: next }); };
  const pickModel = (next: string) => { setCustomized(true); setSuccessor(current => ({ ...current, agentId: current.agentId ?? agentId, model: next })); };
  const pickReasoning = (next: string) => { setCustomized(true); setSuccessor(current => ({ ...current, agentId: current.agentId ?? agentId, reasoningEffort: next })); };
  const busy = start.isPending || isCeremonyRunning(handoff?.state);

  return <div className="ui-overlay fixed inset-0 z-[70] grid place-items-center bg-zinc-950/35 p-2 sm:p-4" onMouseDown={event => { if (event.currentTarget === event.target) close(); }}>
    <div ref={panelRef} role="dialog" aria-modal="true" aria-label={L("交接仪式", "Handover Ceremony")} data-phase={phase} className="ui-dialog flex max-h-[90dvh] w-full max-w-lg flex-col overflow-hidden rounded-[16px] border border-zinc-200 bg-white shadow-[0_24px_80px_rgba(24,24,27,.24)]">
      <div className="flex h-12 shrink-0 items-center gap-2 border-b border-zinc-100 px-4">
        <PawPrint size={16} className="text-zinc-700"/>
        <h2 className="text-[15px] font-semibold text-zinc-900">{ceremonyPhaseTitle[phase]}</h2>
        {handoff?.outcome && <OutcomeBadge outcome={handoff.outcome}/>}
        <button ref={closeRef} type="button" onClick={close} aria-label={busy ? L("收起（仪式会在后台继续）", "Minimize (ceremony continues in background)") : L("关闭", "Close")} title={busy ? L("收起；仪式会在后台继续", "Minimize (continues in background)") : L("关闭", "Close")} className="ml-auto grid h-8 w-8 place-items-center rounded-lg text-zinc-400 hover:bg-zinc-100 hover:text-zinc-800"><X size={16}/></button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-5 pb-5 pt-4">
        <CeremonyStage phase={phase} oldStage={oldStage} oldName={handoff?.fromCat?.name ?? info.name} newName={successorName} generation={generation}/>
        {phase === 'invite' && <InviteBody
          speech={handoff ? handoffInvite(oldStage, info.name) : L(`${info.name}要把工作交给第 ${generation + 1} 代吗？`, `Hand over ${info.name}'s work to Generation ${generation + 1}?`)}
          reasons={reasons}
          trigger={handoff?.trigger}
          note={handoff?.reason ?? undefined}
          name={name}
          onName={setName}
          currentName={info.name}
          agents={agentOptions}
          models={modelsQuery.data?.models ?? []}
          reasoningEfforts={modelsQuery.data?.reasoningEfforts ?? []}
          agentId={agentId}
          model={model}
          reasoningEffort={reasoningEffort}
          customized={customized}
          modelsLoading={modelsQuery.isFetching}
          onAgent={pickAgent}
          onModel={pickModel}
          onReasoning={pickReasoning}
        />}
        {phase !== 'invite' && handoff && <ProgressBody handoff={handoff} phase={phase}/>}
        {error && <div className="mt-3 flex items-start gap-1.5 rounded-lg border border-red-200 bg-red-50 px-2.5 py-2 text-[12px] leading-5 text-red-700"><CircleAlert size={14} className="mt-0.5 shrink-0"/>{error}</div>}
        {syncNotice && <div className={`mt-3 flex items-start gap-1.5 rounded-lg border px-2.5 py-2 text-[12px] leading-5 ${syncNotice.ok ? 'border-emerald-200 bg-emerald-50 text-emerald-800' : 'border-amber-200 bg-amber-50 text-amber-800'}`}>
          {syncNotice.ok ? <CircleCheck size={14} className="mt-0.5 shrink-0"/> : <CircleAlert size={14} className="mt-0.5 shrink-0"/>}{syncNotice.message}
        </div>}
      </div>
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-t border-zinc-100 px-4 py-3">
        {phase === 'invite' && <>
          {handoff?.state === 'proposed' && <button type="button" disabled={decline.isPending || start.isPending} onClick={() => decline.mutate()} className="h-9 rounded-lg px-3 text-[13px] text-zinc-600 hover:bg-zinc-100 disabled:opacity-40">{L("再陪我一阵", "Stay a bit longer")}</button>}
          <button type="button" onClick={close} className="h-9 rounded-lg px-3 text-[13px] text-zinc-500 hover:bg-zinc-100">{L("以后再说", "Later")}</button>
          <button type="button" disabled={start.isPending || !info.adopted} onClick={() => start.mutate()} className="ml-auto inline-flex h-9 items-center gap-1.5 rounded-full bg-zinc-900 px-4 text-[13px] font-medium text-white hover:bg-zinc-700 disabled:opacity-40">
            {start.isPending ? <LoaderCircle size={14} className="animate-spin"/> : <PawPrint size={14}/>}{L("开始交接", "Start Handover")}
          </button>
        </>}
        {phase !== 'invite' && !isCeremonyFinal(handoff?.state) && <span className="flex items-center gap-1.5 text-[12px] text-zinc-500"><LoaderCircle size={13} className="animate-spin"/>{L("仪式进行中，可以先收起，结束后小猫会冒泡告诉你", "Ceremony running — you can close this window and be notified when done")}</span>}
        {phase === 'done' && handoff && <>
          <button type="button" onClick={() => { close(); nav.openSession(handoff.fromSessionId); }} className="inline-flex h-9 items-center gap-1.5 rounded-lg px-3 text-[13px] text-zinc-600 hover:bg-zinc-100"><Eye size={14}/>{L("前任的会话（只读）", "Predecessor Session (Read-only)")}</button>
          <button type="button" disabled={syncBot.isPending} onClick={() => syncBot.mutate()} className="inline-flex h-9 items-center gap-1.5 rounded-lg px-3 text-[13px] text-zinc-600 hover:bg-zinc-100 disabled:opacity-40"><RefreshCw size={14} className={syncBot.isPending ? 'animate-spin' : ''}/>{syncBot.isPending ? L("同步中…", "Syncing…") : L("同步飞书机器人", "Sync Lark Bot")}</button>
          {handoff.outcome === 'partial' && !handoff.briefingTaskId && <button type="button" disabled={resend.isPending} onClick={() => resend.mutate()} className="inline-flex h-9 items-center gap-1.5 rounded-lg px-3 text-[13px] text-zinc-600 hover:bg-zinc-100 disabled:opacity-40"><Send size={14}/>{L("重发交接说明", "Resend Handover Brief")}</button>}
          <button type="button" onClick={() => { close(); nav.openMain(handoff.toSessionId ?? undefined); }} className="ml-auto inline-flex h-9 items-center gap-1.5 rounded-full bg-zinc-900 px-4 text-[13px] font-medium text-white hover:bg-zinc-700">{L("去见", "Meet ")}{handoff.successorName ?? L("新猫", "Successor")}<ArrowRight size={14}/></button>
        </>}
        {(phase === 'rolled_back' || phase === 'cancelled') && <button type="button" onClick={close} className="ml-auto h-9 rounded-full bg-zinc-900 px-4 text-[13px] font-medium text-white hover:bg-zinc-700">{L("知道了", "Got it")}</button>}
      </div>
    </div>
  </div>;
}

function OutcomeBadge({ outcome }: { outcome: NonNullable<HandoffView['outcome']> }) {
  const tone = outcomeTone[outcome];
  const classes = tone === 'ok' ? 'bg-emerald-50 text-emerald-700' : tone === 'warn' ? 'bg-amber-50 text-amber-700' : 'bg-red-50 text-red-700';
  return <span className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${classes}`}>{outcomeLabel[outcome]}</span>;
}

/** 舞台：老猫和新猫。动作完全由画面阶段决定，CSS 负责动画。 */
function CeremonyStage({ phase, oldStage, oldName, newName, generation }: { phase: CeremonyPhase; oldStage: NonNullable<HandoffView['fromCat']>['lifeStage']; oldName: string; newName: string; generation: number }) {
  const kittenRef = useRef<HTMLDivElement>(null);
  const born = phase === 'newborn' || phase === 'transfer' || phase === 'closing' || phase === 'done';
  const retiring = phase !== 'invite' && phase !== 'rolled_back' && phase !== 'cancelled';
  const oldAct = phase === 'farewell' || phase === 'newborn' || phase === 'transfer' ? 'wave' : phase === 'closing' || phase === 'done' ? 'leave' : undefined;
  const newAct = phase === 'newborn' ? 'pop' : phase === 'transfer' ? 'bounce' : undefined;
  const celebrated = useRef(false);
  useEffect(() => {
    if (phase !== 'newborn' && phase !== 'done') return;
    if (phase === 'done' && celebrated.current) return;
    celebrated.current = true;
    const timer = window.setTimeout(() => { const rect = kittenRef.current?.getBoundingClientRect(); if (rect) burst(rect, 'hearts', phase === 'done' ? 10 : 6); }, 420);
    return () => window.clearTimeout(timer);
  }, [phase]);
  return <div className="ui-ceremony-stage" aria-hidden="true">
    <span className="ui-ceremony-ground"/>
    <div className="ui-ceremony-cat" data-act={oldAct}>
      <Kitten size={78} stage={oldStage} retired={retiring} mood={phase === 'rolled_back' ? 'sad' : phase === 'invite' ? 'idle' : 'happy'} collar interactive={false}/>
      <span className="ui-ceremony-tag">{generationLabel(generation)} · {oldName}</span>
    </div>
    {phase === 'transfer' && <div className="ui-ceremony-notes">
      {NOTE_COLORS.map((color, index) => <span key={color} className="ui-ceremony-note" data-flying="" style={{ background: color, animationDelay: `${index * 0.45}s` }}/>)}
    </div>}
    <div ref={kittenRef} className="ui-ceremony-cat" data-hidden={born ? undefined : ''} data-act={newAct}>
      <Kitten size={62} stage="kitten" mood={phase === 'done' ? 'celebrating' : 'curious'} collar={phase === 'done'} drawCollar={phase === 'done'} interactive={false}/>
      <span className="ui-ceremony-tag">{generationLabel(generation + 1)} · {newName}</span>
    </div>
  </div>;
}

function InviteBody({
  speech, reasons, trigger, note, name, onName, currentName,
  agents, models, reasoningEfforts, agentId, model, reasoningEffort, customized, modelsLoading,
  onAgent, onModel, onReasoning
}: {
  speech: string; reasons: LifecycleReason[]; trigger?: HandoffView['trigger']; note?: string; name: string; onName(value: string): void; currentName: string;
  agents: Agent[]; models: AgentModel[]; reasoningEfforts: AgentModel[]; agentId: string; model: string; reasoningEffort: string;
  customized: boolean; modelsLoading: boolean; onAgent(value: string): void; onModel(value: string): void; onReasoning(value: string): void;
}) {
  const L = useBi();
  const agentLabel = agents.find(agent => agent.id === agentId)?.name ?? (agentId || L("当前 Agent", "Current Agent"));
  const modelLabel = model || L("默认模型", "Default Model");
  const reasoningLabel = reasoningEffort || L("默认强度", "Default Effort");
  return <div className="mt-4 flex flex-col gap-3 text-[13px] leading-6 text-zinc-700">
    <p className="ui-speech !m-0 self-center">{speech}</p>
    <section>
      <h3 className="text-[12px] font-semibold text-zinc-500">{L("为什么", "Reason")}{trigger ? ` · ${triggerLabel[trigger]}` : ''}</h3>
      {note && <p className="mt-0.5 text-[12.5px] text-zinc-600">「{note}」</p>}
      {reasons.length
        ? <ul className="mt-1 flex flex-wrap gap-1.5">{reasons.map(reason => <li key={reason.metric} className="rounded-full bg-orange-50 px-2 py-0.5 text-[12px] text-orange-700">{formatReason(reason)}</li>)}</ul>
        : <p className="mt-0.5 text-[12.5px] text-zinc-500">{L("指标都还在正常范围，交接是你主动发起的。", "All metrics are healthy; this handover was initiated manually.")}</p>}
    </section>
    <section>
      <h3 className="text-[12px] font-semibold text-zinc-500">{L("交接会做什么", "What happens during handover")}</h3>
      <ul className="mt-1 list-disc space-y-0.5 pl-4 text-[12.5px] text-zinc-600">
        <li>{L("旧主会话归档成只读：对话、事件、便签、草稿、watch、文件索引一条不删。", "The previous main session is archived as read-only — all chats, events, notes, drafts, watches, and file indexes stay intact.")}</li>
        <li>{L("新猫默认继承 Agent / 模型 / 思考深度 / 工作目录，也可以在「接班配置」里换；交接说明是系统轮次，不冒充你说话。", "The successor inherits Agent, model, reasoning, and workspace by default (customizable below); the handover brief runs as a system turn.")}</li>
        <li>{L("没做完的事项、watch、待确认草稿转给新猫；已完成的便签折叠进归档区，随时能取出。", "Active tasks, watches, and pending drafts transfer to the successor; completed notes fold into the archive shelf.")}</li>
        <li>{L("任何一步失败都会自动回滚，旧主会话不会丢。", "Any failure rolls back automatically with zero data loss.")}</li>
      </ul>
    </section>
    <label className="flex items-center gap-2">
      <span className="shrink-0 text-[12px] font-semibold text-zinc-500">{L("新猫的名字", "Successor Name")}</span>
      <input value={name} maxLength={16} onChange={event => onName(event.target.value)} aria-label={L("新猫的名字", "Successor Name")} placeholder={currentName} className="ui-field h-8 w-36 rounded-lg border border-zinc-300 bg-white px-2.5 text-[13px] font-semibold text-zinc-900 outline-none"/>
      <button type="button" onClick={() => onName(pickKittenName(name.trim() || currentName))} aria-label={L("随机换一个名字", "Randomize name")} title={L("随机换一个名字", "Randomize name")} className="ui-dice grid h-8 w-8 place-items-center rounded-lg text-zinc-500 hover:bg-zinc-100 hover:text-zinc-900"><Dices size={15}/></button>
      {name.trim() === currentName && <span className="text-[11.5px] text-zinc-400">{L("沿用原来的名字", "Keep same name")}</span>}
    </label>
    <details className="group rounded-lg border border-zinc-200 bg-zinc-50/70 px-2.5 py-2" data-testid="successor-config">
      <summary className="flex cursor-pointer list-none items-center gap-1.5 text-[12px] font-semibold text-zinc-600">
        <ChevronDown size={13} className="shrink-0 transition-transform group-open:rotate-180"/>
        <span className="shrink-0">{L("接班配置", "Successor Configuration")}</span>
        <span className="truncate font-normal text-zinc-400">· {agentLabel} · {modelLabel} · {reasoningLabel}</span>
      </summary>
      <p className="mt-1 text-[11.5px] leading-5 text-zinc-500">{L("只影响新主会话，旧会话仍归档只读；不改就沿用当前配置。", "Applies only to the new main session; leave unchanged to inherit current settings.")}{modelsLoading ? L(" 正在读取可选模型…", " Loading available models…") : ''}</p>
      <div className="mt-1.5 grid gap-2">
        <label className="grid gap-1">
          <span className="text-[11.5px] font-medium text-zinc-500">Agent</span>
          <CompactSelect size="sm" value={agentId} placeholder={L("选择 Agent", "Select Agent")} disabledText={L("没有可用 Agent", "No available Agents")}
            options={agents.map(agent => ({ value: agent.id, label: agent.name, agentId: agent.id }))} onChange={onAgent}/>
        </label>
        <label className="grid gap-1">
          <span className="text-[11.5px] font-medium text-zinc-500">{L("模型", "Model")}</span>
          <CompactSelect size="sm" value={model} placeholder={L("Agent 默认模型", "Agent Default Model")} disabledText={L("该 Agent 暂未提供模型", "No models provided by this Agent")}
            options={[{ value: '', label: L("Agent 默认模型", "Agent Default Model") }, ...models.map(item => ({ value: item.id, label: item.name, meta: item.id }))]}
            onChange={onModel}/>
        </label>
        <label className="grid gap-1">
          <span className="text-[11.5px] font-medium text-zinc-500">{L("思考深度", "Reasoning Effort")}</span>
          <CompactSelect size="sm" value={reasoningEffort} placeholder={L("Agent 默认强度", "Agent Default Effort")} disabledText={L("该 Agent 暂未提供可选强度", "No reasoning options provided")}
            options={[{ value: '', label: L("Agent 默认强度", "Agent Default Effort") }, ...reasoningEfforts.map(item => ({ value: item.id, label: item.name }))]}
            onChange={onReasoning}/>
        </label>
      </div>
      <p className={`mt-1.5 text-[11.5px] ${customized ? 'text-amber-700' : 'text-zinc-400'}`}>
        {customized ? L(`新主会话将使用 ${agentLabel} · ${modelLabel} · ${reasoningLabel}。`, `New main session will use ${agentLabel} · ${modelLabel} · ${reasoningLabel}.`) : L("未改动时逐项继承当前小猫。", "Unchanged fields inherit from the current companion.")}
      </p>
    </details>
  </div>;
}

function ProgressBody({ handoff, phase }: { handoff: HandoffView; phase: CeremonyPhase }) {
  const L = useBi();
  const steps = ceremonySteps(handoff);
  const summary = transferSummary(handoff.transfers);
  return <div className="mt-5 flex flex-col gap-3">
    <div className="ui-ceremony-paws" aria-label={L("仪式进度", "Ceremony Progress")}>
      {steps.map(step => <PawPrint key={step.key} size={18} className="ui-ceremony-paw" data-status={step.status} aria-label={`${step.label}：${step.status}`}/>)}
    </div>
    <ol className="flex flex-col gap-1 text-[12.5px]">
      {steps.map(step => <li key={step.key} className="flex items-start gap-2" data-status={step.status}>
        {step.status === 'done' ? <CircleCheck size={14} className="mt-0.5 shrink-0 text-emerald-600"/> : step.status === 'failed' ? <CircleAlert size={14} className="mt-0.5 shrink-0 text-red-600"/> : step.status === 'active' ? <LoaderCircle size={14} className="mt-0.5 shrink-0 animate-spin text-amber-600"/> : <span className="mt-1 h-3 w-3 shrink-0 rounded-full border border-zinc-300"/>}
        <span className={step.status === 'pending' ? 'text-zinc-400' : 'text-zinc-800'}>{step.label}{step.detail ? <span className="text-zinc-500"> · {step.detail}</span> : null}</span>
      </li>)}
    </ol>
    {phase === 'rolled_back' && <div className="flex items-start gap-1.5 rounded-lg border border-amber-200 bg-amber-50 px-2.5 py-2 text-[12px] leading-5 text-amber-800">
      <RotateCcw size={14} className="mt-0.5 shrink-0"/>
      <span>{handoff.error ? `${handoff.error}。` : L("交接没成功，已经回滚，主会话还是原来那只。", "Handover failed and rolled back; your original companion remains active.")}{L("便签、草稿和 watch 都回到了原处。", "All notes, drafts, and watches were restored.")}</span>
    </div>}
    {handoff.transfers.length > 0 && <section>
      <h3 className="text-[12px] font-semibold text-zinc-500">{L("便签交接 · 转交", "Notes transferred: ")} {summary.transferred}{summary.needsConfirmation ? L(` · 待你确认 ${summary.needsConfirmation}`, ` · ${summary.needsConfirmation} need confirmation`) : ''}{summary.failed ? L(` · 失败 ${summary.failed}`, ` · ${summary.failed} failed`) : ''}{summary.reverted ? L(` · 已回滚 ${summary.reverted}`, ` · ${summary.reverted} reverted`) : ''}</h3>
      <ul className="mt-1 flex max-h-40 flex-col gap-1 overflow-y-auto">
        {handoff.transfers.map(item => <li key={item.id} className="flex items-start gap-2 rounded-md bg-zinc-50 px-2 py-1 text-[12px]" data-status={item.status}>
          <span className={`shrink-0 rounded px-1 text-[10.5px] leading-[18px] ${item.status === 'transferred' ? 'bg-emerald-100 text-emerald-700' : item.status === 'needs_confirmation' ? 'bg-amber-100 text-amber-700' : item.status === 'failed' ? 'bg-red-100 text-red-700' : 'bg-zinc-200 text-zinc-600'}`}>{transferStatusLabel[item.status]}</span>
          <span className="min-w-0 flex-1"><span className="text-zinc-500">{transferKindLabel[item.kind]}</span> <span className="text-zinc-800">{item.title}</span>{item.detail ? <span className="block text-[11.5px] text-zinc-500">{item.detail}</span> : null}</span>
        </li>)}
      </ul>
    </section>}
    {phase === 'done' && <p className="text-[12px] leading-5 text-zinc-500">
      
      {L("第", "Gen ")} {handoff.fromCat?.generation ?? '?'}  {L("代", "")}{handoff.fromCat?.name ?? ''}{L("退休时是", "retired as ")}{stageCatLabel[handoff.fromCat?.lifeStage ?? 'elder']}{L("，旧会话", "; previous session ")} <code className="rounded bg-zinc-100 px-1 font-mono text-[11px]">{handoff.fromSessionId}</code>  {L("已归档只读。", "is archived read-only.")}
      {handoff.package?.closedNotes.archived ? L(` 已完成的 ${handoff.package.closedNotes.archived} 张便签折叠进了归档区。`, ` ${handoff.package.closedNotes.archived} completed note(s) folded into archive.`) : ''}
      {handoff.error ? ` ${handoff.error}` : ''}
    </p>}
  </div>;
}
