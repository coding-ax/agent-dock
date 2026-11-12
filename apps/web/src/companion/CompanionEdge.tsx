import { useEffect, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent } from 'react';
import { useEventListener, useMemoizedFn } from 'ahooks';
import { X } from 'lucide-react';
import { Kitten } from './Kitten';
import { anchorElement, nudge, prefersReducedMotion, useAnchor } from './effects';
import { useCompanion, useCompanionNav } from './useCompanion';
import { useCompanionStore, type BubbleAction, type CompanionBubble } from './companion-store';

export type CompanionView = 'home' | 'main' | 'session';

const POSITION_KEY = 'agentdock:companion-edge-y';
const BUBBLE_MS = 4_600;
/** 往左拉超过这么多像素就算「拉开便签」。 */
const PULL_OPEN = 34;

function readRatio() {
  try {
    const value = Number(window.localStorage.getItem(POSITION_KEY));
    return Number.isFinite(value) && value > 0 && value < 1 ? value : 0.4;
  } catch { return 0.4; }
}

function useViewportHeight() {
  const [height, setHeight] = useState(() => window.innerHeight);
  useEventListener('resize', () => setHeight(window.innerHeight), { target: () => window });
  return height;
}

/** 可暂停的倒计时：鼠标悬停在气泡上时停表，移开后接着走。 */
function usePausableTimeout(ms: number, paused: boolean, onDone: () => void) {
  const remaining = useRef(ms);
  const done = useMemoizedFn(onDone);
  useEffect(() => {
    if (paused) return;
    const startedAt = Date.now();
    const timer = window.setTimeout(done, Math.max(0, remaining.current));
    return () => { window.clearTimeout(timer); remaining.current -= Date.now() - startedAt; };
  }, [paused, done]);
}

function EdgeBubble({ bubble, onAction, onDone }: { bubble: CompanionBubble; onAction(action: BubbleAction): void; onDone(): void }) {
  const [paused, setPaused] = useState(false);
  const [leaving, setLeaving] = useState(false);
  usePausableTimeout(BUBBLE_MS, paused || leaving, () => setLeaving(true));
  useEffect(() => {
    if (!leaving) return;
    const timer = window.setTimeout(onDone, prefersReducedMotion() ? 0 : 200);
    return () => window.clearTimeout(timer);
  }, [leaving, onDone]);
  return <div className="ui-edge-bubble" data-tone={bubble.tone} data-paused={paused || undefined} data-leaving={leaving || undefined} style={{ '--bubble-ms': `${BUBBLE_MS}ms` } as CSSProperties} onPointerEnter={() => setPaused(true)} onPointerLeave={() => setPaused(false)}>
    <div role="status" aria-live="polite" className="ui-edge-bubble-card" data-actionable={bubble.action ? '' : undefined} onClick={() => { if (bubble.action) onAction(bubble.action); setLeaving(true); }}>
      <span className="min-w-0">{bubble.text}</span>
      <button type="button" aria-label="收起这句话" onClick={event => { event.stopPropagation(); setLeaving(true); }} className="absolute right-1.5 top-1.5 grid h-5 w-5 place-items-center rounded-md text-zinc-400 transition-colors hover:bg-zinc-900/5 hover:text-zinc-700"><X size={12}/></button>
      <span className="ui-edge-bubble-timer" aria-hidden="true"/>
    </div>
    <span className="ui-edge-bubble-tail" aria-hidden="true"/>
  </div>;
}

/**
 * 屏幕右缘的小猫与便签夹：任何页面都能一眼看到小猫派出去的便签，点一下（或往左一拉）便签就划出来。
 *
 * - 平时缩在边缘只露出大半个身子，悬停时整个滑出来，便签叠像扑克牌一样散开；
 * - 上下拖动换位置（记住比例，窗口缩放后仍在相对位置），往左拉超过一小段就打开便签；
 * - 小猫有话说时从这里冒气泡（派出便签、验收通过、需要你拍板……），点气泡直达对应便签；
 * - 首页和主会话里已经有一只大猫，这里就只留便签夹，不重复画猫。
 * - 还没认领时：一只小猫从屏幕边缘探出半个头，点它去认领（用户说过「先不了」就不再探头）。
 */
export function CompanionEdge({ view }: { view: CompanionView }) {
  const info = useCompanion();
  const nav = useCompanionNav();
  const drawerOpen = useCompanionStore(store => store.drawerOpen);
  const bubble = useCompanionStore(store => store.bubble);
  const inviteDismissed = useCompanionStore(store => store.inviteDismissed);
  const viewportHeight = useViewportHeight();
  const [ratio, setRatio] = useState(readRatio);
  const [dragging, setDragging] = useState(false);
  const [pulled, setPulled] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const pill = useRef<HTMLDivElement | null>(null);
  const gesture = useRef<{ id: number; x: number; y: number; top: number; mode?: 'move' | 'pull'; pull: number } | undefined>(undefined);
  const suppressClick = useRef(false);
  const notesAnchor = useAnchor<HTMLSpanElement>('notes-edge');
  const kittenAnchor = useAnchor<HTMLSpanElement>('kitten-edge');
  const pillAnchor = useAnchor<HTMLDivElement>('edge-pill');

  const pillHeight = 140;
  const clampTop = (value: number) => Math.min(Math.max(value, 64), Math.max(64, viewportHeight - pillHeight - 110));
  const top = clampTop(ratio * viewportHeight);

  // 需要用户拍板的事项变多时，便签夹往外探一下。
  const needs = info.counts.needsUser;
  const lastNeeds = useRef(needs);
  useEffect(() => {
    if (needs > lastNeeds.current) nudge(anchorElement('edge-pill'));
    lastNeeds.current = needs;
  }, [needs]);

  const onAction = useMemoizedFn((action: BubbleAction) => {
    if (action.kind === 'main') nav.openMain();
    else useCompanionStore.getState().openDrawer({ highlight: action.taskId });
  });
  const onBubbleDone = useMemoizedFn(() => useCompanionStore.getState().nextBubble());

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.pointerType === 'mouse' && event.button !== 0) return;
    gesture.current = { id: event.pointerId, x: event.clientX, y: event.clientY, top, pull: 0 };
  };
  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const current = gesture.current;
    if (!current || current.id !== event.pointerId) return;
    const dx = event.clientX - current.x;
    const dy = event.clientY - current.y;
    if (!current.mode) {
      if (Math.hypot(dx, dy) < 6) return;
      current.mode = dx < 0 && Math.abs(dx) > Math.abs(dy) ? 'pull' : 'move';
      root.current?.setPointerCapture(event.pointerId);
      setDragging(true);
    }
    if (current.mode === 'move') {
      if (root.current) root.current.style.top = `${clampTop(current.top + dy)}px`;
      return;
    }
    // 橡皮筋：越拉越费劲，最多拉出 64px。
    const pull = Math.max(-64, Math.min(0, dx * 0.7));
    current.pull = pull;
    pill.current?.style.setProperty('--edge-pull', `${pull}px`);
    setPulled(pull < -PULL_OPEN);
  };
  const endGesture = (event: ReactPointerEvent<HTMLDivElement>) => {
    const current = gesture.current;
    if (!current || current.id !== event.pointerId) return;
    gesture.current = undefined;
    if (!current.mode) return;
    suppressClick.current = true;
    window.setTimeout(() => { suppressClick.current = false; }, 0);
    setDragging(false);
    if (current.mode === 'move') {
      const nextTop = clampTop(current.top + (event.clientY - current.y));
      const nextRatio = nextTop / viewportHeight;
      // 拖动时直接写了 DOM；松手后写成最终值，React 下一次渲染算出的 top 与之相同，不会跳。
      if (root.current) root.current.style.top = `${nextTop}px`;
      setRatio(nextRatio);
      try { window.localStorage.setItem(POSITION_KEY, nextRatio.toFixed(4)); } catch { /* ignore */ }
      return;
    }
    pill.current?.style.removeProperty('--edge-pull');
    setPulled(false);
    if (current.pull < -PULL_OPEN) useCompanionStore.getState().openDrawer();
  };

  if (!info.loaded) return null;

  if (!info.adopted) {
    if (inviteDismissed || view === 'home') return null;
    return <div ref={root} className="ui-edge" style={{ top }}>
      <button type="button" onClick={nav.goAdopt} aria-label="认领一只小猫" title="喵？带我回家吧" className="ui-edge-peek ui-cat-hover-host">
        <Kitten variant="face" size={32} mood="curious" interactive={false}/>
      </button>
    </div>;
  }

  const showKitten = view === 'session';
  const open = info.counts.open;
  const alertTone = needs > 0 ? 'needs' : info.pendingDrafts > 0 ? 'draft' : undefined;
  const planned = info.counts.planned;
  const label = `${info.name}的便签：${open} 张便签${needs ? `，${needs} 件需要你` : ''}${planned ? `，${planned} 张计划等你点头` : ''}`;
  return <div ref={root} className="ui-edge" style={{ top }} data-dragging={dragging || undefined} data-pulled={pulled || undefined} data-attention={needs > 0 || undefined} data-bubble={bubble ? '' : undefined}
    onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={endGesture} onPointerCancel={endGesture}
    onClickCapture={event => { if (suppressClick.current) { event.stopPropagation(); event.preventDefault(); } }}>
    {bubble && !drawerOpen && <EdgeBubble key={bubble.id} bubble={bubble} onAction={onAction} onDone={onBubbleDone}/>}
    <div ref={node => { pill.current = node; pillAnchor(node); }} className="ui-edge-pill">
      <span className="ui-edge-grip" aria-hidden="true" title="上下拖动换位置"/>
      {showKitten && <button type="button" onClick={() => nav.openMain()} aria-label={`和${info.name}聊聊（${info.status}）`} title={`${info.name} · ${info.status}`} className="ui-edge-btn ui-edge-kitten ui-cat-hover-host">
        <span ref={kittenAnchor}><Kitten variant="face" size={30} mood={info.mood} collar interactive={false}/></span>
      </button>}
      <button type="button" onClick={() => useCompanionStore.getState().toggleDrawer()} aria-label={label} title={`${label}（也可以往左拉）`} aria-expanded={drawerOpen} className="ui-edge-btn ui-edge-notes">
        <span ref={notesAnchor} className="ui-edge-stack ui-note-paper-running" aria-hidden="true"><i className="ui-note-paper-review"/><i className="ui-note-paper-done"/><i/></span>
        {open > 0 && <span className="ui-edge-count">{open > 99 ? '99+' : open}</span>}
        {alertTone && <span className="ui-edge-alert" data-tone={alertTone} aria-hidden="true"/>}
      </button>
    </div>
  </div>;
}
