import { useEffect, useRef } from 'react';

/** scale≈1 的判定容差：聚焦缩放（iOS focus zoom，实测 ≈1.14）与手动双指缩放都会明显偏离 1。 */
const SCALE_TOLERANCE = 0.01;

/**
 * 把根容器钉在「可视视口」上，返回需要挂到该容器上的 ref。
 *
 * 各容器对软键盘的处理分两类：
 * - overlay 模式（iOS Safari）：键盘浮在 layout viewport 之上，layout 不缩小（100dvh 仍是全高），
 *   但 visualViewport 变矮并整体上推（height 缩小、offsetTop > 0）。此时必须用 vv.height 锁根容器
 *   高度、translateY(offsetTop) 跟随上推，否则整页可橡皮筋滚动且 composer 与键盘之间空出一条。
 * - resize 模式（多数 App 内置 WebView，如飞书 WKWebView）：键盘弹起时容器自己把 layout viewport
 *   缩小，clientHeight 与 vv.height 一起变小、offsetTop 为 0，100dvh 已正确收缩。此时按规则写进去
 *   的 height 恰好就是 100dvh，transform 为 0，与不干预等价。
 *
 * 因此不需要（也刻意不做）「是否处于 overlay」的二选一判定：无键盘时两套来源数值本来就相等，
 * 键盘动画期间逐帧判定反而会在两套来源之间跳一帧，整页连顶栏一起抖。这里只保留 scale≈1 这道闸——
 * 缩放状态下 vv.height 是「缩放后的 layout px」，与 clientHeight 不同基准，写进去会整体错位，
 * 这时清掉内联样式交回 CSS 100dvh。
 *
 * 写入方式必须是事件回调里的命令式 style 赋值，不能走 useState：
 * setState 会让整个 App 重渲染，而渲染由 Scheduler 调度（MessageChannel），
 * 会落在键盘动画的下一帧之后，根容器跟不上 OS 的动画，表现就是顶栏先滚出去再被拽回来。
 * 命令式赋值在同一帧内生效，且不触发任何 React 工作。
 *
 * 调用方必须保证该容器不带受 React 管理的 style（否则重渲染会覆盖这里的赋值）。
 *
 * ahooks 的 useEventListener target 类型不覆盖 VisualViewport，这里直接手写订阅。
 */
export function useVisualViewportShell<T extends HTMLElement>() {
  const ref = useRef<T | null>(null);

  useEffect(() => {
    const element = ref.current;
    const vv = window.visualViewport;
    if (!element || !vv) return;
    const sync = () => {
      if (Math.abs(vv.scale - 1) > SCALE_TOLERANCE) {
        element.style.height = '';
        element.style.transform = '';
        return;
      }
      element.style.height = `${vv.height}px`;
      element.style.transform = `translateY(${vv.offsetTop}px)`;
    };
    sync();
    // height 与 offsetTop 的变化分别伴随 resize / scroll 两个事件，都要订阅。
    vv.addEventListener('resize', sync);
    vv.addEventListener('scroll', sync);
    return () => {
      vv.removeEventListener('resize', sync);
      vv.removeEventListener('scroll', sync);
      element.style.height = '';
      element.style.transform = '';
    };
  }, []);

  return ref;
}
