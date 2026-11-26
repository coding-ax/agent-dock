import { lazy, Suspense, useEffect, useMemo, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  ArrowLeft,
  ArrowUp,
  ChevronRight,
  Code2,
  Download,
  Eye,
  EyeOff,
  File as FileIcon,
  FileAudio,
  FileCode2,
  FileImage,
  FileText,
  FileVideo,
  Folder as FolderIcon,
  PanelLeftClose,
  PanelLeftOpen,
  RefreshCw
} from 'lucide-react';
import { Highlight, Prism, themes } from 'prism-react-renderer';
import { Spinner } from './Loaders';
import { HoverTooltip } from './HoverTooltip';
import { api, type FsDirectoryEntry, type FsListEntry, type FsReadDirectoryResult } from './api';
import {
  buildDirectoryBreadcrumbs,
  filePreviewPath,
  formatLineRange,
  isAudioFilePath,
  isImageFilePath,
  isMarkdownFilePath,
  isSvgFilePath,
  isVideoFilePath,
  workspacePreviewPath
} from './file-preview-link';
import { MarkdownContent } from './MarkdownContent';
import { useResolvedTheme } from './theme';

const ImageLightbox = lazy(() => import('./ImageLightbox'));

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

const extensionLanguageMap: Record<string, string> = {
  '.ts': 'typescript', '.mts': 'typescript', '.cts': 'typescript',
  '.tsx': 'tsx',
  '.js': 'javascript', '.mjs': 'javascript', '.cjs': 'javascript',
  '.jsx': 'jsx',
  '.json': 'json', '.jsonl': 'json',
  '.md': 'markdown', '.markdown': 'markdown',
  '.css': 'css', '.scss': 'scss', '.less': 'less',
  '.html': 'markup', '.htm': 'markup', '.xml': 'markup', '.svg': 'markup', '.vue': 'markup', '.svelte': 'markup',
  '.py': 'python',
  '.go': 'go',
  '.rs': 'rust',
  '.rb': 'ruby',
  '.java': 'java',
  '.kt': 'kotlin',
  '.swift': 'swift',
  '.c': 'c', '.h': 'c',
  '.cc': 'cpp', '.cpp': 'cpp', '.hpp': 'cpp',
  '.sh': 'bash', '.bash': 'bash', '.zsh': 'bash',
  '.yaml': 'yaml', '.yml': 'yaml',
  '.sql': 'sql',
  '.graphql': 'graphql', '.gql': 'graphql',
  '.diff': 'diff', '.patch': 'diff'
};

export function languageForFilename(name: string | undefined): string {
  if (!name) return 'plain';
  const lower = name.toLowerCase();
  const dot = lower.lastIndexOf('.');
  const ext = dot >= 0 ? lower.slice(dot) : '';
  const mapped = extensionLanguageMap[ext];
  return mapped && Prism.languages[mapped] ? mapped : 'plain';
}

function CodeFileViewer({
  content,
  filename,
  targetLine,
  targetEndLine,
  scrollNonce
}: {
  content: string;
  filename?: string;
  targetLine?: number;
  targetEndLine?: number;
  scrollNonce?: number;
}) {
  const dark = useResolvedTheme() === 'dark';
  const language = languageForFilename(filename);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!targetLine || !containerRef.current) return;
    const row = containerRef.current.querySelector<HTMLElement>(`[data-line="${targetLine}"]`);
    if (row && typeof row.scrollIntoView === 'function') {
      row.scrollIntoView({ block: 'center', behavior: 'smooth' });
    }
  }, [content, targetLine, targetEndLine, scrollNonce]);

  const highlightStart = targetLine && targetLine >= 1 ? targetLine : undefined;
  const highlightEnd = highlightStart ? Math.max(highlightStart, targetEndLine ?? highlightStart) : undefined;

  return (
    <div ref={containerRef} className="min-h-full bg-[rgb(var(--code-bg))]" data-testid="code-file-viewer">
      <Highlight theme={dark ? themes.vsDark : themes.vsLight} code={content} language={language}>
        {({ className, style, tokens, getLineProps, getTokenProps }) => (
          <pre
            className={`${className} m-0 min-w-full overflow-x-auto py-2.5 text-[12.5px] leading-[1.6]`}
            style={{ ...style, backgroundColor: 'transparent' }}
          >
            <code className="block min-w-max">
              {tokens.map((line, index) => {
                const lineNum = index + 1;
                const isTarget = Boolean(highlightStart && highlightEnd && lineNum >= highlightStart && lineNum <= highlightEnd);
                const lineProps = getLineProps({ line });
                return (
                  <div
                    key={lineNum}
                    data-line={lineNum}
                    data-highlighted={isTarget ? 'true' : undefined}
                    {...lineProps}
                    className={`flex min-h-[20px] pr-4 ${isTarget ? 'border-l-2 border-amber-400 bg-amber-100/80 dark:bg-amber-500/20' : 'border-l-2 border-transparent hover:bg-zinc-900/[0.03] dark:hover:bg-white/[0.03]'}`}
                  >
                    <span className={`w-11 shrink-0 select-none pr-3 text-right font-mono text-[11px] tabular-nums ${isTarget ? 'font-semibold text-amber-700 dark:text-amber-300' : 'text-zinc-400'}`}>
                      {lineNum}
                    </span>
                    <span className="min-w-0 flex-1 whitespace-pre">
                      {line.map((token, tokenIndex) => (
                        <span key={tokenIndex} {...getTokenProps({ token })} />
                      ))}
                    </span>
                  </div>
                );
              })}
            </code>
          </pre>
        )}
      </Highlight>
    </div>
  );
}

export function FileExplorerPanel({
  sessionId,
  cwd,
  initialPath,
  targetLine,
  targetEndLine,
  previewNonce,
  disabledReason,
  onClose
}: {
  sessionId: string;
  cwd: string;
  initialPath?: string;
  targetLine?: number;
  targetEndLine?: number;
  previewNonce?: number;
  /** 远端会话暂时没有远端文件 API；给出原因而不是列本机同名路径。 */
  disabledReason?: string;
  /** 移动端返回会话回调（通常绑定隐藏副屏）。 */
  onClose?: () => void;
}) {
  const previewPath = initialPath ? filePreviewPath(initialPath, cwd) : undefined;
  const workspacePath = initialPath ? workspacePreviewPath(initialPath, cwd) : undefined;
  const [path, setPath] = useState(workspacePath ? splitPath(workspacePath).slice(0, -1).join('/') : '');
  const [selected, setSelected] = useState<string | undefined>(previewPath);
  const [activeLine, setActiveLine] = useState<number | undefined>(targetLine);
  const [activeEndLine, setActiveEndLine] = useState<number | undefined>(targetEndLine);
  // 默认折叠文件树（带文件目标时）；无目标时展开以便直接挑文件。
  const [treeOpen, setTreeOpen] = useState<boolean>(!previewPath);
  // Markdown 与 SVG 共用的视图模式：默认渲染预览；若 Markdown 链接带行号则切源码以便定位行。
  const [viewMode, setViewMode] = useState<'preview' | 'source'>(
    previewPath && isMarkdownFilePath(previewPath) && targetLine ? 'source' : 'preview'
  );
  const [lightboxOpen, setLightboxOpen] = useState(false);
  const [showHidden, setShowHidden] = useState(false);
  // 从目录预览点进文件时记住来源目录，便于一键返回所在目录。
  const [returnDir, setReturnDir] = useState<string | undefined>(undefined);

  // 复用右栏单个文件预览 Tab：每次点击新文件/行号时同步选中状态并默认收起文件树。
  useEffect(() => {
    if (!initialPath) return;
    const nextPreview = filePreviewPath(initialPath, cwd);
    const nextWorkspace = workspacePreviewPath(initialPath, cwd);
    setSelected(nextPreview);
    if (nextWorkspace) {
      setPath(splitPath(nextWorkspace).slice(0, -1).join('/'));
    }
    setActiveLine(targetLine);
    setActiveEndLine(targetEndLine);
    setViewMode(nextPreview && isMarkdownFilePath(nextPreview) && targetLine ? 'source' : 'preview');
    setTreeOpen(false);
    setLightboxOpen(false);
    setShowHidden(false);
    setReturnDir(undefined);
  }, [initialPath, targetLine, targetEndLine, previewNonce, cwd]);

  const selectedIsSvg = isSvgFilePath(selected);
  const selectedIsImage = isImageFilePath(selected);
  const selectedIsVideo = isVideoFilePath(selected);
  const selectedIsAudio = isAudioFilePath(selected);
  const selectedIsPdf = /\.pdf$/i.test(selected ?? '');
  const selectedIsMarkdown = isMarkdownFilePath(selected);
  const selectedName = selected ? (splitPath(selected).at(-1) ?? (selected === '/' ? '/' : selected)) : undefined;
  const lineBadge = formatLineRange(activeLine, activeEndLine);

  const shouldFetchText = Boolean(selected) && !disabledReason && !selectedIsPdf && !selectedIsVideo && !selectedIsAudio && (
    !selectedIsImage || (selectedIsSvg && viewMode === 'source')
  );

  const segments = useMemo(() => splitPath(path), [path]);
  const listing = useQuery({
    queryKey: ['fs-list', sessionId, path],
    queryFn: () => api.fsList(sessionId, path),
    enabled: !disabledReason && treeOpen,
    refetchOnWindowFocus: false,
    staleTime: 10_000
  });
  const file = useQuery({
    queryKey: ['fs-read', sessionId, selected, selectedIsSvg ? 'text' : 'default', showHidden ? 'hidden' : 'visible'],
    queryFn: () => api.fsReadText(sessionId, selected!, {
      ...(selectedIsSvg ? { format: 'text' as const } : {}),
      ...(showHidden ? { hidden: true } : {})
    }),
    enabled: shouldFetchText,
    retry: false
  });

  const dirData = file.data && file.data.kind === 'directory' ? file.data : undefined;
  const textData = file.data && file.data.kind !== 'directory' ? file.data : undefined;
  const isDirectory = Boolean(dirData);

  const canToggleMode = Boolean(selected && !isDirectory && (selectedIsMarkdown || selectedIsSvg));
  const rawUrl = selected ? api.fsReadUrl(sessionId, selected) : undefined;
  const downloadUrl = selected && !isDirectory ? api.fsDownloadUrl(sessionId, selected) : undefined;

  const openDirectory = (dirPath: string) => {
    setSelected(dirPath);
    setReturnDir(undefined);
    setActiveLine(undefined);
    setActiveEndLine(undefined);
    setViewMode('preview');
    setLightboxOpen(false);
  };

  const openFileFromDirectory = (filePath: string, fromDir: string) => {
    setReturnDir(fromDir);
    setSelected(filePath);
    setActiveLine(undefined);
    setActiveEndLine(undefined);
    setViewMode('preview');
    setLightboxOpen(false);
  };

  return <div className="flex h-full min-h-0 flex-col bg-white">
    <div className="flex h-10 shrink-0 items-center gap-1.5 border-b border-zinc-200 px-2.5 text-[12px]">
      {/* 移动端单栏返回栏：预览态返回会话，文件树态若有已选文件则返回预览 */}
      {onClose && (
        <button
          type="button"
          onClick={() => {
            if (treeOpen && selected) setTreeOpen(false);
            else onClose();
          }}
          className="inline-flex h-7 shrink-0 items-center gap-1 rounded-md px-1.5 text-[12px] font-medium text-zinc-600 transition-colors hover:bg-zinc-100 hover:text-zinc-900 lg:hidden"
        >
          <ArrowLeft size={14} />
          <span>{treeOpen && selected ? '返回预览' : '返回'}</span>
        </button>
      )}
      <HoverTooltip content={treeOpen ? '收起文件树' : '展开文件树'}>
        <button
          type="button"
          disabled={Boolean(disabledReason)}
          onClick={() => setTreeOpen(open => !open)}
          aria-label={treeOpen ? '收起文件树' : '展开文件树'}
          aria-pressed={treeOpen}
          className={`grid h-7 w-7 shrink-0 place-items-center rounded-md transition-colors disabled:opacity-40 ${treeOpen ? 'bg-zinc-100 text-zinc-900' : 'text-zinc-500 hover:bg-zinc-100 hover:text-zinc-900'}`}
        >
          {treeOpen ? <PanelLeftClose size={14} /> : <PanelLeftOpen size={14} />}
        </button>
      </HoverTooltip>

      {/* 文件名或面包屑 */}
      {treeOpen ? (
        <div className="flex min-w-0 flex-1 items-center gap-0.5 overflow-x-auto text-[12px] text-zinc-500">
          <button type="button" onClick={() => setPath('')} className="shrink-0 rounded px-1 py-0.5 font-mono hover:bg-zinc-100">~</button>
          {segments.map((segment, index) => (
            <span key={index} className="flex min-w-0 shrink-0 items-center gap-0.5">
              <ChevronRight size={10} className="shrink-0 text-zinc-300" />
              <button
                type="button"
                onClick={() => setPath(joinPath(segments.slice(0, index + 1)))}
                title={segment}
                className="max-w-28 truncate rounded px-1 py-0.5 font-mono hover:bg-zinc-100"
              >
                {segment}
              </button>
            </span>
          ))}
        </div>
      ) : (
        <div className="flex min-w-0 flex-1 items-center gap-1.5">
          {returnDir && !isDirectory && (
            <button
              type="button"
              onClick={() => openDirectory(returnDir)}
              data-testid="back-to-directory-btn"
              className="inline-flex h-6 shrink-0 items-center gap-1 rounded-md border border-zinc-200 bg-zinc-50 px-1.5 text-[11px] font-medium text-zinc-600 transition-colors hover:bg-zinc-100 hover:text-zinc-900"
            >
              <ArrowLeft size={11} />
              <span>目录</span>
            </button>
          )}
          {isDirectory && <FolderIcon size={13} className="shrink-0 text-amber-500" />}
          <span className="truncate font-mono text-[12px] font-medium text-zinc-700" title={selected ?? '文件预览'}>
            {selectedName ?? '文件预览'}
          </span>
          {lineBadge && (
            <span className="shrink-0 rounded bg-amber-100 px-1.5 py-0.5 font-mono text-[11px] font-medium text-amber-800">
              {lineBadge}
            </span>
          )}
        </div>
      )}

      {/* 右侧操作：Markdown/SVG 渲染与源码切换、下载、刷新 */}
      <div className="ml-auto flex shrink-0 items-center gap-1">
        {canToggleMode && (
          <div className="flex rounded-md border border-zinc-200 bg-zinc-50 p-0.5" role="group" aria-label="视图模式">
            <button
              type="button"
              onClick={() => setViewMode('preview')}
              aria-pressed={viewMode === 'preview'}
              className={`inline-flex h-6 items-center gap-1 rounded px-2 text-[11px] font-medium transition-colors ${viewMode === 'preview' ? 'bg-white text-zinc-900 shadow-sm' : 'text-zinc-500 hover:text-zinc-800'}`}
            >
              <Eye size={11} />
              <span>{selectedIsMarkdown ? '渲染' : '预览'}</span>
            </button>
            <button
              type="button"
              onClick={() => setViewMode('source')}
              aria-pressed={viewMode === 'source'}
              className={`inline-flex h-6 items-center gap-1 rounded px-2 text-[11px] font-medium transition-colors ${viewMode === 'source' ? 'bg-white text-zinc-900 shadow-sm' : 'text-zinc-500 hover:text-zinc-800'}`}
            >
              <Code2 size={11} />
              <span>源码</span>
            </button>
          </div>
        )}
        {downloadUrl && !disabledReason && (
          <HoverTooltip content="下载文件">
            <a
              href={downloadUrl}
              download={selectedName ?? 'file'}
              aria-label="下载文件"
              className="grid h-7 w-7 place-items-center rounded-md text-zinc-500 transition-colors hover:bg-zinc-100 hover:text-zinc-900"
            >
              <Download size={13} />
            </a>
          </HoverTooltip>
        )}
        <HoverTooltip content="刷新">
          <button
            type="button"
            disabled={Boolean(disabledReason)}
            onClick={() => {
              if (treeOpen) void listing.refetch();
              if (shouldFetchText) void file.refetch();
            }}
            aria-label="刷新文件"
            className="grid h-7 w-7 place-items-center rounded-md text-zinc-400 transition-colors hover:bg-zinc-100 hover:text-zinc-800 disabled:opacity-40"
          >
            <RefreshCw size={13} />
          </button>
        </HoverTooltip>
      </div>
    </div>

    {disabledReason ? (
      <div className="m-4 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-[12px] leading-5 text-amber-800">
        {disabledReason}
      </div>
    ) : (
      <div className={`grid min-h-0 flex-1 ${treeOpen ? 'grid-cols-1 md:grid-cols-[minmax(180px,220px)_1fr]' : 'grid-cols-1'}`}>
        {/* 文件树：桌面端在左侧并排；移动端展开时单栏全屏，选文件后自动切回预览 */}
        {treeOpen && (
          <div className="min-h-0 overflow-y-auto border-r border-zinc-200 bg-zinc-50/50 py-1" data-testid="file-tree-pane">
            {listing.isLoading && <div className="flex items-center gap-2 px-3 py-2 text-[12px] text-zinc-400"><Spinner size={12} />读取中…</div>}
            {listing.error && <div className="px-3 py-2 text-[12px] leading-4 text-red-600">{listing.error.message}</div>}
            {listing.data && !listing.data.entries.length && <div className="px-3 py-2 text-[12px] text-zinc-400">空目录</div>}
            {listing.data?.entries.map(entry => (
              <FileRow
                key={entry.name}
                entry={entry}
                active={selected === joinPath([...segments, entry.name])}
                onOpen={() => {
                  const next = joinPath([...segments, entry.name]);
                  if (entry.type === 'dir') {
                    setPath(next);
                  } else {
                    setSelected(next);
                    setReturnDir(undefined);
                    setActiveLine(undefined);
                    setActiveEndLine(undefined);
                    setViewMode('preview');
                    setLightboxOpen(false);
                    // 窄屏下选完文件自动收起文件树，直接进入全屏单栏预览
                    if (typeof window !== 'undefined' && window.innerWidth < 768) {
                      setTreeOpen(false);
                    }
                  }
                }}
              />
            ))}
          </div>
        )}

        {/* 预览区：移动端当 treeOpen=true 时隐藏，避免被 160px 文件树挤压 */}
        <div className={`min-h-0 flex-col overflow-auto bg-white ${treeOpen ? 'hidden md:flex' : 'flex'}`} data-testid="file-preview-pane">
          {initialPath && !previewPath ? (
            <div className="p-4 text-[12px] leading-5 text-red-600">文件不在当前会话可预览范围内：{initialPath}</div>
          ) : !selected ? (
            <div className="flex h-full flex-col items-center justify-center gap-2 p-6 text-center text-[12px] text-zinc-400">
              <span>选择文件预览（文本 ≤1MB / 图片、SVG、PDF ≤20MB / 音视频）</span>
              {!treeOpen && (
                <button
                  type="button"
                  onClick={() => setTreeOpen(true)}
                  className="inline-flex items-center gap-1.5 rounded-md border border-zinc-200 bg-white px-3 py-1.5 text-[12px] font-medium text-zinc-700 hover:bg-zinc-50"
                >
                  <PanelLeftOpen size={13} />
                  <span>展开文件树</span>
                </button>
              )}
            </div>
          ) : selectedIsImage && (!selectedIsSvg || viewMode === 'preview') ? (
            <div className="flex h-full flex-col items-center justify-center gap-3 overflow-auto p-4">
              <div className="flex max-h-[calc(100%-32px)] max-w-full items-center justify-center rounded-lg border border-zinc-200 bg-[repeating-conic-gradient(#f4f4f5_0%_25%,#ffffff_0%_50%)] bg-[length:16px_16px] p-3">
                <img
                  src={rawUrl}
                  alt={selectedName ?? ''}
                  onClick={() => setLightboxOpen(true)}
                  className="max-h-[70vh] max-w-full cursor-zoom-in object-contain"
                />
              </div>
              <div className="font-mono text-[12px] text-zinc-500">{selected}</div>
              {lightboxOpen && rawUrl && (
                <Suspense fallback={null}>
                  <ImageLightbox src={rawUrl} alt={selectedName} open={lightboxOpen} onClose={() => setLightboxOpen(false)} />
                </Suspense>
              )}
            </div>
          ) : selectedIsPdf ? (
            <iframe src={rawUrl} title={selectedName ?? 'PDF 预览'} className="h-full w-full border-0" />
          ) : selectedIsVideo ? (
            <div className="flex h-full flex-col items-center justify-center gap-3 overflow-auto p-4">
              <video
                key={rawUrl}
                src={rawUrl}
                controls
                playsInline
                preload="metadata"
                className="max-h-[75vh] max-w-full rounded-lg bg-black shadow-sm"
              />
              <div className="font-mono text-[12px] text-zinc-500">{selected}</div>
            </div>
          ) : selectedIsAudio ? (
            <div className="flex h-full flex-col items-center justify-center gap-3 overflow-auto p-6">
              <audio key={rawUrl} src={rawUrl} controls preload="metadata" className="w-full max-w-md" />
              <div className="font-mono text-[12px] text-zinc-500">{selected}</div>
            </div>
          ) : file.isLoading ? (
            <div className="flex items-center gap-2 p-4 text-[12px] text-zinc-400"><Spinner size={12} />读取中…</div>
          ) : file.error ? (
            <div className="m-4 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-[12px] leading-5 text-red-700">
              {file.error.message}
            </div>
          ) : dirData ? (
            <DirectoryPreviewView
              dir={dirData}
              cwd={cwd}
              showHidden={showHidden}
              onToggleHidden={() => setShowHidden(value => !value)}
              onOpenDirectory={openDirectory}
              onOpenFile={filePath => openFileFromDirectory(filePath, dirData.path)}
            />
          ) : textData && selectedIsMarkdown && viewMode === 'preview' ? (
            <div className="min-h-0 flex-1 overflow-auto">
              <div className="truncate border-b border-zinc-100 px-4 py-2 font-mono text-[11px] text-zinc-400" title={selected}>{selected}</div>
              <article className="markdown max-w-[78ch] p-4 text-[13px] leading-6 text-zinc-800">
                <MarkdownContent sessionId={sessionId} showLinkedImageThumbnails={false}>{textData.content}</MarkdownContent>
              </article>
            </div>
          ) : textData ? (
            <div className="min-h-0 flex-1 overflow-auto">
              <div className="flex items-center justify-between gap-2 border-b border-zinc-100 px-3 py-1.5 font-mono text-[11px] text-zinc-400">
                <span className="truncate" title={selected}>{selected}</span>
                <span className="shrink-0 tabular-nums">{formatSize(textData.size)}</span>
              </div>
              <CodeFileViewer
                content={textData.content}
                filename={selectedName}
                targetLine={activeLine}
                targetEndLine={activeEndLine}
                scrollNonce={previewNonce}
              />
            </div>
          ) : null}
        </div>
      </div>
    )}
  </div>;
}

function EntryIcon({ entry }: { entry: FsDirectoryEntry }) {
  if (entry.kind === 'directory') {
    return <FolderIcon size={15} className="shrink-0 text-amber-500" />;
  }
  if (isImageFilePath(entry.name)) {
    return <FileImage size={15} className="shrink-0 text-sky-500" />;
  }
  if (isVideoFilePath(entry.name)) {
    return <FileVideo size={15} className="shrink-0 text-blue-500" />;
  }
  if (isAudioFilePath(entry.name)) {
    return <FileAudio size={15} className="shrink-0 text-emerald-500" />;
  }
  if (isMarkdownFilePath(entry.name)) {
    return <FileText size={15} className="shrink-0 text-blue-500" />;
  }
  if (languageForFilename(entry.name) !== 'plain') {
    return <FileCode2 size={15} className="shrink-0 text-zinc-500" />;
  }
  return <FileIcon size={15} className="shrink-0 text-zinc-400" />;
}

function DirectoryPreviewView({
  dir,
  cwd,
  showHidden,
  onToggleHidden,
  onOpenDirectory,
  onOpenFile
}: {
  dir: FsReadDirectoryResult;
  cwd: string;
  showHidden: boolean;
  onToggleHidden(): void;
  onOpenDirectory(path: string): void;
  onOpenFile(path: string): void;
}) {
  const crumbs = useMemo(() => buildDirectoryBreadcrumbs(dir.path, cwd), [dir.path, cwd]);

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="directory-preview-view">
      {/* 路径面包屑 + 返回上级 */}
      <div className="flex shrink-0 items-center gap-1.5 border-b border-zinc-200 bg-zinc-50/70 px-3 py-2">
        {dir.parentPath && (
          <HoverTooltip content="返回上级目录">
            <button
              type="button"
              onClick={() => onOpenDirectory(dir.parentPath!)}
              aria-label="返回上级目录"
              data-testid="directory-parent-btn"
              className="grid h-6 w-6 shrink-0 place-items-center rounded-md border border-zinc-200 bg-white text-zinc-600 transition-colors hover:bg-zinc-100 hover:text-zinc-900"
            >
              <ArrowUp size={13} />
            </button>
          </HoverTooltip>
        )}
        <nav
          aria-label="目录路径"
          data-testid="directory-breadcrumbs"
          className="flex min-w-0 flex-1 items-center gap-0.5 overflow-x-auto whitespace-nowrap text-[12px] text-zinc-500"
        >
          {crumbs.map((crumb, index) => {
            const isLast = index === crumbs.length - 1;
            return (
              <span key={`${crumb.path}:${index}`} className="flex shrink-0 items-center gap-0.5">
                {index > 0 && <ChevronRight size={11} className="shrink-0 text-zinc-300" />}
                {isLast ? (
                  <span className="rounded px-1 py-0.5 font-mono font-medium text-zinc-800" title={dir.absolutePath}>
                    {crumb.label}
                  </span>
                ) : (
                  <button
                    type="button"
                    onClick={() => onOpenDirectory(crumb.path)}
                    title={crumb.path}
                    className="rounded px-1 py-0.5 font-mono transition-colors hover:bg-zinc-200/70 hover:text-zinc-900"
                  >
                    {crumb.label}
                  </button>
                )}
              </span>
            );
          })}
        </nav>
      </div>

      {/* 统计栏 + 隐藏文件开关 */}
      <div className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-b border-zinc-100 px-3 py-1.5 text-[11px] text-zinc-500">
        <span className="tabular-nums">
          {dir.truncated ? `已展示 ${dir.entries.length} / ${dir.totalCount} 项` : `共 ${dir.totalCount} 项`}
        </span>
        {dir.hiddenCount > 0 && (
          <button
            type="button"
            onClick={onToggleHidden}
            data-testid="toggle-hidden-btn"
            className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] text-zinc-500 transition-colors hover:bg-zinc-100 hover:text-zinc-800"
          >
            {showHidden ? <EyeOff size={11} /> : <Eye size={11} />}
            <span>{showHidden ? '隐藏点文件' : `显示隐藏文件 (${dir.hiddenCount})`}</span>
          </button>
        )}
      </div>

      {dir.truncated && (
        <div className="shrink-0 border-b border-amber-200 bg-amber-50 px-3 py-1.5 text-[11px] text-amber-800">
          目录条目较多，仅展示前 {dir.entries.length} 项（共 {dir.totalCount} 项）
        </div>
      )}

      {/* 目录项列表 */}
      <div className="min-h-0 flex-1 overflow-y-auto">
        {dir.entries.length === 0 ? (
          <div className="flex flex-col items-center justify-center gap-2 px-4 py-10 text-center text-[12px] text-zinc-400">
            <span>空目录</span>
            {dir.hiddenCount > 0 && !showHidden && (
              <button
                type="button"
                onClick={onToggleHidden}
                className="rounded-md border border-zinc-200 bg-white px-2.5 py-1 text-[11px] font-medium text-zinc-600 transition-colors hover:bg-zinc-50 hover:text-zinc-900"
              >
                显示 {dir.hiddenCount} 个隐藏项
              </button>
            )}
          </div>
        ) : (
          <div className="divide-y divide-zinc-100 py-0.5" data-testid="directory-entry-list">
            {dir.entries.map(entry => (
              <button
                key={entry.path}
                type="button"
                onClick={() => (entry.kind === 'directory' ? onOpenDirectory(entry.path) : onOpenFile(entry.path))}
                title={entry.name}
                data-testid={`directory-entry-${entry.kind}`}
                className="flex w-full items-center gap-2.5 px-3 py-2 text-left text-[12.5px] transition-colors hover:bg-zinc-100/80"
              >
                <EntryIcon entry={entry} />
                <span className="min-w-0 flex-1 truncate font-mono text-zinc-800">{entry.name}</span>
                {entry.kind === 'file' ? (
                  <span className="shrink-0 font-mono text-[11px] tabular-nums text-zinc-400">
                    {formatSize(entry.size)}
                  </span>
                ) : (
                  <ChevronRight size={13} className="shrink-0 text-zinc-400" />
                )}
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function FileRow({ entry, active, onOpen }: { entry: FsListEntry; active: boolean; onOpen(): void }) {
  return <button type="button" onClick={onOpen} title={entry.name} className={`flex w-full items-center gap-2 px-3 py-1.5 text-left text-[12px] transition-colors ${active ? 'bg-zinc-200/70 text-zinc-900' : 'text-zinc-700 hover:bg-zinc-100'}`}>
    {entry.type === 'dir' ? <FolderIcon size={13} className="shrink-0 text-zinc-400" /> : <FileIcon size={13} className="shrink-0 text-zinc-400" />}
    <span className="min-w-0 flex-1 truncate">{entry.name}</span>
    {entry.type === 'file' && <span className="shrink-0 text-[12px] tabular-nums text-zinc-400">{formatSize(entry.size)}</span>}
  </button>;
}
