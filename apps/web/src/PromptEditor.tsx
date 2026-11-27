import { useState, type ReactNode } from 'react';
import CodeMirror, { EditorView } from '@uiw/react-codemirror';
import { markdownLanguage } from '@codemirror/lang-markdown';
import { Eye, Pencil } from 'lucide-react';
import { MarkdownContent } from './MarkdownContent';
import { AiTextAssistControl, useAiFlash } from './AiTextAssist';

const extensions = [
  markdownLanguage.extension,
  EditorView.lineWrapping,
  EditorView.contentAttributes.of({ 'aria-label': '预注入 Prompt' }),
  EditorView.theme({
    '&': { fontSize: '12px', backgroundColor: 'transparent', color: 'rgb(var(--zinc-900))' },
    // 这是一段给人看的提示词，不是代码：不要行号、不要当前行高亮，字距按正文来。
    '.cm-content': { fontFamily: '"Fira Code", ui-monospace, SFMono-Regular, Menlo, monospace', lineHeight: '1.7', padding: '6px 0' },
    '&.cm-focused': { outline: 'none' },
    // 颜色全走 CSS 变量：随浅色 / 深色主题自动切换，不用在主题变化时重建编辑器。
    '.cm-cursor, .cm-dropCursor': { borderLeftColor: 'rgb(var(--zinc-900))' },
    '.cm-placeholder': { color: 'rgb(var(--zinc-400))' },
    '&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground': { backgroundColor: 'rgb(var(--accent) / .25)' }
  })
];
const setup = { lineNumbers: false, foldGutter: false, highlightActiveLine: false, autocompletion: false };

/** 预注入 Prompt 编辑器：Markdown 写入 + 同框预览 + 统一 AI 辅助写作/优化（支持未配置置灰提示与多步撤销）。 */
export default function PromptEditor({ value, onChange, aiContext, resetKey }: {
  value: string;
  onChange(value: string): void;
  /** 提供给 AI 的机器人配置摘要；不传则不显示 AI 辅助。 */
  aiContext?: string;
  /** 切换机器人时重置撤销栈。 */
  resetKey?: string;
}) {
  const [mode, setMode] = useState<'edit' | 'preview'>('edit');
  const flash = useAiFlash();

  return <div className={`mt-1.5 overflow-hidden rounded-md border border-zinc-300 bg-white ui-field-within ${flash.flashClass}`}>
    <div className="flex flex-wrap items-center gap-1 border-b border-zinc-200 bg-zinc-50 px-1.5 py-1">
      <ModeTab active={mode === 'edit'} onClick={() => setMode('edit')} icon={<Pencil size={11}/>}>编辑</ModeTab>
      <ModeTab active={mode === 'preview'} onClick={() => setMode('preview')} icon={<Eye size={11}/>}>预览</ModeTab>
      {aiContext !== undefined && (
        <AiTextAssistControl
          mode="prompt_write"
          variant="pill"
          size="xs"
          popoverSide="bottom"
          popoverAlign="start"
          value={value}
          onChange={next => { onChange(next); setMode('edit'); }}
          onFlash={flash.triggerFlash}
          resetKey={resetKey}
          context={() => ({
            field: '飞书机器人预注入 Prompt',
            purpose: '在每轮飞书对话中、用户请求之前隐式注入给 Agent，用于约束行为偏好与回复风格（中文 Markdown，控制在 180 字以内）',
            botContext: aiContext,
            maxChars: 220
          })}
          testId="lark-pre-inject-ai"
        />
      )}
      <span className="ml-auto shrink-0 tabular-nums pr-1 text-[12px] text-zinc-400">{value.length} 字</span>
    </div>
    {mode === 'edit'
      ? <CodeMirror theme="none" value={value} onChange={onChange} height="auto" minHeight="120px" maxHeight="360px" extensions={extensions} basicSetup={setup} indentWithTab={false} placeholder="例如：每轮结束时在合适的地方回复发起轮次的用户，并尽量 @ ta，回复尽量简短。"/>
      : <div className="max-h-[360px] min-h-[120px] overflow-auto px-3 py-2">
        {value.trim()
          ? <MarkdownContent sessionId={undefined}>{value}</MarkdownContent>
          : <span className="text-[12px] text-zinc-400">还没有内容。切回「编辑」写入每轮注入的提示词。</span>}
      </div>}
  </div>;
}

function ModeTab({ active, onClick, icon, children }: { active: boolean; onClick: () => void; icon: ReactNode; children: ReactNode }) {
  return <button type="button" aria-pressed={active} onClick={onClick} className={`inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[12px] ${active ? 'bg-white text-zinc-900 shadow-sm' : 'text-zinc-500 hover:text-zinc-800'}`}>{icon}{children}</button>;
}
