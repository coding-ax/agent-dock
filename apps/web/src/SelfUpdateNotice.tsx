import { Spinner } from './Loaders';
import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { useInterval } from 'ahooks';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { RefreshCw } from 'lucide-react';
import { api, type SelfUpdateStatus } from './api';
import { ConfirmDialog } from './ui-controls';
import { HoverTooltip } from './HoverTooltip';
import { useToast } from './Toast';
import { DesktopUpdateNotice } from './DesktopUpdateNotice';
import { desktopUpdateApi } from './desktop-update';
import {
  resolveUpdateProgress,
  SELF_UPDATE_QUERY_KEY,
  SELF_UPDATE_REFETCH_INTERVAL_MS,
  setSelfUpdateStarting,
  setSelfUpdateWatch,
  shortVersion,
  useSelfUpdateClientState
} from './self-update-progress';
import { useBi } from './i18n';

let activeExternalWatchers = 0;

/**
 * 独立的后台升级轮询守卫：挂在常驻的侧栏底部，避免统一设置中心弹窗关闭后丢失
 * 「升级中轮询版本号 → 完成后提示并自动刷新页面」状态。
 */
export function SelfUpdateWatcher({ enabled }: { enabled: boolean }) {
  const L = useBi();
  const toast = useToast(8_000);
  const client = useSelfUpdateClientState();
  const watch = client.watch;
  const qc = useQueryClient();
  const active = enabled && !desktopUpdateApi();
  const status = useQuery({
    queryKey: SELF_UPDATE_QUERY_KEY,
    queryFn: () => api.selfUpdateStatus(),
    enabled: active,
    retry: false,
    refetchInterval: SELF_UPDATE_REFETCH_INTERVAL_MS,
    refetchOnWindowFocus: false
  });

  useEffect(() => {
    if (!active) return;
    activeExternalWatchers += 1;
    return () => { activeExternalWatchers = Math.max(0, activeExternalWatchers - 1); };
  }, [active]);

  useEffect(() => {
    if (!active) return;
    const current = status.data;
    if (!current?.updating || watch) return;
    setSelfUpdateWatch({
      fromVersion: current.currentVersion,
      ...(current.latestVersion ? { targetVersion: current.latestVersion } : {}),
      startedAt: Date.now()
    });
  }, [active, status.data?.updating, status.data?.currentVersion, status.data?.latestVersion, watch]);

  useInterval(async () => {
    if (!active || !watch) return;
    const latest = await api.selfUpdateStatus().catch(() => undefined);
    if (latest) qc.setQueryData(SELF_UPDATE_QUERY_KEY, latest);
    const progress = resolveUpdateProgress(watch.fromVersion, latest, Date.now() - watch.startedAt);
    if (progress.phase === 'pending') return;
    setSelfUpdateWatch(undefined);
    if (progress.phase === 'failed') {
      if (!latest) qc.setQueryData<SelfUpdateStatus>(SELF_UPDATE_QUERY_KEY, prev => prev ? { ...prev, updating: false } : prev);
      toast.show(progress.message);
      void status.refetch();
      return;
    }
    toast.show(L(`已升级到 ${progress.version}，即将刷新页面`, `Updated to ${progress.version}; reloading…`), 'info');
    window.setTimeout(() => window.location.reload(), 1_500);
  }, active && watch ? 2_000 : undefined);

  if (!active || !toast.toast) return null;
  return createPortal(toast.toast, document.body);
}

/**
 * 侧边栏底部的版本行：显示当前 AgentDock 版本，有新版本时变成「升级到 x」入口。
 *
 * 桌面客户端由 Electron 主进程的 electron-updater 负责，preload 存在时直接走
 * DesktopUpdateNotice；浏览器和 daemon 才走下面这条 npm + agent-dock update 链路。
 */
export function SelfUpdateNotice({ enabled }: { enabled: boolean }) {
  if (desktopUpdateApi()) return <DesktopUpdateNotice />;
  return <ServerUpdateNotice enabled={enabled} />;
}

/**
 * CLI / daemon 的升级入口。
 *
 * 升级由服务端拉起脱离的 `agent-dock update` 完成，期间服务会重启、请求会失败；
 * 这里只轮询版本号，变了就提示并刷新页面（新版前端资源也在新包里）。
 */
function ServerUpdateNotice({ enabled }: { enabled: boolean }) {
  const L = useBi();
  const toast = useToast(8_000);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [hintOpen, setHintOpen] = useState(false);
  const client = useSelfUpdateClientState();
  const watch = client.watch;
  const qc = useQueryClient();
  // 服务端缓存 registry 结果 30 分钟，前端 5 分钟问一次基本都命中缓存，换来更短的发现延迟；
  // 会话 token 没权限时静默失败、不显示入口。
  const status = useQuery({ queryKey: SELF_UPDATE_QUERY_KEY, queryFn: () => api.selfUpdateStatus(), enabled, retry: false, refetchInterval: SELF_UPDATE_REFETCH_INTERVAL_MS, refetchOnWindowFocus: false });
  // 手动检查跳过服务端缓存：刚发完版想马上升级时不必等缓存过期。
  const check = useMutation({
    mutationFn: () => api.selfUpdateStatus(true),
    onSuccess: next => {
      qc.setQueryData(SELF_UPDATE_QUERY_KEY, next);
      if (next.checkError) toast.show(next.checkError);
      else if (!next.updateAvailable) toast.show(L(`已是最新版本（${shortVersion(next.currentVersion)}）`, `Up to date (${shortVersion(next.currentVersion)})`), 'info');
    },
    onError: error => toast.show(error.message)
  });
  const start = useMutation({
    mutationFn: api.startSelfUpdate,
    onMutate: () => { setSelfUpdateStarting(true); },
    onSuccess: (next: SelfUpdateStatus) => {
      setConfirmOpen(false);
      qc.setQueryData(SELF_UPDATE_QUERY_KEY, next);
      setSelfUpdateWatch({ fromVersion: next.currentVersion, ...(next.latestVersion ? { targetVersion: next.latestVersion } : {}), startedAt: Date.now() });
      setSelfUpdateStarting(false);
    },
    onError: () => { setSelfUpdateStarting(false); }
  });

  // 页面在升级进行中刷新或打开时，服务端已返回 updating=true；自动补上轮询，完成后才能恢复状态并刷新。
  useEffect(() => {
    const current = status.data;
    if (!current?.updating || watch) return;
    setSelfUpdateWatch({
      fromVersion: current.currentVersion,
      ...(current.latestVersion ? { targetVersion: current.latestVersion } : {}),
      startedAt: Date.now()
    });
  }, [status.data?.updating, status.data?.currentVersion, status.data?.latestVersion, watch]);

  useInterval(async () => {
    if (!watch || activeExternalWatchers > 0) return;
    const latest = await api.selfUpdateStatus().catch(() => undefined);
    if (latest) qc.setQueryData(SELF_UPDATE_QUERY_KEY, latest);
    const progress = resolveUpdateProgress(watch.fromVersion, latest, Date.now() - watch.startedAt);
    if (progress.phase === 'pending') return;
    setSelfUpdateWatch(undefined);
    if (progress.phase === 'failed') {
      if (!latest) qc.setQueryData<SelfUpdateStatus>(SELF_UPDATE_QUERY_KEY, prev => prev ? { ...prev, updating: false } : prev);
      toast.show(progress.message);
      void status.refetch();
      return;
    }
    toast.show(L(`已升级到 ${progress.version}，即将刷新页面`, `Updated to ${progress.version}; reloading…`), 'info');
    window.setTimeout(() => window.location.reload(), 1_500);
  }, watch ? 2_000 : undefined);

  const data = status.data;
  if (!data) return null;
  const updating = client.starting || Boolean(watch) || data.updating;
  const target = watch?.targetVersion ?? data.latestVersion;
  const showBanner = updating || (data.updateAvailable && data.latestVersion);
  // 前台进程没有被 supervisor 托管，界面没法重启它；不要只禁用按钮，把可执行的
  // 操作原样给出来，否则用户只看到一个灰按钮和一句无法照做的提示。
  const manualHint = data.runtime === 'foreground'
    ? L(`当前是前台运行的 AgentDock 进程，界面无法重启它。请先在终端按 Ctrl-C 停止，再执行 npm install -g @agent-dock/cli@${data.distTag}，然后重新启动；需要后台常驻可改用 agent-dock start。`, `AgentDock is running in the foreground and cannot self-restart. Press Ctrl-C in terminal, run npm install -g @agent-dock/cli@${data.distTag}, and start again (or use agent-dock start for background mode).`)
    : L(`桌面版请在 AgentDock 应用内升级；浏览器访问时请在运行服务的那台机器上执行 npm install -g @agent-dock/cli@${data.distTag} && agent-dock restart。`, `Update via the desktop app, or run npm install -g @agent-dock/cli@${data.distTag} && agent-dock restart on the host machine.`);
  return <>
    {showBanner && <div className="mb-2 flex h-9 items-center gap-2 rounded-lg border border-zinc-200 bg-white/80 pl-2.5 pr-1 text-[12px] text-zinc-600 shadow-[0_1px_2px_rgba(24,24,27,.04)]">
      {updating ? <Spinner size={13} className="shrink-0 text-zinc-400"/> : <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-emerald-500"/>}
      <HoverTooltip content={target ? L(`${data.distTag} 通道 ${target}`, `${data.distTag} channel ${target}`) : L("新版本", "New version")}>
        <span className="min-w-0 flex-1 truncate">{updating ? L("正在升级，完成后自动刷新", "Updating — page will reload automatically") : <>{L("新版本", "New version")} <span className="font-mono text-zinc-800">{shortVersion(target!)}</span>  {L("可用", "available")}</>}</span>
      </HoverTooltip>
      {!updating && <HoverTooltip content={data.canUpdate ? L("安装新版本并重启服务", "Install update and restart service") : L("查看手动升级方式", "View manual update instructions")}>
        <button type="button" onClick={() => { if (updating) return; if (!data.canUpdate) { setHintOpen(true); return; } start.reset(); setConfirmOpen(true); }} className="h-7 shrink-0 rounded-md px-2 text-[12px] font-medium text-zinc-900 transition-colors hover:bg-zinc-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-zinc-400/50">{L("升级", "Update")}</button>
      </HoverTooltip>}
    </div>}
    <div className="flex h-8 items-center gap-2 text-[12px]">
      <HoverTooltip content={data.currentVersion}><span className="min-w-0 flex-1 truncate">AgentDock <span className="font-mono">{shortVersion(data.currentVersion)}</span></span></HoverTooltip>
      {/* 有更新提示时也要保留手动检查：服务端缓存 30 分钟，刚发完版时横幅上的版本号
          可能已经过期，没有这个入口就只能等缓存自然失效。 */}
      <HoverTooltip content={updating ? L("升级进行中", "Updating") : check.isPending ? L("正在检查更新", "Checking for updates") : L("检查更新", "Check Updates")}>
        <button type="button" aria-label={L("检查更新", "Check Updates")} disabled={check.isPending || updating} onClick={() => check.mutate()} className="ml-auto grid h-7 w-7 shrink-0 place-items-center rounded-md text-zinc-400 transition-colors duration-150 hover:bg-zinc-100 hover:text-zinc-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-zinc-400/50 disabled:pointer-events-none"><RefreshCw size={13} strokeWidth={2} className={check.isPending ? 'animate-spin text-zinc-500' : ''}/></button>
      </HoverTooltip>
    </div>
    {/* 侧边栏带 transform，内部的 fixed 会以侧边栏为包含块只盖住它自己；弹窗和 toast 挂到 body 才能全屏。 */}
    {createPortal(<>
    <ConfirmDialog
      open={confirmOpen}
      title={L(`升级到 ${data.latestVersion ? shortVersion(data.latestVersion) : '新版本'}？`, `Update to ${data.latestVersion ? shortVersion(data.latestVersion) : 'new version'}?`)}
      description={L("会安装新版本并重启 AgentDock 服务，正在执行的任务会被中断，页面会在升级完成后自动刷新。", "Installs the new version and restarts AgentDock. Active tasks will be interrupted and the page will auto-reload.")}
      confirmLabel={L("升级并重启", "Update & Restart")}
      busy={start.isPending || updating}
      {...(start.error ? { error: start.error.message } : {})}
      onConfirm={() => { if (!start.isPending && !updating) start.mutate(); }}
      onCancel={() => setConfirmOpen(false)}
    />
    <ConfirmDialog
      open={hintOpen}
      title={L("需要手动升级", "Manual Update Required")}
      description={manualHint}
      confirmLabel={L("知道了", "Got it")}
      onConfirm={() => setHintOpen(false)}
      onCancel={() => setHintOpen(false)}
    />
    {toast.toast}
    </>, document.body)}
  </>;
}
