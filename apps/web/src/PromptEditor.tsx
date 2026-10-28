import { useState } from 'react';
import CodeMirror, { EditorView } from '@uiw/react-codemirror';
import { markdown } from '@codemirror/lang-markdown';
import { Eye, Pencil } from 'lucide-react';
import { MarkdownContent } from './MarkdownContent';

const extensions = [
  markdown(),
  EditorView.lineWrapping,
  EditorView.contentAttributes.of({ 'aria-label': '预注入 Prompt' }),
  EditorView.theme({
    '&': { fontSize: '12px' },
    // 这是一段给人看的提示词，不是代码：不要行号、不要当前行高亮，字距按正文来。
    '.cm-content': { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', lineHeight: '1.7', padding: '6px 0' },
    '&.cm-focused': { outline: 'none' }
  })
];
const setup = { lineNumbers: false, foldGutter: false, highlightActiveLine: false, autocompletion: false };

/** 预注入 Prompt 编辑器：Markdown 写入 + 同框预览，高度跟随内容而不是固定一大片空白。 */
export default function PromptEditor({ value, onChange }: { value: string; onChange(value: string): void }) {
  const [mode, setMode] = useState<'edit' | 'preview'>('edit');
  return <div className="mt-1.5 overflow-hidden rounded-md border border-zinc-300 bg-white ui-field-within">
    <div className="flex items-center gap-0.5 border-b border-zinc-200 bg-zinc-50 px-1.5 py-1">
      <ModeTab active={mode === 'edit'} onClick={() => setMode('edit')} icon={<Pencil size={11}/>}>编辑</ModeTab>
      <ModeTab active={mode === 'preview'} onClick={() => setMode('preview')} icon={<Eye size={11}/>}>预览</ModeTab>
      <span className="ml-auto tabular-nums pr-1 text-[10px] text-zinc-400">{value.length} 字</span>
    </div>
    {mode === 'edit'
      ? <CodeMirror value={value} onChange={onChange} height="auto" minHeight="120px" maxHeight="360px" extensions={extensions} basicSetup={setup} indentWithTab={false} placeholder="例如：每轮结束时在合适的地方回复发起轮次的用户，并尽量 @ ta，回复尽量简短。"/>
      : <div className="max-h-[360px] min-h-[120px] overflow-auto px-3 py-2">
        {value.trim()
          ? <MarkdownContent sessionId={undefined}>{value}</MarkdownContent>
          : <span className="text-[12px] text-zinc-400">还没有内容。切回「编辑」写入每轮注入的提示词。</span>}
      </div>}
  </div>;
}

function ModeTab({ active, onClick, icon, children }: { active: boolean; onClick: () => void; icon: React.ReactNode; children: React.ReactNode }) {
  return <button type="button" aria-pressed={active} onClick={onClick} className={`inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] ${active ? 'bg-white text-zinc-900 shadow-sm' : 'text-zinc-500 hover:text-zinc-800'}`}>{icon}{children}</button>;
}
