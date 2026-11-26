import { useState } from 'react';
import { motion } from 'motion/react';
import { ArrowUpRight, BookOpen } from 'lucide-react';
import { useLang } from '../lib/i18n';
import { Reveal, Rich, SectionHeading } from './ui';
import { CodeBlock } from './CodeBlock';

export function Docs() {
  const { t } = useLang();
  const d = t.docs;
  const [tab, setTab] = useState(0);
  const current = d.tabs[tab];
  return (
    <section id="docs" className="relative py-24 sm:py-32">
      <div className="mx-auto max-w-[1200px] px-5 sm:px-8">
        <SectionHeading kicker={d.kicker} title={d.title} sub={d.sub} />

        <Reveal className="mx-auto mt-12 max-w-[920px]" y={24}>
          <div className="no-scrollbar -mx-5 overflow-x-auto px-5 sm:mx-0 sm:px-0">
            <div role="tablist" aria-label={d.title} className="mx-auto flex w-max gap-1 rounded-full border border-line bg-card p-1">
              {d.tabs.map((item, index) => (
                <button key={item.id} type="button" role="tab" aria-selected={index === tab} onClick={() => setTab(index)} className={`relative h-9 shrink-0 rounded-full px-3 font-dock text-[12.5px] transition-colors sm:px-4 sm:text-[13px] ${index === tab ? 'text-zinc-900' : 'text-zinc-500 hover:text-zinc-800'}`}>
                  {index === tab && <motion.span layoutId="docs-tab" className="absolute inset-0 rounded-full bg-zinc-900/[.07]" transition={{ type: 'spring', stiffness: 420, damping: 36 }} />}
                  <span className="relative sm:hidden">{item.short}</span><span className="relative hidden sm:inline">{item.label}</span>
                </button>
              ))}
            </div>
          </div>
          <motion.div key={current.id} initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.25 }}>
            <CodeBlock lines={current.code} prompt={current.id !== 'api'} title={current.id === 'api' ? 'http://127.0.0.1:4310' : 'agent-dock --help'} className="mt-5" />
          </motion.div>
        </Reveal>

        <div className="mt-14 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {d.cards.map((card, index) => (
            <Reveal key={card.title} delay={index * 0.04} y={16}>
              <a href={card.href} target="_blank" rel="noreferrer noopener" className="card group flex h-full items-start gap-3.5 rounded-2xl p-5 transition-[border-color,transform] duration-300 hover:-translate-y-0.5 hover:border-zinc-300">
                <span className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-zinc-900/[.05] text-zinc-600 transition-colors group-hover:bg-brand/15 group-hover:text-brand"><BookOpen size={16} /></span>
                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-1 font-display text-[16px] font-semibold text-zinc-900">{card.title}<ArrowUpRight size={14} className="text-zinc-400 transition-transform group-hover:-translate-y-px group-hover:translate-x-px group-hover:text-zinc-900" /></span>
                  <span className="mt-1 block text-[13.5px] leading-[1.7] text-zinc-500"><Rich text={card.body} /></span>
                </span>
              </a>
            </Reveal>
          ))}
        </div>
      </div>
    </section>
  );
}
