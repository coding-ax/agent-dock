import { useState } from 'react';
import { createPortal } from 'react-dom';
import { useInterval } from 'ahooks';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { LoaderCircle, RefreshCw } from 'lucide-react';
import { api, type SelfUpdateStatus } from './api';
import { ConfirmDialog } from './ui-controls';
import { HoverTooltip } from './HoverTooltip';
import { useToast } from './Toast';
import { resolveUpdateProgress, shortVersion } from './self-update-progress';

/**
 * 侧边栏底部的版本行：显示当前 AgentDock 版本，有新版本时变成「升级到 x」入口。
 *
 * 升级由服务端拉起脱离的 `agent-dock update` 完成，期间服务会重启、请求会失败；
 * 这里只轮询版本号，变了就提示并刷新页面（新版前端资源也在新包里）。
 */
export function SelfUpdateNotice({ enabled }: { enabled: boolean }) {
  const toast = useToast(8_000);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [watch, setWatch] = useState<{ fromVersion: string; targetVersion?: string; startedAt: number }>();
  const qc = useQueryClient();
  // 服务端缓存 registry 结果 30 分钟，前端 5 分钟问一次基本都命中缓存，换来更短的发现延迟；
  // 会话 token 没权限时静默失败、不显示入口。
  const status = useQuery({ queryKey: ['self-update'], queryFn: () => api.selfUpdateStatus(), enabled, retry: false, refetchInterval: 5 * 60_000, refetchOnWindowFocus: false });
  // 手动检查跳过服务端缓存：刚发完版想马上升级时不必等缓存过期。
  const check = useMutation({
    mutationFn: () => api.selfUpdateStatus(true),
    onSuccess: next => {
      qc.setQueryData(['self-update'], next);
      if (next.checkError) toast.show(next.checkError);
      else if (!next.updateAvailable) toast.show(`已是最新版本（${shortVersion(next.currentVersion)}）`, 'info');
    },
    onError: error => toast.show(error.message)
  });
  const start = useMutation({
    mutationFn: api.startSelfUpdate,
    onSuccess: (next: SelfUpdateStatus) => { setConfirmOpen(false); setWatch({ fromVersion: next.currentVersion, ...(next.latestVersion ? { targetVersion: next.latestVersion } : {}), startedAt: Date.now() }); }
  });

  useInterval(async () => {
    if (!watch) return;
    const latest = await api.selfUpdateStatus().catch(() => undefined);
    const progress = resolveUpdateProgress(watch.fromVersion, latest, Date.now() - watch.startedAt);
    if (progress.phase === 'pending') return;
    setWatch(undefined);
    if (progress.phase === 'failed') { toast.show(progress.message); void status.refetch(); return; }
    toast.show(`已升级到 ${progress.version}，即将刷新页面`, 'info');
    window.setTimeout(() => window.location.reload(), 1_500);
  }, watch ? 2_000 : undefined);

  const data = status.data;
  if (!data) return null;
  const updating = Boolean(watch) || data.updating;
  const target = watch?.targetVersion ?? data.latestVersion;
  const showBanner = updating || (data.updateAvailable && data.latestVersion);
  return <>
    {showBanner && <div className="mb-2 flex h-9 items-center gap-2 rounded-lg border border-zinc-200 bg-white/80 pl-2.5 pr-1 text-[11px] text-zinc-600 shadow-[0_1px_2px_rgba(24,24,27,.04)]">
      {updating ? <LoaderCircle size={13} className="shrink-0 animate-spin text-zinc-400"/> : <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-emerald-500"/>}
      <HoverTooltip content={target ? `${data.distTag} 通道 ${target}` : '新版本'}>
        <span className="min-w-0 flex-1 truncate">{updating ? '正在升级，完成后自动刷新' : <>新版本 <span className="font-mono text-zinc-800">{shortVersion(target!)}</span> 可用</>}</span>
      </HoverTooltip>
      {!updating && <HoverTooltip content={data.canUpdate ? '安装新版本并重启服务' : '前台运行时无法在界面升级，请在终端执行 agent-dock update'}>
        <button type="button" disabled={!data.canUpdate} onClick={() => { start.reset(); setConfirmOpen(true); }} className="h-7 shrink-0 rounded-md px-2 text-[11px] font-medium text-zinc-900 transition-colors hover:bg-zinc-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-zinc-400/50 disabled:cursor-not-allowed disabled:text-zinc-400">升级</button>
      </HoverTooltip>}
    </div>}
    <div className="flex h-6 items-center gap-1">
      <HoverTooltip content={data.currentVersion}><span className="min-w-0 truncate">AgentDock <span className="font-mono">{shortVersion(data.currentVersion)}</span></span></HoverTooltip>
      {!showBanner && <HoverTooltip content={check.isPending ? '正在检查更新' : '检查更新'}>
        <button type="button" aria-label="检查更新" disabled={check.isPending} onClick={() => check.mutate()} className="grid h-6 w-6 shrink-0 place-items-center rounded-md text-zinc-400 transition-[color,background-color,box-shadow,transform] duration-150 hover:bg-white hover:text-zinc-800 hover:shadow-[0_1px_2px_rgba(24,24,27,.08)] active:scale-[.94] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-zinc-400/50 disabled:pointer-events-none"><RefreshCw size={12} strokeWidth={2} className={check.isPending ? 'animate-spin text-zinc-500' : ''}/></button>
      </HoverTooltip>}
    </div>
    {/* 侧边栏带 transform，内部的 fixed 会以侧边栏为包含块只盖住它自己；弹窗和 toast 挂到 body 才能全屏。 */}
    {createPortal(<>
    <ConfirmDialog
      open={confirmOpen}
      title={`升级到 ${data.latestVersion ? shortVersion(data.latestVersion) : '新版本'}？`}
      description="会安装新版本并重启 AgentDock 服务，正在执行的任务会被中断，页面会在升级完成后自动刷新。"
      confirmLabel="升级并重启"
      busy={start.isPending}
      {...(start.error ? { error: start.error.message } : {})}
      onConfirm={() => start.mutate()}
      onCancel={() => setConfirmOpen(false)}
    />
    {toast.toast}
    </>, document.body)}
  </>;
}
