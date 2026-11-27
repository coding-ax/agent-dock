import { useEffect, useState } from 'react';
import { Check, Copy, RotateCcw, X } from 'lucide-react';
import type { Session } from './api';
import { AiFieldHeader, AiTextAssistControl, useAiFlash } from './AiTextAssist';
import { IconButton } from './ui-controls';

/**
 * 查看并优化会话的系统提示词。
 * 支持用 AI 辅助改写/润色（带多步回撤与高亮过渡）并一键复制用于新会话，不影响原会话历史记录。
 */
export function SystemPromptDialog({ session, onClose }: { session: Session; onClose(): void }) {
  const original = session.systemPrompt ?? '';
  const [draft, setDraft] = useState(original);
  const [copied, setCopied] = useState(false);
  const flash = useAiFlash();

  useEffect(() => {
    setDraft(original);
    setCopied(false);
  }, [session.id, original]);

  const dirty = draft !== original;

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(draft);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1_600);
    } catch {
      // 忽略剪贴板权限拒绝，用户可直接从文本框选中复制
    }
  };

  return <div className="ui-overlay fixed inset-0 z-30 grid place-items-center bg-zinc-950/30 p-3 sm:p-4" onMouseDown={event => { if (event.currentTarget === event.target) onClose(); }}>
    <div role="dialog" aria-modal="true" aria-label="系统提示词" className="ui-dialog flex max-h-[84dvh] w-full max-w-2xl flex-col overflow-hidden rounded-[14px] border border-zinc-200 bg-white shadow-[0_24px_80px_rgba(24,24,27,.2)]">
      <div className="flex items-center gap-2 border-b border-zinc-100 px-4 py-3">
        <div className="min-w-0">
          <h2 className="text-[16px] font-semibold text-zinc-900">系统提示词</h2>
          <p className="mt-0.5 truncate text-[12px] text-zinc-500">创建时提示词 · 支持 AI 优化改写与一键复制</p>
        </div>
        <span className="ml-auto"><IconButton label="关闭" onClick={onClose}><X size={16}/></IconButton></span>
      </div>
      <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-4 py-4">
        <AiFieldHeader
          label="创建时提示词"
          htmlFor="session-system-prompt-editor"
          hint={dirty ? '已修改草稿' : undefined}
          assist={
            <AiTextAssistControl
              mode="prompt_optimize"
              variant="pill"
              size="xs"
              popoverSide="bottom"
              popoverAlign="end"
              value={draft}
              onChange={setDraft}
              onFlash={flash.triggerFlash}
              resetKey={session.id}
              context={() => ({
                field: '会话 System Prompt',
                purpose: '优化或重写当前会话的系统提示词，使其角色定义、约束与输出格式更清晰可执行',
                cwd: session.cwd,
                agentName: session.agentId,
                ...(session.model ? { model: session.model } : {}),
                ...(session.title ? { sessionTitle: session.title } : {})
              })}
              testId="system-prompt-dialog-ai"
            />
          }
        />
        <textarea
          id="session-system-prompt-editor"
          value={draft}
          onChange={event => setDraft(event.target.value)}
          rows={12}
          aria-label="系统提示词编辑区"
          placeholder="当前会话暂无系统提示词，可使用右上角 AI 帮写或直接输入…"
          className={`ui-field min-h-[220px] w-full flex-1 resize-y rounded-xl border border-zinc-200 bg-zinc-50/40 px-3 py-2.5 font-mono text-[12px] leading-5 text-zinc-800 outline-none placeholder:text-zinc-400 ${flash.flashClass}`}
        />
        <div className="flex flex-wrap items-center justify-between gap-2 text-[12px] text-zinc-400">
          <span className="tabular-nums">{draft.length} 字 · 优化后可复制到新会话使用</span>
          <div className="flex items-center gap-1.5">
            {dirty && (
              <button
                type="button"
                onClick={() => setDraft(original)}
                className="inline-flex h-7 items-center gap-1 rounded-lg border border-zinc-200 bg-white px-2.5 text-[12px] font-medium text-zinc-600 transition-colors hover:bg-zinc-50 hover:text-zinc-900"
              >
                <RotateCcw size={12}/>恢复原值
              </button>
            )}
            <button
              type="button"
              disabled={!draft.trim()}
              onClick={() => void handleCopy()}
              className="ui-press inline-flex h-7 items-center gap-1 rounded-lg bg-zinc-900 px-3 text-[12px] font-medium text-white hover:bg-zinc-700 disabled:opacity-40"
            >
              {copied ? <Check key="check" size={12} className="ui-icon-pop"/> : <Copy key="copy" size={12}/>}
              {copied ? '已复制' : '复制提示词'}
            </button>
          </div>
        </div>
      </div>
    </div>
  </div>;
}
