import { lazy, memo, Suspense, useState, type ReactNode } from 'react';
import { useThrottle, useTimeout } from 'ahooks';
import ReactMarkdown, { defaultUrlTransform, type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { rehypeTextUnits } from './rehype-text-units';
import { Check, Copy } from 'lucide-react';
import { Highlight, Prism, themes } from 'prism-react-renderer';
import { localFileLink } from './file-preview-link';
import { useDockStore } from './store';

// 图片放大预览只在点开图片时才需要，动态加载以免把 lightbox 及其样式计入首屏。
const ImageLightbox = lazy(() => import('./ImageLightbox'));

const imageExtensions = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.svg']);

// sessionId 为必填：缺失时 .agentdock/uploads 下的图片会被渲染成裸的绝对文件系统路径
// （图片必然损坏，且把宿主机 home 目录写进 DOM）。声明为可选会让漏传的调用点通不过 tsc。
// 确实没有会话上下文时显式传 undefined，表示「已知无 session」而非忘记传。
function resolveImageSrc(src: string, sessionId: string | undefined): string {
  if (!src) return src;
  if (src.startsWith('http://') || src.startsWith('https://') || src.startsWith('data:') || src.startsWith('/api/')) {
    return src;
  }
  const ext = src.split('.').pop()?.toLowerCase();
  if (ext && imageExtensions.has(`.${ext}`) && sessionId && src.includes('.agentdock/uploads')) {
    const filename = src.split(/[/\\]/).pop();
    if (filename) return `/api/sessions/${sessionId}/uploads/${filename}`;
  }
  return src;
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
  return <div className="code-renderer group/code my-4 overflow-hidden rounded-xl border border-zinc-700/70 bg-[#18191d] shadow-[0_8px_24px_rgba(24,24,27,.12)] [contain:layout_paint]">
    <div className="flex h-9 items-center border-b border-white/[.07] bg-white/[.025] px-3 text-[10px] text-zinc-400">
      <span className="font-mono tracking-wide">{label}</span>
      <button type="button" onClick={() => void copy()} className="ml-auto flex h-7 items-center gap-1.5 rounded-md px-2 font-medium text-zinc-400 transition-colors hover:bg-white/[.07] hover:text-zinc-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-zinc-500" aria-label={copied ? '代码已复制' : '复制代码'}>
        {copied ? <Check size={12}/> : <Copy size={12}/>}<span>{copied ? '已复制' : '复制'}</span>
      </button>
    </div>
    <Highlight theme={themes.vsDark} code={code} language={language}>
      {({ className: prismClassName, style, tokens, getLineProps, getTokenProps }) => <pre className={`${prismClassName} code-renderer-scroll m-0 overflow-x-auto px-4 py-3.5 text-[12.5px] leading-6`} style={{ ...style, backgroundColor: 'transparent' }}><code>{tokens.map((line, lineIndex) => <span key={lineIndex} {...getLineProps({ line })} className="block min-h-6">{line.map((token, tokenIndex) => <span key={tokenIndex} {...getTokenProps({ token })}/>)}</span>)}</code></pre>}
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
        className="my-2 max-h-40 w-auto max-w-full cursor-zoom-in object-contain transition-shadow hover:shadow-md"
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

const markdownComponents: Components = {
  // 跳链默认新开标签页：Agent 输出的链接若在同页打开会直接踢走当前会话时间线，很迷。
  // 统一 target="_blank" + rel，外部站内链接一律新开。
  a({ href, children }) {
    return <a href={href} target="_blank" rel="noopener noreferrer" className="font-medium text-[#2563eb] underline decoration-[#2563eb]/40 underline-offset-2 hover:decoration-[#2563eb]">{children}</a>;
  },
  code({ className, children }) {
    if (isBlockCode(className, children)) return <CodeBlock className={className} code={String(children).replace(/\n$/, '')}/>;
    return <code className="rounded-[.3rem] bg-zinc-100 px-[.32rem] py-[.12rem] font-mono text-[.86em] text-zinc-800 ring-1 ring-inset ring-zinc-200">{children}</code>;
  },
  pre({ children }) { return <>{children}</>; },
  // 横向滚动放在外层 div 上，不能直接让 table display:block（iOS WebKit 会撑破容器导致整页横滑，见 index.css）。
  table({ children }) {
    return <div className="markdown-table-scroll"><table>{children}</table></div>;
  }
  // img 由 MarkdownContent 内部覆盖：它需要 sessionId 才能把 uploads 路径改写成可访问 URL。
};

export const MarkdownContent = memo(function MarkdownContent({ children, sessionId, throttleMs, animateUnits = false }: { children: string; sessionId: string | undefined; throttleMs?: number; /** 流式输出时给文字挂词级模糊入场；历史消息保持 false。 */ animateUnits?: boolean }) {
  // 流式文本（思考过程 / 进行中的回复）每秒可达 40+ 次 token 更新，ReactMarkdown
  // 每次都对整段文本重新 parse、Prism 重新高亮全部代码块，主线程长任务会把
  // spinner 和整页拖成鬼畜闪。节流后 parse 频率降到个位数/秒；trailing 触发
  // 保证流结束后完整内容一定会刷出。
  const shown = useThrottle(children, { wait: throttleMs ?? 0 });
  const markdown = throttleMs ? shown : children;
  const components: Components = {
    ...markdownComponents,
    a({ href, children }) {
      const filePath = href ? localFileLink(href) : undefined;
      if (filePath && sessionId) return <button type="button" title={filePath} onClick={() => {
        const dock = useDockStore.getState();
        dock.openTab({ id: `preview:${dock.primarySessionId}:${sessionId}:${filePath}`, kind: 'files', anchorSessionId: sessionId, filePath, title: filePath.split('/').at(-1) || '文件' });
      }} className="font-medium text-[#2563eb] underline decoration-[#2563eb]/40 underline-offset-2 hover:decoration-[#2563eb]">{children}</button>;
      return <a href={href} target="_blank" rel="noopener noreferrer" className="font-medium text-[#2563eb] underline decoration-[#2563eb]/40 underline-offset-2 hover:decoration-[#2563eb]">{children}</a>;
    },
    img({ src, alt }) {
      const resolved = resolveImageSrc(src ?? '', sessionId);
      // src 为空时不能渲染 <img src="">：浏览器会把它解析成当前页面地址并重新下载整个页面
      // （React 也会就此告警）。Agent 输出里出现 ![alt]() 这类空图片链接是现实情况。
      if (!resolved) return null;
      return <LightboxImage src={resolved} alt={alt ?? ''} />;
    }
  };
  return <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={animateUnits ? [rehypeTextUnits] : []} urlTransform={url => /^file:/i.test(url) ? url : defaultUrlTransform(url)} components={components}>{markdown}</ReactMarkdown>;
});
