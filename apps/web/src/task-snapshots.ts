import type { Task } from './api';

/**
 * 任务快照合并。
 *
 * 任务的 `updatedAt` 由服务端在每次状态写入时递增，所以同一个 id 的两份快照里
 * 时间更早的那份一定是旧的。SSE 的 task 事件和 2 秒一次的 tasks 轮询是两条独立
 * 通道：轮询请求可能先发出、后返回，把已经切成 running 的任务又写回 queued。
 * 用户看到的就是「上面在跑，下面还显示排队中」。
 *
 * 这里只做一件事：同一任务以较新的快照为准；已离开 queued 的任务不接受回退。
 * 后续轮询带回更新（例如漏掉 SSE task 事件后补上 running）仍然照常前进。
 */
export function preferNewerTask(previous: Task, incoming: Task): Task {
  if (previous.id !== incoming.id) return incoming;
  if (incoming.updatedAt < previous.updatedAt) return previous;
  // updatedAt 相同或缺失时，状态也不许从非 queued 退回 queued：同一个任务 id 不会重新入队。
  if (incoming.status === 'queued' && previous.status !== 'queued') return previous;
  return incoming;
}

/** 用一条新快照更新任务列表；没有变化时返回原数组，避免 React 白白重渲染。 */
export function upsertTask(previous: Task[] | undefined, task: Task): Task[] {
  const list = previous ?? [];
  const index = list.findIndex(item => item.id === task.id);
  if (index < 0) return [...list, task];
  const existing = list[index]!;
  const next = preferNewerTask(existing, task);
  if (next === existing) return list;
  const copy = [...list];
  copy[index] = next;
  return copy;
}

/** 全量快照（tasks 轮询）按 id 合并：旧快照不能把已经前进的状态写回去。 */
export function mergeTaskSnapshots(previous: Task[] | undefined, incoming: Task[]): Task[] {
  if (!previous?.length) return incoming;
  const byId = new Map(previous.map(task => [task.id, task]));
  let changed = false;
  const merged = incoming.map(task => {
    const existing = byId.get(task.id);
    if (!existing) return task;
    const next = preferNewerTask(existing, task);
    if (next !== task) changed = true;
    return next;
  });
  return changed ? merged : incoming;
}

/**
 * 拉取一次任务全量快照并合并。
 *
 * `read` 必须在响应回来之后才调用：请求飞行期间 SSE 可能已经把任务推到 running，
 * 用发起请求时的旧缓存做基准，仍会把 running 写回 queued。
 */
export async function fetchTaskSnapshot(read: () => Task[] | undefined, fetcher: () => Promise<Task[]>): Promise<Task[]> {
  const incoming = await fetcher();
  return mergeTaskSnapshots(read(), incoming);
}
