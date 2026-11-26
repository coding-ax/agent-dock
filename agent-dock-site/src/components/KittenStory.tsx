import { useEffect, useRef, useState, type ReactNode } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { ArrowRight, Check, Folder, Gauge, LoaderCircle, PawPrint, RotateCcw } from 'lucide-react';
import { useLang } from '../lib/i18n';
import { AgentIcon, Kitten, Reveal, Rich, SectionHeading, type Mood } from './ui';

type StepKey = 'adopt' | 'split' | 'dispatch' | 'supervise' | 'review' | 'age' | 'handoff';

const MOODS: Record<StepKey, Mood> = { adopt: 'curious', split: 'happy', dispatch: 'busy', supervise: 'search', review: 'sparkle', age: 'sleepy', handoff: 'happy' };
const AGE: Record<StepKey, number> = { adopt: 0.04, split: 0.08, dispatch: 0.12, supervise: 0.3, review: 0.4, age: 0.86, handoff: 0.02 };
const NOTE_AGENTS = ['codex', 'claude', 'antigravity'];
const NOTE_MODELS = ['gpt-6.1-sol', 'Opus 5.5', 'Gemini 4 Neon'];

const fade = { initial: { opacity: 0, y: 14, filter: 'blur(4px)' }, animate: { opacity: 1, y: 0, filter: 'blur(0px)' }, exit: { opacity: 0, y: -10, filter: 'blur(4px)' }, transition: { duration: 0.4, ease: [0.2, 0, 0, 1] } } as const;

function Paper({ children, tone = 'amber', rotate = 0, className = '' }: { children: ReactNode; tone?: 'amber' | 'sky' | 'emerald'; rotate?: number; className?: string }) {
  const paper = tone === 'amber' ? 'bg-amber-50 border-amber-200/80' : tone === 'sky' ? 'bg-sky-50 border-sky-200/80' : 'bg-emerald-50 border-emerald-200/80';
  return (
    <div className={`relative rounded-lg border px-3 py-2.5 font-dock shadow-[0_1px_0_rgb(0_0_0/.03),0_10px_20px_-12px_rgb(0_0_0/.35)] ${paper} ${className}`} style={{ rotate: `${rotate}deg` }}>
      {children}
    </div>
  );
}

function Widget({ step }: { step: StepKey }) {
  const { t } = useLang();
  const k = t.kitten;
  switch (step) {
    case 'adopt':
      return (
        <div className="w-full max-w-[320px] rounded-2xl border border-zinc-200 bg-white p-4 font-dock shadow-[0_16px_40px_-16px_rgb(0_0_0/.3)]">
          <div className="text-[11px] text-zinc-500">{k.adopt.nameLabel}</div>
          <div className="mt-1 rounded-lg border border-zinc-300 px-2.5 py-1.5 text-[13px] text-zinc-900">{k.adopt.name}<span className="caret ml-px inline-block h-[13px] w-[1.5px] translate-y-[2px] bg-zinc-900" /></div>
          <div className="mt-3 text-[11px] text-zinc-500">{k.adopt.agentLabel}</div>
          <div className="mt-1 flex items-center gap-2 rounded-lg border border-zinc-200 px-2.5 py-1.5 text-[12.5px] text-zinc-800"><AgentIcon id="claude" size={14} />{k.adopt.agent}<span className="ml-auto text-[11px] text-zinc-400">{k.adopt.depth} · {k.adopt.depthValue}</span></div>
          <div className="mt-4 flex h-9 items-center justify-center gap-1.5 rounded-full bg-zinc-900 text-[12.5px] font-medium text-white"><PawPrint size={14} />{k.adopt.cta}</div>
        </div>
      );
    case 'split':
      return (
        <div className="relative h-[150px] w-full max-w-[360px]">
          {k.sessions.map((title, index) => (
            <motion.div key={title} className="absolute w-[58%]" style={{ left: `${index * 21}%`, top: index === 1 ? 0 : 18 }} initial={{ opacity: 0, y: 30, rotate: 0 }} animate={{ opacity: 1, y: 0, rotate: [-6, 2, 7][index] }} transition={{ delay: 0.08 * index, type: 'spring', stiffness: 260, damping: 20 }}>
              <Paper>
                <div className="text-[10px] text-zinc-400">#{index + 1}</div>
                <div className="truncate text-[12px] font-semibold text-zinc-900">{title}</div>
                <div className="mt-1.5 space-y-1">
                  <div className="h-1.5 w-[86%] rounded-full bg-zinc-900/[.08]" />
                  <div className="h-1.5 w-[62%] rounded-full bg-zinc-900/[.08]" />
                </div>
              </Paper>
            </motion.div>
          ))}
        </div>
      );
    case 'dispatch':
      return (
        <div className="flex w-full max-w-[380px] flex-col gap-2.5 font-dock">
          {k.sessions.map((title, index) => (
            <motion.div key={title} initial={{ opacity: 0, x: -16 }} animate={{ opacity: 1, x: 0 }} transition={{ delay: 0.1 * index }} className="flex items-center gap-2">
              <Paper className="min-w-0 flex-1 !py-1.5"><div className="truncate text-[11.5px] font-semibold text-zinc-900">{title}</div></Paper>
              <svg width="38" height="10" viewBox="0 0 38 10" className="shrink-0 text-brand" aria-hidden="true"><path d="M1 5h32" stroke="currentColor" strokeWidth="1.6" className="flow-dash" fill="none" /><path d="M31 1l5 4-5 4" stroke="currentColor" strokeWidth="1.6" fill="none" /></svg>
              <div className="flex w-[132px] shrink-0 items-center gap-2 rounded-lg border border-zinc-200 bg-white px-2 py-1.5">
                <AgentIcon id={NOTE_AGENTS[index]} size={15} />
                <span className="min-w-0 truncate text-[11px] text-zinc-700">{NOTE_MODELS[index]}</span>
                <span className="live-dot ml-auto h-1.5 w-1.5 shrink-0 rounded-full bg-amber-500" />
              </div>
            </motion.div>
          ))}
        </div>
      );
    case 'supervise':
      return (
        <div className="w-full max-w-[360px] font-dock">
          <div className="flex items-center gap-2 rounded-xl border border-dashed border-zinc-300 bg-white/70 px-3 py-2 text-[11.5px]">
            <Gauge size={13} className="text-brand" />
            <span className="font-semibold text-zinc-800">{k.systemRound}</span>
          </div>
          <p className="mt-1.5 px-1 text-[10.5px] text-zinc-400">{k.systemDesc}</p>
          <div className="mt-3 flex flex-col gap-1.5">
            {k.sessions.slice(0, 2).map((title, index) => (
              <motion.div key={title} initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.25 + index * 0.35 }} className="flex items-center gap-2 rounded-lg bg-white px-2.5 py-1.5 text-[11.5px] text-zinc-600 ring-1 ring-zinc-200">
                <AgentIcon id={NOTE_AGENTS[index]} size={13} />
                <span className="min-w-0 flex-1 truncate">#{index + 1} {title}</span>
                <Check size={12} strokeWidth={3} className="shrink-0 text-emerald-500" />
              </motion.div>
            ))}
            <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ delay: 1 }} className="flex items-center gap-2 rounded-lg bg-white px-2.5 py-1.5 text-[11.5px] text-zinc-600 ring-1 ring-zinc-200">
              <AgentIcon id={NOTE_AGENTS[2]} size={13} />
              <span className="min-w-0 flex-1 truncate">#3 {k.sessions[2]}</span>
              <LoaderCircle size={12} className="spin shrink-0 text-amber-500" />
            </motion.div>
          </div>
        </div>
      );
    case 'review':
      return <ReviewWidget />;
    case 'age':
      return (
        <div className="w-full max-w-[380px] font-dock">
          <div className="relative h-2 rounded-full bg-zinc-900/[.07]">
            <motion.div className="h-full rounded-full bg-gradient-to-r from-emerald-400 via-amber-400 to-brand" initial={{ width: '8%' }} animate={{ width: '86%' }} transition={{ duration: 1.4, ease: [0.2, 0, 0, 1] }} />
            {[0.15, 0.45, 0.8].map(floor => <span key={floor} className="absolute top-1/2 h-3 w-px -translate-y-1/2 bg-zinc-400/60" style={{ left: `${floor * 100}%` }} />)}
          </div>
          <div className="mt-2 grid grid-cols-4 text-[10.5px] text-zinc-400">
            {k.stages.map((stage, index) => <span key={stage.key} className={`${index === 3 ? 'font-semibold text-zinc-900' : ''} ${index > 0 ? 'text-center' : ''} ${index === 3 ? '!text-right' : ''}`}>{stage.label}</span>)}
          </div>
          <div className="mt-3 rounded-xl bg-white px-3 py-2 text-[11.5px] text-zinc-600 ring-1 ring-zinc-200">{k.stages[3].blurb}</div>
          <div className="mt-2.5 grid grid-cols-3 gap-2">
            {k.metrics.map(metric => (
              <div key={metric.label} className="rounded-xl bg-white px-2.5 py-2 ring-1 ring-zinc-200">
                <div className="text-[15px] font-semibold tabular-nums text-zinc-900">{metric.value}</div>
                <div className="truncate text-[10px] text-zinc-400">{metric.label}</div>
              </div>
            ))}
          </div>
        </div>
      );
    case 'handoff':
      return <HandoffWidget />;
  }
}

function ReviewWidget() {
  const { t } = useLang();
  const k = t.kitten;
  const [fixed, setFixed] = useState(false);
  useEffect(() => { const timer = window.setTimeout(() => setFixed(true), 1800); return () => window.clearTimeout(timer); }, []);
  return (
    <div className="grid w-full max-w-[380px] grid-cols-3 gap-2">
      {k.sessions.map((title, index) => {
        const rework = index === 2 && !fixed;
        return (
          <Paper key={title} tone={rework ? 'amber' : 'emerald'} rotate={[-2, 1, -1][index]} className="!px-2.5">
            <div className="text-[10px] text-zinc-400">#{index + 1}</div>
            <div className="line-clamp-2 min-h-[32px] text-[11px] font-semibold leading-4 text-zinc-900">{title}</div>
            <motion.div key={String(rework)} initial={{ opacity: 0, scale: 1.6, rotate: -20 }} animate={{ opacity: 1, scale: 1, rotate: -8 }} transition={{ type: 'spring', stiffness: 480, damping: 18, delay: rework ? 0.1 : 0.15 + index * 0.18 }}
              className={`mt-2 inline-flex items-center gap-0.5 rounded border-2 px-1 text-[9.5px] font-bold ${rework ? 'border-amber-500/70 text-amber-600 dark:text-amber-300' : 'border-emerald-500/70 text-emerald-600 dark:text-emerald-300'}`}>
              {rework ? <RotateCcw size={9} strokeWidth={3} /> : <Check size={9} strokeWidth={3.5} />}
              {rework ? k.verdicts.rework : k.verdicts.ok}
            </motion.div>
          </Paper>
        );
      })}
    </div>
  );
}

function HandoffWidget() {
  const { t } = useLang();
  const k = t.kitten;
  const [done, setDone] = useState(0);
  useEffect(() => {
    const timer = window.setInterval(() => setDone(value => (value >= k.ceremony.length ? value : value + 1)), 450);
    return () => window.clearInterval(timer);
  }, [k.ceremony.length]);
  return (
    <div className="w-full max-w-[400px] font-dock">
      <ol className="grid grid-cols-3 gap-1.5 sm:grid-cols-6">
        {k.ceremony.map((label, index) => {
          const state = index < done ? 'done' : index === done ? 'active' : 'pending';
          return (
            <li key={label} className={`flex flex-col items-center gap-1 rounded-lg px-1 py-1.5 text-center text-[10px] leading-tight transition-colors ${state === 'done' ? 'bg-emerald-50 text-zinc-700' : state === 'active' ? 'bg-amber-50 text-zinc-800' : 'bg-zinc-900/[.03] text-zinc-400'}`}>
              {state === 'done' ? <Check size={11} strokeWidth={3} className="text-emerald-500" /> : state === 'active' ? <LoaderCircle size={11} className="spin text-amber-500" /> : <span className="my-[3px] h-1.5 w-1.5 rounded-full bg-zinc-300" />}
              {label}
            </li>
          );
        })}
      </ol>
    </div>
  );
}

/** 舞台：小猫 + 气泡 + 当前步骤的小组件；年龄条随步骤推进，换代时重置成第 2 代。 */
function Stage({ index, compact = false }: { index: number; compact?: boolean }) {
  const { t, lang } = useLang();
  const k = t.kitten;
  const step = k.steps[index];
  const key = step.key as StepKey;
  const gen2 = key === 'handoff';
  const ageIndex = gen2 ? 0 : AGE[key] >= 0.8 ? 3 : AGE[key] >= 0.45 ? 2 : AGE[key] >= 0.15 ? 1 : 0;
  const name = gen2 ? t.demo.cat.name2 : t.demo.cat.name;
  const genLabel = lang === 'zh' ? `第 ${gen2 ? 2 : 1} 代 · ${k.stages[ageIndex].label}` : `Gen ${gen2 ? 2 : 1} · ${k.stages[ageIndex].label}`;
  return (
    <div className={`card relative flex flex-col overflow-hidden rounded-[28px] ${compact ? 'h-[440px]' : 'h-full'}`}>
      <div aria-hidden="true" className="dot-grid absolute inset-0 opacity-70" />
      <div aria-hidden="true" className="absolute left-1/2 top-[30%] h-[60%] w-[80%] -translate-x-1/2 rounded-full bg-[radial-gradient(closest-side,rgb(var(--glow)/.16),transparent)]" />
      <div className="relative flex items-center justify-between px-5 pt-4 font-dock text-[11.5px] text-zinc-500">
        <span className="tabular-nums">{k.stepOf(index + 1, k.steps.length)} · <span className="text-zinc-900">{step.label}</span></span>
        <AnimatePresence mode="wait" initial={false}>
          <motion.span key={`${name}-${genLabel}`} {...fade} className="flex items-center gap-1.5 rounded-full bg-zinc-900/[.05] px-2.5 py-1">
            <PawPrint size={11} className="text-brand" />{name} · {genLabel}
          </motion.span>
        </AnimatePresence>
      </div>
      <div className="relative mx-5 mt-3 h-1 overflow-hidden rounded-full bg-zinc-900/[.06]">
        <motion.div className="h-full rounded-full bg-gradient-to-r from-emerald-400 via-amber-400 to-brand" animate={{ width: `${Math.round(AGE[key] * 100)}%` }} transition={{ duration: 0.8, ease: [0.2, 0, 0, 1] }} />
      </div>
      <div className="relative flex flex-1 flex-col items-center justify-center gap-4 px-5 pb-6 pt-2">
        <div className="flex flex-col items-center">
          <AnimatePresence mode="wait">
            <motion.div key={`bubble-${index}`} {...fade} className="relative mb-3 max-w-[300px] rounded-2xl bg-white px-3.5 py-2 text-center font-dock text-[12.5px] leading-5 text-zinc-700 shadow-[0_8px_24px_-8px_rgb(0_0_0/.25)] ring-1 ring-zinc-200">
              {step.bubble}
              <span className="absolute -bottom-1 left-1/2 h-2.5 w-2.5 -translate-x-1/2 rotate-45 bg-white" />
            </motion.div>
          </AnimatePresence>
          <div className="relative flex items-end gap-3">
            <AnimatePresence>
              {gen2 && (
                <motion.div key="old" initial={{ opacity: 0, x: 20 }} animate={{ opacity: 0.55, x: 0 }} exit={{ opacity: 0 }} className="grayscale-[40%]">
                  <Kitten mood="sleepy" size={compact ? 62 : 78} />
                </motion.div>
              )}
            </AnimatePresence>
            <AnimatePresence mode="wait">
              <motion.div key={`cat-${key}`} initial={{ opacity: 0, scale: 0.85, y: 10 }} animate={{ opacity: 1, scale: 1, y: 0 }} exit={{ opacity: 0, scale: 0.9 }} transition={{ type: 'spring', stiffness: 260, damping: 20 }}>
                <Kitten mood={MOODS[key]} size={compact ? 112 : 150} />
              </motion.div>
            </AnimatePresence>
          </div>
        </div>
        <AnimatePresence mode="wait">
          <motion.div key={`widget-${key}`} {...fade} className="flex w-full justify-center">
            <Widget step={key} />
          </motion.div>
        </AnimatePresence>
      </div>
    </div>
  );
}

export function KittenStory() {
  const { t } = useLang();
  const k = t.kitten;
  const [active, setActive] = useState(0);
  const items = useRef<(HTMLLIElement | null)[]>([]);

  useEffect(() => {
    if (typeof IntersectionObserver === 'undefined') return;
    const observer = new IntersectionObserver(entries => {
      for (const entry of entries) {
        if (entry.isIntersecting) setActive(Number((entry.target as HTMLElement).dataset.index));
      }
    }, { rootMargin: '-48% 0px -48% 0px' });
    items.current.forEach(node => node && observer.observe(node));
    return () => observer.disconnect();
  }, []);

  return (
    <section id="kitten" className="relative bg-page-soft py-24 sm:py-32">
      <div aria-hidden="true" className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-zinc-300 to-transparent" />
      <div className="mx-auto max-w-[1200px] px-5 sm:px-8">
        <SectionHeading kicker={k.kicker} title={k.title} sub={k.sub} />

        <div className="mt-16 grid grid-cols-1 gap-10 lg:mt-20 lg:grid-cols-[minmax(0,1.05fr)_minmax(0,1fr)] lg:gap-16">
          <div className="hidden lg:block">
            <div className="sticky top-[13vh] h-[min(660px,74vh)]">
              <Stage index={active} />
            </div>
          </div>

          <ol className="relative">
            <span aria-hidden="true" className="absolute bottom-[33vh] left-[15px] top-[33vh] hidden w-px bg-zinc-300/70 lg:block" />
            {k.steps.map((step, index) => (
              <li
                key={step.key}
                ref={node => { items.current[index] = node; }}
                data-index={index}
                className="relative flex flex-col justify-center py-6 lg:min-h-[66vh] lg:py-10 lg:pl-14"
              >
                <span aria-hidden="true" className={`absolute left-[9px] top-1/2 hidden h-[13px] w-[13px] -translate-y-1/2 rounded-[3px] border-2 transition-all duration-300 lg:block ${active === index ? 'scale-110 border-brand bg-brand' : 'border-zinc-300 bg-page-soft'}`} />
                <div className="mb-6 lg:hidden"><Stage index={index} compact /></div>
                <Reveal>
                  <p className={`font-dock text-[12.5px] font-medium tracking-[.08em] transition-colors ${active === index ? 'text-brand' : 'text-zinc-400'}`}>{k.stepOf(index + 1, k.steps.length)} · {step.label}</p>
                  <h3 className="mt-3 font-display text-[28px] font-semibold leading-[1.15] tracking-[-0.03em] text-zinc-900 sm:text-[34px]">{step.title}</h3>
                  <p className="mt-4 max-w-[520px] text-pretty text-[16px] leading-[1.85] text-zinc-500 sm:text-[17px]"><Rich text={step.body} /></p>
                  {step.key === 'dispatch' && (
                    <div className="mt-5 flex flex-wrap items-center gap-2 font-dock text-[12px] text-zinc-500">
                      {NOTE_AGENTS.map((id, i) => <span key={id} className="flex items-center gap-1.5 rounded-full border border-line bg-card px-2.5 py-1"><AgentIcon id={id} size={13} />{NOTE_MODELS[i]}</span>)}
                      <span className="flex items-center gap-1 text-zinc-400"><Folder size={12} />web · server · docs</span>
                    </div>
                  )}
                  {step.key === 'handoff' && (
                    <a href="#start" className="mt-6 inline-flex items-center gap-1.5 font-dock text-[13px] font-medium text-zinc-900 underline decoration-brand/50 decoration-2 underline-offset-4 hover:decoration-brand">
                      {t.nav.cta}<ArrowRight size={14} />
                    </a>
                  )}
                </Reveal>
              </li>
            ))}
          </ol>
        </div>
      </div>
    </section>
  );
}
