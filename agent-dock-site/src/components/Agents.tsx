import { Cable, ListChecks, Plug, ShieldCheck } from 'lucide-react';
import { useLang } from '../lib/i18n';
import { AGENTS, AGENT_ROWS } from '../lib/agents';
import { AgentIcon, Reveal, Rich, SectionHeading } from './ui';

const POINT_ICONS = [Cable, ListChecks, Plug, ShieldCheck];

function Row({ ids, direction, duration }: { ids: string[]; direction: 'left' | 'right'; duration: number }) {
  const items = [...ids, ...ids];
  return (
    <div className="marquee fade-mask-x overflow-hidden py-1.5">
      <div className={`flex w-max gap-3 ${direction === 'left' ? 'marquee-left' : 'marquee-right'}`} style={{ ['--dur' as string]: `${duration}s` }}>
        {items.map((id, index) => (
          <div key={`${id}-${index}`} aria-hidden={index >= ids.length} className="flex h-14 shrink-0 items-center gap-3 rounded-2xl border border-line bg-card px-4 transition-colors hover:border-zinc-300">
            <AgentIcon id={id} size={24} />
            <span className="whitespace-nowrap font-dock text-[14px] text-zinc-800">{AGENTS[id].name}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

export function Agents() {
  const { t } = useLang();
  return (
    <section id="agents" className="relative py-24 sm:py-32">
      <div className="mx-auto max-w-[1200px] px-5 sm:px-8">
        <SectionHeading kicker={t.agents.kicker} title={t.agents.title} sub={t.agents.sub} />
      </div>
      <Reveal className="mt-14 flex flex-col gap-1.5" y={16}>
        <Row ids={AGENT_ROWS[0]} direction="left" duration={56} />
        <Row ids={AGENT_ROWS[1]} direction="right" duration={62} />
        <div className="mt-3 flex justify-center px-5">
          <span className="rounded-full border border-dashed border-zinc-300 px-4 py-1.5 font-dock text-[12.5px] text-zinc-500">{t.agents.more}</span>
        </div>
      </Reveal>
      <div className="mx-auto mt-16 grid max-w-[1200px] gap-px overflow-hidden px-5 sm:grid-cols-2 sm:px-8 lg:grid-cols-4">
        {t.agents.points.map((point, index) => {
          const Icon = POINT_ICONS[index];
          return (
            <Reveal key={point.title} delay={index * 0.06} className="border-line py-6 sm:px-6 sm:first:pl-0 lg:border-l lg:first:border-l-0">
              <Icon size={18} className="text-brand" />
              <h3 className="mt-4 font-display text-[17px] font-semibold tracking-[-0.01em] text-zinc-900">{point.title}</h3>
              <p className="mt-2 text-[14.5px] leading-[1.75] text-zinc-500"><Rich text={point.body} /></p>
            </Reveal>
          );
        })}
      </div>
    </section>
  );
}
