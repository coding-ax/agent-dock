import { startTransition, useEffect, useState, type ReactNode } from 'react';

/**
 * 弹窗先出壳、下一帧再挂重内容。
 *
 * 弹窗的状态切换发生在点击处理器里，React 会把整个弹窗（含 Ant Design 表单）一次提交完，
 * 浏览器才有机会绘制——这就是「点了没反应，过一下整个弹窗才蹦出来」。这里让弹窗的
 * 头部/遮罩/打开动画先渲染，重表单等两帧后再以 transition 挂载：
 * - 两帧保证外壳已经真正上屏；
 * - startTransition 让表单挂载可以被拆成可中断的小任务，不产生 50ms+ 的长任务。
 */
export function DeferredMount({ children, placeholder }: { children: ReactNode; placeholder: ReactNode }) {
  const [ready, setReady] = useState(false);
  useEffect(() => {
    let second = 0;
    const first = requestAnimationFrame(() => {
      second = requestAnimationFrame(() => startTransition(() => setReady(true)));
    });
    return () => {
      cancelAnimationFrame(first);
      cancelAnimationFrame(second);
    };
  }, []);
  return <>{ready ? children : placeholder}</>;
}

/** 弹窗主体的通用占位：几行灰块，避免重内容挂载前出现空白。 */
export function DeferredSkeleton({ className = '' }: { className?: string }) {
  return <div aria-hidden="true" className={`space-y-2.5 ${className}`}>
    <div className="h-9 ui-skeleton rounded-md bg-zinc-100"/>
    <div className="h-9 ui-skeleton rounded-md bg-zinc-100"/>
    <div className="h-9 ui-skeleton rounded-md bg-zinc-100"/>
  </div>;
}
