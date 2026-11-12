import { useMemo, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Archive, Brush, Eye, Hourglass, LoaderCircle, RefreshCw, RotateCcw } from 'lucide-react';
import { api, type AssistantLifecycle, type CatRecord, type LifecycleConfig, type MaintenanceRun } from '../api';
import { sinceLabel } from './companion-model';
import { useLifecycleOverview } from './useCompanion';
import {
  agePercent, formatMetricValue, formatReason, generationLabel, levelLabel, METRIC_KEYS, metricLabel, nextStage, outcomeLabel,
  STAGE_FLOORS, stageBlurb, stageCatLabel, stageLabel
} from './lifecycle-model';

const errorText = (error: unknown) => error instanceof Error ? error.message : '操作失败';
const catStateLabel: Record<CatRecord['state'], string> = { active: '在岗', retired: '已退休', released: '已解除', aborted: '没接上班' };
const runStateLabel: Record<MaintenanceRun['state'], string> = { running: '进行中', completed: '已完成', failed: '失败', interrupted: '被打断' };
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
  const qc = useQueryClient();
  const query = useLifecycleOverview();
  const overview: AssistantLifecycle | undefined = query.data;
  const [drafts, setDrafts] = useState<Drafts>({});
  const [syncedConfig, setSyncedConfig] = useState('');
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();

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
  const runNow = useMutation({ mutationFn: () => api.assistantRunMaintenance({ reason: '你在小猫档案里点了立即整理' }), onSuccess: () => ok('整理轮次开始了，进度在主会话时间线上'), onError: fail });
  const save = useMutation({ mutationFn: api.assistantSaveLifecycleConfig, onSuccess: () => ok('已保存'), onError: fail });
  const undo = useMutation({ mutationFn: (batchId: string) => api.assistantUnarchiveNotes({ batchId }), onSuccess: result => ok(`已取出 ${result.restored.length} 张便签`), onError: fail });
  // 换代后：把飞书机器人同步成当前在岗的小猫。非主会话/权限不足时后端会返回原因。
  const syncBot = useMutation({
    mutationFn: () => api.handoverSyncBot(),
    onSuccess: result => result.ok ? ok(result.message) : fail(new Error(result.message)),
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

  if (query.isError) return <div className="border-t border-zinc-100 px-4 py-3 text-[12px] text-zinc-400">这个版本的服务端还没有小猫档案。</div>;
  if (!overview) return <div className="flex items-center gap-1.5 border-t border-zinc-100 px-4 py-3 text-[12px] text-zinc-400"><LoaderCircle size={13} className="animate-spin"/>正在读小猫档案…</div>;

  const cat = overview.cat;
  const config = overview.config;
  const next = cat ? nextStage(cat.lifeStage) : undefined;
  const percent = agePercent(cat?.peakAgeScore);
  const maintenanceRunning = overview.maintenance?.state === 'running';
  const proposal = overview.handoff?.state === 'proposed' ? overview.handoff : undefined;
  const runningHandoff = overview.handoff && overview.handoff.state !== 'proposed' ? overview.handoff : undefined;
  const lineage = [...overview.lineage].sort((a, b) => a.generation - b.generation);

  return <section aria-label="小猫档案" className="border-t border-zinc-100 px-4 py-3.5">
    <div className="flex flex-wrap items-center gap-2">
      <h3 className="flex items-center gap-1.5 text-[14px] text-zinc-900"><Hourglass size={14}/>小猫档案</h3>
      {cat && <span className="ui-stage-chip" data-stage={cat.lifeStage}>{generationLabel(cat.generation)} · {stageLabel[cat.lifeStage]}</span>}
      <span className={`text-[12px] ${levelClass[overview.level]}`}>{overview.level === 'ok' ? '指标都正常' : `${levelLabel[overview.level]}：${overview.reasons.filter(reason => reason.level === overview.level).map(formatReason).join('、')}`}</span>
      <div className="ml-auto flex items-center gap-1.5">
        {lineage.length > 1 && <button type="button" disabled={syncBot.isPending} onClick={() => syncBot.mutate()} className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-zinc-200 px-2.5 text-[12px] text-zinc-700 hover:bg-zinc-50 disabled:opacity-40">
          <RefreshCw size={13} className={syncBot.isPending ? 'animate-spin' : ''}/>{syncBot.isPending ? '同步中…' : '同步飞书机器人'}
        </button>}
        <button type="button" disabled={!cat || maintenanceRunning || runNow.isPending || Boolean(runningHandoff)} onClick={() => runNow.mutate()} className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-zinc-200 px-2.5 text-[12px] text-zinc-700 hover:bg-zinc-50 disabled:opacity-40">
          {maintenanceRunning || runNow.isPending ? <LoaderCircle size={13} className="animate-spin"/> : <Brush size={13}/>}{maintenanceRunning ? '正在整理…' : '立即整理'}
        </button>
        <button type="button" disabled={!cat} onClick={() => onOpenCeremony(proposal?.id ?? runningHandoff?.id)} className="inline-flex h-8 items-center gap-1.5 rounded-lg bg-zinc-900 px-2.5 text-[12px] font-medium text-white hover:bg-zinc-700 disabled:opacity-40">
          {runningHandoff ? '查看交接进度' : proposal ? '交接提议待确认' : '交接仪式'}
        </button>
      </div>
    </div>

    {cat && <div className="mt-3">
      <p className="text-[12.5px] text-zinc-700">{generationLabel(cat.generation)}{cat.name}现在是<b className="font-semibold">{stageCatLabel[cat.lifeStage]}</b>：{stageBlurb[cat.lifeStage]}。</p>
      <div className="mt-2 ui-age-bar" role="meter" aria-label="小猫年纪" aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent}>
        <span className="ui-age-bar-fill" style={{ width: `${percent}%` }}/>
        {(['adult', 'senior', 'elder'] as const).map(stage => <span key={stage} className="ui-age-bar-tick" style={{ left: `${STAGE_FLOORS[stage] * 100}%` }} title={`${stageLabel[stage]}从这里开始`}/>)}
      </div>
      <p className="mt-1.5 text-[11.5px] leading-5 text-zinc-500">
        年纪看压缩次数、轮次和上下文用量，事件量只在极高时作上限保护；时间占两成，只长不缩。
        {next ? ` 再长到 ${Math.round(STAGE_FLOORS[next] * 100)}% 就是${stageLabel[next]}。` : ' 已经是最后一个阶段，交接后新猫从幼猫开始。'}
        {` 认领于 ${sinceLabel(cat.adoptedAt) || '刚刚'}，陪你聊了 ${cat.rounds} 轮。`}
      </p>
    </div>}

    <div className="mt-3 overflow-x-auto">
      <table className="w-full min-w-[440px] text-left text-[12px]">
        <thead className="text-[11px] text-zinc-400">
          <tr><th className="py-1 font-normal">指标</th><th className="py-1 font-normal">现在</th><th className="py-1 font-normal">整理档</th><th className="py-1 font-normal">交接档</th><th className="py-1 font-normal">状态</th></tr>
        </thead>
        <tbody>
          {METRIC_KEYS.map(metric => {
            const level = overview.levels?.[metric] ?? 'ok';
            return <tr key={metric} className="border-t border-zinc-100" data-level={level}>
              <td className="py-1.5 text-zinc-700">{metricLabel[metric]}</td>
              <td className="py-1.5 tabular-nums text-zinc-900">{formatMetricValue(metric, overview.metrics?.[metric])}</td>
              {(['tidy', 'handoff'] as const).map(levelKey => <td key={levelKey} className="py-1">
                <input inputMode="decimal" value={drafts[`${metric}.${levelKey}`] ?? ''} placeholder="关" aria-label={`${metricLabel[metric]}的${levelKey === 'tidy' ? '整理' : '交接'}阈值`}
                  onChange={event => { const value = event.target.value; setNotice(undefined); setDrafts(current => ({ ...current, [`${metric}.${levelKey}`]: value })); }}
                  className="ui-field h-7 w-16 rounded-md border border-zinc-200 bg-white px-1.5 text-[12px] tabular-nums text-zinc-800 outline-none placeholder:text-zinc-300"/>
              </td>)}
              <td className={`py-1.5 ${levelClass[level]}`}>{levelLabel[level]}</td>
            </tr>;
          })}
        </tbody>
      </table>
    </div>
    <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-2 text-[12px] text-zinc-600">
      <label className="flex items-center gap-1.5"><input type="checkbox" checked={config.autoMaintenance} disabled={save.isPending} onChange={event => save.mutate({ autoMaintenance: event.target.checked })} className="h-3.5 w-3.5 accent-zinc-900"/>到整理档自动开整理轮次</label>
      <label className="flex items-center gap-1.5"><input type="checkbox" checked={config.autoProposeHandoff} disabled={save.isPending} onChange={event => save.mutate({ autoProposeHandoff: event.target.checked })} className="h-3.5 w-3.5 accent-zinc-900"/>到交接档提议交接（仍要你确认）</label>
      <span className="text-zinc-400">每天最多自动整理 {config.maxAutoRunsPerDay} 次；已完成超过 {config.foldClosedAfterHours} 小时的便签才会被折叠</span>
      <button type="button" disabled={!Object.keys(changed).length || invalid || save.isPending} onClick={() => save.mutate({ set: changed })} className="ml-auto h-7 rounded-md bg-zinc-900 px-2.5 text-[12px] font-medium text-white hover:bg-zinc-800 disabled:opacity-40">{save.isPending ? '保存中…' : '保存阈值'}</button>
    </div>
    {invalid && <p className="mt-1 text-[11px] text-red-600">阈值要填正数，留空表示关掉这一档。</p>}
    {notice && <p className="mt-1 text-[11px] text-emerald-600">{notice}</p>}
    {error && <p className="mt-1 rounded-md border border-red-200 bg-red-50 px-2 py-1.5 text-[12px] text-red-700">{error}</p>}

    {lineage.length > 0 && <div className="mt-4">
      <h4 className="text-[12px] font-semibold text-zinc-500">历代小猫</h4>
      <ol className="mt-1 flex flex-col gap-1">
        {lineage.map(record => <li key={record.id} className="flex flex-wrap items-center gap-x-2 gap-y-0.5 rounded-md bg-zinc-50 px-2 py-1.5 text-[12px]" data-state={record.state}>
          <span className="font-medium text-zinc-800">{generationLabel(record.generation)} · {record.name}</span>
          <span className={`rounded px-1 text-[10.5px] leading-[18px] ${record.state === 'active' ? 'bg-emerald-100 text-emerald-700' : 'bg-zinc-200 text-zinc-600'}`}>{catStateLabel[record.state]} · {stageLabel[record.lifeStage]}</span>
          <span className="text-zinc-500">{record.rounds} 轮 · 认领于 {sinceLabel(record.adoptedAt) || '刚刚'}{record.retiredAt ? ` · 退休于 ${sinceLabel(record.retiredAt) || '刚刚'}` : ''}</span>
          <code className="truncate font-mono text-[10.5px] text-zinc-400" title={record.sessionId}>{record.sessionId}</code>
          {record.state !== 'active' && <button type="button" onClick={() => onOpenSession(record.sessionId)} className="ml-auto inline-flex h-6 items-center gap-1 rounded px-1.5 text-[11.5px] text-zinc-600 hover:bg-zinc-200"><Eye size={12}/>查看会话（只读）</button>}
        </li>)}
      </ol>
    </div>}

    {(overview.maintenanceRuns.length > 0 || overview.handoffs.length > 0) && <div className="mt-4 grid gap-3 min-[560px]:grid-cols-2">
      {overview.maintenanceRuns.length > 0 && <div>
        <h4 className="text-[12px] font-semibold text-zinc-500">最近的整理轮次</h4>
        <ul className="mt-1 flex flex-col gap-1">
          {overview.maintenanceRuns.slice(0, 4).map(run => <li key={run.id} className="rounded-md bg-zinc-50 px-2 py-1.5 text-[12px]" data-state={run.state}>
            <div className="flex items-center gap-1.5">
              <span className="text-zinc-800">{run.trigger === 'auto' ? '自动' : '手动'} · {runStateLabel[run.state]}</span>
              <span className="text-zinc-400">{sinceLabel(run.createdAt)}</span>
              {run.batch && run.archiveBatchId && (run.batch.undoneAt
                ? <span className="ml-auto text-[11px] text-zinc-400">已取出 {run.batch.count} 张</span>
                : <button type="button" disabled={undo.isPending} onClick={() => undo.mutate(run.archiveBatchId!)} className="ml-auto inline-flex h-6 items-center gap-1 rounded px-1.5 text-[11.5px] text-zinc-600 hover:bg-zinc-200 disabled:opacity-40"><RotateCcw size={11}/>撤销折叠 {run.batch.count} 张</button>)}
            </div>
            {(run.summary || run.error) && <p className="mt-0.5 line-clamp-2 text-[11.5px] leading-5 text-zinc-500">{run.summary ?? run.error}</p>}
          </li>)}
        </ul>
      </div>}
      {overview.handoffs.length > 0 && <div>
        <h4 className="text-[12px] font-semibold text-zinc-500">交接记录</h4>
        <ul className="mt-1 flex flex-col gap-1">
          {overview.handoffs.slice(0, 4).map(handoff => <li key={handoff.id}>
            <button type="button" onClick={() => onOpenCeremony(handoff.id)} className="flex w-full items-center gap-1.5 rounded-md bg-zinc-50 px-2 py-1.5 text-left text-[12px] hover:bg-zinc-100">
              <Archive size={12} className="shrink-0 text-zinc-400"/>
              <span className="truncate text-zinc-800">{handoff.successorName ? `交给${handoff.successorName}` : '交接'} · {handoff.outcome ? outcomeLabel[handoff.outcome] : handoff.state === 'cancelled' ? '已取消' : handoff.state === 'rolled_back' ? '已回滚' : handoff.state === 'proposed' ? '等你确认' : '进行中'}</span>
              <span className="ml-auto shrink-0 text-zinc-400">{sinceLabel(handoff.completedAt ?? handoff.createdAt)}</span>
            </button>
          </li>)}
        </ul>
      </div>}
    </div>}
  </section>;
}
