import { Check, Copy } from 'lucide-react';
import { useLang } from '../lib/i18n';
import { useCopy } from './ui';

type Line = { code: string; comment: string };

/** 「空白 + # + 空白」之后算注释；URL 里的 README.md#xxx 不受影响。 */
function parse(line: string): Line {
  if (/^\s*#\s/.test(line)) return { code: '', comment: line.trim() };
  const match = /\s+#\s/.exec(line);
  return match ? { code: line.slice(0, match.index), comment: line.slice(match.index).trim() } : { code: line.trimEnd(), comment: '' };
}

/**
 * 终端代码块：两套主题下都是深色终端。
 * 宽屏用两列网格，注释自动对齐到同一列（不依赖手工补空格，中英文混排也不会错位），
 * 没有注释的行横跨两列，不会把注释列推远；手机上注释挪到命令上一行，少横向滚动。复制时去掉注释。
 */
export function CodeBlock({ lines, prompt = true, title, className = '' }: { lines: string[]; prompt?: boolean; title?: string; className?: string }) {
  const { t } = useLang();
  const [copied, copy] = useCopy();
  const parsed = lines.map(parse);
  const text = parsed.filter(item => item.code).map(item => item.code).join('\n');
  const command = (item: Line) => (
    <>
      {prompt && item.code && <span className="select-none text-[#f2a24a]">$ </span>}
      <span className="text-[#ececec]">{item.code || ' '}</span>
    </>
  );
  return (
    <div className={`overflow-hidden rounded-2xl bg-[#141414] font-dock shadow-[0_20px_50px_-24px_rgb(0_0_0/.55)] ring-1 ring-black/10 dark:ring-white/10 ${className}`}>
      <div className="flex h-10 items-center gap-1.5 border-b border-[#ffffff]/[.08] pl-3.5 pr-1.5">
        <span className="h-2.5 w-2.5 rounded-full bg-[#ff5f57]" /><span className="h-2.5 w-2.5 rounded-full bg-[#febc2e]" /><span className="h-2.5 w-2.5 rounded-full bg-[#28c840]" />
        {title && <span className="ml-2 truncate text-[11.5px] text-[#8a8a8a]">{title}</span>}
        <button
          type="button"
          onClick={() => copy(text)}
          aria-label={copied ? t.common.copied : t.common.copy}
          className={`ml-auto flex h-8 items-center gap-1.5 rounded-lg px-2.5 text-[11.5px] transition-colors ${copied ? 'text-[#98c379]' : 'text-[#9b9b9b] hover:bg-[#ffffff]/[.08] hover:text-[#ffffff]'}`}
        >
          {copied ? <Check size={13} strokeWidth={2.5} /> : <Copy size={13} />}
          {copied ? t.common.copied : t.common.copy}
        </button>
      </div>
      <pre className="no-scrollbar overflow-x-auto px-4 py-3.5 text-[12.5px] leading-[1.9] sm:text-[13px]">
        <code className="grid w-max min-w-full grid-cols-1 gap-x-6 sm:grid-cols-[max-content_1fr]">
          {parsed.map((item, index) =>
            item.code && item.comment ? (
              <span key={index} className="flex flex-col max-sm:mt-1 max-sm:first:mt-0 sm:contents">
                <span className="whitespace-pre">{command(item)}</span>
                <span className="whitespace-pre text-[#858585] max-sm:order-first">{item.comment}</span>
              </span>
            ) : (
              <span key={index} className={`whitespace-pre sm:col-span-2 ${item.comment ? 'text-[#858585]' : ''}`}>{item.comment || command(item)}</span>
            )
          )}
        </code>
      </pre>
    </div>
  );
}
