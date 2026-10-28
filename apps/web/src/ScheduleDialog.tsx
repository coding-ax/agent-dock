import { useMemo, useRef, useState, type ReactNode } from 'react';
import { useInterval, useUpdateEffect } from 'ahooks';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlarmClock, ArrowLeft, ChevronRight, FolderOpen, History, LoaderCircle, MessageSquare, Plus, Repeat, Trash2, X, Zap } from 'lucide-react';
import { AutoComplete, Button, Checkbox, DatePicker, Input, InputNumber, Segmented, Select, Space, Switch, Tag, TimePicker, Tooltip } from 'antd';
import dayjs from 'dayjs';
import { api, type Agent, type Schedule, type ScheduleRun, type Session } from './api';
import { agentModelsQueryKey, loadAgentModels, readCachedAgentModels } from './model-cache';
import { describeCron, describeInterval, describeRunTime, intervalUnits, nextCronRuns, nextIntervalRuns, oncePresets, recurrenceKinds, recurrenceToTrigger, weekdayLabels, weekdayOrder, type IntervalUnit, type Recurrence } from './recurrence';
import { ConfirmDialog } from './ui-controls';
import { AgentIcon } from './AgentIcon';
import { useModalFocusTrap } from './useModalFocusTrap';
import { useToast } from './Toast';
import { bindableSessions, canResume, deliveryHints, deliveryLabels, describeTrigger, emptyScheduleForm, formatScheduleTime, parseScheduleTemplate, recentWorkspaces, runStatusLabels, scheduleFormToInput, scheduleState, type ScheduleFormState, describeCountdown, summarizeSchedules, type ScheduleSummary } from './schedule-view';

/** 全局列表里「在哪里跑」：绑了会话显示会话标题，独立任务显示 Agent · 目录。 */
function scheduleTarget(schedule: Schedule, titles: Map<string, string>, agents: Agent[]): string | undefined {
  if (schedule.sessionId) return titles.get(schedule.sessionId);
  const template = parseScheduleTemplate(schedule.sessionTemplate);
  if (!template) return undefined;
  const agent = agents.find(item => item.id === template.agentId)?.name ?? template.agentId;
  return `${agent} · ${template.cwd.split(/[\\/]/).filter(Boolean).pop() || template.cwd}`;
}

const stateColor = { active: 'success', paused: 'default', done: 'default', failed: 'error' } as const;
const runTone = { delivered: 'text-emerald-600', skipped: 'text-amber-600', failed: 'text-red-600' } as const;

function useScheduleActions() {
  const qc = useQueryClient();
  const toast = useToast();
  const refresh = () => void qc.invalidateQueries({ queryKey: ['schedules'] });
  const onError = (error: Error) => toast.show(error.message);
  const pause = useMutation({ mutationFn: api.pauseSchedule, onSuccess: refresh, onError });
  const resume = useMutation({ mutationFn: api.resumeSchedule, onSuccess: refresh, onError });
  const remove = useMutation({ mutationFn: api.deleteSchedule, onSuccess: refresh, onError });
  const run = useMutation({
    mutationFn: api.runSchedule,
    onSuccess: result => {
      refresh();
      void qc.invalidateQueries({ queryKey: ['sessions'] });
      toast.show(result.status === 'delivered' ? '已触发一次' : `本次${runStatusLabels[result.status]}：${result.reason ?? ''}`, result.status === 'delivered' ? 'info' : 'error');
    },
    onError
  });
  return { pause, resume, remove, run, toast: toast.toast };
}

function ScheduleRuns({ schedule, onOpenSession }: { schedule: Schedule; onOpenSession(id: string): void }) {
  const runs = useQuery({ queryKey: ['schedules', schedule.id, 'runs'], queryFn: () => api.scheduleRuns(schedule.id) });
  return <div className="border-t border-zinc-100 bg-zinc-50/60 px-4 py-2.5">
    <div className="mb-1.5 whitespace-pre-wrap break-words text-[12px] leading-5 text-zinc-700">{schedule.prompt}</div>
    <div className="mb-1 text-[10px] font-medium text-zinc-400">最近执行</div>
    {runs.isLoading && <div className="flex items-center gap-1.5 text-[11px] text-zinc-400"><LoaderCircle size={11} className="animate-spin"/>读取中…</div>}
    {runs.data?.length === 0 && <div className="text-[11px] text-zinc-400">还没有触发过</div>}
    {runs.data?.map(run => <div key={run.id} className="flex min-w-0 items-center gap-2 py-0.5 text-[11px]">
      <span className="shrink-0 tabular-nums text-zinc-500">{formatScheduleTime(run.fireAt)}</span>
      <span className={`shrink-0 font-medium ${runTone[run.status]}`}>{runStatusLabels[run.status]}</span>
      {run.reason && <span className="min-w-0 truncate text-zinc-400" title={run.reason}>{run.reason}</span>}
      {run.sessionId && run.status === 'delivered' && <button type="button" onClick={() => onOpenSession(run.sessionId!)} className="ml-auto shrink-0 rounded px-1.5 py-0.5 text-[10px] text-blue-600 hover:bg-blue-50">打开会话</button>}
    </div>)}
  </div>;
}

function ScheduleRow({ schedule, sessionTitle, lastRun, now, actions, onOpenSession }: { schedule: Schedule; sessionTitle?: string; lastRun?: ScheduleRun; now: Date; actions: ReturnType<typeof useScheduleActions>; onOpenSession(id: string): void }) {
  const [open, setOpen] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const state = scheduleState(schedule);
  const busy = [actions.pause, actions.resume, actions.run, actions.remove].some(action => action.isPending && action.variables === schedule.id);
  const toggling = [actions.pause, actions.resume].some(action => action.isPending && action.variables === schedule.id);
  const nextAt = schedule.enabled && schedule.nextRunAt ? new Date(schedule.nextRunAt) : undefined;
  // 开关只表达「启用/暂停」；单次已执行、或失败停用且不可恢复的，用标签说明状态。
  const switchable = schedule.enabled || canResume(schedule);
  return <div className="group border-b border-zinc-100 last:border-b-0">
    <div className={`flex min-w-0 items-start gap-3 px-4 py-3 transition-colors hover:bg-zinc-50/80 ${schedule.enabled ? '' : 'opacity-75'}`}>
      <button type="button" onClick={() => setOpen(value => !value)} aria-expanded={open} className="flex min-w-0 flex-1 items-start gap-2 text-left">
        <ChevronRight size={14} className={`mt-[3px] shrink-0 text-zinc-400 transition-transform ${open ? 'rotate-90' : ''}`}/>
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-2">
            <span className="min-w-0 truncate text-[13px] font-medium text-zinc-900">{schedule.name}</span>
            <Tag bordered={false} color={stateColor[state.tone]} className="m-0 shrink-0 text-[11px]">{state.label}</Tag>
          </div>
          {schedule.prompt.trim() !== schedule.name.trim() && <div className="mt-1 line-clamp-2 whitespace-pre-wrap break-words text-[12px] leading-5 text-zinc-500">{schedule.prompt}</div>}
          <div className="mt-1.5 flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-zinc-500">
            <span className="inline-flex items-center gap-1 text-zinc-700"><Repeat size={11} className="text-zinc-400"/>{describeTrigger(schedule)}</span>
            <span className="inline-flex min-w-0 items-center gap-1"><MessageSquare size={11} className="shrink-0 text-zinc-400"/><span className="truncate">{deliveryLabels[schedule.delivery]}{sessionTitle ? ` · ${sessionTitle}` : ''}</span></span>
            <span className="inline-flex items-center gap-1 tabular-nums"><History size={11} className="text-zinc-400"/>{lastRun ? <>上次 {describeRunTime(new Date(lastRun.fireAt), now)} <span className={runTone[lastRun.status]}>{runStatusLabels[lastRun.status]}</span></> : '还没触发过'}{schedule.runCount > 0 && <span className="text-zinc-400">（共 {schedule.runCount} 次）</span>}</span>
          </div>
        </div>
      </button>
      {nextAt && <div className="hidden w-24 shrink-0 text-right sm:block" title={formatScheduleTime(schedule.nextRunAt)}>
        <div className="text-[12px] font-medium tabular-nums text-zinc-800">{describeRunTime(nextAt, now)}</div>
        <div className="mt-0.5 text-[11px] tabular-nums text-zinc-400">{describeCountdown(nextAt, now)}</div>
      </div>}
      <div className="flex shrink-0 items-center gap-1">
        <Tooltip title="立即执行一次"><Button type="text" size="small" aria-label="立即执行一次" disabled={busy} loading={actions.run.isPending && actions.run.variables === schedule.id} icon={<Zap size={14}/>} onClick={() => actions.run.mutate(schedule.id)} className="text-zinc-500"/></Tooltip>
        <Tooltip title="删除"><Button type="text" size="small" danger aria-label="删除" disabled={busy} icon={<Trash2 size={14}/>} onClick={() => setConfirmDelete(true)} className="opacity-60 group-hover:opacity-100"/></Tooltip>
        {switchable && <Tooltip title={schedule.enabled ? '暂停' : '恢复'}><Switch size="small" aria-label={schedule.enabled ? '暂停' : '恢复'} checked={schedule.enabled} loading={toggling} disabled={busy && !toggling} onChange={on => (on ? actions.resume : actions.pause).mutate(schedule.id)} className="ml-1"/></Tooltip>}
      </div>
    </div>
    {open && <ScheduleRuns schedule={schedule} onOpenSession={onOpenSession}/>}
    <ConfirmDialog open={confirmDelete} tone="danger" title="删除这个定时任务？" description={`「${schedule.name}」不会再触发。已经产生的会话不受影响。`} confirmLabel="删除" busy={actions.remove.isPending} onCancel={() => setConfirmDelete(false)} onConfirm={() => actions.remove.mutate(schedule.id, { onSuccess: () => setConfirmDelete(false) })}/>
  </div>;
}

/** 列表顶部的概览：一眼看到有多少在跑、今天还会触发几次、最近有没有失败。 */
function ScheduleOverview({ summary, now }: { summary: ScheduleSummary; now: Date }) {
  const cell = (label: string, value: ReactNode, tone = 'text-zinc-900') => <div className="min-w-0 rounded-lg bg-zinc-50 px-3 py-2">
    <div className="text-[11px] text-zinc-400">{label}</div>
    <div className={`mt-0.5 truncate text-[15px] font-semibold tabular-nums ${tone}`}>{value}</div>
  </div>;
  const next = summary.next?.nextRunAt ? new Date(summary.next.nextRunAt) : undefined;
  return <div className="shrink-0 border-b border-zinc-100 px-4 py-3">
    <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
      {cell('启用中', <>{summary.active}{summary.inactive > 0 && <span className="ml-1 text-[11px] font-normal text-zinc-400">/ 停用 {summary.inactive}</span>}</>)}
      {cell('今天还会触发', summary.dueToday)}
      {cell('24 小时内已投递', summary.ran24h)}
      {cell('24 小时内失败', summary.failed24h, summary.failed24h ? 'text-red-600' : 'text-zinc-900')}
    </div>
    {next && summary.next && <div className="mt-2 flex min-w-0 items-center gap-1.5 text-[12px] text-zinc-500">
      <AlarmClock size={12} className="shrink-0 text-zinc-400"/>
      <span className="shrink-0">下一个</span>
      <span className="min-w-0 truncate font-medium text-zinc-800">{summary.next.name}</span>
      <span className="shrink-0 tabular-nums">{describeRunTime(next, now)}（{describeCountdown(next, now)}）</span>
    </div>}
  </div>;
}

/** 最近执行（跨任务）：列表下方的流水，空闲时也能看到它们在干活。 */
function RecentRuns({ runs, names, now, onOpenSession }: { runs: ScheduleRun[]; names: Map<string, string>; now: Date; onOpenSession(id: string): void }) {
  if (!runs.length) return null;
  return <div className="px-4 pb-4 pt-3">
    <div className="mb-1.5 text-[11px] font-medium text-zinc-400">最近执行</div>
    <div className="overflow-hidden rounded-lg border border-zinc-100">
      {runs.slice(0, 12).map(run => <div key={run.id} className="flex min-w-0 items-center gap-3 border-b border-zinc-100 px-3 py-1.5 text-[12px] last:border-b-0">
        <span className="w-28 shrink-0 tabular-nums text-zinc-500">{describeRunTime(new Date(run.fireAt), now)}</span>
        <span className={`w-12 shrink-0 font-medium ${runTone[run.status]}`}>{runStatusLabels[run.status]}</span>
        <span className="min-w-0 flex-1 truncate text-zinc-700" title={run.reason ?? undefined}>{names.get(run.scheduleId) ?? '已删除的任务'}{run.reason && <span className="text-zinc-400"> · {run.reason}</span>}</span>
        {run.sessionId && run.status === 'delivered' && <Button type="link" size="small" onClick={() => onOpenSession(run.sessionId!)} className="h-auto shrink-0 px-0 text-[11px]">打开会话</Button>}
      </div>)}
    </div>
  </div>;
}

/**
 * 新建表单（占满弹窗主体，不再压在列表上方）。
 * - 每次新开会话：直接选 Agent / 工作目录 / 模型。从会话标题栏进来时用本会话的配置预填，
 *   并把生出的会话挂在本会话下；全局入口生出的是独立会话。
 * - 追加到已有会话：只有这时才需要选会话。
 * - 底部始终显示一句话摘要和接下来几次触发时间，创建前就知道它会在什么时候、在哪里跑。
 */
function ScheduleForm({ session, agents, sessions, onDone, onCancel }: { session?: Session; agents: Agent[]; sessions: Session[]; onDone(name: string): void; onCancel(): void }) {
  const qc = useQueryClient();
  const candidates = useMemo(() => bindableSessions(sessions), [sessions]);
  const enabledAgents = useMemo(() => agents.filter(agent => !agent.disabled), [agents]);
  const [form, setForm] = useState<ScheduleFormState>(() => ({
    ...emptyScheduleForm,
    runAt: oncePresets(new Date())[1]!.value,
    agentId: session?.agentId ?? candidates.find(item => enabledAgents.some(agent => agent.id === item.agentId))?.agentId ?? enabledAgents[0]?.id ?? '',
    cwd: session?.cwd ?? candidates[0]?.cwd ?? '',
    model: session?.model ?? '',
    appendSessionId: session?.id ?? candidates[0]?.id ?? ''
  }));
  const [error, setError] = useState<string>();
  const [now, setNow] = useState(() => new Date());
  useInterval(() => setNow(new Date()), 30_000);
  const workspaces = useMemo(() => recentWorkspaces(sessions.filter(item => !item.archivedAt), [session?.cwd, enabledAgents.find(agent => agent.id === form.agentId)?.cwd]), [sessions, session?.cwd, enabledAgents, form.agentId]);
  const models = useQuery({
    queryKey: agentModelsQueryKey(form.agentId, form.model || undefined),
    queryFn: () => loadAgentModels(form.agentId, form.model || undefined),
    enabled: form.delivery === 'new_session' && Boolean(form.agentId),
    initialData: () => readCachedAgentModels(form.agentId, form.model || undefined),
    initialDataUpdatedAt: 0,
    staleTime: 60_000
  });
  const capabilities = useQuery({ queryKey: ['system-capabilities'], queryFn: api.systemCapabilities, staleTime: 300_000 });
  const pickDirectory = useMutation({ mutationFn: api.selectDirectory, onSuccess: result => update({ cwd: result.path }), // 用户在系统选择框里点「取消」不是错误。
    onError: failure => { if (!/cancelled/i.test(failure.message)) setError(failure.message); } });
  const create = useMutation({
    mutationFn: api.createSchedule,
    onSuccess: created => { void qc.invalidateQueries({ queryKey: ['schedules'] }); onDone(created.name); },
    onError: failure => setError(failure.message)
  });
  function update(patch: Partial<ScheduleFormState>) { setForm(current => ({ ...current, ...patch })); setError(undefined); }
  const setRecurrence = (patch: Partial<Recurrence>) => update({ recurrence: { ...form.recurrence, ...patch } });
  const submit = () => {
    if (create.isPending) return;
    const result = scheduleFormToInput(form, session ? { parentSessionId: session.id } : {});
    if (result.error || !result.input) { setError(result.error); return; }
    create.mutate(result.input);
  };
  const built = form.kind === 'recurring' ? recurrenceToTrigger(form.recurrence) : undefined;
  const trigger = built?.trigger;
  const upcoming = useMemo(() => {
    if (form.kind === 'once') {
      const at = new Date(form.runAt);
      return Number.isNaN(at.getTime()) ? [] : [at];
    }
    if (trigger?.intervalMinutes) return nextIntervalRuns(trigger.intervalMinutes, now, 3);
    return trigger?.cron ? nextCronRuns(trigger.cron, now, 3) : [];
  }, [form.kind, form.runAt, trigger?.cron, trigger?.intervalMinutes, now]);
  const oncePast = form.kind === 'once' && upcoming[0] !== undefined && upcoming[0].getTime() <= now.getTime();
  const appendTarget = session ?? candidates.find(item => item.id === form.appendSessionId);
  const target = form.delivery === 'append'
    ? appendTarget ? `追加到「${appendTarget.title || appendTarget.cwd}」` : '还没选要追加的会话'
    : `用 ${enabledAgents.find(agent => agent.id === form.agentId)?.name ?? '…'} 在 ${form.cwd.split(/[\\/]/).filter(Boolean).pop() || '…'} 新开会话`;
  const when = form.kind === 'once' ? (upcoming[0] ? describeRunTime(upcoming[0], now) : '未选时间') : trigger?.intervalMinutes ? describeInterval(trigger.intervalMinutes) : trigger?.cron ? describeCron(trigger.cron) : '周期未填完整';

  const label = 'text-[12px] font-medium text-zinc-700';
  const sub = 'text-[11px] text-zinc-400';
  const agentOptions = enabledAgents.map(agent => ({ value: agent.id, label: <span className="flex items-center gap-2"><AgentIcon agentId={agent.id} agentName={agent.name} size={15}/>{agent.name}</span> }));
  const modelOptions = [{ value: '', label: models.data?.defaultModel ? `Agent 默认（${models.data.defaultModel}）` : 'Agent 默认' }, ...(models.data?.models ?? []).map(item => ({ value: item.id, label: item.name }))];
  const workspaceOptions = workspaces.map(path => ({ value: path, label: <span className="flex min-w-0 items-baseline gap-2"><span className="shrink-0">{path.split(/[\\/]/).filter(Boolean).pop() || path}</span><span className="min-w-0 truncate font-mono text-[11px] text-zinc-400">{path}</span></span> }));
  return <div className="flex min-h-0 flex-1 flex-col" onKeyDown={event => { if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) { event.preventDefault(); submit(); } }}>
    <div className="flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto px-5 py-4">
      <label className="flex flex-col gap-1.5"><span className={label}>到点让 Agent 做什么</span>
        <Input.TextArea autoFocus value={form.prompt} onChange={event => update({ prompt: event.target.value })} autoSize={{ minRows: 3, maxRows: 8 }} placeholder="写成能独立执行的完整指令，例如：汇总昨天群里的消息，列出待办" className="text-[13px] leading-5"/>
        <span className={sub}>到点时 Agent 看不到现在的对话，把背景写进去。</span>
      </label>

      <div className="flex flex-col gap-2"><span className={label}>什么时候</span>
        <Segmented<ScheduleFormState['kind']> className="self-start" value={form.kind} onChange={kind => update({ kind })} options={[{ value: 'recurring', label: '重复' }, { value: 'once', label: '只一次' }]}/>
        {form.kind === 'recurring' ? <>
          <div className="flex flex-wrap items-center gap-2">
            <Select className="w-28" value={form.recurrence.kind} onChange={kind => setRecurrence({ kind })} options={recurrenceKinds.map(item => ({ value: item.kind, label: item.label }))}/>
            {(form.recurrence.kind === 'daily' || form.recurrence.kind === 'weekdays' || form.recurrence.kind === 'weekly') && <TimePicker aria-label="触发时间" format="HH:mm" minuteStep={5} needConfirm={false} allowClear={false} showNow={false} value={form.recurrence.time ? dayjs(form.recurrence.time, 'HH:mm') : null} onChange={value => setRecurrence({ time: value ? value.format('HH:mm') : '' })} className="w-28"/>}
            {form.recurrence.kind === 'hourly' && <Select aria-label="每小时的第几分" className="w-32" value={form.recurrence.minute} onChange={minute => setRecurrence({ minute })} options={[0, 5, 10, 15, 20, 30, 45].map(minute => ({ value: minute, label: minute === 0 ? '整点' : `第 ${minute} 分` }))}/>}
            {form.recurrence.kind === 'interval' && <Space.Compact>
              <InputNumber<number> aria-label="间隔" min={1} precision={0} value={form.recurrence.every} onChange={value => setRecurrence({ every: value ?? 0 })} prefix={<span className="text-zinc-400">每</span>} className="w-28"/>
              <Select<IntervalUnit> aria-label="间隔单位" className="w-20" value={form.recurrence.everyUnit} onChange={everyUnit => setRecurrence({ everyUnit })} options={intervalUnits.map(item => ({ value: item.unit, label: item.label }))}/>
            </Space.Compact>}
          </div>
          {form.recurrence.kind === 'weekly' && <Checkbox.Group aria-label="星期" value={form.recurrence.weekdays} onChange={weekdays => setRecurrence({ weekdays })} options={weekdayOrder.map(day => ({ value: day, label: `周${weekdayLabels[day]}` }))}/>}
          {form.recurrence.kind === 'custom' && <div className="flex flex-col gap-1">
            <Input value={form.recurrence.cron} onChange={event => setRecurrence({ cron: event.target.value })} placeholder="0 9 * * 1-5" aria-label="cron 表达式" className="font-mono"/>
            <span className={sub}>5 段：分 时 日 月 周。例如 <code className="font-mono">0 9 1 * *</code> 是每月 1 号 09:00。</span>
          </div>}
        </> : <div className="flex flex-wrap items-center gap-2">
          <DatePicker aria-label="触发时间" showTime={{ format: 'HH:mm' }} format="YYYY-MM-DD HH:mm" allowClear={false} status={oncePast ? 'error' : undefined} disabledDate={day => day.isBefore(dayjs(now), 'day')} value={form.runAt ? dayjs(form.runAt) : null} onChange={value => update({ runAt: value ? value.format('YYYY-MM-DDTHH:mm') : '' })} className="w-48"/>
          <div className="flex flex-wrap gap-1">{oncePresets(now).map(preset => <Button key={preset.label} size="small" type={form.runAt === preset.value ? 'primary' : 'text'} onClick={() => update({ runAt: preset.value })}>{preset.label}</Button>)}</div>
        </div>}
      </div>

      <div className="flex flex-col gap-2"><span className={label}>在哪里执行</span>
        <Segmented className="self-start" value={form.delivery} onChange={delivery => update({ delivery })} options={(['new_session', 'append'] as const).map(delivery => ({ value: delivery, label: deliveryLabels[delivery] }))}/>
        <span className={sub}>{deliveryHints[form.delivery]}</span>
        {form.delivery === 'new_session' ? <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2">
          <div className="flex flex-col gap-1"><span className={sub}>Agent</span>
            <Select value={form.agentId || undefined} placeholder="选择 Agent" notFoundContent="没有可用 Agent" options={agentOptions} onChange={agentId => update({ agentId, model: '' })}/>
          </div>
          <div className="flex flex-col gap-1"><span className={sub}>模型</span>
            <Select value={form.model} showSearch optionFilterProp="label" loading={models.isFetching} options={modelOptions} onChange={model => update({ model })}/>
          </div>
          <div className="flex flex-col gap-1 sm:col-span-2"><span className={sub}>工作目录 <span className="text-zinc-300">可以直接输入绝对路径</span></span>
            <Space.Compact className="w-full">
              <AutoComplete className="min-w-0 flex-1" value={form.cwd} onChange={cwd => update({ cwd })} options={workspaceOptions} filterOption={(input, option) => String(option?.value ?? '').toLowerCase().includes(input.toLowerCase())} placeholder="/path/to/project" popupMatchSelectWidth>
                <Input className="font-mono text-[12px]" aria-label="工作目录" allowClear/>
              </AutoComplete>
              {capabilities.data?.directoryPicker && <Button icon={<FolderOpen size={13}/>} loading={pickDirectory.isPending} onClick={() => pickDirectory.mutate()}>浏览</Button>}
            </Space.Compact>
          </div>
        </div> : session
          ? <span className="text-[12px] text-zinc-600">追加到当前会话「{session.title || session.cwd}」</span>
          : <Select value={form.appendSessionId || undefined} placeholder="选择会话" notFoundContent="没有可追加的会话" showSearch optionFilterProp="title" options={candidates.map(item => ({ value: item.id, title: `${item.title || item.cwd} ${item.cwd}`, label: <span className="flex min-w-0 items-center gap-2"><AgentIcon agentId={item.agentId} size={15}/><span className="min-w-0 truncate">{item.title || item.cwd}</span><span className="ml-auto shrink-0 font-mono text-[11px] text-zinc-400">{item.cwd.split(/[\\/]/).filter(Boolean).pop()}</span></span> }))} onChange={appendSessionId => update({ appendSessionId })}/>}
      </div>

      <label className="flex flex-col gap-1.5"><span className={label}>名称 <span className="font-normal text-zinc-400">可选</span></span>
        <Input value={form.name} onChange={event => update({ name: event.target.value })} placeholder={form.prompt.trim() ? form.prompt.trim().slice(0, 24) : '不填则取内容开头'}/>
      </label>
    </div>

    <div className="shrink-0 border-t border-zinc-100 bg-zinc-50/70 px-5 py-3">
      <div className="mb-2.5 flex min-w-0 items-start gap-2 text-[12px] leading-5">
        <AlarmClock size={13} className="mt-1 shrink-0 text-zinc-400"/>
        <div className="min-w-0">
          <div className="text-zinc-800"><span className="font-medium">{when}</span><span className="text-zinc-400"> · </span><span className="text-zinc-600">{target}</span></div>
          {oncePast
            ? <div className="text-[11px] text-red-600">这个时间已经过去了，换一个。</div>
            : form.kind === 'recurring' && <div className="text-[11px] tabular-nums text-zinc-500">{upcoming.length ? `接下来：${upcoming.map(at => describeRunTime(at, now)).join('、')}` : trigger?.cron ? '未来两周内不会触发，确认表达式没写错' : built?.error}</div>}
        </div>
      </div>
      {error && <div role="alert" className="mb-2.5 rounded-md border border-red-100 bg-red-50 px-2.5 py-1.5 text-[12px] leading-5 text-red-700">{error}</div>}
      <div className="flex items-center justify-end gap-2">
        <span className="mr-auto hidden text-[11px] text-zinc-400 sm:inline">⌘/Ctrl + Enter 创建</span>
        <Button onClick={onCancel} disabled={create.isPending}>取消</Button>
        <Button type="primary" onClick={submit} loading={create.isPending} disabled={!form.prompt.trim() || oncePast}>创建</Button>
      </div>
    </div>
  </div>;
}

/**
 * 定时任务面板。
 * - 不传 session：全局列表（侧边栏入口），新建时直接选 Agent / 目录，或选一个会话追加。
 * - 传 session：只列这个会话的（会话标题栏入口），新建时用它的配置预填。
 */
export function ScheduleDialog({ session, sessions, onClose, onOpenSession }: { session?: Session; sessions: Session[]; onClose(): void; onOpenSession(id: string): void }) {
  const agents = useQuery({ queryKey: ['agents'], queryFn: () => api.agents() });
  const panelRef = useRef<HTMLDivElement>(null);
  useModalFocusTrap({ panel: panelRef, initial: panelRef, dismissible: true, onDismiss: onClose });
  const schedules = useQuery({ queryKey: ['schedules', session?.id ?? 'all'], queryFn: () => api.schedules(session?.id), refetchInterval: 15_000 });
  const actions = useScheduleActions();
  const [creating, setCreating] = useState(false);
  const titles = useMemo(() => new Map(sessions.map(item => [item.id, item.title || item.cwd])), [sessions]);
  const items = useMemo(() => [...(schedules.data ?? [])].sort((a, b) => Number(b.enabled) - Number(a.enabled) || (a.nextRunAt ?? '').localeCompare(b.nextRunAt ?? '') || b.createdAt.localeCompare(a.createdAt)), [schedules.data]);
  const openSession = (id: string) => { onOpenSession(id); onClose(); };
  const recentRuns = useQuery({ queryKey: ['schedules', 'recent-runs', session?.id ?? 'all'], queryFn: () => api.recentScheduleRuns(session?.id), refetchInterval: 15_000, enabled: !creating });
  const [now, setNow] = useState(() => new Date());
  useInterval(() => setNow(new Date()), 30_000);
  const summary = useMemo(() => summarizeSchedules(items, recentRuns.data ?? [], now), [items, recentRuns.data, now]);
  const lastRuns = useMemo(() => { const map = new Map<string, ScheduleRun>(); for (const run of recentRuns.data ?? []) if (!map.has(run.scheduleId)) map.set(run.scheduleId, run); return map; }, [recentRuns.data]);
  const names = useMemo(() => new Map(items.map(item => [item.id, item.name])), [items]);
  const loadError = schedules.error instanceof Error ? schedules.error.message : undefined;
  const toast = useToast();
  useUpdateEffect(() => { if (loadError) toast.show(`读取定时任务失败：${loadError}`); }, [loadError]);

  return <div className="ui-overlay fixed inset-0 z-[60] grid place-items-center bg-zinc-950/30 p-2 backdrop-blur-[2px] sm:p-4" onMouseDown={event => { if (event.currentTarget === event.target) onClose(); }}>
    <div ref={panelRef} role="dialog" aria-modal="true" aria-label="定时任务" className="ui-dialog flex h-[min(720px,86dvh)] w-full max-w-2xl flex-col overflow-hidden rounded-2xl border border-zinc-200 bg-white shadow-[0_24px_80px_rgba(24,24,27,.2)]">
      <div className="flex h-12 shrink-0 items-center gap-2 border-b border-zinc-100 px-4">
        {creating
          ? <><button type="button" onClick={() => setCreating(false)} aria-label="返回列表" className="-ml-1.5 grid h-8 w-8 place-items-center rounded-lg text-zinc-500 hover:bg-zinc-100 hover:text-zinc-800"><ArrowLeft size={16}/></button>
            <div className="text-[14px] font-semibold text-zinc-900">新建定时任务</div></>
          : <><div className="flex min-w-0 items-center gap-2 text-[14px] font-semibold text-zinc-900"><AlarmClock size={16}/>定时任务</div>
            <span className="hidden min-w-0 truncate text-[11px] text-zinc-400 sm:inline">{session ? `「${session.title || session.cwd}」的任务` : '全部会话'}</span></>}
        <div className="ml-auto flex items-center gap-1">
          {/* 空列表时主体里已有「新建定时任务」，标题栏不再重复。 */}
          {!creating && items.length > 0 && <Button type="text" icon={<Plus size={14}/>} onClick={() => setCreating(true)} className="font-medium text-zinc-600">新建</Button>}
          <button type="button" onClick={onClose} aria-label="关闭" className="grid h-8 w-8 place-items-center rounded-lg text-zinc-400 hover:bg-zinc-100 hover:text-zinc-800"><X size={16}/></button>
        </div>
      </div>
      {creating
        ? <ScheduleForm {...(session ? { session } : {})} agents={agents.data ?? []} sessions={sessions} onDone={name => { setCreating(false); toast.show(`已创建「${name}」`, 'info'); }} onCancel={() => setCreating(false)}/>
        : <div className="min-h-0 flex-1 overflow-y-auto">
          {schedules.isLoading && <div className="flex items-center gap-2 px-4 py-3 text-[12px] text-zinc-400"><LoaderCircle size={13} className="animate-spin"/>读取中…</div>}
          {!schedules.isLoading && !items.length && <div className="flex h-full flex-col items-center justify-center gap-3 px-6 pb-10 text-center">
            <div className="grid h-10 w-10 place-items-center rounded-full bg-zinc-100 text-zinc-400"><AlarmClock size={18}/></div>
            <div className="text-[13px] font-medium text-zinc-700">{session ? '这个会话还没有定时任务' : '还没有定时任务'}</div>
            <div className="max-w-sm text-[12px] leading-5 text-zinc-400">让 Agent 按时做事：每天早上汇总、工作日巡检、某个时间点提醒。也可以直接在对话里让 Agent 注册。</div>
            <Button type="primary" icon={<Plus size={14}/>} onClick={() => setCreating(true)} className="mt-1">新建定时任务</Button>
          </div>}
          {items.length > 0 && <ScheduleOverview summary={summary} now={now}/>}
          {items.map(schedule => <ScheduleRow key={schedule.id} schedule={schedule} sessionTitle={session ? undefined : scheduleTarget(schedule, titles, agents.data ?? [])} lastRun={lastRuns.get(schedule.id)} now={now} actions={actions} onOpenSession={openSession}/>)}
          {items.length > 0 && <RecentRuns runs={recentRuns.data ?? []} names={names} now={now} onOpenSession={openSession}/>}
        </div>}
    </div>
    {actions.toast}{toast.toast}
  </div>;
}
