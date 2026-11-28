import { useMemo, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Archive, Brush, Eye, Hourglass, LoaderCircle, RefreshCw, RotateCcw } from 'lucide-react';
import { api, type AssistantLifecycle, type CatRecord, type LifecycleConfig, type MaintenanceRun } from '../api';
import { sinceLabel } from './companion-model';
import { useCompanion, useLifecycleOverview } from './useCompanion';
import {
  agePercent, earlyHandoffEntry, formatMetricValue, formatReason, generationLabel, levelLabel, METRIC_KEYS, metricLabel, nextStage,
  outcomeLabel, proposeEarlyHandoff, STAGE_FLOORS, stageBlurb, stageCatLabel, stageLabel
} from './lifecycle-model';
import { bi, useBi } from '../i18n';

const errorText = (error: unknown) => error instanceof Error ? error.message : bi("操作失败", "Action failed");
const catStateLabel: Record<CatRecord['state'], string> = { get active() { return bi("在岗", "Active"); }, get retired() { return bi("已退休", "Retired"); }, get released() { return bi("已解除", "Released"); }, get aborted() { return bi("没接上班", "Did not start"); } };
const runStateLabel: Record<MaintenanceRun['state'], string> = { get running() { return bi("进行中", "Running"); }, get completed() { return bi("已完成", "Completed"); }, get failed() { return bi("失败", "Failed"); }, get interrupted() { return bi("被打断", "Interrupted"); } };
const levelClass = { ok: 'text-zinc-500', tidy: 'text-amber-700', handoff: 'text-orange-700' } as const;
type Drafts = Record<string, string>;

const thresholdDrafts = (config: LifecycleConfig): Drafts => Object.fromEntries(METRIC_KEYS.flatMap(metric => [
  [`${metric}.tidy`, config.thresholds[metric]?.tidy === undefined ? '' : String(config.thresholds[metric].tidy)],
  [`${metric}.handoff`, config.thresholds[metric]?.handoff === undefined ? '' : String(config.thresholds[metric].handoff)]
]));

/**
 * 小猫档案：这一代的年纪和阶段、各项指标对阈值、历代小猫（退休的会话只读可看）、整理和交接记录。
 * 阈值留空表示关掉这一档；所有自动动作都在这里能关掉。
 */
export function CatProfile({ onOpenSession, onOpenCeremony }: { onOpenSession(id: string): void; onOpenCeremony(handoffId?: string): void }) {
  const L = useBi();
  const qc = useQueryClient();
  const info = useCompanion();
  const query = useLifecycleOverview();
  const overview: AssistantLifecycle | undefined = query.data;
  const [drafts, setDrafts] = useState<Drafts>({});
  const [syncedConfig, setSyncedConfig] = useState('');
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const [confirmEarly, setConfirmEarly] = useState(false);

  // 服务端配置变了（保存成功或别处改了）才重置输入框；轮询拿到同样的配置不打断正在填的数。
  const configKey = overview ? JSON.stringify(overview.config) : '';
  if (overview && configKey !== syncedConfig) { setSyncedConfig(configKey); setDrafts(thresholdDrafts(overview.config)); }

  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['assistant-lifecycle'] });
    void qc.invalidateQueries({ queryKey: ['assistant-state'] });
    void qc.invalidateQueries({ queryKey: ['assistant-notes-archive'] });
  };
  const ok = (text: string) => { setError(undefined); setNotice(text); refresh(); };
  const fail = (value: unknown) => { setNotice(undefined); setError(errorText(value)); };
  const runNow = useMutation({ mutationFn: () => api.assistantRunMaintenance({ reason: L("你在小猫档案里点了立即整理", "Triggered manual maintenance from Companion Profile") }), onSuccess: () => ok(L("整理轮次开始了，进度在主会话时间线上", "Maintenance turn started; track progress in the main session timeline")), onError: fail });
  const save = useMutation({ mutationFn: api.assistantSaveLifecycleConfig, onSuccess: () => ok(L("已保存", "Saved")), onError: fail });
  const undo = useMutation({ mutationFn: (batchId: string) => api.assistantUnarchiveNotes({ batchId }), onSuccess: result => ok(L(`已取出 ${result.restored.length} 张便签`, `Restored ${result.restored.length} sticky note(s)`)), onError: fail });
  // 换代后：把飞书机器人同步成当前在岗的小猫。非主会话/权限不足时后端会返回原因。
  const syncBot = useMutation({
    mutationFn: () => api.handoverSyncBot(),
    onSuccess: result => result.ok ? ok(result.message) : fail(new Error(result.message)),
    onError: fail
  });
  // 提前交接只发起提议，不替用户确认；真正的执行仍要在仪式里点「开始交接」。
  const earlyHandoff = useMutation({
    mutationFn: () => proposeEarlyHandoff(() => api.assistantProposeHandoff({ reason: L("你在小猫档案里提前发起交接（还没到老年）", "Initiated early handover from Companion Profile") })),
    onSuccess: id => { setConfirmEarly(false); onOpenCeremony(id); },
    onError: fail
  });

  const changed = useMemo(() => {
    if (!overview) return {};
    const original = thresholdDrafts(overview.config);
    const patch: Record<string, number | null> = {};
    for (const [key, value] of Object.entries(drafts)) {
      if ((original[key] ?? '') === value.trim()) continue;
      patch[key] = value.trim() === '' ? null : Number(value);
    }
    return patch;
  }, [drafts, overview]);
  const invalid = Object.values(changed).some(value => value !== null && (!Number.isFinite(value) || value <= 0));

  if (query.isError) return <div className="border-t border-zinc-100 px-4 py-3 text-[12px] text-zinc-400">{L("这个版本的服务端还没有小猫档案。", "This server version does not support Companion Profiles yet.")}</div>;
  if (!overview) return <div className="flex items-center gap-1.5 border-t border-zinc-100 px-4 py-3 text-[12px] text-zinc-400"><LoaderCircle size={13} className="animate-spin"/>{L("正在读小猫档案…", "Loading Companion Profile…")}</div>;

  const cat = overview.cat;
  const config = overview.config;
  const next = cat ? nextStage(cat.lifeStage) : undefined;
  const percent = agePercent(cat?.peakAgeScore);
  const maintenanceRunning = overview.maintenance?.state === 'running';
  const proposal = overview.handoff?.state === 'proposed' ? overview.handoff : undefined;
  const runningHandoff = overview.handoff && overview.handoff.state !== 'proposed' ? overview.handoff : undefined;
  const lineage = [...overview.lineage].sort((a, b) => a.generation - b.generation);
  const early = earlyHandoffEntry({ adopted: Boolean(cat), stage: cat?.lifeStage, handoff: overview.handoff, busy: info.busy });

  return <section aria-label={L("小猫档案", "Companion Profile")} className="border-t border-zinc-100 px-4 py-3.5">
    <div className="flex flex-wrap items-center gap-2">
      <h3 className="flex items-center gap-1.5 text-[14px] text-zinc-900"><Hourglass size={14}/>{L("小猫档案", "Companion Profile")}</h3>
      {cat && <span className="ui-stage-chip" data-stage={cat.lifeStage}>{generationLabel(cat.generation)} · {stageLabel[cat.lifeStage]}</span>}
      <span className={`text-[12px] ${levelClass[overview.level]}`}>{overview.level === 'ok' ? L("指标都正常", "All metrics healthy") : `${levelLabel[overview.level]}：${overview.reasons.filter(reason => reason.level === overview.level).map(formatReason).join('、')}`}</span>
      <div className="ml-auto flex flex-wrap items-center gap-1.5">
        {lineage.length > 1 && <button type="button" disabled={syncBot.isPending} onClick={() => syncBot.mutate()} className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-zinc-200 px-2.5 text-[12px] text-zinc-700 hover:bg-zinc-50 disabled:opacity-40">
          <RefreshCw size={13} className={syncBot.isPending ? 'animate-spin' : ''}/>{syncBot.isPending ? L("同步中…", "Syncing…") : L("同步飞书机器人", "Sync Lark Bot")}
        </button>}
        <button type="button" disabled={!cat || maintenanceRunning || runNow.isPending || Boolean(runningHandoff)} onClick={() => runNow.mutate()} className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-zinc-200 px-2.5 text-[12px] text-zinc-700 hover:bg-zinc-50 disabled:opacity-40">
          {maintenanceRunning || runNow.isPending ? <LoaderCircle size={13} className="animate-spin"/> : <Brush size={13}/>}{maintenanceRunning ? L("正在整理…", "Tidying…") : L("立即整理", "Tidy Now")}
        </button>
        <button type="button" disabled={!cat} onClick={() => onOpenCeremony(proposal?.id ?? runningHandoff?.id)} className="inline-flex h-8 items-center gap-1.5 rounded-lg bg-zinc-900 px-2.5 text-[12px] font-medium text-white hover:bg-zinc-700 disabled:opacity-40">
          {runningHandoff ? L("查看交接进度", "View Handover") : proposal ? L("交接提议待确认", "Handover Pending") : L("交接仪式", "Handover Ceremony")}
        </button>
      </div>
    </div>

    {cat && <div className="mt-3">
      <p className="text-[12.5px] text-zinc-700">{generationLabel(cat.generation)}{cat.name}{L("现在是", "Current stage: ")}<b className="font-semibold">{stageCatLabel[cat.lifeStage]}</b>：{stageBlurb[cat.lifeStage]}。</p>
      <div className="mt-2 ui-age-bar" role="meter" aria-label={L("小猫年纪", "Companion Lifecycle")} aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent}>
        <span className="ui-age-bar-fill" style={{ width: `${percent}%` }}/>
        {(['adult', 'senior', 'elder'] as const).map(stage => <span key={stage} className="ui-age-bar-tick" style={{ left: `${STAGE_FLOORS[stage] * 100}%` }} title={L(`${stageLabel[stage]}从这里开始`, `${stageLabel[stage]} starts here`)}/>)}
      </div>
      <p className="mt-1.5 text-[11.5px] leading-5 text-zinc-500">
        
        {L("年纪看压缩次数、轮次和上下文用量，事件量只在极高时作上限保护；时间占两成，只长不缩。", "Lifecycle score tracks compactions, turns, and context usage (plus 20% uptime); it only progresses forward.")}
        {next ? L(` 再长到 ${Math.round(STAGE_FLOORS[next] * 100)}% 就是${stageLabel[next]}。`, ` Reaches ${stageLabel[next]} at ${Math.round(STAGE_FLOORS[next] * 100)}%.`) : L(" 已经是最后一个阶段，交接后新猫从幼猫开始。", " is the final stage; after handover, the successor begins as a Kitten.")}
        {L(` 认领于 ${sinceLabel(cat.adoptedAt) || '刚刚'}，陪你聊了 ${cat.rounds} 轮。`, ` Adopted ${sinceLabel(cat.adoptedAt) || 'just now'} · ${cat.rounds} turns.`)}
      </p>
    </div>}

    <div className="mt-3 overflow-hidden rounded-xl border border-zinc-200 bg-white">
      <div className="overflow-x-auto">
        <table className="w-full min-w-[440px] border-collapse text-left text-[12px]">
          <thead>
            <tr className="border-b border-zinc-200/80 bg-zinc-50/80 text-[11px] font-medium text-zinc-500">
              <th className="whitespace-nowrap px-3 py-2 font-medium">{L("指标", "Metric")}</th>
              <th className="whitespace-nowrap px-3 py-2 text-right font-medium">{L("现在", "Now")}</th>
              <th className="whitespace-nowrap px-3 py-2 text-right font-medium">{L("整理档", "Tidy")}</th>
              <th className="whitespace-nowrap px-3 py-2 text-right font-medium">{L("交接档", "Handover")}</th>
              <th className="whitespace-nowrap px-3 py-2 text-right font-medium">{L("状态", "Status")}</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-zinc-100">
            {METRIC_KEYS.map(metric => {
              const level = overview.levels?.[metric] ?? 'ok';
              return <tr key={metric} className="transition-colors hover:bg-zinc-50/70" data-level={level}>
                <td className="whitespace-nowrap px-3 py-2 align-middle font-medium text-zinc-700">{metricLabel[metric]}</td>
                <td className="whitespace-nowrap px-3 py-2 text-right align-middle tabular-nums text-zinc-900">{formatMetricValue(metric, overview.metrics?.[metric])}</td>
                {(['tidy', 'handoff'] as const).map(levelKey => <td key={levelKey} className="whitespace-nowrap px-3 py-1.5 text-right align-middle">
                  <input inputMode="decimal" value={drafts[`${metric}.${levelKey}`] ?? ''} placeholder={L("关", "Off")} aria-label={L(`${metricLabel[metric]}的${levelKey === 'tidy' ? '整理' : '交接'}阈值`, `${levelKey === 'tidy' ? 'Tidy' : 'Handover'} threshold for ${metricLabel[metric]}`)}
                    onChange={event => { const value = event.target.value; setNotice(undefined); setDrafts(current => ({ ...current, [`${metric}.${levelKey}`]: value })); }}
                    className="ui-field h-7 w-16 rounded-md border border-zinc-200 bg-white px-2 text-right text-[12px] tabular-nums text-zinc-800 outline-none placeholder:text-zinc-300"/>
                </td>)}
                <td className={`whitespace-nowrap px-3 py-2 text-right align-middle text-[11.5px] font-medium ${levelClass[level]}`}>{levelLabel[level]}</td>
              </tr>;
            })}
          </tbody>
        </table>
      </div>
    </div>
    <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-2 text-[12px] text-zinc-600">
      <label className="flex items-center gap-1.5"><input type="checkbox" checked={config.autoMaintenance} disabled={save.isPending} onChange={event => save.mutate({ autoMaintenance: event.target.checked })} className="h-3.5 w-3.5 accent-zinc-900"/>{L("到整理档自动开整理轮次", "Auto-run maintenance turn at Tidy threshold")}</label>
      <label className="flex items-center gap-1.5"><input type="checkbox" checked={config.autoProposeHandoff} disabled={save.isPending} onChange={event => save.mutate({ autoProposeHandoff: event.target.checked })} className="h-3.5 w-3.5 accent-zinc-900"/>{L("到交接档提议交接（仍要你确认）", "Propose handover at Handover threshold (requires your approval)")}</label>
      <span className="text-zinc-400">{L("每天最多自动整理", "Max auto-tidy runs per day: ")} {config.maxAutoRunsPerDay}  {L("次；已完成超过", "; fold tasks completed over ")} {config.foldClosedAfterHours}  {L("小时的便签才会被折叠", " hour(s) ago")}</span>
      <button type="button" disabled={!Object.keys(changed).length || invalid || save.isPending} onClick={() => save.mutate({ set: changed })} className="ml-auto h-7 rounded-md bg-zinc-900 px-2.5 text-[12px] font-medium text-white hover:bg-zinc-800 disabled:opacity-40">{save.isPending ? L("保存中…", "Saving…") : L("保存阈值", "Save Thresholds")}</button>
    </div>
    {invalid && <p className="mt-1 text-[11px] text-red-600">{L("阈值要填正数，留空表示关掉这一档。", "Enter positive numbers; leave blank to disable a threshold.")}</p>}
    {notice && <p className="mt-1 text-[11px] text-emerald-600">{notice}</p>}
    {error && <p className="mt-1 rounded-md border border-red-200 bg-red-50 px-2 py-1.5 text-[12px] text-red-700">{error}</p>}

    {lineage.length > 0 && <div className="mt-4">
      <h4 className="text-[12px] font-semibold text-zinc-500">{L("历代小猫", "Lineage")}</h4>
      <ol className="mt-1 flex flex-col gap-1">
        {lineage.map(record => <li key={record.id} className="flex flex-wrap items-center gap-x-2 gap-y-0.5 rounded-md bg-zinc-50 px-2 py-1.5 text-[12px]" data-state={record.state}>
          <span className="font-medium text-zinc-800">{generationLabel(record.generation)} · {record.name}</span>
          <span className={`rounded px-1 text-[10.5px] leading-[18px] ${record.state === 'active' ? 'bg-emerald-100 text-emerald-700' : 'bg-zinc-200 text-zinc-600'}`}>{catStateLabel[record.state]} · {stageLabel[record.lifeStage]}</span>
          <span className="text-zinc-500">{record.rounds}  {L("轮 · 认领于", " turns · Adopted ")} {sinceLabel(record.adoptedAt) || L("刚刚", "Just now")}{record.retiredAt ? L(` · 退休于 ${sinceLabel(record.retiredAt) || '刚刚'}`, ` · Retired ${sinceLabel(record.retiredAt) || 'just now'}`) : ''}</span>
          <code className="truncate font-mono text-[10.5px] text-zinc-400" title={record.sessionId}>{record.sessionId}</code>
          {record.state !== 'active' && <button type="button" onClick={() => onOpenSession(record.sessionId)} className="ml-auto inline-flex h-6 items-center gap-1 rounded px-1.5 text-[11.5px] text-zinc-600 hover:bg-zinc-200"><Eye size={12}/>{L("查看会话（只读）", "View Session (Read-only)")}</button>}
        </li>)}
      </ol>
    </div>}

    {(overview.maintenanceRuns.length > 0 || overview.handoffs.length > 0) && <div className="mt-4 grid gap-3 min-[560px]:grid-cols-2">
      {overview.maintenanceRuns.length > 0 && <div>
        <h4 className="text-[12px] font-semibold text-zinc-500">{L("最近的整理轮次", "Recent Maintenance Turns")}</h4>
        <ul className="mt-1 flex flex-col gap-1">
          {overview.maintenanceRuns.slice(0, 4).map(run => <li key={run.id} className="rounded-md bg-zinc-50 px-2 py-1.5 text-[12px]" data-state={run.state}>
            <div className="flex items-center gap-1.5">
              <span className="text-zinc-800">{run.trigger === 'auto' ? L("自动", "Auto") : L("手动", "Manual")} · {runStateLabel[run.state]}</span>
              <span className="text-zinc-400">{sinceLabel(run.createdAt)}</span>
              {run.batch && run.archiveBatchId && (run.batch.undoneAt
                ? <span className="ml-auto text-[11px] text-zinc-400">{L("已取出", "Restored")} {run.batch.count}  {L("张", " notes")}</span>
                : <button type="button" disabled={undo.isPending} onClick={() => undo.mutate(run.archiveBatchId!)} className="ml-auto inline-flex h-6 items-center gap-1 rounded px-1.5 text-[11.5px] text-zinc-600 hover:bg-zinc-200 disabled:opacity-40"><RotateCcw size={11}/>{L("撤销折叠", "Unfold")} {run.batch.count}  {L("张", " notes")}</button>)}
            </div>
            {(run.summary || run.error) && <p className="mt-0.5 line-clamp-2 text-[11.5px] leading-5 text-zinc-500">{run.summary ?? run.error}</p>}
          </li>)}
        </ul>
      </div>}
      {overview.handoffs.length > 0 && <div>
        <h4 className="text-[12px] font-semibold text-zinc-500">{L("交接记录", "Handover History")}</h4>
        <ul className="mt-1 flex flex-col gap-1">
          {overview.handoffs.slice(0, 4).map(handoff => <li key={handoff.id}>
            <button type="button" onClick={() => onOpenCeremony(handoff.id)} className="flex w-full items-center gap-1.5 rounded-md bg-zinc-50 px-2 py-1.5 text-left text-[12px] hover:bg-zinc-100">
              <Archive size={12} className="shrink-0 text-zinc-400"/>
              <span className="truncate text-zinc-800">{handoff.successorName ? L(`交给${handoff.successorName}`, `Handed over to ${handoff.successorName}`) : L("交接", "Handover")} · {handoff.outcome ? outcomeLabel[handoff.outcome] : handoff.state === 'cancelled' ? L("已取消", "Cancelled") : handoff.state === 'rolled_back' ? L("已回滚", "Rolled Back") : handoff.state === 'proposed' ? L("等你确认", "Pending Approval") : L("进行中", "Running")}</span>
              <span className="ml-auto shrink-0 text-zinc-400">{sinceLabel(handoff.completedAt ?? handoff.createdAt)}</span>
            </button>
          </li>)}
        </ul>
      </div>}
    </div>}

    {early.visible && <div className="mt-4 border-t border-zinc-100 pt-2" data-testid="early-handoff-entry">
      <p className="text-[11.5px] leading-5 text-zinc-400">{early.note}</p>
      <button type="button" aria-expanded={early.mode === 'confirm' ? confirmEarly : undefined}
        onClick={() => early.mode === 'progress' ? onOpenCeremony(overview.handoff?.id) : setConfirmEarly(value => !value)}
        className="mt-0.5 text-[11.5px] text-zinc-500 underline decoration-zinc-300 underline-offset-2 hover:text-zinc-800">
        {early.label}
      </button>
      {early.mode === 'confirm' && confirmEarly && <div role="group" aria-label={L("确认提前交接", "Confirm Early Handover")} className="mt-2 rounded-lg border border-zinc-200 bg-zinc-50 px-2.5 py-2 text-[12px] leading-5 text-zinc-600">
        <p>{L("现在只是发起提议，还要在交接仪式里再点一次「开始交接」才会执行。交接后当前主会话归档成只读，新猫接班。", "This only creates a proposal; click \"Start Handover\" in the ceremony to execute. The current main session archives as read-only when the successor takes over.")}</p>
        {info.busy && <p className="mt-0.5 text-amber-700">{L("主会话这一轮还没结束；确认后如果还在忙，会提示你等这一轮结束。", "The main session is still running a turn; you may be asked to wait until it completes.")}</p>}
        <div className="mt-1.5 flex flex-wrap items-center gap-2">
          <button type="button" disabled={earlyHandoff.isPending} onClick={() => setConfirmEarly(false)} className="h-7 rounded-md px-2 text-[12px] text-zinc-500 hover:bg-zinc-200 disabled:opacity-40">{L("再想想", "Cancel")}</button>
          <button type="button" disabled={earlyHandoff.isPending} onClick={() => earlyHandoff.mutate()} className="h-7 rounded-md border border-zinc-300 bg-white px-2.5 text-[12px] font-medium text-zinc-800 hover:bg-zinc-100 disabled:opacity-40">{earlyHandoff.isPending ? L("发起中…", "Proposing…") : L("发起交接提议", "Propose Handover")}</button>
        </div>
      </div>}
    </div>}
  </section>;
}
