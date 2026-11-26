import { Fragment, useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { motion, useReducedMotion } from 'motion/react';
import { Check, Copy } from 'lucide-react';
import { AGENTS, type AgentInfo } from '../lib/agents';
import { useLang } from '../lib/i18n';

/* ---------- 小猫立绘 ---------- */

export type Mood = 'idle' | 'happy' | 'curious' | 'sparkle' | 'busy' | 'search' | 'sleepy';

/** 真实的小猫立绘：动图 WebP（4 帧呼吸动画），减少动效时换成静态 PNG。 */
export function Kitten({ mood, size = 120, className = '', alt = '', style }: { mood: Mood; size?: number; className?: string; alt?: string; style?: CSSProperties }) {
  return (
    <picture className={`block select-none ${className}`} style={{ height: size, ...style }}>
      <source srcSet={`/companion/cat-${mood}.png`} media="(prefers-reduced-motion: reduce)" />
      <img
        src={`/companion/cat-${mood}.webp`}
        alt={alt}
        aria-hidden={alt ? undefined : true}
        draggable={false}
        decoding="async"
        className="h-full w-auto max-w-none object-contain"
        style={{ height: size }}
      />
    </picture>
  );
}

/* ---------- Agent 图标 ---------- */

export function AgentIcon({ id, agent, size = 16, className = '' }: { id?: string; agent?: AgentInfo; size?: number; className?: string }) {
  const info = agent ?? (id ? AGENTS[id] : undefined);
  if (!info) return null;
  return (
    <img
      src={info.icon}
      width={size}
      height={size}
      alt=""
      aria-hidden="true"
      draggable={false}
      loading="lazy"
      className={`shrink-0 object-contain ${info.mono ? 'ui-mono-brand' : ''} ${className}`}
      style={{ width: size, height: size }}
    />
  );
}

/* ---------- 品牌图形 ---------- */

export function KittenMark({ className = '', size = 28 }: { className?: string; size?: number }) {
  return <img src="/brand/kitten-mark.svg" width={size} height={size} alt="" aria-hidden="true" className={`pixelated ${className}`} style={{ width: size, height: size }} />;
}

/** 像素字标：浅色用浓缩咖啡色 AGENT，暗色换奶油色，两张图跟着主题显隐，避免切换闪烁。 */
export function Wordmark({ className = '', height = 16 }: { className?: string; height?: number }) {
  const width = Math.round((height * 234) / 32);
  return (
    <span className={`relative inline-block ${className}`} style={{ height, width }} role="img" aria-label="AgentDock">
      <img src="/brand/wordmark-light.svg" alt="" aria-hidden="true" className="pixelated absolute inset-0 h-full w-full object-contain dark:hidden" style={{ objectPosition: 'left center' }} />
      <img src="/brand/wordmark-dark.svg" alt="" aria-hidden="true" className="pixelated absolute inset-0 hidden h-full w-full object-contain dark:block" style={{ objectPosition: 'left center' }} />
    </span>
  );
}

/** 像素爪印：8×8 网格，crispEdges，和 Logo 一个语汇。 */
export function PixelPaw({ className = '', size = 12 }: { className?: string; size?: number }) {
  return (
    <svg viewBox="0 0 8 8" width={size} height={size} shapeRendering="crispEdges" aria-hidden="true" className={className} fill="currentColor">
      <rect x="1" y="0" width="2" height="2" /><rect x="5" y="0" width="2" height="2" />
      <rect x="0" y="3" width="2" height="2" /><rect x="6" y="3" width="2" height="2" />
      <rect x="2" y="4" width="4" height="1" /><rect x="1" y="5" width="6" height="2" /><rect x="2" y="7" width="4" height="1" />
    </svg>
  );
}

export function GithubIcon({ size = 16, className = '' }: { size?: number; className?: string }) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} aria-hidden="true" className={className} fill="currentColor">
      <path d="M12 .5C5.65.5.5 5.65.5 12a11.5 11.5 0 0 0 7.86 10.92c.58.1.79-.25.79-.56v-2c-3.2.7-3.87-1.37-3.87-1.37-.53-1.33-1.28-1.69-1.28-1.69-1.05-.71.08-.7.08-.7 1.16.08 1.77 1.19 1.77 1.19 1.03 1.77 2.71 1.26 3.37.96.1-.75.4-1.26.73-1.55-2.55-.29-5.24-1.28-5.24-5.68 0-1.25.45-2.28 1.19-3.08-.12-.29-.52-1.46.11-3.05 0 0 .97-.31 3.17 1.18a10.9 10.9 0 0 1 5.77 0c2.2-1.49 3.16-1.18 3.16-1.18.63 1.59.24 2.76.12 3.05.74.8 1.18 1.83 1.18 3.08 0 4.41-2.69 5.38-5.25 5.67.41.36.78 1.06.78 2.14v3.17c0 .31.21.67.8.56A11.5 11.5 0 0 0 23.5 12C23.5 5.65 18.35.5 12 .5Z" />
    </svg>
  );
}

/* ---------- 复制 ---------- */

export function useCopy(timeout = 1600): [boolean, (text: string) => void] {
  const [copied, setCopied] = useState(false);
  const timer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(timer.current), []);
  const copy = (text: string) => {
    const done = () => { setCopied(true); window.clearTimeout(timer.current); timer.current = window.setTimeout(() => setCopied(false), timeout); };
    if (navigator.clipboard?.writeText) navigator.clipboard.writeText(text).then(done, () => fallbackCopy(text) && done());
    else if (fallbackCopy(text)) done();
  };
  return [copied, copy];
}

function fallbackCopy(text: string): boolean {
  try {
    const area = document.createElement('textarea');
    area.value = text;
    area.setAttribute('readonly', '');
    area.style.position = 'fixed';
    area.style.opacity = '0';
    document.body.appendChild(area);
    area.select();
    const ok = document.execCommand('copy');
    area.remove();
    return ok;
  } catch { return false; }
}

export function CopyButton({ text, className = '', size = 14 }: { text: string; className?: string; size?: number }) {
  const { t } = useLang();
  const [copied, copy] = useCopy();
  return (
    <button
      type="button"
      onClick={() => copy(text)}
      aria-label={copied ? t.common.copied : t.common.copy}
      title={copied ? t.common.copied : t.common.copy}
      className={`grid h-8 w-8 shrink-0 place-items-center rounded-lg text-zinc-500 transition-colors hover:bg-zinc-900/[.06] hover:text-zinc-900 ${className}`}
    >
      {copied ? <Check size={size} className="text-emerald-500" strokeWidth={2.5} /> : <Copy size={size} />}
    </button>
  );
}

/* ---------- 版式 ---------- */

export function Kicker({ children, className = '' }: { children: ReactNode; className?: string }) {
  return (
    <p className={`inline-flex items-center gap-2 font-dock text-[12px] font-medium uppercase tracking-[.14em] text-brand ${className}`}>
      <PixelPaw size={11} />
      <span>{children}</span>
    </p>
  );
}

export function Reveal({ children, delay = 0, y = 24, className = '', as = 'div', once = true, amount = 0.25 }: {
  children: ReactNode; delay?: number; y?: number; className?: string; as?: 'div' | 'li' | 'section' | 'article'; once?: boolean; amount?: number;
}) {
  const reduce = useReducedMotion();
  const Component = motion[as];
  return (
    <Component
      className={className}
      initial={reduce ? false : { opacity: 0, y, filter: 'blur(6px)' }}
      whileInView={{ opacity: 1, y: 0, filter: 'blur(0px)' }}
      viewport={{ once, amount }}
      transition={{ duration: 0.8, delay, ease: [0.16, 1, 0.3, 1] }}
    >
      {children}
    </Component>
  );
}

/** 标题里的 \n 是「优先换行点」：放得下就同一行，放不下只在这里断，避免中文在词中间折行。 */
export function Phrases({ text }: { text: string }) {
  const parts = text.split('\n');
  if (parts.length === 1) return <>{text}</>;
  const separator = /[\u3000-\u9fff\uff00-\uffef]/.test(text) ? '' : ' ';
  return (
    <>
      {parts.map((part, index) => (
        <Fragment key={index}>
          {index > 0 && separator}
          <span className="inline-block">{part}</span>
        </Fragment>
      ))}
    </>
  );
}

const TOKEN = /((?:--?)?[A-Za-z0-9][\w.]*(?:[-#/][\w.]+)+|--[A-Za-z][\w-]*)/;

/** 正文里的 agent-dock、--local-only、file.ts#L14-L16 这类词整体不折行（浏览器默认会在连字符后断开）。 */
export function Rich({ text }: { text: string }) {
  const parts = text.split(TOKEN);
  if (parts.length === 1) return <>{text}</>;
  return <>{parts.map((part, index) => (index % 2 === 1 ? <span key={index} className="whitespace-nowrap">{part}</span> : part))}</>;
}

export function SectionHeading({ kicker, title, sub, align = 'center', className = '' }: { kicker: string; title: ReactNode; sub?: ReactNode; align?: 'center' | 'left'; className?: string }) {
  const centered = align === 'center';
  return (
    <div className={`${centered ? 'mx-auto text-center' : ''} max-w-3xl ${className}`}>
      <Reveal><Kicker>{kicker}</Kicker></Reveal>
      <Reveal delay={0.05}>
        <h2 className="mt-4 text-balance font-display text-[34px] font-semibold leading-[1.08] tracking-[-0.035em] text-zinc-900 sm:text-[46px] lg:text-[56px]">{typeof title === 'string' ? <Phrases text={title} /> : title}</h2>
      </Reveal>
      {sub && (
        <Reveal delay={0.1}>
          <p className={`mt-5 text-pretty text-[16px] leading-[1.75] text-zinc-500 sm:text-[18px] ${centered ? 'mx-auto max-w-2xl' : 'max-w-2xl'}`}>{typeof sub === 'string' ? <Rich text={sub} /> : sub}</p>
        </Reveal>
      )}
    </div>
  );
}

export function ExternalLink({ href, children, className = '', ariaLabel }: { href: string; children: ReactNode; className?: string; ariaLabel?: string }) {
  return <a href={href} target="_blank" rel="noreferrer noopener" className={className} aria-label={ariaLabel}>{children}</a>;
}

/** 只在进入视口后才开始的循环动画：离开视口暂停，省电也省 CPU。 */
export function useInViewport<T extends Element>(options: IntersectionObserverInit = { threshold: 0.2 }): [React.RefObject<T | null>, boolean] {
  const ref = useRef<T | null>(null);
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    const node = ref.current;
    if (!node || typeof IntersectionObserver === 'undefined') { setVisible(true); return; }
    const observer = new IntersectionObserver(([entry]) => setVisible(entry.isIntersecting), options);
    observer.observe(node);
    return () => observer.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return [ref, visible];
}

/** 定时推进的步进器：visible 为 false 时暂停，回到视口继续。 */
export function useTicker(durations: number[], active: boolean, { loop = true, onEnd }: { loop?: boolean; onEnd?: () => void } = {}): [number, (step: number) => void] {
  const [step, setStep] = useState(0);
  const endRef = useRef(onEnd);
  endRef.current = onEnd;
  useEffect(() => {
    if (!active) return;
    const duration = durations[step] ?? 1000;
    const timer = window.setTimeout(() => {
      if (step + 1 < durations.length) setStep(step + 1);
      else if (endRef.current) endRef.current();
      else if (loop) setStep(0);
    }, duration);
    return () => window.clearTimeout(timer);
  }, [active, step, durations, loop]);
  return [step, setStep];
}
