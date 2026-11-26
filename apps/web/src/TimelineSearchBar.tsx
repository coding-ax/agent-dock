import { ChevronDown, ChevronUp, Search, X } from 'lucide-react';
import { type KeyboardEvent, type RefObject } from 'react';
import { HoverTooltip } from './HoverTooltip';

export interface TimelineSearchBarProps {
  inputRef: RefObject<HTMLInputElement | null>;
  query: string;
  hasQuery: boolean;
  activeIndex: number;
  total: number;
  onQueryChange(next: string): void;
  onNext(): void;
  onPrev(): void;
  onClear(): void;
  onClose(): void;
}

export function TimelineSearchBar({
  inputRef,
  query,
  hasQuery,
  activeIndex,
  total,
  onQueryChange,
  onNext,
  onPrev,
  onClear,
  onClose
}: TimelineSearchBarProps) {
  const handleKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.nativeEvent.isComposing || event.keyCode === 229) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      onClose();
      return;
    }
    if (event.key === 'Enter') {
      event.preventDefault();
      if (total <= 0) return;
      if (event.shiftKey) onPrev();
      else onNext();
    }
  };

  const countLabel = !hasQuery
    ? null
    : total > 0
      ? `${activeIndex + 1} / ${total}`
      : '无结果';

  return (
    <div
      role="search"
      aria-label="对话内容搜索"
      data-testid="timeline-search-bar"
      className="ui-popover absolute right-3 top-2.5 z-20 flex w-[min(360px,calc(100%-24px))] max-sm:left-3 max-sm:right-3 max-sm:top-2 max-sm:w-auto items-center gap-1 rounded-xl border border-zinc-200 bg-white/95 px-2.5 py-1.5 shadow-[0_10px_30px_rgba(0,0,0,.12)] backdrop-blur-md"
    >
      <Search size={14} aria-hidden="true" className="shrink-0 text-zinc-400" />
      <input
        ref={inputRef}
        type="text"
        value={query}
        onChange={event => onQueryChange(event.target.value)}
        onKeyDown={handleKeyDown}
        placeholder="搜索当前对话…"
        aria-label="搜索当前对话"
        autoComplete="off"
        spellCheck={false}
        className="min-w-0 flex-1 bg-transparent px-1 py-0.5 text-[13px] text-zinc-900 placeholder:text-zinc-400"
      />
      {query.length > 0 && (
        <HoverTooltip content="清空关键词">
          <button
            type="button"
            aria-label="清空关键词"
            onClick={() => {
              onClear();
              inputRef.current?.focus();
            }}
            className="grid h-6 w-6 shrink-0 place-items-center rounded-md text-zinc-400 transition-colors hover:bg-zinc-100 hover:text-zinc-700"
          >
            <X size={13} />
          </button>
        </HoverTooltip>
      )}
      {countLabel && (
        <span
          role="status"
          aria-live="polite"
          data-testid="timeline-search-count"
          className={`shrink-0 whitespace-nowrap px-1 text-[12px] tabular-nums ${total > 0 ? 'text-zinc-500' : 'text-red-500'}`}
        >
          {countLabel}
        </span>
      )}
      <span aria-hidden="true" className="mx-0.5 h-4 w-px shrink-0 bg-zinc-200" />
      <HoverTooltip content="上一条匹配 (Shift+Enter)">
        <button
          type="button"
          aria-label="上一条匹配"
          disabled={total <= 0}
          onClick={onPrev}
          className="grid h-7 w-7 shrink-0 place-items-center rounded-lg text-zinc-500 transition-colors hover:bg-zinc-100 hover:text-zinc-900 disabled:pointer-events-none disabled:opacity-35"
        >
          <ChevronUp size={15} />
        </button>
      </HoverTooltip>
      <HoverTooltip content="下一条匹配 (Enter)">
        <button
          type="button"
          aria-label="下一条匹配"
          disabled={total <= 0}
          onClick={onNext}
          className="grid h-7 w-7 shrink-0 place-items-center rounded-lg text-zinc-500 transition-colors hover:bg-zinc-100 hover:text-zinc-900 disabled:pointer-events-none disabled:opacity-35"
        >
          <ChevronDown size={15} />
        </button>
      </HoverTooltip>
      <HoverTooltip content="关闭搜索 (Esc)">
        <button
          type="button"
          aria-label="关闭搜索"
          onClick={onClose}
          className="grid h-7 w-7 shrink-0 place-items-center rounded-lg text-zinc-500 transition-colors hover:bg-zinc-100 hover:text-zinc-900"
        >
          <X size={14} />
        </button>
      </HoverTooltip>
    </div>
  );
}
