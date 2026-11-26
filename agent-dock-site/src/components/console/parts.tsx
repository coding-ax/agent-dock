import { useEffect, useState, type ReactNode } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import {
  AlarmClock, ArrowUp, BookOpen, Check, ChevronDown, ChevronRight, Ellipsis, FileText, Folder, Gauge, LoaderCircle,
  PanelRight, Paperclip, Plus, Search, Settings, SlidersHorizontal, Smartphone, StickyNote as StickyIcon
} from 'lucide-react';
import { AgentIcon, type Mood } from '../ui';
import { useLang } from '../../lib/i18n';

export const spring = { type: 'spring', stiffness: 380, damping: 32 } as const;
export const easeOut = [0.2, 0, 0, 1] as const;

/* ---------- 小部件 ---------- */

/** 头像：用完整立绘放大后裁到脸部，和控制台的小猫头像一致。 */
export function KittenAvatar({ mood = 'idle', size = 36, className = '' }: { mood?: Mood; size?: number; className?: string }) {
  return (
    <span className={`relative block shrink-0 overflow-hidden rounded-full bg-[#f6ede6] ring-1 ring-black/5 dark:bg-[#3a302b] ${className}`} style={{ width: size, height: size }}>
      <img
        src={`/companion/cat-${mood}.webp`}
        alt=""
        aria-hidden="true"
        draggable={false}
        className="absolute left-1/2 max-w-none -translate-x-1/2"
        style={{ height: size * 1.5, top: size * 0.04 }}
      />
    </span>
  );
}

export function Typewriter({ text, duration, active = true, caret = true, className = '' }: { text: string; duration: number; active?: boolean; caret?: boolean; className?: string }) {
  const [count, setCount] = useState(active ? 0 : text.length);
  useEffect(() => {
    if (!active) { setCount(text.length); return; }
    setCount(0);
    const chars = Array.from(text);
    const tick = Math.max(16, duration / Math.max(1, chars.length));
    let index = 0;
    const timer = window.setInterval(() => {
      index += 1;
      setCount(index);
      if (index >= chars.length) window.clearInterval(timer);
    }, tick);
    return () => window.clearInterval(timer);
  }, [text, duration, active]);
  const shown = Array.from(text).slice(0, count).join('');
  return (
    <span className={className}>
      {shown}
      {caret && count < text.length && <span className="caret ml-px inline-block h-[1.05em] w-[2px] translate-y-[2px] bg-current align-baseline" />}
    </span>
  );
}

/** 秒表：running 时每秒递增。 */
export function useElapsed(running: boolean, start = 0) {
  const [seconds, setSeconds] = useState(start);
  useEffect(() => {
    if (!running) return;
    const timer = window.setInterval(() => setSeconds(value => value + 1), 1000);
    return () => window.clearInterval(timer);
  }, [running]);
  return seconds;
}

export const mmss = (seconds: number) => `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;

/** 演示里被「点中」的元素：一圈呼吸光环，代替假的鼠标指针。 */
export function Pulse({ on, children, className = '', rounded = 'rounded-lg' }: { on: boolean; children: ReactNode; className?: string; rounded?: string }) {
  return (
    <span className={`relative inline-flex ${className}`}>
      {children}
      <AnimatePresence>
        {on && (
          <motion.span
            initial={{ opacity: 0, scale: 0.9 }}
            animate={{ opacity: [0.9, 0.35, 0.9], scale: 1 }}
            exit={{ opacity: 0 }}
            transition={{ opacity: { duration: 1.1, repeat: Infinity }, scale: { duration: 0.25 } }}
            className={`pointer-events-none absolute -inset-1 ${rounded} ring-2 ring-brand/70`}
          />
        )}
      </AnimatePresence>
    </span>
  );
}

/* ---------- 侧栏 ---------- */

export interface RailSession { id: string; title: string; agent: string; time: string; running?: boolean; fresh?: boolean }

export function Rail({ name, mood, stage, status, sessions, notes, active = 'main' }: {
  name: string; mood: Mood; stage: string; status: string; sessions: RailSession[]; notes: number; active?: string;
}) {
  const { t } = useLang();
  const r = t.demo.rail;
  return (
    <aside className="hidden w-[232px] shrink-0 flex-col border-r border-zinc-200 bg-rail md:flex lg:w-[252px]">
      <div className="flex items-center gap-2 px-3.5 pb-2 pt-3.5">
        <img src="/brand/app-icon.svg" alt="" className="h-6 w-6 rounded-[7px]" />
        <span className="text-[13.5px] font-semibold text-zinc-900">AgentDock</span>
      </div>
      <div className="flex items-center gap-2 px-3.5 py-1.5 text-[12.5px] text-zinc-700"><Plus size={14} />{r.newChat}</div>
      <div className="mx-2.5 mt-1 flex items-center gap-1.5">
        <div className="flex h-8 flex-1 items-center gap-2 rounded-lg border border-zinc-200 bg-white px-2.5 text-[12px] text-zinc-400">
          <Search size={13} /><span className="flex-1 truncate">{r.search}</span><span className="rounded bg-zinc-100 px-1 text-[10px] text-zinc-400">⌘K</span>
        </div>
        <span className="grid h-8 w-8 place-items-center rounded-lg border border-zinc-200 bg-white text-zinc-500"><SlidersHorizontal size={13} /></span>
      </div>

      {/* 小猫卡片 */}
      <div className={`mx-2 mt-2.5 flex items-center gap-2.5 rounded-xl px-2 py-2 ${active === 'main' ? 'bg-zinc-900/[.05]' : ''}`}>
        <KittenAvatar mood={mood} size={34} />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <span className="truncate text-[13px] font-semibold text-zinc-900">{name}</span>
            <span className="shrink-0 rounded bg-zinc-900/[.06] px-1 text-[10px] text-zinc-500">{stage}</span>
          </div>
          <AnimatePresence mode="wait" initial={false}>
            <motion.div key={status} initial={{ opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -4 }} transition={{ duration: 0.2 }} className="truncate text-[11.5px] text-zinc-500">
              {status}
            </motion.div>
          </AnimatePresence>
        </div>
        <span className="relative grid h-7 w-7 place-items-center text-zinc-500">
          <StickyIcon size={15} />
          {notes > 0 && <motion.span key={notes} initial={{ scale: 0.4 }} animate={{ scale: 1 }} transition={spring} className="absolute -right-0.5 -top-0.5 grid h-3.5 min-w-3.5 place-items-center rounded-full bg-zinc-900 px-0.5 text-[9px] font-semibold text-white">{notes}</motion.span>}
        </span>
      </div>

      <div className="mt-3 flex items-center justify-between px-3.5 text-[11.5px] text-zinc-500">
        <span>{r.sessions}</span>
        <span className="flex rounded-md bg-zinc-900/[.05] p-0.5 text-[10.5px]">
          <span className="rounded bg-white px-1.5 py-0.5 text-zinc-800 shadow-sm">{r.byTime}</span>
          <span className="px-1.5 py-0.5">{r.byProject}</span>
        </span>
      </div>
      <div className="mt-1.5 px-3.5 text-[11px] text-zinc-400">{r.today}</div>
      <ul className="mt-1 flex-1 overflow-hidden px-1.5">
        <AnimatePresence initial={false}>
          {sessions.map(session => (
            <motion.li
              key={session.id}
              layout
              initial={{ opacity: 0, height: 0 }}
              animate={{ opacity: 1, height: 'auto' }}
              exit={{ opacity: 0, height: 0 }}
              transition={{ duration: 0.3, ease: easeOut }}
              className="overflow-hidden"
            >
              <div className={`flex items-center gap-2 rounded-lg px-2 py-[7px] text-[12.5px] ${session.fresh ? 'bg-brand/[.07]' : ''}`}>
                <AgentIcon id={session.agent} size={14} />
                <span className="min-w-0 flex-1 truncate text-zinc-700">{session.title}</span>
                {session.running ? <LoaderCircle size={12} className="spin shrink-0 text-link" /> : <span className="shrink-0 text-[11px] text-zinc-400">{session.time}</span>}
              </div>
            </motion.li>
          ))}
        </AnimatePresence>
      </ul>
      <div className="flex items-center justify-between border-t border-zinc-200 px-3.5 py-2.5 text-[12.5px] text-zinc-600">
        <span className="flex items-center gap-2"><Settings size={14} />{r.settings}</span>
        <Smartphone size={14} className="text-zinc-400" />
      </div>
    </aside>
  );
}

/* ---------- 顶栏 ---------- */

export function TopBar({ name, mood, gen, agent, model, subtitle, review = 0, running = 0, notes = 0, alarm = false }: {
  name: string; mood: Mood; gen: string; agent: string; model?: string; subtitle?: string; review?: number; running?: number; notes?: number; alarm?: boolean;
}) {
  const { t } = useLang();
  return (
    <div className="flex h-[52px] shrink-0 items-center gap-2.5 border-b border-zinc-200 px-3 sm:px-4">
      <KittenAvatar mood={mood} size={32} />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <span className="truncate text-[13.5px] font-semibold text-zinc-900">{name}</span>
          <span className="hidden shrink-0 rounded bg-zinc-900/[.06] px-1.5 text-[10.5px] text-zinc-500 sm:inline">{t.demo.cat.main}</span>
          <AnimatePresence mode="wait" initial={false}>
            <motion.span key={gen} initial={{ opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -4 }} className="shrink-0 rounded bg-zinc-900/[.06] px-1.5 text-[10.5px] text-zinc-500">{gen}</motion.span>
          </AnimatePresence>
        </div>
        <div className="flex items-center gap-1.5 truncate text-[11.5px] text-zinc-500">
          {subtitle && <span className="truncate">{subtitle}</span>}
          {subtitle && <span className="text-zinc-300">·</span>}
          <AgentIcon id={agent} size={12} />
          <span className="truncate">{model}</span>
        </div>
      </div>
      <div className="hidden items-center gap-1.5 lg:flex">
        {review > 0 && <span className="flex items-center gap-1 rounded-full bg-sky-100/70 px-2 py-1 text-[11px] text-zinc-600"><span className="h-2 w-2 rounded-sm bg-sky-200 ring-1 ring-sky-300/50" />{review} {t.demo.chips.review}</span>}
        {running > 0 && <span className="flex items-center gap-1 rounded-full bg-amber-100/70 px-2 py-1 text-[11px] text-zinc-600"><span className="h-2 w-2 rounded-sm bg-amber-200 ring-1 ring-amber-300/50" />{running} {t.demo.chips.running}</span>}
        <span className="flex items-center gap-1 rounded-full px-2 py-1 text-[11px] text-zinc-600"><FileText size={13} />{t.demo.chips.notes}{notes > 0 && <span className="grid h-4 min-w-4 place-items-center rounded-full bg-zinc-900 px-1 text-[9.5px] font-semibold text-white">{notes}</span>}</span>
      </div>
      <div className="flex items-center gap-0.5 text-zinc-500">
        <Pulse on={alarm} rounded="rounded-md"><span className={`grid h-7 w-7 place-items-center rounded-md ${alarm ? 'bg-zinc-900/[.07] text-zinc-900' : ''}`}><AlarmClock size={15} /></span></Pulse>
        <span className="hidden h-7 w-7 place-items-center sm:grid"><BookOpen size={15} /></span>
        <span className="hidden h-7 w-7 place-items-center sm:grid"><PanelRight size={15} /></span>
        <span className="grid h-7 w-7 place-items-center"><Ellipsis size={15} /></span>
      </div>
    </div>
  );
}

/* ---------- 时间线 ---------- */

export function Timeline({ children, className = '' }: { children: ReactNode; className?: string }) {
  return (
    <div className={`fade-mask-top relative flex min-h-0 flex-1 flex-col justify-end overflow-hidden px-3 pb-3 sm:px-6 ${className}`}>
      <div className="mx-auto flex w-full max-w-[640px] flex-col gap-3">{children}</div>
    </div>
  );
}

export const Appear = ({ children, className = '', delay = 0 }: { children: ReactNode; className?: string; delay?: number }) => (
  <motion.div layout="position" initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.35, delay, ease: easeOut }} className={className}>
    {children}
  </motion.div>
);

export function UserBubble({ children }: { children: ReactNode }) {
  return (
    <Appear className="flex justify-end">
      <div className="max-w-[86%] rounded-[20px] bg-bubble px-3.5 py-2.5 text-[13px] leading-[1.7] text-zinc-900">{children}</div>
    </Appear>
  );
}

export function ProcessedRow({ text, spinning }: { text: string; spinning?: boolean }) {
  return (
    <Appear className="flex items-center gap-1.5 text-[12px] text-zinc-500">
      {spinning ? <LoaderCircle size={13} className="spin text-zinc-400" /> : <Check size={13} className="text-emerald-500" strokeWidth={2.5} />}
      <span className={spinning ? 'shimmer-text' : ''}>{text}</span>
      <ChevronRight size={13} className="ml-auto text-zinc-300" />
    </Appear>
  );
}

export function AssistantText({ children }: { children: ReactNode }) {
  return <Appear className="text-[13px] leading-[1.8] text-zinc-800">{children}</Appear>;
}

export function InlineCode({ children }: { children: ReactNode }) {
  return <code className="rounded-md bg-code px-1.5 py-0.5 text-[12px] text-zinc-700 ring-1 ring-zinc-200">{children}</code>;
}

export function ToolRow({ command, done }: { command: string; done?: boolean }) {
  return (
    <Appear className="flex items-center gap-2 rounded-lg border border-zinc-200 bg-code px-2.5 py-1.5 text-[11.5px] text-zinc-600">
      {done ? <Check size={12} className="shrink-0 text-emerald-500" strokeWidth={2.5} /> : <LoaderCircle size={12} className="spin shrink-0 text-zinc-400" />}
      <span className="shrink-0 text-zinc-400">Bash</span>
      <span className="truncate">{command}</span>
    </Appear>
  );
}

export function SystemRound({ title, badge, desc }: { title: string; badge: string; desc: string }) {
  return (
    <Appear className="flex items-center gap-2 rounded-xl border border-dashed border-zinc-300 bg-zinc-900/[.02] px-3 py-2 text-[11.5px]">
      <Gauge size={13} className="shrink-0 text-brand" />
      <span className="shrink-0 font-semibold text-zinc-800">{title}</span>
      <span className="shrink-0 rounded bg-brand/15 px-1.5 text-[10px] font-semibold text-brand">{badge}</span>
      <span className="hidden truncate text-zinc-500 xl:inline">{desc}</span>
    </Appear>
  );
}

/* ---------- 便签 ---------- */

export type NoteStatus = 'running' | 'review' | 'done';

const notePaper: Record<NoteStatus, string> = {
  running: 'bg-amber-50 border-amber-200/80',
  review: 'bg-sky-50 border-sky-200/80',
  done: 'bg-emerald-50 border-emerald-200/80'
};

export function StickyNote({ index, title, agent, model, cwd, status, statusLabel, rework, reworkLabel, elapsed, stamp, compact }: {
  index: number; title: string; agent: string; model: string; cwd: string; status: NoteStatus; statusLabel: string;
  rework?: string; reworkLabel?: string; elapsed: string; stamp?: string; compact?: boolean;
}) {
  return (
    <motion.div
      layout
      initial={{ opacity: 0, y: 14, rotate: index % 2 ? 2.5 : -2.5, scale: 0.92 }}
      animate={{ opacity: 1, y: 0, rotate: index % 2 ? 0.6 : -0.6, scale: 1 }}
      transition={spring}
      className={`relative overflow-hidden rounded-lg border px-3 py-2.5 shadow-[0_1px_0_rgb(0_0_0/.03),0_6px_14px_-8px_rgb(0_0_0/.25)] transition-colors duration-500 ${notePaper[status]}`}
    >
      <div className="flex items-start gap-2">
        <span className="mt-px font-dock text-[10.5px] text-zinc-400">#{index + 1}</span>
        <div className="min-w-0 flex-1">
          <div className="truncate text-[12.5px] font-semibold text-zinc-900">{title}</div>
          <div className="mt-1 flex items-center gap-1.5 text-[11px] text-zinc-500">
            <AgentIcon id={agent} size={12} />
            <span className="truncate">{model}</span>
            {!compact && <span className="flex shrink-0 items-center gap-0.5 text-zinc-400"><Folder size={10} />{cwd}</span>}
          </div>
        </div>
      </div>
      <div className="mt-2 flex items-center justify-between text-[10.5px]">
        <span className="flex items-center gap-1 text-zinc-600">
          {status === 'running' && <span className="live-dot h-1.5 w-1.5 rounded-full bg-amber-500" />}
          {status === 'review' && <span className="h-1.5 w-1.5 rounded-full bg-sky-500" />}
          {status === 'done' && <Check size={11} className="text-emerald-600" strokeWidth={3} />}
          {statusLabel}{rework && <span className="text-zinc-400"> · {reworkLabel}</span>}
        </span>
        <span className="font-dock tabular-nums text-zinc-400">{elapsed}</span>
      </div>
      <AnimatePresence>
        {stamp && (
          <motion.span
            initial={{ opacity: 0, scale: 1.8, rotate: -24 }}
            animate={{ opacity: 1, scale: 1, rotate: -12 }}
            transition={{ type: 'spring', stiffness: 520, damping: 18 }}
            className="absolute right-2 top-2 flex items-center gap-0.5 rounded border-2 border-emerald-500/70 px-1 font-dock text-[10px] font-bold text-emerald-600 dark:text-emerald-300"
          >
            <Check size={10} strokeWidth={3.5} />{stamp}
          </motion.span>
        )}
      </AnimatePresence>
      {rework && status === 'running' && <div className="mt-1.5 rounded bg-white/60 px-1.5 py-1 text-[10.5px] leading-4 text-zinc-600">↺ {rework}</div>}
    </motion.div>
  );
}

/* ---------- 输入框 ---------- */

export function Composer({ placeholder, children, toolbar, quote, meter }: { placeholder: string; children?: ReactNode; toolbar?: ReactNode; quote?: ReactNode; meter?: string }) {
  return (
    <div className="shrink-0 px-3 pb-3 sm:px-6 sm:pb-4">
      <div className="mx-auto w-full max-w-[640px] rounded-[18px] border border-zinc-200 bg-white px-2.5 pb-2 pt-2 shadow-[0_1px_2px_rgb(0_0_0/.04)]">
        <AnimatePresence initial={false}>
          {quote && (
            <motion.div initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: 'auto' }} exit={{ opacity: 0, height: 0 }} className="overflow-hidden">
              <div className="mx-1 mb-1.5 rounded-r-lg border-l-[2.5px] border-zinc-400 bg-zinc-900/[.045] px-2.5 py-1.5 text-[12px] text-zinc-600">{quote}</div>
            </motion.div>
          )}
        </AnimatePresence>
        <div className="min-h-[40px] px-1.5 py-1 text-[13px] leading-6 text-zinc-900">
          {children ?? <span className="line-clamp-2 text-zinc-400">{placeholder}</span>}
        </div>
        <div className="flex items-center gap-1 text-[11.5px] text-zinc-500">
          <span className="grid h-7 w-7 place-items-center">/</span>
          <span className="grid h-7 w-7 place-items-center"><Paperclip size={13} /></span>
          <div className="no-scrollbar flex min-w-0 flex-1 items-center gap-1 overflow-x-auto">{toolbar}</div>
          {meter && <span className="hidden shrink-0 font-dock text-[10.5px] text-zinc-400 xl:inline">{meter}</span>}
          <span className="grid h-7 w-7 shrink-0 place-items-center rounded-full bg-zinc-900 text-white"><ArrowUp size={14} /></span>
        </div>
      </div>
    </div>
  );
}

export function ToolbarChip({ children, active, pulse }: { children: ReactNode; active?: boolean; pulse?: boolean }) {
  return (
    <Pulse on={Boolean(pulse)} rounded="rounded-md">
      <span className={`flex h-7 shrink-0 items-center gap-1 whitespace-nowrap rounded-md px-1.5 transition-colors ${active ? 'bg-zinc-900/[.07] text-zinc-900' : ''}`}>
        {children}
        <ChevronDown size={11} className="text-zinc-400" />
      </span>
    </Pulse>
  );
}

export function Dropdown({ header, children, className = '' }: { header: string; children: ReactNode; className?: string }) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 6, scale: 0.98 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={{ opacity: 0, y: 6, scale: 0.98 }}
      transition={{ duration: 0.18, ease: easeOut }}
      className={`absolute z-20 w-[232px] overflow-hidden rounded-xl border border-zinc-200 bg-white p-1 shadow-[0_12px_32px_-8px_rgb(0_0_0/.25)] ${className}`}
    >
      <div className="px-2 pb-1 pt-1.5 text-[10.5px] text-zinc-400">{header}</div>
      {children}
    </motion.div>
  );
}

export function DropdownItem({ children, selected, hover }: { children: ReactNode; selected?: boolean; hover?: boolean }) {
  return (
    <div className={`flex items-center gap-2 rounded-lg px-2 py-1.5 text-[12px] text-zinc-800 transition-colors ${hover ? 'bg-zinc-900/[.07]' : ''}`}>
      {children}
      {selected && <Check size={13} className="ml-auto text-zinc-900" strokeWidth={2.5} />}
    </div>
  );
}
