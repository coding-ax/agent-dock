import { readDaemonStatus } from './daemon.js';

/**
 * 自杀保护：AgentDock 托管的 Agent（环境里有 agentdock_session_id）在当前轮次里重启/停止/升级
 * 正在服务它的 daemon，会把自己所在的 ACP 进程一起带走：本轮结果丢失，任务被标成 interrupted。
 *
 * 只拦「目标 daemon 就是自己所在的那一个」：沙箱（agent-dock dev）用独立 HOME 与数据库，
 * 操作它不受影响。用户在自己的终端里没有 agentdock_session_id，也不受影响。
 * 确实要硬来（比如用户明确要求）可设 AGENTDOCK_ALLOW_SELF_RESTART=1。
 */
export const ALLOW_SELF_RESTART_ENV = 'AGENTDOCK_ALLOW_SELF_RESTART';

export type SelfRestartAction = 'restart' | 'stop' | 'update';

export interface SelfRestartContext {
  env: NodeJS.ProcessEnv;
  /** 当前命令将要操作的 daemon 的数据库路径；daemon 没在跑时为空。 */
  targetDatabase?: string;
  /** Agent 所在 daemon 的数据库路径（由 runtime 注入 agentdock_database）。 */
  ownDatabase?: string;
}

export function selfRestartBlockReason(action: SelfRestartAction, context: SelfRestartContext): string | undefined {
  const sessionId = context.env.agentdock_session_id?.trim();
  if (!sessionId) return undefined;
  if (['1', 'true', 'yes'].includes((context.env[ALLOW_SELF_RESTART_ENV] ?? '').trim().toLowerCase())) return undefined;
  // 已知自己所在的库且和目标不同：在操作别的实例（沙箱等），放行。拿不准时保守拦下。
  if (context.ownDatabase && context.targetDatabase && context.ownDatabase !== context.targetDatabase) return undefined;
  if (!context.targetDatabase && action !== 'update') return undefined;
  const verb = action === 'update' ? '升级并重启' : action === 'stop' ? '停止' : '重启';
  return [
    `已拦截：你正运行在 AgentDock 会话 ${sessionId} 里，${verb}这个 daemon 会把当前 Agent 进程一起杀掉，本轮结果会丢失。`,
    '- 验证改动：用 `agent-dock dev up` 起一个隔离的沙箱实例，`agent-dock dev run -- <命令>` 在里面跑，`agent-dock dev down` 清理。',
    '- 确实要升级正在使用的实例：告诉用户在自己的终端里执行，或用户明确同意后设 ' + `${ALLOW_SELF_RESTART_ENV}=1 再执行。`
  ].join('\n');
}

/** 读取目标 daemon 的数据库路径；没在跑或状态文件缺失时返回 undefined。 */
export function targetDaemonDatabase(dir: string): string | undefined {
  const state = readDaemonStatus(dir);
  return state?.ready ? state.database : undefined;
}
