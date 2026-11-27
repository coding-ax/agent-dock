import { ExitGate } from './ExitGate';
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
  const button = <button type="button" aria-label={label} aria-pressed={active} disabled={disabled} onClick={onClick} className={`ui-press grid h-8 w-8 place-items-center rounded-lg hover:bg-zinc-100 hover:text-zinc-900 active:scale-[.95] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-zinc-400/50 disabled:pointer-events-none disabled:opacity-30 ${active ? 'bg-zinc-100 text-zinc-900' : 'text-zinc-500'}`}>{children}</button>;
  return <HoverTooltip content={label}>{button}</HoverTooltip>;
}

export interface SlidingSegmentedOption<T extends string = string> {
  value: T;
  label: ReactNode;
  disabled?: boolean;
  ariaLabel?: string;
  tooltip?: ReactNode;
}

/**
 * 统一滑动胶囊分段控件（纯 CSS transform 滑块，零布局重排、60fps）。
 *
 * 适用于 2–4 个等宽互斥选项（设置项分段、侧栏「时间/项目」、看板「列视图/矩阵」、
 * 弹窗标签页等），同时支持 radiogroup 与 tablist 两种无障碍语义角色。
 */
export function SlidingSegmented<T extends string>({
  options,
  value,
  onChange,
  ariaLabel,
  role = 'radiogroup',
  size = 'md',
  className = '',
  itemClassName = ''
}: {
  options: ReadonlyArray<SlidingSegmentedOption<NoInfer<T>>>;
  value: T;
  onChange(value: NoInfer<T>): void;
  ariaLabel?: string;
  role?: 'radiogroup' | 'tablist';
  size?: 'xs' | 'sm' | 'md';
  className?: string;
  itemClassName?: string;
}) {
  const activeIndex = Math.max(0, options.findIndex(option => option.value === value));
  const count = Math.max(1, options.length);
  const trackMetrics = size === 'xs'
    ? 'rounded-lg p-0.5'
    : size === 'sm'
      ? 'rounded-xl p-0.5'
      : 'rounded-xl p-1';
  const thumbRadius = size === 'xs' ? 'rounded-[6px]' : 'rounded-lg';
  const thumbInset = size === 'md' ? 4 : 2;
  const itemHeight = size === 'xs' ? 'h-6 text-[11.5px] px-2' : size === 'sm' ? 'h-7 text-[12px] px-2.5' : 'h-7 text-[12px] px-3';

  return (
    <div
      role={role}
      aria-label={ariaLabel}
      className={`relative grid items-center bg-zinc-100 ${trackMetrics} ${className}`}
      style={{ gridTemplateColumns: `repeat(${count}, minmax(0, 1fr))` }}
    >
      <span
        aria-hidden="true"
        className={`ui-segmented-thumb pointer-events-none absolute bg-white shadow-[0_1px_2px_rgba(0,0,0,.08),0_1px_3px_rgba(0,0,0,.04)] ring-1 ring-zinc-200/70 ${thumbRadius}`}
        style={{
          top: thumbInset,
          bottom: thumbInset,
          left: thumbInset,
          width: `calc((100% - ${thumbInset * 2}px) / ${count})`,
          transform: `translateX(${activeIndex * 100}%)`
        }}
      />
      {options.map(option => {
        const active = option.value === value;
        const button = (
          <button
            key={option.value}
            type="button"
            role={role === 'tablist' ? 'tab' : 'radio'}
            aria-checked={role === 'radiogroup' ? active : undefined}
            aria-selected={role === 'tablist' ? active : undefined}
            aria-label={option.ariaLabel}
            disabled={option.disabled}
            onClick={() => onChange(option.value)}
            className={`relative z-10 flex items-center justify-center gap-1.5 whitespace-nowrap font-medium transition-colors duration-150 active:scale-[.98] disabled:cursor-not-allowed disabled:opacity-40 ${thumbRadius} ${itemHeight} ${active ? 'text-zinc-900' : 'text-zinc-500 hover:text-zinc-800'} ${itemClassName}`}
          >
            {option.label}
          </button>
        );
        return option.tooltip
          ? <HoverTooltip key={option.value} content={option.tooltip}>{button}</HoverTooltip>
          : button;
      })}
    </div>
  );
}

/**
 * 「标题 + 说明 + 控件」的标准设置行。飞书配置、设置弹窗里的所有开关/下拉都走这一套，
 * 保证不同页面的右边缘、行高和分隔线一致。
 *
 * 窄屏（<520px）时控件换到说明文字下方并左对齐，避免 160px 的下拉把说明挤成竖条。
 */
export function SettingRow({ title, description, children, className = '', inline = false }: { title: ReactNode; description?: ReactNode; children: ReactNode; className?: string; inline?: boolean }) {
  if (inline) {
    return <div className={`flex items-center justify-between gap-4 border-t border-zinc-100 px-4 py-3.5 first:border-t-0 ${className}`}>
      <div className="min-w-0 flex-1">
        <div className="text-[14px] text-zinc-900">{title}</div>
        {description && <div className="mt-0.5 text-[12px] leading-5 text-zinc-500">{description}</div>}
      </div>
      <div className="flex shrink-0 items-center justify-end">{children}</div>
    </div>;
  }
  return <div className={`flex flex-col gap-2.5 border-t border-zinc-100 px-4 py-3.5 first:border-t-0 min-[520px]:flex-row min-[520px]:items-center min-[520px]:gap-4 ${className}`}>
    <div className="min-w-0 flex-1">
      <div className="text-[14px] text-zinc-900">{title}</div>
      {description && <div className="mt-0.5 text-[12px] leading-5 text-zinc-500">{description}</div>}
    </div>
    <div className="flex w-full shrink-0 items-center min-[520px]:w-auto min-[520px]:justify-end">{children}</div>
  </div>;
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
  return <ExitGate open={open}><ConfirmDialogPanel {...props}/></ExitGate>;
}

function ConfirmDialogPanel({ title, description, confirmLabel, tone = 'warning', busy = false, error, onConfirm, onCancel }: Omit<ConfirmDialogProps, 'open'>) {
  const panelRef = useRef<HTMLDivElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  useModalFocusTrap({ panel: panelRef, initial: cancelRef, dismissible: !busy, onDismiss: onCancel });
  const danger = tone === 'danger';
  return <div className="ui-overlay fixed inset-0 z-50 grid place-items-center bg-zinc-950/35 p-4" onMouseDown={event => { if (!busy && event.currentTarget === event.target) onCancel(); }}>
    <div ref={panelRef} role="alertdialog" aria-modal="true" aria-labelledby="confirm-dialog-title" aria-describedby="confirm-dialog-description" className="ui-dialog w-full max-w-[420px] overflow-hidden rounded-[14px] border border-zinc-200 bg-white shadow-[0_28px_90px_rgba(24,24,27,.24)]">
      <div className="flex gap-3.5 px-5 pb-4 pt-5">
        <div className={`grid h-10 w-10 shrink-0 place-items-center rounded-xl ${danger ? 'bg-red-50 text-red-600 ring-1 ring-red-100' : 'bg-amber-50 text-amber-700 ring-1 ring-amber-100'}`}><AlertTriangle size={19} strokeWidth={1.8}/></div>
        <div className="min-w-0 pt-0.5"><h2 id="confirm-dialog-title" className="text-[16px] font-semibold tracking-[-.01em] text-zinc-900">{title}</h2><p id="confirm-dialog-description" className="mt-1.5 text-[12px] leading-5 text-zinc-500">{description}</p></div>
      </div>
      {error && <div className="mx-5 mb-4 rounded-lg border border-red-100 bg-red-50 px-3 py-2 text-[12px] leading-4 text-red-700">{error}</div>}
      <div className="flex justify-end gap-2 border-t border-zinc-100 bg-zinc-50/70 px-5 py-3.5">
        <Button ref={cancelRef} size="large" disabled={busy} onClick={onCancel}>取消</Button>
        <Button type="primary" danger={danger} size="large" loading={busy} onClick={onConfirm} className="min-w-24">{busy ? '处理中' : confirmLabel}</Button>
      </div>
    </div>
  </div>;
}
