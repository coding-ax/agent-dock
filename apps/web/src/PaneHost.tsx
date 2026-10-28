import { useRef, useState, type ReactNode } from 'react';
import { useLocalStorageState, useEventListener } from 'ahooks';
import { ChevronRight, Folder, MessagesSquare, PanelRight, ScrollText, Terminal as TerminalIcon, X } from 'lucide-react';
import { HoverTooltip } from './HoverTooltip';
import { paneTypeOptions } from './PaneTypeMenu';
import type { PaneTab } from './store';
import type { Shortcut } from './useShortcuts';

const MIN_WIDTH = 320;
const MAX_WIDTH = 900;
const DEFAULT_WIDTH = 480;

/** 副屏宽度独立记忆。 */
const widthStorageKey = 'agentdock:pane-host-width';

const paneDescriptions: Record<PaneTab['kind'], string> = {
  session: '查看会话内容',
  terminal: '在当前工作目录运行命令',
  'side-chat': '新建对话，与主会话并排协作',
  files: '浏览和预览工作目录里的文件',
  raw: '查看完整输出与运行细节',
};

export const paneTabIcon = (kind: PaneTab['kind'], size = 12): ReactNode => {
  if (kind === 'terminal') return <TerminalIcon size={size}/>;
  if (kind === 'files') return <Folder size={size}/>;
  if (kind === 'side-chat') return <MessagesSquare size={size}/>;
  if (kind === 'raw') return <ScrollText size={size}/>;
  return null;
};

/**
 * 右栏多标签面板区。
 *
 * 两处关键机制：
 * - 左缘拖拽调宽（localStorage 记忆），lg 以上与主区并排、lg 以下全屏覆盖；
 * - **各标签内容常驻挂载、仅 hidden 切换**——终端切走再切回不能丢 xterm 画面与 ws 连接，
 *   这是硬约束，不是优化。
 *
 * 标签按主会话显示；其他会话的标签保持挂载，切回时恢复现场。
 */
export function PaneHost({ tabs, mountedTabs, activeTabId, visible, shortcuts, acceptsDrop = false, onDropSession, onActivate, onClose, onAdd, onPick, onHide, children }: {
  tabs: PaneTab[];
  mountedTabs: PaneTab[];
  activeTabId?: string;
  visible: boolean;
  shortcuts: Shortcut[];
  /** 正在被拖进副屏的会话：为真时整块面板区变成落点。载荷在 App 上，这里只需要知道「有没有」。 */
  acceptsDrop?: boolean;
  onDropSession(): void;
  onActivate(id: string): void;
  onClose(id: string): void;
  onAdd(anchor?: HTMLElement): void;
  onPick(kind: PaneTab['kind']): void;
  onHide(): void;
  children: Record<string, ReactNode>;
}) {
  const [width, setWidth] = useLocalStorageState<number>(widthStorageKey, { defaultValue: DEFAULT_WIDTH });
  const [dragging, setDragging] = useState(false);
  const addButtonRef = useRef<HTMLButtonElement>(null);
  const startX = useRef(0);
  const startWidth = useRef(0);

  const clampedWidth = Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, width ?? DEFAULT_WIDTH));

  useEventListener('pointermove', (event: PointerEvent) => {
    if (!dragging) return;
    // 拖的是左缘：鼠标左移应当变宽。
    setWidth(Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, startWidth.current + (startX.current - event.clientX))));
  }, { target: () => document, enable: dragging });
  useEventListener('pointerup', () => dragging && setDragging(false), { target: () => document, enable: dragging });

  return <div className={`ui-side-panel fixed inset-0 z-30 min-h-0 flex-col border-l border-zinc-200 bg-white shadow-[-12px_0_36px_rgba(24,24,27,.1)] lg:static lg:z-auto lg:w-[var(--pane-w)] lg:shrink-0 lg:shadow-none ${visible ? 'flex' : 'hidden'}`} style={{ ['--pane-w' as string]: `${clampedWidth}px` }}>
    <div onPointerDown={event => { event.preventDefault(); startX.current = event.clientX; startWidth.current = clampedWidth; setDragging(true); }} className="absolute inset-y-0 left-0 z-10 hidden w-1.5 -translate-x-1/2 cursor-col-resize touch-none bg-transparent hover:bg-blue-400/30 lg:block" title="拖拽调整宽度"/>

    <div className="flex h-9 shrink-0 items-center gap-0.5 border-b border-zinc-200 px-1.5">
      <div className="flex min-w-0 flex-1 items-center gap-0.5 overflow-x-auto">
        {tabs.length === 0 && <span className="pl-2 text-[11px] font-medium text-zinc-500">副屏</span>}
        {tabs.map(tab => <div key={tab.id} className={`group flex h-7 min-w-0 max-w-[180px] shrink-0 items-center rounded-md pl-2 pr-0.5 text-[11px] font-medium transition-colors ${activeTabId === tab.id ? 'bg-zinc-900 text-white' : 'text-zinc-500 hover:bg-zinc-100 hover:text-zinc-900'}`}>
          <button type="button" onClick={() => onActivate(tab.id)} title={tab.title} className="flex min-w-0 flex-1 items-center gap-1.5">
            {paneTabIcon(tab.kind)}
            <span className="min-w-0 truncate">{tab.title}</span>
          </button>
          <HoverTooltip content={`关闭 ${tab.title ?? '面板'}`}><button type="button" onClick={() => onClose(tab.id)} aria-label={`关闭 ${tab.title ?? '面板'}`} className={`grid h-5 w-5 shrink-0 place-items-center rounded transition-opacity ${activeTabId === tab.id ? 'text-white/60 hover:bg-white/15 hover:text-white' : 'text-zinc-400 opacity-0 hover:bg-zinc-200 hover:text-zinc-800 group-hover:opacity-100'}`}><X size={11}/></button></HoverTooltip>
        </div>)}
      </div>
      {tabs.length > 0 && <HoverTooltip content="新建面板（终端 / 侧边聊天 / 文件 / 原始日志）"><button ref={addButtonRef} type="button" onClick={() => onAdd(addButtonRef.current ?? undefined)} aria-label="新建面板" className="ml-auto grid h-7 w-7 shrink-0 place-items-center rounded-md text-zinc-400 hover:bg-zinc-100 hover:text-zinc-800"><PlusGlyph/></button></HoverTooltip>}
      <HoverTooltip content="隐藏副屏"><button type="button" onClick={onHide} aria-label="隐藏副屏" className="grid h-7 w-7 shrink-0 place-items-center rounded-md text-zinc-400 hover:bg-zinc-100 hover:text-zinc-800"><X size={14}/></button></HoverTooltip>
    </div>

    <div className="relative min-h-0 flex-1">
      {tabs.length === 0 && <div className="absolute inset-0 overflow-y-auto px-5 py-8">
        <div className="mx-auto flex min-h-full w-full max-w-[380px] flex-col justify-center">
          <div className="mb-8 text-center">
            <span className="mx-auto mb-4 grid h-10 w-10 place-items-center rounded-xl border border-zinc-200 bg-zinc-50 text-zinc-600"><PanelRight size={19} strokeWidth={1.7}/></span>
            <h2 className="text-[15px] font-semibold text-zinc-900">把需要的工具放在右边</h2>
            <p className="mt-1.5 text-[12px] leading-5 text-zinc-500">选择一个面板，和当前会话并排使用。</p>
          </div>
          {(['继续工作', '查看上下文'] as const).map((group, groupIndex) => <section key={group} className={groupIndex === 0 ? '' : 'mt-6'}>
            <h3 className="mb-2 px-1 text-[10px] font-semibold tracking-[.12em] text-zinc-400">{group}</h3>
            <div className="overflow-hidden rounded-xl border border-zinc-200 bg-white shadow-[0_2px_8px_rgba(24,24,27,.03)]">
              {paneTypeOptions(shortcuts).slice(groupIndex * 2, groupIndex * 2 + 2).map((option, index) => <button key={option.kind} type="button" onClick={() => onPick(option.kind)} className={`group flex w-full items-center gap-3 px-3.5 py-3 text-left transition-colors hover:bg-zinc-50 focus-visible:relative focus-visible:z-10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-zinc-400 ${index > 0 ? 'border-t border-zinc-100' : ''}`}>
                <span className="grid h-9 w-9 shrink-0 place-items-center rounded-lg border border-zinc-100 bg-zinc-50 text-zinc-600">{paneTabIcon(option.kind, 17)}</span>
                <span className="min-w-0 flex-1"><span className="block text-[12px] font-medium text-zinc-800">{option.label}</span><span className="mt-0.5 block text-[11px] leading-4 text-zinc-400">{paneDescriptions[option.kind]}</span></span>
                {option.shortcut && <span className="shrink-0 font-mono text-[10px] text-zinc-400">{option.shortcut.label}</span>}
                <ChevronRight size={13} className="shrink-0 text-zinc-300 transition-colors group-hover:text-zinc-500"/>
              </button>)}
            </div>
          </section>)}
        </div>
      </div>}
      {/* 常驻挂载 + hidden 切换：终端靠这条活着，不能改成条件渲染。 */}
      {mountedTabs.map(tab => <div key={tab.id} className={`absolute inset-0 ${tabs.includes(tab) && activeTabId === tab.id ? '' : 'hidden'}`}>{children[tab.id]}</div>)}
      {/* 落点铺在内容区之上（不是整个面板）：拖拽时标签栏仍可点。onDragOver 必须 preventDefault 才收得到 drop。 */}
      {acceptsDrop && <div onDragOver={event => event.preventDefault()} onDrop={event => { event.preventDefault(); onDropSession(); }} className="absolute inset-0 z-20 grid place-items-center border-2 border-dashed border-zinc-400 bg-zinc-900/5">
        <span className="rounded-lg bg-white px-3 py-1.5 text-[12px] font-medium text-zinc-700 shadow-[0_2px_8px_rgba(24,24,27,.08)]">放到这里，在副屏打开</span>
      </div>}
    </div>
  </div>;
}

/** 内联的加号，避免为一个字形再引一个图标名。 */
function PlusGlyph() {
  return <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M12 5v14M5 12h14"/></svg>;
}
