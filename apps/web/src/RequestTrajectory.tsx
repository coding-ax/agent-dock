import { useMemo, useState, type ReactNode } from 'react';
import { AlertTriangle, ChevronDown, ChevronRight, LoaderCircle, Sparkles, Wrench } from 'lucide-react';
import type { Task, TurnRange } from './api';
import { buildRoundActivity, processSummary, type RequestPayload, type RequestRound, type RequestRoundActivity, type RequestScope, type RequestTrajectory, type RoundActivityGap } from './session-request-log';
import { ActivityPanel, TimelineItem } from './TimelineItems';
import { useRoundProcess } from './useRoundProcess';
import type { TimelineEvent } from './timeline';

/** 折叠阈值：超过这个字数的文本默认收起来，避免长提示词把轨迹刷屏。 */
const COLLAPSE_THRESHOLD = 240;

/**
 * 面板之外的事实，逐轮渲染要用：`sessionId` 必填不是形式——漏传它会让 MarkdownContent 里的
 * `.agentdock/uploads` 图片退化成宿主机绝对路径（图片必坏且泄漏 home 目录），而 TimelineItem
 * 的 sessionId 是可选的，tsc 抓不到，所以在这一层收紧。
 * `eventsSaved` / `turns` 决定「为什么没有过程」该怎么说，不能让渲染层自己猜。
 */
export type RequestTrajectoryContext = { sessionId: string; turns: TurnRange[]; eventsSaved: boolean };

const taskStatusLabels: Record<string, string> = {
  queued: '排队中',
  running: '执行中',
  completed: '已完成',
  failed: '失败',
  interrupted: '已打断',
  cancelled: '已取消'
};

const taskStatusTones: Record<string, string> = {
  completed: 'bg-emerald-500',
  failed: 'bg-red-500',
  running: 'bg-amber-500'
};

/** 每轮实际发送给 Agent 的请求，按轮次排成一条竖向轨迹。 */
export function RequestTrajectoryView({ trajectory, context, wrap }: { trajectory: RequestTrajectory; context: RequestTrajectoryContext; wrap: boolean }) {
  const { rounds } = trajectory;
  const [status, setStatus] = useState('all');
  const counts = useMemo(() => {
    const byStatus = new Map<string, number>();
    for (const round of rounds) byStatus.set(round.status, (byStatus.get(round.status) ?? 0) + 1);
    return byStatus;
  }, [rounds]);
  const shown = status === 'all' ? rounds : rounds.filter(round => round.status === status);
  return <div className="font-sans">
    <div className="mb-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-[10px] text-zinc-500">
      <span className="tabular-nums">{rounds.length} 轮</span>
      <span aria-hidden className="text-zinc-300">·</span>
      <span className="tabular-nums">{trajectory.sentRounds} 轮保存了实际请求</span>
      <span aria-hidden className="text-zinc-300">·</span>
      <span>旧任务未保存的请求无法还原</span>
    </div>
    {counts.size > 1 && <div className="mb-3 flex flex-wrap items-center gap-1">
      <FilterChip active={status === 'all'} count={rounds.length} onClick={() => setStatus('all')}>全部</FilterChip>
      {[...counts].map(([key, count]) => <FilterChip key={key} active={status === key} count={count} onClick={() => setStatus(key)}>{taskStatusLabels[key] ?? key}</FilterChip>)}
    </div>}
    <ol className="m-0 list-none p-0">
      <TrajectoryNode last={shown.length === 0} tone="bg-sky-500"><ScopeCard scope={trajectory.scope} wrap={wrap}/></TrajectoryNode>
      {shown.map((round, index) => <TrajectoryNode key={round.id} last={index === shown.length - 1} tone={taskStatusTones[round.status] ?? 'bg-zinc-300'}>
        <RoundCard round={round} context={context} modelLabel={trajectory.scope.modelLabel} wrap={wrap}/>
      </TrajectoryNode>)}
    </ol>
    {rounds.length === 0 && <div className="pl-5 text-zinc-500">当前会话还没有任务。</div>}
    {rounds.length > 0 && shown.length === 0 && <div className="pl-5 text-zinc-500">当前筛选下没有轮次。</div>}
  </div>;
}

function FilterChip({ active, count, onClick, children }: { active: boolean; count: number; onClick: () => void; children: ReactNode }) {
  return <button type="button" aria-pressed={active} onClick={onClick} className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] ${active ? 'border-zinc-300 bg-white text-zinc-900 shadow-sm' : 'border-transparent text-zinc-500 hover:bg-zinc-100 hover:text-zinc-800'}`}>
    {children}<span className="tabular-nums text-zinc-400">{count}</span>
  </button>;
}

function TrajectoryNode({ tone, last, children }: { tone: string; last: boolean; children: ReactNode }) {
  return <li className="relative pb-3 pl-5">
    {!last && <span aria-hidden className="absolute bottom-0 left-[3px] top-4 w-px bg-zinc-200"/>}
    <span aria-hidden className={`absolute left-0 top-[5px] h-[7px] w-[7px] rounded-full ${tone}`}/>
    {children}
  </li>;
}

function ScopeCard({ scope, wrap }: { scope: RequestScope; wrap: boolean }) {
  return <section>
    <NodeHeader title="会话创建" meta={scope.systemPrompt ? `${scope.systemPrompt.length} 字 System Prompt` : undefined}/>
    {scope.systemPrompt
      ? <TextBlock label="会话级 System Prompt" text={scope.systemPrompt} wrap={wrap}/>
      : <p className="m-0 text-[11px] text-zinc-500">未设置或旧会话未保存 System Prompt。</p>}
  </section>;
}

function RoundCard({ round, context, modelLabel, wrap }: { round: RequestRound; context: RequestTrajectoryContext; modelLabel: string; wrap: boolean }) {
  const { payload } = round;
  return <section className="rounded-lg border border-zinc-200 bg-white">
    <div className="flex flex-wrap items-center gap-x-2 gap-y-1 border-b border-zinc-100 px-2.5 py-1.5">
      <span className="text-[11px] font-medium text-zinc-800">第 {round.index} 轮</span>
      <span className="tabular-nums text-[10px] text-zinc-400" title={round.createdAt}>{formatClock(round.createdAt)}</span>
      <span className="rounded bg-zinc-100 px-1.5 py-0.5 text-[10px] text-zinc-600">{taskStatusLabels[round.status] ?? round.status}</span>
      {payloadBadge(payload)}
      <span className="ml-auto truncate font-mono text-[10px] text-zinc-400" title={round.id}>{round.id}</span>
    </div>
    <div className="flex flex-col gap-2 px-2.5 py-2">
      {payload.state === 'sent' && payload.form === 'injected' ? <>
        <Caption>实际发送 = 注入内容 + 用户可见，按此顺序拼接，共 {payload.text.length} 字。</Caption>
        <TextBlock label="注入内容" text={payload.prefix} wrap={wrap} tone="injected" forceCollapsed/>
        <TextBlock label="用户可见" text={round.visiblePrompt} wrap={wrap}/>
      </> : payload.state === 'sent' && payload.form === 'identical'
        ? <TextBlock label="实际发送 = 用户可见" text={payload.text} wrap={wrap}/>
        : <>
          <TextBlock label="用户可见" text={round.visiblePrompt} wrap={wrap}/>
          <PayloadDetail payload={payload} wrap={wrap}/>
        </>}
    </div>
    <RoundActivity round={round} context={context} modelLabel={modelLabel}/>
  </section>;
}

/** 「为什么没有过程」的三种说法。用户要能据此判断是数据没了、还是这一轮本来就空。 */
const gapCopy: Record<RoundActivityGap, string> = {
  'no-events-saved': '这个会话没有保存事件，无法还原这一轮的过程。',
  'no-anchor': '这一轮早于轮次锚点，无法确定它的事件范围。',
  'no-events-this-round': '这一轮没有留下过程事件。'
};

/**
 * 一轮的最终输出与过程。默认只显示最终输出——落库的那段（runtime 判终态时存下的），
 * 没有就从这一轮的过程事件里还原（历史任务没有那一列）。
 * 思考与工具调用要用户点开才请求：一轮可能有几十万行事件，面板打开时不该逐个拉。
 */
function RoundActivity({ round, context, modelLabel }: { round: RequestRound; context: RequestTrajectoryContext; modelLabel: string }) {
  const bounds = useMemo(() => context.turns.find(turn => turn.taskId === round.id), [context.turns, round.id]);
  // 排队/取消的轮次没交给 Agent，不显示过程入口；请求未保存的历史任务照样有过程可看。
  const hasProcess = round.payload.state !== 'not-sent' && round.processEvents > 0;
  // 自动拉不自动拉由纯函数定（见 session-request-log 的 AUTO_LOAD_ROUNDS）：只在「没有落库的
  // 最终输出、过程又便宜」时替用户拉一次，剩下的等他自己展开。
  const process = useRoundProcess({ sessionId: context.sessionId, taskId: round.id, bounds, autoLoad: round.autoLoadProcess });
  const activity = useMemo<RequestRoundActivity>(() => {
    const task = roundTask(round, context.sessionId);
    return process.loaded
      ? buildRoundActivity(task, { state: 'events', events: process.events })
      : buildRoundActivity(task, { state: 'missing', reason: unfetchedReason(context, round) });
  }, [process.loaded, process.events, context, round]);

  const summary = processSummary(activity);
  const storedFinal = round.finalText;
  const recoveredFinal = !storedFinal && activity.state === 'available' ? activity.final?.data.text ?? undefined : undefined;
  const finalText = storedFinal ?? recoveredFinal;
  const finalEvent = useMemo<TimelineEvent | undefined>(() => finalText
    ? { id: `round-final-${round.id}`, sequence: -1, type: 'text', timestamp: round.updatedAt, data: { text: finalText, role: 'assistant' } }
    : undefined, [finalText, round.id, round.updatedAt]);
  const missingFinal = finalEvent || round.payload.state === 'not-sent'
    ? undefined
    : activity.state === 'available' ? '本轮没有产生最终输出。'
      // 两种缺法分开说：没有最终输出是记录里就没有，过程缺失另有原因，不能混成一句。
      // 过程还在的轮次（没自动拉的那些）要告诉用户去哪儿找，否则「没有最终输出」看着像丢了。
      : activity.state === 'unavailable' ? `没有存下这一轮的最终输出；${gapCopy[activity.reason]}${hasProcess ? '展开下面的过程可以看到它。' : ''}`
        : undefined;

  return <div className="border-t border-zinc-100 px-2.5 py-2">
    {finalEvent
      ? <TimelineItem event={finalEvent} final sessionId={context.sessionId} assistantLabel={modelLabel}/>
      : missingFinal && <p className="m-0 text-[11px] text-zinc-500">{missingFinal}</p>}
    {recoveredFinal && <p className="m-0 mt-1 text-[10px] text-zinc-400">最终输出取自本轮过程事件，记录里没有单独保存。</p>}
    {hasProcess && <details open={process.open} className="mt-2 border-t border-zinc-100">
      <summary onClick={event => { event.preventDefault(); process.toggle(); }} className="flex cursor-pointer select-none items-center gap-1.5 py-1.5 text-[11px] font-medium text-zinc-600 outline-none transition-colors hover:text-zinc-800">
        <Wrench size={12} className="shrink-0 text-zinc-400"/><span>思考与工具调用</span>
        {summary && <span className="tabular-nums text-[10px] font-normal text-zinc-400">{summary}</span>}
        {process.open ? <ChevronDown size={12} className="ml-auto shrink-0 text-zinc-400"/> : <ChevronRight size={12} className="ml-auto shrink-0 text-zinc-400"/>}
      </summary>
      {process.open && <div className="pt-1">
        {process.error && <p role="alert" className="m-0 mb-1 flex items-center gap-2 text-[11px] text-red-600">{process.error}
          {!process.loaded && <button type="button" onClick={process.retry} className="rounded border border-red-200 px-1.5 py-0.5 text-[10px] hover:bg-red-50">重试</button>}
        </p>}
        {!process.loaded && process.loading && <p className="m-0 flex items-center gap-1.5 text-[11px] text-zinc-500"><LoaderCircle size={12} className="animate-spin"/>读取这一轮的事件…</p>}
        {activity.state === 'available'
          ? <ActivityPanel groups={activity.groups} ongoing={false} sessionId={context.sessionId} hasAnswer={activity.hasAnswer} taskStatus={activity.taskStatus} modelLabel={modelLabel} startedAt={activity.startedAt} completedAt={activity.completedAt}/>
          : process.loaded && activity.state === 'unavailable' && <p className="m-0 text-[11px] text-zinc-500">{gapCopy[activity.reason]}</p>}
        {process.truncated && <button type="button" disabled={process.loading} onClick={process.loadMore} className="mt-1 rounded border border-zinc-300 px-1.5 py-0.5 text-[10px] text-zinc-600 hover:bg-zinc-100 disabled:opacity-50">{process.loading ? '读取中…' : '加载剩余事件'}</button>}
      </div>}
    </details>}
  </div>;
}

/** RequestRound 是视图模型，timeline 的判定入口要的是任务本身——在这里显式投影，不猜字段。 */
function roundTask(round: RequestRound, sessionId: string): Task {
  return { id: round.id, sessionId, prompt: round.visiblePrompt, status: round.status, createdAt: round.createdAt, updatedAt: round.updatedAt };
}

function unfetchedReason(context: RequestTrajectoryContext, round: RequestRound): RoundActivityGap {
  // 锚点图是按会话一次算出来的：认得出这一轮就是锚点齐全、边界明确，只是这一轮没有过程事件；
  // 认不出则要么是早于锚点的旧数据，要么这个会话根本没保存过事件。
  if (context.turns.some(turn => turn.taskId === round.id)) return 'no-events-this-round';
  return context.eventsSaved ? 'no-anchor' : 'no-events-saved';
}

function PayloadDetail({ payload, wrap }: { payload: RequestPayload; wrap: boolean }) {
  if (payload.state === 'not-sent') return <p className="m-0 text-[11px] text-zinc-500">未发送给 Agent：任务还在排队，或已被取消。</p>;
  if (payload.state === 'unavailable') return <p className="m-0 text-[11px] text-zinc-500">历史任务未保存实际请求，无法还原。</p>;
  if (payload.form === 'unrelated') return <div className="flex flex-col gap-1.5">
    <p className="m-0 flex items-start gap-1 text-[11px] text-red-600"><AlertTriangle size={12} className="mt-0.5 shrink-0"/>保存的实际请求与可见文本没有包含关系，无法把差异归因成注入，下面原样展示。</p>
    <TextBlock label="实际发送（原文）" text={payload.text} wrap={wrap}/>
  </div>;
  return undefined;
}

function payloadBadge(payload: RequestPayload) {
  if (payload.state === 'not-sent') return <span className="rounded bg-zinc-100 px-1.5 py-0.5 text-[10px] text-zinc-500">未发送</span>;
  if (payload.state === 'unavailable') return <span className="rounded bg-zinc-100 px-1.5 py-0.5 text-[10px] text-zinc-500">请求未保存</span>;
  if (payload.form === 'injected') return <span className="inline-flex items-center gap-0.5 rounded bg-sky-50 px-1.5 py-0.5 text-[10px] text-sky-700"><Sparkles size={10}/>注入 {payload.prefix.length} 字</span>;
  if (payload.form === 'unrelated') return <span className="inline-flex items-center gap-0.5 rounded bg-red-50 px-1.5 py-0.5 text-[10px] text-red-600"><AlertTriangle size={10}/>正文不一致</span>;
  return undefined;
}

function NodeHeader({ title, meta }: { title: string; meta?: string }) {
  return <div className="mb-1.5 flex items-center gap-2 pt-0.5">
    <span className="text-[11px] font-medium text-zinc-800">{title}</span>
    {meta && <span className="tabular-nums text-[10px] text-zinc-500">{meta}</span>}
  </div>;
}

function Caption({ children }: { children: ReactNode }) {
  return <p className="m-0 text-[11px] text-zinc-500">{children}</p>;
}

// tone：injected 表示这段是 AgentDock 自己拼进去的（与「会话创建」节点同色系），
// plain 是用户自己写的原文。两者必须一眼能分开，否则看不出哪部分不是人写的。
function TextBlock({ label, text, wrap, tone = 'plain', forceCollapsed = false }: { label: string; text: string; wrap: boolean; tone?: 'plain' | 'injected'; forceCollapsed?: boolean }) {
  const long = text.length > COLLAPSE_THRESHOLD;
  const [expanded, setExpanded] = useState(!long && !forceCollapsed);
  const shown = expanded ? text : text.slice(0, COLLAPSE_THRESHOLD);
  const injected = tone === 'injected';
  return <div key={label} className={`rounded-md border ${injected ? 'border-sky-200 border-l-2 border-l-sky-400 bg-sky-50/50' : 'border-zinc-200 bg-zinc-50'}`}>
    <div className={`flex items-center gap-2 border-b px-2 py-1 ${injected ? 'border-sky-100' : 'border-zinc-200/80'}`}>
      {injected && <Sparkles size={10} className="shrink-0 text-sky-500"/>}
      <span className={`text-[10px] ${injected ? 'text-sky-700' : 'text-zinc-500'}`}>{label}</span>
      <span className={`tabular-nums text-[10px] ${injected ? 'text-sky-600/70' : 'text-zinc-400'}`}>{text.length} 字</span>
      {(long || forceCollapsed) && <button type="button" aria-expanded={expanded} onClick={() => setExpanded(value => !value)} className={`ml-auto inline-flex items-center gap-0.5 rounded px-1 py-0.5 text-[10px] ${injected ? 'text-sky-700 hover:bg-sky-100' : 'text-zinc-500 hover:bg-zinc-200/60 hover:text-zinc-900'}`}>
        {expanded ? <ChevronDown size={11}/> : <ChevronRight size={11}/>}{expanded ? '收起' : '展开'}
      </button>}
    </div>
    <pre className={`m-0 px-2 py-1.5 font-mono text-[11px] leading-5 ${injected ? 'text-zinc-600' : 'text-zinc-700'} ${wrap ? 'whitespace-pre-wrap break-words' : 'overflow-x-auto whitespace-pre'}`}>{shown}{!expanded && '…'}</pre>
  </div>;
}

function formatClock(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleTimeString('zh-CN', { hour12: false });
}
