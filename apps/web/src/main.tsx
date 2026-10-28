import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import App from './App';
import { AntdScope } from './AntdScope';
import { WebAccessDeniedError } from './api';
import './index.css';
// 401/403（访问门拒绝）不重试：凭证缺失时重试只会刷一屏 401，轮询间隔再兜底就是截图里的死循环。
const client = new QueryClient({
  defaultOptions: {
    queries: {
      retry: (failureCount, error) => !(error instanceof WebAccessDeniedError) && failureCount < 3
    }
  }
});
// 事件流是只增不改的长数组，token 级 SSE 每条都要写一次缓存；replaceEqualDeep 的结构共享
// 会对整个数组做深比较，实测 20000 条时 setQueryData 从 0.6s 涨到 10s。只对 ['events', *]
// 关掉：sessions / tasks / lark-config 都在轮询，靠引用稳定抑制重渲染，不能动。
// 必须走 setQueryDefaults 而不是挂在 useQuery 上——query 被 gc 或 removeQueries 之后，
// setQueryData 会用不含该 option 的默认值重建 Query，结构共享就悄悄恢复了（实测 undefined）。
client.setQueryDefaults(['events'], {
  structuralSharing: false,
  // 事件数组很大——真实最大会话 94145 条、解析后约 74MB。默认 gcTime 是 5 分钟，
  // 浏览几个大会话就有几百 MB 常驻，这才是「页面停留久了内存涨」的直接来源。
  // 缩到 60s：只影响「已切走且无人订阅」的会话，当前会话有 observer 不会被回收；
  // 代价是超过 60s 再切回去要重新全量拉一次，实测最大会话 0.36s，可以接受。
  gcTime: 60_000,
  // 高频切换会话时避免重复拉取：默认 staleTime=0 意味着每次切回都重新请求（网络往返 +
  // 重建几十 MB 的时间线）。活跃会话的事件由 SSE 持续 setQueryData 写进缓存，不需要靠
  // refetch 保持最新；给一个 30s 窗口，反复来回切时直接命中缓存，只有离开超过 30s 才会
  // 触发增量/全量补拉（SSE 断开期间的补拉由 useRefetchFullOnFocus 兜底）。
  staleTime: 30_000
});
createRoot(document.getElementById('root')!).render(<StrictMode><QueryClientProvider client={client}><AntdScope><App/></AntdScope></QueryClientProvider></StrictMode>);

// 临时调试：?vvdebug=1 时在页面左上角显示 viewport 实测数值，用于定位移动端软键盘问题。
// 挂在 body 根级，独立于 #root，避免根容器的 height/transform 影响自身定位。
if (new URLSearchParams(window.location.search).get('vvdebug') === '1' && window.visualViewport) {
  const vv = window.visualViewport!;
  const box = document.createElement('div');
  box.style.cssText = 'position:fixed;top:0;left:0;right:0;z-index:99999;margin:0;padding:6px 8px;font:11px/1.5 ui-monospace,Menlo,monospace;background:rgba(0,0,0,.78);color:#7CFC9A;pointer-events:none;white-space:pre-wrap;word-break:break-all';
  document.body.appendChild(box);
  const dvh = () => `${(window.innerHeight / 100).toFixed(1)}dvh?`;
  const render = () => {
    box.textContent = [
      `vv.h=${Math.round(vv.height)} offTop=${Math.round(vv.offsetTop)} scale=${vv.scale} w=${Math.round(vv.width)}`,
      `innerH=${window.innerHeight} innerW=${window.innerWidth} dpr=${window.devicePixelRatio}`,
      `dvh100≈${dvh()} apply=${Math.abs(vv.scale - 1) <= 0.01}`,
      `docH=${document.documentElement.clientHeight} ua=${(navigator.userAgent.match(/OS [0-9_]+/)?.[0] ?? '')}`
    ].join('\n');
  };
  render();
  vv.addEventListener('resize', render);
  vv.addEventListener('scroll', render);
}
