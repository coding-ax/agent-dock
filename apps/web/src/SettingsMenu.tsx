import { useRef, useState } from 'react';
import { useEventListener } from 'ahooks';
import { useQuery } from '@tanstack/react-query';
import { AlarmClock, Archive, Bot, FolderOpen, Settings, Settings2, Workflow } from 'lucide-react';
import { api } from './api';
import { AutostartToggle } from './AutostartToggle';
import { SelfUpdateNotice } from './SelfUpdateNotice';
import { ThemeSegmented } from './ThemeToggle';
import { useDismissOnOutsidePointer } from './useDismissOnOutsidePointer';

const itemClass = 'flex h-[34px] w-full items-center gap-2.5 rounded-lg px-2.5 text-[14px] font-medium text-zinc-600 transition-colors duration-150 hover:bg-zinc-100 hover:text-zinc-900';

/**
 * 侧栏底部唯一的入口：把定时任务、归档、导入、Agent / 飞书设置、主题、开机自启、版本都收进一个向上弹出的菜单，
 * 侧栏主体只剩会话列表。
 *
 * 弹层只用 hidden 切换、不条件渲染：SelfUpdateNotice 里有「升级中轮询版本号、完成后刷新页面」的状态，卸载就丢了。
 */
export function SettingsMenu({ webDenied, archivedCount, onSchedule, onArchived, onImport, onAgentConfig, onLark }: {
  webDenied: boolean;
  archivedCount: number;
  onSchedule(): void;
  onArchived(): void;
  onImport(): void;
  onAgentConfig(): void;
  onLark(): void;
}) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  useDismissOnOutsidePointer(root, open, () => setOpen(false));
  useEventListener('keydown', (event: KeyboardEvent) => { if (event.key === 'Escape') setOpen(false); }, { target: () => document, enable: open });
  // 与 SelfUpdateNotice 同一个 queryKey 和选项，只用来在入口上点一个「有新版本」的小红点。
  const update = useQuery({ queryKey: ['self-update'], queryFn: () => api.selfUpdateStatus(), enabled: !webDenied, retry: false, refetchInterval: 5 * 60_000, refetchOnWindowFocus: false });
  const hasUpdate = Boolean(update.data?.updateAvailable || update.data?.updating);
  const pick = (action: () => void) => () => { setOpen(false); action(); };

  return <div ref={root} className="relative min-w-[268px] border-t border-zinc-200 p-2">
    <div role="menu" aria-label="设置" style={{ transformOrigin: 'bottom center' }} aria-hidden={!open} inert={!open} className={`absolute inset-x-2 bottom-full z-30 mb-1 max-h-[75dvh] overflow-y-auto rounded-xl border border-zinc-200 bg-white p-1.5 shadow-[0_-12px_36px_rgba(12,13,16,.14)] transition-[opacity,transform,visibility] duration-200 ease-[cubic-bezier(.2,0,0,1)] ${open ? 'visible translate-y-0 opacity-100' : 'invisible translate-y-1.5 opacity-0'}`}>
      <button type="button" role="menuitem" onClick={pick(onSchedule)} className={itemClass}><AlarmClock size={16}/><span>定时任务</span></button>
      <button type="button" role="menuitem" onClick={pick(onArchived)} className={itemClass}><Archive size={16}/><span>归档会话</span><span className="ml-auto text-[12px] tabular-nums text-zinc-400">{archivedCount}</span></button>
      <button type="button" role="menuitem" onClick={pick(onImport)} className={itemClass}><FolderOpen size={16}/><span>导入外部会话</span></button>
      <a role="menuitem" href="/sources-router.html" className={itemClass}><Workflow size={16}/><span>消息源与 Router</span><span className="ml-auto text-[12px] font-normal text-zinc-400">外部事件</span></a>
      <div className="my-1 border-t border-zinc-200/70"/>
      <button type="button" role="menuitem" onClick={pick(onAgentConfig)} className={itemClass}><Bot size={16}/><span>Agent 设置</span></button>
      <button type="button" role="menuitem" onClick={pick(onLark)} className={itemClass}><Settings2 size={16}/><span>飞书设置</span></button>
      <div className="my-1 border-t border-zinc-200/70"/>
      <div className="px-2.5 py-1"><div className="mb-1.5 text-[12px] text-zinc-500">外观</div><ThemeSegmented/></div>
      <div className="px-2.5 py-1 text-[12px] text-zinc-600"><AutostartToggle enabled={!webDenied}/></div>
      <div className="mt-1 border-t border-zinc-200/70 px-2.5 pb-1 pt-2 text-[12px] text-zinc-400"><SelfUpdateNotice enabled={!webDenied}/></div>
    </div>
    <button type="button" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen(value => !value)} className={`flex h-9 w-full items-center gap-2.5 rounded-lg px-2.5 text-[14px] font-medium transition-colors duration-150 ${open ? 'bg-zinc-100 text-zinc-900' : 'text-zinc-600 hover:bg-zinc-100 hover:text-zinc-900'}`}>
      <Settings size={16} className={`transition-transform duration-300 ease-[cubic-bezier(.2,0,0,1)] ${open ? 'rotate-90' : ''}`}/><span>设置</span>
      {hasUpdate && <span className="ml-auto flex items-center gap-1 text-[12px] font-normal text-emerald-600"><span className="h-1.5 w-1.5 rounded-full bg-emerald-500 ui-status-pulse"/>有新版本</span>}
    </button>
  </div>;
}
