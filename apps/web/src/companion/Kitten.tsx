import { forwardRef, useEffect, useImperativeHandle, useRef, useState, type CSSProperties, type MouseEvent } from 'react';
import { burst, prefersReducedMotion } from './effects';
import {
  FALLBACK_KITTEN_SPRITE,
  kittenSpriteKey,
  kittenSpritePng,
  kittenSpriteWebp,
  type KittenMood,
} from './kitten-moods';
import type { LifeStage } from '../api';
import './companion.css';
import './lifecycle.css';

/**
 * 小猫：首页、主会话头像、侧栏卡片、右缘把手共用的一只。
 *
 * 形象来自设计稿：奶白长毛、蓝金异色瞳、额头戴 >_ 屏幕护目镜、耳机和深色围巾的像素猫。
 * 每种心情是一张透明底的像素立绘（public/companion/，15 套状态与精灵映射见 kitten-moods.ts），
 * 「活」的部分由动效 .webp + CSS 变量驱动，pointermove 只经 requestAnimationFrame 写 --mx/--my，不触发 React 重渲染：
 * - mood → 立绘：idle 待命、curious 歪头、thinking 托腮思考、busy 敲电脑、delegating 派便签、
 *   reviewing 放大镜验收、waiting/alert 招手等你拍板、happy 眯眼笑、celebrating 举爪庆祝、
 *   error 排查小紧张、sad 耷拉耳朵、tidying 整理记忆、night 深夜月光陪伴、sleepy 趴着睡；
 * - track：整只猫轻轻朝光标方向倾斜；typingAware：输入框聚焦时安静低头倾听并暂停鼠标跟随，打字过程沉稳不抖动；
 * - celebrateKey 变化：原地蹦一下、换成闪亮立绘并冒爱心；点它：抖一下、偶尔冒一颗心；
 * - 呼吸与状态切换：所有循环动画只动 transform / opacity，prefers-reduced-motion 下回退静态 PNG 并停住动效；
 * - 资源降级兜底：任意状态立绘加载失败时静默回退到 cat-idle.png，不出现破图。
 *
 * stage / retired 仍保留在 data-* 上（徽章等外部 UI 在用），立绘本身不再画道具。
 * variant='face' 只露出头部，给 24–40px 的头像位用。
 */
export type KittenProps = {
  size?: number;
  variant?: 'full' | 'face';
  mood?: KittenMood;
  /** 年纪：不传时是没有阶段道具的成年样子（旧服务端）。 */
  stage?: LifeStage;
  /** 退休的老猫：戴上小帽子。 */
  retired?: boolean;
  collar?: boolean;
  /** 项圈第一次出现时画出来；平时直接显示。 */
  drawCollar?: boolean;
  track?: boolean;
  typingAware?: boolean;
  /** 能点（耳朵抖 + 心）；作为大按钮的一部分时可关掉，免得吞掉点击。 */
  interactive?: boolean;
  celebrateKey?: number;
  viewTransitionName?: string;
  label?: string;
  className?: string;
  style?: CSSProperties;
  onClick?: (event: MouseEvent<HTMLElement>) => void;
};

export type KittenHandle = { element: HTMLDivElement | null; hop(): void; twitch(): void };

const isEditable = (target: EventTarget | null) =>
  target instanceof HTMLTextAreaElement
  || (target instanceof HTMLInputElement && !['checkbox', 'radio', 'range', 'button', 'submit'].includes(target.type))
  || (target instanceof HTMLElement && target.isContentEditable);

export const Kitten = forwardRef<KittenHandle, KittenProps>(function Kitten({
  size = 96, variant = 'full', mood = 'idle', stage, retired = false, track = false, typingAware = false,
  interactive = true, celebrateKey, viewTransitionName, label, className = '', style, onClick
}, ref) {
  const root = useRef<HTMLDivElement>(null);
  const [sparkling, setSparkling] = useState(false);
  const [fallbackFor, setFallbackFor] = useState<string | null>(null);
  const toggles = useRef({ twitch: false, hop: false });
  const twitchClearTimer = useRef<number | undefined>(undefined);

  const twitch = () => {
    const el = root.current;
    if (!el) return;
    toggles.current.twitch = !toggles.current.twitch;
    el.classList.toggle('ui-cat-twitching-a', toggles.current.twitch);
    el.classList.toggle('ui-cat-twitching-b', !toggles.current.twitch);
    window.clearTimeout(twitchClearTimer.current);
    twitchClearTimer.current = window.setTimeout(() => {
      root.current?.classList.remove('ui-cat-twitching-a', 'ui-cat-twitching-b');
    }, 340);
  };
  useEffect(() => () => window.clearTimeout(twitchClearTimer.current), []);
  const hop = () => {
    const el = root.current;
    if (!el || prefersReducedMotion()) return;
    // 同 twitch：两个等价类交替，靠 animation-name 变化重播，不读布局。
    toggles.current.hop = !toggles.current.hop;
    el.classList.toggle('ui-cat-hop-a', toggles.current.hop);
    el.classList.toggle('ui-cat-hop-b', !toggles.current.hop);
  };

  useImperativeHandle(ref, () => ({ get element() { return root.current; }, hop, twitch }), []);

  // 庆祝：蹦一下 + 爱心。首次挂载（key 从 undefined 变成数字）不算。
  const lastCelebrate = useRef(celebrateKey);
  useEffect(() => {
    if (celebrateKey === undefined || celebrateKey === lastCelebrate.current) return;
    lastCelebrate.current = celebrateKey;
    hop();
    setSparkling(true);
    const off = window.setTimeout(() => setSparkling(false), 1_800);
    const el = root.current;
    if (el) window.setTimeout(() => burst(el.getBoundingClientRect(), 'hearts', 9), 180);
    return () => window.clearTimeout(off);
  }, [celebrateKey]);

  useEffect(() => {
    const el = root.current;
    if (!el || prefersReducedMotion()) return;
    let frame = 0;
    let resetTimer = 0;
    let typing = false;

    const setLook = (x: number, y: number) => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        el.style.setProperty('--mx', x.toFixed(3));
        el.style.setProperty('--my', y.toFixed(3));
      });
    };
    const clearLook = () => setLook(0, 0);

    const onMove = (event: PointerEvent) => {
      if (typing) return;
      const rect = el.getBoundingClientRect();
      const dx = event.clientX - (rect.left + rect.width / 2);
      const dy = event.clientY - (rect.top + rect.height / 2);
      const distance = Math.hypot(dx, dy) || 1;
      const strength = Math.min(1, distance / 220);
      setLook(dx / distance * strength, dy / distance * strength);
      window.clearTimeout(resetTimer);
      resetTimer = window.setTimeout(clearLook, 1_500);
    };
    const onFocusIn = (event: FocusEvent) => {
      if (!isEditable(event.target)) return;
      typing = true;
      el.classList.add('ui-cat-typing');
      clearLook();
    };
    const onFocusOut = (event: FocusEvent) => {
      if (!isEditable(event.target)) return;
      typing = false;
      el.classList.remove('ui-cat-typing');
      clearLook();
    };
    if (track) {
      window.addEventListener('pointermove', onMove, { passive: true });
      document.documentElement.addEventListener('pointerleave', clearLook);
    }
    if (typingAware) {
      // 输入框聚焦时小猫安静低头倾听并暂停鼠标跟随；不再随每次按键反复触发抖动动画。
      document.addEventListener('focusin', onFocusIn);
      document.addEventListener('focusout', onFocusOut);
      // 挂载时输入框可能已经聚焦（首页自动聚焦）。
      if (isEditable(document.activeElement)) { typing = true; el.classList.add('ui-cat-typing'); }
    }
    return () => {
      cancelAnimationFrame(frame);
      window.clearTimeout(resetTimer);
      window.removeEventListener('pointermove', onMove);
      document.documentElement.removeEventListener('pointerleave', clearLook);
      document.removeEventListener('focusin', onFocusIn);
      document.removeEventListener('focusout', onFocusOut);
    };
  }, [track, typingAware]);

  const handleClick = (event: MouseEvent<HTMLElement>) => {
    twitch();
    // 点三下大概冒一次心：不是每次都有，才像真的猫。
    if (variant === 'full' && Math.random() < 0.34 && root.current) burst(root.current.getBoundingClientRect(), 'hearts', 4);
    onClick?.(event);
  };

  const face = variant === 'face';
  const spriteKey = kittenSpriteKey(mood, sparkling);
  const spritePng = kittenSpritePng(mood, sparkling);
  const spriteWebp = kittenSpriteWebp(mood, sparkling);
  const useFallback = fallbackFor === spritePng;
  const artwork = <span key={spriteKey} className="ui-cat-sprite-box ui-cat-sprite-swap">
    <picture>
      {!useFallback && <source media="(prefers-reduced-motion: no-preference)" type="image/webp" srcSet={spriteWebp}/>}
      <img
        className="ui-cat-sprite"
        src={useFallback ? FALLBACK_KITTEN_SPRITE : spritePng}
        alt=""
        draggable={false}
        decoding="async"
        onError={() => {
          if (!useFallback && spritePng !== FALLBACK_KITTEN_SPRITE) setFallbackFor(spritePng);
        }}
      />
    </picture>
  </span>;

  const classes = `ui-cat ui-kitten ${face ? 'ui-kitten-face' : 'ui-kitten-full'} ${className}`;
  const rootStyle: CSSProperties = { width: size, height: size, ...(viewTransitionName ? { viewTransitionName } as CSSProperties : {}), ...style };
  return <div ref={root} className={classes} data-mood={mood} data-sprite={spriteKey} data-stage={stage} data-retired={retired || undefined} style={rootStyle}>
    {interactive
      ? <button type="button" tabIndex={onClick ? 0 : -1} aria-label={label ?? '小猫'} onClick={handleClick} className="ui-cat-stage" style={{ width: size, height: size }}>{artwork}</button>
      : <span className="ui-cat-stage" role={label ? 'img' : undefined} aria-label={label} style={{ width: size, height: size }}>{artwork}</span>}
  </div>;
});
