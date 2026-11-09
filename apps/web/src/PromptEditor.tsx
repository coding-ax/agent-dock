import { useEffect, useRef, useState } from 'react';
import CodeMirror, { EditorView } from '@uiw/react-codemirror';
import { markdownLanguage } from '@codemirror/lang-markdown';
import { Eye, Pencil, Sparkles } from 'lucide-react';
import { MarkdownContent } from './MarkdownContent';
import { Spinner } from './Loaders';
import { api } from './api';
import { buildPreInjectAssistPrompt } from './ai-assist';

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

/** 平台补全默认超时：推理模型写短提示词也可能超过 30 秒，且浏览器侧要留一点读响应余量。 */
const assistTimeoutMs = 90_000;

/** 预注入 Prompt 编辑器：Markdown 写入 + 同框预览，高度跟随内容而不是固定一大片空白。 */
export default function PromptEditor({ value, onChange, aiContext }: { value: string; onChange(value: string): void; /** 提供给 AI 的机器人配置摘要；不传则不显示 AI 补全。 */ aiContext?: string }) {
  const [mode, setMode] = useState<'edit' | 'preview'>('edit');
  const [generating, setGenerating] = useState(false);
  const [assist, setAssist] = useState<{ text?: string; error?: string }>();
  const abortRef = useRef<AbortController | undefined>(undefined);
  useEffect(() => () => abortRef.current?.abort(), []);

  async function generate() {
    if (generating) return;
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setGenerating(true);
    setAssist(undefined);
    try {
      const result = await api.completeLlm(buildPreInjectAssistPrompt(aiContext ?? '', value), assistTimeoutMs, { signal: controller.signal });
      const text = result.text.trim();
      setAssist(text ? { text } : { error: '模型没有返回内容，请换个模型或稍后重试。' });
    } catch (error) {
      if (!controller.signal.aborted) setAssist({ error: error instanceof Error ? error.message : String(error) });
    } finally {
      if (!controller.signal.aborted) setGenerating(false);
    }
  }

  function cancel() {
    abortRef.current?.abort();
    abortRef.current = undefined;
    setGenerating(false);
    setAssist({ error: '已取消生成。' });
  }

  return <div className="mt-1.5 overflow-hidden rounded-md border border-zinc-300 bg-white ui-field-within">
    <div className="flex items-center gap-0.5 border-b border-zinc-200 bg-zinc-50 px-1.5 py-1">
      <ModeTab active={mode === 'edit'} onClick={() => setMode('edit')} icon={<Pencil size={11}/>}>编辑</ModeTab>
      <ModeTab active={mode === 'preview'} onClick={() => setMode('preview')} icon={<Eye size={11}/>}>预览</ModeTab>
      {aiContext !== undefined && (generating
        ? <button type="button" onClick={cancel} className="ml-0.5 inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[12px] text-zinc-500 hover:bg-white hover:text-zinc-800"><Spinner size={11}/>生成中… · 取消</button>
        : <button type="button" onClick={() => void generate()} className="ml-0.5 inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[12px] text-zinc-500 hover:bg-white hover:text-zinc-800"><Sparkles size={11}/>AI 补全</button>)}
      <span className="ml-auto tabular-nums pr-1 text-[12px] text-zinc-400">{value.length} 字</span>
    </div>
    {mode === 'edit'
      ? <CodeMirror theme="none" value={value} onChange={onChange} height="auto" minHeight="120px" maxHeight="360px" extensions={extensions} basicSetup={setup} indentWithTab={false} placeholder="例如：每轮结束时在合适的地方回复发起轮次的用户，并尽量 @ ta，回复尽量简短。"/>
      : <div className="max-h-[360px] min-h-[120px] overflow-auto px-3 py-2">
        {value.trim()
          ? <MarkdownContent sessionId={undefined}>{value}</MarkdownContent>
          : <span className="text-[12px] text-zinc-400">还没有内容。切回「编辑」写入每轮注入的提示词。</span>}
      </div>}
    {assist && <div className="border-t border-zinc-200 bg-zinc-50 px-3 py-2">
      {assist.error
        ? <div className="text-[12px] leading-5 text-red-600">{assist.error}<div className="mt-0.5 text-zinc-400">AI 补全使用「Agent 设置 → 模型端点」里配置的模型。</div></div>
        : <>
          <div className="flex items-center gap-2">
            <span className="text-[12px] font-medium text-zinc-700">AI 建议</span>
            <span className="text-[12px] text-zinc-400">应用前可先预览</span>
            <button type="button" onClick={() => { if (assist.text) { onChange(assist.text); setMode('edit'); } setAssist(undefined); }} className="ml-auto rounded bg-zinc-900 px-2 py-1 text-[12px] font-medium text-white hover:bg-zinc-800">使用</button>
            <button type="button" onClick={() => setAssist(undefined)} className="rounded px-2 py-1 text-[12px] text-zinc-500 hover:bg-white">放弃</button>
          </div>
          <p className="mt-1 whitespace-pre-wrap break-words text-[12px] leading-5 text-zinc-800">{assist.text}</p>
        </>}
    </div>}
  </div>;
}

function ModeTab({ active, onClick, icon, children }: { active: boolean; onClick: () => void; icon: React.ReactNode; children: React.ReactNode }) {
  return <button type="button" aria-pressed={active} onClick={onClick} className={`inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[12px] ${active ? 'bg-white text-zinc-900 shadow-sm' : 'text-zinc-500 hover:text-zinc-800'}`}>{icon}{children}</button>;
}
