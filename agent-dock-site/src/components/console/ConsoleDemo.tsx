import { useCallback, useRef, useState } from 'react';
import { AnimatePresence, motion, useReducedMotion, useScroll, useTransform } from 'motion/react';
import { Lock, Pause, Play, RotateCcw } from 'lucide-react';
import { useLang } from '../../lib/i18n';
import { Kicker, Kitten, Phrases, useInViewport } from '../ui';
import { ArtifactsScene, DispatchScene, ScheduleScene, SwitchScene, type SceneProps } from './scenes';

const SCENES: Array<(props: SceneProps) => React.JSX.Element> = [DispatchScene, SwitchScene, ArtifactsScene, ScheduleScene];

export function ConsoleDemo() {
  const { t } = useLang();
  const reduce = useReducedMotion();
  const [scene, setScene] = useState(0);
  const [round, setRound] = useState(0);
  const [paused, setPaused] = useState(false);
  const [hovered, setHovered] = useState(false);
  const [progress, setProgress] = useState({ ratio: 0, ms: 0 });
  const [viewRef, visible] = useInViewport<HTMLDivElement>({ threshold: 0.3 });
  const active = visible && !paused;

  const frameRef = useRef<HTMLDivElement>(null);
  const { scrollYProgress } = useScroll({ target: frameRef, offset: ['start end', 'start 0.2'] });
  const rotateX = useTransform(scrollYProgress, [0, 1], [reduce ? 0 : 20, 0]);
  const scale = useTransform(scrollYProgress, [0, 1], [reduce ? 1 : 0.9, 1]);
  const y = useTransform(scrollYProgress, [0, 1], [reduce ? 0 : 40, 0]);

  const pick = useCallback((index: number) => {
    setScene(index);
    setRound(value => value + 1);
    setProgress({ ratio: 0, ms: 0 });
    setPaused(false);
  }, []);
  const onEnd = useCallback(() => {
    setScene(value => (value + 1) % SCENES.length);
    setRound(value => value + 1);
    setProgress({ ratio: 0, ms: 0 });
  }, []);
  const onProgress = useCallback((ratio: number, ms: number) => setProgress({ ratio, ms }), []);

  const Scene = SCENES[scene];
  const tab = t.demo.tabs[scene];

  return (
    <section id="demo" className="relative scroll-mt-16 px-3 pb-20 pt-16 sm:px-8 sm:pb-28 sm:pt-24">
      <div className="mx-auto max-w-[1200px]">
        <div className="flex flex-col items-center text-center">
          <Kicker>{t.demo.kicker}</Kicker>
          <h2 className="sr-only"><Phrases text={t.demo.title} /></h2>
          <div className="no-scrollbar mt-5 max-w-full overflow-x-auto px-1 pb-1">
            <div role="tablist" aria-label={t.demo.kicker} className="inline-flex items-center gap-1 rounded-full border border-line bg-card/80 p-1 backdrop-blur">
              {t.demo.tabs.map((item, index) => (
                <button
                  key={item.id}
                  type="button"
                  role="tab"
                  aria-selected={index === scene}
                  onClick={() => pick(index)}
                  className={`relative h-9 shrink-0 overflow-hidden whitespace-nowrap rounded-full px-3 font-dock text-[12.5px] transition-colors sm:px-4 sm:text-[13px] ${index === scene ? 'text-zinc-900' : 'text-zinc-500 hover:text-zinc-800'}`}
                >
                  {index === scene && <motion.span layoutId="demo-tab" className="absolute inset-0 rounded-full bg-zinc-900/[.07]" transition={{ type: 'spring', stiffness: 420, damping: 36 }} />}
                  <span className="relative sm:hidden">{item.short}</span><span className="relative hidden sm:inline">{item.label}</span>
                  {index === scene && (
                    <span className="absolute inset-x-3 bottom-[3px] h-[2px] overflow-hidden rounded-full bg-zinc-900/[.06]">
                      <span className="block h-full rounded-full bg-brand" style={{ width: `${progress.ratio * 100}%`, transition: active ? `width ${progress.ms}ms linear` : 'none' }} />
                    </span>
                  )}
                </button>
              ))}
            </div>
          </div>
          <div className="mt-2 flex items-center gap-1 font-dock text-[12px] text-zinc-500 sm:mt-3 sm:gap-2">
            <AnimatePresence mode="wait" initial={false}>
              <motion.span key={tab.id} initial={{ opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -4 }} transition={{ duration: 0.2 }}>{tab.hint}</motion.span>
            </AnimatePresence>
            <span className="h-3 w-px bg-zinc-300" />
            <button type="button" onClick={() => setPaused(value => !value)} aria-label={paused ? t.demo.play : t.demo.pause} title={paused ? t.demo.play : t.demo.pause} className="grid h-9 w-9 place-items-center rounded-full text-zinc-500 hover:bg-zinc-900/[.06] hover:text-zinc-900 sm:h-7 sm:w-7">
              {paused ? <Play size={12} /> : <Pause size={12} />}
            </button>
            <button type="button" onClick={() => pick(scene)} aria-label={t.demo.replay} title={t.demo.replay} className="grid h-9 w-9 place-items-center rounded-full text-zinc-500 hover:bg-zinc-900/[.06] hover:text-zinc-900 sm:h-7 sm:w-7">
              <RotateCcw size={12} />
            </button>
          </div>
        </div>

        <div ref={viewRef} className="relative mt-24 sm:mt-28" style={{ perspective: 1800 }}>
          {/* 窗口背后的暖光 */}
          <div aria-hidden="true" className="pointer-events-none absolute inset-x-[8%] top-[6%] -z-10 h-[70%] rounded-full bg-brand/20 blur-[90px] dark:bg-brand/15" />
          <motion.div ref={frameRef} style={{ rotateX, scale, y, transformOrigin: '50% 0%' }} className="relative" onMouseEnter={() => setHovered(true)} onMouseLeave={() => setHovered(false)}>
            {/* 小猫从窗口后面探出头 */}
            <div aria-hidden="true" className="absolute -top-[74px] right-[7%] z-0 flex items-end gap-2 sm:-top-[96px] sm:right-[9%]">
              <motion.span
                initial={{ opacity: 0, y: 8, scale: 0.9 }}
                whileInView={{ opacity: 1, y: 0, scale: 1 }}
                viewport={{ once: true }}
                transition={{ delay: 0.6, duration: 0.4 }}
                className="relative mb-12 hidden whitespace-nowrap rounded-2xl bg-white px-3 py-1.5 font-dock text-[12px] text-zinc-700 shadow-[0_6px_20px_-6px_rgb(0_0_0/.25)] ring-1 ring-zinc-200 sm:mb-16 sm:block"
              >
                {hovered ? t.hero.peekHover : t.hero.peek}
                <span className="absolute -right-1 bottom-2 h-2.5 w-2.5 rotate-45 bg-white" />
              </motion.span>
              <motion.div initial={{ y: 40 }} whileInView={{ y: 0 }} viewport={{ once: true, amount: 0.2 }} transition={{ type: 'spring', stiffness: 160, damping: 14, delay: 0.3 }}>
                <Kitten mood={hovered ? 'happy' : 'curious'} size={112} className="hidden sm:block" />
                <Kitten mood={hovered ? 'happy' : 'curious'} size={84} className="sm:hidden" />
              </motion.div>
            </div>

            <div className="window-shadow relative z-10 overflow-hidden rounded-[16px] border border-zinc-200 bg-canvas font-dock sm:rounded-[20px]">
              {/* 窗口标题栏 */}
              <div className="flex h-10 items-center gap-3 border-b border-zinc-200 bg-rail px-3.5">
                <span className="flex gap-1.5" aria-hidden="true">
                  <span className="h-3 w-3 rounded-full bg-[#ff5f57]" /><span className="h-3 w-3 rounded-full bg-[#febc2e]" /><span className="h-3 w-3 rounded-full bg-[#28c840]" />
                </span>
                <span className="mx-auto flex min-w-0 items-center gap-1.5 rounded-md bg-zinc-900/[.045] px-3 py-1 text-[11.5px] text-zinc-500">
                  <Lock size={10} className="shrink-0" /><span className="truncate">{t.demo.url}</span>
                </span>
                <span className="w-[52px]" aria-hidden="true" />
              </div>
              <div className="h-[540px] sm:h-[580px] lg:h-[600px]" aria-live="off">
                <Scene key={`${scene}-${round}`} active={active} onEnd={onEnd} onProgress={onProgress} />
              </div>
            </div>
          </motion.div>
        </div>
      </div>
    </section>
  );
}
