import { forwardRef, useEffect, useImperativeHandle, useRef, useState, type CSSProperties, type MouseEvent } from 'react';
import { burst, prefersReducedMotion } from './effects';
import type { KittenMood } from './companion-model';
import type { LifeStage } from '../api';
import './companion.css';
import './lifecycle.css';

/**
 * 小猫：首页、主会话头像、侧栏卡片、右缘把手共用的一只。
 *
 * 形象来自设计稿：奶白长毛、蓝金异色瞳、额头戴 >_ 屏幕护目镜、耳机和深色围巾的像素猫。
 * 每种心情是一张透明底的像素立绘（public/companion/），不做逐部件动画；「活」的部分仍是 class / CSS 变量驱动，
 * pointermove 只经 requestAnimationFrame 写 --mx/--my，不触发 React 重渲染：
 * - mood → 立绘：idle 待命、busy 敲电脑、curious 拿放大镜、alert 头顶问号、sleepy 趴着睡、happy 眯眼笑；
 * - track：整只猫轻轻朝光标方向倾斜；typingAware：输入框聚焦时低头、按键时轻轻抖一下；
 * - celebrateKey 变化：原地蹦一下、换成闪亮立绘并冒爱心；点它：抖一下、偶尔冒一颗心；
 * - 呼吸：所有循环动画只动 transform，prefers-reduced-motion 下不注册任何监听，保持静态。
 *
 * stage / retired / collar 仍保留在 data-* 上（徽章等外部 UI 在用），立绘本身不再画道具。
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

/** 每种心情对应参考图里的一张像素立绘（透明底 PNG）。 */
const SPRITES = Object.fromEntries((['idle', 'happy', 'curious', 'sparkle', 'busy', 'search', 'sleepy'] as const).map(name => [name, `/companion/cat-${name}.png`])) as Record<'idle' | 'happy' | 'curious' | 'sparkle' | 'busy' | 'search' | 'sleepy', string>;
const MOOD_SPRITE: Record<KittenMood, keyof typeof SPRITES> = {
  idle: 'idle', happy: 'happy', curious: 'search', busy: 'busy', alert: 'curious', sleepy: 'sleepy', sad: 'idle',
};

export type KittenHandle = { element: HTMLDivElement | null; hop(): void; twitch(): void };

const isEditable = (target: EventTarget | null) =>
  target instanceof HTMLTextAreaElement
  || (target instanceof HTMLInputElement && !['checkbox', 'radio', 'range', 'button', 'submit'].includes(target.type))
  || (target instanceof HTMLElement && target.isContentEditable);

export const Kitten = forwardRef<KittenHandle, KittenProps>(function Kitten({
  size = 96, variant = 'full', mood = 'idle', stage, retired = false, collar = false, drawCollar = false, track = false, typingAware = false,
  interactive = true, celebrateKey, viewTransitionName, label, className = '', style, onClick
}, ref) {
  const root = useRef<HTMLDivElement>(null);
  const [sparkling, setSparkling] = useState(false);
  const toggles = useRef({ twitch: false, hop: false });

  const twitch = () => {
    const el = root.current;
    if (!el) return;
    el.classList.remove('ui-cat-ear-wiggle-a', 'ui-cat-ear-wiggle-b');
    toggles.current.twitch = !toggles.current.twitch;
    el.classList.toggle('ui-cat-twitching-a', toggles.current.twitch);
    el.classList.toggle('ui-cat-twitching-b', !toggles.current.twitch);
  };
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
    let blinkTimer = 0;
    let blinkOffTimer = 0;
    let typing = false;
    let wiggle = false;

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
    const onInput = (event: Event) => {
      if (!isEditable(event.target)) return;
      el.classList.remove('ui-cat-twitching-a', 'ui-cat-twitching-b');
      wiggle = !wiggle;
      el.classList.toggle('ui-cat-ear-wiggle-a', wiggle);
      el.classList.toggle('ui-cat-ear-wiggle-b', !wiggle);
    };
    const scheduleBlink = () => {
      blinkTimer = window.setTimeout(() => {
        el.classList.add('ui-cat-blinking');
        blinkOffTimer = window.setTimeout(() => {
          el.classList.remove('ui-cat-blinking');
          scheduleBlink();
        }, 120);
      }, 3_500 + Math.random() * 3_500);
    };

    if (track) {
      window.addEventListener('pointermove', onMove, { passive: true });
      document.documentElement.addEventListener('pointerleave', clearLook);
    }
    if (typingAware) {
      document.addEventListener('focusin', onFocusIn);
      document.addEventListener('focusout', onFocusOut);
      document.addEventListener('input', onInput);
      // 挂载时输入框可能已经聚焦（首页自动聚焦）。
      if (isEditable(document.activeElement)) { typing = true; el.classList.add('ui-cat-typing'); }
    }
    scheduleBlink();
    return () => {
      cancelAnimationFrame(frame);
      window.clearTimeout(resetTimer);
      window.clearTimeout(blinkTimer);
      window.clearTimeout(blinkOffTimer);
      window.removeEventListener('pointermove', onMove);
      document.documentElement.removeEventListener('pointerleave', clearLook);
      document.removeEventListener('focusin', onFocusIn);
      document.removeEventListener('focusout', onFocusOut);
      document.removeEventListener('input', onInput);
    };
  }, [track, typingAware]);

  const handleClick = (event: MouseEvent<HTMLElement>) => {
    twitch();
    // 点三下大概冒一次心：不是每次都有，才像真的猫。
    if (variant === 'full' && Math.random() < 0.34 && root.current) burst(root.current.getBoundingClientRect(), 'hearts', 4);
    onClick?.(event);
  };

  const face = variant === 'face';
  const sprite = sparkling ? SPRITES.sparkle : SPRITES[MOOD_SPRITE[mood] ?? 'idle'];
  const svg = <span className="ui-cat-sprite-box">
    {!face && <span className="ui-cat-shadow-px" aria-hidden="true"/>}
    <img className="ui-cat-sprite" src={sprite} alt="" draggable={false} decoding="async"/>
  </span>;

  const classes = `ui-cat ui-kitten ${face ? 'ui-kitten-face' : 'ui-kitten-full'} ${className}`;
  const rootStyle: CSSProperties = { width: size, height: size, ...(viewTransitionName ? { viewTransitionName } as CSSProperties : {}), ...style };
  return <div ref={root} className={classes} data-mood={mood} data-stage={stage} data-retired={retired || undefined} style={rootStyle}>
    {interactive
      ? <button type="button" tabIndex={onClick ? 0 : -1} aria-label={label ?? '小猫'} onClick={handleClick} className="ui-cat-stage" style={{ width: size, height: size }}>{svg}</button>
      : <span className="ui-cat-stage" role={label ? 'img' : undefined} aria-label={label} style={{ width: size, height: size }}>{svg}</span>}
  </div>;
});
