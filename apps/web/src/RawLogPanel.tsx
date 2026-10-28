import { useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ArrowDownToLine, Braces, Download, FileJson, RefreshCw, WrapText } from 'lucide-react';
import { Segmented } from 'antd';
import { api, type DockEvent } from './api';
import { HoverTooltip } from './HoverTooltip';
import { JsonTreeView } from './JsonTreeView';
import { RequestTrajectoryView, type RequestTrajectoryContext } from './RequestTrajectory';
import { buildRequestTrajectory } from './session-request-log';

const PAGE_SIZE = 200;

/** 原文优先；ACP 只提供结构化事件时显示完整 payload。 */
export function formatRawEvent(event: DockEvent): string {
  return `[${event.timestamp}] #${event.sequence} ${event.type}\n${event.raw ?? JSON.stringify(event.data, null, 2) ?? ''}`;
}

export function RawLogPanel({ sessionId, active = true }: { sessionId: string; active?: boolean }) {
  const [mode, setMode] = useState<'events' | 'requests' | 'record'>('events');
  const [recordView, setRecordView] = useState<'tree' | 'text'>('tree');
  const latest = useQuery({
    queryKey: ['raw-events', sessionId],
    queryFn: () => api.rawEvents(sessionId),
    enabled: active && mode === 'events',
    refetchInterval: active && mode === 'events' ? 3_000 : false,
    refetchOnWindowFocus: false,
  });
  const record = useQuery({
    queryKey: ['session-record', sessionId],
    queryFn: () => api.sessionRecord(sessionId),
    enabled: active && mode !== 'events',
    refetchOnWindowFocus: false,
  });
  // 轮次锚点图只有「实际请求」档要用，且整个面板只在换会话时算一次（服务端要扫该会话的全部 text 事件）。
  const turns = useQuery({
    queryKey: ['session-turns', sessionId],
    queryFn: () => api.sessionTurns(sessionId),
    enabled: active && mode === 'requests',
    refetchOnWindowFocus: false,
  });
  const [older, setOlder] = useState<DockEvent[]>([]);
  const [hasMore, setHasMore] = useState(true);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [olderError, setOlderError] = useState<string>();
  const [wrap, setWrap] = useState(true);
  const [follow, setFollow] = useState(true);
  const boxRef = useRef<HTMLDivElement>(null);
  const preserveScroll = useRef<{ height: number; top: number } | undefined>(undefined);

  const events = useMemo(() => {
    const bySequence = new Map<number, DockEvent>();
    for (const event of [...older, ...(latest.data ?? [])]) bySequence.set(event.sequence, event);
    return [...bySequence.values()].sort((a, b) => a.sequence - b.sequence);
  }, [older, latest.data]);
  const raw = useMemo(() => events.map(formatRawEvent).join('\n\n'), [events]);
  const recordJson = useMemo(() => record.data ? JSON.stringify(record.data, null, 2) : '', [record.data]);
  const displayedRaw = mode === 'record' ? recordJson : raw;
  const trajectory = useMemo(() => record.data ? buildRequestTrajectory(record.data, turns.data?.turns ?? []) : undefined, [record.data, turns.data]);
  // 逐轮过程要按需请求「这一轮」，就得把边界和「会话到底有没有事件」一起交下去——
  // 渲染层据此把「没保存事件」「早于锚点」「这一轮本来就空」分开说，不能自己猜。
  const context = useMemo<RequestTrajectoryContext>(() => ({
    sessionId,
    turns: turns.data?.turns ?? [],
    eventsSaved: Boolean(record.data?.eventsTruncated) || (record.data?.events.length ?? 0) > 0
  }), [sessionId, turns.data, record.data]);
  // 服务端只回最近一页事件（避免把百万行读进内存）。截断必须说出来：这一档叫「完整记录」，
  // 用户会拿它对账，静默少给事件等于给出错误结论。
  const recordNote = record.data?.eventsTruncated
    ? `事件仅显示最近 ${record.data.events.length} 条，共 ${record.data.eventTotal ?? '?'} 条；更早的事件请在「事件流」里逐页读取。`
    : undefined;
  const lines = useMemo(() => raw ? raw.split('\n').length : 0, [raw]);

  useLayoutEffect(() => {
    if (mode === 'events' && follow && boxRef.current) boxRef.current.scrollTop = boxRef.current.scrollHeight;
  }, [raw, follow, mode]);
  useLayoutEffect(() => {
    const previous = preserveScroll.current;
    if (!previous || !boxRef.current) return;
    boxRef.current.scrollTop = previous.top + boxRef.current.scrollHeight - previous.height;
    preserveScroll.current = undefined;
  }, [older]);

  const loadOlder = async () => {
    const first = events[0]?.sequence;
    if (!first || loadingOlder) return;
    setLoadingOlder(true);
    setOlderError(undefined);
    setFollow(false);
    try {
      const page = await api.rawEvents(sessionId, first);
      if (boxRef.current) preserveScroll.current = { height: boxRef.current.scrollHeight, top: boxRef.current.scrollTop };
      setOlder(current => [...page, ...current]);
      setHasMore(page.length === PAGE_SIZE);
    } catch (error) {
      setOlderError(error instanceof Error ? error.message : String(error));
    } finally {
      setLoadingOlder(false);
    }
  };

  const downloadRecord = () => {
    if (!recordJson) return;
    const url = URL.createObjectURL(new Blob([recordJson + '\n'], { type: 'application/json' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = `${sessionId}-record.json`;
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1_000);
  };

  return <div className="flex h-full min-h-0 flex-col bg-white">
    <div className="flex h-10 shrink-0 items-center gap-2 border-b border-zinc-200 px-3 text-[11px] text-zinc-500">
      <Segmented<typeof mode> size="small" aria-label="原始日志模式" className="shrink-0 text-[11px]" value={mode} onChange={next => { setMode(next); if (next !== 'events' && boxRef.current) boxRef.current.scrollTop = 0; }} options={[{ value: 'events', label: '事件流' }, { value: 'requests', label: '实际请求' }, { value: 'record', label: '完整记录' }]}/>
      <span className="truncate font-mono text-[10px] text-zinc-400" title={sessionId}>{sessionId.slice(0, 16)}…</span>
      <span className="shrink-0 tabular-nums text-[10px] text-zinc-400">{mode === 'events' ? `${events.length} 条 · ${lines} 行` : record.data ? `${record.data.tasks.length} 任务 · ${record.data.events.length} 事件${record.data.eventsTruncated ? ` / 共 ${record.data.eventTotal ?? '?'}` : ''}` : ''}</span>
      <span className="ml-auto flex items-center gap-1">
        <HoverTooltip content="刷新"><button type="button" aria-label="刷新原始日志" onClick={() => void (mode === 'events' ? latest.refetch() : record.refetch())} className={`grid h-7 w-7 place-items-center rounded-md ${toolButtonTone(false)}`}><RefreshCw size={13}/></button></HoverTooltip>
        <HoverTooltip content={wrap ? '关闭自动换行' : '开启自动换行'}><button type="button" aria-label="切换自动换行" aria-pressed={wrap} onClick={() => setWrap(value => !value)} className={`grid h-7 w-7 place-items-center rounded-md ${toolButtonTone(wrap)}`}><WrapText size={13}/></button></HoverTooltip>
        {mode === 'record' ? <>
          <HoverTooltip content={recordView === 'tree' ? '显示原始 JSON 文本' : '显示结构视图'}><button type="button" aria-label="切换记录视图" aria-pressed={recordView === 'tree'} onClick={() => setRecordView(value => value === 'tree' ? 'text' : 'tree')} className={`grid h-7 w-7 place-items-center rounded-md ${toolButtonTone(recordView === 'tree')}`}>{recordView === 'tree' ? <Braces size={13}/> : <FileJson size={13}/>}</button></HoverTooltip>
          <HoverTooltip content="下载完整记录 JSON"><button type="button" aria-label="下载完整记录" disabled={!recordJson} onClick={downloadRecord} className={`grid h-7 w-7 place-items-center rounded-md disabled:opacity-40 ${toolButtonTone(false)}`}><Download size={13}/></button></HoverTooltip>
        </> : <HoverTooltip content={follow ? '停止跟随最新输出' : '跟随最新输出'}><button type="button" aria-label="切换跟随输出" aria-pressed={follow} onClick={() => { setFollow(value => !value); if (!follow && boxRef.current) boxRef.current.scrollTop = boxRef.current.scrollHeight; }} className={`grid h-7 w-7 place-items-center rounded-md ${toolButtonTone(follow)}`}><ArrowDownToLine size={13}/></button></HoverTooltip>}
      </span>
    </div>
    <div className="border-b border-zinc-200 bg-zinc-50/70 px-3 py-1.5 text-[10px] leading-4 text-zinc-500">{mode === 'requests' ? '按轮次展示创建时的 System Prompt、每轮实际发送给 Agent 的文本，以及每轮的最终输出与思考、工具调用（过程按需读取，不占首屏）。注入内容单独标出；旧任务未保存的请求无法还原；手动刷新获取最新记录。' : mode === 'record' ? <>会话配置、全部任务（含已保存的实际请求）和事件；默认按结构折叠，可切回原始 JSON。手动刷新获取最新记录。{recordNote && <span className="text-amber-700"> {recordNote}</span>}</> : '显示会话收到的原始事件；Agent 未提供终端原文时显示事件数据。最新事件每 3 秒刷新。'}</div>
    {(mode === 'events' ? latest.error : record.error) && <div role="alert" className="border-b border-red-200 bg-red-50 px-3 py-2 text-[11px] text-red-600">{(mode === 'events' ? latest.error : record.error)?.message}</div>}
    <div ref={boxRef} onScroll={event => { const el = event.currentTarget; if (follow && el.scrollHeight - el.scrollTop - el.clientHeight > 24) setFollow(false); }} className={`min-h-0 flex-1 overflow-auto bg-zinc-50/60 p-3 text-[11px] leading-5 text-zinc-700 ${mode === 'requests' ? '' : 'font-mono'}`}>
      {mode === 'events' && events.length > 0 && hasMore && (older.length > 0 || latest.data?.length === PAGE_SIZE) && <button type="button" disabled={loadingOlder} onClick={() => void loadOlder()} className="mb-3 rounded-md border border-zinc-300 bg-white px-2.5 py-1 text-[10px] text-zinc-600 hover:bg-zinc-100 disabled:opacity-50">{loadingOlder ? '读取中…' : '加载更早事件'}</button>}
      {mode === 'events' && olderError && <div role="alert" className="mb-2 text-red-600">{olderError}</div>}
      {mode === 'requests'
        ? trajectory ? <RequestTrajectoryView trajectory={trajectory} context={context} wrap={wrap}/> : <span className="text-zinc-500">{record.isLoading ? '读取记录中…' : '暂无记录。'}</span>
        : mode === 'record' && record.data && recordView === 'tree'
          ? <JsonTreeView value={record.data} wrap={wrap}/>
          : displayedRaw ? <pre className={`m-0 ${wrap ? 'whitespace-pre-wrap break-words' : 'whitespace-pre'}`}>{displayedRaw}</pre> : <span className="text-zinc-500">{mode === 'events' ? (latest.isLoading ? '读取事件中…' : '当前会话暂无事件。') : (record.isLoading ? '读取记录中…' : '暂无记录。')}</span>}
    </div>
  </div>;
}


function toolButtonTone(active: boolean): string {
  return active ? 'bg-zinc-100 text-zinc-900' : 'text-zinc-500 hover:bg-zinc-100 hover:text-zinc-900';
}
