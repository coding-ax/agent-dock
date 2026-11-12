import { memo, useEffect, useRef, useState, type CSSProperties } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, ChevronUp, Clock, ExternalLink, ListChecks, LoaderCircle, MessageCircleHeart, PanelRightOpen, Play, RotateCcw, Trash2 } from 'lucide-react';
import { api, type Agent, type AssistantReview, type AssistantTask } from '../api';
import { AgentIcon } from '../AgentIcon';
import { workspaceLabel } from '../session-groups';
import { noteTilt, noteTone, noteToneLabel, sinceLabel, tapeTilt } from './companion-model';
import { burst, prefersReducedMotion } from './effects';
import { useCompanionNav } from './useCompanion';
import { useCompanionStore } from './companion-store';

const verdictLabel: Record<AssistantReview['verdict'], string> = { accepted: '验收通过', rework: '打回返工', needs_user: '需要你拍板', cancelled: '已取消' };

/** 完成标准逐条对上最近一次验收的勾选结果：先按原文匹配，对不上再按顺序。 */
function checksFor(task: AssistantTask, review?: AssistantReview) {
  // 验收通过但没逐条打勾（主会话常常只给结论）：通过就意味着每条标准都满足了。
  const accepted = review ? review.verdict === 'accepted' : task.state === 'closed' && task.outcome === 'accepted';
  return task.doneWhen.map((criterion, index) => {
    const check = review?.checks.find(item => item.criterion.trim() === criterion.trim()) ?? review?.checks[index];
    return { criterion, met: check?.met ?? (accepted ? true : undefined), evidence: check?.evidence };
  });
}

/**
 * 一张便签 = 主会话派出去的一件事。
 *
 * 纸色跟状态走（进行中暖黄、待验收浅蓝、需要你浅橙、计划是铅笔虚线框、完成薄荷绿），
 * 每张按 id 稳定地歪一点、顶上贴一截胶带、右下角折一个角。悬停时拿起来摆正、露出工具条；
 * 点一下展开成整行，看完成标准的验收勾选、最近一次验收意见，并能直接打开对应的侧边会话。
 * 状态变成「已验收」时盖一个章并撒一把彩纸；被定位（从督办提示、气泡点过来）时闪一圈。
 */
export const StickyNote = memo(function StickyNote({ task, index, expanded, highlightNonce, kittenName, agent, now, onToggle }: {
  task: AssistantTask;
  index: number;
  expanded: boolean;
  highlightNonce?: number;
  kittenName: string;
  agent?: Agent;
  now: number;
  onToggle(id: string): void;
}) {
  const qc = useQueryClient();
  const nav = useCompanionNav();
  const article = useRef<HTMLElement>(null);
  const ring = useRef<HTMLSpanElement>(null);
  const tone = noteTone(task);
  const closed = task.state === 'closed';
  const [confirmCancel, setConfirmCancel] = useState(false);
  const [freshStamp, setFreshStamp] = useState(false);
  const previousState = useRef(task.state);

  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['assistant-state'] });
    void qc.invalidateQueries({ queryKey: ['assistant-task', task.id] });
  };
  const cancel = useMutation({ mutationFn: () => api.assistantCancelTask(task.id, '用户在便签上取消'), onSuccess: refresh, onSettled: () => setConfirmCancel(false) });
  const start = useMutation({ mutationFn: () => api.assistantStartPlanned(task.id), onSuccess: refresh });
  const detail = useQuery({ queryKey: ['assistant-task', task.id, task.updatedAt], queryFn: () => api.assistantTask(task.id), enabled: expanded, staleTime: 10_000 });
  const reviews = detail.data?.reviews ?? [];
  const latestReview = reviews.at(-1);

  // 「取消」要点两次：第一次变红提示，3 秒内再点才真的撕掉。
  useEffect(() => {
    if (!confirmCancel) return;
    const timer = window.setTimeout(() => setConfirmCancel(false), 3_000);
    return () => window.clearTimeout(timer);
  }, [confirmCancel]);

  // 眼看着它被验收：盖章 + 彩纸。打开抽屉之前就已经关掉的便签直接显示章，不重播。
  useEffect(() => {
    if (previousState.current !== 'closed' && task.state === 'closed') {
      setFreshStamp(true);
      if (task.outcome === 'accepted' && article.current) burst(article.current.getBoundingClientRect(), 'confetti', 14);
    }
    previousState.current = task.state;
  }, [task.state, task.outcome]);

  // 被定位：滚到视野中间，闪两圈、轻轻晃一下。
  useEffect(() => {
    if (!highlightNonce || !article.current) return;
    const reduced = prefersReducedMotion();
    const target = article.current;
    const timer = window.setTimeout(() => {
      target.scrollIntoView({ block: 'center', behavior: reduced ? 'auto' : 'smooth' });
      if (reduced) return;
      ring.current?.animate([
        { opacity: 0, transform: 'scale(.97)' }, { opacity: 1, transform: 'scale(1.01)', offset: 0.25 },
        { opacity: 0, transform: 'scale(1.05)', offset: 0.5 }, { opacity: 1, transform: 'scale(1.01)', offset: 0.75 }, { opacity: 0, transform: 'scale(1.05)' }
      ], { duration: 1500, delay: 280, easing: 'ease-out' });
      target.animate([{ rotate: '0deg' }, { rotate: '-2.4deg', offset: 0.2 }, { rotate: '2deg', offset: 0.4 }, { rotate: '-1.1deg', offset: 0.6 }, { rotate: '.5deg', offset: 0.8 }, { rotate: '0deg' }], { duration: 760, delay: 320, easing: 'ease-in-out' });
    }, 60);
    return () => window.clearTimeout(timer);
  }, [highlightNonce]);

  const ask = () => {
    const store = useCompanionStore.getState();
    store.draftForMain(`关于便签「${task.title}」（${task.id}）：`);
    store.closeDrawer();
    nav.openMain();
  };
  const openSession = (where: 'primary' | 'pane') => {
    useCompanionStore.getState().closeDrawer();
    nav.openTask(task, where);
  };

  const live = task.state === 'running';
  const since = sinceLabel(closed ? task.closedAt ?? task.updatedAt : task.updatedAt, now);
  const style = { '--tilt': `${noteTilt(task.id)}deg`, '--tape-tilt': `${tapeTilt(task.id)}deg` } as CSSProperties;
  const actionLabelPrefix = `便签「${task.title}」`;

  const actions = <div className="ui-note-actions">
    {task.sessionId && <button type="button" className="ui-note-action" data-primary={expanded || undefined} onClick={() => openSession('primary')} aria-label={`${actionLabelPrefix}：打开会话`} title="打开对应的侧边会话"><ExternalLink size={12}/><span className="ui-note-action-text">打开</span></button>}
    {task.sessionId && <button type="button" className="ui-note-action max-lg:hidden" onClick={() => openSession('pane')} aria-label={`${actionLabelPrefix}：在副屏打开`} title="在副屏并排打开"><PanelRightOpen size={12}/><span className="ui-note-action-text">副屏</span></button>}
    {task.plan && !closed && <button type="button" className="ui-note-action" data-primary={!task.sessionId || undefined} disabled={start.isPending} onClick={() => start.mutate()} aria-label={`${actionLabelPrefix}：开工`} title="按计划开工">{start.isPending ? <LoaderCircle size={12} className="animate-spin"/> : <Play size={12}/>}<span className="ui-note-action-text">开工</span></button>}
    <button type="button" className="ui-note-action" onClick={ask} aria-label={`${actionLabelPrefix}：问问${kittenName}`} title={`把这张便签带去问${kittenName}`}><MessageCircleHeart size={12}/><span className="ui-note-action-text">问问{kittenName}</span></button>
    {!closed && <button type="button" className="ui-note-action" data-danger="" data-confirm={confirmCancel || undefined} disabled={cancel.isPending} onClick={() => { if (confirmCancel) cancel.mutate(); else setConfirmCancel(true); }} aria-label={confirmCancel ? `${actionLabelPrefix}：再点一次确认取消` : `${actionLabelPrefix}：取消`} title={confirmCancel ? '再点一次确认撕掉' : '取消这张便签'}>{cancel.isPending ? <LoaderCircle size={12} className="animate-spin"/> : <Trash2 size={12}/>}<span className="ui-note-action-text">{confirmCancel ? '确认撕掉？' : '取消'}</span></button>}
  </div>;

  return <div className="ui-note-slot" data-flip-id={task.id} data-expanded={expanded || undefined} style={{ '--i': index } as CSSProperties}>
    <article ref={article} className={`ui-note ui-note-paper-${tone}`} data-live={live || undefined} style={style} aria-label={`${noteToneLabel[tone]}：${task.title}`}>
      <span className="ui-note-tape" aria-hidden="true"/>
      <span ref={ring} className="ui-note-ring" aria-hidden="true"/>
      {closed && <span className="ui-note-stamp" data-fresh={freshStamp || undefined} aria-hidden="true">{task.outcome === 'cancelled' ? '已取消' : <><Check size={11} strokeWidth={3}/>已验收</>}</span>}
      <button type="button" className="ui-note-main" aria-expanded={expanded} onClick={() => onToggle(task.id)}>
        <span className="ui-note-status ui-note-ink">
          <span className="ui-note-dot"/>
          <span className="truncate">{noteToneLabel[tone]}{task.round > 0 ? ` · 返工 ${task.round} 次` : ''}</span>
          {/* 盖了章的便签右上角留给印章，时间挪到底下那行。 */}
          {since && !closed && <span className="ml-auto shrink-0 font-normal text-zinc-500">{since}</span>}
        </span>
        <span className="ui-note-title">{task.title}</span>
        {live && <span className="ui-note-progress" aria-hidden="true"/>}
        <span className="ui-note-meta">
          {task.doneWhen.length > 0 && <span className="inline-flex items-center gap-1"><ListChecks size={11}/>{task.doneWhen.length} 条标准</span>}
          {task.expectMinutes ? <span className="inline-flex items-center gap-1"><Clock size={11}/>约 {task.expectMinutes} 分钟</span> : null}
          {(agent || task.agentId) && <span className="inline-flex min-w-0 items-center gap-1"><AgentIcon agentId={task.agentId} agentName={agent?.name} size={11}/><span className="truncate">{agent?.name ?? task.agentId}</span></span>}
          {closed && since && <span className="shrink-0">{since}</span>}
        </span>
      </button>
      <div className="ui-note-details" aria-hidden={!expanded} inert={!expanded}>
        <div>
          <div className="space-y-3 px-3 pb-2">
            {task.notes.trim() && <p className="max-h-40 overflow-y-auto whitespace-pre-wrap break-words text-[12.5px] leading-5 text-zinc-700">{task.notes.trim()}</p>}
            {task.doneWhen.length > 0 && <div>
              <div className="mb-1.5 text-[11px] font-semibold tracking-[.04em] text-zinc-500">完成标准{latestReview ? ` · ${verdictLabel[latestReview.verdict]}` : ''}</div>
              <ul className="space-y-1">
                {checksFor(task, latestReview).map((item, checkIndex) => <li key={checkIndex} className="ui-note-check" data-met={item.met === undefined ? undefined : String(item.met)} title={item.evidence}>
                  <span className="ui-note-check-box">{item.met === true ? <Check size={10} strokeWidth={3}/> : item.met === false ? <span className="text-[10px] font-bold leading-none">×</span> : null}</span>
                  <span className="min-w-0 break-words">{item.criterion}{item.evidence && <span className="mt-0.5 block text-[11.5px] text-zinc-500">{item.evidence}</span>}</span>
                </li>)}
              </ul>
            </div>}
            {latestReview?.note && <div className="rounded-lg bg-zinc-900/[.04] px-2.5 py-2 text-[12px] leading-5 text-zinc-600"><span className="font-medium text-zinc-800">{kittenName}的验收意见：</span>{latestReview.note}</div>}
            {expanded && detail.isLoading && <div className="flex items-center gap-1.5 text-[11.5px] text-zinc-400"><LoaderCircle size={11} className="animate-spin"/>正在取验收记录…</div>}
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-zinc-500">
              {task.cwd && <span title={task.cwd} className="truncate">📁 {workspaceLabel(task.cwd)}</span>}
              {(task.model || task.reasoningEffort) && <span title="派活时选定的模型与思考深度">⚙ {[task.model, task.reasoningEffort].filter(Boolean).join(' · ')}</span>}
              <span>派出于 {sinceLabel(task.createdAt, now) || '刚刚'}</span>
              {reviews.length > 1 && <span className="inline-flex items-center gap-1"><RotateCcw size={10}/>验收过 {reviews.length} 次</span>}
              <span className="font-mono text-zinc-400">{task.id}</span>
            </div>
          </div>
        </div>
      </div>
      {actions}
      {expanded && <button type="button" onClick={() => onToggle(task.id)} className="absolute bottom-2 right-3 grid h-6 w-6 place-items-center rounded-md text-zinc-500 transition-colors hover:bg-zinc-900/5 hover:text-zinc-800" aria-label="收起便签"><ChevronUp size={14}/></button>}
    </article>
  </div>;
});
