import { useEffect, useRef, useState } from 'react';
import { useEventListener } from 'ahooks';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import {
  Check,
  CheckCircle2,
  ExternalLink,
  FileText,
  LoaderCircle,
  PawPrint,
  Pin,
  Play,
  RotateCcw,
  Save,
  X
} from 'lucide-react';
import {
  api,
  type Agent,
  type AssistantTask,
  type HydratedBoardColumn,
  type HydratedBoardItem,
  type Session
} from '../api';
import { AgentIcon } from '../AgentIcon';
import { AiFieldHeader, AiTextAssistControl, useAiFlash } from '../AiTextAssist';
import { HoverTooltip } from '../HoverTooltip';
import { SessionPane } from '../SessionPane';
import { nextClientMutationId, useBoardStore } from './board-store';
import {
  COLUMN_COLOR_STYLES,
  VISUAL_STATE_META,
  formatBoardElapsed,
  toMentionedCard
} from './board-utils';

interface BoardDetailDrawerProps {
  boardId: string;
  item: HydratedBoardItem;
  columns: HydratedBoardColumn[];
  session?: Session;
  task?: AssistantTask;
  agent?: Agent;
  onClose(): void;
  onOpenFullSession(sessionId: string): void;
  onOpenSidebar(): void;
  onNotice(text: string, tone?: 'info' | 'error' | 'success'): void;
}

export function BoardDetailDrawer({
  boardId,
  item,
  columns,
  session,
  task,
  agent,
  onClose,
  onOpenFullSession,
  onOpenSidebar,
  onNotice
}: BoardDetailDrawerProps) {
  const qc = useQueryClient();
  const [drawerWidth, setDrawerWidth] = useState(560);
  const [resizing, setResizing] = useState(false);
  const [noteDraft, setNoteDraft] = useState(item.userNote ?? '');
  const [kittenNoteDraft, setKittenNoteDraft] = useState(item.kittenNote ?? '');
  const [savedNotice, setSavedNotice] = useState(false);
  const savedTimerRef = useRef<number | undefined>(undefined);
  const noteFlash = useAiFlash();
  const kittenNoteFlash = useAiFlash();
  const currentColumnName = columns.find(col => col.id === item.columnId)?.name;

  useEffect(() => {
    setNoteDraft(item.userNote ?? '');
    setKittenNoteDraft(item.kittenNote ?? '');
    setSavedNotice(false);
  }, [item.id, item.userNote, item.kittenNote]);

  useEffect(() => () => {
    window.clearTimeout(savedTimerRef.current);
  }, []);

  useEventListener('keydown', (event: KeyboardEvent) => {
    if (event.key === 'Escape') {
      event.stopPropagation();
      onClose();
    }
  }, { target: () => window });

  useEventListener('pointermove', (event: PointerEvent) => {
    if (!resizing) return;
    const next = Math.min(Math.max(420, window.innerWidth - event.clientX), Math.min(820, window.innerWidth - 160));
    setDrawerWidth(next);
  }, { target: () => document, enable: resizing });

  useEventListener('pointerup', () => {
    if (resizing) setResizing(false);
  }, { target: () => document, enable: resizing });

  const stateMeta = VISUAL_STATE_META[item.live.visualState] ?? VISUAL_STATE_META.idle;
  const elapsed = formatBoardElapsed(item.live.activeMs);
  const reworkRounds = item.live.round && item.live.round > 1 ? item.live.round - 1 : 0;

  const startPlanMutation = useMutation({
    mutationFn: () => api.assistantStartPlanned(item.entityId),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['board', boardId] });
      void qc.invalidateQueries({ queryKey: ['assistant-state'] });
      useBoardStore.getState().flashKitten('delegating', '已启动该计划任务', 3_200);
      onNotice('计划已启动执行', 'info');
    },
    onError: err => onNotice(err instanceof Error ? err.message : String(err), 'error')
  });

  const reviewMutation = useMutation({
    mutationFn: (verdict: 'accepted' | 'rework') =>
      api.assistantReviewTask(item.entityId, {
        verdict,
        note: verdict === 'accepted' ? '在看板详情抽屉确认验收通过' : '在看板详情抽屉退回返工'
      }),
    onSuccess: (_res, verdict) => {
      void qc.invalidateQueries({ queryKey: ['board', boardId] });
      void qc.invalidateQueries({ queryKey: ['assistant-state'] });
      if (verdict === 'accepted') {
        useBoardStore.getState().triggerCelebrate('任务已验收通过！');
        onNotice('已验收通过', 'success');
      } else {
        useBoardStore.getState().flashKitten('thinking', '已打回返工', 3_000);
        onNotice('已打回返工', 'info');
      }
    },
    onError: err => onNotice(err instanceof Error ? err.message : String(err), 'error')
  });

  const saveNoteMutation = useMutation({
    mutationFn: () =>
      api.updateBoardItem(boardId, item.id, {
        userNote: noteDraft.trim() || null,
        kittenNote: kittenNoteDraft.trim() || null,
        clientMutationId: nextClientMutationId()
      }),
    onSuccess: res => {
      if (res.board) qc.setQueryData(['board', boardId], res.board);
      setSavedNotice(true);
      window.clearTimeout(savedTimerRef.current);
      savedTimerRef.current = window.setTimeout(() => setSavedNotice(false), 1600);
      onNotice('卡片备注已保存', 'success');
    },
    onError: err => onNotice(err instanceof Error ? err.message : String(err), 'error')
  });

  const moveColMutation = useMutation({
    mutationFn: (toColumnId: string) =>
      api.moveBoardItem(boardId, item.id, {
        toColumnId,
        placement: 'top',
        clientMutationId: nextClientMutationId()
      }),
    onSuccess: res => {
      if (res.board) qc.setQueryData(['board', boardId], res.board);
      onNotice('已移动到新列', 'info');
    },
    onError: err => onNotice(err instanceof Error ? err.message : String(err), 'error')
  });

  return (
    <div className="fixed inset-0 z-40 flex justify-end md:pointer-events-none">
      {/* 移动端半透明遮罩 */}
      <button
        type="button"
        aria-label="关闭详情抽屉"
        onClick={onClose}
        className="ui-board-drawer-scrim fixed inset-0 bg-zinc-950/25 md:hidden"
      />
      <aside
        role="dialog"
        aria-label={`任务详情：${item.live.title}`}
        style={{ ['--drawer-w' as string]: `${drawerWidth}px` }}
        className="ui-board-drawer pointer-events-auto relative z-10 flex h-full w-full flex-col border-l border-zinc-200 bg-canvas shadow-[-16px_0_44px_rgba(15,23,42,.14)] md:w-[var(--drawer-w)]"
      >
        {/* 桌面左侧拖拽调宽柄 */}
        <div
          onPointerDown={e => {
            e.preventDefault();
            setResizing(true);
          }}
          className="absolute inset-y-0 left-0 z-20 hidden w-1.5 cursor-col-resize bg-transparent hover:bg-blue-400/35 md:block"
        />

        {/* 抽屉顶部栏 */}
        <header
          className="flex shrink-0 items-center gap-2 border-b border-zinc-200 bg-white px-3.5 py-2.5"
          style={{ paddingTop: 'max(0.625rem, env(safe-area-inset-top))' }}
        >
          {item.entityKind === 'note' ? (
            <span className="grid h-6 w-6 shrink-0 place-items-center rounded-md bg-zinc-100 text-zinc-500">
              <FileText size={13}/>
            </span>
          ) : (
            <AgentIcon agentId={item.live.agentId ?? 'claude'} agentName={agent?.name ?? item.live.agentName} size={18}/>
          )}
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-1.5">
              <h3 className="truncate text-[14px] font-semibold text-zinc-900">{item.live.title}</h3>
              {item.pinned && <Pin size={12} className="shrink-0 fill-current text-amber-500"/>}
            </div>
            <div className="flex items-center gap-2 text-[11.5px] text-zinc-500">
              <span className="inline-flex items-center gap-1">
                <span className={`h-1.5 w-1.5 rounded-full ${stateMeta.dotClass}`}/>
                {stateMeta.label}
              </span>
              {elapsed && <span className="font-mono tabular-nums">{elapsed}</span>}
              <select
                aria-label="切换卡片所属列"
                value={item.columnId}
                onChange={e => moveColMutation.mutate(e.target.value)}
                className="h-5 rounded border border-zinc-200 bg-zinc-50 px-1.5 text-[11px] text-zinc-700"
              >
                {columns.map(col => (
                  <option key={col.id} value={col.id}>{col.name}</option>
                ))}
              </select>
            </div>
          </div>

          <HoverTooltip content="投喂给主小猫">
            <button
              type="button"
              aria-label="投喂给主小猫"
              onClick={() => {
                useBoardStore.getState().addDockMentionCard(toMentionedCard(item));
                onNotice(`已把「${item.live.title}」放进小猫指令栏`, 'info');
              }}
              className="ui-press grid h-8 w-8 shrink-0 place-items-center rounded-lg text-amber-600 transition-colors hover:bg-amber-50"
            >
              <PawPrint size={15}/>
            </button>
          </HoverTooltip>

          {session && (
            <HoverTooltip content="全屏打开完整会话">
              <button
                type="button"
                aria-label="全屏打开完整会话"
                onClick={() => onOpenFullSession(session.id)}
                className="ui-press grid h-8 w-8 shrink-0 place-items-center rounded-lg text-zinc-500 transition-colors hover:bg-zinc-100 hover:text-zinc-900"
              >
                <ExternalLink size={15}/>
              </button>
            </HoverTooltip>
          )}

          <HoverTooltip content="关闭抽屉（Esc）">
            <button
              type="button"
              aria-label="关闭抽屉"
              onClick={onClose}
              className="ui-press grid h-8 w-8 shrink-0 place-items-center rounded-lg text-zinc-500 transition-colors hover:bg-zinc-100 hover:text-zinc-900"
            >
              <X size={16}/>
            </button>
          </HoverTooltip>
        </header>

        {/* 便签精简验收/状态条（仅 atask_* 显示） */}
        {item.entityKind === 'task' && (
          <div className="shrink-0 border-b border-zinc-200 bg-zinc-50/80 px-4 py-2.5">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex flex-wrap items-center gap-1.5 text-[12px] text-zinc-600">
                <span className="font-medium text-zinc-800">便签状态：</span>
                <span>{task?.plan ? '计划待启动' : stateMeta.label}</span>
                {reworkRounds > 0 ? <span className="rounded bg-amber-100 px-1.5 py-0.5 text-[11px] text-amber-800">返工 {reworkRounds} 轮</span> : null}
              </div>
              <div className="flex items-center gap-1.5">
                {task?.plan && (
                  <button
                    type="button"
                    disabled={startPlanMutation.isPending}
                    onClick={() => startPlanMutation.mutate()}
                    className="inline-flex h-7 items-center gap-1 rounded-lg bg-blue-600 px-2.5 text-[12px] font-medium text-white hover:bg-blue-700 disabled:opacity-50"
                  >
                    {startPlanMutation.isPending ? <LoaderCircle size={12} className="animate-spin"/> : <Play size={12}/>}
                    开始执行
                  </button>
                )}
                {item.live.taskState === 'review' && (
                  <>
                    <button
                      type="button"
                      disabled={reviewMutation.isPending}
                      onClick={() => reviewMutation.mutate('accepted')}
                      className="inline-flex h-7 items-center gap-1 rounded-lg bg-emerald-600 px-2.5 text-[12px] font-medium text-white hover:bg-emerald-700 disabled:opacity-50"
                    >
                      <CheckCircle2 size={12}/>
                      验收通过
                    </button>
                    <button
                      type="button"
                      disabled={reviewMutation.isPending}
                      onClick={() => reviewMutation.mutate('rework')}
                      className="inline-flex h-7 items-center gap-1 rounded-lg border border-amber-300 bg-amber-50 px-2.5 text-[12px] font-medium text-amber-800 hover:bg-amber-100 disabled:opacity-50"
                    >
                      <RotateCcw size={12}/>
                      打回返工
                    </button>
                  </>
                )}
              </div>
            </div>
            {task?.doneWhen && task.doneWhen.length > 0 && (
              <ul className="mt-2 space-y-1 text-[12px] text-zinc-600">
                {task.doneWhen.map((criterion, idx) => (
                  <li key={idx} className="flex items-start gap-1.5">
                    <span className="mt-1 h-1.5 w-1.5 shrink-0 rounded-full bg-sky-500"/>
                    <span>{criterion}</span>
                  </li>
                ))}
              </ul>
            )}
            {item.kittenNote && (
              <div className="ui-board-kitten-note mt-2 flex items-start gap-1.5 rounded-lg px-2.5 py-1.5 text-[12px] text-amber-900 dark:text-amber-200">
                <PawPrint size={12} className="mt-0.5 shrink-0 text-amber-600"/>
                <span>{item.kittenNote}</span>
              </div>
            )}
          </div>
        )}

        {/* 主体区：有会话则直接嵌入 SessionPane 实时流，否则展示卡片编辑视图 */}
        <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
          {session ? (
            <SessionPane
              key={`board-drawer:${session.id}`}
              session={session}
              agent={agent}
              pane="secondary"
              onOpenSidebar={onOpenSidebar}
            />
          ) : (
            <div className="flex flex-1 flex-col gap-4 overflow-y-auto p-5">
              <div>
                <AiFieldHeader
                  label="卡片内容 / 备注"
                  htmlFor="board-detail-note-draft"
                  assist={
                    <AiTextAssistControl
                      mode="description_polish"
                      variant="pill"
                      size="xs"
                      popoverSide="bottom"
                      popoverAlign="end"
                      value={noteDraft}
                      onChange={setNoteDraft}
                      onFlash={noteFlash.triggerFlash}
                      resetKey={item.id}
                      context={() => ({
                        field: '看板卡片内容与备注',
                        purpose: '清晰记录任务要点、验收清单或关键上下文，方便回看与交给主小猫执行',
                        sessionTitle: item.live.title,
                        ...(currentColumnName ? { columnName: currentColumnName } : {}),
                        ...(kittenNoteDraft.trim() ? { extra: `督办批注：${kittenNoteDraft.trim()}` } : {})
                      })}
                      testId="board-detail-note-ai"
                    />
                  }
                />
                <textarea
                  id="board-detail-note-draft"
                  rows={5}
                  value={noteDraft}
                  onChange={e => setNoteDraft(e.target.value)}
                  placeholder="写下任务要点、验收清单或提醒…"
                  className={`ui-field mt-1.5 w-full rounded-xl border border-zinc-200 bg-white p-3 text-[13px] leading-6 text-zinc-900 ${noteFlash.flashClass}`}
                />
              </div>

              <div>
                <AiFieldHeader
                  label="小猫督办批注"
                  htmlFor="board-detail-kitten-note"
                  assist={
                    <AiTextAssistControl
                      mode="description_polish"
                      variant="pill"
                      size="xs"
                      popoverSide="bottom"
                      popoverAlign="end"
                      value={kittenNoteDraft}
                      onChange={setKittenNoteDraft}
                      onFlash={kittenNoteFlash.triggerFlash}
                      resetKey={item.id}
                      context={() => ({
                        field: '小猫督办批注',
                        purpose: '精炼的一句话督办/验收结论，会高亮显示在看板卡片上，不超过 60 字',
                        sessionTitle: item.live.title,
                        maxChars: 60,
                        ...(currentColumnName ? { columnName: currentColumnName } : {}),
                        ...(noteDraft.trim() ? { extra: `卡片备注：${noteDraft.trim().slice(0, 400)}` } : {})
                      })}
                      testId="board-detail-kitten-note-ai"
                    />
                  }
                />
                <input
                  id="board-detail-kitten-note"
                  type="text"
                  value={kittenNoteDraft}
                  onChange={e => setKittenNoteDraft(e.target.value)}
                  placeholder="记录督办/验收结论，会高亮显示在卡片上…"
                  className={`ui-field mt-1.5 h-9 w-full rounded-xl border border-zinc-200 bg-white px-3 text-[13px] text-zinc-900 ${kittenNoteFlash.flashClass}`}
                />
              </div>

              <div>
                <div className="text-[12px] font-medium text-zinc-600">所属列</div>
                <div className="mt-1.5 flex flex-wrap gap-1.5">
                  {columns.map(col => {
                    const style = COLUMN_COLOR_STYLES[col.color] ?? COLUMN_COLOR_STYLES.zinc;
                    const active = col.id === item.columnId;
                    return (
                      <button
                        key={col.id}
                        type="button"
                        onClick={() => moveColMutation.mutate(col.id)}
                        className={`inline-flex h-7 items-center gap-1.5 rounded-lg border px-2.5 text-[12px] font-medium transition-colors ${
                          active
                            ? 'border-zinc-900 bg-zinc-900 text-white'
                            : 'border-zinc-200 bg-white text-zinc-700 hover:bg-zinc-50'
                        }`}
                      >
                        <span className={`h-2 w-2 rounded-full ${style.dot}`}/>
                        {col.name}
                      </button>
                    );
                  })}
                </div>
              </div>

              <div className="flex items-center gap-2 pt-2">
                <button
                  type="button"
                  disabled={saveNoteMutation.isPending}
                  onClick={() => saveNoteMutation.mutate()}
                  className="ui-press inline-flex h-9 items-center gap-1.5 rounded-xl bg-zinc-900 px-4 text-[13px] font-medium text-white hover:bg-zinc-700 disabled:opacity-50"
                >
                  {saveNoteMutation.isPending
                    ? <LoaderCircle size={13} className="animate-spin"/>
                    : savedNotice
                      ? <Check key="saved" size={13} className="ui-icon-pop text-emerald-400"/>
                      : <Save key="save" size={13}/>}
                  {savedNotice ? '已保存' : '保存修改'}
                </button>
                <button
                  type="button"
                  onClick={() => {
                    useBoardStore.getState().addDockMentionCard(toMentionedCard(item));
                    onClose();
                    onNotice(`已把「${item.live.title}」投喂到小猫指令栏`, 'info');
                  }}
                  className="ui-press inline-flex h-9 items-center gap-1.5 rounded-xl border border-amber-300 bg-amber-50 px-3.5 text-[13px] font-medium text-amber-800 hover:bg-amber-100"
                >
                  <PawPrint size={13}/>
                  派给主小猫执行
                </button>
              </div>
            </div>
          )}
        </div>
      </aside>
    </div>
  );
}
