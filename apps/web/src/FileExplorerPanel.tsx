import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ChevronRight, File as FileIcon, Folder as FolderIcon, FolderOpen, LoaderCircle, RefreshCw } from 'lucide-react';
import { api, type FsListEntry } from './api';
import { filePreviewPath, workspacePreviewPath } from './file-preview-link';
import { MarkdownContent } from './MarkdownContent';

function formatSize(size: number): string {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / 1024 / 1024).toFixed(1)} MB`;
}

/** 面包屑分段纯函数：'' → []；'src/a' → ['src','a']。 */
export function splitPath(path: string): string[] {
  return path.split('/').filter(Boolean);
}

function joinPath(parts: string[]): string {
  return parts.join('/');
}

export function FileExplorerPanel({ sessionId, cwd, initialPath }: { sessionId: string; cwd: string; initialPath?: string }) {
  const previewPath = initialPath ? filePreviewPath(initialPath, cwd) : undefined;
  const workspacePath = initialPath ? workspacePreviewPath(initialPath, cwd) : undefined;
  const [path, setPath] = useState(workspacePath ? splitPath(workspacePath).slice(0, -1).join('/') : '');
  const [selected, setSelected] = useState<string | undefined>(previewPath);
  const selectedIsImage = /\.(png|jpe?g|gif|webp|bmp|svg|avif)$/i.test(selected ?? '');
  const selectedIsPdf = /\.pdf$/i.test(selected ?? '');
  const segments = useMemo(() => splitPath(path), [path]);
  const listing = useQuery({
    queryKey: ['fs-list', sessionId, path],
    queryFn: () => api.fsList(sessionId, path),
    refetchOnWindowFocus: false,
    staleTime: 10_000
  });
  const file = useQuery({
    queryKey: ['fs-read', sessionId, selected],
    queryFn: () => api.fsReadText(sessionId, selected!),
    enabled: Boolean(selected) && !selectedIsImage && !selectedIsPdf,
    retry: false
  });
  const selectedName = selected ? splitPath(selected).at(-1) : undefined;
  const selectedIsMarkdown = /\.(md|markdown)$/i.test(selected ?? '');

  return <div className="flex h-full min-h-0 flex-col bg-white">
    <div className="flex h-9 shrink-0 items-center gap-1.5 border-b border-zinc-200 px-3 text-[11px]">
      <FolderOpen size={13} className="text-zinc-500"/>
      <span className="font-medium text-zinc-700">文件</span>
      {/* 面包屑 */}
      <div className="ml-1 flex min-w-0 items-center gap-0.5 text-[11px] text-zinc-500">
        <button type="button" onClick={() => setPath('')} className="rounded px-1 py-0.5 font-mono hover:bg-zinc-100">~</button>
        {segments.map((segment, index) => <span key={index} className="flex min-w-0 items-center gap-0.5"><ChevronRight size={10} className="shrink-0 text-zinc-300"/><button type="button" onClick={() => setPath(joinPath(segments.slice(0, index + 1)))} title={segment} className="max-w-32 truncate rounded px-1 py-0.5 font-mono hover:bg-zinc-100">{segment}</button></span>)}
      </div>
      <span className="ml-auto flex items-center gap-0.5">
        <button type="button" onClick={() => void listing.refetch()} aria-label="刷新文件列表" className="grid h-7 w-7 place-items-center rounded-md text-zinc-400 transition-colors hover:bg-zinc-100 hover:text-zinc-800"><RefreshCw size={13}/></button>
      </span>
    </div>
    <div className="grid min-h-0 flex-1 grid-cols-[minmax(160px,220px)_1fr]">
      <div className="min-h-0 overflow-y-auto border-r border-zinc-200 bg-zinc-50/50 py-1">
        {listing.isLoading && <div className="flex items-center gap-2 px-3 py-2 text-[11px] text-zinc-400"><LoaderCircle size={12} className="animate-spin"/>读取中…</div>}
        {listing.error && <div className="px-3 py-2 text-[11px] leading-4 text-red-600">{listing.error.message}</div>}
        {listing.data && !listing.data.entries.length && <div className="px-3 py-2 text-[11px] text-zinc-400">空目录</div>}
        {listing.data?.entries.map(entry => <FileRow key={entry.name} entry={entry} active={selected === joinPath([...segments, entry.name])} onOpen={() => {
          const next = joinPath([...segments, entry.name]);
          if (entry.type === 'dir') setPath(next);
          else setSelected(next);
        }}/>)}
      </div>
      <div className="min-h-0 overflow-auto bg-white">
        {initialPath && !previewPath ? <div className="p-3 text-[11px] leading-5 text-red-600">文件不在当前会话工作区内，无法预览：{initialPath}</div>
          : !selected ? <div className="grid h-full place-items-center text-[11px] text-zinc-400">选择左侧文件预览（文本 ≤1MB / 图片、PDF ≤20MB）</div>
          : selectedIsImage ? <div className="flex h-full flex-col items-center gap-2 overflow-auto p-3"><img src={api.fsReadUrl(sessionId, selected)} alt={selectedName} className="max-h-full max-w-full rounded-md border border-zinc-200 object-contain"/><div className="font-mono text-[10px] text-zinc-400">{selectedName}</div></div>
          : selectedIsPdf ? <iframe src={api.fsReadUrl(sessionId, selected)} title={selectedName ?? 'PDF 预览'} className="h-full w-full border-0"/>
          : file.isLoading ? <div className="flex items-center gap-2 p-3 text-[11px] text-zinc-400"><LoaderCircle size={12} className="animate-spin"/>读取中…</div>
          : file.error ? <div className="p-3 text-[11px] leading-5 text-red-600">{file.error.message}</div>
          : file.data && selectedIsMarkdown ? <><div className="truncate border-b border-zinc-100 px-4 py-2 font-mono text-[10px] text-zinc-500" title={selected}>{selected}</div><article className="markdown max-w-[78ch] p-4 text-[13px] leading-6 text-zinc-800"><MarkdownContent sessionId={sessionId}>{file.data.content}</MarkdownContent></article></>
          : file.data ? <pre className="m-0 whitespace-pre-wrap break-words p-3 font-mono text-[11px] leading-5 text-zinc-700">{file.data.content}</pre> : null}
      </div>
    </div>
  </div>;
}

function FileRow({ entry, active, onOpen }: { entry: FsListEntry; active: boolean; onOpen(): void }) {
  return <button type="button" onClick={onOpen} title={entry.name} className={`flex w-full items-center gap-2 px-3 py-1.5 text-left text-[12px] transition-colors ${active ? 'bg-zinc-200/70 text-zinc-900' : 'text-zinc-700 hover:bg-zinc-100'}`}>
    {entry.type === 'dir' ? <FolderIcon size={13} className="shrink-0 text-zinc-400"/> : <FileIcon size={13} className="shrink-0 text-zinc-400"/>}
    <span className="min-w-0 flex-1 truncate">{entry.name}</span>
    {entry.type === 'file' && <span className="shrink-0 text-[10px] tabular-nums text-zinc-400">{formatSize(entry.size)}</span>}
  </button>;
}
