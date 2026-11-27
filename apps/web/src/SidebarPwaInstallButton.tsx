import { useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useEventListener } from 'ahooks';
import { MonitorDown, X } from 'lucide-react';
import { ExitGate } from './ExitGate';
import { HoverTooltip } from './HoverTooltip';
import { Spinner } from './Loaders';
import { triggerPwaInstall, type PwaInstallSnapshot } from './pwa-install';

export type PwaInstallTrigger = () => Promise<'accepted' | 'dismissed' | 'manual'>;

export function pwaInstallTooltipLabel(pwa: Pick<PwaInstallSnapshot, 'installing'>): string {
  return pwa.installing ? '等待确认安装…' : '安装为桌面应用';
}

export async function runSidebarPwaInstallAction(
  pwa: Pick<PwaInstallSnapshot, 'canPrompt' | 'installing'>,
  guideOpen: boolean,
  trigger: PwaInstallTrigger = triggerPwaInstall
): Promise<{ nextGuideOpen: boolean; outcome?: 'accepted' | 'dismissed' | 'manual' }> {
  if (pwa.installing) return { nextGuideOpen: guideOpen };
  if (!pwa.canPrompt) return { nextGuideOpen: !guideOpen };
  const outcome = await trigger();
  if (outcome === 'manual') return { nextGuideOpen: true, outcome };
  return { nextGuideOpen: false, outcome };
}

/**
 * 侧边栏顶部 BrandLogo（AGENTDOCK）同行最右侧的 PWA 安装快捷入口。
 *
 * 仅在桌面 Web 浏览器且尚未安装时展示（非 Electron、非 standalone、非移动端、非窄屏抽屉），
 * 复用 pwa-install.ts 共享状态：支持原生一键安装、等待确认态与手工安装引导弹层。
 */
export function SidebarPwaInstallButton({
  pwa,
  onInstall = triggerPwaInstall,
  initialGuideOpen = false
}: {
  pwa: PwaInstallSnapshot;
  onInstall?: PwaInstallTrigger;
  initialGuideOpen?: boolean;
}) {
  const [guideOpen, setGuideOpen] = useState(initialGuideOpen);
  const [position, setPosition] = useState<{ top: number; left: number; width: number }>();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const showGuide = guideOpen && pwa.visible && !pwa.canPrompt && Boolean(pwa.manualHint);

  const place = () => {
    const rect = triggerRef.current?.getBoundingClientRect();
    if (!rect || typeof window === 'undefined') return;
    if (rect.width === 0 && rect.height === 0) {
      setGuideOpen(false);
      return;
    }
    const width = Math.min(252, window.innerWidth - 16);
    const left = Math.max(8, Math.min(rect.right - width, window.innerWidth - width - 8));
    setPosition({ top: rect.bottom + 8, left, width });
  };

  useEventListener('pointerdown', (event: PointerEvent) => {
    const target = event.target as Node | null;
    if (!triggerRef.current?.contains(target) && !popoverRef.current?.contains(target)) {
      setGuideOpen(false);
    }
  }, { target: () => document, enable: showGuide });

  useEventListener('keydown', (event: KeyboardEvent) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      setGuideOpen(false);
      triggerRef.current?.focus();
    }
  }, { target: () => document, enable: showGuide });

  useEventListener('resize', () => {
    if (showGuide) place();
  }, { target: () => window, enable: showGuide });

  if (!pwa.visible) return null;

  const label = pwaInstallTooltipLabel(pwa);

  const handleClick = async () => {
    if (!pwa.canPrompt && !guideOpen) place();
    const { nextGuideOpen } = await runSidebarPwaInstallAction(pwa, guideOpen, onInstall);
    if (nextGuideOpen) place();
    setGuideOpen(nextGuideOpen);
  };

  return <>
    <HoverTooltip content={label} side="bottom" align="end">
      <button
        ref={triggerRef}
        type="button"
        data-pwa-install-shortcut="sidebar-header"
        aria-label={label}
        aria-expanded={showGuide || undefined}
        aria-haspopup={!pwa.canPrompt ? 'dialog' : undefined}
        disabled={pwa.installing}
        onClick={() => void handleClick()}
        className={`hidden h-7 w-7 shrink-0 place-items-center rounded-lg transition-[color,background-color,transform] duration-150 active:scale-[.96] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-zinc-400/50 disabled:pointer-events-none disabled:opacity-50 md:grid ${showGuide ? 'bg-zinc-100 text-zinc-900' : 'text-zinc-500 hover:bg-zinc-100 hover:text-zinc-900'}`}
      >
        {pwa.installing ? <Spinner size={14} label="正在打开安装弹窗" className="text-zinc-500"/> : <MonitorDown size={15}/>}
      </button>
    </HoverTooltip>
    {typeof document !== 'undefined' && createPortal(
      <ExitGate open={showGuide && Boolean(position)} ms={150}>
        {showGuide && position ? (
          <div
            ref={popoverRef}
            role="dialog"
            aria-label="安装为桌面应用指引"
            data-pwa-install-guide="sidebar-header"
            data-placement="top-end"
            style={{ top: position.top, left: position.left, width: position.width }}
            className="ui-popover fixed z-50 rounded-xl border border-zinc-200 bg-white p-3 text-left shadow-[0_16px_40px_rgba(24,24,27,.16)]"
          >
            <div className="flex items-center gap-1.5">
              <MonitorDown size={14} className="shrink-0 text-zinc-500"/>
              <span className="min-w-0 flex-1 text-[13px] font-medium text-zinc-900">安装为桌面应用</span>
              <HoverTooltip content="关闭" side="bottom">
                <button
                  type="button"
                  aria-label="关闭安装引导"
                  onClick={() => setGuideOpen(false)}
                  className="ui-press grid h-6 w-6 shrink-0 place-items-center rounded-md text-zinc-400 transition-colors hover:bg-zinc-100 hover:text-zinc-700"
                >
                  <X size={13}/>
                </button>
              </HoverTooltip>
            </div>
            <p className="mt-1.5 text-[12px] leading-5 text-zinc-600">{pwa.manualHint}</p>
          </div>
        ) : null}
      </ExitGate>,
      document.body
    )}
  </>;
}
