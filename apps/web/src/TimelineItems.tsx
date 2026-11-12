import { AlertTriangle, BookOpen, BrainCircuit, Check, ChevronRight, CircleStop, CircleX, Database, FilePenLine, FlaskConical, GitBranch, Globe2, MessageSquare, Search, Square, StickyNote, Terminal, Users, Wrench } from 'lucide-react';
import { memo, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Spinner } from './Loaders';
import { buildActivitySteps, thinkingTitle, eventRenderSignature, groupRenderSignature, type ActivityStep, type TimelineActivityGroup, type TimelineEvent } from './timeline';
import { MarkdownContent } from './MarkdownContent';
import { AssistantMarkdown, ThinkingMarkdown } from './TypewriterText';
import { elapsedMilliseconds, formatElapsed, summarizeTools, toolActionLabel, toolPresentation, type ToolKind } from './tool-presentation';
import { toolDetailView, type ToolDetailView } from './tool-detail';
import { SupervisionNotice } from './companion/SupervisionNotice';

/**
 * 时间线的渲染单元。原先这些组件都藏在 SessionPane 内部，只有它能用；「实际请求」轨迹面板
 * 要做到「某一轮的最终输出」和「展开看这一轮的过程」跟主时间线长得一样、判定一致，就得共用
 * 同一批组件，于是搬到这里。只导出 TimelineItem 与 ActivityPanel 两个入口。
 */

function ToolKindIcon({ kind, size = 16 }: { kind: ToolKind; size?: number }) {
  if (kind === 'read') return <BookOpen size={size}/>;
  if (kind === 'edit') return <FilePenLine size={size}/>;
  if (kind === 'search') return <Search size={size}/>;
  if (kind === 'web') return <Globe2 size={size}/>;
  if (kind === 'git') return <GitBranch size={size}/>;
  if (kind === 'test') return <FlaskConical size={size}/>;
  if (kind === 'database') return <Database size={size}/>;
  if (kind === 'agent') return <Users size={size}/>;
  if (kind === 'note') return <StickyNote size={size}/>;
  if (kind === 'terminal') return <Terminal size={size}/>;
  return <Wrench size={size}/>;
}

const isToolTerminal = (event: TimelineEvent) => event.data.status === 'completed' || event.data.status === 'failed';

/** 展开容器：grid-template-rows 0fr → 1fr 加透明度，内容常驻 DOM，避免高度跳变。
 *  首次展开前不渲染内容（历史长会话默认折叠时不必为每一步建 DOM）；展开过之后保留，才能播收起动画。 */
function Disclosure({ open, children }: { open: boolean; children: ReactNode }) {
  const [everOpened, setEverOpened] = useState(open);
  if (open && !everOpened) setEverOpened(true);
  return <div aria-hidden={!open} inert={!open} className={`grid transition-[grid-template-rows,opacity] duration-200 ease-[cubic-bezier(.2,0,0,1)] ${open ? 'grid-rows-[1fr] opacity-100' : 'grid-rows-[0fr] opacity-0'}`}>
    <div className="overflow-hidden">{everOpened ? children : null}</div>
  </div>;
}

/** 命令输出默认只露最后 40 行，避免一次工具调用把整条时间线撑开。 */
function CommandOutput({ text }: { text: string }) {
  const [showAll, setShowAll] = useState(false);
  const lines = text.split('\n');
  const truncated = !showAll && lines.length > 40;
  return <div>
    <pre className="m-0 max-h-60 overflow-auto whitespace-pre-wrap break-words rounded-md bg-zinc-50 p-2.5 font-mono text-[12px] leading-5 text-zinc-600">{truncated ? lines.slice(-40).join('\n') : text}</pre>
    {truncated && <button type="button" onClick={() => setShowAll(true)} className="mt-1 rounded px-1 py-0.5 text-[12px] text-zinc-500 transition-colors hover:bg-zinc-100 hover:text-zinc-900">显示全部（{lines.length} 行）</button>}
  </div>;
}

function CollapsibleOutput({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  const lines = text.split('\n');
  return <div>
    <button type="button" aria-expanded={open} onClick={() => setOpen(value => !value)} className="flex items-center gap-1 rounded px-1 py-0.5 text-[12px] text-zinc-500 transition-colors hover:bg-zinc-100 hover:text-zinc-900"><ChevronRight size={12} className={`transition-transform duration-200 ${open ? 'rotate-90' : ''}`}/>输出{lines.length > 0 ? `（${lines.length} 行）` : ''}</button>
    <Disclosure open={open}><CommandOutput text={text}/></Disclosure>
  </div>;
}

function ToolDetail({ view }: { view: ToolDetailView }) {
  if (view.kind === 'command') return <div className="space-y-1.5 py-1">
    <div className="flex items-start gap-2">
      <span aria-hidden="true" className="shrink-0 font-mono text-[12px] leading-5 text-zinc-400">$</span>
      <code className="min-w-0 flex-1 whitespace-pre-wrap break-all font-mono text-[12px] leading-5 text-zinc-700">{view.command}</code>
      {view.exitCode !== undefined && <span className={`shrink-0 rounded px-1.5 py-0.5 font-mono text-[12px] leading-4 ${view.exitCode === 0 ? 'bg-emerald-50 text-emerald-700' : 'bg-red-50 text-red-700'}`}>exit {view.exitCode}</span>}
    </div>
    {view.output ? <CommandOutput text={view.output}/> : null}
  </div>;

  if (view.kind === 'diff') return <div className="space-y-1.5 py-1">
    {view.path && <div className="truncate font-mono text-[12px] text-zinc-500">{view.path}</div>}
    {view.note ? <div className="text-[12px] text-zinc-500">{view.note}</div> : <div className="max-h-60 overflow-auto rounded-md border border-zinc-200 bg-zinc-50 py-1 font-mono text-[12px] leading-5">
      {view.lines.map((line, index) => <div key={index} className={`whitespace-pre-wrap break-words px-2.5 ${line.kind === 'add' ? 'bg-emerald-500/10 text-emerald-800' : line.kind === 'remove' ? 'bg-red-500/10 text-red-700' : line.kind === 'meta' ? 'text-zinc-400' : 'text-zinc-600'}`}>{line.kind === 'add' ? '+' : line.kind === 'remove' ? '-' : ' '}{line.text}</div>)}
    </div>}
  </div>;

  if (view.kind === 'paths') return <div className="space-y-1.5 py-1">
    {view.items.length > 0 && <div className="flex flex-wrap gap-1.5">{view.items.map(item => <code key={item} title={item} className="max-w-full truncate rounded bg-zinc-100 px-1.5 py-0.5 font-mono text-[12px] text-zinc-600">{item}</code>)}</div>}
    {view.output ? <CollapsibleOutput text={view.output}/> : null}
  </div>;

  return <pre className="m-0 my-1 max-h-60 overflow-auto whitespace-pre-wrap break-words rounded-md border border-zinc-200 bg-zinc-50 p-2.5 font-mono text-[12px] leading-5 text-zinc-600">{JSON.stringify({ ...(view.input !== undefined ? { input: view.input } : {}), ...(view.output !== undefined ? { output: view.output } : {}) }, null, 2)}</pre>;
}

const ToolCard = memo(function ToolCard({ event }: { event: TimelineEvent }) {
  const [open, setOpen] = useState(false);
  const terminal = isToolTerminal(event);
  const failed = event.data.status === 'failed';
  const hasDetails = event.data.input !== undefined || event.data.output !== undefined;
  const presentation = toolPresentation(event.data);
  const elapsed = formatElapsed(elapsedMilliseconds(event.data.startedAt ?? event.timestamp, terminal ? event.data.completedAt ?? event.timestamp : undefined));
  const tone = failed ? 'text-red-500' : terminal ? 'text-zinc-400' : 'text-zinc-500';
  return <div className="ui-timeline-item">
    <button type="button" data-timeline-disclosure aria-expanded={open} disabled={!hasDetails} onClick={() => setOpen(value => !value)} className="group/tool flex min-h-8 w-full items-center gap-2 rounded-md px-1 py-1 text-left text-[12px] text-zinc-500 transition-colors hover:bg-zinc-50 disabled:cursor-default disabled:hover:bg-transparent">
      <ToolKindIcon kind={presentation.kind} size={13}/><span className="min-w-0 flex-1 truncate">{presentation.label}{presentation.detail && <span title={presentation.detail} className="ml-1.5 font-mono text-zinc-400">{presentation.detail}</span>}</span>
      <span className={`flex shrink-0 items-center gap-1.5 whitespace-nowrap tabular-nums ${failed ? 'text-red-500' : 'text-zinc-400'}`}>{elapsed && <span>{elapsed}</span>}{!terminal && <Spinner size={12}/>}{failed && <span>失败</span>}{hasDetails && <ChevronRight size={12} className={`transition-transform duration-200 ${open ? 'rotate-90' : ''}`}/>}</span>
    </button>
    <Disclosure open={open}>{hasDetails && <div className="mb-1 pl-2.5"><div className="border-l border-zinc-200 pl-3"><ToolDetail view={toolDetailView(event.data)}/></div></div>}</Disclosure>
  </div>;
}, (prev, next) => eventRenderSignature(prev.event) === eventRenderSignature(next.event));

/** 一行可展开的步骤：只露一句话描述 + 状态，点开才看细节。展开状态完全由用户决定，不随流式输出自动开合。 */
function StepDisclosure({ icon, title, subtitle, meta, running, failed, children }: { icon: ReactNode; title: ReactNode; subtitle?: ReactNode; meta?: ReactNode; running: boolean; failed?: boolean; children?: ReactNode }) {
  const [open, setOpen] = useState(false);
  const hasBody = children !== undefined && children !== null && children !== false;
  return <div className="ui-timeline-item relative">
    <button type="button" data-timeline-disclosure aria-expanded={open} disabled={!hasBody} onClick={() => setOpen(value => !value)} className="group/step flex min-h-8 w-full items-start gap-2 py-1 text-left text-[13px] text-zinc-500 transition-colors hover:text-zinc-900 disabled:cursor-default disabled:hover:text-zinc-500">
      <span className={`relative z-10 mt-0.5 grid h-4 w-4 shrink-0 place-items-center bg-canvas ${failed ? 'text-red-500' : running ? 'text-zinc-800' : 'text-zinc-400'}`}>{icon}</span>
      <span className="min-w-0 flex-1">
        <span className="flex min-w-0 items-center gap-2">
          <span className={`min-w-0 truncate ${running ? 'ui-shimmer-text font-medium' : ''}`}>{title}</span>
          {meta && <span className="ml-auto shrink-0 whitespace-nowrap text-[12px] tabular-nums text-zinc-400">{meta}</span>}
          {hasBody && <ChevronRight size={12} className={`shrink-0 text-zinc-400 transition-transform duration-200 ${open ? 'rotate-90' : ''}`}/>}
        </span>
        {subtitle && <span className="mt-0.5 block truncate font-mono text-[12px] leading-4 text-zinc-400">{subtitle}</span>}
      </span>
    </button>
    <Disclosure open={open}>{hasBody && <div className="mb-0.5 pl-6"><div className="border-l border-zinc-200 pl-3">{children}</div></div>}</Disclosure>
  </div>;
}

/** 进行中的行每秒刷新一次「已耗时」：没有新事件到达时组件不会重渲染，耗时就会卡在第一次渲染的值上。 */
function useNow(active: boolean) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [active]);
  return now;
}

/**
 * 单个步骤的耗时：从组件第一次以 live 状态挂载开始计时，live 结束时定格。
 * 历史回放的步骤没有可靠的起点，不显示耗时（整轮耗时由折叠行给出）。
 */
function useStepElapsed(live: boolean) {
  const start = useRef<number | undefined>(undefined);
  const [end, setEnd] = useState<number>();
  if (live && start.current === undefined) start.current = Date.now();
  useEffect(() => {
    if (!live && start.current !== undefined) setEnd(current => current ?? Date.now());
  }, [live]);
  const now = useNow(live);
  if (start.current === undefined) return undefined;
  return (end ?? now) - start.current;
}

const ToolsStep = memo(function ToolsStep({ events }: { events: TimelineEvent[] }) {
  const runningEvent = events.find(event => !isToolTerminal(event));
  const running = Boolean(runningEvent);
  const failedCount = events.filter(event => event.data.status === 'failed').length;
  const summary = summarizeTools(events) || `${events.length} 次工具调用`;
  const first = toolPresentation(events[0]!.data);
  const last = events.at(-1)!;
  const current = toolPresentation((runningEvent ?? last).data);
  const now = useNow(running);
  const elapsed = formatElapsed(elapsedMilliseconds(events[0]!.data.startedAt ?? events[0]!.timestamp, running ? undefined : last.data.completedAt ?? last.timestamp, now));
  // 进行中用进行时（「正在运行命令」），已经跑完的项补一句计数；完成后才用汇总（「运行了 3 条命令」）。
  const doneCount = events.filter(isToolTerminal).length;
  const runningLabel = `${toolActionLabel(current, false)}${doneCount ? ` · 已完成 ${doneCount} 项` : ''}`;
  const subtitle = current.detail;
  const meta = <>
    {failedCount > 0 && <span className="text-red-500">{failedCount} 次失败</span>}
    {failedCount > 0 && (events.length > 1 || elapsed) && <span className="mx-1 text-zinc-300">·</span>}
    {events.length > 1 && <span>{events.length} 次</span>}
    {events.length > 1 && elapsed && <span className="mx-1 text-zinc-300">·</span>}
    {elapsed && <span>{elapsed}</span>}
  </>;
  return <StepDisclosure icon={<ToolKindIcon kind={first.kind}/>} running={running} failed={!running && failedCount > 0}
    title={running ? runningLabel : summary}
    subtitle={subtitle}
    meta={meta}>
    <div className="space-y-0.5 py-0.5">{events.map(event => <ToolCard key={event.id} event={event}/>)}</div>
  </StepDisclosure>;
}, (prev, next) => prev.events.length === next.events.length
  && prev.events.every((event, index) => eventRenderSignature(event) === eventRenderSignature(next.events[index]!)));

const ThinkingStep = memo(function ThinkingStep({ event, live, replay, sessionId }: { event: TimelineEvent; live: boolean; replay: boolean; sessionId: string | undefined }) {
  const elapsedValue = formatElapsed(useStepElapsed(live));
  const title = thinkingTitle(event.data.text, live);
  // 结束后没有标题时把耗时并进标题（「已思考 8 秒」）；有标题时耗时放右侧。
  const main = live ? (title ?? '思考中') : (title ?? (elapsedValue ? `已思考 ${elapsedValue}` : '已思考'));
  const meta = title && elapsedValue ? elapsedValue : undefined;
  return <StepDisclosure icon={<BrainCircuit size={16}/>} running={live} title={main} meta={meta}>
    <div className="max-h-80 overflow-y-auto"><ThinkingMarkdown text={event.data.text ?? ''} active={live} replay={replay || !live} sessionId={sessionId}/></div>
  </StepDisclosure>;
}, (prev, next) => prev.live === next.live && prev.replay === next.replay && prev.sessionId === next.sessionId
  && eventRenderSignature(prev.event) === eventRenderSignature(next.event));

function ActivitySteps({ steps, ongoing, replay, sessionId, reservePending = false, pending = false, pendingLabel }: { steps: ActivityStep[]; ongoing: boolean; replay: boolean; sessionId: string | undefined; /** 留出「处理中」这一行的位置，即便此刻不显示。 */ reservePending?: boolean; pending?: boolean; pendingLabel?: string }) {
  const last = steps.at(-1);
  const slot = reservePending || pending;
  return <div className="relative">
    {/* 留空的「处理中」行不画竖线，竖线照旧止于最后一步。 */}
    <span aria-hidden="true" className={`absolute left-2 top-2 w-px bg-zinc-200 ${slot && !pending ? 'bottom-11' : 'bottom-3'}`}/>
    {steps.map(step => {
      const isLast = step === last;
      if (step.kind === 'thinking') return <ThinkingStep key={step.id} event={step.event} live={ongoing && isLast} replay={replay} sessionId={sessionId}/>;
      if (step.kind === 'tools') return <ToolsStep key={step.id} events={step.events}/>;
      const streaming = ongoing && isLast;
      return <div key={step.id} className="relative pl-6"><AssistantMarkdown text={step.event.data.text ?? ''} active={streaming} replay={replay || !streaming} sessionId={sessionId}/></div>;
    })}
    {slot && <div aria-hidden={pending ? undefined : true} className="relative min-h-8 py-1 text-[13px] text-zinc-400">
      {pending && <div className="ui-timeline-item flex min-h-6 items-center pl-6">
        <span className="absolute left-0 top-1/2 grid h-4 w-4 -translate-y-1/2 place-items-center bg-canvas"><span className="h-1.5 w-1.5 rounded-full bg-zinc-400"/></span>
        <span className="ui-shimmer-text">{pendingLabel}</span>
      </div>}
    </div>}
  </div>;
}

export const ActivityPanel = memo(function ActivityPanel({ groups, ongoing, replay = false, sessionId, hasAnswer = false, taskStatus = 'running', modelLabel, startedAt, completedAt }: { groups: TimelineActivityGroup[]; ongoing: boolean; /** 首屏 payload 渲染出来的行：其中的流式文本不做重播动画。 */ replay?: boolean; sessionId: string | undefined; hasAnswer?: boolean; taskStatus?: string; modelLabel: string; startedAt?: string; completedAt?: string }) {
  const steps = useMemo(() => buildActivitySteps(groups), [groups]);
  const [open, setOpen] = useState(false);
  const now = useNow(ongoing);
  const elapsed = formatElapsed(elapsedMilliseconds(startedAt ?? groups[0]?.startedAt, ongoing ? undefined : completedAt ?? groups.at(-1)?.completedAt, now));
  const interrupted = taskStatus === 'interrupted' || taskStatus === 'cancelled';
  const failed = taskStatus === 'failed';
  const incomplete = taskStatus === 'incomplete';
  const missingFinal = !ongoing && !hasAnswer;
  const missingFinalText = interrupted ? '任务已中断，未产生最终输出。' : failed ? '任务执行失败，未产生最终输出。' : 'Agent 未返回最终输出。';
  const last = steps.at(-1);
  // 最后一步不是还在转的思考 / 工具 / 流式正文时（刚发出、或工具刚返回等下一步），给一行加载提示，免得界面像卡住。
  const idle = ongoing && (!last || (last.kind === 'tools' && last.events.every(isToolTerminal)));
  // 「处理中」那一行的位置在「还没有步骤」或「最后一步是工具」期间一直留着，只切换文字显隐：
  // 连续的工具调用会并进同一行，这一行若随每次工具起落增删，整条时间线就跟着上下跳 32px。
  // 最后一步换成思考 / 正文时，新的一行正好顶替它的位置，高度只增不减。
  const reservePending = ongoing && (!last || last.kind === 'tools');

  // 进行中：不套外壳，每一步按输出顺序平铺，正文正常展示。
  if (ongoing) return <section aria-live="polite" aria-label={`${modelLabel} 执行过程`} className="my-3">
    <ActivitySteps steps={steps} ongoing replay={replay} sessionId={sessionId} reservePending={reservePending} pending={idle} pendingLabel={`处理中${elapsed ? ` · ${elapsed}` : ''}`}/>
  </section>;

  // 结束后：中间过程全部收进一行「已处理 xx」，只留最终输出；点开才看完整过程。
  const StatusIcon = interrupted ? Square : failed ? CircleX : incomplete ? AlertTriangle : Check;
  const statusTone = interrupted ? 'text-zinc-400' : failed ? 'text-red-500' : incomplete ? 'text-amber-500' : 'text-emerald-600';
  const statusText = interrupted ? '已取消' : failed ? '已失败' : incomplete ? '未完成' : undefined;
  return <>
    {steps.length > 0 && <div className="ui-timeline-item my-3">
      <button type="button" data-timeline-disclosure aria-expanded={open} onClick={() => setOpen(value => !value)} className="flex min-h-8 w-full items-center gap-2 py-1 text-left text-[13px] text-zinc-500 transition-colors hover:text-zinc-900">
        <StatusIcon size={14} className={`shrink-0 ${statusTone}`}/>
        <span className="whitespace-nowrap">{elapsed ? `已处理 ${elapsed}` : '查看执行过程'}</span>
        <span className="text-zinc-300">·</span>
        <span className="whitespace-nowrap">{steps.length} 步</span>
        {statusText && <span className={`text-[12px] ${statusTone}`}>{statusText}</span>}
        <ChevronRight size={13} className={`ml-auto shrink-0 text-zinc-400 transition-transform duration-200 ${open ? 'rotate-90' : ''}`}/>
      </button>
      <Disclosure open={open}><div className="pb-1 pt-1"><ActivitySteps steps={steps} ongoing={false} replay sessionId={sessionId}/></div></Disclosure>
    </div>}
    {missingFinal && <div role="status" className="ui-timeline-item my-4 flex items-center gap-2 text-[13px] text-zinc-500">{failed ? <CircleX size={14} className="text-red-500"/> : interrupted ? <CircleStop size={14} className="text-zinc-400"/> : <MessageSquare size={14} className={incomplete ? 'text-amber-500' : 'text-zinc-400'}/>}<span>{missingFinalText}</span></div>}
  </>;
}, (prev, next) => prev.ongoing === next.ongoing && prev.sessionId === next.sessionId && prev.hasAnswer === next.hasAnswer
  && prev.taskStatus === next.taskStatus && prev.modelLabel === next.modelLabel
  && prev.startedAt === next.startedAt && prev.completedAt === next.completedAt
  && prev.groups.length === next.groups.length
  && prev.groups.every((group, index) => group.id === next.groups[index]!.id && groupRenderSignature(group) === groupRenderSignature(next.groups[index]!)));

const PermissionCard = memo(function PermissionCard({ event }: { event: TimelineEvent }) {
  return <div className="ui-timeline-item my-4 rounded-xl border border-orange-200 bg-orange-50 px-4 py-3.5">
    <div className="flex items-start gap-3"><span className="mt-0.5 shrink-0 text-orange-700"><Square size={14}/></span><div className="min-w-0 flex-1"><div className="text-sm font-semibold text-zinc-900">操作已拦截</div><p className="mt-1 text-sm leading-6 text-zinc-600">{event.data.title}</p>
      <div className="mt-2 text-xs font-medium text-zinc-500">{event.data.status === 'pending' ? '历史授权请求已失效；当前版本固定使用完全访问' : event.data.status}</div>
    </div></div>
  </div>;
});

export const TimelineItem = memo(function TimelineItem({ event, final = false, streaming = false, replay = false, assistantLabel = 'Agent', sessionId }: { event: TimelineEvent; final?: boolean; streaming?: boolean; /** 首屏 payload 渲染出来的行：其中的流式文本不做重播动画。 */ replay?: boolean; assistantLabel?: string; sessionId?: string }) {
  if (event.type === 'tool_call' || event.type === 'tool_result') return <ToolCard event={event}/>;
  if (event.type === 'permission_request') return <PermissionCard event={event}/>;
  if (event.type === 'warning') return <aside role="status" className="ui-timeline-item my-4 overflow-hidden rounded-xl border border-amber-200 bg-amber-50/60">
    <div className="flex items-start gap-2.5 px-4 py-3"><AlertTriangle size={15} className="mt-0.5 shrink-0 text-amber-700"/><div className="min-w-0"><div className="text-[13px] font-semibold text-amber-950">{event.data.warningKind === 'skill' ? 'Skill 提示' : 'Agent 警告'}</div><div className="mt-1 text-[13px] leading-5 text-amber-800"><MarkdownContent sessionId={sessionId}>{event.data.text ?? ''}</MarkdownContent></div></div></div>
  </aside>;
  if (event.type === 'error') return <aside role="alert" className="ui-timeline-item my-4 overflow-hidden rounded-xl border border-red-200 bg-red-50/60">
    <div className="flex items-start gap-2.5 px-4 py-3"><CircleX size={15} className="mt-0.5 shrink-0 text-red-600"/><div className="min-w-0"><div className="text-[13px] font-semibold text-red-950">Agent 错误</div><div className="mt-1 text-[13px] leading-5 text-red-800"><MarkdownContent sessionId={sessionId}>{event.data.message ?? 'Agent 运行失败'}</MarkdownContent></div></div></div>
  </aside>;
  if (event.type === 'thinking') return null;
  // daemon 注入的督办/提醒：不是用户气泡。每条信号画成一张迷你便签，点了在抽屉里定位；全文可展开。
  if (event.data.origin === 'injected') {
    const detail = typeof event.data.detail === 'string' ? event.data.detail : '';
    return <SupervisionNotice text={event.data.text} detail={detail} timestamp={event.timestamp}/>;
  }
  const user = event.data.role === 'user';
  if (user) {
    const text = markLeadingSlashCommand(stripImageReferenceLines(event.data.text ?? ''));
    // 「发送中」是气泡左侧的绝对定位圆环，对齐最后一行文字：不占位，确认后消失也不会让气泡跳动。
    // 用 bottom 而不是 translate 定位，避免和 animate-spin 的 transform 冲突。
    return <div className="ui-timeline-item my-6 flex justify-end"><div className="relative min-w-0 ui-user-bubble max-w-[80%] rounded-[18px] bg-[rgb(var(--bubble))] px-4 py-2.5 text-[15px] leading-[1.7] text-zinc-900"><MarkdownContent sessionId={sessionId} highlightSlashCommands>{text}</MarkdownContent>{event.data.optimistic && <Spinner size={14} label="发送中" className="absolute bottom-4 right-full mr-2 text-zinc-400"/>}</div></div>;
  }
  // 挂载时已不在流式输出的正文直接给全文。轮次结束时最终回答会从执行面板搬成独立的 final 行（重新挂载），
  // tasks 刷新的空档也可能让它短暂搬回去再搬出来；否则这些早就返回过的内容会从 0 重新打一遍。
  const settled = replay || !streaming;
  // 轮次结束时搬出来的 final 行，内容刚才已经在执行面板里显示过：不重播入场动画，否则回答会先消失再淡入。
  // 首屏历史（replay）照常和其它行一起淡入。
  if (final) return <AssistantMarkdown text={event.data.text ?? ''} active={streaming} replay={settled} final animateEnter={replay} assistantLabel={assistantLabel} sessionId={sessionId}/>;
  return <AssistantMarkdown text={event.data.text ?? ''} active={streaming} replay={settled} assistantLabel={assistantLabel} sessionId={sessionId}/>;
}, (prev, next) => prev.final === next.final && prev.streaming === next.streaming && prev.assistantLabel === next.assistantLabel && prev.sessionId === next.sessionId
  && eventRenderSignature(prev.event) === eventRenderSignature(next.event)
  // error/warning/permission 卡片的 payload 变化也要刷新；text 长度已在签名内。
  && JSON.stringify(prev.event.data.status ?? '') === JSON.stringify(next.event.data.status ?? '')
  && (prev.event.data.message ?? '') === (next.event.data.message ?? '')
  && (prev.event.data.title ?? '') === (next.event.data.title ?? ''));

const imageExtensions = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.svg']);
/** 用户消息开头的 /命令 包成行内代码，交给 MarkdownContent 渲染成命令 chip；只处理第一个 token。 */
function markLeadingSlashCommand(text: string): string {
  return text.replace(/^(\s*)(\/[^\s`]+)(?=\s|$)/, '$1`$2`');
}
function stripImageReferenceLines(text: string): string {
  return text.split('\n').filter(line => {
    const match = line.match(/^(?:\/file|\[文件\]|\[图片\])\s+(.+)$/);
    if (!match) return true;
    const path = match[1]!.trim();
    const ext = path.split('.').pop()?.toLowerCase();
    if (!ext || !imageExtensions.has(`.${ext}`)) return true;
    return !path.includes('.agentdock/uploads');
  }).join('\n');
}
