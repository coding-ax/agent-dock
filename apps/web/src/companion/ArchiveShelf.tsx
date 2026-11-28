import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Archive, ChevronDown, LoaderCircle, RotateCcw } from 'lucide-react';
import { api, type ArchiveBatch, type AssistantTask } from '../api';
import { sinceLabel } from './companion-model';
import { archiveSourceLabel } from './lifecycle-model';
import { useCompanion, useCompanionNav } from './useCompanion';
import { useCompanionStore } from './companion-store';
import { bi, useBi } from '../i18n';

const outcomeText = (task: AssistantTask) => task.outcome === 'cancelled' ? bi("已取消", "Cancelled") : bi("已验收", "Approved");

/**
 * 便签墙底部的归档区：整理轮次、交接或手动收起的已完成便签。
 * 只读可看、整批可取出；不是删除，便签和它的侧边会话都还在。
 */
export function ArchiveShelf() {
  const L = useBi();
  const info = useCompanion();
  const nav = useCompanionNav();
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const count = info.archivedTasks.length;
  const archive = useQuery({ queryKey: ['assistant-notes-archive', count], queryFn: api.assistantNotesArchive, enabled: open && count > 0, retry: false });
  const restore = useMutation({
    mutationFn: (batch: ArchiveBatch) => api.assistantUnarchiveNotes({ batchId: batch.id }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['assistant-state'] });
      void qc.invalidateQueries({ queryKey: ['assistant-notes-archive'] });
      void qc.invalidateQueries({ queryKey: ['assistant-lifecycle'] });
    }
  });

  // 按批次分组：同一次整理/交接折叠的放一起；找不到批次的（旧数据）归到「其他」。
  const groups = useMemo(() => {
    const byId = new Map(info.archivedTasks.map(task => [task.id, task]));
    const batches = (archive.data?.batches ?? []).filter(batch => !batch.undoneAt)
      .map(batch => ({ batch, tasks: batch.taskIds.map(id => byId.get(id)).filter((task): task is AssistantTask => Boolean(task?.archivedAt && task.archiveBatchId === batch.id)) }))
      .filter(group => group.tasks.length)
      .sort((a, b) => b.batch.createdAt.localeCompare(a.batch.createdAt));
    const grouped = new Set(batches.flatMap(group => group.tasks.map(task => task.id)));
    const rest = info.archivedTasks.filter(task => !grouped.has(task.id));
    return { batches, rest };
  }, [archive.data, info.archivedTasks]);

  if (!info.adopted || !count) return null;
  const openTask = (task: AssistantTask) => { useCompanionStore.getState().closeDrawer(); nav.openTask(task); };
  const row = (task: AssistantTask) => <li key={task.id}>
    <button type="button" disabled={!task.sessionId} onClick={() => openTask(task)} title={task.sessionId ? L("打开这张便签的会话", "Open note session") : undefined} className="flex w-full items-center gap-2 rounded-md px-2 py-1 text-left text-[12px] hover:bg-zinc-100 disabled:hover:bg-transparent">
      <span className="min-w-0 flex-1 truncate text-zinc-700">{task.title}</span>
      <span className="shrink-0 text-[11px] text-zinc-400">{outcomeText(task)} · {sinceLabel(task.closedAt ?? task.updatedAt)}</span>
    </button>
  </li>;

  return <section className="ui-drawer-section mt-[18px]" aria-label={L("归档区", "Archive")}>
    <button type="button" onClick={() => setOpen(value => !value)} aria-expanded={open} className="ui-drawer-section-title w-full !cursor-pointer hover:text-zinc-800">
      <Archive size={12}/>{L("归档区 ·", "Archive ·")} {count}  {L("张（只读）", " (Read-only)")}<ChevronDown size={12} className={`transition-transform duration-200 ${open ? 'rotate-180' : ''}`}/>
    </button>
    {open && <div className="flex flex-col gap-2 rounded-xl border border-dashed border-zinc-300 bg-zinc-50/70 p-2">
      <p className="px-1 text-[11.5px] leading-5 text-zinc-500">{L("整理和交接时折叠进来的已完成便签。记录都在，随时可以整批取出放回便签墙。", "Completed notes folded during maintenance or handover. Restore any batch back to the sticky wall anytime.")}</p>
      {archive.isLoading && <p className="flex items-center gap-1.5 px-1 text-[12px] text-zinc-400"><LoaderCircle size={12} className="animate-spin"/>{L("正在读归档…", "Loading archive…")}</p>}
      {groups.batches.map(({ batch, tasks }) => <div key={batch.id} className="rounded-lg bg-white/80 p-1.5 ring-1 ring-zinc-200/70">
        <div className="flex items-center gap-2 px-1 pb-1">
          <span className="text-[11.5px] font-medium text-zinc-600">{archiveSourceLabel[batch.source]} · {tasks.length}  {L("张", " notes")}</span>
          <span className="text-[11px] text-zinc-400">{sinceLabel(batch.createdAt)}</span>
          <button type="button" disabled={restore.isPending} onClick={() => restore.mutate(batch)} className="ml-auto inline-flex h-6 items-center gap-1 rounded-md px-1.5 text-[11.5px] text-zinc-600 hover:bg-zinc-100 disabled:opacity-40">
            {restore.isPending && restore.variables?.id === batch.id ? <LoaderCircle size={11} className="animate-spin"/> : <RotateCcw size={11}/>}{L("取出", "Restore")}
          </button>
        </div>
        {batch.reason && <p className="px-1 pb-1 text-[11px] text-zinc-400">{batch.reason}</p>}
        <ul>{tasks.map(row)}</ul>
      </div>)}
      {groups.rest.length > 0 && (archive.data || !archive.isLoading) && <div className="rounded-lg bg-white/80 p-1.5 ring-1 ring-zinc-200/70">
        {groups.batches.length > 0 && <div className="px-1 pb-1 text-[11.5px] font-medium text-zinc-600">{L("其他 ·", "Other ·")} {groups.rest.length}  {L("张", " notes")}</div>}
        <ul>{groups.rest.map(row)}</ul>
      </div>}
      {restore.isError && <p className="px-1 text-[11.5px] text-red-600">{restore.error instanceof Error ? restore.error.message : L("取出失败", "Restore failed")}</p>}
    </div>}
  </section>;
}
