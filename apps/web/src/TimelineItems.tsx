import { AlertTriangle, BookOpen, BrainCircuit, ChevronRight, CircleStop, CircleX, Database, FilePenLine, FlaskConical, GitBranch, Globe2, LoaderCircle, MessageSquare, Search, Square, Terminal, Users, Wrench } from 'lucide-react';
import { memo, useEffect, useState, type ReactNode } from 'react';
import { eventRenderSignature, groupRenderSignature, type TimelineActivityGroup, type TimelineEvent } from './timeline';
import { MarkdownContent } from './MarkdownContent';
import { AssistantMarkdown, ThinkingMarkdown } from './TypewriterText';
import { useAutoCollapse } from './useAutoCollapse';
import { HoverTooltipText } from './HoverTooltip';
import { elapsedMilliseconds, formatElapsed, groupToolActivityRows, toolActionLabel, toolDescription, toolPresentation, type ToolKind } from './tool-presentation';

/**
 * 时间线的渲染单元。原先这些组件都藏在 SessionPane 内部，只有它能用；「实际请求」轨迹面板
 * 要做到「某一轮的最终输出」和「展开看这一轮的过程」跟主时间线长得一样、判定一致，就得共用
 * 同一批组件，于是搬到这里。只导出 TimelineItem 与 ActivityPanel 两个入口。
 */

function ToolKindIcon({ kind, size = 14 }: { kind: ToolKind; size?: number }) {
  if (kind === 'read') return <BookOpen size={size}/>;
  if (kind === 'edit') return <FilePenLine size={size}/>;
  if (kind === 'search') return <Search size={size}/>;
  if (kind === 'web') return <Globe2 size={size}/>;
  if (kind === 'git') return <GitBranch size={size}/>;
  if (kind === 'test') return <FlaskConical size={size}/>;
  if (kind === 'database') return <Database size={size}/>;
  if (kind === 'agent') return <Users size={size}/>;
  if (kind === 'terminal') return <Terminal size={size}/>;
  return <Wrench size={size}/>;
}

const ToolCard = memo(function ToolCard({ event, preferDescription = true }: { event: TimelineEvent; preferDescription?: boolean }) {
  const data = event.data; const done = data.status === 'completed'; const failed = data.status === 'failed'; const terminal = done || failed;
  // 展开/收起完全交给用户。旧写法是 useAutoCollapse(!terminal)：执行中自动展开、完成即收起，
  // 于每个工具完成的一瞬间抽走一个最高 288px 的 JSON 块；贴底视图里正看的内容被整体上拽，
  // 一轮十几次工具调用就是十几次高度跳变。trace 列表默认紧凑，要看细节再点。
  const [open, setOpen] = useState(false); const toggle = () => setOpen(value => !value);
  const hasDetails = data.input !== undefined || data.output !== undefined;
  const presentation = toolPresentation(data);
  const elapsed = formatElapsed(elapsedMilliseconds(data.startedAt ?? event.timestamp, terminal ? data.completedAt ?? event.timestamp : undefined));
  const statusLabel = failed ? '失败' : done ? '已完成' : '执行中'; const actionLabel = preferDescription ? toolDescription(data) ?? toolActionLabel(presentation, terminal) : toolActionLabel(presentation, terminal);
  const tone = failed ? 'text-red-400' : done ? 'text-zinc-400' : 'text-blue-400';
  return <div className="ui-trace-row overflow-hidden">
    <button type="button" data-timeline-disclosure disabled={!hasDetails} onClick={toggle} className="group/tool flex min-h-6 w-full items-center gap-1.5 rounded-md px-1 py-0.5 text-left transition-colors hover:bg-zinc-50 disabled:cursor-default">
      <span className={`grid h-4 w-4 shrink-0 place-items-center ${tone}`}><ToolKindIcon kind={presentation.kind} size={11}/></span><span className="min-w-0 flex-1 truncate text-[10px] text-zinc-400"><span className="text-zinc-500">{actionLabel}</span>{presentation.detail && <span title={presentation.detail} className="ml-1.5 font-mono text-zinc-400/70">{presentation.detail}</span>}</span>
      <span className="flex shrink-0 items-center gap-1 whitespace-nowrap text-[9.5px] tabular-nums text-zinc-400/80">{elapsed && <span>{elapsed}</span>}{!terminal ? <LoaderCircle size={9} className="animate-spin text-blue-400"/> : failed ? <span className="text-red-400">{statusLabel}</span> : null}{hasDetails && <ChevronRight size={10} className={`text-zinc-300 transition-transform duration-200 ${open ? 'rotate-90' : ''}`}/>}</span>
    </button>
    {open && hasDetails && <div className="mb-1.5 ml-5 border-l border-zinc-100 pl-2.5"><pre className="m-0 max-h-72 overflow-auto whitespace-pre-wrap border-0 bg-transparent py-1 text-[10px] leading-[1.55] text-zinc-500">{JSON.stringify({ ...(data.input !== undefined ? { input: data.input } : {}), ...(data.output !== undefined ? { output: data.output } : {}) }, null, 2)}</pre></div>}
  </div>;
}, (prev, next) => prev.preferDescription === next.preferDescription
  && eventRenderSignature(prev.event) === eventRenderSignature(next.event));

/** 高度/透明度一起过渡；折叠后的 300ms 内保留子节点，避免自动收起时内容瞬间消失。 */
function AnimatedReveal({ open, children }: { open: boolean; children: ReactNode }) {
  const [mounted, setMounted] = useState(open);
  // 打开时在本次渲染就挂上内容，否则 0fr → 1fr 的过渡会从「空容器」开始，看不出展开动画。
  if (open && !mounted) setMounted(true);
  useEffect(() => {
    if (open) return;
    const timer = window.setTimeout(() => setMounted(false), 300);
    return () => window.clearTimeout(timer);
  }, [open]);
  return <div aria-hidden={!open} className={`grid transition-[grid-template-rows,opacity] duration-300 ease-[cubic-bezier(.16,1,.3,1)] ${open ? 'grid-rows-[1fr] opacity-100' : 'grid-rows-[0fr] opacity-0'}`}>
    <div className="min-h-0 overflow-hidden">{mounted ? children : null}</div>
  </div>;
}

const ToolBatch = memo(function ToolBatch({ description, events }: { description: string; events: TimelineEvent[] }) {
  const running = events.some(event => event.data.status !== 'completed' && event.data.status !== 'failed');
  const [open, setOpen] = useState(false); const toggle = () => setOpen(value => !value);
  const failedCount = events.filter(event => event.data.status === 'failed').length;
  const failed = failedCount > 0;
  const presentation = toolPresentation(events[0]!.data);
  const tone = failed ? 'text-red-400' : running ? 'text-blue-400' : 'text-zinc-400';
  return <div className="ui-trace-row overflow-hidden">
    <button type="button" data-timeline-disclosure onClick={toggle} className="group/batch flex min-h-6 w-full items-center gap-1.5 rounded-md px-1 py-0.5 text-left transition-colors hover:bg-zinc-50">
      <span className={`grid h-4 w-4 shrink-0 place-items-center ${tone}`}><ToolKindIcon kind={presentation.kind} size={11}/></span>
      <HoverTooltipText content={description} className="min-w-0 flex-1 truncate text-[10px] text-zinc-400 transition-colors group-hover/batch:text-zinc-600">{description}</HoverTooltipText>
      {events.length > 1 && <span className="shrink-0 whitespace-nowrap text-[9.5px] tabular-nums text-zinc-400/80">×{events.length}</span>}
      {running ? <LoaderCircle size={9} className="shrink-0 animate-spin text-blue-400"/> : failed ? <span className="shrink-0 text-[9.5px] text-red-400">失败</span> : null}
      <ChevronRight size={10} className={`shrink-0 text-zinc-300 transition-transform duration-200 ${open ? 'rotate-90' : ''}`}/>
    </button>
    <AnimatedReveal open={open}><div className="ml-2 border-l border-zinc-100 pl-2 pb-0.5">{events.map(event => <ToolCard key={event.id} event={event} preferDescription={false}/>)}</div></AnimatedReveal>
  </div>;
}, (prev, next) => prev.description === next.description
  && prev.events.length === next.events.length
  && prev.events.every((event, index) => eventRenderSignature(event) === eventRenderSignature(next.events[index]!)));

/** 折叠行只留一句可读的描述；完整 Markdown 与流式内容在展开后出现。 */
function thinkingSummary(text: string | undefined) {
  const line = (text ?? '').split('\n').map(item => item.replace(/^\s*(?:[-*+]|\d+[.)])\s+/, '').replace(/[*~`>#]/g, '').trim()).find(Boolean) ?? '';
  return line.length > 84 ? `${line.slice(0, 84).trimEnd()}…` : line;
}

const ThinkingBlock = memo(function ThinkingBlock({ event, replay = false, sessionId, live, caret }: { event: TimelineEvent; replay?: boolean; sessionId: string | undefined; live: boolean; caret: boolean }) {
  const [open, setOpen] = useState(false);
  const summary = thinkingSummary(event.data.text);
  return <div className="ui-trace-row">
    <button type="button" data-timeline-disclosure data-live-thinking={caret || undefined} aria-expanded={open} onClick={() => setOpen(value => !value)} className="group/think flex min-h-6 w-full select-none items-center gap-1.5 rounded-md px-1 py-0.5 text-left outline-none transition-colors hover:bg-zinc-50 focus-visible:ring-2 focus-visible:ring-zinc-300">
      <BrainCircuit size={11} className="shrink-0 text-zinc-400"/>
      <span className="shrink-0 text-[10px] font-medium text-zinc-500">思考</span>
      <span className={`min-w-0 flex-1 truncate text-[10.5px] ${summary ? 'text-zinc-400' : 'text-zinc-400/70'}`}>{summary || (live ? '正在思考…' : '查看思考内容')}</span>
      {caret && <LoaderCircle size={9} className="shrink-0 animate-spin text-blue-400"/>}
      <ChevronRight size={10} className={`shrink-0 text-zinc-300 transition-transform duration-200 ${open ? 'rotate-90' : ''}`}/>
    </button>
    <AnimatedReveal open={open}>
      <div className="mb-1 ml-5 border-l border-zinc-100 py-1 pl-2.5">
        <ThinkingMarkdown text={event.data.text ?? ''} active={caret} replay={replay || !caret} sessionId={sessionId}/>
      </div>
    </AnimatedReveal>
  </div>;
}, (prev, next) => prev.live === next.live && prev.caret === next.caret && prev.replay === next.replay && prev.sessionId === next.sessionId
  && eventRenderSignature(prev.event) === eventRenderSignature(next.event));

const ActivityContent = memo(function ActivityContent({ events, replay = false, sessionId, live = false, ongoing = false }: { events: TimelineEvent[]; replay?: boolean; sessionId: string | undefined; live?: boolean; ongoing?: boolean }) {
  const rows = groupToolActivityRows(events);
  return <div className="space-y-0.5">
    {rows.map((row, index) => {
      if (row.kind === 'batch') return <ToolBatch key={row.id} description={row.description} events={row.events}/>;
      const last = index === rows.length - 1;
      if (row.event.type === 'thinking') return <ThinkingBlock key={row.event.id} event={row.event} replay={replay} sessionId={sessionId} live={live} caret={ongoing && last}/>;
      if (row.event.type === 'text') {
        const streaming = ongoing && last;
        return <AssistantMarkdown key={row.event.id} text={row.event.data.text ?? ''} active={streaming} replay={replay || !streaming} compact assistantLabel="Agent" sessionId={sessionId}/>;
      }
      return <ToolCard key={row.event.id} event={row.event}/>;
    })}
  </div>;
}, (prev, next) => prev.live === next.live && prev.ongoing === next.ongoing && prev.replay === next.replay && prev.sessionId === next.sessionId
  && prev.events.length === next.events.length
  && prev.events.every((event, index) => eventRenderSignature(event) === eventRenderSignature(next.events[index]!)));

export const ActivityPanel = memo(function ActivityPanel({ groups, ongoing, replay = false, sessionId, hasAnswer = false, taskStatus = 'running', modelLabel, startedAt, completedAt }: { groups: TimelineActivityGroup[]; ongoing: boolean; /** 首屏 payload 渲染出来的行：其中的流式文本不做重播动画。 */ replay?: boolean; sessionId: string | undefined; hasAnswer?: boolean; taskStatus?: string; modelLabel: string; startedAt?: string; completedAt?: string }) {
  // key 按 turn 稳定；完成时收起进行中的过程，之后仍可手动展开。
  const { open, toggle } = useAutoCollapse(ongoing);
  const elapsed = formatElapsed(elapsedMilliseconds(startedAt ?? groups[0]?.startedAt, ongoing ? undefined : completedAt ?? groups.at(-1)?.completedAt));
  const events = groups.flatMap(group => group.events);
  const thinkingCount = events.filter(event => event.type === 'thinking').length;
  const toolCount = events.filter(event => event.type === 'tool_call' || event.type === 'tool_result').length;
  const countLabel = [thinkingCount ? `${thinkingCount} 段思考` : '', toolCount ? `${toolCount} 次工具调用` : ''].filter(Boolean).join(' · ');
  const interrupted = taskStatus === 'interrupted' || taskStatus === 'cancelled';
  const failed = taskStatus === 'failed';
  const incomplete = taskStatus === 'incomplete';
  const statusLabel = ongoing ? '执行中' : interrupted ? '已取消' : failed ? '已失败' : incomplete ? '未完成' : '已完成';
  const statusTone = ongoing ? 'text-blue-500' : interrupted ? 'text-zinc-400' : failed ? 'text-red-500' : incomplete ? 'text-amber-600' : 'text-zinc-400';
  const missingFinal = !ongoing && !hasAnswer;
  const missingFinalText = interrupted ? '任务已中断，未产生最终输出。' : failed ? '任务执行失败，未产生最终输出。' : 'Agent 未返回最终输出。';
  return <>
  <section aria-live={ongoing ? 'polite' : undefined} aria-label={`${modelLabel} 执行过程`} className="ui-timeline-item my-2 text-zinc-500">
    <button type="button" data-timeline-disclosure aria-expanded={open} onClick={toggle} className="group/turn flex min-h-7 w-full select-none items-center gap-1.5 rounded-md py-0.5 text-left outline-none transition-colors hover:text-zinc-700 focus-visible:ring-2 focus-visible:ring-zinc-300">
      <span className="shrink-0 whitespace-nowrap text-[10.5px] tabular-nums text-zinc-400">{elapsed ? `${ongoing ? '已耗时' : '耗时'} ${elapsed}` : '执行过程'}</span>
      {countLabel && <><span aria-hidden className="shrink-0 text-[10px] text-zinc-300">·</span><span className="min-w-0 truncate text-[10px] tabular-nums text-zinc-400">{countLabel}</span></>}
      {ongoing ? <LoaderCircle size={9} className="ml-auto shrink-0 animate-spin text-blue-400"/> : <span className={`ml-auto h-1.5 w-1.5 shrink-0 rounded-full ${interrupted ? 'bg-zinc-300' : failed ? 'bg-red-400' : incomplete ? 'bg-amber-400' : 'bg-emerald-400'}`}/>}<span className={`shrink-0 whitespace-nowrap text-[9.5px] ${statusTone}`}>{statusLabel}</span>
      <ChevronRight size={11} className={`shrink-0 text-zinc-300 transition-transform duration-300 ${open ? 'rotate-90' : ''}`}/>
    </button>
    <AnimatedReveal open={open}>
      <div className="pb-1 pt-0.5">
        {groups.length ? <ActivityContent events={events} replay={replay} sessionId={sessionId} live={ongoing} ongoing={ongoing}/> : <div className="flex items-center gap-1.5 py-1 pl-1 text-[10px] text-zinc-400"><LoaderCircle size={10} className="animate-spin"/>等待模型输出</div>}
      </div>
    </AnimatedReveal>
  </section>
  {missingFinal && <div role="status" className="ui-timeline-item my-3 flex items-center gap-1.5 text-[11px] text-zinc-500">{failed ? <CircleX size={13} className="text-red-500"/> : interrupted ? <CircleStop size={13} className="text-zinc-400"/> : <MessageSquare size={13} className={incomplete ? 'text-amber-500' : 'text-zinc-400'}/>}<span>{missingFinalText}</span></div>}
  </>;
}, (prev, next) => prev.ongoing === next.ongoing && prev.sessionId === next.sessionId && prev.hasAnswer === next.hasAnswer
  && prev.taskStatus === next.taskStatus && prev.modelLabel === next.modelLabel
  && prev.startedAt === next.startedAt && prev.completedAt === next.completedAt
  && prev.groups.length === next.groups.length
  && prev.groups.every((group, index) => group.id === next.groups[index]!.id && groupRenderSignature(group) === groupRenderSignature(next.groups[index]!)));

const PermissionCard = memo(function PermissionCard({ event }: { event: TimelineEvent }) {
  return <div className="ui-timeline-item my-4 rounded-xl border border-orange-200 bg-orange-50 px-4 py-3.5">
    <div className="flex items-start gap-3"><div className="mt-0.5 grid h-7 w-7 place-items-center rounded-lg bg-orange-100 text-orange-700"><Square size={13}/></div><div className="min-w-0 flex-1"><div className="text-sm font-semibold text-zinc-900">操作已拦截</div><p className="mt-1 text-sm leading-6 text-zinc-600">{event.data.title}</p>
      <div className="mt-2 text-xs font-medium text-zinc-500">{event.data.status === 'pending' ? '历史授权请求已失效；当前版本固定使用完全访问' : event.data.status}</div>
    </div></div>
  </div>;
});

export const TimelineItem = memo(function TimelineItem({ event, final = false, streaming = false, replay = false, assistantLabel = 'Agent', sessionId }: { event: TimelineEvent; final?: boolean; streaming?: boolean; /** 首屏 payload 渲染出来的行：其中的流式文本不做重播动画。 */ replay?: boolean; assistantLabel?: string; sessionId?: string }) {
  if (event.type === 'tool_call' || event.type === 'tool_result') return <ToolCard event={event}/>;
  if (event.type === 'permission_request') return <PermissionCard event={event}/>;
  if (event.type === 'warning') return <aside role="status" className="ui-timeline-item my-4 overflow-hidden rounded-xl border border-amber-200 bg-amber-50/75 shadow-[0_4px_14px_rgba(180,83,9,.045)]">
    <div className="flex items-start gap-3 px-4 py-3"><span className="mt-0.5 grid h-7 w-7 shrink-0 place-items-center rounded-lg bg-amber-100 text-amber-700"><AlertTriangle size={14}/></span><div className="min-w-0"><div className="text-[13px] font-semibold text-amber-950">{event.data.warningKind === 'skill' ? 'Skill 提示' : 'Agent 警告'}</div><div className="mt-1 text-[13px] leading-5 text-amber-800"><MarkdownContent sessionId={sessionId}>{event.data.text ?? ''}</MarkdownContent></div></div></div>
  </aside>;
  if (event.type === 'error') return <aside role="alert" className="ui-timeline-item my-4 overflow-hidden rounded-xl border border-red-200 bg-red-50/80 shadow-[0_4px_14px_rgba(185,28,28,.045)]">
    <div className="flex items-start gap-3 px-4 py-3"><span className="mt-0.5 grid h-7 w-7 shrink-0 place-items-center rounded-lg bg-red-100 text-red-700"><CircleX size={14}/></span><div className="min-w-0"><div className="text-[13px] font-semibold text-red-950">Agent 错误</div><div className="mt-1 text-[13px] leading-5 text-red-800"><MarkdownContent sessionId={sessionId}>{event.data.message ?? 'Agent 运行失败'}</MarkdownContent></div></div></div>
  </aside>;
  if (event.type === 'thinking') return null;
  const user = event.data.role === 'user';
  if (user) {
    const text = stripImageReferenceLines(event.data.text ?? '');
    return <div className="ui-timeline-item my-6 flex justify-end"><div className="min-w-0 max-w-[84%] rounded-2xl rounded-br-md bg-zinc-900 px-4 py-3 text-[14px] leading-6 text-zinc-50 shadow-[0_3px_12px_rgba(24,24,27,.1)] sm:max-w-[78%]"><MarkdownContent sessionId={sessionId}>{text}</MarkdownContent>{event.data.optimistic && <div className="mt-1 text-right text-[10px] text-zinc-400">发送中…</div>}</div></div>;
  }
  // 挂载时已不在流式输出的正文直接给全文。轮次结束时最终回答会从执行面板搬成独立的 final 行（重新挂载），
  // tasks 刷新的空档也可能让它短暂搬回去再搬出来；否则这些早就返回过的内容会从 0 重新打一遍。
  const settled = replay || !streaming;
  if (final) return <AssistantMarkdown text={event.data.text ?? ''} active={streaming} replay={settled} final assistantLabel={assistantLabel} sessionId={sessionId}/>;
  return <AssistantMarkdown text={event.data.text ?? ''} active={streaming} replay={settled} assistantLabel={assistantLabel} sessionId={sessionId}/>;
}, (prev, next) => prev.final === next.final && prev.streaming === next.streaming && prev.assistantLabel === next.assistantLabel && prev.sessionId === next.sessionId
  && eventRenderSignature(prev.event) === eventRenderSignature(next.event)
  // error/warning/permission 卡片的 payload 变化也要刷新；text 长度已在签名内。
  && JSON.stringify(prev.event.data.status ?? '') === JSON.stringify(next.event.data.status ?? '')
  && (prev.event.data.message ?? '') === (next.event.data.message ?? '')
  && (prev.event.data.title ?? '') === (next.event.data.title ?? ''));

const imageExtensions = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.svg']);
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
