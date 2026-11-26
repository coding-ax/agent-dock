import { useEffect, useRef } from 'react';
import { motion, useReducedMotion } from 'motion/react';
import { ArrowUpRight, Check, Copy, Download } from 'lucide-react';
import { useLang } from '../lib/i18n';
import { INSTALL, LINKS } from '../content';
import { AgentIcon, GithubIcon, useCopy } from './ui';

const ease = [0.16, 1, 0.3, 1] as const;

/** 首屏两侧漂浮的 Agent 图标：外层跟鼠标视差，内层自己上下浮动，两种 transform 分层互不覆盖。 */
const TILES = [
  { id: 'claude', side: 'left', x: '3%', y: '16%', size: 78, tilt: -9, depth: 26, dur: 7.5, delay: 0 },
  { id: 'gemini', side: 'left', x: '11%', y: '50%', size: 62, tilt: 7, depth: 16, dur: 8.5, delay: -2 },
  { id: 'antigravity', side: 'left', x: '2%', y: '78%', size: 58, tilt: -5, depth: 12, dur: 6.8, delay: -4 },
  { id: 'codex', side: 'right', x: '4%', y: '13%', size: 74, tilt: 8, depth: 24, dur: 7.8, delay: -1 },
  { id: 'cursor', side: 'right', x: '12%', y: '48%', size: 62, tilt: -7, depth: 18, dur: 8.2, delay: -3 },
  { id: 'copilot', side: 'right', x: '3%', y: '76%', size: 56, tilt: 6, depth: 12, dur: 7.1, delay: -5 }
] as const;

export function InstallCommand() {
  const { t } = useLang();
  const [copied, copy] = useCopy();
  return (
    <>
      {/* 桌面：一行胶囊，点整条即复制 */}
      <button
        type="button"
        onClick={() => copy(INSTALL.one)}
        aria-label={t.hero.copy}
        className="group hidden h-12 items-center gap-3 rounded-full border border-line bg-card pl-5 pr-1.5 font-dock text-[14px] text-zinc-800 shadow-[0_1px_2px_rgb(0_0_0/.04)] transition-[border-color,box-shadow] hover:border-zinc-300 hover:shadow-[0_0_0_4px_rgb(var(--brand)/.10)] sm:inline-flex"
      >
        <span className="select-none text-brand">$</span>
        <span className="whitespace-nowrap">{INSTALL.one}</span>
        <span className={`ml-1 inline-flex h-9 items-center gap-1.5 rounded-full px-3 text-[12.5px] transition-colors ${copied ? 'bg-emerald-50 text-emerald-600 dark:text-emerald-300' : 'bg-zinc-900/[.05] text-zinc-600 group-hover:bg-zinc-900 group-hover:text-white'}`}>
          {copied ? <Check size={14} strokeWidth={2.5} /> : <Copy size={14} />}
          {copied ? t.hero.copied : t.common.copy}
        </span>
      </button>
      {/* 手机：两行终端卡片，避免一行命令撑破 390px */}
      <div className="relative w-full rounded-2xl border border-line bg-card p-4 pr-14 text-left font-dock text-[13px] leading-6 text-zinc-800 sm:hidden">
        {INSTALL.lines.map(line => (
          <div key={line} className="whitespace-nowrap"><span className="mr-2 select-none text-brand">$</span>{line}</div>
        ))}
        <button
          type="button"
          onClick={() => copy(INSTALL.one)}
          aria-label={t.hero.copy}
          className={`absolute right-3 top-3 grid h-9 w-9 place-items-center rounded-xl transition-colors ${copied ? 'bg-emerald-50 text-emerald-600 dark:text-emerald-300' : 'bg-zinc-900/[.05] text-zinc-600'}`}
        >
          {copied ? <Check size={15} strokeWidth={2.5} /> : <Copy size={15} />}
        </button>
      </div>
    </>
  );
}

export function Hero() {
  const { t, lang } = useLang();
  const reduce = useReducedMotion();
  const ref = useRef<HTMLElement>(null);

  // 鼠标视差：直接写 CSS 变量，不触发 React 重渲染。
  useEffect(() => {
    const node = ref.current;
    if (!node || reduce || !window.matchMedia('(pointer: fine)').matches) return;
    let frame = 0;
    const onMove = (event: PointerEvent) => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const rect = node.getBoundingClientRect();
        node.style.setProperty('--mx', String(((event.clientX - rect.left) / rect.width - 0.5) * 2));
        node.style.setProperty('--my', String(((event.clientY - rect.top) / rect.height - 0.5) * 2));
      });
    };
    node.addEventListener('pointermove', onMove);
    return () => { node.removeEventListener('pointermove', onMove); cancelAnimationFrame(frame); };
  }, [reduce]);

  const item = (delay: number) => ({
    initial: reduce ? false : { opacity: 0, y: 22, filter: 'blur(8px)' },
    animate: { opacity: 1, y: 0, filter: 'blur(0px)' },
    transition: { duration: 0.9, delay, ease }
  } as const);

  return (
    <section id="top" ref={ref} className="relative isolate overflow-hidden pt-32 sm:pt-40" style={{ ['--mx' as string]: 0, ['--my' as string]: 0 }}>
      {/* 背景：像素点阵 + 暖色光晕 + 几颗像素星 */}
      <div aria-hidden="true" className="pointer-events-none absolute inset-0 -z-10">
        <div className="dot-grid fade-mask-radial absolute inset-0" />
        <div className="glow-breathe absolute left-1/2 top-[-12%] h-[620px] w-[1100px] max-w-[160vw] -translate-x-1/2 rounded-full bg-[radial-gradient(closest-side,rgb(var(--glow)/.16),transparent)] dark:bg-[radial-gradient(closest-side,rgb(var(--glow)/.20),transparent)]" />
        {[
          ['14%', '22%', '3.2s', '0s'], ['84%', '30%', '2.6s', '-1s'], ['22%', '64%', '3.8s', '-2s'], ['76%', '70%', '3.1s', '-0.4s'], ['50%', '9%', '2.9s', '-1.6s'], ['63%', '42%', '3.5s', '-2.4s']
        ].map(([left, top, dur, delay], index) => (
          <span key={index} className={`twinkle absolute h-[5px] w-[5px] bg-brand ${index !== 1 && index !== 4 ? 'max-sm:hidden' : ''}`} style={{ left, top, ['--dur' as string]: dur, ['--delay' as string]: delay }} />
        ))}
      </div>

      {/* 漂浮的 Agent 图标（只在宽屏出现） */}
      <div aria-hidden="true" className="pointer-events-none absolute inset-x-0 top-24 mx-auto hidden h-[520px] max-w-[1320px] lg:block">
        {TILES.map((tile, index) => (
          <div
            key={tile.id}
            className="absolute"
            style={{
              [tile.side]: tile.x,
              top: tile.y,
              transform: `translate3d(calc(var(--mx) * ${tile.depth}px), calc(var(--my) * ${Math.round(tile.depth * 0.6)}px), 0)`,
              transition: 'transform .6s cubic-bezier(.16,1,.3,1)'
            }}
          >
            <motion.div
              initial={reduce ? false : { opacity: 0, scale: 0.6 }}
              animate={{ opacity: 1, scale: 1 }}
              transition={{ duration: 0.9, delay: 0.35 + index * 0.07, ease }}
            >
              <div className="float-a" style={{ ['--tilt' as string]: `${tile.tilt}deg`, ['--dur' as string]: `${tile.dur}s`, ['--delay' as string]: `${tile.delay}s` }}>
                <div className="elevated grid place-items-center rounded-[22px] border border-line bg-card" style={{ width: tile.size, height: tile.size }}>
                  <AgentIcon id={tile.id} size={Math.round(tile.size * 0.46)} />
                </div>
              </div>
            </motion.div>
          </div>
        ))}
      </div>

      <div className="relative mx-auto flex max-w-[1200px] flex-col items-center px-5 text-center sm:px-8">
        <motion.a
          {...item(0)}
          href={LINKS.releases}
          target="_blank"
          rel="noreferrer noopener"
          className="group inline-flex max-w-full items-center gap-2 rounded-full border border-line bg-card/80 py-1 pl-1 pr-3 font-dock text-[12.5px] text-zinc-600 backdrop-blur transition-colors hover:border-zinc-300 hover:text-zinc-900"
        >
          <span className="rounded-full bg-brand/15 px-2 py-0.5 text-[11.5px] font-semibold text-brand">{t.hero.badgeTag}</span>
          <span className="truncate">{t.hero.badge}</span>
          <ArrowUpRight size={13} className="shrink-0 text-zinc-400 transition-transform group-hover:-translate-y-px group-hover:translate-x-px" />
        </motion.a>

        <h1 className={`mt-7 font-display font-semibold text-zinc-900 ${lang === 'zh' ? 'text-[40px] leading-[1.12] tracking-[-0.03em] min-[400px]:text-[44px] sm:text-[64px] lg:text-[84px]' : 'text-[44px] leading-[1.02] tracking-[-0.045em] sm:text-[68px] lg:text-[92px]'}`}>
          <motion.span {...item(0.08)} className="block">{t.hero.titleA}</motion.span>
          <motion.span {...item(0.18)} className="block">
            <span className="pixel-shadow">{t.hero.titleB1}</span>
            <span className={`max-sm:block ${lang === 'en' ? 'sm:ml-[.2em]' : ''}`}><span className="pixel-shadow">{t.hero.titleB2}</span></span>
          </motion.span>
        </h1>

        <motion.p {...item(0.3)} className="mt-7 max-w-[680px] text-pretty text-[16px] leading-[1.8] text-zinc-500 sm:text-[18.5px]">
          {t.hero.sub}
        </motion.p>

        <motion.div {...item(0.42)} className="mt-9 flex w-full flex-col items-center gap-4">
          <InstallCommand />
          <div className="flex w-full flex-col items-stretch justify-center gap-3 sm:w-auto sm:flex-row sm:items-center">
            <a href={LINKS.releases} target="_blank" rel="noreferrer noopener" className="inline-flex h-12 items-center justify-center gap-2 rounded-full bg-zinc-900 px-6 font-dock text-[14px] font-medium text-white transition-[transform,box-shadow] hover:-translate-y-0.5 hover:shadow-[0_0_0_5px_rgb(var(--brand)/.18)]">
              <Download size={16} />{t.hero.desktop}
            </a>
            <a href={LINKS.github} target="_blank" rel="noreferrer noopener" className="inline-flex h-12 items-center justify-center gap-2 rounded-full border border-zinc-300 bg-card/60 px-6 font-dock text-[14px] font-medium text-zinc-900 backdrop-blur transition-colors hover:bg-zinc-100">
              <GithubIcon size={16} />{t.hero.github}
            </a>
          </div>
        </motion.div>

        <motion.ul {...item(0.52)} className="mt-7 flex flex-wrap items-center justify-center gap-x-4 gap-y-2 font-dock text-[12px] text-zinc-400">
          {t.hero.facts.map((fact, index) => (
            <li key={fact} className="flex items-center gap-4">
              {index > 0 && <span aria-hidden="true" className="h-1 w-1 bg-zinc-300" />}
              {fact}
            </li>
          ))}
        </motion.ul>

        {/* 窄屏：图标排成一行，代替两侧漂浮 */}
        <motion.div {...item(0.6)} aria-hidden="true" className="mt-9 flex items-center gap-2.5 lg:hidden">
          {TILES.map(tile => (
            <span key={tile.id} className="grid h-10 w-10 place-items-center rounded-xl border border-line bg-card">
              <AgentIcon id={tile.id} size={20} />
            </span>
          ))}
        </motion.div>
      </div>
    </section>
  );
}
