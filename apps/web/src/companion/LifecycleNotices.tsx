import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Brush, ChevronDown, Eye, LoaderCircle, PawPrint, RotateCcw } from 'lucide-react';
import { api, type MaintenanceRun } from '../api';
import { systemRoundCopy, type SystemRoundOrigin } from './lifecycle-model';
import { useCompanionNav, useLifecycleOverview } from './useCompanion';

const runStateText: Record<MaintenanceRun['state'], string> = { running: '正在整理', completed: '整理完了', failed: '整理失败', interrupted: '被打断了' };

/**
 * 时间线上的系统轮次：整理轮次（origin=maintenance）和交接说明（origin=handoff）。
 * 它们不是用户说的话，所以不画成用户气泡；完整指令可展开，整理折叠的便签能一键取出。
 */
export function SystemRoundNotice({ origin, text, detail, timestamp, taskId, sessionId }: { origin: SystemRoundOrigin; text?: string; detail: string; timestamp?: string; taskId?: string; sessionId?: string }) {
  const copy = systemRoundCopy(origin, text);
  const [open, setOpen] = useState(false);
  const time = timestamp ? new Date(timestamp).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }) : '';
  const Icon = origin === 'maintenance' ? Brush : PawPrint;
  return <div className="ui-timeline-item ui-system-round px-4 py-3" data-kind={origin} role="note" aria-label={`${copy.title}（系统轮次）`}>
    <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
      <Icon size={14} className="shrink-0 text-zinc-600"/>
      <span className="text-[13px] font-semibold text-zinc-800">{copy.title}</span>
      <span className="ui-system-badge">系统轮次 · 不是你发的</span>
      {time && <span className="ml-auto shrink-0 text-[11px] tabular-nums text-zinc-400">{time}</span>}
    </div>
    {copy.subtitle && <p className="mt-1 text-[12.5px] leading-5 text-zinc-600">{copy.subtitle}</p>}
    <p className="mt-0.5 text-[11.5px] leading-4 text-zinc-400">{origin === 'maintenance'
      ? '小猫在汇总、分组、折叠已完成的便签；文件只做索引和归档建议，不删不改。这一轮不会派活。'
      : '这是交接包，不冒充你说话；前任的会话已归档只读，记录一条没删。'}</p>
    {origin === 'maintenance' ? <MaintenanceStatus taskId={taskId}/> : <HandoffLinks sessionId={sessionId}/>}
    {detail && <button type="button" onClick={() => setOpen(value => !value)} aria-expanded={open} className="mt-2 inline-flex items-center gap-1 text-[11.5px] text-zinc-400 transition-colors hover:text-zinc-700">
      {open ? '收起完整指令' : '查看完整指令'}<ChevronDown size={11} className={`transition-transform duration-200 ${open ? 'rotate-180' : ''}`}/>
    </button>}
    {open && <pre className="ui-disclosure-body mt-1.5 max-h-72 overflow-y-auto whitespace-pre-wrap break-words font-sans text-[12px] leading-5 text-zinc-500">{detail}</pre>}
  </div>;
}

/** 这一轮整理的结果：进行中 / 完成（折叠了几张，能撤销）/ 失败。找不到记录（旧轮次）就不显示。 */
function MaintenanceStatus({ taskId }: { taskId?: string }) {
  const qc = useQueryClient();
  const overview = useLifecycleOverview(Boolean(taskId));
  const run = taskId ? [overview.data?.maintenance, ...(overview.data?.maintenanceRuns ?? [])].find(item => item?.runtimeTaskId === taskId) : undefined;
  const undo = useMutation({
    mutationFn: (batchId: string) => api.assistantUnarchiveNotes({ batchId }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['assistant-lifecycle'] });
      void qc.invalidateQueries({ queryKey: ['assistant-state'] });
      void qc.invalidateQueries({ queryKey: ['assistant-notes-archive'] });
    }
  });
  if (!run) return null;
  return <div className="mt-2 flex flex-wrap items-center gap-2 text-[12px]" data-state={run.state}>
    <span className={run.state === 'failed' ? 'text-red-600' : run.state === 'running' ? 'text-amber-700' : 'text-zinc-600'}>
      {run.state === 'running' && <LoaderCircle size={12} className="mr-1 inline animate-spin"/>}{runStateText[run.state]}
      {run.batch ? ` · 折叠了 ${run.batch.count} 张已完成便签` : ''}
    </span>
    {run.batch && run.archiveBatchId && (run.batch.undoneAt
      ? <span className="text-zinc-400">已全部取出</span>
      : <button type="button" disabled={undo.isPending} onClick={() => undo.mutate(run.archiveBatchId!)} className="inline-flex h-6 items-center gap-1 rounded-md border border-zinc-200 bg-white px-1.5 text-[11.5px] text-zinc-600 hover:bg-zinc-50 disabled:opacity-40"><RotateCcw size={11}/>撤销折叠</button>)}
    {undo.isError && <span className="text-red-600">{undo.error instanceof Error ? undo.error.message : '撤销失败'}</span>}
  </div>;
}

/** 交接说明里给一个回到前任会话（只读）的入口。 */
function HandoffLinks({ sessionId }: { sessionId?: string }) {
  const nav = useCompanionNav();
  const overview = useLifecycleOverview(Boolean(sessionId));
  const handoff = sessionId ? overview.data?.handoffs.find(item => item.toSessionId === sessionId) : undefined;
  if (!handoff) return null;
  return <div className="mt-2 flex flex-wrap items-center gap-2 text-[12px]">
    <button type="button" onClick={() => nav.openSession(handoff.fromSessionId)} className="inline-flex h-6 items-center gap-1 rounded-md border border-violet-200 bg-white px-1.5 text-[11.5px] text-violet-700 hover:bg-violet-50"><Eye size={11}/>前任的会话（只读）</button>
    <code className="truncate font-mono text-[10.5px] text-zinc-400" title={handoff.fromSessionId}>{handoff.fromSessionId}</code>
  </div>;
}
