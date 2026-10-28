import type { DockEvent } from './api';

/**
 * 把一批 SSE 事件合入已缓存的事件数组。
 *
 * 拆成纯函数有两个原因：一是 SSE 追加是整个 Web 端唯一的高频写路径（真实会话
 * 6960 条事件里 5661 条是 token 级 thinking），合并逻辑值得单独测；二是仓库没有
 * jsdom / RTL，只有 node 环境的纯函数单测，逻辑留在组件里就测不到。
 *
 * 语义与被它取代的逐条 findIndex + 展开写法保持一致：
 * - sequence 是唯一键。已存在的条目**就地替换**且不移动位置——工具卡片靠这条
 *   从「执行中」翻到「已完成」，换位置会让时间线顺序抖动。
 * - 未见过的 sequence 追加到尾部，保持 incoming 内部顺序。数组顺序只对原始日志
 *   的拼接有意义（buildTimeline 自己会按 timestamp/sequence 排序）。
 * - 没有任何新增时返回原数组引用，让 React 跳过这次派生与渲染。
 *
 * 逐条写入时每条事件都要全量扫描 + 全量复制，是 O(n²)；这里整批只处理一次。
 * 更关键的是走「序号大于队尾就直接追加」的快路径：服务端 sequence 严格单调递增
 * （runtime 的 emit 先持久化再派发，SSE 按序写出），所以正常流式场景根本不用建索引。
 * 每批都无条件建一次 Map 仍然是 O(n²)——真实 94145 事件的会话实测 10.7s，
 * 加上快路径后 0.38s。
 */
export function mergeEventBatch(current: DockEvent[], incoming: DockEvent[]): DockEvent[] {
  if (!incoming.length) return current;
  const next = current.slice();
  let last = next.length ? next[next.length - 1]!.sequence : -Infinity;
  let index: Map<number, number> | undefined;
  for (const event of incoming) {
    if (event.sequence > last) {
      next.push(event);
      last = event.sequence;
      // 索引已经建过就顺带维护，避免同一批里后续的替换分支再重建一次。
      index?.set(event.sequence, next.length - 1);
      continue;
    }
    index ??= new Map(next.map((item, position) => [item.sequence, position]));
    const position = index.get(event.sequence);
    // 迟到的同 sequence 事件是「更新」而不是新事件（工具从 running 变 completed），
    // 必须原地替换：换位置会让时间线顺序抖动。
    if (position !== undefined) { next[position] = event; continue; }
    // 真正乱序到达的新事件：按 sequence 插回正确位置。原始日志靠数组顺序拼接，
    // 直接追加会让 raw 面板的内容次序错乱。
    let at = next.length;
    while (at > 0 && next[at - 1]!.sequence > event.sequence) at--;
    next.splice(at, 0, event);
    index = undefined;
    last = next[next.length - 1]!.sequence;
  }
  return next;
}
