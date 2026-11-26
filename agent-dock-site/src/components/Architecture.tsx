import { CalendarClock, Database, Globe, MessageSquare, MonitorSmartphone, ShieldAlert } from 'lucide-react';
import { useLang } from '../lib/i18n';
import { AgentIcon, Kitten, Reveal, Rich, SectionHeading } from './ui';

const INPUT_ICONS = [MessageSquare, MonitorSmartphone, Globe, CalendarClock];
const OUTPUT_IDS = ['claude', 'codex', 'gemini', 'cursor', null] as const;

/** 左右两侧的连线：n 个端点汇聚到中间一点，虚线流动表示数据方向。 */
function Connector({ count, direction }: { count: number; direction: 'in' | 'out' }) {
  const paths = Array.from({ length: count }, (_, index) => {
    const y = ((index + 0.5) / count) * 100;
    return direction === 'in' ? `M0 ${y} C 55 ${y}, 45 50, 100 50` : `M0 50 C 55 50, 45 ${y}, 100 ${y}`;
  });
  return (
    <svg className="hidden h-full w-full lg:block" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
      {paths.map(d => <path key={d} d={d} fill="none" stroke="rgb(var(--zinc-300))" strokeWidth="1.2" vectorEffect="non-scaling-stroke" />)}
      {paths.map((d, index) => <path key={`f-${d}`} d={d} fill="none" stroke="rgb(var(--brand))" strokeWidth="1.6" vectorEffect="non-scaling-stroke" className="flow-dash" style={{ animationDelay: `${index * -0.27}s` }} />)}
    </svg>
  );
}

function VerticalFlow() {
  return (
    <div className="flex justify-center lg:hidden" aria-hidden="true">
      <svg width="12" height="44" viewBox="0 0 12 44"><path d="M6 0v44" stroke="rgb(var(--brand))" strokeWidth="1.6" className="flow-dash" fill="none" /></svg>
    </div>
  );
}

export function Architecture() {
  const { t } = useLang();
  const a = t.arch;
  return (
    <section id="how" className="relative py-24 sm:py-32">
      <div className="mx-auto max-w-[1200px] px-5 sm:px-8">
        <SectionHeading kicker={a.kicker} title={a.title} sub={a.sub} />

        <Reveal className="mt-16 grid items-stretch gap-0 lg:grid-cols-[minmax(0,1fr)_72px_minmax(0,1.35fr)_72px_minmax(0,1fr)]" y={30}>
          {/* 入口 */}
          <div className="grid grid-cols-2 gap-2.5 lg:grid-cols-1 lg:grid-rows-4 lg:gap-3 lg:py-6">
            {a.inputs.map((input, index) => {
              const Icon = INPUT_ICONS[index];
              return (
                <div key={input} className="card flex items-center gap-2.5 rounded-2xl px-4 py-3.5 font-dock text-[13px] text-zinc-800">
                  <Icon size={16} className="shrink-0 text-zinc-500" />{input}
                </div>
              );
            })}
          </div>
          <VerticalFlow />
          <Connector count={4} direction="in" />

          {/* 核心 */}
          <div className="relative overflow-hidden rounded-[26px] border border-zinc-300/70 bg-card p-5 shadow-[0_24px_60px_-30px_rgb(var(--glow)/.5)] sm:p-6">
            <div aria-hidden="true" className="absolute -right-10 -top-16 h-48 w-48 rounded-full bg-[radial-gradient(closest-side,rgb(var(--glow)/.22),transparent)]" />
            <div className="relative flex items-center gap-3">
              <img src="/brand/app-icon.svg" alt="" className="h-9 w-9 rounded-[10px]" />
              <div className="min-w-0 flex-1">
                <div className="font-display text-[17px] font-semibold text-zinc-900">{a.core}</div>
                <div className="font-dock text-[11.5px] text-zinc-500">@agent-dock/cli</div>
              </div>
              <Kitten mood="idle" size={54} className="-my-2 shrink-0" />
            </div>
            <div className="relative mt-5 grid grid-cols-2 gap-2">
              {a.coreItems.map(item => (
                <div key={item} className="rounded-xl bg-zinc-900/[.04] px-3 py-2.5 font-dock text-[12px] text-zinc-700">{item}</div>
              ))}
            </div>
            <div className="relative mt-3 flex items-center gap-2 rounded-xl border border-dashed border-zinc-300 px-3 py-2.5 font-dock text-[12px] text-zinc-600">
              <Database size={14} className="shrink-0 text-brand" />{a.store}
            </div>
            <div className="relative mt-3 flex items-center justify-between rounded-xl bg-zinc-900 px-3.5 py-2.5 font-dock text-[12.5px] text-white">
              <span className="font-semibold">{a.runtime}</span>
              <span className="text-[11px] opacity-70">ACP · stdio</span>
            </div>
          </div>

          <VerticalFlow />
          <Connector count={5} direction="out" />
          {/* Agent */}
          <div className="flex flex-wrap justify-center gap-2.5 lg:grid lg:grid-rows-5 lg:gap-2.5 lg:py-4">
            {a.outputs.map((name, index) => {
              const id = OUTPUT_IDS[index];
              return (
                <div key={name} className={`flex items-center gap-2.5 rounded-2xl px-4 py-3 font-dock text-[13px] ${id ? 'card text-zinc-800' : 'border border-dashed border-zinc-300 text-zinc-500'}`}>
                  {id ? <AgentIcon id={id} size={17} /> : <span className="w-[17px] text-center">+</span>}{name}
                </div>
              );
            })}
          </div>
        </Reveal>

        <Reveal className="mx-auto mt-12 flex max-w-3xl gap-3 rounded-2xl border border-amber-200 bg-amber-50 px-5 py-4 text-[14px] leading-[1.75] text-zinc-700" y={16}>
          <ShieldAlert size={18} className="mt-0.5 shrink-0 text-amber-600 dark:text-amber-300" />
          <p><Rich text={a.warn} /></p>
        </Reveal>
      </div>
    </section>
  );
}
