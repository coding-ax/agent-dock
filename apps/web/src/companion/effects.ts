import { useCallback, useRef } from 'react';
import { flushSync } from 'react-dom';
import type { NoteTone } from './companion-model';

/**
 * 小猫与便签的一次性动效：便签飞出去、爱心冒出来、计数跳一下、页面间的形变过渡。
 *
 * 都是命令式的 WAAPI（element.animate），不进 React 状态：动画期间不触发任何重渲染，
 * 元素播完自己删掉。prefers-reduced-motion 下全部直接跳过——那时界面只保留状态变化本身。
 */

export const prefersReducedMotion = () => typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

const SPRING_CURVES = {
  soft: 'linear(0, 0.033, 0.114, 0.222, 0.34, 0.457, 0.567, 0.665, 0.749, 0.82, 0.876, 0.921, 0.955, 0.979, 0.997, 1.008, 1.015, 1.019, 1.02, 1.019, 1.018, 1.016, 1.013, 1.011, 1.009, 1.007, 1.005, 1.004, 1.003, 1.002, 1.001, 1, 1)',
  bouncy: 'linear(0, 0.049, 0.171, 0.335, 0.512, 0.682, 0.832, 0.954, 1.044, 1.104, 1.137, 1.148, 1.141, 1.124, 1.1, 1.074, 1.049, 1.026, 1.008, 0.994, 0.985, 0.98, 0.978, 0.979, 0.981, 0.985, 0.989, 0.993, 0.996, 0.999, 1.001, 1.002, 1.003, 1.003, 1.003, 1.003, 1.002, 1.002, 1.001, 1.001, 1)'
};
const SPRING_FALLBACK = { soft: 'cubic-bezier(.22, 1.2, .36, 1)', bouncy: 'cubic-bezier(.34, 1.56, .64, 1)' };
let linearSupported: boolean | undefined;

/** WAAPI 用的弹簧缓动：支持 CSS linear() 的浏览器用真弹簧曲线，否则退回近似的 cubic-bezier。 */
export function springEasing(kind: 'soft' | 'bouncy' = 'soft') {
  linearSupported ??= typeof CSS !== 'undefined' && typeof CSS.supports === 'function' && CSS.supports('animation-timing-function', 'linear(0, 1)');
  return linearSupported ? SPRING_CURVES[kind] : SPRING_FALLBACK[kind];
}

/* ---------- 锚点：动效的起点和终点 ---------- */

const anchors = new Map<string, HTMLElement>();

/**
 * 把元素登记成具名锚点（例如「右缘便签夹」「主会话头像」）。同名锚点后挂载的覆盖先挂载的，
 * 卸载时只删除自己登记的那一个，不会误删别人刚登记的同名元素。
 */
export function useAnchor<T extends HTMLElement>(name: string) {
  const current = useRef<T | null>(null);
  return useCallback((element: T | null) => {
    if (element) {
      current.current = element;
      anchors.set(name, element);
      return;
    }
    if (current.current && anchors.get(name) === current.current) anchors.delete(name);
    current.current = null;
  }, [name]);
}

export function anchorElement(name: string): HTMLElement | undefined {
  const element = anchors.get(name);
  return element?.isConnected ? element : undefined;
}

/** 按优先级找第一个「真的看得见」的锚点：在文档里、有尺寸、在视口内、没被 display:none / visibility:hidden。 */
export function anchorRect(names: string[]): DOMRect | undefined {
  for (const name of names) {
    const element = anchorElement(name);
    if (!element) continue;
    const check = (element as HTMLElement & { checkVisibility?: (options?: { checkVisibilityCSS?: boolean }) => boolean }).checkVisibility;
    if (typeof check === 'function' && !check.call(element, { checkVisibilityCSS: true })) continue;
    const rect = element.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) continue;
    if (rect.bottom < 0 || rect.top > window.innerHeight || rect.right < 0 || rect.left > window.innerWidth) continue;
    return rect;
  }
  return undefined;
}

/* ---------- 便签飞行 ---------- */

/**
 * 一张小便签从 from 沿抛物线飞到 to。起终点水平距离很近（比如从右缘小猫飞进下面的便签夹）
 * 时，弧线先往左甩出去再落回来，否则看起来只是原地闪一下。
 */
export function flyNote(from: DOMRect, to: DOMRect, tone: NoteTone = 'running'): Promise<void> {
  if (prefersReducedMotion()) return Promise.resolve();
  const width = 26;
  const height = 22;
  const note = document.createElement('div');
  note.className = `ui-flying-note ui-note-paper-${tone}`;
  note.setAttribute('aria-hidden', 'true');
  document.body.appendChild(note);
  const start = { x: from.left + from.width / 2 - width / 2, y: from.top + from.height / 2 - height / 2 };
  const end = { x: to.left + to.width / 2 - width / 2, y: to.top + to.height / 2 - height / 2 };
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const distance = Math.hypot(dx, dy);
  const control = {
    x: start.x + dx / 2 - (Math.abs(dx) < 90 ? 90 : 0),
    y: Math.min(start.y, end.y) - Math.min(170, 60 + distance * 0.22)
  };
  const at = (t: number) => ({
    x: (1 - t) ** 2 * start.x + 2 * (1 - t) * t * control.x + t ** 2 * end.x,
    y: (1 - t) ** 2 * start.y + 2 * (1 - t) * t * control.y + t ** 2 * end.y
  });
  const steps = [0, 0.15, 0.35, 0.55, 0.75, 0.9, 1];
  const rotations = [-18, -6, 6, 12, 6, 2, 0];
  const scales = [0.4, 1.12, 1.05, 0.95, 0.8, 0.66, 0.52];
  const frames = steps.map((t, index) => {
    const point = at(t);
    return {
      transform: `translate(${point.x}px, ${point.y}px) rotate(${rotations[index]}deg) scale(${scales[index]})`,
      opacity: index === 0 ? 0 : index === steps.length - 1 ? 0.2 : 1,
      offset: t
    };
  });
  const animation = note.animate(frames, { duration: 760 + Math.min(360, distance * 0.35), easing: 'cubic-bezier(.4, 0, .25, 1)', fill: 'forwards' });
  return animation.finished.then(() => note.remove(), () => note.remove());
}

/* ---------- 粒子：爱心 / 星星 / 彩纸 ---------- */

const HEART = '<svg viewBox="0 0 24 24" width="100%" height="100%"><path d="M12 20.5C6.2 16.6 3 13.4 3 9.6 3 6.9 5.1 5 7.6 5c1.8 0 3.4 1 4.4 2.5C13 6 14.6 5 16.4 5 18.9 5 21 6.9 21 9.6c0 3.8-3.2 7-9 10.9Z" fill="currentColor"/></svg>';
const HEART_LINE = '<svg viewBox="0 0 24 24" width="100%" height="100%"><path d="M12 20.5C6.2 16.6 3 13.4 3 9.6 3 6.9 5.1 5 7.6 5c1.8 0 3.4 1 4.4 2.5C13 6 14.6 5 16.4 5 18.9 5 21 6.9 21 9.6c0 3.8-3.2 7-9 10.9Z" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linejoin="round"/></svg>';
const SPARKLE = '<svg viewBox="0 0 24 24" width="100%" height="100%"><path d="M12 2.5c.6 4.6 2.9 6.9 7.5 7.5-4.6.6-6.9 2.9-7.5 7.5-.6-4.6-2.9-6.9-7.5-7.5 4.6-.6 6.9-2.9 7.5-7.5Z" fill="currentColor"/></svg>';
const CONFETTI_TONES: NoteTone[] = ['running', 'review', 'needs', 'done'];

export type BurstKind = 'hearts' | 'sparkles' | 'confetti';

/** 从 rect 中心向上方扇形喷出一小撮粒子，播完自删。 */
export function burst(rect: DOMRect, kind: BurstKind = 'hearts', count = 8) {
  if (prefersReducedMotion()) return;
  const layer = document.createElement('div');
  layer.className = 'ui-burst-layer';
  layer.setAttribute('aria-hidden', 'true');
  document.body.appendChild(layer);
  const cx = rect.left + rect.width / 2;
  const cy = rect.top + rect.height * 0.4;
  const animations: Animation[] = [];
  for (let index = 0; index < count; index++) {
    const particle = document.createElement('span');
    const size = kind === 'confetti' ? 7 + Math.random() * 4 : 10 + Math.random() * 9;
    particle.className = `ui-burst-particle ui-burst-${kind}`;
    if (kind === 'confetti') particle.classList.add(`ui-note-paper-${CONFETTI_TONES[index % CONFETTI_TONES.length]}`);
    else particle.innerHTML = kind === 'sparkles' ? SPARKLE : index % 3 === 2 ? HEART_LINE : HEART;
    particle.style.width = `${size}px`;
    particle.style.height = `${kind === 'confetti' ? size * 0.7 : size}px`;
    layer.appendChild(particle);
    // 向上的 140° 扇形，粒子之间均匀分布再加一点抖动，不会全挤在一条线上。
    const angle = (-160 + (120 / Math.max(1, count - 1)) * index + (Math.random() * 16 - 8)) * Math.PI / 180;
    const distance = 46 + Math.random() * 64;
    const x = cx + Math.cos(angle) * distance;
    const y = cy + Math.sin(angle) * distance - 18;
    const spin = (Math.random() * 2 - 1) * (kind === 'confetti' ? 360 : 40);
    const animation = particle.animate([
      { transform: `translate(${cx - size / 2}px, ${cy - size / 2}px) scale(.3) rotate(0deg)`, opacity: 0 },
      { transform: `translate(${(cx + x) / 2 - size / 2}px, ${(cy + y) / 2 - size / 2 - 12}px) scale(1.1) rotate(${spin / 2}deg)`, opacity: 1, offset: 0.35 },
      { transform: `translate(${x - size / 2}px, ${y - size / 2 + (kind === 'confetti' ? 30 : 0)}px) scale(.6) rotate(${spin}deg)`, opacity: 0 }
    ], { duration: 900 + Math.random() * 500, delay: index * 22, easing: 'cubic-bezier(.2, .7, .3, 1)', fill: 'forwards' });
    animations.push(animation);
  }
  void Promise.allSettled(animations.map(animation => animation.finished)).then(() => layer.remove());
}

/* ---------- 小反馈 ---------- */

/** 计数、按钮被「砸中」时跳一下。 */
export function bump(element: Element | null | undefined, strength = 1) {
  if (!element || prefersReducedMotion()) return;
  element.animate([
    { transform: 'scale(1)' },
    { transform: `scale(${1 + 0.2 * strength})`, offset: 0.3 },
    { transform: `scale(${1 - 0.06 * strength})`, offset: 0.6 },
    { transform: 'scale(1)' }
  ], { duration: 460, easing: 'cubic-bezier(.3, .7, .4, 1)' });
}

/** 需要用户注意时，轻轻探出来再缩回去。 */
export function nudge(element: Element | null | undefined) {
  if (!element || prefersReducedMotion()) return;
  element.animate([
    { transform: 'translateX(0) rotate(0)' },
    { transform: 'translateX(-12px) rotate(-3deg)', offset: 0.25 },
    { transform: 'translateX(-6px) rotate(2deg)', offset: 0.5 },
    { transform: 'translateX(-9px) rotate(-1deg)', offset: 0.7 },
    { transform: 'translateX(0) rotate(0)' }
  ], { duration: 900, easing: 'cubic-bezier(.3, .7, .4, 1)', composite: 'add' });
}

/* ---------- 页面间的形变过渡 ---------- */

/**
 * 首页 / 主会话 / 右缘之间切换时，小猫用 View Transitions 从旧位置形变到新位置。
 * 两边各有一只带同名 `view-transition-name` 的小猫（同一时刻只挂一只），浏览器负责插值。
 * 不支持的浏览器、或用户要求减少动效时，直接切换。
 */
export function withViewTransition(update: () => void) {
  const doc = document as Document & { startViewTransition?: (callback: () => void) => unknown };
  if (typeof doc.startViewTransition !== 'function' || prefersReducedMotion()) { update(); return; }
  doc.startViewTransition(() => { flushSync(update); });
}

export const KITTEN_TRANSITION_NAME = 'agentdock-kitten';
