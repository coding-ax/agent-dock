import { memo, useRef, useState } from 'react';
import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import {
  ArrowRightLeft,
  Check,
  Eye,
  FileText,
  Folder,
  MoreHorizontal,
  PawPrint,
  Pin,
  PinOff,
  RotateCcw,
  Trash2
} from 'lucide-react';
import type { Agent, BoardDensity, HydratedBoardColumn, HydratedBoardItem } from '../api';
import { AgentIcon } from '../AgentIcon';
import { ExitGate } from '../ExitGate';
import { HoverTooltip } from '../HoverTooltip';
import { useDismissOnOutsidePointer } from '../useDismissOnOutsidePointer';
import {
  COLUMN_COLOR_STYLES,
  VISUAL_STATE_META,
  formatBoardElapsed,
  formatRelativeBrief,
  projectBasename
} from './board-utils';

export interface BoardCardActionHandlers {
  onOpenDrawer(item: HydratedBoardItem): void;
  onAskKitten(item: HydratedBoardItem): void;
  onTogglePin(item: HydratedBoardItem): void;
  onToggleSelect(item: HydratedBoardItem): void;
  onMoveToColumn(item: HydratedBoardItem, columnId: string): void;
  onRemove(item: HydratedBoardItem): void;
  onResetOverride?(item: HydratedBoardItem): void;
}

interface BoardCardSurfaceProps {
  item: HydratedBoardItem;
  density: BoardDensity;
  agent?: Agent;
  columns: HydratedBoardColumn[];
  selected?: boolean;
  activeDrawer?: boolean;
  dragging?: boolean;
  landed?: boolean;
  isOverlay?: boolean;
  columnBadge?: { name: string; color: HydratedBoardColumn['color'] };
  handlers?: BoardCardActionHandlers;
}

export const BoardCardSurface = memo(function BoardCardSurface({
  item,
  density,
  agent,
  columns,
  selected = false,
  activeDrawer = false,
  dragging = false,
  landed = false,
  isOverlay = false,
  columnBadge,
  handlers
}: BoardCardSurfaceProps) {
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  useDismissOnOutsidePointer(menuRef, menuOpen, () => setMenuOpen(false));

  const stateMeta = VISUAL_STATE_META[item.live.visualState] ?? VISUAL_STATE_META.idle;
  const compact = density === 'compact';
  const elapsedLabel = formatBoardElapsed(item.live.activeMs);
  const updatedBrief = formatRelativeBrief(item.live.updatedAt ?? item.updatedAt);
  const project = projectBasename(item.live.cwd);
  const doneTotal = item.live.doneWhenTotal ?? 0;
  const doneMet = item.live.doneWhenMet ?? 0;
  const reworkRounds = item.live.round && item.live.round > 1 ? item.live.round - 1 : 0;
  const hasRework = reworkRounds > 0;
  const colStyle = columnBadge ? COLUMN_COLOR_STYLES[columnBadge.color] ?? COLUMN_COLOR_STYLES.zinc : undefined;

  return (
    <article
      data-board-card-id={item.id}
      data-selected={selected || undefined}
      data-active-drawer={activeDrawer || undefined}
      data-dragging={dragging || undefined}
      data-landed={landed || undefined}
      onClick={event => {
        if (isOverlay || menuOpen) return;
        if (event.metaKey || event.ctrlKey) {
          event.preventDefault();
          handlers?.onToggleSelect(item);
          return;
        }
        handlers?.onOpenDrawer(item);
      }}
      className={`group/card relative overflow-visible rounded-xl text-left select-none ${
        isOverlay ? 'ui-board-card-overlay w-[296px]' : 'ui-board-card cursor-pointer'
      }`}
    >
      {/* 左侧 3px 语义状态脉冲色条 */}
      <span
        aria-hidden="true"
        className={`pointer-events-none absolute inset-y-2 left-0 w-[3px] rounded-r-full ${stateMeta.barClass}`}
      />

      <div className={compact ? 'px-3 py-2.5 pl-3.5' : 'px-3.5 py-3 pl-4'}>
        {/* Row 1: 复选/Agent 微标 + 标题 + 置顶/返工/耗时 */}
        <div className="flex items-start gap-2">
          <div className="relative mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center">
            <span className={!isOverlay && handlers && selected ? 'opacity-0' : !isOverlay && handlers ? 'transition-opacity group-hover/card:opacity-0' : ''}>
              {item.entityKind === 'note' ? (
                <span className="grid h-4 w-4 place-items-center rounded bg-zinc-100 text-zinc-500">
                  <FileText size={11}/>
                </span>
              ) : (
                <AgentIcon agentId={item.live.agentId ?? 'claude'} agentName={agent?.name ?? item.live.agentName} size={15}/>
              )}
            </span>
            {!isOverlay && handlers && (
              <button
                type="button"
                aria-label={selected ? '取消选中卡片' : '选中卡片（批量 @小猫）'}
                aria-pressed={selected}
                onPointerDown={e => e.stopPropagation()}
                onClick={e => {
                  e.stopPropagation();
                  handlers.onToggleSelect(item);
                }}
                className={`ui-press absolute inset-0 grid place-items-center rounded border transition-all ${
                  selected
                    ? 'border-blue-500 bg-blue-500 text-white opacity-100'
                    : 'border-zinc-300 bg-white text-transparent opacity-0 hover:border-zinc-400 group-hover/card:opacity-100 focus:opacity-100'
                }`}
              >
                <Check key={selected ? 'on' : 'off'} size={10} strokeWidth={3} className={selected ? 'ui-icon-pop' : ''}/>
              </button>
            )}
          </div>

          <div className="min-w-0 flex-1">
            <h4
              className={`font-medium leading-snug text-zinc-900 ${
                compact ? 'truncate text-[13px]' : 'line-clamp-2 text-[13.5px]'
              }`}
              title={item.live.title}
            >
              {item.live.title}
            </h4>
          </div>

          <div className="flex shrink-0 items-center gap-1 pt-0.5">
            {item.pinned && (
              <HoverTooltip content="已置顶">
                <span className="text-amber-500"><Pin size={11} className="ui-icon-pop fill-current"/></span>
              </HoverTooltip>
            )}
            {hasRework && (
              <span className="rounded bg-amber-100 px-1 py-0.5 text-[10px] font-medium tabular-nums text-amber-800">
                返工×{reworkRounds}
              </span>
            )}
            {elapsedLabel ? (
              <span className={`font-mono text-[11px] tabular-nums ${stateMeta.pulse ? stateMeta.textClass : 'text-zinc-400'}`}>
                {elapsedLabel}
              </span>
            ) : updatedBrief ? (
              <span className="text-[11px] tabular-nums text-zinc-400">{updatedBrief}</span>
            ) : null}
          </div>
        </div>

        {/* Row 2: 实时单行进度摘要 / 工具步 */}
        <div className="mt-1.5 flex items-center gap-1.5 pl-0.5">
          <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${stateMeta.dotClass}`}/>
          <p className="min-w-0 flex-1 truncate text-[12px] leading-5 text-zinc-600" title={item.live.activity}>
            {item.live.activity || stateMeta.label}
          </p>
          {doneTotal > 0 && (
            <span className="shrink-0 rounded-md bg-zinc-100 px-1.5 py-0.5 text-[10.5px] font-medium tabular-nums text-zinc-500">
              {doneMet}/{doneTotal}
            </span>
          )}
        </div>

        {/* 可选：主小猫督办批注微条 */}
        {item.kittenNote && (
          <div className="ui-board-kitten-note mt-2 flex items-start gap-1.5 rounded-lg px-2 py-1 text-[11.5px] leading-4 text-amber-900 dark:text-amber-200">
            <PawPrint size={11} className="mt-0.5 shrink-0 text-amber-600 dark:text-amber-400"/>
            <span className={compact ? 'truncate' : 'line-clamp-2'}>{item.kittenNote}</span>
          </div>
        )}

        {/* 舒适态用户备注 */}
        {!compact && item.userNote && item.entityKind !== 'note' && (
          <p className="mt-1.5 line-clamp-2 text-[11.5px] leading-4 text-zinc-500">{item.userNote}</p>
        )}

        {/* Row 3: 来源 / 项目 / 标签 + 悬停微操作条 */}
        <div className="mt-2 flex items-center justify-between gap-2">
          <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1">
            {columnBadge && colStyle && (
              <span className={`inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[10.5px] font-medium ${colStyle.badge}`}>
                <span className={`h-1.5 w-1.5 rounded-full ${colStyle.dot}`}/>
                {columnBadge.name}
              </span>
            )}
            <span className="inline-flex items-center rounded-md bg-zinc-100 px-1.5 py-0.5 text-[10.5px] font-medium text-zinc-500">
              {item.entityKind === 'task' ? '便签' : item.entityKind === 'session' ? '会话' : '文字'}
            </span>
            {project && (
              <span className="inline-flex max-w-[116px] items-center gap-0.5 truncate rounded-md bg-zinc-100/80 px-1.5 py-0.5 text-[10.5px] text-zinc-500" title={item.live.cwd ?? undefined}>
                <Folder size={10} className="shrink-0 text-zinc-400"/>
                <span className="truncate">{project}</span>
              </span>
            )}
            {item.tags.slice(0, compact ? 1 : 3).map(tag => (
              <span key={tag} className="max-w-[78px] truncate rounded-md bg-sky-50 px-1.5 py-0.5 text-[10.5px] font-medium text-sky-700">
                #{tag}
              </span>
            ))}
            {item.tags.length > (compact ? 1 : 3) && (
              <span className="text-[10.5px] text-zinc-400">+{item.tags.length - (compact ? 1 : 3)}</span>
            )}
          </div>

          {!isOverlay && handlers && (
            <div
              className="flex shrink-0 items-center gap-0.5 opacity-100 transition-opacity md:opacity-0 md:group-hover/card:opacity-100 md:group-focus-within/card:opacity-100"
              onPointerDown={e => e.stopPropagation()}
              onClick={e => e.stopPropagation()}
            >
              <HoverTooltip content="打开详情抽屉">
                <button
                  type="button"
                  aria-label="打开详情抽屉"
                  onClick={() => handlers.onOpenDrawer(item)}
                  className="ui-press grid h-6 w-6 place-items-center rounded-md text-zinc-500 transition-colors hover:bg-zinc-100 hover:text-zinc-900"
                >
                  <Eye size={12.5}/>
                </button>
              </HoverTooltip>
              <HoverTooltip content="投喂给小猫处理">
                <button
                  type="button"
                  aria-label="投喂给小猫处理"
                  onClick={() => handlers.onAskKitten(item)}
                  className="ui-press grid h-6 w-6 place-items-center rounded-md text-amber-600 transition-colors hover:bg-amber-50 hover:text-amber-700"
                >
                  <PawPrint size={12.5}/>
                </button>
              </HoverTooltip>
              <HoverTooltip content={item.pinned ? '取消置顶' : '置顶到列首'}>
                <button
                  type="button"
                  aria-label={item.pinned ? '取消置顶' : '置顶到列首'}
                  onClick={() => handlers.onTogglePin(item)}
                  className={`ui-press grid h-6 w-6 place-items-center rounded-md transition-colors hover:bg-zinc-100 ${item.pinned ? 'text-amber-500' : 'text-zinc-500 hover:text-zinc-900'}`}
                >
                  {item.pinned ? <PinOff size={12}/> : <Pin size={12}/>}
                </button>
              </HoverTooltip>
              <div ref={menuRef} className="relative">
                <HoverTooltip content="移动与更多操作">
                  <button
                    type="button"
                    aria-label="移动与更多操作"
                    aria-expanded={menuOpen}
                    onClick={() => setMenuOpen(open => !open)}
                    className="ui-press grid h-6 w-6 place-items-center rounded-md text-zinc-500 transition-colors hover:bg-zinc-100 hover:text-zinc-900"
                  >
                    <MoreHorizontal size={13}/>
                  </button>
                </HoverTooltip>
                <ExitGate open={menuOpen} ms={150}>
                  {menuOpen && (
                    <div data-placement="top-end" className="ui-popover absolute right-0 top-7 z-40 w-48 rounded-xl border border-zinc-200 bg-white p-1.5 shadow-[0_14px_34px_rgba(24,24,27,.16)]">
                      <div className="px-2 py-1 text-[11px] font-medium text-zinc-400">移动到列</div>
                      <div className="max-h-40 overflow-y-auto">
                        {columns.map(col => {
                          const isCurrent = col.id === item.columnId;
                          const style = COLUMN_COLOR_STYLES[col.color] ?? COLUMN_COLOR_STYLES.zinc;
                          return (
                            <button
                              key={col.id}
                              type="button"
                              disabled={isCurrent}
                              onClick={() => {
                                setMenuOpen(false);
                                handlers.onMoveToColumn(item, col.id);
                              }}
                              className="ui-press flex h-7 w-full items-center gap-2 rounded-lg px-2 text-left text-[12px] text-zinc-700 hover:bg-zinc-100 disabled:opacity-45"
                            >
                              <span className={`h-2 w-2 shrink-0 rounded-full ${style.dot}`}/>
                              <span className="min-w-0 flex-1 truncate">{col.name}</span>
                              {isCurrent && <ArrowRightLeft size={11} className="text-zinc-400"/>}
                            </button>
                          );
                        })}
                      </div>
                      <div className="my-1 border-t border-zinc-100"/>
                      {item.manualOverride && !item.virtual && handlers.onResetOverride && (
                        <button
                          type="button"
                          onClick={() => {
                            setMenuOpen(false);
                            handlers.onResetOverride?.(item);
                          }}
                          className="ui-press flex h-7 w-full items-center gap-2 rounded-lg px-2 text-left text-[12px] text-zinc-700 hover:bg-zinc-100"
                        >
                          <RotateCcw size={12} className="text-zinc-400"/>
                          <span>恢复规则自动归位</span>
                        </button>
                      )}
                      {!item.virtual && (
                        <button
                          type="button"
                          onClick={() => {
                            setMenuOpen(false);
                            handlers.onRemove(item);
                          }}
                          className="ui-press flex h-7 w-full items-center gap-2 rounded-lg px-2 text-left text-[12px] text-red-600 hover:bg-red-50"
                        >
                          <Trash2 size={12}/>
                          <span>从看板移出</span>
                        </button>
                      )}
                    </div>
                  )}
                </ExitGate>
              </div>
            </div>
          )}
        </div>
      </div>
    </article>
  );
});

export interface SortableBoardCardProps {
  item: HydratedBoardItem;
  density: BoardDensity;
  agent?: Agent;
  columns: HydratedBoardColumn[];
  selected: boolean;
  activeDrawer: boolean;
  landed: boolean;
  columnBadge?: { name: string; color: HydratedBoardColumn['color'] };
  handlers: BoardCardActionHandlers;
}

export const SortableBoardCard = memo(function SortableBoardCard(props: SortableBoardCardProps) {
  const { item } = props;
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: item.id,
    data: { type: 'card', item, columnId: item.columnId }
  });

  const style = {
    transform: CSS.Translate.toString(transform),
    transition
  };

  return (
    <div
      ref={setNodeRef}
      style={style}
      data-board-flip-id={item.id}
      {...attributes}
      {...listeners}
      className="touch-manipulation outline-none"
    >
      <BoardCardSurface
        item={props.item}
        density={props.density}
        agent={props.agent}
        columns={props.columns}
        selected={props.selected}
        activeDrawer={props.activeDrawer}
        dragging={isDragging}
        landed={props.landed}
        columnBadge={props.columnBadge}
        handlers={props.handlers}
      />
    </div>
  );
});
