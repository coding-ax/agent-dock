import { AlertTriangle, BookOpen, BrainCircuit, ChevronDown, ChevronRight, CircleStop, CircleX, Database, FilePenLine, FlaskConical, GitBranch, Globe2, LoaderCircle, MessageSquare, Search, Square, Terminal, Users, Wrench } from 'lucide-react';
import { memo, useState } from 'react';
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
  const tone = failed ? 'text-red-500' : done ? 'text-emerald-600' : 'text-blue-500';
  return <div className="overflow-hidden">
    <button type="button" data-timeline-disclosure disabled={!hasDetails} onClick={toggle} className="group/tool flex min-h-9 w-full items-center gap-2 py-1.5 text-left transition-colors hover:text-zinc-800 disabled:cursor-default">
      <span className={`grid h-5 w-5 shrink-0 place-items-center ${tone}`}><ToolKindIcon kind={presentation.kind} size={13}/></span><span className="min-w-0 flex-1 truncate text-[11px] text-zinc-500"><span className="font-medium text-zinc-700">{actionLabel}</span>{presentation.detail && <span title={presentation.detail} className="ml-1.5 font-mono text-zinc-400">{presentation.detail}</span>}</span>
      <span className="flex shrink-0 items-center gap-1.5 whitespace-nowrap text-[10px] tabular-nums text-zinc-400">{elapsed && <span>{elapsed}</span>}{!terminal ? <LoaderCircle size={11} className="animate-spin text-blue-500"/> : <span className={`h-1.5 w-1.5 rounded-full ${failed ? 'bg-red-500' : 'bg-emerald-500'}`}/>}<span className={tone}>{statusLabel}</span>{hasDetails && (open ? <ChevronDown size={12}/> : <ChevronRight size={12}/>)}</span>
    </button>
    {open && hasDetails && <div className="mb-2 ml-7 border-l border-zinc-200 pl-3"><pre className="m-0 max-h-72 overflow-auto whitespace-pre-wrap border-0 bg-transparent py-1 text-[10px] leading-5 text-zinc-500">{JSON.stringify({ ...(data.input !== undefined ? { input: data.input } : {}), ...(data.output !== undefined ? { output: data.output } : {}) }, null, 2)}</pre></div>}
  </div>;
}, (prev, next) => prev.preferDescription === next.preferDescription
  && eventRenderSignature(prev.event) === eventRenderSignature(next.event));

const ToolBatch = memo(function ToolBatch({ description, events }: { description: string; events: TimelineEvent[] }) {
  const running = events.some(event => event.data.status !== 'completed' && event.data.status !== 'failed');
  // 同 ToolCard：批量行也由用户决定展开。原来跟着 running 自动开合会在批次收尾时整体塌陷。
  const [open, setOpen] = useState(false); const toggle = () => setOpen(value => !value);
  const failedCount = events.filter(event => event.data.status === 'failed').length;
  const completedCount = events.filter(event => event.data.status === 'completed').length;
  const failed = failedCount > 0;
  const presentation = toolPresentation(events[0]!.data);
  const tone = failed ? 'text-red-500' : running ? 'text-blue-500' : 'text-emerald-600';
  const statusLabel = failed && completedCount ? '部分失败' : failed ? '失败' : running ? '执行中' : '已完成';
  return <div className="overflow-hidden">
    <button type="button" data-timeline-disclosure onClick={toggle} className="flex min-h-9 w-full items-center gap-2 py-1.5 text-left transition-colors">
      <span className={`grid h-5 w-5 shrink-0 place-items-center ${tone}`}><ToolKindIcon kind={presentation.kind} size={13}/></span>
      <HoverTooltipText content={description} className="min-w-0 flex-1 truncate text-[11px] font-medium text-zinc-700">{description}</HoverTooltipText><span className="shrink-0 whitespace-nowrap text-[10px] text-zinc-400">{events.length} 次操作</span>
      {running ? <LoaderCircle size={11} className="shrink-0 animate-spin text-blue-500"/> : <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${failed ? 'bg-red-500' : 'bg-emerald-500'}`}/>}<span className={`shrink-0 whitespace-nowrap text-[10px] ${tone}`}>{statusLabel}</span>
      {open ? <ChevronDown size={12} className="shrink-0 text-zinc-400"/> : <ChevronRight size={12} className="shrink-0 text-zinc-400"/>}
    </button>
    {open && <div className="mb-2 ml-7 border-l border-zinc-200 pl-3">{events.map(event => <ToolCard key={event.id} event={event} preferDescription={false}/>)}</div>}
  </div>;
}, (prev, next) => prev.description === next.description
  && prev.events.length === next.events.length
  && prev.events.every((event, index) => eventRenderSignature(event) === eventRenderSignature(next.events[index]!)));

const ThinkingBlock = memo(function ThinkingBlock({ event, replay = false, sessionId, live, caret }: { event: TimelineEvent; replay?: boolean; sessionId: string | undefined; live: boolean; caret: boolean }) {
  const { open, toggle } = useAutoCollapse(live);
  return <details open={open} className="reasoning group/think py-1.5">
    <summary data-timeline-disclosure onClick={event => { event.preventDefault(); toggle(); }} className="flex cursor-pointer select-none items-center gap-2 py-1 text-[11px] font-medium text-zinc-600 outline-none transition-colors hover:text-zinc-800 focus-visible:rounded focus-visible:ring-2 focus-visible:ring-zinc-300 focus-visible:ring-inset">
      <BrainCircuit size={13}/><span>思考过程</span>
      <ChevronRight size={12} className="ml-auto shrink-0 text-zinc-400 transition-transform group-open/think:rotate-90"/>
    </summary>
    {/* 挂载时就不在输出的思考（同一批事件里被后续内容盖过的、手动展开的历史阶段）直接给全文，
        不再从 0 逐字重播；否则一批事件到达时好几段思考会同时「打字」。replay 只在首帧生效。 */}
    {open && <ThinkingMarkdown text={event.data.text ?? ''} active={caret} replay={replay || !caret} sessionId={sessionId}/>}
  </details>;
}, (prev, next) => prev.live === next.live && prev.caret === next.caret && prev.replay === next.replay && prev.sessionId === next.sessionId
  && eventRenderSignature(prev.event) === eventRenderSignature(next.event));

const ActivityContent = memo(function ActivityContent({ events, replay = false, sessionId, live = false, ongoing = false }: { events: TimelineEvent[]; replay?: boolean; sessionId: string | undefined; live?: boolean; ongoing?: boolean }) {
  const rows = groupToolActivityRows(events);
  return <div className="space-y-1">
    {/* live 取「整轮是否还在跑」，不取「是不是最后一行」：后者会让每出现一行新内容就把
        上一段思考收起，流式过程中思考块反复开合。光标则只跟「最后一个阶段的最后一行」：
        整轮在跑时每段思考都挂光标，会同时闪好几个。 */}
    {rows.map((row, index) => row.kind === 'batch' ? <ToolBatch key={row.id} description={row.description} events={row.events}/> : row.event.type === 'text' ? null : row.event.type === 'thinking' ? <ThinkingBlock key={row.event.id} event={row.event} replay={replay} sessionId={sessionId} live={live} caret={ongoing && index === rows.length - 1}/> : <ToolCard key={row.event.id} event={row.event}/>)}
  </div>;
}, (prev, next) => prev.live === next.live && prev.ongoing === next.ongoing && prev.replay === next.replay && prev.sessionId === next.sessionId
  && prev.events.length === next.events.length
  && prev.events.every((event, index) => eventRenderSignature(event) === eventRenderSignature(next.events[index]!)));

const ActivityGroupPanel = memo(function ActivityGroupPanel({ group, replay = false, sessionId, ongoing = false, live = false }: { group: TimelineActivityGroup; replay?: boolean; sessionId: string | undefined; ongoing?: boolean; live?: boolean }) {
  // live 是「整轮还在跑」，ongoing 只是「这是最后一个阶段」。旧写法拿 ongoing 当自动开合
  // 的信号，于是每冒出一个新阶段，上一阶段的展开内容就被收起——一轮里反复塌陷，画面持续
  // 跳动。整轮还在跑就保持展开，轮次结束后再收起。
  const { open, toggle } = useAutoCollapse(live);
  const toolCount = group.events.filter(event => event.type === 'tool_call' || event.type === 'tool_result').length;
  const thinkingCount = group.events.filter(event => event.type === 'thinking').length;
  const countLabel = [thinkingCount ? `${thinkingCount} 段思考` : '', toolCount ? `${toolCount} 次工具调用` : ''].filter(Boolean).join(' · ');
  const elapsed = formatElapsed(elapsedMilliseconds(group.startedAt, ongoing ? undefined : group.completedAt));
  const hasFailure = group.events.some(event => (event.type === 'tool_call' || event.type === 'tool_result') && event.data.status === 'failed');
  return <details open={open} className="reasoning-group group/stage border-b border-zinc-200 text-sm text-zinc-500 last:border-b-0">
    <summary data-timeline-disclosure onClick={event => { event.preventDefault(); toggle(); }} className="flex min-h-10 cursor-pointer select-none items-center gap-2 py-2 text-[12px] font-medium text-zinc-500 outline-none transition-colors hover:text-zinc-800 focus-visible:rounded-md focus-visible:ring-2 focus-visible:ring-zinc-300 focus-visible:ring-inset">
      <HoverTooltipText content={group.labelTitle} className="min-w-0 flex-1 truncate text-zinc-700">{group.label}</HoverTooltipText>
      {elapsed && <span className="shrink-0 whitespace-nowrap tabular-nums text-[10px] text-zinc-400">{elapsed}</span>}
      {ongoing ? <LoaderCircle size={11} className="shrink-0 animate-spin text-blue-500"/> : <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${hasFailure ? 'bg-red-500' : 'bg-emerald-500'}`}/>}<span className={`shrink-0 whitespace-nowrap text-[10px] ${ongoing ? 'text-blue-600' : hasFailure ? 'text-red-600' : 'text-emerald-600'}`}>{ongoing ? '执行中' : hasFailure ? '部分失败' : '已完成'}</span>
      <ChevronRight size={13} className="shrink-0 text-zinc-400 transition-transform group-open/stage:rotate-90"/>
    </summary>
    {open && <div className="pb-3 pl-5">
      {countLabel && <div className="mb-1 flex items-center gap-2 text-[11px] font-medium text-zinc-500"><Wrench size={14}/><span>{countLabel}</span></div>}
      <ActivityContent events={group.events} replay={replay} sessionId={sessionId} live={live} ongoing={ongoing}/>
    </div>}
  </details>;
}, (prev, next) => prev.ongoing === next.ongoing && prev.live === next.live && prev.replay === next.replay && prev.sessionId === next.sessionId
  && groupRenderSignature(prev.group) === groupRenderSignature(next.group));

export const ActivityPanel = memo(function ActivityPanel({ groups, ongoing, replay = false, sessionId, hasAnswer = false, taskStatus = 'running', modelLabel, startedAt, completedAt }: { groups: TimelineActivityGroup[]; ongoing: boolean; /** 首屏 payload 渲染出来的行：其中的流式文本不做重播动画。 */ replay?: boolean; sessionId: string | undefined; hasAnswer?: boolean; taskStatus?: string; modelLabel: string; startedAt?: string; completedAt?: string }) {
  // key 按 turn 稳定；完成时收起进行中的过程，之后仍可手动展开。
  const { open, toggle } = useAutoCollapse(ongoing);
  const elapsed = formatElapsed(elapsedMilliseconds(startedAt ?? groups[0]?.startedAt, ongoing ? undefined : completedAt ?? groups.at(-1)?.completedAt));
  const interrupted = taskStatus === 'interrupted' || taskStatus === 'cancelled';
  const failed = taskStatus === 'failed';
  const incomplete = taskStatus === 'incomplete';
  const statusLabel = ongoing ? '执行中' : interrupted ? '已取消' : failed ? '已失败' : incomplete ? '未完成' : '已完成';
  const statusTone = ongoing ? 'text-blue-600' : interrupted ? 'text-zinc-500' : failed ? 'text-red-600' : incomplete ? 'text-amber-600' : 'text-emerald-600';
  const missingFinal = !ongoing && !hasAnswer;
  const missingFinalText = interrupted ? '任务已中断，未产生最终输出。' : failed ? '任务执行失败，未产生最终输出。' : 'Agent 未返回最终输出。';
  return <>
  <details open={open} aria-live={ongoing ? 'polite' : undefined} aria-label={`${modelLabel} 执行过程`} className="reasoning ui-timeline-item group/turn my-3 border-b border-zinc-200 text-sm text-zinc-500">
    <summary data-timeline-disclosure onClick={event => { event.preventDefault(); toggle(); }} className="flex min-h-11 cursor-pointer select-none items-center gap-2 py-2.5 text-[12px] font-medium text-zinc-500 outline-none transition-colors hover:text-zinc-800 focus-visible:rounded-md focus-visible:ring-2 focus-visible:ring-zinc-300 focus-visible:ring-inset">
      <span className="whitespace-nowrap">{elapsed ? `${ongoing ? '已耗时' : '耗时'} ${elapsed}` : '查看执行过程'}</span>
      {ongoing ? <LoaderCircle size={11} className="shrink-0 animate-spin text-blue-500"/> : <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${interrupted ? 'bg-zinc-400' : failed ? 'bg-red-500' : incomplete ? 'bg-amber-500' : 'bg-emerald-500'}`}/>}<span className={`shrink-0 whitespace-nowrap text-[10px] ${statusTone}`}>{statusLabel}</span>
      <ChevronRight size={13} className="shrink-0 text-zinc-400 transition-transform group-open/turn:rotate-90"/>
      {groups.length > 0 && <span className="ml-auto text-[10px] tabular-nums text-zinc-400">{groups.length} 个阶段</span>}
    </summary>
    {open && <div className="pb-3 pl-5">
      {groups.length ? groups.map((group, index) => <ActivityGroupPanel key={group.id} group={group} replay={replay} sessionId={sessionId} ongoing={ongoing && index === groups.length - 1} live={ongoing}/>) : <div className="flex items-center gap-2 py-2 text-[11px] text-zinc-400"><LoaderCircle size={12} className="animate-spin"/>等待模型输出</div>}
    </div>}
  </details>
  {missingFinal && <div role="status" className="ui-timeline-item my-4 flex items-center gap-2 text-[12px] text-zinc-500">{failed ? <CircleX size={14} className="text-red-500"/> : interrupted ? <CircleStop size={14} className="text-zinc-400"/> : <MessageSquare size={14} className={incomplete ? 'text-amber-500' : 'text-zinc-400'}/>}<span>{missingFinalText}</span></div>}
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
