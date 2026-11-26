import { useEffect, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { Check, ChevronLeft, Ellipsis, LoaderCircle, MessagesSquare, Mic, Plus, QrCode, RotateCcw, ShieldCheck, Smile, Users } from 'lucide-react';
import { useLang } from '../lib/i18n';
import { AgentIcon, Reveal, Rich, SectionHeading, useInViewport, useTicker } from './ui';
import { KittenAvatar, mmss } from './console/parts';

const FEATURE_ICONS = [QrCode, MessagesSquare, Users, RotateCcw, ShieldCheck];
const LARK = [600, 1000, 800, 1100, 900, 900, 1000, 2200, 1300, 3600];

function Phone() {
  const { t, lang } = useLang();
  const p = t.lark.phone;
  const [ref, visible] = useInViewport<HTMLDivElement>({ threshold: 0.35 });
  const [tick] = useTicker(LARK, visible, { loop: true });
  const step = tick - 1;
  const [elapsed, setElapsed] = useState(0);
  const running = step >= 3 && step < 6;
  useEffect(() => { if (step < 3) setElapsed(0); }, [step]);
  useEffect(() => {
    if (!running) return;
    const timer = window.setInterval(() => setElapsed(value => value + 4), 250);
    return () => window.clearInterval(timer);
  }, [running]);
  const state = step >= 6 ? 'done' : step >= 3 ? 'running' : 'thinking';
  const stateChip = state === 'done' ? { label: p.done, cls: 'bg-emerald-100 text-emerald-700 dark:text-emerald-300' } : state === 'running' ? { label: p.running, cls: 'bg-sky-100 text-sky-700 dark:text-sky-300' } : { label: p.thinking, cls: 'bg-zinc-900/[.06] text-zinc-500' };
  const headerBand = state === 'done' ? 'from-emerald-50' : state === 'running' ? 'from-sky-50' : 'from-zinc-900/[.04]';
  const [mention, ...rest] = p.ask.split(' ');

  return (
    <div ref={ref} className="relative mx-auto w-[300px] sm:w-[330px]">
      <div aria-hidden="true" className="absolute -inset-10 -z-10 rounded-full bg-brand/15 blur-[80px]" />
      <div className="rounded-[52px] bg-[#0d0d0d] p-[11px] shadow-[0_40px_80px_-30px_rgb(0_0_0/.55)] ring-1 ring-black/10 dark:ring-white/10">
        <div className="relative flex h-[620px] flex-col overflow-hidden rounded-[42px] bg-[#f2f3f5] font-sans dark:bg-[#161616] sm:h-[660px]">
          {/* 状态栏 + 灵动岛 */}
          <div className="relative flex h-11 shrink-0 items-center justify-between px-7 pt-1 text-[13px] font-semibold text-zinc-900">
            <span>9:41</span>
            <span aria-hidden="true" className="absolute left-1/2 top-2.5 h-[26px] w-[92px] -translate-x-1/2 rounded-full bg-[#0d0d0d]" />
            <span className="flex items-center gap-1" aria-hidden="true">
              <span className="flex items-end gap-[2px]">{[5, 7, 9, 11].map(h => <span key={h} className="w-[3px] rounded-sm bg-zinc-900" style={{ height: h }} />)}</span>
              <span className="ml-1 h-[11px] w-[22px] rounded-[3px] border border-zinc-900/70 p-[1.5px]"><span className="block h-full w-[70%] rounded-[1.5px] bg-zinc-900" /></span>
            </span>
          </div>
          {/* 群聊标题 */}
          <div className="flex h-12 shrink-0 items-center gap-2 border-b border-black/[.06] px-3 dark:border-white/[.06]">
            <ChevronLeft size={20} className="text-zinc-700" />
            <span className="grid h-7 w-7 place-items-center rounded-lg bg-brand text-[12px] font-bold text-snow">{lang === 'zh' ? '研' : 'D'}</span>
            <span className="text-[15px] font-semibold text-zinc-900">{p.group}</span>
            <span className="text-[13px] text-zinc-400">({p.members})</span>
            <Ellipsis size={18} className="ml-auto text-zinc-600" />
          </div>
          {/* 消息 */}
          <div className="fade-mask-top flex min-h-0 flex-1 flex-col justify-end gap-3 overflow-hidden px-3 pb-3">
            <AnimatePresence initial={false}>
              {step >= 0 && (
                <motion.div key="ask" layout initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} className="flex flex-col items-end">
                  <div className="flex items-start gap-2">
                    <div className="max-w-[210px] rounded-2xl rounded-tr-md bg-[#cfe0ff] px-3 py-2 text-[13.5px] leading-[1.55] text-[#0d0d0d] dark:bg-[#2a3f6a] dark:text-[#ececec]">
                      <span className="font-medium text-[#3370ff] dark:text-[#8fb1ff]">{mention}</span> {rest.join(' ')}
                    </div>
                    <span className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-zinc-300 text-[11px] font-semibold text-zinc-700">{p.me}</span>
                  </div>
                  <AnimatePresence>
                    {step >= 1 && (
                      <motion.span initial={{ opacity: 0, scale: 0.6 }} animate={{ opacity: 1, scale: 1 }} transition={{ type: 'spring', stiffness: 500, damping: 20 }} className="mr-10 mt-1 flex items-center gap-1 rounded-full bg-white px-2 py-0.5 text-[11px] text-zinc-500 shadow-sm dark:bg-[#2a2a2a]">
                        <span>👀</span>AgentDock
                      </motion.span>
                    )}
                  </AnimatePresence>
                </motion.div>
              )}
              {step >= 2 && (
                <motion.div key="card" layout initial={{ opacity: 0, y: 14 }} animate={{ opacity: 1, y: 0 }} className="flex items-start gap-2">
                  <KittenAvatar mood={state === 'done' ? 'happy' : 'busy'} size={32} />
                  <div className="min-w-0 flex-1">
                    <div className="mb-1 text-[11px] text-zinc-500">{p.bot}</div>
                    <div className="overflow-hidden rounded-xl bg-white shadow-[0_1px_2px_rgb(0_0_0/.06)] ring-1 ring-black/[.04] dark:bg-[#232323] dark:ring-white/[.06]">
                      <div className={`flex items-center gap-1.5 bg-gradient-to-b ${headerBand} to-transparent px-3 pb-2 pt-2.5 transition-colors duration-500`}>
                        <AgentIcon id="claude" size={14} />
                        <span className="text-[12.5px] font-semibold text-zinc-900">{p.agent}</span>
                        <span className={`ml-auto rounded px-1.5 py-0.5 text-[10.5px] font-medium transition-colors ${stateChip.cls}`}>{stateChip.label}</span>
                      </div>
                      <div className="px-3 pb-2.5 text-[12.5px] leading-[1.6] text-zinc-700">
                        {state === 'thinking' && <span className="shimmer-text">{p.thinking}</span>}
                        {state !== 'thinking' && (
                          <ul className="space-y-1 font-dock text-[11px] text-zinc-500">
                            {p.trace.slice(0, state === 'done' ? 3 : Math.min(3, step - 2)).map((line, index) => (
                              <motion.li key={line} initial={{ opacity: 0, x: -6 }} animate={{ opacity: 1, x: 0 }} className="flex items-center gap-1.5">
                                {state === 'running' && index === step - 3 ? <LoaderCircle size={11} className="spin shrink-0 text-sky-500" /> : <Check size={11} strokeWidth={3} className="shrink-0 text-emerald-500" />}
                                <span className="truncate">{line}</span>
                              </motion.li>
                            ))}
                          </ul>
                        )}
                        <AnimatePresence>
                          {state === 'done' && (
                            <motion.p initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: 'auto' }} className="mt-2 overflow-hidden text-zinc-800">{p.result}</motion.p>
                          )}
                        </AnimatePresence>
                      </div>
                      <div className="flex items-center justify-between border-t border-black/[.05] px-3 py-2 text-[11px] text-zinc-400 dark:border-white/[.06]">
                        <span className="font-dock tabular-nums">{state === 'done' ? p.elapsed : state === 'running' ? mmss(elapsed) : '00:00'}</span>
                        {state !== 'done' && <span className="rounded-md border border-zinc-300 px-2 py-0.5 text-[11px] text-zinc-600">{p.interrupt}</span>}
                      </div>
                    </div>
                  </div>
                </motion.div>
              )}
              {step >= 7 && (
                <motion.div key="thread" layout initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} className="ml-10 rounded-xl border-l-[3px] border-brand/70 bg-white/80 px-3 py-2 dark:bg-[#202020]">
                  <div className="text-[12.5px] text-zinc-800"><span className="mr-1 rounded bg-brand/15 px-1 font-dock text-[11px] font-semibold text-brand">/btw</span>{p.thread.replace('/btw ', '')}</div>
                  <AnimatePresence>
                    {step >= 8 && (
                      <motion.div initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} className="mt-1.5 flex items-center gap-1.5 text-[12px] text-zinc-500">
                        <KittenAvatar mood="happy" size={18} />{p.threadReply}
                      </motion.div>
                    )}
                  </AnimatePresence>
                </motion.div>
              )}
            </AnimatePresence>
          </div>
          {/* 输入栏 */}
          <div className="flex shrink-0 items-center gap-2 border-t border-black/[.06] bg-white/70 px-3 pb-6 pt-2.5 dark:border-white/[.06] dark:bg-[#1c1c1c]">
            <Mic size={19} className="text-zinc-500" />
            <span className="flex-1 rounded-full bg-[#f2f3f5] px-3 py-1.5 text-[13px] text-zinc-400 dark:bg-[#2a2a2a]">{p.input}</span>
            <Smile size={19} className="text-zinc-500" />
            <Plus size={19} className="text-zinc-500" />
          </div>
        </div>
      </div>
    </div>
  );
}

export function Lark() {
  const { t } = useLang();
  return (
    <section id="lark" className="relative overflow-hidden py-24 sm:py-32">
      <div className="mx-auto grid max-w-[1200px] grid-cols-1 items-center gap-16 px-5 sm:px-8 lg:grid-cols-[minmax(0,1fr)_auto] lg:gap-20">
        <div>
          <SectionHeading align="left" kicker={t.lark.kicker} title={t.lark.title} sub={t.lark.sub} />
          <ul className="mt-10 grid grid-cols-1 gap-x-8 gap-y-6 sm:grid-cols-2">
            {t.lark.features.map((feature, index) => {
              const Icon = FEATURE_ICONS[index];
              return (
                <Reveal as="li" key={feature.title} delay={index * 0.05} className="flex gap-3.5">
                  <span className="grid h-9 w-9 shrink-0 place-items-center rounded-xl border border-line bg-card text-brand"><Icon size={17} /></span>
                  <div>
                    <h3 className="font-display text-[16px] font-semibold text-zinc-900">{feature.title}</h3>
                    <p className="mt-1 text-[14px] leading-[1.7] text-zinc-500"><Rich text={feature.body} /></p>
                  </div>
                </Reveal>
              );
            })}
          </ul>
        </div>
        <Reveal y={40} className="lg:pr-6">
          <Phone />
        </Reveal>
      </div>
    </section>
  );
}
