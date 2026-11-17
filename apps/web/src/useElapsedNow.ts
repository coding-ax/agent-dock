import { useEffect, useState } from 'react';

/**
 * 只在需要实时耗时的时候起定时器：进行中每秒，排队每 30 秒。
 * 组件卸载或状态结束后立即清掉，不会留下一堆常驻 interval。
 */
export function useElapsedNow(active: boolean, intervalMs = 1_000) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), intervalMs);
    return () => window.clearInterval(timer);
  }, [active, intervalMs]);
  return now;
}
