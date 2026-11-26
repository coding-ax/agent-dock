import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { Check, CircleCheck, FileCode2, Film, Folder, Image as ImageIcon, LoaderCircle, Play, Quote, Repeat, X } from 'lucide-react';
import { useLang } from '../../lib/i18n';
import { AgentIcon, Kitten, KittenMark, useTicker, type Mood } from '../ui';
import {
  AssistantText, Composer, Dropdown, DropdownItem, ProcessedRow, Pulse, Rail, StickyNote, SystemRound, Timeline, ToolRow,
  ToolbarChip, TopBar, Typewriter, UserBubble, easeOut, mmss, spring, type NoteStatus, type RailSession
} from './parts';

export interface SceneProps { active: boolean; onEnd: () => void; onProgress: (ratio: number, ms: number) => void }

/** 场景步进 + 把进度报告给顶部 Tab 的进度条。 */
function useScene(durations: number[], { active, onEnd, onProgress }: SceneProps) {
  const [step] = useTicker(durations, active, { loop: false, onEnd });
  const total = useMemo(() => durations.reduce((sum, value) => sum + value, 0), [durations]);
  useEffect(() => {
    const done = durations.slice(0, step + 1).reduce((sum, value) => sum + value, 0);
    onProgress(done / total, durations[step] ?? 0);
  }, [step]); // eslint-disable-line react-hooks/exhaustive-deps
  return step;
}

function Body({ children }: { children: ReactNode }) {
  return <div className="flex h-full min-h-0">{children}</div>;
}

function Main({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <div className={`relative flex min-w-0 flex-1 flex-col bg-canvas ${className}`}>{children}</div>;
}

function useBaseline(): RailSession[] {
  const { t } = useLang();
  return t.demo.rail.baseline.map((session, index) => ({ id: `base-${index}`, ...session }));
}

function Toast({ children, tone = 'dark' }: { children: ReactNode; tone?: 'dark' | 'brand' }) {
  return (
    <motion.div
      initial={{ opacity: 0, y: -10, scale: 0.96 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={{ opacity: 0, y: -10 }}
      transition={spring}
      className={`pointer-events-none absolute left-1/2 top-3 z-30 flex max-w-[92%] -translate-x-1/2 items-center gap-2 rounded-full px-3.5 py-2 text-[12px] font-medium shadow-lg ${tone === 'brand' ? 'bg-brand text-snow' : 'bg-zinc-900 text-white'}`}
    >
      {children}
    </motion.div>
  );
}

/* =====================================================================
 * 场景一：小猫派活
 * ===================================================================== */

const DISPATCH = [900, 2300, 1200, 900, 550, 550, 900, 1900, 1500, 1000, 700, 700, 1500, 1000, 3000];

function LiveNote(props: { index: number; status: NoteStatus; stamp?: string; rework?: string; compact?: boolean; label: string; reworkLabel?: string; note: { title: string; agent: string; model: string; cwd: string } }) {
  const [seconds, setSeconds] = useState(0);
  useEffect(() => {
    if (props.status !== 'running') return;
    const timer = window.setInterval(() => setSeconds(value => value + 9), 1000);
    return () => window.clearInterval(timer);
  }, [props.status]);
  const agentId = props.note.agent === 'Claude Code' ? 'claude' : props.note.agent === 'Antigravity' ? 'antigravity' : 'codex';
  return (
    <StickyNote
      index={props.index}
      title={props.note.title}
      agent={agentId}
      model={props.compact ? props.note.agent : props.note.model}
      cwd={props.note.cwd}
      status={props.status}
      statusLabel={props.label}
      rework={props.rework}
      reworkLabel={props.reworkLabel}
      elapsed={mmss(seconds)}
      stamp={props.stamp}
      compact={props.compact}
    />
  );
}

export function DispatchScene(props: SceneProps) {
  const { t, lang } = useLang();
  const d = t.demo.dispatch;
  const step = useScene(DISPATCH, props);
  const baseline = useBaseline();

  const created = Math.max(0, Math.min(3, step - 3));
  const statuses: NoteStatus[] = [0, 1, 2].map(index => {
    if (index === 2 && step === 12) return 'running';
    if (step >= 10 + index && index < 2) return 'done';
    if (index === 2 && step >= 13) return 'done';
    if (step >= 9) return 'review';
    return 'running';
  });
  const stamps = statuses.map(status => (status === 'done' ? d.verdictOk : undefined));
  const reworkIndex = step >= 12 ? 2 : -1;

  const mood: Mood = step >= 14 ? 'sparkle' : step >= 8 ? 'search' : step >= 4 ? 'busy' : step >= 2 ? 'curious' : 'idle';
  const status = step >= 14 ? t.demo.status.done : step >= 9 ? t.demo.status.reviewing : step >= 4 ? t.demo.status.dispatched : step >= 2 ? t.demo.status.thinking : t.demo.status.idle;
  const runningCount = statuses.slice(0, created).filter(value => value === 'running').length;
  const reviewCount = statuses.slice(0, created).filter(value => value === 'review').length;

  const sessions: RailSession[] = [
    ...d.notes.slice(0, created).map((note, index) => ({
      id: `side-${index}`,
      title: note.title,
      agent: note.agent === 'Claude Code' ? 'claude' : note.agent === 'Antigravity' ? 'antigravity' : 'codex',
      time: t.demo.rail.justNow,
      running: statuses[index] === 'running',
      fresh: true
    })).reverse(),
    ...baseline
  ];

  const notes = d.notes.slice(0, created).map((note, index) => ({ note, index, status: statuses[index], stamp: stamps[index] }));
  const noteLabel = (value: NoteStatus) => d.status[value];

  return (
    <Body>
      <Rail name={t.demo.cat.name} mood={mood} stage={lang === 'zh' ? '幼猫' : 'Kitten'} status={status} sessions={sessions} notes={created} />
      <Main>
        <TopBar name={t.demo.cat.name} mood={mood} gen={t.demo.cat.gen1} agent="claude" model="Opus 5.5" subtitle={status} review={reviewCount} running={runningCount} notes={created} />
        <div className="flex min-h-0 flex-1">
          <div className="flex min-w-0 flex-1 flex-col">
            <Timeline>
              {step >= 2 && <UserBubble>{d.prompt}</UserBubble>}
              {step >= 2 && <ProcessedRow text={step >= 3 ? d.processed(6, 3) : '…'} spinning={step < 3} />}
              {step >= 3 && <AssistantText>{d.reply}</AssistantText>}
              {notes.map(({ note, index }) => (
                <ToolRow key={`tool-${index}`} done command={`${d.tool} --agent ${note.agent === 'Claude Code' ? 'claude' : note.agent === 'Antigravity' ? 'antigravity' : 'codex'} --title "${note.title}"`} />
              ))}
              {step >= 8 && <SystemRound title={d.systemRound} badge={d.systemBadge} desc={d.systemDesc} />}
              {step >= 9 && <AssistantText>{d.reviewing}</AssistantText>}
              {step >= 14 && <AssistantText><span className="mr-1">🎉</span>{d.final}</AssistantText>}
            </Timeline>
            {/* 窄屏：便签贴在输入框上方 */}
            {created > 0 && (
              <div className="grid shrink-0 grid-cols-3 gap-2 px-3 pb-1 sm:px-6 lg:hidden">
                {notes.map(({ note, index, status: noteStatus, stamp }) => (
                  <LiveNote key={index} index={index} note={note} status={noteStatus} stamp={stamp} compact label={noteLabel(noteStatus)} rework={reworkIndex === index && noteStatus === 'running' ? d.reworkNote : undefined} />
                ))}
              </div>
            )}
            <Composer
              placeholder={t.demo.composer.placeholderMain}
              meter="12.4k tok · ⚡86.2 t/s"
              toolbar={<><ToolbarChip><AgentIcon id="claude" size={12} />Opus 5.5</ToolbarChip><ToolbarChip>high</ToolbarChip></>}
            >
              {step === 1 ? <Typewriter text={d.prompt} duration={2000} /> : undefined}
            </Composer>
          </div>

          {/* 宽屏：右侧便签栏 */}
          <aside className="hidden w-[252px] shrink-0 flex-col border-l border-zinc-200 bg-rail/70 lg:flex">
            <div className="flex items-center justify-between px-3.5 pb-2 pt-3 text-[12px] font-semibold text-zinc-800">
              <span className="whitespace-nowrap">{t.demo.chips.notes} {created > 0 && <span className="ml-1 font-normal text-zinc-400">{created}</span>}</span>
              <span className="flex gap-1 whitespace-nowrap text-[10.5px] font-normal text-zinc-500">
                <span className="rounded bg-amber-100 px-1.5">{d.legend.running}</span>
                <span className="rounded bg-sky-100 px-1.5">{d.legend.review}</span>
                <span className="rounded bg-emerald-100 px-1.5">{d.legend.done}</span>
              </span>
            </div>
            <div className="flex flex-1 flex-col gap-2.5 overflow-hidden px-3 pb-3">
              <AnimatePresence>
                {notes.map(({ note, index, status: noteStatus, stamp }) => (
                  <LiveNote
                    key={index}
                    index={index}
                    note={note}
                    status={noteStatus}
                    stamp={stamp}
                    label={noteLabel(noteStatus)}
                    rework={reworkIndex === index && noteStatus === 'running' ? d.reworkNote : undefined}
                    reworkLabel={reworkIndex === index ? `${d.verdictRework}` : undefined}
                  />
                ))}
              </AnimatePresence>
              {created === 0 && (
                <div className="mt-6 flex flex-col items-center gap-2 text-center text-[11.5px] text-zinc-400">
                  <Kitten mood="idle" size={64} className="opacity-80" />
                  {t.demo.status.idle}
                </div>
              )}
            </div>
          </aside>
        </div>
      </Main>
    </Body>
  );
}

/* =====================================================================
 * 场景二：选 Agent 与模型（新对话首页）
 * ===================================================================== */

const SWITCH = [1100, 1100, 800, 700, 1200, 900, 900, 600, 2600];
const INSTALLED = ['claude', 'codex', 'gemini', 'cursor', 'antigravity', 'opencode', 'qwen'];
const MODELS = ['gpt-6.1-sol', 'gpt-6-astra', 'gpt-6', 'gpt-5'];
const EFFORTS = ['low', 'medium', 'high', 'xhigh'];

export function SwitchScene(props: SceneProps) {
  const { t, lang } = useLang();
  const s = t.demo.switch;
  const step = useScene(SWITCH, props);
  const baseline = useBaseline();

  const agent = step >= 3 ? 'codex' : 'claude';
  const model = step >= 5 ? 'gpt-6.1-sol' : step === 3 ? null : step >= 4 ? 'gpt-6.1-sol' : 'Opus 5.5';
  const effort = step >= 7 ? 'high' : 'medium';
  const agentName = agent === 'codex' ? 'Codex' : 'Claude Code';

  return (
    <Body>
      <Rail name={t.demo.cat.name} mood="idle" stage={lang === 'zh' ? '幼猫' : 'Kitten'} status={t.demo.status.idle} sessions={baseline} notes={0} active="home" />
      <Main>
        <AnimatePresence>{step >= 7 && <Toast><CircleCheck size={14} className="text-emerald-400" />{s.toast}</Toast>}</AnimatePresence>
        <div className="flex min-h-0 flex-1 flex-col items-center justify-center px-3 pb-2 pt-6 sm:px-6">
          <div className="relative flex flex-col items-center">
            <div className="relative mb-2 rounded-2xl bg-white px-3 py-1.5 text-[12px] text-zinc-700 shadow-[0_4px_16px_-4px_rgb(0_0_0/.18)] ring-1 ring-zinc-200">
              {step >= 7 ? `${agentName} · ${model} · ${effort}` : t.demo.status.idle}
              <span className="absolute -bottom-1 left-1/2 h-2 w-2 -translate-x-1/2 rotate-45 bg-white ring-0" />
            </div>
            <Kitten mood={step >= 7 ? 'happy' : 'idle'} size={86} />
            <span className="mt-1.5 rounded-full border-[1.5px] border-zinc-900 px-2.5 py-0.5 text-[11.5px] font-semibold text-zinc-900">{t.demo.cat.name}</span>
          </div>
          <div className="mt-4 text-[17px] font-semibold text-zinc-900">{s.greeting}</div>
          <div className="mt-3 flex rounded-xl bg-zinc-900/[.05] p-1 text-[12px]">
            <span className="rounded-lg bg-white px-3 py-1 font-medium text-zinc-900 shadow-sm">{s.newChat}</span>
            <span className="px-3 py-1 text-zinc-500">{s.handTo}</span>
          </div>
        </div>
        <div className="relative">
          <AnimatePresence>
            {(step === 1 || step === 2) && (
              <Dropdown key="agents" header={s.agentHeader} className="bottom-[calc(100%-10px)] left-3 sm:left-[calc(50%-260px)]">
                {INSTALLED.map(id => (
                  <DropdownItem key={id} selected={id === 'claude'} hover={step === 2 && id === 'codex'}>
                    <AgentIcon id={id} size={14} />
                    <span>{id === 'claude' ? 'Claude Code' : id === 'codex' ? 'Codex' : id === 'gemini' ? 'Gemini CLI' : id === 'cursor' ? 'Cursor' : id === 'antigravity' ? 'Antigravity' : id === 'opencode' ? 'opencode' : 'Qwen Code'}</span>
                  </DropdownItem>
                ))}
              </Dropdown>
            )}
            {(step === 4 || step === 5) && (
              <Dropdown key="models" header={s.modelHeader} className="bottom-[calc(100%-10px)] left-3 sm:left-[calc(50%-120px)]">
                {MODELS.map(id => (
                  <DropdownItem key={id} selected={step === 5 && id === 'gpt-6.1-sol'} hover={step === 4 && id === 'gpt-6.1-sol'}>
                    <AgentIcon id="codex" size={13} /><span className="font-dock">{id}</span>
                  </DropdownItem>
                ))}
              </Dropdown>
            )}
            {step === 6 && (
              <Dropdown key="effort" header={s.effort} className="bottom-[calc(100%-10px)] right-3 w-[180px] sm:left-[calc(50%+30px)] sm:right-auto">
                {EFFORTS.map(id => (
                  <DropdownItem key={id} hover={id === 'high'} selected={id === 'medium'}><span className="font-dock">{id}</span></DropdownItem>
                ))}
              </Dropdown>
            )}
          </AnimatePresence>
          <Composer
            placeholder={t.demo.composer.placeholderHome}
            toolbar={
              <>
                <ToolbarChip pulse={step === 1} active={step === 1 || step === 2}><AgentIcon id={agent} size={12} />{agentName}</ToolbarChip>
                <span className="hidden sm:inline-flex"><ToolbarChip><Folder size={12} />{s.cwd}</ToolbarChip></span>
                <ToolbarChip pulse={step === 4} active={step === 4 || step === 5}>
                  {model ? <span className="font-dock">{model}</span> : <span className="flex items-center gap-1 text-zinc-400"><LoaderCircle size={11} className="spin" /><span className="shimmer-text">/models</span></span>}
                </ToolbarChip>
                <ToolbarChip pulse={step === 6} active={step === 6}><span className="font-dock">{effort}</span></ToolbarChip>
              </>
            }
          />
        </div>
      </Main>
    </Body>
  );
}

/* =====================================================================
 * 场景三：产物预览 · 行号定位 · 划词引用
 * ===================================================================== */

const ART = [1000, 1700, 800, 2400, 700, 2200, 700, 2700, 900, 900, 800, 2600];

type Tok = [string, string?];
const C = { k: 'text-[#a626a4] dark:text-[#c678dd]', s: 'text-[#50a14f] dark:text-[#98c379]', f: 'text-[#4078f2] dark:text-[#61afef]', c: 'text-zinc-400 italic', n: 'text-[#986801] dark:text-[#d19a66]', t: 'text-[#c18401] dark:text-[#e5c07b]' };
const CODE: Tok[][] = [
  [['import', C.k], [' { z } '], ['from', C.k], [" 'zod'", C.s], [';']],
  [],
  [['// 表单校验统一走 zod，错误贴着输入框显示', C.c]],
  [['const', C.k], [' schema = z.'], ['object', C.f], ['({']],
  [['  email: z.'], ['string', C.f], ['().'], ['email', C.f], ['(', ], ["'邮箱格式不对'", C.s], ['),']],
  [['  password: z.'], ['string', C.f], ['().'], ['min', C.f], ['('], ['8', C.n], [', '], ["'至少 8 位'", C.s], [')']],
  [['});']],
  [],
  [['export function', C.k], [' '], ['LoginForm', C.f], ['() {']],
  [['  const', C.k], [' [errors, setErrors] = '], ['useState', C.f], ['<'], ['Errors', C.t], ['>({});']],
  [['  const', C.k], [' onSubmit = '], ['async', C.k], [' (form: '], ['FormData', C.t], [') => {']],
  [['    const', C.k], [' result = schema.'], ['safeParse', C.f], ['('], ['Object', C.t], ['.'], ['fromEntries', C.f], ['(form));']],
  [['    if', C.k], [' (!result.success) '], ['return', C.k], [' '], ['setErrors', C.f], ['('], ['flatten', C.f], ['(result.error));']],
  [['    await', C.k], [' '], ['signIn', C.f], ['(result.data);']],
  [['  };']],
  [['  return', C.k], [' <'], ['Card', C.t], ['>']],
  [['    <'], ['Field', C.t], [' name='], ['"email"', C.s], [' error={errors.email} />']],
  [['    <'], ['Field', C.t], [' name='], ['"password"', C.s], [' type='], ['"password"', C.s], [' />']],
  [['  </'], ['Card', C.t], ['>;']],
  [['}']]
];
const FIRST_LINE = 40;
const HIGHLIGHT: [number, number] = [42, 58];

function CodePreview() {
  return (
    <div className="min-h-0 flex-1 overflow-hidden py-2 font-dock text-[11.5px] leading-[19px]">
      {CODE.map((line, index) => {
        const number = FIRST_LINE + index;
        const lit = number >= HIGHLIGHT[0] && number <= HIGHLIGHT[1];
        return (
          <motion.div
            key={index}
            initial={{ backgroundColor: 'rgba(0,0,0,0)' }}
            animate={{ backgroundColor: lit ? 'rgb(var(--brand) / .10)' : 'rgba(0,0,0,0)' }}
            transition={{ delay: 0.25 + (lit ? (number - HIGHLIGHT[0]) * 0.02 : 0), duration: 0.3 }}
            className={`flex whitespace-pre pr-3 ${lit ? 'shadow-[inset_2px_0_0_rgb(var(--brand))]' : ''}`}
          >
            <span className="w-10 shrink-0 select-none pr-3 text-right text-zinc-400">{number}</span>
            <span className="text-zinc-800">{line.map(([text, cls], i) => <span key={i} className={cls}>{text}</span>)}</span>
          </motion.div>
        );
      })}
    </div>
  );
}

function LoginMock({ dim }: { dim?: boolean }) {
  const { t } = useLang();
  const a = t.demo.artifacts;
  return (
    <div className={`grid h-full w-full place-items-center bg-gradient-to-b from-[#fbf7f3] to-[#f2ebe4] ${dim ? 'opacity-70' : ''}`}>
      <div className="w-[64%] max-w-[230px] rounded-xl bg-[#ffffff] p-3.5 text-[#0d0d0d] shadow-[0_8px_30px_-10px_rgb(0_0_0/.35)]">
        <KittenMark size={22} />
        <div className="mt-2 text-[12.5px] font-semibold">{a.imageTitle}</div>
        <div className="text-[9.5px] text-[#6b6b6b]">{a.imageSub}</div>
        {[a.email, a.password].map(label => (
          <div key={label} className="mt-2">
            <div className="text-[8.5px] text-[#6b6b6b]">{label}</div>
            <div className="mt-0.5 h-5 rounded-md border border-[#e5e5e5]" />
          </div>
        ))}
        <div className="mt-3 grid h-6 place-items-center rounded-md bg-[#0d0d0d] text-[9.5px] font-medium text-[#ffffff]">{a.signIn}</div>
      </div>
    </div>
  );
}

function VideoPreview() {
  const { t } = useLang();
  const [progress, setProgress] = useState(0.08);
  useEffect(() => {
    const timer = window.setInterval(() => setProgress(value => Math.min(0.92, value + 0.035)), 100);
    return () => window.clearInterval(timer);
  }, []);
  const total = 21;
  return (
    <div className="flex min-h-0 flex-1 flex-col p-3">
      <div className="relative min-h-0 flex-1 overflow-hidden rounded-lg bg-[#0d0d0d]">
        <div className="absolute inset-3"><LoginMock dim /></div>
        <span className="absolute right-2 top-2 rounded-full bg-black/60 px-2 py-0.5 font-dock text-[9.5px] text-[#ffffff]">{t.demo.artifacts.range}</span>
        <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/80 to-transparent p-2.5 pt-8">
          <div className="flex items-center gap-2 font-dock text-[10px] text-[#ffffff]">
            <Play size={11} fill="currentColor" />
            <div className="h-1 flex-1 overflow-hidden rounded-full bg-[#ffffff]/25"><div className="h-full rounded-full bg-[#ffffff]" style={{ width: `${progress * 100}%`, transition: 'width .1s linear' }} /></div>
            <span className="tabular-nums">{mmss(Math.round(progress * total))} / {mmss(total)}</span>
          </div>
        </div>
      </div>
    </div>
  );
}

export function ArtifactsScene(props: SceneProps) {
  const { t, lang } = useLang();
  const a = t.demo.artifacts;
  const step = useScene(ART, props);
  const baseline = useBaseline();
  const preview = step >= 3 && step <= 7 ? (step >= 7 ? 'video' : step >= 5 ? 'image' : 'code') : null;
  const selecting = step >= 8;
  const quoted = step >= 10;

  const files = [
    { id: 'code', label: `src/auth/LoginForm.tsx#${a.lines}`, icon: <FileCode2 size={11} />, pulse: step === 2 },
    { id: 'image', label: 'artifacts/login-v2.png', icon: <ImageIcon size={11} />, pulse: step === 4 },
    { id: 'video', label: 'artifacts/demo.mp4', icon: <Film size={11} />, pulse: step === 6 }
  ];
  const fileChip = (index: number) => (
    <Pulse on={files[index].pulse} rounded="rounded-md">
      <span className={`inline-flex items-center gap-1 rounded-md px-1.5 py-px align-baseline text-[12px] text-link underline decoration-link/30 underline-offset-2 transition-colors ${preview === files[index].id ? 'bg-link/10' : ''}`}>
        {files[index].icon}{files[index].label}
      </span>
    </Pulse>
  );
  const [before, after] = a.replyD.split(a.quote);

  return (
    <Body>
      <Rail name={t.demo.cat.name} mood="happy" stage={lang === 'zh' ? '幼猫' : 'Kitten'} status={t.demo.status.done} sessions={baseline} notes={0} active="side" />
      <Main>
        <TopBar name={t.demo.dispatch.notes[0].title} mood="happy" gen={t.demo.cat.gen1} agent="codex" model="gpt-6.1-sol" />
        <div className="relative flex min-h-0 flex-1">
          <div className="flex min-w-0 flex-1 flex-col">
            <Timeline>
              <UserBubble>{a.ask}</UserBubble>
              <ProcessedRow text={t.demo.dispatch.processed(214, 23)} />
              {step >= 1 && (
                <AssistantText>
                  {a.replyA}{fileChip(0)}{a.replyB}{fileChip(1)}{a.replyC}{fileChip(2)}{before}
                  <span className="relative">
                    <span className={`rounded-sm transition-colors duration-500 ${selecting ? 'bg-link/25' : ''}`}>{a.quote}</span>
                    <AnimatePresence>
                      {step >= 9 && step < 11 && (
                        <motion.span
                          initial={{ opacity: 0, y: 4, scale: 0.9 }}
                          animate={{ opacity: 1, y: 0, scale: step === 10 ? 0.94 : 1 }}
                          exit={{ opacity: 0, scale: 0.9 }}
                          transition={{ duration: 0.18 }}
                          className="absolute -top-9 left-1/2 z-10 flex -translate-x-1/2 items-center gap-1 whitespace-nowrap rounded-lg bg-zinc-900 px-2.5 py-1.5 text-[11.5px] font-medium text-white shadow-lg"
                        >
                          <Quote size={11} />{a.quoteBtn}
                        </motion.span>
                      )}
                    </AnimatePresence>
                  </span>
                  {after}
                </AssistantText>
              )}
            </Timeline>
            <Composer
              placeholder={t.demo.composer.placeholderMain}
              quote={quoted ? a.quote : undefined}
              toolbar={<><ToolbarChip><AgentIcon id="codex" size={12} />gpt-6.1-sol</ToolbarChip><ToolbarChip>high</ToolbarChip></>}
            >
              {step >= 11 ? <Typewriter text={t.demo.composer.quoteFollow} duration={1600} /> : undefined}
            </Composer>
          </div>

          <AnimatePresence>
            {preview && (
              <motion.aside
                key="preview"
                initial={{ opacity: 0, x: 24 }}
                animate={{ opacity: 1, x: 0 }}
                exit={{ opacity: 0, x: 24 }}
                transition={{ duration: 0.35, ease: easeOut }}
                className="absolute inset-x-2 bottom-2 top-[30%] z-20 flex flex-col overflow-hidden rounded-2xl border border-zinc-200 bg-white shadow-[0_20px_50px_-12px_rgb(0_0_0/.35)] lg:static lg:inset-auto lg:z-auto lg:w-[46%] lg:rounded-none lg:border-y-0 lg:border-r-0 lg:shadow-none"
              >
                <div className="flex h-10 shrink-0 items-center gap-2 border-b border-zinc-200 px-3 text-[11.5px] text-zinc-600">
                  {preview === 'code' ? <FileCode2 size={13} /> : preview === 'image' ? <ImageIcon size={13} /> : <Film size={13} />}
                  <span className="truncate font-dock">{preview === 'code' ? 'src/auth/LoginForm.tsx' : preview === 'image' ? 'artifacts/login-v2.png' : 'artifacts/demo.mp4'}</span>
                  {preview === 'code' && <span className="shrink-0 rounded bg-brand/15 px-1.5 font-dock text-[10px] font-semibold text-brand">{a.lines}</span>}
                  {preview === 'image' && <span className="shrink-0 font-dock text-[10px] text-zinc-400">1440×900 · 184 KB</span>}
                  <X size={13} className="ml-auto shrink-0 text-zinc-400" />
                </div>
                <AnimatePresence mode="wait">
                  <motion.div key={preview} initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.2 }} className="flex min-h-0 flex-1 flex-col bg-canvas">
                    {preview === 'code' && <CodePreview />}
                    {preview === 'image' && <div className="min-h-0 flex-1 p-3"><div className="h-full overflow-hidden rounded-lg ring-1 ring-zinc-200"><LoginMock /></div></div>}
                    {preview === 'video' && <VideoPreview />}
                  </motion.div>
                </AnimatePresence>
              </motion.aside>
            )}
          </AnimatePresence>
        </div>
      </Main>
    </Body>
  );
}

/* =====================================================================
 * 场景四：定时任务 · 换代自动跟随
 * ===================================================================== */

const SCH = [1000, 1800, 1000, 1100, 900, 1500, 1700, 2800, 1300, 2800];

function Ceremony({ labels }: { labels: string[] }) {
  const [done, setDone] = useState(0);
  useEffect(() => {
    const timer = window.setInterval(() => setDone(value => Math.min(labels.length, value + 1)), 420);
    return () => window.clearInterval(timer);
  }, [labels.length]);
  return (
    <ol className="mt-2.5 grid grid-cols-3 gap-1.5 sm:grid-cols-6">
      {labels.map((label, index) => {
        const state = index < done ? 'done' : index === done ? 'active' : 'pending';
        return (
          <li key={label} className={`flex flex-col items-center gap-1 rounded-lg px-1 py-1.5 text-center text-[10px] transition-colors ${state === 'done' ? 'bg-emerald-50 text-zinc-700' : state === 'active' ? 'bg-amber-50 text-zinc-800' : 'text-zinc-400'}`}>
            <span className="grid h-4 w-4 place-items-center">
              {state === 'done' ? <Check size={12} strokeWidth={3} className="text-emerald-500" /> : state === 'active' ? <LoaderCircle size={12} className="spin text-amber-500" /> : <span className="h-1.5 w-1.5 rounded-full bg-zinc-300" />}
            </span>
            <span className="leading-tight">{label}</span>
          </li>
        );
      })}
    </ol>
  );
}

export function ScheduleScene(props: SceneProps) {
  const { t, lang } = useLang();
  const s = t.demo.schedule;
  const step = useScene(SCH, props);
  const baseline = useBaseline();

  const newCat = step >= 8;
  const name = newCat ? t.demo.cat.name2 : t.demo.cat.name;
  const gen = newCat ? t.demo.cat.gen2 : step >= 6 ? t.demo.cat.gen1Old : t.demo.cat.gen1;
  const mood: Mood = newCat ? 'happy' : step === 7 ? 'busy' : step >= 6 ? 'sleepy' : 'idle';
  const stage = newCat ? (lang === 'zh' ? '幼猫' : 'Kitten') : step >= 6 ? (lang === 'zh' ? '老年' : 'Elder') : (lang === 'zh' ? '幼猫' : 'Kitten');
  const dialog = step <= 5;
  const listView = step >= 5;

  const field = (label: string, children: ReactNode, highlight = false) => (
    <div className="flex items-start gap-3">
      <span className="w-12 shrink-0 pt-1.5 text-[11px] text-zinc-500">{label}</span>
      <div className={`min-w-0 flex-1 rounded-lg border px-2.5 py-1.5 text-[12px] text-zinc-800 transition-colors ${highlight ? 'border-zinc-500' : 'border-zinc-200'}`}>{children}</div>
    </div>
  );

  return (
    <Body>
      <Rail name={name} mood={mood} stage={stage} status={step >= 6 && !newCat ? s.tired : t.demo.status.idle} sessions={baseline} notes={0} />
      <Main>
        <TopBar name={name} mood={mood} gen={gen} agent="claude" model="Opus 5.5" alarm={step === 0} />
        <AnimatePresence>
          {step === 6 && <Toast>{s.tired}</Toast>}
          {step >= 8 && <Toast tone="brand">🐾 {s.handoff}</Toast>}
        </AnimatePresence>
        <div className="relative flex min-h-0 flex-1 flex-col">
          <Timeline>
            <UserBubble>{s.ask}</UserBubble>
            <ProcessedRow text={t.demo.dispatch.processed(4, 1)} />
            <AssistantText>{s.answer}</AssistantText>
            <ToolRow done command={s.cli} />
            {step === 7 && (
              <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} className="rounded-xl border border-zinc-200 bg-white p-3">
                <div className="flex items-center gap-2 text-[12px] font-semibold text-zinc-800"><Kitten mood="sleepy" size={26} />{s.ceremonyTitle}</div>
                <Ceremony labels={s.ceremony} />
              </motion.div>
            )}
          </Timeline>

          {/* 定时任务列表（保存后常驻在时间线底部） */}
          <AnimatePresence>
            {listView && !dialog && (
              <motion.div initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} className="mx-3 mb-3 rounded-xl border border-zinc-200 bg-white p-2.5 sm:mx-6">
                <div className="mb-1.5 flex items-center gap-1.5 px-1 text-[11.5px] font-semibold text-zinc-700"><Repeat size={12} />{s.title}</div>
                <ScheduleRow title={s.name} when={s.cronHuman} target={s.target} migrated={step >= 9 ? s.migrated : undefined} highlight={step >= 9} />
                <ScheduleRow title={s.second} when={s.every} target={name} />
              </motion.div>
            )}
          </AnimatePresence>
          <Composer placeholder={t.demo.composer.placeholderMain} toolbar={<><ToolbarChip><AgentIcon id="claude" size={12} />Opus 5.5</ToolbarChip><ToolbarChip>high</ToolbarChip></>} />

          {/* 定时任务弹窗 */}
          <AnimatePresence>
            {dialog && (
              <motion.div key="dialog" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="absolute inset-0 z-20 grid place-items-center bg-black/25 p-3">
                <motion.div initial={{ opacity: 0, scale: 0.97, y: 8 }} animate={{ opacity: 1, scale: 1, y: 0 }} exit={{ opacity: 0, scale: 0.97 }} transition={{ duration: 0.22, ease: easeOut }} className="w-full max-w-[440px] rounded-2xl border border-zinc-200 bg-white p-4 shadow-[0_24px_60px_-12px_rgb(0_0_0/.4)]">
                  <div className="mb-3 flex items-center justify-between">
                    <span className="flex items-center gap-2 text-[14px] font-semibold text-zinc-900"><Repeat size={14} />{s.title}</span>
                    <X size={14} className="text-zinc-400" />
                  </div>
                  {listView ? (
                    <div className="flex flex-col gap-1">
                      <ScheduleRow title={s.name} when={s.cronHuman} target={s.target} fresh />
                      <ScheduleRow title={s.second} when={s.every} target={name} />
                    </div>
                  ) : (
                    <div className="flex flex-col gap-2.5">
                      {field(s.fields.name, step >= 1 ? <Typewriter text={s.name} duration={500} caret={false} /> : <span className="text-zinc-300">—</span>, step === 1)}
                      {field(s.fields.prompt, step >= 1 ? <Typewriter text={s.prompt} duration={1300} caret={step === 1} /> : <span className="text-zinc-300">—</span>, step === 1)}
                      {field(s.fields.when, (
                        <span className="flex items-center gap-2">
                          <span className="flex rounded-md bg-zinc-900/[.05] p-0.5 text-[10.5px]"><span className="rounded bg-white px-1.5 shadow-sm">{s.cronTab}</span><span className="px-1.5 text-zinc-500">{s.everyTab}</span></span>
                          <span className="font-dock">{step >= 2 ? s.cron : ''}</span>
                          {step >= 2 && <span className="truncate text-[11px] text-zinc-400">{s.cronHuman}</span>}
                        </span>
                      ), step === 2)}
                      {field(s.fields.target, (
                        <span className="flex flex-col gap-1">
                          <span className={`flex items-center gap-2 rounded-md px-1.5 py-1 transition-colors ${step >= 3 ? 'bg-brand/10 text-zinc-900' : ''}`}>
                            <span className={`grid h-3.5 w-3.5 place-items-center rounded-full border ${step >= 3 ? 'border-brand' : 'border-zinc-300'}`}>{step >= 3 && <span className="h-1.5 w-1.5 rounded-full bg-brand" />}</span>
                            <span className="truncate">{s.target}</span>
                            <span className="ml-auto shrink-0 text-[10.5px] text-zinc-400">{s.targetHint}</span>
                          </span>
                          <span className="flex items-center gap-2 px-1.5 py-0.5 text-zinc-400"><span className="h-3.5 w-3.5 rounded-full border border-zinc-300" />{s.fields.other}</span>
                        </span>
                      ), step === 3)}
                      <div className="mt-1 flex items-center justify-between">
                        <span className="text-[11px] text-zinc-500">{s.next} · <span className="text-zinc-800">{step >= 2 ? s.nextValue : '—'}</span></span>
                        <Pulse on={step === 4} rounded="rounded-full"><span className="rounded-full bg-zinc-900 px-4 py-1.5 text-[12px] font-medium text-white">{s.save}</span></Pulse>
                      </div>
                    </div>
                  )}
                </motion.div>
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      </Main>
    </Body>
  );
}

function ScheduleRow({ title, when, target, migrated, highlight, fresh }: { title: string; when: string; target: string; migrated?: string; highlight?: boolean; fresh?: boolean }) {
  return (
    <motion.div layout initial={fresh ? { opacity: 0, y: 6 } : false} animate={{ opacity: 1, y: 0 }} className={`flex items-center gap-2 rounded-lg px-2 py-1.5 text-[11.5px] transition-colors duration-500 ${highlight ? 'bg-emerald-50' : ''}`}>
      <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-emerald-500" />
      <span className="min-w-0 flex-1 truncate font-medium text-zinc-800">{title}</span>
      <span className="hidden shrink-0 font-dock text-[10.5px] text-zinc-500 sm:inline">{when}</span>
      <span className="flex min-w-0 shrink items-center gap-1 truncate rounded-full bg-zinc-900/[.05] px-2 py-0.5 text-[10.5px] text-zinc-600">
        <span className="truncate">{target}</span>
        <AnimatePresence>
          {migrated && (
            <motion.span initial={{ opacity: 0, width: 0 }} animate={{ opacity: 1, width: 'auto' }} className="flex shrink-0 items-center gap-0.5 overflow-hidden whitespace-nowrap text-emerald-600 dark:text-emerald-300">
              <Check size={10} strokeWidth={3} />{migrated}
            </motion.span>
          )}
        </AnimatePresence>
      </span>
    </motion.div>
  );
}
