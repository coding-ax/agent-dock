import { useRef, useState } from 'react';
import { useEventListener } from 'ahooks';
import { useQuery } from '@tanstack/react-query';
import { AlarmClock, Archive, BarChart3, Bell, Bot, FolderOpen, MessagesSquare, MonitorDown, Palette, PawPrint, Regex, Settings, Settings2, Smartphone } from 'lucide-react';
import { api } from './api';
import { AutostartToggle } from './AutostartToggle';
import { KeepAwakeToggle } from './KeepAwakeToggle';
import { resolveDesktopUpdateBadge, useDesktopUpdate } from './desktop-update';
import { triggerPwaInstall, usePwaInstall } from './pwa-install';
import { SelfUpdateNotice } from './SelfUpdateNotice';
import { HoverTooltip } from './HoverTooltip';
import { Spinner } from './Loaders';
import {
  resolveServerUpdateBadge,
  SELF_UPDATE_QUERY_KEY,
  SELF_UPDATE_REFETCH_INTERVAL_MS,
  useSelfUpdateClientState
} from './self-update-progress';
import { ThemeSegmented } from './ThemeToggle';
import { useActiveTheme } from './theme';
import { useDismissOnOutsidePointer } from './useDismissOnOutsidePointer';

const itemClass = 'ui-press flex h-[34px] w-full items-center gap-2.5 rounded-lg px-2.5 text-[14px] font-medium text-zinc-600 hover:bg-zinc-100 hover:text-zinc-900';

/**
 * 侧栏底部唯一的入口：把定时任务、归档、导入、Agent / 飞书设置、主题、开机自启、永不休眠、版本都收进一个向上弹出的菜单，
 * 侧栏主体只剩会话列表。
 *
 * 弹层只用 hidden 切换、不条件渲染：SelfUpdateNotice 里有「升级中轮询版本号、完成后刷新页面」的状态，卸载就丢了。
 */
export function SettingsMenu({ webDenied, archivedCount, onUsage, onSchedule, onArchived, onImport, onAgentConfig, onSideChatConfig, onAssistant, onNotifications, onLark, onLarkRegexTriggers, onLarkAvatar, onThemeStudio, onShare }: {
  webDenied: boolean;
  archivedCount: number;
  onUsage(): void;
  onSchedule(): void;
  onArchived(): void;
  onImport(): void;
  onAgentConfig(): void;
  onSideChatConfig(): void;
  onAssistant(): void;
  onNotifications?(): void;
  onLark(): void;
  onLarkRegexTriggers?(): void;
  onLarkAvatar(): void;
  onThemeStudio?(): void;
  onShare(): void;
}) {
  const activeTheme = useActiveTheme();
  const [open, setOpen] = useState(false);
  const [showPwaGuide, setShowPwaGuide] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const closeMenu = () => { setOpen(false); setShowPwaGuide(false); };
  useDismissOnOutsidePointer(root, open, closeMenu);
  useEventListener('keydown', (event: KeyboardEvent) => { if (event.key === 'Escape') closeMenu(); }, { target: () => document, enable: open });
  // 与 SelfUpdateNotice 同一个 queryKey、选项和客户端升级状态，让外层入口同步显示「有新版本」或「正在更新…」。
  // 桌面壳有 preload 更新通道时用它的状态，服务端那条 npm 查询不再有意义。
  const desktopUpdate = useDesktopUpdate();
  const pwa = usePwaInstall();
  const selfUpdateClient = useSelfUpdateClientState();
  const update = useQuery({ queryKey: SELF_UPDATE_QUERY_KEY, queryFn: () => api.selfUpdateStatus(), enabled: !webDenied && !desktopUpdate.api, retry: false, refetchInterval: SELF_UPDATE_REFETCH_INTERVAL_MS, refetchOnWindowFocus: false });
  const updateBadge = desktopUpdate.api
    ? resolveDesktopUpdateBadge(desktopUpdate.state, desktopUpdate.installing)
    : resolveServerUpdateBadge(update.data, selfUpdateClient);
  const pick = (action: () => void) => () => { closeMenu(); action(); };
  const handlePwaInstall = async () => {
    if (!pwa.canPrompt) {
      setShowPwaGuide(current => !current);
      return;
    }
    const result = await triggerPwaInstall();
    if (result === 'accepted') closeMenu();
    else if (result === 'manual') setShowPwaGuide(true);
  };

  return <div ref={root} className="relative flex min-w-[268px] items-center gap-1 border-t border-zinc-200 p-2">
    <div role="menu" aria-label="设置" style={{ transformOrigin: 'bottom center' }} aria-hidden={!open} inert={!open} className={`absolute inset-x-2 bottom-full z-30 mb-1 max-h-[75dvh] overflow-y-auto rounded-xl border border-zinc-200 bg-white p-1.5 shadow-[0_-12px_36px_rgba(12,13,16,.14)] transition-[opacity,transform,visibility] duration-[180ms] ease-[cubic-bezier(.16,1,.3,1)] ${open ? 'visible translate-y-0 scale-100 opacity-100' : 'invisible translate-y-1.5 scale-[0.97] opacity-0'}`}>
      <button type="button" role="menuitem" onClick={pick(onUsage)} className={itemClass}><BarChart3 size={16}/><span>消耗看板</span></button>
      <button type="button" role="menuitem" onClick={pick(onSchedule)} className={itemClass}><AlarmClock size={16}/><span>定时任务</span></button>
      <button type="button" role="menuitem" onClick={pick(onArchived)} className={itemClass}><Archive size={16}/><span>归档会话</span><span className="ml-auto text-[12px] tabular-nums text-zinc-400">{archivedCount}</span></button>
      <button type="button" role="menuitem" onClick={pick(onImport)} className={itemClass}><FolderOpen size={16}/><span>导入外部会话</span></button>
      <div className="my-1 border-t border-zinc-200/70"/>
      <button type="button" role="menuitem" onClick={pick(onAgentConfig)} className={itemClass}><Bot size={16}/><span>Agent 设置</span></button>
      <button type="button" role="menuitem" onClick={pick(onSideChatConfig)} className={itemClass}><MessagesSquare size={16}/><span>侧边对话设置</span></button>
      <button type="button" role="menuitem" onClick={pick(onAssistant)} className={itemClass}><PawPrint size={16}/><span>小猫与督办</span></button>
      {onNotifications && <button type="button" role="menuitem" onClick={pick(onNotifications)} className={itemClass}><Bell size={16}/><span>通知设置</span></button>}
      <button type="button" role="menuitem" onClick={pick(onLark)} className={itemClass}><Settings2 size={16}/><span>飞书设置</span></button>
      {onLarkRegexTriggers && <button type="button" role="menuitem" onClick={pick(onLarkRegexTriggers)} className={itemClass}><Regex size={16}/><span>群聊正则唤起</span></button>}
      <button type="button" role="menuitem" onClick={pick(onLarkAvatar)} className={itemClass}><Bot size={16}/><span>AI 飞书替身</span></button>
      {!desktopUpdate.api && pwa.visible && <>
        <div className="my-1 border-t border-zinc-200/70"/>
        <button type="button" role="menuitem" disabled={pwa.installing} onClick={() => void handlePwaInstall()} className={`${itemClass} disabled:opacity-60`}>
          {pwa.installing ? <Spinner size={15} label="正在打开安装弹窗" className="text-zinc-500"/> : <MonitorDown size={16}/>}
          <span>{pwa.installing ? '等待确认安装…' : '安装为桌面应用'}</span>
          {pwa.canPrompt && <span className="ml-auto rounded bg-zinc-100 px-1.5 py-0.5 text-[11px] font-normal text-zinc-500">PWA</span>}
        </button>
        {showPwaGuide && !pwa.canPrompt && Boolean(pwa.manualHint) && <div className="mx-1.5 mb-1 mt-0.5 rounded-lg border border-zinc-200 bg-zinc-50 px-2.5 py-2 text-[12px] leading-5 text-zinc-600">{pwa.manualHint}</div>}
      </>}
      <div className="my-1 border-t border-zinc-200/70"/>
      {onThemeStudio && (
        <button type="button" role="menuitem" data-testid="settings-theme-studio-item" onClick={pick(onThemeStudio)} className={itemClass}>
          <Palette size={16}/>
          <span>主题工坊</span>
          <span className="ml-auto flex max-w-[110px] items-center gap-1.5 truncate text-[11.5px] font-normal text-zinc-400">
            <span className="h-2 w-2 shrink-0 rounded-full ring-1 ring-zinc-300" style={{ backgroundColor: activeTheme.tokens.accent }}/>
            <span className="truncate">{activeTheme.name}</span>
          </span>
        </button>
      )}
      <div className="px-2.5 py-1"><div className="mb-1.5 text-[12px] text-zinc-500">外观</div><ThemeSegmented onOpenStudio={onThemeStudio ? pick(onThemeStudio) : undefined}/></div>
      <div className="px-2.5 py-1 text-[12px] text-zinc-600"><AutostartToggle enabled={!webDenied}/><KeepAwakeToggle enabled={!webDenied}/></div>
      <div className="mt-1 border-t border-zinc-200/70 px-2.5 pb-1 pt-2 text-[12px] text-zinc-400"><SelfUpdateNotice enabled={!webDenied}/></div>
    </div>
    <button type="button" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen(value => !value)} className={`ui-press flex h-9 min-w-0 flex-1 items-center gap-2.5 rounded-lg px-2.5 text-[14px] font-medium ${open ? 'bg-zinc-100 text-zinc-900' : 'text-zinc-600 hover:bg-zinc-100 hover:text-zinc-900'}`}>
      <Settings size={16} className={`transition-transform duration-300 ease-[cubic-bezier(.16,1,.3,1)] ${open ? 'rotate-90' : ''}`}/><span>设置</span>
      {updateBadge === 'updating' && <span className="ml-auto flex shrink-0 items-center gap-1.5 text-[12px] font-normal text-zinc-500"><Spinner size={12} label="正在更新" className="text-zinc-500"/>正在更新…</span>}
      {updateBadge === 'available' && <span className="ml-auto flex shrink-0 items-center gap-1 text-[12px] font-normal text-emerald-600"><span className="h-1.5 w-1.5 rounded-full bg-emerald-500 ui-status-pulse"/>有新版本</span>}
    </button>
    <HoverTooltip content="在手机上打开（扫码）">
      <button type="button" onClick={() => { setOpen(false); onShare(); }} aria-label="在手机上打开" className="ui-press grid h-9 w-9 shrink-0 place-items-center rounded-lg text-zinc-600 hover:bg-zinc-100 hover:text-zinc-900"><Smartphone size={16}/></button>
    </HoverTooltip>
  </div>;
}
