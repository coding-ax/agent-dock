import { useEffect, useRef, useState } from 'react';
import { Check, Copy, X } from 'lucide-react';
import type { Session } from './api';
import { copyText } from './session-context-menu';
import { IconButton } from './ui-controls';
import { useModalFocusTrap } from './useModalFocusTrap';
import { useBi } from './i18n';

/**
 * 查看会话创建时注入的系统提示词快照。
 * 纯只读展示：已创建会话的 System Prompt 无法保存回写，这里仅提供清晰阅读与一键复制。
 */
export function SystemPromptDialog({ session, onClose }: { session: Session; onClose(): void }) {
  const L = useBi();
  const prompt = session.systemPrompt ?? '';
  const hasPrompt = Boolean(prompt.trim());
  const [copied, setCopied] = useState(false);
  const [copyError, setCopyError] = useState<string>();
  const copyTimerRef = useRef<number | undefined>(undefined);
  const panelRef = useRef<HTMLDivElement>(null);

  useModalFocusTrap({ panel: panelRef, initial: panelRef, dismissible: true, onDismiss: onClose });

  useEffect(() => {
    setCopied(false);
    setCopyError(undefined);
    return () => {
      if (copyTimerRef.current !== undefined) window.clearTimeout(copyTimerRef.current);
    };
  }, [session.id, prompt]);

  const handleCopy = async () => {
    if (!hasPrompt) return;
    const result = await copyText(prompt);
    if (result.ok) {
      setCopyError(undefined);
      setCopied(true);
      if (copyTimerRef.current !== undefined) window.clearTimeout(copyTimerRef.current);
      copyTimerRef.current = window.setTimeout(() => {
        setCopied(false);
        copyTimerRef.current = undefined;
      }, 1_600);
    } else {
      setCopied(false);
      setCopyError(result.message);
    }
  };

  return <div className="ui-overlay fixed inset-0 z-30 grid place-items-center bg-zinc-950/30 p-3 sm:p-4" onMouseDown={event => { if (event.currentTarget === event.target) onClose(); }}>
    <div
      ref={panelRef}
      tabIndex={-1}
      role="dialog"
      aria-modal="true"
      aria-label={L("系统提示词", "System Prompt")}
      className="ui-dialog flex max-h-[84dvh] w-full max-w-2xl flex-col overflow-hidden rounded-[14px] border border-zinc-200 bg-white shadow-[0_24px_80px_rgba(24,24,27,.2)] outline-none"
    >
      <div className="flex shrink-0 items-start gap-2 border-b border-zinc-100 px-4 py-3">
        <div className="min-w-0 flex-1">
          <h2 className="text-[16px] font-semibold text-zinc-900">{L("系统提示词", "System Prompt")}</h2>
          <p className="mt-0.5 text-[12px] leading-4 text-zinc-500">{L("创建会话时注入的系统提示词快照（只读，可一键复制）", "Read-only snapshot of the system prompt injected at session creation")}</p>
        </div>
        <span className="ml-auto shrink-0"><IconButton label={L("关闭", "Close")} onClick={onClose}><X size={16}/></IconButton></span>
      </div>
      <div className="flex min-h-0 flex-1 flex-col gap-3 px-4 py-4">
        <div className="flex shrink-0 items-center justify-between gap-2">
          <h3 className="text-[12px] font-semibold text-zinc-600">{L("创建时提示词", "Creation Prompt")}</h3>
          <span className="inline-flex items-center rounded-md border border-zinc-200 bg-zinc-50 px-1.5 py-0.5 text-[11px] font-medium text-zinc-500">
            
            {L("只读快照", "Read-only")}
          </span>
        </div>
        <pre
          data-testid="system-prompt-readonly-content"
          aria-label={L("创建时系统提示词（只读）", "System prompt at creation (read-only)")}
          className="m-0 min-h-[160px] flex-1 overflow-y-auto whitespace-pre-wrap break-words rounded-xl border border-zinc-200 bg-zinc-50/70 px-3.5 py-3 font-mono text-[12px] leading-5 text-zinc-800 select-text"
        >
          {hasPrompt ? prompt : <span className="text-zinc-400">{L("当前会话暂无系统提示词。", "No system prompt configured for this session.")}</span>}
        </pre>
        <div className="flex shrink-0 flex-wrap items-center justify-between gap-2 text-[12px] text-zinc-500">
          <span className="tabular-nums">
            {copyError ? <span role="alert" className="text-red-600">{copyError}</span> : L(`${prompt.length.toLocaleString()} 字 · 已创建会话的提示词不可修改`, `${prompt.length.toLocaleString()} chars · Prompt cannot be edited after creation`)}
          </span>
          <button
            type="button"
            data-testid="system-prompt-copy-btn"
            disabled={!hasPrompt}
            onClick={() => void handleCopy()}
            className="ui-press inline-flex h-8 items-center gap-1.5 rounded-lg bg-zinc-900 px-3 text-[12px] font-medium text-white hover:bg-zinc-700 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {copied ? <Check key="check" size={12} className="ui-icon-pop"/> : <Copy key="copy" size={12}/>}
            {copied ? L("已复制", "Copied") : L("复制提示词", "Copy Prompt")}
          </button>
        </div>
      </div>
    </div>
  </div>;
}
