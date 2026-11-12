import { useEffect, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowRight, CircleAlert, CircleCheck, Dices, Eye, LoaderCircle, PawPrint, RefreshCw, RotateCcw, Send, X } from 'lucide-react';
import { api, type HandoffView, type LifecycleReason } from '../api';
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

const errorText = (error: unknown) => error instanceof Error ? error.message : '操作失败';
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
  const qc = useQueryClient();
  const info = useCompanion();
  const nav = useCompanionNav();
  const panelRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const close = () => useCompanionStore.getState().closeCeremony();
  useModalFocusTrap({ panel: panelRef, initial: closeRef, dismissible: true, onDismiss: close });

  const [handoffId, setHandoffId] = useState<string | undefined>(initialId ?? info.lifecycle?.handoff?.id);
  const [name, setName] = useState(info.name);
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
      const proposal = handoff?.state === 'proposed' ? handoff : (await api.assistantProposeHandoff({ reason: '你在网页上发起了交接仪式' })).handoff;
      setHandoffId(proposal.id);
      return (await api.assistantConfirmHandoff(proposal.id, trimmed && trimmed !== info.name ? { name: trimmed } : {})).handoff;
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
  const busy = start.isPending || isCeremonyRunning(handoff?.state);

  return <div className="ui-overlay fixed inset-0 z-[70] grid place-items-center bg-zinc-950/35 p-2 sm:p-4" onMouseDown={event => { if (event.currentTarget === event.target) close(); }}>
    <div ref={panelRef} role="dialog" aria-modal="true" aria-label="交接仪式" data-phase={phase} className="ui-dialog flex max-h-[90dvh] w-full max-w-lg flex-col overflow-hidden rounded-[16px] border border-zinc-200 bg-white shadow-[0_24px_80px_rgba(24,24,27,.24)]">
      <div className="flex h-12 shrink-0 items-center gap-2 border-b border-zinc-100 px-4">
        <PawPrint size={16} className="text-zinc-700"/>
        <h2 className="text-[15px] font-semibold text-zinc-900">{ceremonyPhaseTitle[phase]}</h2>
        {handoff?.outcome && <OutcomeBadge outcome={handoff.outcome}/>}
        <button ref={closeRef} type="button" onClick={close} aria-label={busy ? '收起（仪式会在后台继续）' : '关闭'} title={busy ? '收起；仪式会在后台继续' : '关闭'} className="ml-auto grid h-8 w-8 place-items-center rounded-lg text-zinc-400 hover:bg-zinc-100 hover:text-zinc-800"><X size={16}/></button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-5 pb-5 pt-4">
        <CeremonyStage phase={phase} oldStage={oldStage} oldName={handoff?.fromCat?.name ?? info.name} newName={successorName} generation={generation}/>
        {phase === 'invite' && <InviteBody
          speech={handoff ? handoffInvite(oldStage, info.name) : `${info.name}要把工作交给第 ${generation + 1} 代吗？`}
          reasons={reasons}
          trigger={handoff?.trigger}
          note={handoff?.reason ?? undefined}
          name={name}
          onName={setName}
          currentName={info.name}
        />}
        {phase !== 'invite' && handoff && <ProgressBody handoff={handoff} phase={phase}/>}
        {error && <div className="mt-3 flex items-start gap-1.5 rounded-lg border border-red-200 bg-red-50 px-2.5 py-2 text-[12px] leading-5 text-red-700"><CircleAlert size={14} className="mt-0.5 shrink-0"/>{error}</div>}
        {syncNotice && <div className={`mt-3 flex items-start gap-1.5 rounded-lg border px-2.5 py-2 text-[12px] leading-5 ${syncNotice.ok ? 'border-emerald-200 bg-emerald-50 text-emerald-800' : 'border-amber-200 bg-amber-50 text-amber-800'}`}>
          {syncNotice.ok ? <CircleCheck size={14} className="mt-0.5 shrink-0"/> : <CircleAlert size={14} className="mt-0.5 shrink-0"/>}{syncNotice.message}
        </div>}
      </div>
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-t border-zinc-100 px-4 py-3">
        {phase === 'invite' && <>
          {handoff?.state === 'proposed' && <button type="button" disabled={decline.isPending || start.isPending} onClick={() => decline.mutate()} className="h-9 rounded-lg px-3 text-[13px] text-zinc-600 hover:bg-zinc-100 disabled:opacity-40">再陪我一阵</button>}
          <button type="button" onClick={close} className="h-9 rounded-lg px-3 text-[13px] text-zinc-500 hover:bg-zinc-100">以后再说</button>
          <button type="button" disabled={start.isPending || !info.adopted} onClick={() => start.mutate()} className="ml-auto inline-flex h-9 items-center gap-1.5 rounded-full bg-zinc-900 px-4 text-[13px] font-medium text-white hover:bg-zinc-700 disabled:opacity-40">
            {start.isPending ? <LoaderCircle size={14} className="animate-spin"/> : <PawPrint size={14}/>}开始交接
          </button>
        </>}
        {phase !== 'invite' && !isCeremonyFinal(handoff?.state) && <span className="flex items-center gap-1.5 text-[12px] text-zinc-500"><LoaderCircle size={13} className="animate-spin"/>仪式进行中，可以先收起，结束后小猫会冒泡告诉你</span>}
        {phase === 'done' && handoff && <>
          <button type="button" onClick={() => { close(); nav.openSession(handoff.fromSessionId); }} className="inline-flex h-9 items-center gap-1.5 rounded-lg px-3 text-[13px] text-zinc-600 hover:bg-zinc-100"><Eye size={14}/>前任的会话（只读）</button>
          <button type="button" disabled={syncBot.isPending} onClick={() => syncBot.mutate()} className="inline-flex h-9 items-center gap-1.5 rounded-lg px-3 text-[13px] text-zinc-600 hover:bg-zinc-100 disabled:opacity-40"><RefreshCw size={14} className={syncBot.isPending ? 'animate-spin' : ''}/>{syncBot.isPending ? '同步中…' : '同步飞书机器人'}</button>
          {handoff.outcome === 'partial' && !handoff.briefingTaskId && <button type="button" disabled={resend.isPending} onClick={() => resend.mutate()} className="inline-flex h-9 items-center gap-1.5 rounded-lg px-3 text-[13px] text-zinc-600 hover:bg-zinc-100 disabled:opacity-40"><Send size={14}/>重发交接说明</button>}
          <button type="button" onClick={() => { close(); nav.openMain(handoff.toSessionId ?? undefined); }} className="ml-auto inline-flex h-9 items-center gap-1.5 rounded-full bg-zinc-900 px-4 text-[13px] font-medium text-white hover:bg-zinc-700">去见{handoff.successorName ?? '新猫'}<ArrowRight size={14}/></button>
        </>}
        {(phase === 'rolled_back' || phase === 'cancelled') && <button type="button" onClick={close} className="ml-auto h-9 rounded-full bg-zinc-900 px-4 text-[13px] font-medium text-white hover:bg-zinc-700">知道了</button>}
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
      <Kitten size={62} stage="kitten" mood={phase === 'done' ? 'happy' : 'curious'} collar={phase === 'done'} drawCollar={phase === 'done'} interactive={false}/>
      <span className="ui-ceremony-tag">{generationLabel(generation + 1)} · {newName}</span>
    </div>
  </div>;
}

function InviteBody({ speech, reasons, trigger, note, name, onName, currentName }: { speech: string; reasons: LifecycleReason[]; trigger?: HandoffView['trigger']; note?: string; name: string; onName(value: string): void; currentName: string }) {
  return <div className="mt-4 flex flex-col gap-3 text-[13px] leading-6 text-zinc-700">
    <p className="ui-speech !m-0 self-center">{speech}</p>
    <section>
      <h3 className="text-[12px] font-semibold text-zinc-500">为什么{trigger ? ` · ${triggerLabel[trigger]}` : ''}</h3>
      {note && <p className="mt-0.5 text-[12.5px] text-zinc-600">「{note}」</p>}
      {reasons.length
        ? <ul className="mt-1 flex flex-wrap gap-1.5">{reasons.map(reason => <li key={reason.metric} className="rounded-full bg-orange-50 px-2 py-0.5 text-[12px] text-orange-700">{formatReason(reason)}</li>)}</ul>
        : <p className="mt-0.5 text-[12.5px] text-zinc-500">指标都还在正常范围，交接是你主动发起的。</p>}
    </section>
    <section>
      <h3 className="text-[12px] font-semibold text-zinc-500">交接会做什么</h3>
      <ul className="mt-1 list-disc space-y-0.5 pl-4 text-[12.5px] text-zinc-600">
        <li>旧主会话归档成只读：对话、事件、便签、草稿、watch、文件索引一条不删。</li>
        <li>新猫继承 Agent / 模型 / 工作目录，拿着交接包接班；交接说明是系统轮次，不冒充你说话。</li>
        <li>没做完的事项、watch、待确认草稿转给新猫；已完成的便签折叠进归档区，随时能取出。</li>
        <li>任何一步失败都会自动回滚，旧主会话不会丢。</li>
      </ul>
    </section>
    <label className="flex items-center gap-2">
      <span className="shrink-0 text-[12px] font-semibold text-zinc-500">新猫的名字</span>
      <input value={name} maxLength={16} onChange={event => onName(event.target.value)} aria-label="新猫的名字" placeholder={currentName} className="ui-field h-8 w-36 rounded-lg border border-zinc-300 bg-white px-2.5 text-[13px] font-semibold text-zinc-900 outline-none"/>
      <button type="button" onClick={() => onName(pickKittenName(name.trim() || currentName))} aria-label="随机换一个名字" title="随机换一个名字" className="ui-dice grid h-8 w-8 place-items-center rounded-lg text-zinc-500 hover:bg-zinc-100 hover:text-zinc-900"><Dices size={15}/></button>
      {name.trim() === currentName && <span className="text-[11.5px] text-zinc-400">沿用原来的名字</span>}
    </label>
  </div>;
}

function ProgressBody({ handoff, phase }: { handoff: HandoffView; phase: CeremonyPhase }) {
  const steps = ceremonySteps(handoff);
  const summary = transferSummary(handoff.transfers);
  return <div className="mt-5 flex flex-col gap-3">
    <div className="ui-ceremony-paws" aria-label="仪式进度">
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
      <span>{handoff.error ? `${handoff.error}。` : '交接没成功，已经回滚，主会话还是原来那只。'}便签、草稿和 watch 都回到了原处。</span>
    </div>}
    {handoff.transfers.length > 0 && <section>
      <h3 className="text-[12px] font-semibold text-zinc-500">便签交接 · 转交 {summary.transferred}{summary.needsConfirmation ? ` · 待你确认 ${summary.needsConfirmation}` : ''}{summary.failed ? ` · 失败 ${summary.failed}` : ''}{summary.reverted ? ` · 已回滚 ${summary.reverted}` : ''}</h3>
      <ul className="mt-1 flex max-h-40 flex-col gap-1 overflow-y-auto">
        {handoff.transfers.map(item => <li key={item.id} className="flex items-start gap-2 rounded-md bg-zinc-50 px-2 py-1 text-[12px]" data-status={item.status}>
          <span className={`shrink-0 rounded px-1 text-[10.5px] leading-[18px] ${item.status === 'transferred' ? 'bg-emerald-100 text-emerald-700' : item.status === 'needs_confirmation' ? 'bg-amber-100 text-amber-700' : item.status === 'failed' ? 'bg-red-100 text-red-700' : 'bg-zinc-200 text-zinc-600'}`}>{transferStatusLabel[item.status]}</span>
          <span className="min-w-0 flex-1"><span className="text-zinc-500">{transferKindLabel[item.kind]}</span> <span className="text-zinc-800">{item.title}</span>{item.detail ? <span className="block text-[11.5px] text-zinc-500">{item.detail}</span> : null}</span>
        </li>)}
      </ul>
    </section>}
    {phase === 'done' && <p className="text-[12px] leading-5 text-zinc-500">
      第 {handoff.fromCat?.generation ?? '?'} 代{handoff.fromCat?.name ?? ''}退休时是{stageCatLabel[handoff.fromCat?.lifeStage ?? 'elder']}，旧会话 <code className="rounded bg-zinc-100 px-1 font-mono text-[11px]">{handoff.fromSessionId}</code> 已归档只读。
      {handoff.package?.closedNotes.archived ? ` 已完成的 ${handoff.package.closedNotes.archived} 张便签折叠进了归档区。` : ''}
      {handoff.error ? ` ${handoff.error}` : ''}
    </p>}
  </div>;
}
