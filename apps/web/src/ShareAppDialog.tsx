import { useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { QRCodeSVG } from 'qrcode.react';
import { Check, Copy, LoaderCircle, QrCode, RefreshCw, Wifi, X } from 'lucide-react';
import { api } from './api';
import { defaultShareUrl, displayShareUrl, shareUrlHost, useDesktopNetwork } from './desktop-network';
import { ConfirmDialog, IconButton } from './ui-controls';
import { useBi } from './i18n';

/**
 * 「在手机上打开」：生成控制台级扫码链接。
 *
 * 二维码里是 master 令牌（与启动输出里的控制台链接同类）：手机扫码后可自由操作
 * 整个 AgentDock。二维码等同于登录凭证，界面上必须明确提示不要转发或公开展示。
 */
export function ShareAppDialog({ onClose }: { onClose(): void }) {
  const L = useBi();
  const network = useDesktopNetwork();
  const link = useQuery({ queryKey: ['share-link'], queryFn: () => api.shareLink(), retry: false });
  const [selected, setSelected] = useState<string>();
  const [copied, setCopied] = useState(false);
  const [lanConfirm, setLanConfirm] = useState(false);
  const [lanBusy, setLanBusy] = useState(false);
  const [lanError, setLanError] = useState<string>();
  const [restarting, setRestarting] = useState(false);

  const data = link.data;
  // 公网入口暂不开放：后端仍保留 public 候选，界面先隐藏，后续开发时放开这一层过滤即可。
  const urls = useMemo(() => data?.urls.filter(item => item.kind !== 'public') ?? [], [data]);
  const chosen = useMemo(() => urls.find(item => item.url === selected) ?? (data ? defaultShareUrl(urls) : undefined), [data, urls, selected]);

  useEffect(() => {
    if (!data) return;
    setSelected(current => current && urls.some(item => item.url === current) ? current : defaultShareUrl(urls)?.url);
  }, [data, urls]);

  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 1_500);
    return () => clearTimeout(timer);
  }, [copied]);

  const copy = async () => {
    if (!chosen) return;
    try {
      await navigator.clipboard.writeText(chosen.url);
      setCopied(true);
    } catch {
      // 非安全上下文（局域网 http）里 clipboard 可能被禁用，退回选中文本让用户自己复制。
      const area = document.createElement('textarea');
      area.value = chosen.url;
      area.style.position = 'fixed';
      area.style.opacity = '0';
      document.body.appendChild(area);
      area.select();
      document.execCommand('copy');
      area.remove();
      setCopied(true);
    }
  };

  const toggleLan = async (enabled: boolean) => {
    setLanBusy(true);
    setLanError(undefined);
    try {
      await network.setLanAccess(enabled);
      setLanConfirm(false);
      setRestarting(true);
    } catch (error) {
      setLanError(error instanceof Error ? error.message : String(error));
    } finally {
      setLanBusy(false);
    }
  };

  const emptyReason = data && !urls.length
    ? network.api && !network.state?.lanAccess
      ? L("桌面客户端目前只监听本机（127.0.0.1），手机无法连接。开启局域网访问后即可扫码。", "Desktop app currently listens on localhost only (127.0.0.1). Enable LAN Access below to connect from your phone.")
      : data.lanEnabled
        ? L("没有检测到可用的局域网地址，请确认电脑已连接 Wi-Fi 或网线。", "No LAN address detected. Check that your computer is connected to Wi-Fi or Ethernet.")
        : L("当前服务只监听本机（--local-only）。用 agent-dock --host 0.0.0.0 重启后，手机才能访问。", "Service is listening locally (--local-only). Restart with agent-dock --host 0.0.0.0 to allow mobile access.")
    : undefined;

  return <div className="ui-overlay fixed inset-0 z-50 grid place-items-center bg-zinc-950/35 p-4" onMouseDown={event => { if (event.currentTarget === event.target && !restarting) onClose(); }}>
    <div role="dialog" aria-modal="true" aria-label={L("在手机上打开", "Open on Mobile")} className="ui-dialog flex max-h-[88dvh] w-full max-w-[460px] flex-col overflow-hidden rounded-[14px] border border-zinc-200 bg-white shadow-[0_24px_80px_rgba(24,24,27,.22)]">
      <div className="flex items-center border-b border-zinc-100 px-4 py-3">
        <div className="min-w-0">
          <h2 className="text-[16px] font-semibold text-zinc-900">{L("在手机上打开", "Open on Mobile")}</h2>
          <p className="mt-0.5 truncate text-[12px] text-zinc-500">{L("扫码后可操作整个控制台", "Scan to access the full console")}</p>
        </div>
        <span className="ml-auto"><IconButton label={L("关闭", "Close")} onClick={onClose}><X size={16}/></IconButton></span>
      </div>

      <div className="space-y-4 overflow-y-auto px-4 py-4">
        {link.isLoading && <div className="flex items-center justify-center gap-2 py-12 text-[12px] text-zinc-500"><LoaderCircle size={16} className="animate-spin"/>{L("正在生成扫码链接…", "Generating QR link…")}</div>}

        {link.isError && <div className="rounded-xl border border-red-100 bg-red-50 px-3 py-3 text-[12px] leading-5 text-red-700">
          {link.error instanceof Error ? link.error.message : L("扫码链接生成失败", "Failed to generate QR link")}
          <button type="button" onClick={() => void link.refetch()} className="ml-2 inline-flex items-center gap-1 font-medium underline underline-offset-2"><RefreshCw size={11}/>{L("重试", "Retry")}</button>
        </div>}

        {data && chosen && <>
          <div className="flex justify-center">
            <div className="w-full max-w-[248px] rounded-xl bg-white p-2.5 ring-1 ring-zinc-200">
              <QRCodeSVG value={chosen.url} size={228} marginSize={2} className="h-auto w-full" title={L("扫码在手机上打开 AgentDock", "Scan to open AgentDock on mobile")}/>
            </div>
          </div>
          <div className="flex items-center gap-2 rounded-lg border border-zinc-200 bg-zinc-50/70 px-2.5 py-2">
            <QrCode size={14} className="shrink-0 text-zinc-400"/>
            <span className="min-w-0 flex-1 truncate font-mono text-[12px] text-zinc-600" title={displayShareUrl(chosen.url)}>{shareUrlHost(chosen.url)}<span className="text-zinc-400">{new URL(displayShareUrl(chosen.url)).pathname}</span></span>
            <button type="button" onClick={() => void copy()} className={`ui-press flex h-7 shrink-0 items-center gap-1 rounded-md px-2 text-[12px] font-medium hover:bg-white ${copied ? 'text-emerald-600' : 'text-zinc-700 hover:text-zinc-900'}`}>
              {copied ? <Check key="check" size={12} className="ui-icon-pop text-emerald-600"/> : <Copy key="copy" size={12}/>}{copied ? L("已复制", "Copied") : L("复制", "Copy")}
            </button>
          </div>

          {urls.length > 1 && <div className="flex flex-wrap gap-1.5">
            {urls.map(item => <button key={item.url} type="button" aria-pressed={item.url === chosen.url} onClick={() => setSelected(item.url)} className={`flex h-7 items-center gap-1.5 rounded-full border px-2.5 text-[12px] transition-colors ${item.url === chosen.url ? 'border-zinc-900 bg-zinc-900 text-white' : 'border-zinc-200 bg-white text-zinc-600 hover:border-zinc-300 hover:text-zinc-900'}`}>
              <Wifi size={11}/>{item.label}
            </button>)}
          </div>}

          <p className="text-[12px] leading-5 text-zinc-500">{L("链接拥有整个控制台权限，有效至", "Grants full console access until ")} {new Date(data.expiresAt).toLocaleDateString('zh-CN', { year: 'numeric', month: 'long', day: 'numeric' })}{L("。请勿转发或公开展示。", ". Do not share publicly.")}</p>
        </>}

        {data && !urls.length && <div className="rounded-xl border border-amber-100 bg-amber-50/70 px-3 py-3 text-[12px] leading-5 text-amber-800">{emptyReason}</div>}

        {(network.api || (data && !data.lanEnabled)) && <section className="border-t border-zinc-100 pt-3">
          <div className="flex items-center gap-2">
            <Wifi size={14} className="text-zinc-400"/>
            <div className="min-w-0 flex-1">
              <div className="text-[13px] text-zinc-800">{L("局域网访问", "LAN Access")}</div>
              <div className="mt-0.5 text-[12px] leading-5 text-zinc-500">{network.api ? (network.state?.lanAccess ? L("已开启，同一 Wi-Fi 下的手机可以连接。", "Enabled — phones on the same Wi-Fi can connect.") : L("关闭中，手机无法通过局域网连接。", "Disabled — mobile devices cannot connect over LAN.")) : L("服务端监听设置由启动参数决定。", "Listener host is controlled by server startup flags.")}</div>
            </div>
            {network.api && !restarting && <button type="button" disabled={lanBusy} onClick={() => setLanConfirm(true)} className="h-7 shrink-0 rounded-md border border-zinc-200 px-2.5 text-[12px] font-medium text-zinc-700 transition-colors hover:border-zinc-300 hover:bg-zinc-50 disabled:opacity-50">
              {lanBusy ? L("处理中…", "Processing…") : network.state?.lanAccess ? L("关闭…", "Disabling…") : L("开启…", "Enabling…")}
            </button>}
          </div>
          {restarting && <div className="mt-2 flex items-center gap-1.5 text-[12px] text-emerald-700"><LoaderCircle size={12} className="animate-spin"/>{L("本地服务正在重启，页面会自动刷新。", "Restarting local server — page will refresh automatically.")}</div>}
          {lanError && <div className="mt-2 rounded-lg border border-red-100 bg-red-50 px-2.5 py-2 text-[12px] text-red-700">{lanError}</div>}
        </section>}
      </div>

      <ConfirmDialog
        open={lanConfirm}
        tone="warning"
        title={network.state?.lanAccess ? L("关闭局域网访问？", "Disable LAN Access?") : L("开启局域网访问？", "Enable LAN Access?")}
        description={L("切换需要重启本地服务，正在运行的 Agent 任务会中断。二维码只在服务重启完成后生效。", "Toggling restarts the local service and interrupts active Agent tasks. QR code refreshes afterward.")}
        confirmLabel={network.state?.lanAccess ? L("关闭并重启", "Disable & Restart") : L("开启并重启", "Enable & Restart")}
        busy={lanBusy}
        error={lanError}
        onCancel={() => { if (!lanBusy) setLanConfirm(false); }}
        onConfirm={() => void toggleLan(!network.state?.lanAccess)}
      />
    </div>
  </div>;
}
