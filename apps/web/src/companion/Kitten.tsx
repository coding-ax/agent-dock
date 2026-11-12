import { forwardRef, useEffect, useImperativeHandle, useRef, type CSSProperties, type MouseEvent } from 'react';
import { burst, prefersReducedMotion } from './effects';
import type { KittenMood } from './companion-model';
import type { LifeStage } from '../api';
import './companion.css';
import './lifecycle.css';

/**
 * 线条小猫：首页、主会话头像、侧栏卡片、右缘把手共用的一只。
 *
 * 纯 SVG 线条（stroke=currentColor），颜色跟随正文色，没有位图和滤镜。所有「活」的部分
 * 都是 class / data-* / CSS 变量驱动，pointermove 只经 requestAnimationFrame 写 --mx/--my，
 * 不触发 React 重渲染：
 * - mood：idle 呼吸、busy 头顶冒思考点、alert 竖耳 + 感叹号、sleepy 眯眼 + zzz、
 *   happy 眯眼笑 + 脸红、sad 耳朵耷拉、curious 歪头；
 * - track：眼睛和头跟着光标；typingAware：输入框（含富文本编辑器）聚焦时低头看、按键耳朵抖；
 * - collar：认领后的项圈和小铃铛，第一次出现时一笔画出来；
 * - celebrateKey 变化：原地蹦一下并冒爱心；点它：耳朵抖、偶尔冒一颗心。
 *
 * - stage：小猫的年纪。幼猫头顶一撮毛、呼吸轻快；资深戴圆眼镜；老年再加白眉、呼吸放慢；
 *   retired：退休时戴上小帽子（交接仪式里走远的那只）。
 *
 * variant='face' 只裁出头部，给 24–40px 的头像位用（线宽相应加粗，缩小后仍清楚）。
 * prefers-reduced-motion 下不注册任何监听，保持静态。
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
  size = 96, variant = 'full', mood = 'idle', stage, retired = false, collar = false, drawCollar = false, track = false, typingAware = false,
  interactive = true, celebrateKey, viewTransitionName, label, className = '', style, onClick
}, ref) {
  const root = useRef<HTMLDivElement>(null);
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
    const el = root.current;
    if (el) window.setTimeout(() => burst(el.getBoundingClientRect(), 'hearts', 9), 180);
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
  const strokeWidth = face ? Math.max(2.2, Math.min(3.4, 64 / size * 1.6)) : 1.75;
  const svg = <svg viewBox={face ? '15 7 66 62' : '0 0 96 96'} width={size} height={size} aria-hidden="true" fill="none" stroke="currentColor" strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round" overflow="visible">
    <g className="ui-cat-body-group">
      {!face && <>
        <path className="ui-cat-tail" d="M59 79 C69 80 75 74 72.5 67 C71 63 67 63.5 67 67.5"/>
        <path d="M36 61 C33 68 33 77 39 82 C44 86 52 86 57 82 C63 77 63 68 60 61"/>
        <path d="M40 81.5 Q42.5 85.5 45 81.5"/>
        <path d="M51 81.5 Q53.5 85.5 56 81.5"/>
      </>}
      <g className="ui-cat-head">
        <path className="ui-cat-ear ui-cat-ear-l" d="M33 29 L28.5 13.5 Q28 11 30.5 11.8 L42 17.5"/>
        <path className="ui-cat-ear ui-cat-ear-r" d="M63 29 L67.5 13.5 Q68 11 65.5 11.8 L54 17.5"/>
        <path d="M30 32 C30 24 37 21 48 21 C59 21 66 24 66 32 L66 44 C66 56 58 63 48 63 C38 63 30 56 30 44 Z"/>
        <g className="ui-cat-eye"><circle cx="39.5" cy="40" r="5.2"/><circle className="ui-cat-pupil" cx="39.5" cy="40" r="2" fill="currentColor" stroke="none"/></g>
        <g className="ui-cat-eye"><circle cx="56.5" cy="40" r="5.2"/><circle className="ui-cat-pupil" cx="56.5" cy="40" r="2" fill="currentColor" stroke="none"/></g>
        <g className="ui-cat-happy"><path d="M35.5 41 Q39.5 36.5 43.5 41"/><path d="M52.5 41 Q56.5 36.5 60.5 41"/></g>
        <g className="ui-cat-blush" stroke="none"><ellipse cx="35" cy="48.5" rx="3.6" ry="2"/><ellipse cx="61" cy="48.5" rx="3.6" ry="2"/></g>
        <path d="M45.8 46.5 L50.2 46.5 L48 49 Z"/>
        <path d="M48 49 C46 52.5 43 52.5 42 50.5 M48 49 C50 52.5 53 52.5 54 50.5"/>
        <g className="ui-cat-whiskers ui-cat-whiskers-l"><path d="M29 44 L19.5 43 M29 48 L19.5 49.5"/></g>
        <g className="ui-cat-whiskers ui-cat-whiskers-r"><path d="M67 44 L76.5 43 M67 48 L76.5 49.5"/></g>
        {/* 阶段道具：都在头部组里跟着头动，用 opacity 切换，不增删节点。 */}
        <g className="ui-cat-tuft"><path d="M46.5 21 C45.8 17.8 47.6 16 49.8 16.6"/><path d="M49.2 21 C49.4 18.9 50.9 18 52.4 18.5"/></g>
        <g className="ui-cat-glasses"><circle cx="39.5" cy="40" r="7.4"/><circle cx="56.5" cy="40" r="7.4"/><path d="M46.9 39.2 Q48 38 49.1 39.2"/><path d="M32.1 38.6 L29.6 37.2 M63.9 38.6 L66.4 37.2"/></g>
        <g className="ui-cat-brows"><path d="M34.2 31.6 Q39.5 28.6 44.6 31.6"/><path d="M51.4 31.6 Q56.5 28.6 61.8 31.6"/></g>
        <g className="ui-cat-hat"><path d="M36.5 22.4 C38 16.4 58 16.4 59.5 22.4 C52 21 44 21 36.5 22.4 Z"/><path d="M48 17 L48.8 14.2"/></g>
      </g>
      {collar && <g className={`ui-cat-collar${drawCollar ? ' ui-cat-collar-draw' : ''}`}>
        <path pathLength={1} d="M36.6 61.6 Q48 68.2 59.4 61.6"/>
        <circle className="ui-cat-bell" pathLength={1} cx="48" cy="67.4" r="2.3"/>
      </g>}
    </g>
    {/* 心情小道具：都画在头顶附近，用 opacity / transform 切换，不增删节点。 */}
    <g className="ui-cat-thought" stroke="none" fill="currentColor"><circle cx="68" cy="13" r="1.6"/><circle cx="73.5" cy="9" r="1.6"/><circle cx="79" cy="5" r="1.6"/></g>
    <g className="ui-cat-alert"><path d="M75 4.5 L75 12"/><circle cx="75" cy="16" r=".4" fill="currentColor"/></g>
    <g className="ui-cat-zzz" strokeWidth={face ? strokeWidth * 0.7 : 1.4}><path className="ui-cat-z1" d="M68 15 h5 l-5 5 h5"/><path className="ui-cat-z2" d="M75 6 h4 l-4 4 h4"/></g>
  </svg>;

  const classes = `ui-cat ui-kitten ${face ? 'ui-kitten-face' : 'ui-kitten-full'} ${className}`;
  const rootStyle: CSSProperties = { width: size, height: size, ...(viewTransitionName ? { viewTransitionName } as CSSProperties : {}), ...style };
  return <div ref={root} className={classes} data-mood={mood} data-stage={stage} data-retired={retired || undefined} style={rootStyle}>
    {interactive
      ? <button type="button" tabIndex={onClick ? 0 : -1} aria-label={label ?? '小猫'} onClick={handleClick} className="ui-cat-stage" style={{ width: size, height: size }}>{svg}</button>
      : <span className="ui-cat-stage" role={label ? 'img' : undefined} aria-label={label} style={{ width: size, height: size }}>{svg}</span>}
  </div>;
});
