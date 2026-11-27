import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type RefObject
} from 'react';
import {
  DndContext,
  DragOverlay,
  KeyboardSensor,
  PointerSensor,
  TouchSensor,
  closestCorners,
  pointerWithin,
  useSensor,
  useSensors,
  type CollisionDetection,
  type DragEndEvent,
  type DragStartEvent
} from '@dnd-kit/core';
import {
  SortableContext,
  horizontalListSortingStrategy,
  sortableKeyboardCoordinates
} from '@dnd-kit/sortable';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  CheckSquare,
  Columns3,
  Download,
  Filter,
  LayoutGrid,
  LoaderCircle,
  Menu,
  MoreHorizontal,
  PawPrint,
  Plus,
  Rows3,
  Rows4,
  Search,
  Sparkles,
  Star,
  Trash2,
  X
} from 'lucide-react';
import {
  api,
  type Agent,
  type AssistantTask,
  type BoardDensity,
  type BoardTemplatePayload,
  type BoardViewMode,
  type BoardVisualState,
  type HydratedBoard,
  type HydratedBoardColumn,
  type HydratedBoardItem,
  type Session
} from '../api';
import { HoverTooltip } from '../HoverTooltip';
import { IconButton, SlidingSegmented } from '../ui-controls';
import { Disclosure } from '../Disclosure';
import { ExitGate } from '../ExitGate';
import { SessionPane } from '../SessionPane';
import { useCompanion } from '../companion/useCompanion';
import { prefersReducedMotion, springEasing } from '../companion/effects';
import { useToast } from '../Toast';
import { BoardCardSurface, SortableBoardCard, type BoardCardActionHandlers } from './BoardCard';
import { BoardColumn } from './BoardColumn';
import { BoardDetailDrawer } from './BoardDetailDrawer';
import { AddCardModal, ColumnEditorModal, CreateBoardModal, type ColumnEditorPayload, type CreateBoardPayload } from './BoardModals';
import { BoardPopoverMenu } from './BoardPopoverMenu';
import { KITTEN_DOCK_DROPPABLE_ID, KittenBoardDock } from './KittenBoardDock';
import { nextClientMutationId, useBoardStore } from './board-store';
import {
  COLUMN_COLOR_STYLES,
  filterBoardColumns,
  isFilterActive,
  toMentionedCard,
  type BoardFilterState
} from './board-utils';
import { useBoardStream } from './useBoardStream';
import './board.css';

/**
 * FLIP 弹簧动画：当 CLI / 主小猫通过 SSE 重排或跨列移动卡片时，
 * 记录上一次渲染位置并弹簧滑到新位置（本地指针拖拽中跳过，避免与 dnd-kit 冲突）。
 */
function useBoardFlip(container: RefObject<HTMLElement | null>, signature: string, disabled: boolean) {
  const prev = useRef(new Map<string, { x: number; y: number }>());
  useLayoutEffect(() => {
    const root = container.current;
    if (!root) return;
    const elements = [...root.querySelectorAll<HTMLElement>('[data-board-flip-id]')];
    const next = new Map<string, { x: number; y: number }>();
    for (const el of elements) {
      const rect = el.getBoundingClientRect();
      next.set(el.dataset.boardFlipId!, { x: rect.left, y: rect.top });
    }
    if (!disabled && !prefersReducedMotion() && prev.current.size) {
      const easing = springEasing('soft');
      for (const el of elements) {
        const before = prev.current.get(el.dataset.boardFlipId!);
        const after = next.get(el.dataset.boardFlipId!);
        if (!before || !after) continue;
        const dx = before.x - after.x;
        const dy = before.y - after.y;
        if (Math.abs(dx) < 2 && Math.abs(dy) < 2) continue;
        if (Math.abs(dx) > 1200 || Math.abs(dy) > 900) continue;
        el.animate(
          [{ transform: `translate(${dx}px, ${dy}px)` }, { transform: 'translate(0, 0)' }],
          { duration: 420, easing }
        );
      }
    }
    prev.current = next;
  }, [container, signature, disabled]);
}

function useIsDesktop(): boolean {
  const [desktop, setDesktop] = useState(() => (typeof window !== 'undefined' ? window.matchMedia('(min-width: 768px)').matches : true));
  useEffect(() => {
    const mq = window.matchMedia('(min-width: 768px)');
    const onChange = () => setDesktop(mq.matches);
    onChange();
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);
  return desktop;
}

export interface BoardWorkspaceProps {
  /** URL 显式指定的看板 ID（如 /boards/brd_xxx），为空时使用记忆的默认看板 */
  routeBoardId?: string;
  agents: Agent[];
  sessions: Session[];
  tasks: AssistantTask[];
  draggingSidebarSessionId?: string;
  onClearSidebarDrag(): void;
  onBoardRouteChange(boardId: string): void;
  onOpenFullSession(sessionId: string): void;
  onOpenSidebar(): void;
}

export function BoardWorkspace({
  routeBoardId,
  agents,
  sessions,
  tasks,
  draggingSidebarSessionId,
  onClearSidebarDrag,
  onBoardRouteChange,
  onOpenFullSession,
  onOpenSidebar
}: BoardWorkspaceProps) {
  const qc = useQueryClient();
  const companion = useCompanion();
  const notice = useToast(2_400);
  const isDesktop = useIsDesktop();

  const lastActiveBoardId = useBoardStore(s => s.lastActiveBoardId);
  const setLastActiveBoardId = useBoardStore(s => s.setLastActiveBoardId);
  const selectedCardIds = useBoardStore(s => s.selectedCardIds);
  const toggleCardSelected = useBoardStore(s => s.toggleCardSelected);
  const clearSelectedCards = useBoardStore(s => s.clearSelectedCards);
  const drawerCardId = useBoardStore(s => s.drawerCardId);
  const openDrawerCard = useBoardStore(s => s.openDrawerCard);
  const kittenChatOpen = useBoardStore(s => s.kittenChatOpen);
  const setKittenChatOpen = useBoardStore(s => s.setKittenChatOpen);
  const landedCardId = useBoardStore(s => s.recentlyLandedId);
  const tidyBanner = useBoardStore(s => s.tidyBanner);
  const mobileColumnByBoard = useBoardStore(s => s.mobileColumnByBoard);
  const setMobileColumn = useBoardStore(s => s.setMobileColumn);

  const [filterOpen, setFilterOpen] = useState(false);
  const [filter, setFilter] = useState<BoardFilterState>({ query: '', agentId: 'all', visualState: 'all' });
  const [createBoardOpen, setCreateBoardOpen] = useState(false);
  const [columnModal, setColumnModal] = useState<{ open: boolean; editing: HydratedBoardColumn | null }>({ open: false, editing: null });
  const [addCardColumn, setAddCardColumn] = useState<HydratedBoardColumn | null>(null);
  const [boardMenuOpen, setBoardMenuOpen] = useState(false);
  const [renamingBoard, setRenamingBoard] = useState(false);
  const [renameDraft, setRenameDraft] = useState('');
  const [activeDrag, setActiveDrag] = useState<{ type: 'card'; item: HydratedBoardItem } | { type: 'column'; column: HydratedBoardColumn } | null>(null);

  const boardMenuRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLDivElement>(null);

  // 1. 拉取全部看板列表
  const boardsQuery = useQuery({
    queryKey: ['boards'],
    queryFn: () => api.boards(false),
    staleTime: 15_000
  });
  const boardList = boardsQuery.data?.boards ?? [];

  // 决定当前活跃看板 ID：路由参数 > 服务端默认记忆看板 > localStorage 记忆 > 'default'
  const resolvedBoardId = useMemo(() => {
    if (routeBoardId && (!boardList.length || boardList.some(b => b.id === routeBoardId))) return routeBoardId;
    const serverDefault = boardList.find(b => b.isDefault)?.id;
    if (lastActiveBoardId && boardList.some(b => b.id === lastActiveBoardId)) return lastActiveBoardId;
    return serverDefault ?? boardList[0]?.id ?? 'default';
  }, [routeBoardId, boardList, lastActiveBoardId]);

  // 2. 拉取当前看板完整水合态
  const boardQuery = useQuery({
    queryKey: ['board', resolvedBoardId],
    queryFn: () => api.board(resolvedBoardId),
    refetchInterval: 15_000
  });
  const hydrated = boardQuery.data;
  const activeBoard = hydrated?.board;

  // 同步记住当前看板 ID 与地址栏 URL
  useEffect(() => {
    if (!activeBoard) return;
    if (lastActiveBoardId !== activeBoard.id) setLastActiveBoardId(activeBoard.id);
    if (routeBoardId !== activeBoard.id) onBoardRouteChange(activeBoard.id);
  }, [activeBoard?.id, lastActiveBoardId, routeBoardId, setLastActiveBoardId, onBoardRouteChange]);

  // 3. 启动看板单连接多路复用 SSE 实时同步
  const streamStatus = useBoardStream(activeBoard?.id ?? resolvedBoardId, true);

  const agentsById = useMemo(() => new Map(agents.map(a => [a.id, a])), [agents]);
  const sessionsById = useMemo(() => new Map(sessions.map(s => [s.id, s])), [sessions]);
  const tasksById = useMemo(() => new Map(tasks.map(t => [t.id, t])), [tasks]);
  const selectedSet = useMemo(() => new Set(selectedCardIds), [selectedCardIds]);

  const rawColumns = hydrated?.columns ?? [];
  const filteredColumns = useMemo(() => filterBoardColumns(rawColumns, filter), [rawColumns, filter]);
  const columnIds = useMemo(() => filteredColumns.map(col => `col:${col.id}`), [filteredColumns]);
  const allItemsFlat = useMemo(() => rawColumns.flatMap(col => col.items), [rawColumns]);
  const filteredItemsFlat = useMemo(
    () => filteredColumns.flatMap(col => col.items.map(item => ({ item, column: col }))),
    [filteredColumns]
  );

  // 移动端当前激活列
  const activeMobileColumnId = useMemo(() => {
    if (!activeBoard || !filteredColumns.length) return undefined;
    const saved = mobileColumnByBoard[activeBoard.id];
    if (saved && filteredColumns.some(c => c.id === saved)) return saved;
    return filteredColumns[0]!.id;
  }, [activeBoard, filteredColumns, mobileColumnByBoard]);

  // FLIP 签名：记录列与卡片归属顺序，当外部 CLI/小猫改动时触发平滑滑动动画
  const flipSignature = useMemo(
    () => filteredColumns.map(c => `${c.id}:${c.items.map(i => i.id).join(',')}`).join('|'),
    [filteredColumns]
  );
  useBoardFlip(canvasRef, flipSignature, Boolean(activeDrag));

  // ---- Mutations ----

  const switchBoardMutation = useMutation({
    mutationFn: async (boardId: string) => {
      setLastActiveBoardId(boardId);
      onBoardRouteChange(boardId);
      clearSelectedCards();
      openDrawerCard(undefined);
      return api.useBoard(boardId, nextClientMutationId());
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['boards'] });
    }
  });

  const createBoardMutation = useMutation({
    mutationFn: (payload: CreateBoardPayload) =>
      api.createBoard({ ...payload, clientMutationId: nextClientMutationId() }),
    onSuccess: created => {
      setCreateBoardOpen(false);
      qc.setQueryData(['board', created.board.id], created);
      setLastActiveBoardId(created.board.id);
      onBoardRouteChange(created.board.id);
      void qc.invalidateQueries({ queryKey: ['boards'] });
      useBoardStore.getState().flashKitten('happy', `新看板「${created.board.name}」已建好！`, 3_000);
      notice.show(`已创建看板「${created.board.name}」`, 'info');
    },
    onError: err => notice.show(err instanceof Error ? err.message : String(err), 'error')
  });

  const importBoardMutation = useMutation({
    mutationFn: (input: { template: BoardTemplatePayload; name?: string; isDefault?: boolean }) =>
      api.importBoard(input),
    onSuccess: created => {
      setCreateBoardOpen(false);
      qc.setQueryData(['board', created.board.id], created);
      setLastActiveBoardId(created.board.id);
      onBoardRouteChange(created.board.id);
      void qc.invalidateQueries({ queryKey: ['boards'] });
      notice.show(`已导入看板「${created.board.name}」`, 'info');
    },
    onError: err => notice.show(err instanceof Error ? err.message : String(err), 'error')
  });

  const updateBoardMutation = useMutation({
    mutationFn: (patch: { name?: string; viewMode?: BoardViewMode; density?: BoardDensity; isDefault?: boolean }) => {
      if (!activeBoard) throw new Error('看板未就绪');
      return api.updateBoard(activeBoard.id, { ...patch, clientMutationId: nextClientMutationId() });
    },
    onMutate: patch => {
      if (!activeBoard) return;
      qc.setQueryData<HydratedBoard>(['board', activeBoard.id], cur =>
        cur ? { ...cur, board: { ...cur.board, ...patch } } : cur
      );
    },
    onSuccess: () => {
      setRenamingBoard(false);
      void qc.invalidateQueries({ queryKey: ['boards'] });
      if (activeBoard) void qc.invalidateQueries({ queryKey: ['board', activeBoard.id] });
    },
    onError: err => notice.show(err instanceof Error ? err.message : String(err), 'error')
  });

  const deleteBoardMutation = useMutation({
    mutationFn: (boardId: string) => api.deleteBoard(boardId, false),
    onSuccess: () => {
      setBoardMenuOpen(false);
      setLastActiveBoardId(undefined);
      void qc.invalidateQueries({ queryKey: ['boards'] });
      notice.show('看板已删除（底层任务与会话已保留）', 'info');
    },
    onError: err => notice.show(err instanceof Error ? err.message : String(err), 'error')
  });

  const saveColumnMutation = useMutation({
    mutationFn: async (input: { editing: HydratedBoardColumn | null; payload: ColumnEditorPayload }) => {
      if (!activeBoard) throw new Error('看板未就绪');
      const clientMutationId = nextClientMutationId();
      if (input.editing) {
        return api.updateBoardColumn(input.editing.id, { ...input.payload, clientMutationId });
      }
      return api.addBoardColumn(activeBoard.id, { ...input.payload, clientMutationId });
    },
    onSuccess: res => {
      setColumnModal({ open: false, editing: null });
      if (res.board) qc.setQueryData(['board', res.board.board.id], res.board);
      void qc.invalidateQueries({ queryKey: ['boards'] });
      notice.show('列配置已更新', 'info');
    },
    onError: err => notice.show(err instanceof Error ? err.message : String(err), 'error')
  });

  const toggleCollapseMutation = useMutation({
    mutationFn: (column: HydratedBoardColumn) =>
      api.updateBoardColumn(column.id, { collapsed: !column.collapsed, clientMutationId: nextClientMutationId() }),
    onSuccess: res => {
      if (res.board) qc.setQueryData(['board', res.board.board.id], res.board);
    }
  });

  const deleteColumnMutation = useMutation({
    mutationFn: (column: HydratedBoardColumn) => {
      const fallback = rawColumns.find(c => c.id !== column.id)?.id;
      return api.deleteBoardColumn(column.id, fallback);
    },
    onSuccess: res => {
      if (res.board) qc.setQueryData(['board', res.board.board.id], res.board);
      void qc.invalidateQueries({ queryKey: ['boards'] });
      notice.show('已删除列并迁移卡片', 'info');
    },
    onError: err => notice.show(err instanceof Error ? err.message : String(err), 'error')
  });

  const moveColumnMutation = useMutation({
    mutationFn: (input: { colId: string; index: number }) =>
      api.moveBoardColumn(input.colId, { index: input.index, clientMutationId: nextClientMutationId() }),
    onSuccess: res => {
      if (res.board) qc.setQueryData(['board', res.board.board.id], res.board);
    },
    onError: err => {
      if (activeBoard) void qc.invalidateQueries({ queryKey: ['board', activeBoard.id] });
      notice.show(err instanceof Error ? err.message : String(err), 'error');
    }
  });

  const addItemMutation = useMutation({
    mutationFn: (body: {
      columnId: string;
      entityKind: 'task' | 'session' | 'note';
      entityId?: string;
      title?: string;
      tags?: string[];
      pinned?: boolean;
    }) => {
      if (!activeBoard) throw new Error('看板未就绪');
      return api.addBoardItem(activeBoard.id, { ...body, clientMutationId: nextClientMutationId() });
    },
    onSuccess: res => {
      setAddCardColumn(null);
      if (res.board) qc.setQueryData(['board', res.board.board.id], res.board);
      void qc.invalidateQueries({ queryKey: ['boards'] });
      useBoardStore.getState().markCardLanded(res.item.id);
      notice.show('已添加到看板', 'info');
    },
    onError: err => notice.show(err instanceof Error ? err.message : String(err), 'error')
  });

  const moveItemMutation = useMutation({
    mutationFn: (input: {
      itemId: string;
      toColumnId: string;
      beforeItemId?: string;
      afterItemId?: string;
      placement?: 'top' | 'bottom';
    }) => {
      if (!activeBoard) throw new Error('看板未就绪');
      return api.moveBoardItem(activeBoard.id, input.itemId, {
        toColumnId: input.toColumnId,
        ...(input.beforeItemId ? { beforeItemId: input.beforeItemId } : {}),
        ...(input.afterItemId ? { afterItemId: input.afterItemId } : {}),
        ...(input.placement ? { placement: input.placement } : {}),
        clientMutationId: nextClientMutationId()
      });
    },
    onSuccess: res => {
      if (res.board) qc.setQueryData(['board', res.board.board.id], res.board);
      useBoardStore.getState().markCardLanded(res.item.id);
      void qc.invalidateQueries({ queryKey: ['boards'] });
    },
    onError: err => {
      if (activeBoard) void qc.invalidateQueries({ queryKey: ['board', activeBoard.id] });
      notice.show(err instanceof Error ? err.message : String(err), 'error');
    }
  });

  const batchMoveMutation = useMutation({
    mutationFn: (input: { itemIds: string[]; toColumnId: string }) => {
      if (!activeBoard) throw new Error('看板未就绪');
      return api.batchMoveBoardItems(activeBoard.id, {
        itemIds: input.itemIds,
        toColumnId: input.toColumnId,
        clientMutationId: nextClientMutationId()
      });
    },
    onSuccess: res => {
      if (res.board) qc.setQueryData(['board', res.board.board.id], res.board);
      clearSelectedCards();
      notice.show(`已批量移动 ${res.moved.length} 张卡片`, 'info');
    },
    onError: err => notice.show(err instanceof Error ? err.message : String(err), 'error')
  });

  const updateItemMutation = useMutation({
    mutationFn: (input: { itemId: string; pinned?: boolean; resetRuleOverride?: boolean }) => {
      if (!activeBoard) throw new Error('看板未就绪');
      return api.updateBoardItem(activeBoard.id, input.itemId, {
        ...(input.pinned !== undefined ? { pinned: input.pinned } : {}),
        ...(input.resetRuleOverride ? { manualOverride: false } : {}),
        clientMutationId: nextClientMutationId()
      });
    },
    onSuccess: res => {
      if (res.board) qc.setQueryData(['board', res.board.board.id], res.board);
    },
    onError: err => notice.show(err instanceof Error ? err.message : String(err), 'error')
  });

  const removeItemMutation = useMutation({
    mutationFn: (itemId: string) => {
      if (!activeBoard) throw new Error('看板未就绪');
      return api.removeBoardItem(activeBoard.id, itemId);
    },
    onSuccess: (res, itemId) => {
      if (res.board) qc.setQueryData(['board', res.board.board.id], res.board);
      else if (activeBoard) void qc.invalidateQueries({ queryKey: ['board', activeBoard.id] });
      if (drawerCardId === itemId) openDrawerCard(undefined);
      void qc.invalidateQueries({ queryKey: ['boards'] });
      notice.show('已从看板移出（任务与会话本身已保留）', 'info');
    },
    onError: err => notice.show(err instanceof Error ? err.message : String(err), 'error')
  });

  // ---- DnD 传感器与磁性小猫 Dock 碰撞检测 ----

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 180, tolerance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  );

  const collisionDetection = useCallback<CollisionDetection>(args => {
    const pointerHits = pointerWithin(args);
    const dockHit = pointerHits.find(c => c.id === KITTEN_DOCK_DROPPABLE_ID);
    if (dockHit) return [dockHit];
    if (pointerHits.length > 0) return pointerHits;
    return closestCorners(args);
  }, []);

  const handleDragStart = useCallback((event: DragStartEvent) => {
    const data = event.active.data.current as
      | { type: 'card'; item: HydratedBoardItem }
      | { type: 'column'; column: HydratedBoardColumn }
      | undefined;
    if (!data) return;
    if (data.type === 'card') setActiveDrag({ type: 'card', item: data.item });
    else if (data.type === 'column') setActiveDrag({ type: 'column', column: data.column });
  }, []);

  const handleDragEnd = useCallback((event: DragEndEvent) => {
    const currentDrag = activeDrag;
    setActiveDrag(null);
    const { active, over } = event;
    if (!over || !activeBoard || !hydrated || !currentDrag) return;

    // 1. 拖卡投喂给底部主小猫 Dock！
    if (currentDrag.type === 'card' && over.id === KITTEN_DOCK_DROPPABLE_ID) {
      useBoardStore.getState().addDockMentionCard(toMentionedCard(currentDrag.item));
      useBoardStore.getState().flashKitten('happy', `接住啦！想让${companion.name}怎么处理？`, 3_000);
      notice.show(`已投喂「${currentDrag.item.live.title}」给${companion.name}`, 'info');
      return;
    }

    // 2. 拖拽调整列顺序
    if (currentDrag.type === 'column') {
      const fromColId = String(active.id).replace(/^col:/, '');
      const overStr = String(over.id);
      let targetColId = overStr.startsWith('col:')
        ? overStr.slice(4)
        : overStr.startsWith('lane:')
          ? overStr.slice(5)
          : (over.data.current as { columnId?: string } | undefined)?.columnId;
      if (!targetColId || targetColId === fromColId) return;
      const toIndex = rawColumns.findIndex(c => c.id === targetColId);
      if (toIndex < 0) return;

      // 乐观更新列序
      qc.setQueryData<HydratedBoard>(['board', activeBoard.id], cur => {
        if (!cur) return cur;
        const fromIdx = cur.columns.findIndex(c => c.id === fromColId);
        if (fromIdx < 0) return cur;
        const cols = [...cur.columns];
        const [moved] = cols.splice(fromIdx, 1);
        cols.splice(toIndex, 0, moved!);
        return { ...cur, columns: cols };
      });
      moveColumnMutation.mutate({ colId: fromColId, index: toIndex });
      return;
    }

    // 3. 卡片同列排序 / 跨列拖拽
    const draggedItem = currentDrag.item;
    const overStr = String(over.id);
    let toColumnId: string | undefined;
    let beforeItemId: string | undefined;
    let placement: 'top' | 'bottom' | undefined;

    if (overStr.startsWith('lane:')) {
      toColumnId = overStr.slice(5);
      placement = 'bottom';
    } else if (overStr.startsWith('col:')) {
      toColumnId = overStr.slice(4);
      placement = 'top';
    } else {
      const targetItem = allItemsFlat.find(i => i.id === overStr);
      if (targetItem) {
        toColumnId = targetItem.columnId;
        if (targetItem.id !== draggedItem.id) {
          beforeItemId = targetItem.id;
        }
      }
    }

    if (!toColumnId) return;
    if (toColumnId === draggedItem.columnId && !beforeItemId) return;

    // 乐观更新卡片归属与顺序，零抖动！
    qc.setQueryData<HydratedBoard>(['board', activeBoard.id], cur => {
      if (!cur) return cur;
      const cols = cur.columns.map(col => ({
        ...col,
        items: col.items.filter(i => i.id !== draggedItem.id)
      }));
      const targetCol = cols.find(col => col.id === toColumnId);
      if (!targetCol) return cur;
      const updatedCard: HydratedBoardItem = {
        ...draggedItem,
        columnId: toColumnId,
        manualOverride: true
      };
      if (beforeItemId) {
        const idx = targetCol.items.findIndex(i => i.id === beforeItemId);
        if (idx >= 0) targetCol.items.splice(idx, 0, updatedCard);
        else targetCol.items.push(updatedCard);
      } else if (placement === 'top') {
        targetCol.items.unshift(updatedCard);
      } else {
        targetCol.items.push(updatedCard);
      }
      return { ...cur, columns: cols };
    });

    moveItemMutation.mutate({
      itemId: draggedItem.id,
      toColumnId,
      ...(beforeItemId ? { beforeItemId } : {}),
      ...(placement ? { placement } : {})
    });
  }, [activeDrag, activeBoard, hydrated, rawColumns, allItemsFlat, companion.name, qc, moveColumnMutation, moveItemMutation, notice]);

  const cardHandlers = useMemo<BoardCardActionHandlers>(() => ({
    onOpenDrawer: item => openDrawerCard(item.id),
    onAskKitten: item => {
      useBoardStore.getState().addDockMentionCard(toMentionedCard(item));
      useBoardStore.getState().flashKitten('happy', `收到「${item.live.title}」！`, 2_800);
      notice.show(`已把「${item.live.title}」投喂给${companion.name}`, 'info');
    },
    onTogglePin: item => updateItemMutation.mutate({ itemId: item.id, pinned: !item.pinned }),
    onToggleSelect: item => toggleCardSelected(item.id),
    onMoveToColumn: (item, columnId) => moveItemMutation.mutate({ itemId: item.id, toColumnId: columnId, placement: 'top' }),
    onRemove: item => removeItemMutation.mutate(item.id),
    onResetOverride: item => updateItemMutation.mutate({ itemId: item.id, resetRuleOverride: true })
  }), [openDrawerCard, toggleCardSelected, companion.name, notice, updateItemMutation, moveItemMutation, removeItemMutation]);

  const handleDropSidebarSession = useCallback((columnId: string, sessionId: string) => {
    onClearSidebarDrag();
    addItemMutation.mutate({ columnId, entityKind: 'session', entityId: sessionId });
  }, [onClearSidebarDrag, addItemMutation]);

  const handleExportTemplate = async () => {
    if (!activeBoard) return;
    setBoardMenuOpen(false);
    try {
      const tpl = await api.exportBoard(activeBoard.id, true);
      const blob = new Blob([JSON.stringify(tpl, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `agentdock-board-${activeBoard.name.replace(/[^\w\u4e00-\u9fa5-]+/g, '_')}.json`;
      a.click();
      URL.revokeObjectURL(url);
      notice.show('已导出看板模板 JSON', 'info');
    } catch (err) {
      notice.show(err instanceof Error ? err.message : String(err), 'error');
    }
  };

  const drawerItem = useMemo(
    () => (drawerCardId ? allItemsFlat.find(item => item.id === drawerCardId) : undefined),
    [drawerCardId, allItemsFlat]
  );

  const viewMode: BoardViewMode = activeBoard?.viewMode ?? 'lanes';
  const density: BoardDensity = activeBoard?.density ?? 'compact';
  const summary = hydrated?.summary;

  return (
    <div className="ui-board-canvas relative flex h-full min-w-0 flex-1 flex-col overflow-hidden">
      {/* ---------- 看板顶栏：快速看板记忆切换 + 视图/密度/筛选 + 新建 ---------- */}
      <header
        className="relative z-30 flex shrink-0 flex-wrap items-center gap-2 border-b border-zinc-200 bg-white/95 px-3 py-2 backdrop-blur-sm md:px-4"
        style={{ paddingTop: 'max(0.5rem, env(safe-area-inset-top))' }}
      >
        {/* 移动端打开侧栏按钮 */}
        <span className="md:hidden">
          <IconButton label="打开会话列表" onClick={onOpenSidebar}><Menu size={17}/></IconButton>
        </span>

        {/* 多看板快速记忆切换 Tabs */}
        <div className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto py-0.5 [scrollbar-width:none]">
          {boardList.map(b => {
            const active = b.id === activeBoard?.id;
            return (
              <button
                key={b.id}
                type="button"
                data-board-tab-id={b.id}
                aria-current={active ? 'page' : undefined}
                onClick={() => {
                  if (!active) switchBoardMutation.mutate(b.id);
                }}
                className={`ui-press inline-flex h-8 shrink-0 items-center gap-1.5 rounded-xl px-3 text-[12.5px] font-medium transition-colors ${
                  active
                    ? 'bg-zinc-900 text-white shadow-sm'
                    : 'bg-zinc-100/80 text-zinc-600 hover:bg-zinc-200/70 hover:text-zinc-900'
                }`}
              >
                {b.isDefault && <Star size={11} className={active ? 'fill-amber-400 text-amber-400' : 'text-amber-500'}/>}
                <span className="max-w-[140px] truncate">{b.name}</span>
                {active && summary && summary.running > 0 && (
                  <span className="inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-blue-500 px-1 text-[10px] font-semibold tabular-nums text-white">
                    {summary.running}
                  </span>
                )}
              </button>
            );
          })}
          <HoverTooltip content="新建自定义看板或导入模板">
            <button
              type="button"
              aria-label="新建看板"
              onClick={() => setCreateBoardOpen(true)}
              className="ui-press inline-flex h-8 shrink-0 items-center gap-1 rounded-xl border border-dashed border-zinc-300 px-2.5 text-[12px] font-medium text-zinc-500 transition-colors hover:border-zinc-400 hover:bg-zinc-100 hover:text-zinc-800"
            >
              <Plus size={13}/>
              <span className="hidden sm:inline">新看板</span>
            </button>
          </HoverTooltip>
        </div>

        {/* 右侧控制组 */}
        <div className="flex shrink-0 items-center gap-1.5">
          {/* 实时 SSE 呼吸指示 */}
          <HoverTooltip content={streamStatus === 'live' ? '实时同步已连接（拖拽与 CLI 秒级双向同步）' : '正在重连实时同步…'}>
            <span className="hidden items-center gap-1.5 rounded-full bg-zinc-100 px-2.5 py-1 text-[11px] font-medium text-zinc-600 xl:inline-flex">
              <span className={`h-1.5 w-1.5 rounded-full ${streamStatus === 'live' ? 'bg-emerald-500 ui-board-dot-pulse' : 'bg-amber-400'}`}/>
              {summary ? `${summary.totalItems} 卡${summary.running ? ` · ${summary.running} 运行` : ''}` : '实时同步'}
            </span>
          </HoverTooltip>

          {/* 视图切换：列视图 | 盯盘矩阵 */}
          <div className="hidden sm:block">
            <SlidingSegmented
              ariaLabel="看板视图模式"
              size="sm"
              value={viewMode}
              onChange={next => {
                if (next !== viewMode) updateBoardMutation.mutate({ viewMode: next });
              }}
              itemClassName="px-2"
              options={[
                {
                  value: 'lanes' as const,
                  ariaLabel: '列视图',
                  tooltip: '列视图（按列自由拖拽编排）',
                  label: (
                    <>
                      <Columns3 size={13}/>
                      <span className="hidden lg:inline">列视图</span>
                    </>
                  )
                },
                {
                  value: 'grid' as const,
                  ariaLabel: '盯盘矩阵',
                  tooltip: '盯盘矩阵（一屏高密度平铺盯多任务）',
                  label: (
                    <>
                      <LayoutGrid size={13}/>
                      <span className="hidden lg:inline">矩阵</span>
                    </>
                  )
                }
              ]}
            />
          </div>

          {/* 密度切换：紧凑 | 舒适 */}
          <HoverTooltip content={density === 'compact' ? '当前：紧凑盯盘（点击切换舒适）' : '当前：舒适展开（点击切换紧凑）'}>
            <button
              type="button"
              aria-label="切换卡片密度"
              onClick={() => updateBoardMutation.mutate({ density: density === 'compact' ? 'comfortable' : 'compact' })}
              className="ui-press hidden h-8 w-8 place-items-center rounded-xl border border-zinc-200 bg-white text-zinc-600 transition-colors hover:bg-zinc-50 hover:text-zinc-900 sm:grid"
            >
              {density === 'compact' ? <Rows4 size={14}/> : <Rows3 size={14}/>}
            </button>
          </HoverTooltip>

          {/* 筛选按钮 */}
          <HoverTooltip content="搜索与筛选卡片">
            <button
              type="button"
              aria-label="搜索与筛选卡片"
              aria-pressed={filterOpen || isFilterActive(filter)}
              onClick={() => setFilterOpen(o => !o)}
              className={`ui-press grid h-8 w-8 place-items-center rounded-xl border transition-colors ${
                filterOpen || isFilterActive(filter)
                  ? 'border-blue-500 bg-blue-50 text-blue-600'
                  : 'border-zinc-200 bg-white text-zinc-600 hover:bg-zinc-50 hover:text-zinc-900'
              }`}
            >
              <Filter size={14}/>
            </button>
          </HoverTooltip>

          {/* 新建列 */}
          <HoverTooltip content="新建一列（手动列或智能规则列）">
            <button
              type="button"
              aria-label="新建列"
              onClick={() => setColumnModal({ open: true, editing: null })}
              className="ui-press inline-flex h-8 items-center gap-1 rounded-xl border border-zinc-200 bg-white px-2.5 text-[12px] font-medium text-zinc-700 transition-colors hover:bg-zinc-50 hover:text-zinc-900"
            >
              <Plus size={13}/>
              <span className="hidden md:inline">新建列</span>
            </button>
          </HoverTooltip>

          {/* 当前看板更多设置菜单 */}
          <div ref={boardMenuRef} className="relative">
            <HoverTooltip content={boardMenuOpen ? undefined : '当前看板操作'} hoverOnly>
              <button
                type="button"
                data-testid="board-more-menu-trigger"
                aria-label="当前看板操作"
                aria-haspopup="menu"
                aria-expanded={boardMenuOpen}
                onClick={() => setBoardMenuOpen(o => {
                  const next = !o;
                  if (!next) setRenamingBoard(false);
                  return next;
                })}
                className={`ui-press grid h-8 w-8 place-items-center rounded-xl border transition-colors ${
                  boardMenuOpen
                    ? 'border-zinc-300 bg-zinc-100 text-zinc-900'
                    : 'border-zinc-200 bg-white text-zinc-600 hover:bg-zinc-50 hover:text-zinc-900'
                }`}
              >
                <MoreHorizontal size={15}/>
              </button>
            </HoverTooltip>
            <BoardPopoverMenu
              open={boardMenuOpen && Boolean(activeBoard)}
              anchorRef={boardMenuRef}
              width={208}
              ariaLabel="当前看板操作"
              testId="board-more-menu"
              onClose={() => {
                setBoardMenuOpen(false);
                setRenamingBoard(false);
              }}
            >
              {activeBoard && (
                <>
                  {renamingBoard ? (
                    <div className="flex items-center gap-1 p-1">
                      <input
                        type="text"
                        autoFocus
                        value={renameDraft}
                        onChange={e => setRenameDraft(e.target.value)}
                        onKeyDown={e => {
                          if (e.key === 'Enter' && renameDraft.trim()) updateBoardMutation.mutate({ name: renameDraft.trim() });
                          if (e.key === 'Escape') setRenamingBoard(false);
                        }}
                        className="h-7 min-w-0 flex-1 rounded-md border border-zinc-300 px-2 text-[12px] text-zinc-900"
                      />
                      <button
                        type="button"
                        onClick={() => { if (renameDraft.trim()) updateBoardMutation.mutate({ name: renameDraft.trim() }); }}
                        className="ui-press h-7 rounded-md bg-zinc-900 px-2 text-[11.5px] font-medium text-white"
                      >
                        保存
                      </button>
                    </div>
                  ) : (
                    <button
                      type="button"
                      role="menuitem"
                      onClick={() => { setRenameDraft(activeBoard.name); setRenamingBoard(true); }}
                      className="ui-press flex h-8 w-full items-center gap-2 rounded-lg px-2.5 text-left text-[12.5px] text-zinc-700 hover:bg-zinc-100"
                    >
                      重命名此看板
                    </button>
                  )}
                  {!activeBoard.isDefault && (
                    <button
                      type="button"
                      role="menuitem"
                      onClick={() => { setBoardMenuOpen(false); switchBoardMutation.mutate(activeBoard.id); }}
                      className="ui-press flex h-8 w-full items-center gap-2 rounded-lg px-2.5 text-left text-[12.5px] text-zinc-700 hover:bg-zinc-100"
                    >
                      <Star size={13} className="text-amber-500"/>
                      设为默认记忆看板
                    </button>
                  )}
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => void handleExportTemplate()}
                    className="ui-press flex h-8 w-full items-center gap-2 rounded-lg px-2.5 text-left text-[12.5px] text-zinc-700 hover:bg-zinc-100"
                  >
                    <Download size={13} className="text-zinc-400"/>
                    导出看板模板 JSON
                  </button>
                  <div className="my-1 border-t border-zinc-100"/>
                  <button
                    type="button"
                    role="menuitem"
                    disabled={boardList.length <= 1 || deleteBoardMutation.isPending}
                    onClick={() => deleteBoardMutation.mutate(activeBoard.id)}
                    className="ui-press flex h-8 w-full items-center gap-2 rounded-lg px-2.5 text-left text-[12.5px] text-red-600 hover:bg-red-50 disabled:opacity-40"
                  >
                    <Trash2 size={13}/>
                    删除此看板
                  </button>
                </>
              )}
            </BoardPopoverMenu>
          </div>
        </div>
      </header>

      {/* 可选筛选条 */}
      <Disclosure open={filterOpen}>
        <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-zinc-200 bg-white/90 px-4 py-2">
          <div className="ui-field-within flex h-8 min-w-[180px] flex-1 items-center gap-1.5 rounded-lg border border-zinc-200 bg-white px-2.5 sm:max-w-[280px]">
            <Search size={13} className="text-zinc-400"/>
            <input
              type="text"
              value={filter.query}
              onChange={e => setFilter(f => ({ ...f, query: e.target.value }))}
              placeholder="搜索标题、工具步、批注、标签…"
              className="h-full min-w-0 flex-1 bg-transparent text-[12.5px] text-zinc-900 placeholder:text-zinc-400"
            />
            {filter.query && (
              <button type="button" aria-label="清空搜索词" onClick={() => setFilter(f => ({ ...f, query: '' }))} className="text-zinc-400 hover:text-zinc-700">
                <X size={12}/>
              </button>
            )}
          </div>
          <select
            aria-label="按状态筛选"
            value={filter.visualState}
            onChange={e => setFilter(f => ({ ...f, visualState: e.target.value as BoardVisualState | 'all' }))}
            className="h-8 rounded-lg border border-zinc-200 bg-white px-2.5 text-[12px] text-zinc-700"
          >
            <option value="all">全部状态</option>
            <option value="running">进行中</option>
            <option value="thinking">思考中</option>
            <option value="needs_user">需要你</option>
            <option value="waiting_approval">待授权</option>
            <option value="review">待验收</option>
            <option value="plan">计划中</option>
            <option value="done">已完成</option>
            <option value="failed">出错</option>
            <option value="note">纯文字卡</option>
          </select>
          <select
            aria-label="按 Agent 筛选"
            value={filter.agentId}
            onChange={e => setFilter(f => ({ ...f, agentId: e.target.value }))}
            className="h-8 rounded-lg border border-zinc-200 bg-white px-2.5 text-[12px] text-zinc-700"
          >
            <option value="all">全部 Agent</option>
            {agents.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}
          </select>
          {isFilterActive(filter) && (
            <button
              type="button"
              onClick={() => setFilter({ query: '', agentId: 'all', visualState: 'all' })}
              className="ui-press h-8 rounded-lg px-2.5 text-[12px] font-medium text-blue-600 hover:bg-blue-50"
            >
              重置筛选
            </button>
          )}
        </div>
      </Disclosure>

      {/* 批量选中工具条 */}
      <Disclosure open={selectedCardIds.length > 0}>
        <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-blue-200 bg-blue-50/80 px-4 py-1.5 text-[12.5px] text-blue-900">
          <span className="inline-flex items-center gap-1.5 font-medium">
            <CheckSquare size={14} className="text-blue-600"/>
            已选 {selectedCardIds.length} 张卡片
          </span>
          <button
            type="button"
            onClick={() => {
              const picked = allItemsFlat.filter(i => selectedSet.has(i.id)).map(toMentionedCard);
              useBoardStore.getState().setDockMentionCards(picked);
              useBoardStore.getState().flashKitten('happy', `已接住 ${picked.length} 张卡！`, 3_000);
            }}
            className="ui-press inline-flex h-7 items-center gap-1 rounded-lg bg-amber-500 px-2.5 text-[12px] font-medium text-white hover:bg-amber-600"
          >
            <PawPrint size={12}/>
            全部喂给{companion.name}
          </button>
          <select
            aria-label="批量移动到列"
            defaultValue=""
            onChange={e => {
              const colId = e.target.value;
              if (colId) batchMoveMutation.mutate({ itemIds: selectedCardIds, toColumnId: colId });
              e.target.value = '';
            }}
            className="h-7 rounded-lg border border-blue-200 bg-white px-2 text-[12px] text-zinc-700"
          >
            <option value="" disabled>批量移到列…</option>
            {rawColumns.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
          <button
            type="button"
            onClick={clearSelectedCards}
            className="ui-press ml-auto text-[12px] text-blue-700 hover:underline"
          >
            取消全选
          </button>
        </div>
      </Disclosure>

      {/* CLI / 主小猫刚刚自动整理看板的轻量浮动提示条 */}
      {tidyBanner && (
        <div className="ui-board-tidy-banner pointer-events-none fixed left-1/2 top-16 z-40 inline-flex items-center gap-1.5 rounded-full border border-sky-200 bg-white/95 px-3.5 py-1.5 text-[12px] font-medium text-sky-800 shadow-[0_10px_28px_rgba(15,23,42,.12)] backdrop-blur-md dark:text-sky-300">
          <Sparkles size={13} className="text-sky-500"/>
          {tidyBanner.text}
        </div>
      )}

      {/* ---------- 主体区：看板画布 + 可选右侧并排主小猫对话面板 ---------- */}
      <DndContext
        sensors={sensors}
        collisionDetection={collisionDetection}
        onDragStart={handleDragStart}
        onDragEnd={handleDragEnd}
        onDragCancel={() => setActiveDrag(null)}
      >
        <div className="flex min-h-0 flex-1 overflow-hidden">
          <div ref={canvasRef} className="relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
            {boardQuery.isLoading && !hydrated ? (
              <div className="flex flex-1 items-center justify-center gap-2 text-[13px] text-zinc-400">
                <LoaderCircle size={16} className="animate-spin"/>
                正在加载看板…
              </div>
            ) : !hydrated ? (
              <div className="flex flex-1 flex-col items-center justify-center gap-3 p-6 text-center">
                <p className="text-[14px] font-medium text-zinc-700">看板暂时无法加载</p>
                <button
                  type="button"
                  onClick={() => void boardQuery.refetch()}
                  className="h-8 rounded-lg bg-zinc-900 px-3.5 text-[12.5px] font-medium text-white"
                >
                  重试
                </button>
              </div>
            ) : (
              <>
                {!isDesktop ? (
                  /* 移动端（<768px）顶部分段列切换器 + 单列全宽视图，确保 390×844 零横向溢出且不重复挂载 dnd-kit ID */
                  <div className="flex min-h-0 flex-1 flex-col">
                    <div className="flex shrink-0 items-center gap-1.5 overflow-x-auto border-b border-zinc-200 bg-white/90 px-3 py-2 [scrollbar-width:none]">
                      {filteredColumns.map(col => {
                        const active = col.id === activeMobileColumnId;
                        const style = COLUMN_COLOR_STYLES[col.color] ?? COLUMN_COLOR_STYLES.zinc;
                        return (
                          <button
                            key={col.id}
                            type="button"
                            onClick={() => activeBoard && setMobileColumn(activeBoard.id, col.id)}
                            className={`ui-press inline-flex h-8 shrink-0 items-center gap-1.5 rounded-full px-3 text-[12.5px] font-medium transition-colors ${
                              active
                                ? 'bg-zinc-900 text-white'
                                : 'bg-zinc-100 text-zinc-600'
                            }`}
                          >
                            <span className={`h-2 w-2 rounded-full ${style.dot}`}/>
                            <span>{col.name}</span>
                            <span className={`rounded-full px-1.5 text-[10.5px] tabular-nums ${active ? 'bg-white/20 text-white' : 'bg-zinc-200/80 text-zinc-600'}`}>
                              {col.items.length}
                            </span>
                          </button>
                        );
                      })}
                    </div>
                    <div key={`${activeBoard?.id ?? ''}:${activeMobileColumnId ?? ''}`} className="ui-view-fade min-h-0 flex-1 overflow-y-auto p-3 pb-20">
                      {(() => {
                        const col = filteredColumns.find(c => c.id === activeMobileColumnId) ?? filteredColumns[0];
                        if (!col) return null;
                        return (
                          <BoardColumn
                            column={col}
                            allColumns={rawColumns}
                            density={density}
                            agentsById={agentsById}
                            selectedIds={selectedSet}
                            drawerCardId={drawerCardId}
                            landedCardId={landedCardId}
                            draggingSidebarSessionId={draggingSidebarSessionId}
                            mobileFullWidth
                            cardHandlers={cardHandlers}
                            onAddCard={setAddCardColumn}
                            onEditColumn={c => setColumnModal({ open: true, editing: c })}
                            onToggleCollapse={c => toggleCollapseMutation.mutate(c)}
                            onDeleteColumn={c => deleteColumnMutation.mutate(c)}
                            onDropSidebarSession={handleDropSidebarSession}
                          />
                        );
                      })()}
                    </div>
                  </div>
                ) : viewMode === 'lanes' ? (
                  /* 桌面端（>=768px）：列视图 Lanes */
                  <div key={`${activeBoard?.id ?? ''}:lanes`} className="ui-view-fade flex min-h-0 flex-1 items-start gap-2.5 overflow-x-auto overflow-y-hidden p-3.5 pb-28">
                    <SortableContext items={columnIds} strategy={horizontalListSortingStrategy}>
                      {filteredColumns.map(col => (
                        <BoardColumn
                          key={col.id}
                          column={col}
                          allColumns={rawColumns}
                          density={density}
                          agentsById={agentsById}
                          selectedIds={selectedSet}
                          drawerCardId={drawerCardId}
                          landedCardId={landedCardId}
                          draggingSidebarSessionId={draggingSidebarSessionId}
                          cardHandlers={cardHandlers}
                          onAddCard={setAddCardColumn}
                          onEditColumn={c => setColumnModal({ open: true, editing: c })}
                          onToggleCollapse={c => toggleCollapseMutation.mutate(c)}
                          onDeleteColumn={c => deleteColumnMutation.mutate(c)}
                          onDropSidebarSession={handleDropSidebarSession}
                        />
                      ))}
                    </SortableContext>

                    {/* 末尾轻量「+ 新建列」幽灵列 */}
                    <button
                      type="button"
                      onClick={() => setColumnModal({ open: true, editing: null })}
                      className="ui-press flex h-12 w-48 shrink-0 items-center justify-center gap-1.5 rounded-2xl border border-dashed border-zinc-300/90 bg-white/50 text-[12.5px] font-medium text-zinc-500 transition-colors hover:border-zinc-400 hover:bg-white hover:text-zinc-800"
                    >
                      <Plus size={14}/>
                      新建自定义列
                    </button>
                  </div>
                ) : (
                  /* 桌面端（>=768px）：高密度盯盘矩阵 Radar Grid */
                  <div key={`${activeBoard?.id ?? ''}:grid`} className="ui-view-fade min-h-0 flex-1 overflow-y-auto p-4 pb-28">
                    {filteredItemsFlat.length === 0 ? (
                      <div className="flex h-64 flex-col items-center justify-center rounded-2xl border border-dashed border-zinc-300 text-center">
                        <p className="text-[14px] font-medium text-zinc-700">盯盘矩阵暂无卡片</p>
                        <p className="mt-1 text-[12.5px] text-zinc-500">可以新建卡片、从左侧栏拖入会话，或切换到运行状态看板。</p>
                      </div>
                    ) : (
                      <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
                        {filteredItemsFlat.map(({ item, column }) => (
                          <SortableBoardCard
                            key={item.id}
                            item={item}
                            density={density}
                            agent={item.live.agentId ? agentsById.get(item.live.agentId) : undefined}
                            columns={rawColumns}
                            selected={selectedSet.has(item.id)}
                            activeDrawer={drawerCardId === item.id}
                            landed={landedCardId === item.id}
                            columnBadge={{ name: column.name, color: column.color }}
                            handlers={cardHandlers}
                          />
                        ))}
                      </div>
                    )}
                  </div>
                )}
              </>
            )}

            {/* 底部悬浮毛玻璃主小猫指令 Dock（支持拖卡投喂！） */}
            {activeBoard && (
              <KittenBoardDock
                boardId={activeBoard.id}
                hydrated={hydrated}
                isDraggingCard={activeDrag?.type === 'card'}
                onNotice={(text, tone) => notice.show(text, tone ?? 'info')}
              />
            )}
          </div>

          {/* 可选右侧并排主小猫实时对话抽屉 */}
          <ExitGate open={Boolean(kittenChatOpen && companion.mainSession)} ms={200}>
            {kittenChatOpen && companion.mainSession && (
              <aside className="ui-board-drawer fixed inset-0 z-40 flex flex-col border-l border-zinc-200 bg-canvas md:static md:z-auto md:w-[390px] md:shrink-0">
                <div className="flex h-10 shrink-0 items-center justify-between border-b border-zinc-200 bg-white px-3">
                  <span className="inline-flex items-center gap-1.5 text-[12.5px] font-semibold text-zinc-800">
                    <PawPrint size={13} className="text-amber-500"/>
                    {companion.name} · 看板协作者
                  </span>
                  <HoverTooltip content="收起并排对话">
                    <button
                      type="button"
                      aria-label="收起并排对话"
                      onClick={() => setKittenChatOpen(false)}
                      className="ui-press grid h-7 w-7 place-items-center rounded-lg text-zinc-500 hover:bg-zinc-100 hover:text-zinc-900"
                    >
                      <X size={14}/>
                    </button>
                  </HoverTooltip>
                </div>
                <div className="flex min-h-0 flex-1 flex-col">
                  <SessionPane
                    key={`board-kitten:${companion.mainSession.id}`}
                    session={companion.mainSession}
                    agent={agentsById.get(companion.mainSession.agentId)}
                    pane="secondary"
                    onOpenSidebar={onOpenSidebar}
                  />
                </div>
              </aside>
            )}
          </ExitGate>
        </div>

        {/* 拖拽浮起微倾卡片 / 列幽灵预览 */}
        <DragOverlay dropAnimation={{ duration: 190, easing: 'cubic-bezier(0.18, 0.89, 0.32, 1.12)' }}>
          {activeDrag?.type === 'card' ? (
            <BoardCardSurface
              item={activeDrag.item}
              density={density}
              agent={activeDrag.item.live.agentId ? agentsById.get(activeDrag.item.live.agentId) : undefined}
              columns={rawColumns}
              isOverlay
            />
          ) : activeDrag?.type === 'column' ? (
            <div className="ui-board-card-overlay w-[280px] rounded-2xl p-3">
              <div className="flex items-center gap-2 text-[13.5px] font-semibold text-zinc-900">
                <span className={`h-2.5 w-2.5 rounded-full ${(COLUMN_COLOR_STYLES[activeDrag.column.color] ?? COLUMN_COLOR_STYLES.zinc).dot}`}/>
                {activeDrag.column.name}
                <span className="ml-auto text-[11px] font-normal text-zinc-400">{activeDrag.column.items.length} 张卡</span>
              </div>
            </div>
          ) : null}
        </DragOverlay>
      </DndContext>

      {/* 单击卡片滑出的右侧详情抽屉（不跳离看板） */}
      <ExitGate open={Boolean(activeBoard && drawerItem)} ms={200}>
        {activeBoard && drawerItem && (
          <BoardDetailDrawer
            boardId={activeBoard.id}
            item={drawerItem}
            columns={rawColumns}
            session={drawerItem.live.sessionId ? sessionsById.get(drawerItem.live.sessionId) : undefined}
            task={drawerItem.entityKind === 'task' ? tasksById.get(drawerItem.entityId) : undefined}
            agent={drawerItem.live.agentId ? agentsById.get(drawerItem.live.agentId) : undefined}
            onClose={() => openDrawerCard(undefined)}
            onOpenFullSession={sid => {
              openDrawerCard(undefined);
              onOpenFullSession(sid);
            }}
            onOpenSidebar={onOpenSidebar}
            onNotice={(text, tone) => notice.show(text, tone ?? 'info')}
          />
        )}
      </ExitGate>

      {/* 弹窗集合 */}
      <CreateBoardModal
        open={createBoardOpen}
        busy={createBoardMutation.isPending || importBoardMutation.isPending}
        onClose={() => setCreateBoardOpen(false)}
        onCreate={payload => createBoardMutation.mutate(payload)}
        onImport={(template, name, isDefault) => importBoardMutation.mutate({ template, name, isDefault })}
      />

      <ColumnEditorModal
        open={columnModal.open}
        editing={columnModal.editing}
        busy={saveColumnMutation.isPending}
        onClose={() => setColumnModal({ open: false, editing: null })}
        onSave={payload => saveColumnMutation.mutate({ editing: columnModal.editing, payload })}
      />

      <AddCardModal
        open={Boolean(addCardColumn)}
        column={addCardColumn}
        sessions={sessions}
        tasks={tasks}
        agents={agents}
        busy={addItemMutation.isPending}
        onClose={() => setAddCardColumn(null)}
        onAddNote={input => addItemMutation.mutate({ columnId: input.columnId, entityKind: 'note', title: input.title, tags: input.tags, pinned: input.pinned })}
        onAddEntity={input => addItemMutation.mutate({ columnId: input.columnId, entityKind: input.entityKind, entityId: input.entityId })}
      />

      {notice.toast}
    </div>
  );
}
