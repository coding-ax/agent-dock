import { X } from 'lucide-react';
import type { Session } from './api';
import { IconButton } from './ui-controls';

/** 查看会话创建时的系统提示词。只读，内容通常很长，所以单独做成弹窗而不是塞在设置里。 */
export function SystemPromptDialog({ session, onClose }: { session: Session; onClose(): void }) {
  return <div className="ui-overlay fixed inset-0 z-30 grid place-items-center bg-zinc-950/30 p-4" onMouseDown={event => { if (event.currentTarget === event.target) onClose(); }}>
    <div role="dialog" aria-modal="true" aria-label="系统提示词" className="ui-dialog flex max-h-[80dvh] w-full max-w-2xl flex-col overflow-hidden rounded-[14px] border border-zinc-200 bg-white shadow-[0_24px_80px_rgba(24,24,27,.2)]">
      <div className="flex items-center border-b border-zinc-100 px-4 py-3">
        <div className="min-w-0"><h2 className="text-[16px] font-semibold text-zinc-900">系统提示词</h2><p className="mt-0.5 truncate text-[12px] text-zinc-500">创建时提示词</p></div>
        <span className="ml-auto"><IconButton label="关闭" onClick={onClose}><X size={16}/></IconButton></span>
      </div>
      <div className="space-y-5 overflow-y-auto px-4 py-4">
        <section><h3 className="mb-2 text-[12px] font-semibold text-zinc-500">创建时提示词</h3><pre className="m-0 whitespace-pre-wrap break-words font-mono text-[12px] leading-5 text-zinc-700">{session.systemPrompt}</pre></section>
      </div>
    </div>
  </div>;
}
