import { useState } from 'react';
import { createPortal } from 'react-dom';
import { RefreshCw } from 'lucide-react';
import { Spinner } from './Loaders';
import { ConfirmDialog } from './ui-controls';
import { HoverTooltip } from './HoverTooltip';
import { useToast } from './Toast';
import { downloadPercent, formatSpeed, formatTransferred, useDesktopUpdate } from './desktop-update';
import { shortVersion } from './self-update-progress';

const buttonClass = 'h-7 shrink-0 rounded-md px-2 text-[12px] font-medium text-zinc-900 transition-colors hover:bg-zinc-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-zinc-400/50 disabled:cursor-not-allowed disabled:text-zinc-400';

/**
 * 桌面客户端（Electron preload 提供 window.agentdockDesktop）的更新入口。
 *
 * 和服务端那条 npm/daemon 链路分开：桌面版跑的是安装包里的运行时，
 * 检查、下载、安装都由 electron-updater 在主进程完成，这里只渲染状态和进度。
 */
export function DesktopUpdateNotice() {
  const toast = useToast(8_000);
  const desktop = useDesktopUpdate();
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [installing, setInstalling] = useState(false);
  const data = desktop.state;
  if (!data) return null;

  const checking = data.phase === 'checking';
  const downloading = data.phase === 'downloading';
  const installingNow = data.phase === 'installing' || installing;
  const busy = checking || downloading || installingNow;
  const target = data.latestVersion;
  const percent = downloadPercent(data);
  const transferred = formatTransferred(data);
  const speed = formatSpeed(data.bytesPerSecond);
  const canCheck = data.phase !== 'unsupported' && !busy && data.phase !== 'downloaded';
  const showBanner = ['available', 'downloading', 'downloaded', 'installing', 'error'].includes(data.phase);

  const check = async () => {
    const next = await desktop.check();
    if (!next) return;
    if (next.phase === 'idle') toast.show(`已是最新版本（${shortVersion(next.currentVersion)}）`, 'info');
    else if (next.phase === 'error') toast.show(next.error ?? '检查更新失败');
    else if (next.phase === 'available' && next.latestVersion) toast.show(`发现新版本 ${shortVersion(next.latestVersion)}`, 'info');
  };

  const download = async () => {
    const next = await desktop.download();
    if (next?.phase === 'error') toast.show(next.error ?? '下载更新失败');
  };

  const install = async () => {
    setInstalling(true);
    try {
      await desktop.install();
    } catch (error) {
      setInstalling(false);
      toast.show(error instanceof Error ? error.message : String(error));
    }
  };

  return <>
    {showBanner && <div className="relative mb-2 flex min-h-9 items-center gap-2 overflow-hidden rounded-lg border border-zinc-200 bg-white/80 pl-2.5 pr-1 text-[12px] text-zinc-600 shadow-[0_1px_2px_rgba(24,24,27,.04)]">
      {data.phase === 'error'
        ? <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-red-500"/>
        : busy || data.phase === 'downloading'
          ? <Spinner size={13} className="shrink-0 text-zinc-400"/>
          : <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-emerald-500"/>}
      {data.phase === 'available' && <>
        <HoverTooltip content={target ? `新版本 ${target}` : '新版本'}>
          <span className="min-w-0 flex-1 truncate">新版本 <span className="font-mono text-zinc-800">{shortVersion(target ?? '')}</span> 可用</span>
        </HoverTooltip>
        <HoverTooltip content="下载安装包并在应用内安装，完成后应用会自动重启">
          <button type="button" onClick={() => void download()} className={buttonClass}>下载并升级</button>
        </HoverTooltip>
      </>}
      {downloading && <>
        <HoverTooltip content={[transferred, speed].filter(Boolean).join(' · ') || '正在下载安装包'}>
          <span className="min-w-0 flex-1 truncate">正在下载{target ? <> <span className="font-mono text-zinc-800">{shortVersion(target)}</span></> : ''} · {Math.round(percent)}%</span>
        </HoverTooltip>
        <span className="h-7 shrink-0 px-2 text-[11px] leading-7 tabular-nums text-zinc-400">{speed}</span>
      </>}
      {data.phase === 'downloaded' && <>
        <HoverTooltip content={target ? `新版本 ${target} 已下载完成` : '更新包已下载完成'}>
          <span className="min-w-0 flex-1 truncate">新版本 <span className="font-mono text-zinc-800">{shortVersion(target ?? '')}</span> 已下载</span>
        </HoverTooltip>
        <HoverTooltip content="退出应用、安装新版本并重新启动">
          <button type="button" onClick={() => setConfirmOpen(true)} className={buttonClass}>重启并安装</button>
        </HoverTooltip>
      </>}
      {installingNow && <>
        <span className="min-w-0 flex-1 truncate">正在重启并安装更新…</span>
      </>}
      {data.phase === 'error' && <>
        <HoverTooltip content={data.error ?? '更新失败'}>
          <span className="min-w-0 flex-1 truncate">更新失败，{data.error ? data.error : '请重试'}</span>
        </HoverTooltip>
        <HoverTooltip content="重新检查更新">
          <button type="button" onClick={() => void check()} className={buttonClass}>重试</button>
        </HoverTooltip>
      </>}
      {downloading && <span className="absolute inset-x-0 bottom-0 h-0.5 bg-zinc-100">
        <span className="block h-full bg-emerald-500 transition-[width] duration-300" style={{ width: `${percent}%` }}/>
      </span>}
    </div>}
    <div className="flex h-8 items-center gap-1 text-[12px]">
      <HoverTooltip content={`当前版本 ${data.currentVersion}`}><span className="min-w-0 truncate">AgentDock <span className="font-mono">{shortVersion(data.currentVersion)}</span></span></HoverTooltip>
      {data.phase !== 'unsupported' && <HoverTooltip content={checking ? '正在检查更新' : data.phase === 'downloaded' ? '更新已下载，重启后安装' : '检查更新'}>
        <button type="button" aria-label="检查更新" disabled={!canCheck} onClick={() => void check()} className="grid h-7 w-7 shrink-0 place-items-center rounded-md text-zinc-400 transition-colors duration-150 hover:bg-white hover:text-zinc-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-zinc-400/50 disabled:pointer-events-none"><RefreshCw size={13} strokeWidth={2} className={checking ? 'animate-spin text-zinc-500' : ''}/></button>
      </HoverTooltip>}
    </div>
    {/* 侧边栏带 transform，fixed 的弹窗会被限制在侧边栏内，必须挂到 body。 */}
    {createPortal(<>
      <ConfirmDialog
        open={confirmOpen}
        title={`重启并安装 ${target ? shortVersion(target) : '新版本'}？`}
        description="会退出 AgentDock、安装新版本并自动重新打开，正在执行的任务会被中断。"
        confirmLabel="重启并安装"
        busy={installingNow}
        onConfirm={() => void install()}
        onCancel={() => setConfirmOpen(false)}
      />
      {toast.toast}
    </>, document.body)}
  </>;
}
