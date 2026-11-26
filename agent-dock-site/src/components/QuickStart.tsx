import { useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { ArrowLeft, ArrowRight, ArrowUpRight, Check, Download, PawPrint, QrCode } from 'lucide-react';
import { useLang } from '../lib/i18n';
import { LINKS } from '../content';
import { AgentIcon, Kitten, Reveal, Rich, SectionHeading } from './ui';
import { CodeBlock } from './CodeBlock';

function Illustration({ step }: { step: string }) {
  const { t } = useLang();
  if (step === 'install') {
    return (
      <div className="flex flex-wrap items-center gap-2 font-dock text-[12px]">
        <a href={LINKS.releases} target="_blank" rel="noreferrer noopener" className="inline-flex items-center gap-1.5 rounded-full border border-line bg-card px-3 py-1.5 text-zinc-700 transition-colors hover:border-zinc-300 hover:text-zinc-900"><Download size={13} />macOS</a>
        <a href={LINKS.releases} target="_blank" rel="noreferrer noopener" className="inline-flex items-center gap-1.5 rounded-full border border-line bg-card px-3 py-1.5 text-zinc-700 transition-colors hover:border-zinc-300 hover:text-zinc-900"><Download size={13} />Windows</a>
        <span className="rounded-full border border-dashed border-zinc-300 px-3 py-1.5 text-zinc-500">Linux · CLI + Web</span>
      </div>
    );
  }
  if (step === 'agents') {
    return (
      <div className="flex flex-wrap items-center gap-2">
        {['claude', 'codex', 'gemini', 'cursor', 'antigravity', 'opencode', 'qwen', 'copilot'].map((id, index) => (
          <motion.span key={id} initial={{ opacity: 0, scale: 0.8 }} animate={{ opacity: 1, scale: 1 }} transition={{ delay: index * 0.04 }} className="grid h-10 w-10 place-items-center rounded-xl border border-line bg-card">
            <AgentIcon id={id} size={20} />
          </motion.span>
        ))}
      </div>
    );
  }
  if (step === 'lark') {
    return (
      <div className="flex items-center gap-3 font-dock text-[12px] text-zinc-600">
        <span className="grid h-12 w-12 place-items-center rounded-xl border border-line bg-card"><QrCode size={22} className="text-zinc-700" /></span>
        <ArrowRight size={14} className="text-zinc-400" />
        <span className="rounded-xl border border-line bg-card px-3 py-2">@AgentDock …</span>
        <ArrowRight size={14} className="text-zinc-400" />
        <span className="flex items-center gap-1 rounded-xl bg-emerald-50 px-3 py-2 text-zinc-700"><Check size={12} strokeWidth={3} className="text-emerald-500" />{t.lark.phone.done}</span>
      </div>
    );
  }
  return (
    <div className="flex items-center gap-4">
      <Kitten mood="curious" size={70} />
      <div className="rounded-2xl border border-line bg-card px-3.5 py-2.5 font-dock text-[12px] text-zinc-700">
        <div>{t.hero.peek}</div>
        <div className="mt-2 inline-flex items-center gap-1.5 rounded-full bg-zinc-900 px-3 py-1 text-[11.5px] font-medium text-white"><PawPrint size={12} />{t.kitten.adopt.cta}</div>
      </div>
    </div>
  );
}

export function QuickStart() {
  const { t } = useLang();
  const s = t.start;
  const [active, setActive] = useState(0);
  const step = s.steps[active];
  const last = active === s.steps.length - 1;

  return (
    <section id="start" className="relative bg-page-soft py-24 sm:py-32">
      <div aria-hidden="true" className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-zinc-300 to-transparent" />
      <div className="mx-auto max-w-[1200px] px-5 sm:px-8">
        <SectionHeading kicker={s.kicker} title={s.title} sub={s.sub} />

        <Reveal className="mt-14 grid grid-cols-1 gap-6 sm:mt-16 lg:grid-cols-[300px_minmax(0,1fr)] lg:gap-10" y={30}>
          {/* 步骤列表：桌面竖排，手机 4 列网格 */}
          <div>
            <ol role="tablist" aria-label={s.title.replace('\n', '')} className="relative grid grid-cols-4 gap-1.5 lg:flex lg:flex-col lg:gap-1">
              <span aria-hidden="true" className="absolute bottom-6 left-[27px] top-6 hidden w-px bg-zinc-300/80 lg:block" />
              {s.steps.map((item, index) => {
                const selected = index === active;
                const done = index < active;
                return (
                  <li key={item.key} className="min-w-0">
                    <button
                      type="button"
                      role="tab"
                      aria-selected={selected}
                      onClick={() => setActive(index)}
                      className={`relative flex w-full flex-col items-center gap-1.5 rounded-2xl px-1 py-2.5 text-center transition-colors lg:flex-row lg:gap-3 lg:px-3 lg:py-3.5 lg:text-left ${selected ? 'bg-card shadow-[0_1px_2px_rgb(0_0_0/.05)] ring-1 ring-line' : 'hover:bg-zinc-900/[.03]'}`}
                    >
                      <span className={`relative z-10 grid h-8 w-8 shrink-0 place-items-center rounded-[10px] font-dock text-[12.5px] font-semibold transition-colors ${selected ? 'bg-brand text-snow' : done ? 'bg-emerald-100 text-emerald-700 dark:text-emerald-300' : 'border border-zinc-300 bg-page-soft text-zinc-500'}`}>
                        {done ? <Check size={14} strokeWidth={3} /> : String(index + 1).padStart(2, '0')}
                      </span>
                      <span className="min-w-0 max-w-full">
                        <span className={`block truncate font-dock text-[12px] font-medium sm:text-[13px] ${selected ? 'text-zinc-900' : 'text-zinc-600'}`}>{item.label}</span>
                        <span className="hidden truncate text-[12.5px] text-zinc-400 lg:block">{item.title}</span>
                      </span>
                    </button>
                  </li>
                );
              })}
            </ol>
          </div>

          <div className="card relative min-w-0 overflow-hidden rounded-[26px] p-5 sm:p-8">
            <AnimatePresence mode="wait">
              <motion.div key={step.key} initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -8 }} transition={{ duration: 0.3, ease: [0.2, 0, 0, 1] }}>
                <p className="font-dock text-[12px] font-medium tracking-[.08em] text-brand">{String(active + 1).padStart(2, '0')} / {String(s.steps.length).padStart(2, '0')} · {step.label}</p>
                <h3 className="mt-3 font-display text-[26px] font-semibold leading-[1.2] tracking-[-0.03em] text-zinc-900 sm:text-[32px]">{step.title}</h3>
                <p className="mt-3 max-w-[620px] text-pretty text-[15.5px] leading-[1.8] text-zinc-500"><Rich text={step.body} /></p>
                <div className="mt-6"><Illustration step={step.key} /></div>
                <CodeBlock lines={step.code} className="mt-6" title="zsh" />
                <ul className="mt-6 grid grid-cols-1 gap-2.5 sm:grid-cols-3">
                  {step.tips.map(tip => (
                    <li key={tip} className="flex gap-2 rounded-xl bg-zinc-900/[.035] px-3.5 py-3 text-[13px] leading-[1.65] text-zinc-600">
                      <Check size={14} strokeWidth={2.5} className="mt-[3px] shrink-0 text-emerald-500" /><span><Rich text={tip} /></span>
                    </li>
                  ))}
                </ul>
              </motion.div>
            </AnimatePresence>
            <div className="mt-8 flex items-center justify-between gap-3 border-t border-line pt-5">
              <button type="button" disabled={active === 0} onClick={() => setActive(value => Math.max(0, value - 1))} className="inline-flex h-10 items-center gap-1.5 rounded-full px-3 font-dock text-[13px] text-zinc-600 transition-colors enabled:hover:bg-zinc-900/[.05] enabled:hover:text-zinc-900 disabled:opacity-35">
                <ArrowLeft size={14} />{s.prev}
              </button>
              {last ? (
                <a href={LINKS.guide} target="_blank" rel="noreferrer noopener" className="inline-flex h-10 items-center gap-1.5 rounded-full bg-zinc-900 px-4 font-dock text-[13px] font-medium text-white transition-[transform,box-shadow] hover:-translate-y-px hover:shadow-[0_0_0_4px_rgb(var(--brand)/.18)]">
                  {s.done}<ArrowUpRight size={14} />
                </a>
              ) : (
                <button type="button" onClick={() => setActive(value => Math.min(s.steps.length - 1, value + 1))} className="inline-flex h-10 items-center gap-1.5 rounded-full bg-zinc-900 px-4 font-dock text-[13px] font-medium text-white transition-[transform,box-shadow] hover:-translate-y-px hover:shadow-[0_0_0_4px_rgb(var(--brand)/.18)]">
                  {s.next} · {s.steps[active + 1].label}<ArrowRight size={14} />
                </button>
              )}
            </div>
          </div>
        </Reveal>
      </div>
    </section>
  );
}
