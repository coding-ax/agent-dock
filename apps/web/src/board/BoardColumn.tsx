import { memo, useMemo, useRef, useState, type DragEvent } from 'react';
import { useDroppable } from '@dnd-kit/core';
import { SortableContext, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import {
  AlertTriangle,
  ChevronsLeft,
  ChevronsRight,
  GripVertical,
  MoreHorizontal,
  Pencil,
  Plus,
  Sparkles,
  Trash2
} from 'lucide-react';
import type { Agent, BoardDensity, HydratedBoardColumn, HydratedBoardItem } from '../api';
import { HoverTooltip } from '../HoverTooltip';
import { useBi, useLocale } from '../i18n';
import { SortableBoardCard, type BoardCardActionHandlers } from './BoardCard';
import { BoardPopoverMenu } from './BoardPopoverMenu';
import { COLUMN_COLOR_STYLES, describeColumnRule, localizeBoardColumnName } from './board-utils';

export interface BoardColumnProps {
  column: HydratedBoardColumn;
  allColumns: HydratedBoardColumn[];
  density: BoardDensity;
  agentsById: Map<string, Agent>;
  selectedIds: ReadonlySet<string>;
  drawerCardId?: string;
  landedCardId?: string;
  draggingSidebarSessionId?: string;
  mobileFullWidth?: boolean;
  cardHandlers: BoardCardActionHandlers;
  onAddCard(column: HydratedBoardColumn): void;
  onEditColumn(column: HydratedBoardColumn): void;
  onToggleCollapse(column: HydratedBoardColumn): void;
  onDeleteColumn(column: HydratedBoardColumn): void;
  onDropSidebarSession(columnId: string, sessionId: string): void;
}

export const BoardColumn = memo(function BoardColumn({
  column,
  allColumns,
  density,
  agentsById,
  selectedIds,
  drawerCardId,
  landedCardId,
  draggingSidebarSessionId,
  mobileFullWidth = false,
  cardHandlers,
  onAddCard,
  onEditColumn,
  onToggleCollapse,
  onDeleteColumn,
  onDropSidebarSession
}: BoardColumnProps) {
  const L = useBi();
  const locale = useLocale();
  const displayName = localizeBoardColumnName(column.name, locale);
  const [menuOpen, setMenuOpen] = useState(false);
  const [sidebarOver, setSidebarOver] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  const {
    attributes,
    listeners,
    setNodeRef: setSortableRef,
    transform,
    transition,
    isDragging: isColumnDragging
  } = useSortable({
    id: `col:${column.id}`,
    data: { type: 'column', column },
    disabled: mobileFullWidth
  });

  const { setNodeRef: setDropRef, isOver: isCardOver } = useDroppable({
    id: `lane:${column.id}`,
    data: { type: 'lane', columnId: column.id }
  });

  const style = {
    transform: CSS.Translate.toString(transform),
    transition
  };

  const colorStyle = COLUMN_COLOR_STYLES[column.color] ?? COLUMN_COLOR_STYLES.zinc;
  const itemIds = useMemo(() => column.items.map(item => item.id), [column.items]);
  const ruleSummary = describeColumnRule(column.rule, locale);
  const wipExceeded = Boolean(column.wipLimit && column.items.length > column.wipLimit);
  const dropHighlight = isCardOver || sidebarOver;

  const onNativeDragOver = (event: DragEvent<HTMLElement>) => {
    if (!draggingSidebarSessionId) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'copy';
    if (!sidebarOver) setSidebarOver(true);
  };

  const onNativeDragLeave = (event: DragEvent<HTMLElement>) => {
    if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
      setSidebarOver(false);
    }
  };

  const onNativeDrop = (event: DragEvent<HTMLElement>) => {
    if (!draggingSidebarSessionId) return;
    event.preventDefault();
    setSidebarOver(false);
    onDropSidebarSession(column.id, draggingSidebarSessionId);
  };

  // 桌面折叠态：优雅的 46px 纵向细条（依然可拖入卡片！）
  if (column.collapsed && !mobileFullWidth) {
    return (
      <section
        ref={node => {
          setSortableRef(node);
          setDropRef(node);
        }}
        style={style}
        data-drop-over={dropHighlight || undefined}
        onDragOver={onNativeDragOver}
        onDragLeave={onNativeDragLeave}
        onDrop={onNativeDrop}
        className={`ui-board-lane flex h-full w-12 shrink-0 flex-col items-center rounded-2xl border border-zinc-200/70 py-2.5 ${isColumnDragging ? 'opacity-45' : ''}`}
      >
        <HoverTooltip content={L(`展开「${displayName}」`, `Expand "${displayName}"`)}>
          <button
            type="button"
            aria-label={L(`展开列 ${displayName}`, `Expand column ${displayName}`)}
            onClick={() => onToggleCollapse(column)}
            className="grid h-7 w-7 place-items-center rounded-lg text-zinc-500 transition-colors hover:bg-white hover:text-zinc-900"
          >
            <ChevronsRight size={14}/>
          </button>
        </HoverTooltip>
        <span className={`mt-2 h-2 w-2 rounded-full ${colorStyle.dot}`}/>
        <span className={`mt-1.5 rounded-full px-1.5 py-0.5 text-[11px] font-semibold tabular-nums ${wipExceeded ? 'bg-red-100 text-red-700' : colorStyle.badge}`}>
          {column.items.length}
        </span>
        <button
          type="button"
          onClick={() => onToggleCollapse(column)}
          className="mt-3 flex-1 overflow-hidden text-[12.5px] font-medium tracking-wide text-zinc-600 transition-colors hover:text-zinc-900 [writing-mode:vertical-rl]"
        >
          {displayName}
        </button>
      </section>
    );
  }

  return (
    <section
      ref={setSortableRef}
      style={style}
      data-board-column-id={column.id}
      data-drop-over={dropHighlight || undefined}
      onDragOver={onNativeDragOver}
      onDragLeave={onNativeDragLeave}
      onDrop={onNativeDrop}
      className={`ui-board-lane flex h-full flex-col rounded-2xl border border-zinc-200/70 ${
        mobileFullWidth ? 'w-full min-w-0' : 'w-[272px] shrink-0 xl:w-[276px] 2xl:w-[304px]'
      } ${isColumnDragging ? 'opacity-45' : ''}`}
    >
      {/* 列头 */}
      <header className="relative z-10 flex shrink-0 items-center gap-1 px-2.5 pb-2 pt-2.5">
        {!mobileFullWidth && (
          <button
            type="button"
            aria-label={L(`拖拽调整「${displayName}」列顺序`, `Drag to reorder "${displayName}"`)}
            {...attributes}
            {...listeners}
            className="-ml-1 grid h-6 w-4 shrink-0 cursor-grab place-items-center rounded text-zinc-400 transition-colors hover:bg-zinc-200/60 hover:text-zinc-700 active:cursor-grabbing"
          >
            <GripVertical size={12.5}/>
          </button>
        )}

        <span className={`h-2 w-2 shrink-0 rounded-full ${colorStyle.dot}`}/>

        <h3
          onDoubleClick={() => onEditColumn(column)}
          className="min-w-0 flex-1 truncate text-[13px] font-semibold text-zinc-800"
          title={displayName}
        >
          {displayName}
        </h3>

        <span
          className={`inline-flex shrink-0 items-center gap-0.5 rounded-full px-1.5 py-0.5 text-[11px] font-semibold tabular-nums ${
            wipExceeded ? 'bg-red-100 text-red-700' : colorStyle.badge
          }`}
        >
          {wipExceeded && <AlertTriangle size={10}/>}
          {column.items.length}
          {column.wipLimit ? `/${column.wipLimit}` : ''}
        </span>

        {ruleSummary && (
          <HoverTooltip content={L(`智能规则列：${ruleSummary}`, `Smart rule: ${ruleSummary}`)}>
            <span className="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-md bg-sky-50 text-sky-700 dark:text-sky-300">
              <Sparkles size={11}/>
            </span>
          </HoverTooltip>
        )}

        <HoverTooltip content={L(`向「${displayName}」添加卡片`, `Add card to "${displayName}"`)}>
          <button
            type="button"
            aria-label={L(`向「${displayName}」添加卡片`, `Add card to "${displayName}"`)}
            onClick={() => onAddCard(column)}
            className="ui-press grid h-6 w-6 shrink-0 place-items-center rounded-lg text-zinc-500 transition-colors hover:bg-white hover:text-zinc-900"
          >
            <Plus size={14}/>
          </button>
        </HoverTooltip>

        {!mobileFullWidth && (
          <HoverTooltip content={L("折叠为细条", "Collapse column")}>
            <button
              type="button"
              aria-label={L(`折叠列 ${displayName}`, `Collapse column ${displayName}`)}
              onClick={() => onToggleCollapse(column)}
              className="ui-press grid h-6 w-6 shrink-0 place-items-center rounded-lg text-zinc-400 transition-colors hover:bg-white hover:text-zinc-900"
            >
              <ChevronsLeft size={14}/>
            </button>
          </HoverTooltip>
        )}

        <div ref={menuRef} className="relative shrink-0">
          <HoverTooltip content={menuOpen ? undefined : L("列设置", "Column settings")} hoverOnly>
            <button
              type="button"
              aria-label={L(`列 ${displayName} 设置`, `Column ${displayName} settings`)}
              aria-haspopup="menu"
              aria-expanded={menuOpen}
              onClick={() => setMenuOpen(open => !open)}
              className={`ui-press grid h-6 w-6 place-items-center rounded-lg transition-colors ${
                menuOpen ? 'bg-white text-zinc-900' : 'text-zinc-400 hover:bg-white hover:text-zinc-900'
              }`}
            >
              <MoreHorizontal size={14}/>
            </button>
          </HoverTooltip>
          <BoardPopoverMenu
            open={menuOpen}
            anchorRef={menuRef}
            width={176}
            ariaLabel={L(`列 ${displayName} 设置`, `Column ${displayName} settings`)}
            onClose={() => setMenuOpen(false)}
          >
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                setMenuOpen(false);
                onEditColumn(column);
              }}
              className="ui-press flex h-8 w-full items-center gap-2 rounded-lg px-2.5 text-left text-[12.5px] text-zinc-700 hover:bg-zinc-100"
            >
              <Pencil size={13} className="text-zinc-400"/>
              
              {L("编辑名称 / 规则", "Edit Name / Rules")}
            </button>
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                setMenuOpen(false);
                onAddCard(column);
              }}
              className="ui-press flex h-8 w-full items-center gap-2 rounded-lg px-2.5 text-left text-[12.5px] text-zinc-700 hover:bg-zinc-100"
            >
              <Plus size={13} className="text-zinc-400"/>
              
              {L("添加会话 / 卡片", "Add Session / Card")}
            </button>
            <div className="my-1 border-t border-zinc-100"/>
            <button
              type="button"
              role="menuitem"
              disabled={allColumns.length <= 1}
              onClick={() => {
                setMenuOpen(false);
                onDeleteColumn(column);
              }}
              className="ui-press flex h-8 w-full items-center gap-2 rounded-lg px-2.5 text-left text-[12.5px] text-red-600 hover:bg-red-50 disabled:opacity-40"
            >
              <Trash2 size={13}/>
              
              {L("删除此列", "Delete Column")}
            </button>
          </BoardPopoverMenu>
        </div>
      </header>

      {/* 卡片列表滚动区 */}
      <div
        ref={setDropRef}
        className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto px-2 pb-3 pt-0.5"
      >
        <SortableContext items={itemIds} strategy={verticalListSortingStrategy}>
          {column.items.map(item => (
            <SortableBoardCard
              key={item.id}
              item={item}
              density={density}
              agent={item.live.agentId ? agentsById.get(item.live.agentId) : undefined}
              columns={allColumns}
              selected={selectedIds.has(item.id)}
              activeDrawer={drawerCardId === item.id}
              landed={landedCardId === item.id}
              handlers={cardHandlers}
            />
          ))}
        </SortableContext>

        {column.items.length === 0 && (
          <div
            className={`flex min-h-[104px] flex-col items-center justify-center rounded-xl border border-dashed px-4 py-5 text-center transition-colors ${
              dropHighlight
                ? 'border-blue-400 bg-blue-50/60 text-blue-700'
                : 'border-zinc-300/80 text-zinc-400'
            }`}
          >
            <p className="text-[12px] font-medium">
              {dropHighlight ? L("松手放到这一列", "Drop card here") : ruleSummary ? L("暂无匹配的实时任务", "No matching live tasks") : L("这一列还是空的", "This column is empty")}
            </p>
            <p className="mt-1 text-[11px] opacity-80">
              {draggingSidebarSessionId ? L("松手将左侧会话加入此列", "Drop sidebar session here") : L("拖拽卡片进来，或点上方 + 添加", "Drag cards here or click + above")}
            </p>
          </div>
        )}
      </div>
    </section>
  );
});
