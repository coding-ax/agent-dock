import { AlertTriangle } from 'lucide-react';
import { Button } from 'antd';
import { useRef, type MouseEvent, type ReactNode } from 'react';
import { useModalFocusTrap } from './useModalFocusTrap';
import { HoverTooltip } from './HoverTooltip';

/**
 * 图标按钮。提示走应用的 HoverTooltip，不用原生 title——原生提示要等约 1 秒、
 * 样式跟随系统、无法限宽，图标按钮上等于没有提示，用户不敢点自己认不出的图标。
 *
 * 提示以**按钮本身**为锚点（HoverTooltip 用 asChild 把触发行为装到这个 button 上）。
 * 不能把 HoverTooltip 放进按钮里包住图标：那样锚点是没有盒子的内联元素，
 * Radix 会把提示定位到视口原点（实测偏出上千像素）。
 */
export function IconButton({ label, disabled, active, onClick, children }: { label: string; disabled?: boolean; active?: boolean; onClick(event: MouseEvent<HTMLButtonElement>): void; children: ReactNode }) {
  const button = <button type="button" aria-label={label} aria-pressed={active} disabled={disabled} onClick={onClick} className={`grid h-8 w-8 place-items-center rounded-lg transition-[color,background-color,transform] duration-200 hover:bg-zinc-100 hover:text-zinc-900 active:scale-[.96] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-zinc-400/50 disabled:pointer-events-none disabled:opacity-30 ${active ? 'bg-zinc-100 text-zinc-900' : 'text-zinc-500'}`}>{children}</button>;
  return <HoverTooltip content={label}>{button}</HoverTooltip>;
}

type ConfirmDialogProps = {
  open: boolean;
  title: string;
  description: string;
  confirmLabel: string;
  tone?: 'danger' | 'warning';
  busy?: boolean;
  error?: string;
  onConfirm(): void;
  onCancel(): void;
};

export function ConfirmDialog({ open, ...props }: ConfirmDialogProps) {
  // 只在打开时挂载内层：焦点陷阱的生命周期就此等同于对话框本身。
  return open ? <ConfirmDialogPanel {...props}/> : null;
}

function ConfirmDialogPanel({ title, description, confirmLabel, tone = 'warning', busy = false, error, onConfirm, onCancel }: Omit<ConfirmDialogProps, 'open'>) {
  const panelRef = useRef<HTMLDivElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  useModalFocusTrap({ panel: panelRef, initial: cancelRef, dismissible: !busy, onDismiss: onCancel });
  const danger = tone === 'danger';
  return <div className="ui-overlay fixed inset-0 z-50 grid place-items-center bg-zinc-950/35 p-4 backdrop-blur-[3px]" onMouseDown={event => { if (!busy && event.currentTarget === event.target) onCancel(); }}>
    <div ref={panelRef} role="alertdialog" aria-modal="true" aria-labelledby="confirm-dialog-title" aria-describedby="confirm-dialog-description" className="ui-dialog w-full max-w-[420px] overflow-hidden rounded-2xl border border-zinc-200 bg-white shadow-[0_28px_90px_rgba(24,24,27,.24)]">
      <div className="flex gap-3.5 px-5 pb-4 pt-5">
        <div className={`grid h-10 w-10 shrink-0 place-items-center rounded-xl ${danger ? 'bg-red-50 text-red-600 ring-1 ring-red-100' : 'bg-amber-50 text-amber-700 ring-1 ring-amber-100'}`}><AlertTriangle size={19} strokeWidth={1.8}/></div>
        <div className="min-w-0 pt-0.5"><h2 id="confirm-dialog-title" className="text-[15px] font-semibold tracking-[-.01em] text-zinc-900">{title}</h2><p id="confirm-dialog-description" className="mt-1.5 text-[12px] leading-5 text-zinc-500">{description}</p></div>
      </div>
      {error && <div className="mx-5 mb-4 rounded-lg border border-red-100 bg-red-50 px-3 py-2 text-[11px] leading-4 text-red-700">{error}</div>}
      <div className="flex justify-end gap-2 border-t border-zinc-100 bg-zinc-50/70 px-5 py-3.5">
        <Button ref={cancelRef} size="large" disabled={busy} onClick={onCancel}>取消</Button>
        <Button type="primary" danger={danger} size="large" loading={busy} onClick={onConfirm} className="min-w-24">{busy ? '处理中' : confirmLabel}</Button>
      </div>
    </div>
  </div>;
}
