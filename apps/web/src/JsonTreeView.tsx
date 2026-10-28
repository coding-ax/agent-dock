import { useState } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';

/** 单行字符串预览上限：更长的值折叠起来，点开才看全。 */
const STRING_PREVIEW = 120;

/** 完整记录的结构视图：逐层折叠，替代一整屏 JSON 文本。 */
export function JsonTreeView({ value, wrap }: { value: unknown; wrap: boolean }) {
  return <div className="font-mono text-[11px] leading-5 text-zinc-700">
    <JsonNode label={undefined} value={value} depth={0} wrap={wrap}/>
  </div>;
}

function JsonNode({ label, value, depth, wrap }: { label: string | undefined; value: unknown; depth: number; wrap: boolean }) {
  const [open, setOpen] = useState(depth < 1);
  const entries = isBranch(value) ? Object.entries(value as Record<string, unknown>) : undefined;
  if (!entries) return <div className={`flex gap-1 ${wrap ? 'break-words' : 'whitespace-pre'}`}><KeyName label={label}/><Primitive value={value}/></div>;
  const array = Array.isArray(value);
  if (!entries.length) return <div className="flex gap-1"><KeyName label={label}/><span className="text-zinc-400">{array ? '[]' : '{}'}</span></div>;
  return <div>
    <button type="button" aria-expanded={open} onClick={() => setOpen(current => !current)} className="flex max-w-full items-center gap-1 rounded text-left hover:bg-zinc-100">
      {open ? <ChevronDown size={11} className="shrink-0 text-zinc-400"/> : <ChevronRight size={11} className="shrink-0 text-zinc-400"/>}
      <KeyName label={label}/>
      <span className="shrink-0 text-zinc-400">{array ? '[' : '{'}{entries.length} 项{open ? '' : (array ? ']' : '}')}</span>
    </button>
    {open && <div className="ml-[5px] border-l border-zinc-200 pl-3">
      {entries.map(([key, child]) => <JsonNode key={key} label={array ? `[${key}]` : key} value={child} depth={depth + 1} wrap={wrap}/>)}
    </div>}
  </div>;
}

function KeyName({ label }: { label?: string }) {
  return label && <span className="text-zinc-500">{label}<span className="text-zinc-300">:</span></span>;
}

function Primitive({ value }: { value: unknown }) {
  if (value === null) return <span className="text-zinc-400">null</span>;
  if (value === undefined) return <span className="text-zinc-400">undefined</span>;
  if (typeof value === 'boolean') return <span className="text-amber-700">{String(value)}</span>;
  if (typeof value === 'number') return <span className="text-sky-700">{String(value)}</span>;
  const text = String(value);
  if (text.length <= STRING_PREVIEW) return <span className="text-emerald-700">{text}</span>;
  return <details className="m-0">
    <summary className="cursor-pointer list-none text-emerald-700">{text.slice(0, STRING_PREVIEW)}…<span className="ml-1 text-[10px] text-zinc-400">共 {text.length} 字</span></summary>
    <span className="text-emerald-700">{text}</span>
  </details>;
}

function isBranch(value: unknown): boolean {
  return typeof value === 'object' && value !== null;
}
