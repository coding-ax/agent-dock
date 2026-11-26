import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { ArrowRight, Check, FileAudio, FileText, Film, Image as ImageIcon, Link2, LoaderCircle, Play, Quote, Repeat, ShieldAlert, Smartphone, Wifi } from 'lucide-react';
import { useLang } from '../lib/i18n';
import { Kitten, KittenMark, Reveal, Rich, SectionHeading, useInViewport, useTicker } from './ui';

function Card({ title, body, children, className = '', delay = 0 }: { title: string; body: string; children: ReactNode; className?: string; delay?: number }) {
  return (
    <Reveal delay={delay} className={`card group relative flex flex-col overflow-hidden rounded-[24px] transition-[border-color,transform] duration-300 hover:-translate-y-0.5 hover:border-zinc-300 ${className}`}>
      <div className="relative h-[228px] overflow-hidden border-b border-line bg-page-soft sm:h-[244px]">
        <div aria-hidden="true" className="dot-grid absolute inset-0 opacity-60" />
        <div className="relative h-full">{children}</div>
      </div>
      <div className="p-6">
        <h3 className="font-display text-[18px] font-semibold tracking-[-0.015em] text-zinc-900">{title}</h3>
        <p className="mt-2 text-[14.5px] leading-[1.75] text-zinc-500"><Rich text={body} /></p>
      </div>
    </Reveal>
  );
}

/** 第一次进入视口后就保持展示：滚回来不再重播，整页截图也能看到完整内容。 */
function useSeen(visible: boolean) {
  const [seen, setSeen] = useState(false);
  useEffect(() => { if (visible) setSeen(true); }, [visible]);
  return seen;
}

/* ---------- 产物预览 ---------- */

const FILES = [
  { name: 'screenshots/login.png', icon: ImageIcon, kind: 'image' },
  { name: 'artifacts/demo.mp4', icon: Film, kind: 'video' },
  { name: 'artifacts/standup.m4a', icon: FileAudio, kind: 'audio' },
  { name: 'RELEASE.md', icon: FileText, kind: 'markdown' }
] as const;
const CYCLE = [2300, 2300, 2300, 2300];

function ArtifactsVisual() {
  const [ref, visible] = useInViewport<HTMLDivElement>();
  const [index] = useTicker(CYCLE, visible);
  const file = FILES[index];
  const bars = useMemo(() => Array.from({ length: 36 }, (_, i) => 0.25 + Math.abs(Math.sin(i * 1.7) * 0.75)), []);
  return (
    <div ref={ref} className="absolute inset-4 flex overflow-hidden rounded-2xl border border-zinc-200 bg-white font-dock shadow-[0_12px_30px_-14px_rgb(0_0_0/.25)] sm:inset-5">
      <ul className="hidden w-[188px] shrink-0 flex-col gap-0.5 border-r border-zinc-200 bg-rail p-2 sm:flex">
        {FILES.map((item, i) => (
          <li key={item.name} className={`flex items-center gap-1.5 rounded-md px-2 py-1.5 text-[11px] ${i === index ? 'bg-zinc-900/[.07] text-zinc-900' : 'text-zinc-500'}`}>
            <item.icon size={12} className="shrink-0" /><span className="truncate">{item.name}</span>
          </li>
        ))}
      </ul>
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex h-8 shrink-0 items-center gap-1.5 border-b border-zinc-200 px-3 text-[10.5px] text-zinc-500">
          <file.icon size={11} /><span className="truncate">{file.name}</span>
        </div>
        <div className="relative min-h-0 flex-1 bg-canvas">
          <AnimatePresence initial={false}>
            <motion.div key={file.kind} initial={{ opacity: 0, scale: 0.98 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.35 }} className="absolute inset-0 grid place-items-center p-3">
              {file.kind === 'image' && (
                <div className="grid h-full w-full place-items-center rounded-lg bg-gradient-to-br from-[#fde6cf] via-[#f6d3c4] to-[#e9c6d8]">
                  <div className="rounded-xl bg-[#ffffff] p-2.5 shadow-lg"><KittenMark size={34} /></div>
                </div>
              )}
              {file.kind === 'video' && (
                <div className="relative h-full w-full overflow-hidden rounded-lg bg-[#0d0d0d]">
                  <div className="absolute inset-0 grid place-items-center"><span className="grid h-10 w-10 place-items-center rounded-full bg-[#ffffff]/90 text-[#0d0d0d]"><Play size={16} fill="currentColor" className="translate-x-px" /></span></div>
                  <div className="absolute inset-x-3 bottom-2.5 h-1 overflow-hidden rounded-full bg-[#ffffff]/25"><motion.div className="h-full bg-[#ffffff]" initial={{ width: '6%' }} animate={{ width: '64%' }} transition={{ duration: 2.2, ease: 'linear' }} /></div>
                  <span className="absolute right-2 top-2 rounded bg-black/60 px-1.5 text-[9px] text-[#ffffff]">Range</span>
                </div>
              )}
              {file.kind === 'audio' && (
                <div className="flex w-full items-center gap-2 rounded-xl bg-white px-3 py-3 ring-1 ring-zinc-200">
                  <span className="grid h-7 w-7 shrink-0 place-items-center rounded-full bg-zinc-900 text-white"><Play size={11} fill="currentColor" /></span>
                  <div className="flex h-8 flex-1 items-center gap-[2px]">
                    {bars.map((height, i) => (
                      <motion.span key={i} className="w-full rounded-full bg-zinc-300" initial={{ scaleY: 0.3 }} animate={{ scaleY: [height * 0.5, height, height * 0.6], backgroundColor: i < 14 ? 'rgb(var(--brand))' : 'rgb(var(--zinc-300))' }} transition={{ duration: 1.2, repeat: Infinity, delay: i * 0.03 }} style={{ height: '100%', transformOrigin: 'center' }} />
                    ))}
                  </div>
                  <span className="text-[10px] tabular-nums text-zinc-400">00:14</span>
                </div>
              )}
              {file.kind === 'markdown' && (
                <div className="w-full self-start px-1 pt-1 text-left font-sans">
                  <div className="text-[14px] font-semibold text-zinc-900">v0.4 · Release notes</div>
                  <ul className="mt-2 space-y-1.5 text-[11.5px] text-zinc-600">
                    {['Schedules follow the main kitten', 'Range streaming for media', 'Lark /btw thread side chat'].map(item => (
                      <li key={item} className="flex items-center gap-1.5"><Check size={11} strokeWidth={3} className="text-emerald-500" />{item}</li>
                    ))}
                  </ul>
                </div>
              )}
            </motion.div>
          </AnimatePresence>
        </div>
      </div>
    </div>
  );
}

/* ---------- 行号定位 ---------- */

const LINES = [
  'export function isExpired(session: Session) {',
  '  // 用 UTC 比较，避免跨零点误判',
  '  const now = Date.now();',
  '  const expires = Date.parse(session.expiresAt);',
  '  if (Number.isNaN(expires)) return true;',
  '  return now >= expires - SKEW_MS;',
  '}'
];

function LinesVisual() {
  const [ref, inView] = useInViewport<HTMLDivElement>();
  const visible = useSeen(inView);
  return (
    <div ref={ref} className="absolute inset-4 flex flex-col gap-3 font-dock sm:inset-5">
      <span className="inline-flex max-w-full items-center gap-1.5 self-start truncate rounded-lg bg-white px-2.5 py-1.5 text-[11.5px] text-link shadow-sm ring-1 ring-zinc-200">
        <Link2 size={12} className="shrink-0" /><span className="truncate underline decoration-link/30 underline-offset-2">src/auth/session.ts#L88-L93</span>
      </span>
      <div className="min-h-0 flex-1 overflow-hidden rounded-xl border border-zinc-200 bg-white py-1.5 text-[10.5px] leading-[19px]">
        {LINES.map((line, index) => {
          const number = 87 + index;
          const lit = number >= 88 && number <= 93;
          return (
            <motion.div key={number} className="flex whitespace-pre pr-2" animate={{ backgroundColor: visible && lit ? 'rgb(var(--brand) / .11)' : 'rgba(0,0,0,0)', boxShadow: visible && lit ? 'inset 2px 0 0 rgb(var(--brand))' : 'inset 0 0 0 transparent' }} transition={{ delay: visible ? 0.4 + index * 0.06 : 0, duration: 0.35 }}>
              <span className="w-8 shrink-0 select-none pr-2 text-right text-zinc-400">{number}</span>
              <span className={`truncate ${line.trim().startsWith('//') ? 'text-zinc-400' : 'text-zinc-700'}`}>{line}</span>
            </motion.div>
          );
        })}
      </div>
    </div>
  );
}

/* ---------- 划词引用 ---------- */

const QUOTE_STEPS = [900, 900, 1000, 2600];

function QuoteVisual() {
  const { lang, t } = useLang();
  const [ref, visible] = useInViewport<HTMLDivElement>();
  const [step] = useTicker(QUOTE_STEPS, visible);
  const phrase = lang === 'zh' ? '会话过期判断改用 UTC' : 'expiry checks now use UTC';
  const before = lang === 'zh' ? '修好了：' : 'Fixed: ';
  const after = lang === 'zh' ? '，并补了跨零点的测试。' : ', with a test across midnight.';
  return (
    <div ref={ref} className="absolute inset-4 flex flex-col justify-between font-dock sm:inset-5">
      <p className="relative mt-8 text-[12.5px] leading-[1.8] text-zinc-700">
        {before}
        <span className="relative">
          <span className={`rounded-sm transition-colors duration-500 ${step >= 1 ? 'bg-link/25' : ''}`}>{phrase}</span>
          <AnimatePresence>
            {step >= 1 && step < 3 && (
              <motion.span initial={{ opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0, scale: step === 2 ? 0.94 : 1 }} exit={{ opacity: 0 }} className="absolute -top-8 left-1/2 flex -translate-x-1/2 items-center gap-1 whitespace-nowrap rounded-lg bg-zinc-900 px-2 py-1 text-[11px] font-medium text-white shadow-lg">
                <Quote size={10} />{t.features.labels.quote}
              </motion.span>
            )}
          </AnimatePresence>
        </span>
        {after}
      </p>
      <div className="rounded-2xl border border-zinc-200 bg-white p-2 shadow-sm">
        <AnimatePresence>
          {step >= 3 && (
            <motion.div initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: 'auto' }} exit={{ opacity: 0, height: 0 }} className="overflow-hidden">
              <div className="mb-1.5 rounded-r-lg border-l-[2.5px] border-zinc-400 bg-zinc-900/[.045] px-2 py-1 text-[11px] text-zinc-600">{phrase}</div>
            </motion.div>
          )}
        </AnimatePresence>
        <div className="flex items-center justify-between px-1 text-[11.5px] text-zinc-400">
          <span>{step >= 3 ? (lang === 'zh' ? '时区配置也要改吗？' : 'Should the TZ config change too?') : '…'}</span>
          <span className="grid h-6 w-6 place-items-center rounded-full bg-zinc-900 text-white"><ArrowRight size={11} className="-rotate-90" /></span>
        </div>
      </div>
    </div>
  );
}

/* ---------- 定时任务 ---------- */

const SCHEDULE_STEPS = [1400, 1400, 2600];

function ScheduleVisual() {
  const { t } = useLang();
  const l = t.features.labels;
  const [ref, visible] = useInViewport<HTMLDivElement>();
  const [step] = useTicker(SCHEDULE_STEPS, visible);
  const moved = step >= 1;
  return (
    <div ref={ref} className="absolute inset-4 flex flex-col justify-center gap-4 font-dock sm:inset-5">
      <div className="flex items-end justify-around">
        {[1, 2].map(gen => (
          <div key={gen} className={`flex flex-col items-center gap-1.5 transition-opacity duration-500 ${gen === 1 && moved ? 'opacity-45' : ''}`}>
            <Kitten mood={gen === 1 ? 'sleepy' : moved ? 'happy' : 'idle'} size={gen === 1 ? 64 : 76} className={gen === 2 && !moved ? 'opacity-40 grayscale' : ''} />
            <span className="rounded-full bg-zinc-900/[.06] px-2 py-0.5 text-[10.5px] text-zinc-600">{l.gen(gen)}</span>
          </div>
        ))}
      </div>
      <div className="relative h-11">
        <span aria-hidden="true" className="absolute left-[18%] right-[18%] top-1/2 border-t border-dashed border-zinc-300" />
        <motion.div
          className="absolute top-0 flex h-11 items-center gap-2 rounded-xl border border-zinc-200 bg-white px-3 text-[11.5px] shadow-[0_8px_20px_-10px_rgb(0_0_0/.3)]"
          initial={false}
          animate={{ left: moved ? '96%' : '4%', x: moved ? '-100%' : '0%' }}
          transition={{ type: 'spring', stiffness: 120, damping: 18 }}
        >
          <Repeat size={12} className="text-brand" />
          <span className="whitespace-nowrap font-semibold text-zinc-800">{l.daily}</span>
          <span className="hidden whitespace-nowrap text-zinc-400 sm:inline">0 9 * * 1-5</span>
          <span className="whitespace-nowrap rounded-full bg-brand/10 px-1.5 text-[10px] text-brand">{l.follow}</span>
        </motion.div>
      </div>
    </div>
  );
}

/* ---------- 排队 / 插队 ---------- */

const QUEUE_STEPS = [1500, 1200, 2200];

function QueueVisual() {
  const { t, lang } = useLang();
  const l = t.features.labels;
  const [ref, visible] = useInViewport<HTMLDivElement>();
  const [step] = useTicker(QUEUE_STEPS, visible);
  const items = lang === 'zh' ? ['跑一遍完整测试', '把截图发到飞书群', '顺便更新 CHANGELOG'] : ['Run the full test suite', 'Post screenshots to Lark', 'Update the CHANGELOG'];
  const order = step >= 2 ? [0, 2, 1] : [0, 1, 2];
  return (
    <div ref={ref} className="absolute inset-4 flex flex-col justify-center gap-2 font-dock sm:inset-5">
      {order.map((itemIndex, position) => (
        <motion.div key={itemIndex} layout transition={{ type: 'spring', stiffness: 300, damping: 26 }} className={`flex items-center gap-2 rounded-xl border bg-white px-3 py-2.5 text-[11.5px] ${position === 0 ? 'border-zinc-300' : 'border-zinc-200'}`}>
          {position === 0 ? <LoaderCircle size={12} className="spin shrink-0 text-link" /> : <span className="w-3 shrink-0 text-center text-[10px] text-zinc-400">{position + 1}</span>}
          <span className="min-w-0 flex-1 truncate text-zinc-700">{items[itemIndex]}</span>
          {position === 0 ? <span className="shrink-0 text-[10px] text-link">{l.running}</span> : itemIndex === 2 && step === 1 ? (
            <motion.span initial={{ scale: 0.9 }} animate={{ scale: [1, 0.94, 1] }} transition={{ repeat: Infinity, duration: 0.9 }} className="shrink-0 rounded-md bg-zinc-900 px-1.5 py-0.5 text-[10px] text-white">{l.steer}</motion.span>
          ) : <span className="shrink-0 rounded-md bg-zinc-900/[.05] px-1.5 py-0.5 text-[10px] text-zinc-500">{l.queued}</span>}
        </motion.div>
      ))}
    </div>
  );
}

/* ---------- 手机扫码 ---------- */

function QrVisual() {
  const { t } = useLang();
  const cells = useMemo(() => {
    const size = 21;
    const grid: boolean[] = [];
    let seed = 42;
    const finder = (x: number, y: number) => {
      const inBox = (ox: number, oy: number) => x >= ox && x < ox + 7 && y >= oy && y < oy + 7;
      for (const [ox, oy] of [[0, 0], [14, 0], [0, 14]]) {
        if (inBox(ox, oy)) {
          const dx = x - ox; const dy = y - oy;
          return dx === 0 || dx === 6 || dy === 0 || dy === 6 || (dx >= 2 && dx <= 4 && dy >= 2 && dy <= 4);
        }
        if (x >= ox - 1 && x <= ox + 7 && y >= oy - 1 && y <= oy + 7) return false;
      }
      return null;
    };
    for (let y = 0; y < size; y += 1) for (let x = 0; x < size; x += 1) {
      const fixed = finder(x, y);
      seed = (seed * 9301 + 49297) % 233280;
      grid.push(fixed ?? seed / 233280 > 0.52);
    }
    return grid;
  }, []);
  return (
    <div className="absolute inset-0 flex items-center justify-center gap-6 font-dock">
      <div className="rounded-2xl bg-[#ffffff] p-3 shadow-[0_12px_30px_-12px_rgb(0_0_0/.3)] ring-1 ring-black/5">
        <svg viewBox="0 0 21 21" width="112" height="112" shapeRendering="crispEdges" aria-hidden="true">
          {cells.map((on, i) => on ? <rect key={i} x={i % 21} y={Math.floor(i / 21)} width="1" height="1" fill="#0d0d0d" /> : null)}
        </svg>
      </div>
      <div className="flex flex-col items-start gap-2">
        <span className="grid h-[86px] w-[46px] place-items-center rounded-[12px] border-2 border-zinc-400"><Smartphone size={18} className="text-zinc-400" /></span>
        <span className="flex items-center gap-1 text-[10.5px] text-zinc-500"><Wifi size={11} />{t.features.labels.lan}</span>
      </div>
    </div>
  );
}

/* ---------- 门禁 ---------- */

function GuardVisual() {
  const { t, lang } = useLang();
  const l = t.features.labels;
  return (
    <div className="absolute inset-4 flex flex-col justify-center gap-2.5 font-dock sm:inset-5">
      <div className="rounded-xl border border-zinc-200 bg-white px-3 py-2 text-[11px] text-zinc-700"><span className="text-zinc-400">regex </span>{'(?:sudo|rm|git\\s+push)\\b'}</div>
      <motion.div initial={{ opacity: 0, y: 8 }} whileInView={{ opacity: 1, y: 0 }} viewport={{ once: true }} transition={{ delay: 0.3 }} className="rounded-xl border border-red-200 bg-red-50 px-3 py-2">
        <div className="flex items-center gap-1.5 text-[11.5px] text-zinc-800"><ShieldAlert size={13} className="text-red-500" /><span className="truncate">rm -rf ./dist</span></div>
        <div className="mt-0.5 text-[10.5px] text-zinc-500">{l.blocked}</div>
      </motion.div>
      <div className="flex flex-wrap items-center gap-1.5 text-[10.5px]">
        <span className="text-zinc-400">{l.allowed}</span>
        {(lang === 'zh' ? ['张三', '李四'] : ['Alice', 'Bob']).map(name => <span key={name} className="rounded-full bg-white px-2 py-0.5 text-zinc-600 ring-1 ring-zinc-200">{name}</span>)}
      </div>
    </div>
  );
}

/* ---------- HTTP + SSE ---------- */

function ApiVisual() {
  const { lang } = useLang();
  const [ref, inView] = useInViewport<HTMLDivElement>();
  const visible = useSeen(inView);
  const lines: Array<[string, string]> = [
    ['$ curl -X POST :4310/api/sessions/ses_42/send \\', 'text-[#e8e6dc]'],
    [`    -d '{"prompt":"${lang === 'zh' ? '检查当前工作区并给出结论' : 'Review this workspace'}","mode":"queue"}'`, 'text-[#e8e6dc]'],
    ['HTTP/1.1 202 Accepted', 'text-[#98c379]'],
    ['$ curl -N :4310/api/sessions/ses_42/stream?after=41', 'text-[#e8e6dc]'],
    ['id: 42', 'text-[#9b9b9b]'],
    ['event: text', 'text-[#f2a24a]'],
    [`data: {"sequence":42,"type":"text","data":{"text":"${lang === 'zh' ? '结果' : 'Result'}"}}`, 'text-[#9b9b9b]']
  ];
  return (
    <div ref={ref} className="absolute inset-4 overflow-hidden rounded-2xl bg-[#141414] font-dock shadow-[0_16px_40px_-16px_rgb(0_0_0/.5)] ring-1 ring-black/10 sm:inset-5 dark:ring-white/10">
      <div className="flex h-7 items-center gap-1.5 border-b border-[#ffffff]/10 px-3">
        <span className="h-2.5 w-2.5 rounded-full bg-[#ff5f57]" /><span className="h-2.5 w-2.5 rounded-full bg-[#febc2e]" /><span className="h-2.5 w-2.5 rounded-full bg-[#28c840]" />
      </div>
      <div className="px-3.5 py-3 text-[10.5px] leading-[19px] sm:text-[11px]">
        {lines.map(([text, cls], index) => (
          <motion.div key={index} className={`truncate ${cls}`} initial={{ opacity: 0 }} animate={{ opacity: visible ? 1 : 0 }} transition={{ delay: visible ? 0.2 + index * 0.28 : 0, duration: 0.25 }}>{text}</motion.div>
        ))}
      </div>
    </div>
  );
}

/* ---------- 递归自我改进 ---------- */

function RsiVisual() {
  const { lang } = useLang();
  const lines: Array<[string, string]> = [
    ['$ agent-dock dev up', 'text-[#e8e6dc]'],
    [lang === 'zh' ? '# 独立 HOME、数据库和端口' : '# separate HOME, database and port', 'text-[#7f7f7f]'],
    ['# → http://127.0.0.1:4399', 'text-[#7f7f7f]'],
    ['$ pnpm test && pnpm typecheck', 'text-[#e8e6dc]'],
    ['$ agent-dock dev down', 'text-[#e8e6dc]']
  ];
  return (
    <div className="absolute inset-4 flex items-end gap-2 sm:inset-5">
      <div className="min-w-0 flex-1 overflow-hidden rounded-2xl bg-[#141414] px-3.5 py-3 font-dock text-[10.5px] leading-[19px] shadow-[0_16px_40px_-16px_rgb(0_0_0/.5)] ring-1 ring-black/10 dark:ring-white/10">
        {lines.map(([text, cls], index) => (
          <motion.div key={index} className={`truncate ${cls}`} initial={{ opacity: 0, x: -6 }} whileInView={{ opacity: 1, x: 0 }} viewport={{ once: true }} transition={{ delay: 0.2 + index * 0.25 }}>{text}</motion.div>
        ))}
        <div className="mt-1 flex items-center gap-1 text-[#98c379]"><Check size={11} strokeWidth={3} />{lang === 'zh' ? '正式 daemon 不受影响' : 'production daemon untouched'}</div>
      </div>
      <Kitten mood="busy" size={74} className="-mb-1 shrink-0" />
    </div>
  );
}

export function Features() {
  const { t } = useLang();
  const c = t.features.cards;
  return (
    <section id="features" className="relative bg-page-soft py-24 sm:py-32">
      <div aria-hidden="true" className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-zinc-300 to-transparent" />
      <div className="mx-auto max-w-[1200px] px-5 sm:px-8">
        <SectionHeading kicker={t.features.kicker} title={t.features.title} sub={t.features.sub} />
        <div className="mt-14 grid grid-cols-1 gap-4 sm:mt-16 md:grid-cols-2 lg:grid-cols-3">
          <Card title={c.artifacts.title} body={c.artifacts.body} className="md:col-span-2"><ArtifactsVisual /></Card>
          <Card title={c.lines.title} body={c.lines.body} delay={0.05}><LinesVisual /></Card>
          <Card title={c.quote.title} body={c.quote.body}><QuoteVisual /></Card>
          <Card title={c.schedule.title} body={c.schedule.body} className="md:col-span-2" delay={0.05}><ScheduleVisual /></Card>
          <Card title={c.queue.title} body={c.queue.body}><QueueVisual /></Card>
          <Card title={c.mobile.title} body={c.mobile.body} delay={0.05}><QrVisual /></Card>
          <Card title={c.guard.title} body={c.guard.body} className="md:col-span-2 lg:col-span-1" delay={0.1}><GuardVisual /></Card>
          <Card title={c.api.title} body={c.api.body} className="md:col-span-2"><ApiVisual /></Card>
          <Card title={c.rsi.title} body={c.rsi.body} className="md:col-span-2 lg:col-span-1" delay={0.05}><RsiVisual /></Card>
        </div>
      </div>
    </section>
  );
}

