import { lazy, memo, Suspense, useMemo, useState, type ReactNode } from 'react';
import { useThrottle, useTimeout } from 'ahooks';
import ReactMarkdown, { defaultUrlTransform, type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkBreaks from 'remark-breaks';
import { rehypeTextUnits } from './rehype-text-units';
import { Check, Copy, FileText, ImageOff } from 'lucide-react';
import { Highlight, Prism, themes } from 'prism-react-renderer';
import { formatLineRange, isImageFilePath, localFileLink, parseFileLink } from './file-preview-link';
import { useDockStore } from './store';
import { useResolvedTheme } from './theme';

// 图片放大预览只在点开图片时才需要，动态加载以免把 lightbox 及其样式计入首屏。
const ImageLightbox = lazy(() => import('./ImageLightbox'));

export const MAX_AUTO_IMAGE_THUMBNAILS = 4;

export interface LinkedImageItem {
  src: string;
  alt: string;
  filePath: string;
}

// sessionId 为必填：缺失时 .agentdock/uploads 下的图片会被渲染成裸的绝对文件系统路径
// （图片必然损坏，且把宿主机 home 目录写进 DOM）。声明为可选会让漏传的调用点通不过 tsc。
// 确实没有会话上下文时显式传 undefined，表示「已知无 session」而非忘记传。
export function resolveImageSrc(src: string, sessionId: string | undefined): string {
  if (!src) return src;
  if (src.startsWith('http://') || src.startsWith('https://') || src.startsWith('data:') || src.startsWith('blob:') || src.startsWith('/api/')) {
    return src;
  }
  if (!sessionId) return src;
  const filePath = localFileLink(src);
  if (!filePath || !isImageFilePath(filePath)) return src;
  const uploadMatch = /(?:^|[/\\])\.agentdock[/\\]uploads[/\\]([^/\\]+)[/\\]([^/\\]+)$/.exec(filePath);
  if (uploadMatch) {
    // 跨会话引用（例如侧边会话引用主会话上传的截图）时，必须使用路径里实际的 uploadSessionId，
    // 否则请求落到当前 sessionId 的上传目录下会 404，导致缩略图裂开。
    const [, uploadSessionId, filename] = uploadMatch;
    return `/api/sessions/${encodeURIComponent(uploadSessionId!)}/uploads/${encodeURIComponent(filename!)}`;
  }
  return `/api/sessions/${sessionId}/fs/read?path=${encodeURIComponent(filePath)}`;
}

const trailingPunctuationPattern = /[.,;:!?)\]}>。，；：！？）】》]+$/;
const bareFileUrlPattern = /file:\/\/\/[^\s<>()[\]"'`]+/gi;

function trimBareFileUrl(raw: string): string {
  return raw.replace(trailingPunctuationPattern, '');
}

/**
 * 轻量 remark 插件：把正文里的裸 `file:///...` 链接自动转为 link 节点，
 * 跳过代码块、行内代码与已有链接，交给 ReactMarkdown 的 `a` 渲染为可点击预览芯片。
 */
function remarkFileAutolink() {
  return (tree: any) => {
    const skipTypes = new Set(['code', 'inlineCode', 'link', 'linkReference', 'definition', 'html']);
    const visit = (node: any) => {
      if (!node || !Array.isArray(node.children) || skipTypes.has(node.type)) return;
      const nextChildren: any[] = [];
      let changed = false;
      for (const child of node.children) {
        if (child?.type === 'text' && typeof child.value === 'string' && /file:\/\/\//i.test(child.value)) {
          const text: string = child.value;
          bareFileUrlPattern.lastIndex = 0;
          let lastIndex = 0;
          let matchedAny = false;
          for (const match of text.matchAll(bareFileUrlPattern)) {
            const start = match.index ?? 0;
            const raw = match[0];
            const url = trimBareFileUrl(raw);
            const parsed = parseFileLink(url);
            if (!parsed) continue;
            matchedAny = true;
            if (start > lastIndex) nextChildren.push({ type: 'text', value: text.slice(lastIndex, start) });
            const base = parsed.path.split('/').at(-1) || parsed.path;
            const lineBadge = formatLineRange(parsed.startLine, parsed.endLine);
            nextChildren.push({
              type: 'link',
              url,
              children: [{ type: 'text', value: lineBadge ? `${base}#${lineBadge}` : base }]
            });
            lastIndex = start + url.length;
          }
          if (matchedAny) {
            changed = true;
            if (lastIndex < text.length) nextChildren.push({ type: 'text', value: text.slice(lastIndex) });
            continue;
          }
        }
        visit(child);
        nextChildren.push(child);
      }
      if (changed) node.children = nextChildren;
    };
    visit(tree);
  };
}

const leadingSlashCommandPattern = /^(\s*)(\/[A-Za-z0-9][A-Za-z0-9_:-]*)/;

/**
 * 轻量 remark 插件：仅把用户消息最开头的单个 `/命令` token（如 `/plan`、`/lark-doc`、`/sc:analyze`）
 * 标记为命令 chip。跳过用户手写反引号包裹的行内代码、多段绝对路径（如 `/Users/...`）以及正文中间出现的
 * 任意 `/...` 片段，避免把路径或路由误染成不折行的蓝色命令 chip。
 */
function remarkLeadingSlashCommand() {
  return (tree: any) => {
    if (!tree || !Array.isArray(tree.children) || tree.children.length === 0) return;
    const firstBlock = tree.children[0];
    if (!firstBlock || firstBlock.type !== 'paragraph' || !Array.isArray(firstBlock.children) || firstBlock.children.length === 0) return;
    const firstChild = firstBlock.children[0];
    if (!firstChild || firstChild.type !== 'text' || typeof firstChild.value !== 'string') return;

    const match = leadingSlashCommandPattern.exec(firstChild.value);
    if (!match) return;
    const [, leadingSpace = '', command = ''] = match;
    const rest = firstChild.value.slice(match[0].length);
    // 紧跟在命令后必须是空白，或该文本节点到此结束且后续为空 / 软换行（remarkBreaks 生成的 break）。
    // 这样 `/Users/codeax/...`（后接 `/`）、`/README.md`（后接 `.`）、`/plan**x**`（后接 strong）都不会误判。
    if (rest.length > 0) {
      if (!/^\s/.test(rest)) return;
    } else if (firstBlock.children.length > 1 && firstBlock.children[1]?.type !== 'break') {
      return;
    }

    const replacement: any[] = [];
    if (leadingSpace) replacement.push({ type: 'text', value: leadingSpace });
    replacement.push({
      type: 'inlineCode',
      value: command,
      data: { hProperties: { className: ['ui-slash-command'] } }
    });
    if (rest) replacement.push({ type: 'text', value: rest });
    firstBlock.children.splice(0, 1, ...replacement);
  };
}

const baseRemarkPlugins = [remarkGfm, remarkBreaks, remarkFileAutolink];
const userCommandRemarkPlugins = [remarkGfm, remarkBreaks, remarkFileAutolink, remarkLeadingSlashCommand];

/**
 * 提取消息中用 `[label](file:///...png|svg)` 或裸 `file:///...png|svg` 引用的本地图片/SVG，
 * 跳过代码块、行内代码以及已通过 `![](...)` 内联展示过的图片，用于消息下方自动附带紧凑缩略图。
 */
export function extractLinkedImages(markdown: string, sessionId: string | undefined): LinkedImageItem[] {
  if (!sessionId || !markdown) return [];
  // 去掉围栏代码块与行内代码，避免示例代码里的路径触发误抓。
  const stripped = markdown
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/~~~[\s\S]*?~~~/g, ' ')
    .replace(/`[^`\n]+`/g, ' ');

  const inlineSrcs = new Set<string>();
  const inlineImagePattern = /!\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;
  for (const match of stripped.matchAll(inlineImagePattern)) {
    const rawUrl = match[1]?.trim();
    if (!rawUrl) continue;
    const resolved = resolveImageSrc(rawUrl, sessionId);
    if (resolved) inlineSrcs.add(resolved);
  }

  const results: LinkedImageItem[] = [];
  const seen = new Set<string>();
  const addCandidate = (rawUrl: string, label?: string) => {
    const parsed = parseFileLink(rawUrl);
    if (!parsed || !isImageFilePath(parsed.path)) return;
    const src = resolveImageSrc(rawUrl, sessionId);
    if (!src || inlineSrcs.has(src) || seen.has(src)) return;
    seen.add(src);
    const fallbackName = parsed.path.split('/').at(-1) || parsed.path;
    results.push({ src, alt: label?.trim() || fallbackName, filePath: parsed.path });
  };

  // 1) Markdown 链接：[label](url)（排除 ![alt](url)）
  const mdLinkPattern = /(?<!!)\[([^\]]+)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;
  for (const match of stripped.matchAll(mdLinkPattern)) {
    addCandidate(match[2]!, match[1]);
  }

  // 2) 裸 file:///... 图片链接
  const withoutMdLinks = stripped.replace(mdLinkPattern, ' ').replace(inlineImagePattern, ' ');
  for (const match of withoutMdLinks.matchAll(bareFileUrlPattern)) {
    const url = trimBareFileUrl(match[0]);
    addCandidate(url);
  }

  return results;
}

const languageAliases: Record<string, string> = {
  csharp: 'csharp', cs: 'csharp', html: 'markup', js: 'javascript', jsx: 'jsx',
  md: 'markdown', py: 'python', rb: 'ruby', rs: 'rust', sh: 'bash', shell: 'bash',
  ts: 'typescript', tsx: 'tsx', xml: 'markup', yml: 'yaml', zsh: 'bash'
};

export function resolveCodeLanguage(className?: string) {
  const requested = /(?:^|\s)language-([\w-]+)/.exec(className ?? '')?.[1]?.toLowerCase() ?? '';
  const normalized = languageAliases[requested] ?? requested;
  return {
    language: normalized && Prism.languages[normalized] ? normalized : 'plain',
    label: requested || 'text'
  };
}

export function isBlockCode(className: string | undefined, children: ReactNode) {
  return Boolean(className?.includes('language-') || String(children).includes('\n'));
}

const CodeBlock = memo(function CodeBlock({ code, className }: { code: string; className?: string }) {
  const { language, label } = resolveCodeLanguage(className);
  const dark = useResolvedTheme() === 'dark';
  const [copied, setCopied] = useState(false);
  // 「已复制」状态 1.5s 后自动回落。delay 传 undefined 即暂停，重复点击会重新计时，
  // 卸载清理由 useTimeout 自己收口，不用手持 timer 句柄。
  useTimeout(() => setCopied(false), copied ? 1_500 : undefined);
  const copy = async () => {
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(code);
      } else {
        const textarea = document.createElement('textarea');
        textarea.value = code;
        textarea.style.position = 'fixed';
        textarea.style.opacity = '0';
        document.body.appendChild(textarea);
        textarea.select();
        document.execCommand('copy');
        document.body.removeChild(textarea);
      }
      setCopied(true);
    } catch { setCopied(false); }
  };
  return <div className="code-renderer group/code my-4 overflow-hidden rounded-[10px] border border-zinc-200 bg-[rgb(var(--code-bg))] [contain:layout_paint]">
    <div className="flex h-8 items-center px-3">
      <span className="font-mono text-[12px] text-zinc-500">{label}</span>
      <button type="button" onClick={() => void copy()} className={`ui-press ml-auto flex h-6 items-center gap-1.5 rounded-md px-2 text-[12px] font-medium hover:bg-zinc-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-zinc-400/50 ${copied ? 'text-emerald-600' : 'text-zinc-500 hover:text-zinc-900'}`} aria-label={copied ? '代码已复制' : '复制代码'}>
        {copied ? <Check key="check" size={12} className="ui-icon-pop"/> : <Copy key="copy" size={12}/>}<span>{copied ? '已复制' : '复制'}</span>
      </button>
    </div>
    <Highlight theme={dark ? themes.vsDark : themes.vsLight} code={code} language={language}>
      {({ className: prismClassName, style, tokens, getLineProps, getTokenProps }) => <pre className={`${prismClassName} code-renderer-scroll m-0 overflow-x-auto px-4 pb-3.5 pt-1 text-[13px] leading-6`} style={{ ...style, backgroundColor: 'transparent' }}><code>{tokens.map((line, lineIndex) => <span key={lineIndex} {...getLineProps({ line })} className="block min-h-6">{line.map((token, tokenIndex) => <span key={tokenIndex} {...getTokenProps({ token })}/>)}</span>)}</code></pre>}
    </Highlight>
  </div>;
});

function LightboxImage({ src, alt }: { src: string; alt?: string }) {
  // 只有点开过一次才挂载 lightbox：未交互的图片不触发动态 import。
  const [opened, setOpened] = useState(false);
  const [open, setOpen] = useState(false);
  return (
    <>
      <img
        src={src}
        alt={alt ?? ''}
        loading="lazy"
        onClick={() => { setOpened(true); setOpen(true); }}
        className="my-2 max-h-40 w-auto max-w-full cursor-zoom-in rounded-md border border-zinc-200/80 bg-zinc-50/50 object-contain transition-shadow hover:shadow-md"
      />
      {opened && (
        // fallback 为 null：chunk 通常瞬时加载完，插一个 loading 遮罩反而闪一下。
        <Suspense fallback={null}>
          <ImageLightbox src={src} alt={alt} open={open} onClose={() => setOpen(false)} />
        </Suspense>
      )}
    </>
  );
}

function LinkedImageThumbnails({ images }: { images: LinkedImageItem[] }) {
  const [expanded, setExpanded] = useState(false);
  const [opened, setOpened] = useState(false);
  const [activeIndex, setActiveIndex] = useState<number | null>(null);
  const [failedSrcs, setFailedSrcs] = useState<Record<string, true>>({});
  const visible = expanded ? images : images.slice(0, MAX_AUTO_IMAGE_THUMBNAILS);
  const hiddenCount = images.length - visible.length;
  const slides = useMemo(() => images.map(item => ({ src: item.src, alt: item.alt })), [images]);

  return (
    <div className="mt-2.5 flex flex-wrap items-stretch gap-2" data-testid="linked-image-thumbnails">
      {visible.map((item, idx) => {
        const failed = Boolean(failedSrcs[item.src]);
        return (
          <button
            key={item.src}
            type="button"
            disabled={failed}
            onClick={() => { setOpened(true); setActiveIndex(idx); }}
            title={item.filePath}
            className={`group flex w-[132px] flex-col overflow-hidden rounded-lg border border-zinc-200 bg-zinc-50/70 text-left transition-all ${failed ? 'cursor-default opacity-80' : 'hover:border-zinc-300 hover:shadow-sm'}`}
          >
            <div className="flex h-[78px] w-full items-center justify-center overflow-hidden bg-white/80 p-1">
              {failed ? (
                <div className="flex flex-col items-center justify-center gap-1 text-zinc-400">
                  <ImageOff size={18} className="text-zinc-300" />
                  <span className="text-[11px]">图片无法加载</span>
                </div>
              ) : (
                <img
                  src={item.src}
                  alt={item.alt}
                  loading="lazy"
                  onError={() => setFailedSrcs(prev => prev[item.src] ? prev : { ...prev, [item.src]: true })}
                  className="max-h-full max-w-full cursor-zoom-in object-contain transition-transform duration-150 group-hover:scale-[1.03]"
                />
              )}
            </div>
            <span className="truncate border-t border-zinc-100 px-2 py-1 font-mono text-[11px] text-zinc-500 group-hover:text-zinc-800">
              {item.alt}
            </span>
          </button>
        );
      })}
      {hiddenCount > 0 && (
        <button
          type="button"
          onClick={() => setExpanded(true)}
          className="flex h-[104px] min-w-[88px] flex-col items-center justify-center rounded-lg border border-dashed border-zinc-300 bg-zinc-50/60 px-3 text-[12px] font-medium text-zinc-600 transition-colors hover:border-zinc-400 hover:bg-zinc-100 hover:text-zinc-900"
        >
          <span>+{hiddenCount} 张</span>
          <span className="mt-0.5 text-[11px] font-normal text-zinc-400">展开全部</span>
        </button>
      )}
      {expanded && images.length > MAX_AUTO_IMAGE_THUMBNAILS && (
        <button
          type="button"
          onClick={() => setExpanded(false)}
          className="self-center rounded-md px-2 py-1 text-[12px] text-zinc-500 hover:bg-zinc-100 hover:text-zinc-800"
        >
          收起
        </button>
      )}
      {opened && activeIndex !== null && (
        <Suspense fallback={null}>
          <ImageLightbox slides={slides} index={activeIndex} open={activeIndex !== null} onClose={() => setActiveIndex(null)} />
        </Suspense>
      )}
    </div>
  );
}

const markdownComponents: Components = {
  // 跳链默认新开标签页：Agent 输出的链接若在同页打开会直接踢走当前会话时间线，很迷。
  // 统一 target="_blank" + rel，外部站内链接一律新开。
  a({ href, children }) {
    return <a href={href} target="_blank" rel="noopener noreferrer" className="font-medium text-link underline decoration-link/40 underline-offset-2 hover:decoration-link">{children}</a>;
  },
  code({ className, children }) {
    if (isBlockCode(className, children)) return <CodeBlock className={className} code={String(children).replace(/\n$/, '')}/>;
    if (className?.split(/\s+/).includes('ui-slash-command')) return <code className="ui-slash-command">{children}</code>;
    return <code className="ui-inline-code rounded bg-zinc-100 px-[.32rem] py-[.12rem] font-mono text-[.9em] text-zinc-800">{children}</code>;
  },
  pre({ children }) { return <>{children}</>; },
  // 横向滚动放在外层 div 上，不能直接让 table display:block（iOS WebKit 会撑破容器导致整页横滑，见 index.css）。
  table({ children }) {
    return <div className="markdown-table-scroll"><table>{children}</table></div>;
  }
  // img 由 MarkdownContent 内部覆盖：它需要 sessionId 才能把本地与 uploads 路径改写成可访问 URL。
};

export const MarkdownContent = memo(function MarkdownContent({ children, sessionId, throttleMs, animateUnits = false, highlightSlashCommands = false, showLinkedImageThumbnails = true }: { children: string; sessionId: string | undefined; throttleMs?: number; /** 流式输出时给文字挂词级模糊入场；历史消息保持 false。 */ animateUnits?: boolean; /** 用户消息：把开头的 /命令 渲染成彩色命令 chip。 */ highlightSlashCommands?: boolean; /** 是否在消息下方自动附带图片/SVG 链接的紧凑缩略图。 */ showLinkedImageThumbnails?: boolean }) {
  // 流式文本（思考过程 / 进行中的回复）每秒可达 40+ 次 token 更新，ReactMarkdown
  // 每次都对整段文本重新 parse、Prism 重新高亮全部代码块，主线程长任务会把
  // spinner 和整页拖成鬼畜闪。节流后 parse 频率降到个位数/秒；trailing 触发
  // 保证流结束后完整内容一定会刷出。
  const shown = useThrottle(children, { wait: throttleMs ?? 0 });
  const markdown = throttleMs ? shown : children;
  const linkedImages = useMemo(
    () => (showLinkedImageThumbnails ? extractLinkedImages(markdown, sessionId) : []),
    [markdown, sessionId, showLinkedImageThumbnails]
  );

  const components: Components = {
    ...markdownComponents,
    a({ href, children }) {
      const parsed = href ? parseFileLink(href) : undefined;
      if (parsed && sessionId) {
        return <button
          type="button"
          title={parsed.path}
          onClick={() => {
            useDockStore.getState().openFilePreview({
              sessionId,
              filePath: parsed.path,
              startLine: parsed.startLine,
              endLine: parsed.endLine
            });
          }}
          className="inline-flex max-w-full items-baseline gap-1 rounded px-1 py-0.5 text-left align-baseline font-medium text-link underline decoration-link/40 underline-offset-2 transition-colors hover:bg-blue-50/70 hover:decoration-link"
        ><FileText size={12} className="relative top-[1px] shrink-0 opacity-70"/><span className="min-w-0 [overflow-wrap:anywhere]">{children}</span></button>;
      }
      return <a href={href} target="_blank" rel="noopener noreferrer" className="font-medium text-link underline decoration-link/40 underline-offset-2 hover:decoration-link">{children}</a>;
    },
    img({ src, alt }) {
      const resolved = resolveImageSrc(src ?? '', sessionId);
      // src 为空时不能渲染 <img src="">：浏览器会把它解析成当前页面地址并重新下载整个页面
      // （React 也会就此告警）。Agent 输出里出现 ![alt]() 这类空图片链接是现实情况。
      if (!resolved) return null;
      return <LightboxImage src={resolved} alt={alt ?? ''} />;
    }
  };
  // remark-breaks：单个换行按用户输入保留（输入框已改成 Enter 换行）。否则多行提示词会被
  // CommonMark 折叠成一整段，长命令 / 路径全挤在一起，既难读也难看。
  return <>
    <ReactMarkdown remarkPlugins={highlightSlashCommands ? userCommandRemarkPlugins : baseRemarkPlugins} rehypePlugins={animateUnits ? [rehypeTextUnits] : []} urlTransform={url => /^file:/i.test(url) ? url : defaultUrlTransform(url)} components={components}>{markdown}</ReactMarkdown>
    {linkedImages.length > 0 && <LinkedImageThumbnails images={linkedImages} />}
  </>;
});
