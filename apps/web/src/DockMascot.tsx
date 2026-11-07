import { useEffect, useRef } from 'react';

/**
 * 空状态的线条小猫。
 *
 * 纯 SVG 线条（stroke=currentColor，1.75px，无填充），颜色跟随正文色，不使用任何
 * 渐变色 / 滤镜 / 位图。交互状态全部通过 class 与 CSS 变量驱动：
 * - pointermove → requestAnimationFrame 写 --mx/--my，不触发 React 重渲染；
 * - 瞳孔在眼眶内偏移（最大 45% 半径），头部 ±3px 平移 + ±4° 倾斜；
 * - 每 4–7 秒随机眨眼 120ms，尾巴 3s 周期摆动，点击耳朵抖 300ms；
 * - 鼠标悬停眯眼笑，10 秒不动犯困，输入框聚焦时看向下方、每次按键耳朵微动；
 * - prefers-reduced-motion 下不注册任何监听，保持静态、眼睛居中。
 */
export function DockMascot({ size = 96 }: { size?: number }) {
  const root = useRef<HTMLDivElement>(null);
  const twitchToggle = useRef(false);

  useEffect(() => {
    const el = root.current;
    if (!el || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;

    let frame = 0;
    let resetTimer = 0;
    let blinkTimer = 0;
    let blinkOffTimer = 0;
    let sleepyTimer = 0;
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
    const scheduleSleepy = () => {
      window.clearTimeout(sleepyTimer);
      sleepyTimer = window.setTimeout(() => el.classList.add('ui-cat-sleepy'), 10_000);
    };
    const wake = () => { el.classList.remove('ui-cat-sleepy'); scheduleSleepy(); };

    const onMove = (event: PointerEvent) => {
      wake();
      if (typing) return;
      const rect = el.getBoundingClientRect();
      const dx = event.clientX - (rect.left + rect.width / 2);
      const dy = event.clientY - (rect.top + rect.height / 2);
      const distance = Math.hypot(dx, dy) || 1;
      // 单位方向 × 距离权重：光标贴近时动作小，离得越远越明确。
      const strength = Math.min(1, distance / 220);
      setLook(dx / distance * strength, dy / distance * strength);
      // 鼠标停住 1.5 秒后眼睛慢慢回到正中。
      window.clearTimeout(resetTimer);
      resetTimer = window.setTimeout(clearLook, 1_500);
    };

    const isInput = (target: EventTarget | null) => target instanceof HTMLTextAreaElement;
    const onFocusIn = (event: FocusEvent) => {
      if (!isInput(event.target)) return;
      typing = true;
      el.classList.add('ui-cat-typing');
      clearLook();
      wake();
    };
    const onFocusOut = (event: FocusEvent) => {
      if (!isInput(event.target)) return;
      typing = false;
      el.classList.remove('ui-cat-typing');
      clearLook();
    };
    const onInput = (event: Event) => {
      if (!isInput(event.target)) return;
      // 每次按键让耳朵轻抖一下。过去用「移除 class → 读 offsetWidth 强制 reflow → 重加」重启动画，
      // 每敲一个字都要同步布局整个页面；改成两个等价类交替，靠 animation-name 变化重启，零 reflow。
      // 两组信号互斥：同时挂 wiggle 与 twitch 时后者的 animation 会被覆盖。
      el.classList.remove('ui-cat-twitching-a', 'ui-cat-twitching-b');
      wiggle = !wiggle;
      el.classList.toggle('ui-cat-ear-wiggle-a', wiggle);
      el.classList.toggle('ui-cat-ear-wiggle-b', !wiggle);
      wake();
    };

    const scheduleBlink = () => {
      blinkTimer = window.setTimeout(() => {
        el.classList.add('ui-cat-blinking');
        blinkOffTimer = window.setTimeout(() => {
          el.classList.remove('ui-cat-blinking');
          scheduleBlink();
        }, 120);
      }, 4_000 + Math.random() * 3_000);
    };

    document.addEventListener('focusin', onFocusIn);
    document.addEventListener('focusout', onFocusOut);
    document.addEventListener('input', onInput);
    window.addEventListener('pointermove', onMove, { passive: true });
    document.documentElement.addEventListener('pointerleave', clearLook);
    scheduleBlink();
    scheduleSleepy();

    return () => {
      cancelAnimationFrame(frame);
      window.clearTimeout(resetTimer);
      window.clearTimeout(blinkTimer);
      window.clearTimeout(blinkOffTimer);
      window.clearTimeout(sleepyTimer);
      document.removeEventListener('focusin', onFocusIn);
      document.removeEventListener('focusout', onFocusOut);
      document.removeEventListener('input', onInput);
      window.removeEventListener('pointermove', onMove);
      document.documentElement.removeEventListener('pointerleave', clearLook);
    };
  }, []);

  const twitchEars = () => {
    const el = root.current;
    if (!el) return;
    // 用两组 keyframes 交替触发重播；打字触发的 wiggle 先摘掉，避免覆盖 twitch 动画。
    el.classList.remove('ui-cat-ear-wiggle-a', 'ui-cat-ear-wiggle-b');
    twitchToggle.current = !twitchToggle.current;
    el.classList.toggle('ui-cat-twitching-a', twitchToggle.current);
    el.classList.toggle('ui-cat-twitching-b', !twitchToggle.current);
  };

  return <div ref={root} className="ui-cat mx-auto" style={{ width: size, height: size }}>
    <button type="button" tabIndex={-1} aria-label="AgentDock 小猫" onClick={twitchEars} className="ui-cat-stage" style={{ width: size, height: size }}>
      <svg viewBox="0 0 96 96" width={size} height={size} aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
        <g className="ui-cat-head">
          <path className="ui-cat-ear ui-cat-ear-l" d="M33 29 L28.5 13.5 Q28 11 30.5 11.8 L42 17.5"/>
          <path className="ui-cat-ear ui-cat-ear-r" d="M63 29 L67.5 13.5 Q68 11 65.5 11.8 L54 17.5"/>
          <path d="M30 32 C30 24 37 21 48 21 C59 21 66 24 66 32 L66 44 C66 56 58 63 48 63 C38 63 30 56 30 44 Z"/>
          <g className="ui-cat-eye"><circle cx="39.5" cy="40" r="5.2"/><circle className="ui-cat-pupil" cx="39.5" cy="40" r="2" fill="currentColor" stroke="none"/></g>
          <g className="ui-cat-eye"><circle cx="56.5" cy="40" r="5.2"/><circle className="ui-cat-pupil" cx="56.5" cy="40" r="2" fill="currentColor" stroke="none"/></g>
          <g className="ui-cat-happy"><path d="M35.5 41 Q39.5 36.5 43.5 41"/><path d="M52.5 41 Q56.5 36.5 60.5 41"/></g>
          <path d="M45.8 46.5 L50.2 46.5 L48 49 Z"/>
          <path d="M48 49 C46 52.5 43 52.5 42 50.5 M48 49 C50 52.5 53 52.5 54 50.5"/>
          <g className="ui-cat-whiskers ui-cat-whiskers-l"><path d="M29 44 L19.5 43 M29 48 L19.5 49.5"/></g>
          <g className="ui-cat-whiskers ui-cat-whiskers-r"><path d="M67 44 L76.5 43 M67 48 L76.5 49.5"/></g>
        </g>
        <path className="ui-cat-tail" d="M59 79 C69 80 75 74 72.5 67 C71 63 67 63.5 67 67.5"/>
        <path d="M36 61 C33 68 33 77 39 82 C44 86 52 86 57 82 C63 77 63 68 60 61"/>
        <path d="M40 81.5 Q42.5 85.5 45 81.5"/>
        <path d="M51 81.5 Q53.5 85.5 56 81.5"/>
      </svg>
    </button>
  </div>;
}
