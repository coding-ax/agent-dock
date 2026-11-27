import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { useDroppable } from '@dnd-kit/core';
import { useMutation } from '@tanstack/react-query';
import {
  ChevronUp,
  LoaderCircle,
  MessageSquare,
  PawPrint,
  Send,
  Sparkles,
  X
} from 'lucide-react';
import { api, type HydratedBoard } from '../api';
import { Kitten, type KittenHandle } from '../companion/Kitten';
import { burst } from '../companion/effects';
import { kittenMoodMeta } from '../companion/kitten-moods';
import { useCompanion, useCompanionNav } from '../companion/useCompanion';
import { HoverTooltip } from '../HoverTooltip';
import { AiTextAssistControl, AiUndoCapsule, useAiFlash } from '../AiTextAssist';
import { useBoardStore } from './board-store';
import {
  QUICK_KITTEN_ACTIONS,
  VISUAL_STATE_META,
  deriveBoardKittenMood,
  toMentionedCard,
  type MentionedBoardCard
} from './board-utils';

export const KITTEN_DOCK_DROPPABLE_ID = 'kitten-dock';

interface KittenBoardDockProps {
  boardId: string;
  hydrated?: HydratedBoard;
  isDraggingCard: boolean;
  onNotice(text: string, tone?: 'info' | 'error' | 'success'): void;
}

export function KittenBoardDock({ boardId, hydrated, isDraggingCard, onNotice }: KittenBoardDockProps) {
  const companion = useCompanion();
  const nav = useCompanionNav();
  const kittenRef = useRef<KittenHandle>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const [prompt, setPrompt] = useState('');
  const [sendEpoch, setSendEpoch] = useState(0);
  const [dockUndo, setDockUndo] = useState<{ canUndo: boolean; undoDepth: number; lastLabel?: string; undoing: boolean; undo: () => void; clearUndo: () => void }>();
  const dockFlash = useAiFlash();
  const [mobileExpanded, setMobileExpanded] = useState(false);

  const selectedCardIds = useBoardStore(s => s.selectedCardIds);
  const dockMentionCards = useBoardStore(s => s.dockMentionCards);
  const removeDockMentionCard = useBoardStore(s => s.removeDockMentionCard);
  const clearDockMentionCards = useBoardStore(s => s.clearDockMentionCards);
  const clearSelectedCards = useBoardStore(s => s.clearSelectedCards);
  const kittenChatOpen = useBoardStore(s => s.kittenChatOpen);
  const toggleKittenChat = useBoardStore(s => s.toggleKittenChat);
  const transientKitten = useBoardStore(s => s.transientKitten);
  const celebrateNonce = useBoardStore(s => s.celebrateNonce);
  const flashKitten = useBoardStore(s => s.flashKitten);

  const { setNodeRef, isOver } = useDroppable({
    id: KITTEN_DOCK_DROPPABLE_ID,
    data: { type: 'kitten-dock' }
  });

  // 当卡片首次悬停到小猫 Dock 时，让小猫欢快地跳一下表示期待！
  const wasOver = useRef(false);
  useEffect(() => {
    if (isOver && isDraggingCard && !wasOver.current) {
      kittenRef.current?.hop();
    }
    wasOver.current = isOver && isDraggingCard;
  }, [isOver, isDraggingCard]);

  // 合并「拖入 Dock 的卡片」与「多选勾选的卡片」，去重展示芯片
  const activeCards = useMemo<MentionedBoardCard[]>(() => {
    const map = new Map<string, MentionedBoardCard>();
    for (const card of dockMentionCards) map.set(card.id, card);
    if (hydrated && selectedCardIds.length) {
      const selectedSet = new Set(selectedCardIds);
      for (const col of hydrated.columns) {
        for (const item of col.items) {
          if (selectedSet.has(item.id) && !map.has(item.id)) {
            map.set(item.id, toMentionedCard(item));
          }
        }
      }
    }
    return [...map.values()];
  }, [dockMentionCards, selectedCardIds, hydrated]);

  // 当有卡片新投喂进来时自动跳一下并聚焦输入框
  const prevCardCount = useRef(activeCards.length);
  useEffect(() => {
    if (activeCards.length > prevCardCount.current) {
      kittenRef.current?.hop();
      const el = kittenRef.current?.element;
      if (el) burst(el.getBoundingClientRect(), 'hearts', 5);
      inputRef.current?.focus();
    }
    prevCardCount.current = activeCards.length;
  }, [activeCards.length]);

  const effectiveMood = deriveBoardKittenMood({
    baseMood: companion.mood,
    adopted: companion.adopted,
    isDraggingCard,
    isOverKittenDock: isOver,
    transientMood: transientKitten,
    hydrated,
    now: Date.now()
  });
  const moodMeta = kittenMoodMeta(effectiveMood);

  const askMutation = useMutation({
    mutationFn: (payload: { text: string; cards: MentionedBoardCard[] }) =>
      api.askBoardKitten(boardId, {
        itemIds: payload.cards.map(c => c.id),
        prompt: payload.text
      }),
    onSuccess: (_res, vars) => {
      setPrompt('');
      setSendEpoch(n => n + 1);
      clearDockMentionCards();
      clearSelectedCards();
      kittenRef.current?.hop();
      const el = kittenRef.current?.element;
      if (el) burst(el.getBoundingClientRect(), 'sparkles', 6);
      flashKitten('delegating', `${companion.name}已接手处理`, 3_800);
      onNotice(
        vars.cards.length
          ? `已将 ${vars.cards.length} 张卡片交给${companion.name}处理`
          : `已发送指令给${companion.name}`,
        'info'
      );
      setMobileExpanded(false);
    },
    onError: error => {
      onNotice(error instanceof Error ? error.message : String(error), 'error');
    }
  });

  const submitPrompt = (textOverride?: string) => {
    const text = (textOverride ?? prompt).trim();
    if (!text || askMutation.isPending) return;
    if (!companion.adopted) {
      nav.goAdopt();
      return;
    }
    askMutation.mutate({ text, cards: activeCards });
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.nativeEvent.isComposing) return;
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      submitPrompt();
    }
  };

  const visibleQuickActions = useMemo(
    () => QUICK_KITTEN_ACTIONS.filter(act => !act.needsCards || activeCards.length > 0),
    [activeCards.length]
  );

  const liveStatusText = isDraggingCard && isOver
    ? `松手把卡片喂给${companion.name} ✨`
    : isDraggingCard
      ? `拖到这里交给${companion.name}督办或验收`
      : transientKitten?.message
        || (hydrated?.summary
          ? [
              hydrated.summary.needsAttention ? `${hydrated.summary.needsAttention} 待拍板` : '',
              hydrated.summary.running ? `${hydrated.summary.running} 运行中` : '',
              hydrated.summary.review ? `${hydrated.summary.review} 待验收` : ''
            ].filter(Boolean).join(' · ') || moodMeta.label
          : moodMeta.label);

  // 未认领小猫的轻量温柔邀请条
  if (companion.loaded && !companion.adopted) {
    return (
      <div className="pointer-events-none fixed inset-x-0 bottom-4 z-30 flex justify-center px-3">
        <div
          ref={setNodeRef}
          className="ui-kitten-dock pointer-events-auto flex items-center gap-3 rounded-2xl px-4 py-2.5"
        >
          <Kitten ref={kittenRef} variant="face" size={34} mood="curious" track interactive={false}/>
          <div className="min-w-0">
            <div className="text-[13px] font-medium text-zinc-900">认领一只主小猫，帮你盯看板和验收卡片</div>
            <div className="text-[11.5px] text-zinc-500">支持拖卡片喂给小猫，也可以让它用 CLI 自动理看板</div>
          </div>
          <button
            type="button"
            onClick={nav.goAdopt}
            className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-full bg-zinc-900 px-3.5 text-[12.5px] font-medium text-white transition-transform hover:bg-zinc-700 active:scale-95"
          >
            <PawPrint size={13}/>
            去认领
          </button>
        </div>
      </div>
    );
  }

  return (
    <>
      {/* 桌面端居中悬浮毛玻璃主小猫指令 Dock */}
      <div className="pointer-events-none fixed inset-x-0 bottom-4 z-30 hidden justify-center px-4 md:flex">
        <div
          ref={setNodeRef}
          data-kitten-dock=""
          data-drag-active={isDraggingCard || undefined}
          data-drop-over={(isDraggingCard && isOver) || undefined}
          className="ui-kitten-dock pointer-events-auto flex w-full max-w-[740px] flex-col gap-2 rounded-2xl px-3.5 py-2.5"
        >
          {/* 投喂芯片与快捷动词行（有卡片或拖卡时展开） */}
          {(activeCards.length > 0 || isDraggingCard) && (
            <div className="flex flex-wrap items-center gap-1.5 border-b border-zinc-200/70 pb-2">
              {isDraggingCard && activeCards.length === 0 ? (
                <span className="inline-flex items-center gap-1.5 text-[12px] font-medium text-amber-700 dark:text-amber-300">
                  <Sparkles size={13}/>
                  {isOver ? `松手！${companion.name}立刻接住这张卡` : `把卡片拖到此处，直接 @${companion.name} 督办 / 验收 / 整理`}
                </span>
              ) : (
                <>
                  {activeCards.map(card => {
                    const meta = VISUAL_STATE_META[card.visualState] ?? VISUAL_STATE_META.idle;
                    return (
                      <span
                        key={card.id}
                        className="ui-board-chip-pop inline-flex h-6 max-w-[200px] items-center gap-1.5 rounded-full border border-amber-200 bg-amber-50 pl-2 pr-1 text-[11.5px] font-medium text-amber-900"
                      >
                        <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${meta.dotClass}`}/>
                        <span className="truncate">@{card.title}</span>
                        <button
                          type="button"
                          aria-label={`移除卡片 ${card.title}`}
                          onClick={() => {
                            removeDockMentionCard(card.id);
                            if (selectedCardIds.includes(card.id)) {
                              useBoardStore.getState().toggleCardSelected(card.id);
                            }
                          }}
                          className="grid h-4 w-4 shrink-0 place-items-center rounded-full text-amber-700/70 hover:bg-amber-200/60 hover:text-amber-900"
                        >
                          <X size={10}/>
                        </button>
                      </span>
                    );
                  })}
                  <div className="ml-auto flex flex-wrap items-center gap-1">
                    {visibleQuickActions.map(action => (
                      <button
                        key={action.key}
                        type="button"
                        disabled={askMutation.isPending}
                        onClick={() => submitPrompt(action.prompt(activeCards))}
                        className="ui-press h-6 rounded-full border border-zinc-200 bg-white/90 px-2.5 text-[11.5px] font-medium text-zinc-700 transition-colors hover:border-amber-300 hover:bg-amber-50 hover:text-amber-800 disabled:opacity-50"
                      >
                        {action.label}
                      </button>
                    ))}
                  </div>
                </>
              )}
            </div>
          )}

          {/* 主交互行：动态小猫头像 + 状态标签 + 指令输入 + 快捷整理/并排对话 */}
          {dockUndo?.canUndo && (
            <div className="flex justify-end">
              <AiUndoCapsule
                undoDepth={dockUndo.undoDepth}
                lastLabel={dockUndo.lastLabel}
                undoing={dockUndo.undoing}
                onUndo={dockUndo.undo}
                onDismiss={dockUndo.clearUndo}
              />
            </div>
          )}
          <div className="flex items-center gap-2.5">
            <div className="ui-kitten-dock-avatar shrink-0">
              <span className="ui-kitten-dock-ring" aria-hidden="true"/>
              <HoverTooltip content={`${companion.name} · ${moodMeta.label}（${moodMeta.hint}）`}>
                <div>
                  <Kitten
                    ref={kittenRef}
                    variant="face"
                    size={40}
                    mood={effectiveMood}
                    stage={companion.stage}
                    collar
                    track
                    typingAware
                    celebrateKey={celebrateNonce}
                    label={`${companion.name}（${moodMeta.label}）`}
                    onClick={() => toggleKittenChat()}
                  />
                </div>
              </HoverTooltip>
            </div>

            <div className="hidden shrink-0 flex-col sm:flex">
              <div className="flex items-center gap-1.5">
                <span className="text-[12.5px] font-semibold text-zinc-900">{companion.name}</span>
                <span className="rounded-full bg-zinc-100 px-1.5 py-0.5 text-[10px] font-medium text-zinc-600">
                  {moodMeta.label}
                </span>
              </div>
              <span className="max-w-[146px] truncate text-[11px] text-zinc-500">{liveStatusText}</span>
            </div>

            <div className={`ui-field-within flex h-9 min-w-0 flex-1 items-center gap-1.5 rounded-xl border border-zinc-200/90 bg-white/90 px-2.5 ${dockFlash.flashClass}`}>
              <input
                ref={inputRef}
                type="text"
                value={prompt}
                onChange={e => setPrompt(e.target.value)}
                onKeyDown={onKeyDown}
                placeholder={
                  activeCards.length
                    ? `对这 ${activeCards.length} 张卡下达指令，Enter 交给${companion.name}…`
                    : `拖卡片喂给${companion.name}，或直接说「帮我理一下看板」…`
                }
                aria-label={`向${companion.name}下达看板指令`}
                className="h-full min-w-0 flex-1 bg-transparent text-[13px] text-zinc-900 placeholder:text-zinc-400"
              />
              {activeCards.length === 0 && !prompt.trim() && (
                <button
                  type="button"
                  disabled={askMutation.isPending}
                  onClick={() => submitPrompt(QUICK_KITTEN_ACTIONS.find(a => a.key === 'organize')!.prompt([]))}
                  className="ui-press hidden h-6 shrink-0 items-center gap-1 rounded-md bg-zinc-100 px-2 text-[11px] font-medium text-zinc-600 transition-colors hover:bg-amber-50 hover:text-amber-800 lg:inline-flex"
                >
                  <Sparkles size={11}/>
                  理看板
                </button>
              )}
              <AiTextAssistControl
                mode="message_polish"
                variant="inline"
                size="xs"
                popoverSide="top"
                popoverAlign="end"
                value={prompt}
                onChange={setPrompt}
                onFlash={dockFlash.triggerFlash}
                hideInlineUndo
                onUndoStateChange={setDockUndo}
                resetKey={`${boardId}:${sendEpoch}`}
                disabled={askMutation.isPending}
                ariaLabel={`AI 润色发给${companion.name}的指令`}
                context={() => ({
                  field: `看板主小猫「${companion.name}」指令输入框`,
                  purpose: '向任务看板的主小猫下达清晰具体的督办、验收、整理或拆解指令',
                  ...(hydrated?.board.name ? { boardName: hydrated.board.name } : {}),
                  ...(activeCards.length ? { cards: activeCards.map(c => c.title) } : {}),
                  extra: liveStatusText
                })}
                testId="board-kitten-dock-ai"
              />
              <HoverTooltip content="发送给主小猫（Enter）">
                <button
                  type="button"
                  aria-label="发送给主小猫"
                  disabled={!prompt.trim() || askMutation.isPending}
                  onClick={() => submitPrompt()}
                  className="grid h-7 w-7 shrink-0 place-items-center rounded-lg bg-zinc-900 text-white transition-all hover:bg-zinc-700 active:scale-95 disabled:opacity-35"
                >
                  {askMutation.isPending ? <LoaderCircle size={13} className="animate-spin"/> : <Send size={12.5}/>}
                </button>
              </HoverTooltip>
            </div>

            <HoverTooltip content={kittenChatOpen ? '收起小猫对话抽屉' : `并排打开${companion.name}对话`}>
              <button
                type="button"
                aria-label={kittenChatOpen ? '收起小猫对话抽屉' : `并排打开${companion.name}对话`}
                aria-pressed={kittenChatOpen}
                onClick={toggleKittenChat}
                className={`ui-press inline-flex h-9 shrink-0 items-center gap-1.5 rounded-xl border px-2.5 text-[12px] font-medium transition-colors ${
                  kittenChatOpen
                    ? 'border-zinc-900 bg-zinc-900 text-white'
                    : 'border-zinc-200 bg-white/85 text-zinc-700 hover:bg-zinc-100'
                }`}
              >
                <MessageSquare size={13.5}/>
                <span className="hidden lg:inline">对话</span>
              </button>
            </HoverTooltip>
          </div>
        </div>
      </div>

      {/* 移动端（<768px）安全区贴底紧凑小猫条，点开弹出指令 Sheet */}
      <div
        className="fixed inset-x-0 bottom-0 z-30 border-t border-zinc-200 bg-white/95 backdrop-blur-md md:hidden"
        style={{ paddingBottom: 'env(safe-area-inset-bottom)' }}
      >
        {mobileExpanded ? (
          <div className="ui-status-banner-in flex flex-col gap-2.5 p-3">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Kitten variant="face" size={28} mood={effectiveMood} stage={companion.stage} interactive={false}/>
                <span className="text-[13px] font-semibold text-zinc-900">{companion.name}</span>
                <span className="rounded-full bg-zinc-100 px-2 py-0.5 text-[10.5px] text-zinc-500">{moodMeta.label}</span>
              </div>
              <button
                type="button"
                aria-label="收起小猫指令面板"
                onClick={() => setMobileExpanded(false)}
                className="grid h-7 w-7 place-items-center rounded-lg text-zinc-500 hover:bg-zinc-100"
              >
                <X size={15}/>
              </button>
            </div>
            {activeCards.length > 0 && (
              <div className="flex flex-wrap gap-1.5">
                {activeCards.map(card => (
                  <span key={card.id} className="inline-flex h-6 max-w-full items-center gap-1 rounded-full bg-amber-50 px-2 text-[11px] font-medium text-amber-800">
                    <span className="truncate">@{card.title}</span>
                    <button type="button" aria-label={`移除 ${card.title}`} onClick={() => removeDockMentionCard(card.id)}><X size={10}/></button>
                  </span>
                ))}
              </div>
            )}
            <div className="flex flex-wrap gap-1.5">
              {visibleQuickActions.map(action => (
                <button
                  key={action.key}
                  type="button"
                  disabled={askMutation.isPending}
                  onClick={() => submitPrompt(action.prompt(activeCards))}
                  className="h-7 rounded-full border border-zinc-200 bg-zinc-50 px-2.5 text-[12px] font-medium text-zinc-700 active:scale-95"
                >
                  {action.label}
                </button>
              ))}
            </div>
            {dockUndo?.canUndo && (
              <div className="flex justify-end">
                <AiUndoCapsule
                  undoDepth={dockUndo.undoDepth}
                  lastLabel={dockUndo.lastLabel}
                  undoing={dockUndo.undoing}
                  onUndo={dockUndo.undo}
                  onDismiss={dockUndo.clearUndo}
                />
              </div>
            )}
            <div className="flex items-center gap-1.5">
              <input
                type="text"
                value={prompt}
                onChange={e => setPrompt(e.target.value)}
                onKeyDown={onKeyDown}
                placeholder={`让${companion.name}督办、验收或整理看板…`}
                className={`h-10 min-w-0 flex-1 rounded-xl border border-zinc-200 bg-white px-3 text-[14px] text-zinc-900 ${dockFlash.flashClass}`}
              />
              <AiTextAssistControl
                mode="message_polish"
                variant="icon"
                size="sm"
                popoverSide="top"
                popoverAlign="end"
                value={prompt}
                onChange={setPrompt}
                onFlash={dockFlash.triggerFlash}
                hideInlineUndo
                onUndoStateChange={setDockUndo}
                resetKey={`${boardId}:${sendEpoch}`}
                disabled={askMutation.isPending}
                ariaLabel={`AI 润色发给${companion.name}的指令`}
                context={() => ({
                  field: `看板主小猫「${companion.name}」指令输入框`,
                  purpose: '向任务看板的主小猫下达清晰具体的督办、验收、整理或拆解指令',
                  ...(hydrated?.board.name ? { boardName: hydrated.board.name } : {}),
                  ...(activeCards.length ? { cards: activeCards.map(c => c.title) } : {}),
                  extra: liveStatusText
                })}
                testId="board-kitten-dock-mobile-ai"
              />
              <button
                type="button"
                aria-label="发送"
                disabled={!prompt.trim() || askMutation.isPending}
                onClick={() => submitPrompt()}
                className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-zinc-900 text-white disabled:opacity-40"
              >
                {askMutation.isPending ? <LoaderCircle size={15} className="animate-spin"/> : <Send size={15}/>}
              </button>
            </div>
          </div>
        ) : (
          <div className="flex h-12 items-center gap-2.5 px-3">
            <button
              type="button"
              onClick={() => setMobileExpanded(true)}
              className="flex min-w-0 flex-1 items-center gap-2 text-left"
            >
              <Kitten variant="face" size={28} mood={effectiveMood} stage={companion.stage} interactive={false}/>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-1.5">
                  <span className="truncate text-[12.5px] font-semibold text-zinc-900">{companion.name}</span>
                  {activeCards.length > 0 && (
                    <span className="rounded-full bg-amber-100 px-1.5 py-0.5 text-[10px] font-semibold text-amber-800">
                      已选 {activeCards.length} 卡
                    </span>
                  )}
                </div>
                <div className="truncate text-[11px] text-zinc-500">{liveStatusText}</div>
              </div>
              <ChevronUp size={15} className="shrink-0 text-zinc-400"/>
            </button>
            <button
              type="button"
              onClick={toggleKittenChat}
              className="ui-press inline-flex h-8 shrink-0 items-center gap-1 rounded-full bg-zinc-900 px-3 text-[12px] font-medium text-white"
            >
              <MessageSquare size={12}/>
              对话
            </button>
          </div>
        )}
      </div>
    </>
  );
}
