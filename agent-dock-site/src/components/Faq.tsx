import { useId, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { Plus } from 'lucide-react';
import { useLang } from '../lib/i18n';
import { Kitten, Reveal, Rich, SectionHeading } from './ui';

function Item({ q, a, open, onToggle }: { q: string; a: string; open: boolean; onToggle: () => void }) {
  const id = useId();
  return (
    <div className="border-b border-line">
      <h3>
        <button type="button" aria-expanded={open} aria-controls={id} onClick={onToggle} className="flex w-full items-center gap-4 py-5 text-left">
          <span className="flex-1 font-display text-[16.5px] font-semibold leading-[1.5] text-zinc-900 sm:text-[17.5px]">{q}</span>
          <motion.span animate={{ rotate: open ? 45 : 0 }} transition={{ duration: 0.25 }} className={`grid h-8 w-8 shrink-0 place-items-center rounded-full transition-colors ${open ? 'bg-zinc-900 text-white' : 'bg-zinc-900/[.05] text-zinc-600'}`}>
            <Plus size={15} />
          </motion.span>
        </button>
      </h3>
      <AnimatePresence initial={false}>
        {open && (
          <motion.div id={id} role="region" initial={{ height: 0, opacity: 0 }} animate={{ height: 'auto', opacity: 1 }} exit={{ height: 0, opacity: 0 }} transition={{ duration: 0.3, ease: [0.2, 0, 0, 1] }} className="overflow-hidden">
            <p className="pb-6 text-[15px] leading-[1.85] text-zinc-500 sm:pr-12"><Rich text={a} /></p>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

export function Faq() {
  const { t } = useLang();
  const [open, setOpen] = useState(0);
  return (
    <section id="faq" className="relative bg-page-soft py-24 sm:py-32">
      <div aria-hidden="true" className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-zinc-300 to-transparent" />
      <div className="mx-auto grid max-w-[1200px] grid-cols-1 gap-12 px-5 sm:px-8 lg:grid-cols-[minmax(0,0.8fr)_minmax(0,1.2fr)] lg:gap-20">
        <div className="lg:sticky lg:top-28 lg:self-start">
          <SectionHeading align="left" kicker={t.faq.kicker} title={t.faq.title} />
          <Reveal delay={0.1} className="mt-8 hidden lg:block"><Kitten mood="curious" size={120} /></Reveal>
        </div>
        <Reveal y={20}>
          <div className="border-t border-line">
            {t.faq.items.map((item, index) => (
              <Item key={item.q} q={item.q} a={item.a} open={open === index} onToggle={() => setOpen(open === index ? -1 : index)} />
            ))}
          </div>
        </Reveal>
      </div>
    </section>
  );
}
