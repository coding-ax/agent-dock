import { useEffect, useLayoutEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent, type RefObject } from 'react';
import { useEventListener, useMemoizedFn } from 'ahooks';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { LoaderCircle, PawPrint, Send, Settings2, Trash2, X } from 'lucide-react';
import { api, type AssistantDraft } from '../api';
import { ArchiveShelf } from './ArchiveShelf';
import { Kitten } from './Kitten';
import { StickyNote } from './StickyNote';
import { groupNotes, type NoteCounts, type NoteFilter } from './companion-model';
import { prefersReducedMotion, springEasing } from './effects';
import { useAssistantState, useCompanion, useCompanionNav } from './useCompanion';
import { useCompanionStore } from './companion-store';

const FILTERS: Array<{ key: NoteFilter; label: string; count(counts: NoteCounts): number; hot?(counts: NoteCounts): boolean }> = [
  { key: 'all', label: '全部', count: counts => counts.open + counts.closed },
  // 计划卡和「需要你」同栏展示，但不报红：只有真正卡住的事才点亮。
  { key: 'needs_user', label: '需要你', count: counts => counts.needsUser + counts.planned, hot: counts => counts.needsUser > 0 },
  { key: 'review', label: '待验收', count: counts => counts.review },
  { key: 'running', label: '进行中', count: counts => counts.running },
  { key: 'closed', label: '已完成', count: counts => counts.closed }
];

const draftChannelLabel: Record<AssistantDraft['channel'], string> = { github_comment: 'GitHub 评论', lark_reply: '飞书回复' };

/**
 * FLIP：每次提交后记下每张便签相对滚动内容的位置；下次布局变了（展开、切换过滤、
 * 状态变化挪到别的分区），新位置的便签先瞬移回旧位置再弹簧滑过去。
 * 动的是外层 slot，里层便签自己的倾斜 transform 不受影响。
 */
function useFlip(container: RefObject<HTMLElement | null>, signature: string) {
  const last = useRef(new Map<string, { x: number; y: number }>());
  useLayoutEffect(() => {
    const root = container.current;
    if (!root) return;
    const origin = root.getBoundingClientRect();
    const elements = [...root.querySelectorAll<HTMLElement>('[data-flip-id]')];
    const next = new Map<string, { x: number; y: number }>();
    for (const element of elements) {
      const rect = element.getBoundingClientRect();
      next.set(element.dataset.flipId!, { x: rect.left - origin.left, y: rect.top - origin.top + root.scrollTop });
    }
    if (!prefersReducedMotion() && last.current.size) {
      const easing = springEasing('soft');
      for (const element of elements) {
        const before = last.current.get(element.dataset.flipId!);
        const after = next.get(element.dataset.flipId!);
        if (!before || !after) continue;
        const dx = before.x - after.x;
        const dy = before.y - after.y;
        if (Math.abs(dx) < 1 && Math.abs(dy) < 1) continue;
        element.animate([{ transform: `translate(${dx}px, ${dy}px)` }, { transform: 'translate(0, 0)' }], { duration: 560, easing });
      }
    }
    last.current = next;
  }, [container, signature]);
}

/** 过滤条的滑块：量出当前项的位置和宽度，交给 CSS 变量做弹簧过渡。 */
function useFilterPill(container: RefObject<HTMLDivElement | null>, active: string, signature: string) {
  useLayoutEffect(() => {
    const root = container.current;
    const chip = root?.querySelector<HTMLElement>(`[data-filter="${active}"]`);
    if (!root || !chip) return;
    root.style.setProperty('--pill-x', `${chip.offsetLeft - 3}px`);
    root.style.setProperty('--pill-w', `${chip.offsetWidth}px`);
  }, [container, active, signature]);
}

function DraftCard({ draft }: { draft: AssistantDraft }) {
  const qc = useQueryClient();
  const refresh = () => void qc.invalidateQueries({ queryKey: ['assistant-state'] });
  const send = useMutation({ mutationFn: () => api.assistantSendDraft(draft.id), onSuccess: refresh });
  const discard = useMutation({ mutationFn: () => api.assistantDiscardDraft(draft.id), onSuccess: refresh });
  const busy = send.isPending || discard.isPending;
  const error = send.error ?? discard.error;
  return <div className="ui-note-slot" data-flip-id={draft.id} data-expanded="">
    <article className="ui-note ui-note-paper-review" aria-label={`待确认的${draftChannelLabel[draft.channel]}`}>
      <span className="ui-note-tape" aria-hidden="true"/>
      <div className="flex flex-col gap-1.5 px-3 pb-2 pt-3.5">
        <span className="ui-note-status ui-note-ink"><span className="ui-note-dot"/>{draftChannelLabel[draft.channel]}草稿 · 等你确认</span>
        <span className="truncate font-mono text-[11.5px] text-zinc-500" title={draft.target}>{draft.target}</span>
        <p className="max-h-28 overflow-y-auto whitespace-pre-wrap break-words text-[12.5px] leading-5 text-zinc-800">{draft.body}</p>
        {draft.lastError && <p className="text-[11.5px] text-red-600">上次发送失败：{draft.lastError}</p>}
        {error && <p className="text-[11.5px] text-red-600">{error.message}</p>}
      </div>
      <div className="ui-note-actions">
        <button type="button" className="ui-note-action" data-primary="" disabled={busy} onClick={() => send.mutate()}>{send.isPending ? <LoaderCircle size={12} className="animate-spin"/> : <Send size={12}/>}<span className="ui-note-action-text">发送</span></button>
        <button type="button" className="ui-note-action" data-danger="" disabled={busy} onClick={() => discard.mutate()}>{discard.isPending ? <LoaderCircle size={12} className="animate-spin"/> : <Trash2 size={12}/>}<span className="ui-note-action-text">丢弃</span></button>
      </div>
    </article>
  </div>;
}

function DrawerBody({ filter, expandedId, onToggle, highlight, now }: { filter: NoteFilter; expandedId?: string; onToggle(id: string): void; highlight?: { taskId: string; nonce: number }; now: number }) {
  const info = useCompanion();
  const nav = useCompanionNav();
  const drafts = useAssistantState().data?.drafts;
  const agents = useQuery({ queryKey: ['agents'], queryFn: () => api.agents(), staleTime: 60_000 }).data;
  const scroller = useRef<HTMLDivElement>(null);
  const sections = useMemo(() => groupNotes(info.tasks, filter), [info.tasks, filter]);
  const pendingDrafts = useMemo(() => (drafts ?? []).filter(draft => draft.state === 'pending'), [drafts]);
  const showDrafts = pendingDrafts.length > 0 && (filter === 'all' || filter === 'needs_user');
  const signature = `${filter}|${expandedId ?? ''}|${sections.map(section => `${section.key}:${section.tasks.map(task => task.id).join(',')}`).join(';')}|${pendingDrafts.length}`;
  useFlip(scroller, signature);

  let index = 0;
  const empty = !sections.some(section => section.tasks.length) && !showDrafts;
  return <div ref={scroller} className="ui-drawer-body">
    {!info.adopted ? <div className="flex flex-col items-center px-6 pb-6 pt-10 text-center">
      <Kitten size={72} mood="curious"/>
      <p className="mt-3 text-[14px] font-semibold text-zinc-800">还没有小猫帮你记便签</p>
      <p className="mt-1 text-[12.5px] leading-5 text-zinc-500">认领一只小猫当主会话，它派出去的活都会贴在这里。</p>
      <button type="button" onClick={() => { useCompanionStore.getState().closeDrawer(); nav.goAdopt(); }} className="mt-4 inline-flex h-9 items-center gap-1.5 rounded-full bg-zinc-900 px-4 text-[13px] font-medium text-white transition-transform hover:bg-zinc-700 active:scale-95"><PawPrint size={14}/>去认领</button>
    </div> : empty ? <div className="flex flex-col items-center px-6 pb-6 pt-10 text-center">
      <Kitten size={68} mood={filter === 'all' ? 'sleepy' : 'idle'} stage={info.stage} collar/>
      <p className="mt-3 text-[14px] font-semibold text-zinc-800">{filter === 'all' ? '一张便签都还没有' : filter === 'needs_user' ? '没有需要你点头的事' : '这一栏是空的'}</p>
      <p className="mt-1 max-w-[260px] text-[12.5px] leading-5 text-zinc-500">{filter === 'all' ? `跟${info.name}说说要做的事，它会拆成便签派出去，做完帮你验收。` : filter === 'needs_user' ? `${info.name}拿不准的事、写好等你点头的计划会贴到这里。` : '换个分类看看吧。'}</p>
      {filter === 'all' && <button type="button" onClick={() => { useCompanionStore.getState().closeDrawer(); nav.openMain(); }} className="mt-4 inline-flex h-9 items-center gap-1.5 rounded-full bg-zinc-900 px-4 text-[13px] font-medium text-white transition-transform hover:bg-zinc-700 active:scale-95"><PawPrint size={14}/>和{info.name}聊聊</button>}
    </div> : <>
      {showDrafts && <section className="ui-drawer-section">
        <h3 className="ui-drawer-section-title">待你确认的草稿 · {pendingDrafts.length}</h3>
        <div className="ui-note-grid">{pendingDrafts.map(draft => <DraftCard key={draft.id} draft={draft}/>)}</div>
      </section>}
      {sections.map(section => <section key={section.key} className="ui-drawer-section">
        <h3 className="ui-drawer-section-title">{section.label} · {section.tasks.length}</h3>
        {section.tasks.length ? <div className="ui-note-grid">
          {section.tasks.map(task => <StickyNote key={task.id} task={task} index={index++} expanded={expandedId === task.id} highlightNonce={highlight?.taskId === task.id ? highlight.nonce : undefined} kittenName={info.name} agent={agents?.find(agent => agent.id === task.agentId)} now={now} onToggle={onToggle}/>)}
        </div> : <p className="px-1 text-[12px] text-zinc-400">这一栏是空的。</p>}
      </section>)}
    </>}
    {info.adopted && (filter === 'all' || filter === 'closed') && <ArchiveShelf/>}
  </div>;
}

/**
 * 便签抽屉：从右边划出来的一面便签墙。
 *
 * 按「需要你 → 待验收 → 进行中 → 已完成」分区，顶上一排过滤（滑块弹簧跟随），
 * 打开时便签从上往下依次落下；点便签原地展开，其余便签用 FLIP 让开。
 * 关掉：点遮罩、按 Esc、点 ×、或在触屏上往右一划。
 */
export function StickyDrawer() {
  const open = useCompanionStore(store => store.drawerOpen);
  const nonce = useCompanionStore(store => store.drawerNonce);
  const filter = useCompanionStore(store => store.filter);
  const highlight = useCompanionStore(store => store.highlight);
  const info = useCompanion();
  const nav = useCompanionNav();
  const [expandedId, setExpandedId] = useState<string>();
  const [now, setNow] = useState(() => Date.now());
  const [dragging, setDragging] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const filterRef = useRef<HTMLDivElement>(null);
  const returnFocus = useRef<HTMLElement | null>(null);
  const swipe = useRef<{ id: number; x: number; y: number; mode?: 'swipe' | 'scroll'; dx: number } | undefined>(undefined);
  const close = useMemoizedFn(() => useCompanionStore.getState().closeDrawer());

  const counts = info.counts;
  useFilterPill(filterRef, filter, `${nonce}|${info.adopted}|${counts.open}|${counts.closed}|${counts.needsUser}|${counts.planned}|${counts.review}|${counts.running}`);

  // 被定位的便签自动展开；每次打开抽屉都从收起开始。
  useEffect(() => { if (highlight) setExpandedId(highlight.taskId); }, [highlight]);
  useEffect(() => {
    if (open) {
      returnFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      setNow(Date.now());
      const timer = window.setTimeout(() => closeRef.current?.focus({ preventScroll: true }), 80);
      const tick = window.setInterval(() => setNow(Date.now()), 30_000);
      return () => { window.clearTimeout(timer); window.clearInterval(tick); };
    }
    setExpandedId(undefined);
    returnFocus.current?.focus?.({ preventScroll: true });
    returnFocus.current = null;
  }, [open]);
  useEffect(() => { if (!open) useCompanionStore.setState({ highlight: undefined }); }, [open]);
  useEventListener('keydown', (event: KeyboardEvent) => { if (event.key === 'Escape') { event.stopPropagation(); close(); } }, { target: () => window, enable: open });

  const toggleNote = useMemoizedFn((id: string) => setExpandedId(current => current === id ? undefined : id));

  // 触屏往右划关掉；纵向滑动照常滚动列表。
  const onPointerDown = (event: ReactPointerEvent<HTMLElement>) => {
    if (event.pointerType === 'mouse') return;
    swipe.current = { id: event.pointerId, x: event.clientX, y: event.clientY, dx: 0 };
  };
  const onPointerMove = (event: ReactPointerEvent<HTMLElement>) => {
    const current = swipe.current;
    if (!current || current.id !== event.pointerId || current.mode === 'scroll') return;
    const dx = event.clientX - current.x;
    const dy = event.clientY - current.y;
    if (!current.mode) {
      if (Math.abs(dy) > 10 && Math.abs(dy) > Math.abs(dx)) { current.mode = 'scroll'; return; }
      if (dx < 12 || Math.abs(dx) < Math.abs(dy) * 1.4) return;
      current.mode = 'swipe';
      panelRef.current?.setPointerCapture(event.pointerId);
      setDragging(true);
    }
    current.dx = Math.max(0, dx);
    rootRef.current?.style.setProperty('--drawer-drag', `${current.dx}px`);
  };
  const onPointerEnd = (event: ReactPointerEvent<HTMLElement>) => {
    const current = swipe.current;
    if (!current || current.id !== event.pointerId) return;
    swipe.current = undefined;
    if (current.mode !== 'swipe') return;
    setDragging(false);
    rootRef.current?.style.removeProperty('--drawer-drag');
    if (current.dx > 90) close();
  };

  // 第一次打开之前不建 DOM。
  if (!nonce) return null;
  const summary = [
    counts.needsUser ? `${counts.needsUser} 件需要你` : '',
    counts.planned ? `${counts.planned} 张计划等你点头` : '',
    counts.running ? `${counts.running} 张进行中` : '',
    counts.review ? `${counts.review} 张待验收` : '',
    !counts.open && counts.closed ? `${counts.closed} 张已完成` : ''
  ].filter(Boolean).join(' · ') || (info.adopted ? '还没有便签' : '还没有认领小猫');

  return <div ref={rootRef} className="ui-drawer-root" data-open={open || undefined} data-dragging={dragging || undefined} inert={!open} aria-hidden={!open}>
    <div className="ui-drawer-backdrop" onClick={close}/>
    <aside ref={panelRef} role="dialog" aria-modal="true" aria-label={`${info.name}的便签`} className="ui-drawer" onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerEnd} onPointerCancel={onPointerEnd}>
      <div key={`head-${nonce}`} className="ui-drawer-head">
        <span className="ui-companion-avatar ui-cat-hover-host"><Kitten variant="face" size={30} mood={info.adopted ? info.mood : 'curious'} stage={info.adopted ? info.stage : undefined} collar={info.adopted} interactive={false}/></span>
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-[15px] font-semibold tracking-[-.01em] text-zinc-900">{info.adopted ? `${info.name}的便签` : '便签'}</h2>
          <p className="truncate text-[12px] text-zinc-500">{summary}</p>
        </div>
        <button ref={closeRef} type="button" onClick={close} aria-label="收起便签" className="grid h-8 w-8 shrink-0 place-items-center rounded-lg text-zinc-500 transition-colors hover:bg-zinc-200/60 hover:text-zinc-900"><X size={16}/></button>
      </div>
      {info.adopted && <div key={`filter-${nonce}`} ref={filterRef} className="ui-filter" role="toolbar" aria-label="按状态筛选便签">
        <span className="ui-filter-pill" aria-hidden="true"/>
        {FILTERS.map(item => {
          const count = item.count(counts);
          return <button key={item.key} type="button" data-filter={item.key} aria-pressed={filter === item.key} data-hot={item.hot?.(counts) ? '' : undefined} onClick={() => { useCompanionStore.getState().setFilter(item.key); setExpandedId(undefined); }} className="ui-filter-chip">{item.label}{count > 0 && <span className="ui-filter-count">{count}</span>}</button>;
        })}
      </div>}
      <DrawerBody key={nonce} filter={filter} expandedId={expandedId} onToggle={toggleNote} highlight={highlight} now={now}/>
      {info.adopted && <div className="ui-drawer-foot">
        <button type="button" onClick={() => { close(); nav.openSettings(); }} className="inline-flex h-8 items-center gap-1.5 rounded-lg px-2.5 text-[12.5px] text-zinc-500 transition-colors hover:bg-zinc-200/60 hover:text-zinc-900"><Settings2 size={14}/>督办设置</button>
        <button type="button" onClick={() => { close(); nav.openMain(); }} className="ml-auto inline-flex h-8 items-center gap-1.5 rounded-full bg-zinc-900 px-3.5 text-[12.5px] font-medium text-white transition-[background-color,transform] hover:bg-zinc-700 active:scale-95"><PawPrint size={13}/>和{info.name}聊聊</button>
      </div>}
    </aside>
  </div>;
}
