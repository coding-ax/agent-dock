import { readFile, readdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { AgentDockRuntime } from '@agent-dock/agent-dock-runtime';

type AcpxRecord = {
  acp_session_id?: unknown;
  backendSessionId?: unknown;
  agentSessionId?: unknown;
  acpx?: { backendSessionId?: unknown } | null;
};

/**
 * 收集「AgentDock 自己发起过的 ACP 后端会话 id」。
 *
 * 导入外部会话时要把这些排除掉：AgentDock 建过的会话（导入接管、模型探测、一次性任务）
 * 都会出现在 Agent 自己的 session/list 里，列出来只会让用户重复导入自己已有的东西。
 *
 * acpx 的持久化记录按 cwd 分目录（`<cwd>/.agentdock/acpx/sessions`），所以要把
 * home、所有 AgentDock 会话的 cwd、所有 Agent 的 cwd 三处都扫一遍；单个目录/记录读失败
 * 只跳过它，不影响其余结果。
 */
export async function collectAgentDockOwnedSessionIds(runtime: AgentDockRuntime): Promise<Set<string>> {
  const dirs = new Set<string>([join(homedir(), '.agentdock', 'acpx', 'sessions')]);
  try {
    for (const session of await runtime.listSessions()) if (session.cwd) dirs.add(join(session.cwd, '.agentdock', 'acpx', 'sessions'));
  } catch { /* 会话列举失败就退化为只扫 home */ }
  try {
    for (const agent of await runtime.listAgents()) if (agent.cwd) dirs.add(join(agent.cwd, '.agentdock', 'acpx', 'sessions'));
  } catch { /* Agent 列举失败同样只跳过这一路 */ }

  const ids = new Set<string>();
  for (const dir of dirs) {
    let entries: string[];
    try { entries = await readdir(dir); } catch { continue; }
    for (const entry of entries) {
      if (!entry.endsWith('.json')) continue;
      try {
        const record = JSON.parse(await readFile(join(dir, entry), 'utf8')) as AcpxRecord;
        const id = record.acp_session_id ?? record.acpx?.backendSessionId ?? record.backendSessionId ?? record.agentSessionId;
        if (typeof id === 'string' && id.trim()) ids.add(id.trim());
      } catch { /* 单条记录损坏不影响其它 */ }
    }
  }
  return ids;
}
