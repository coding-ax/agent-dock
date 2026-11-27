import { basename } from 'node:path';
import type {
  BoardColumnColor,
  BoardColumnRule,
  BoardDropAction,
  BoardEntityKind,
  BoardTaskRuleState,
  Session,
  SessionState
} from '@agent-dock/agent-dock-shared';
import type { AssistantTask } from '../assistant/types.js';

export interface ColumnSeedSpec {
  name: string;
  color: BoardColumnColor;
  collapsed?: boolean;
  wipLimit?: number | null;
  rule?: BoardColumnRule | null;
  onDropAction?: BoardDropAction;
}

/**
 * 开箱默认「运行状态」看板的 4 列智能规则：
 * - 需要你：waiting_for_permission / needs_user / plan 待确认 / 失败异常
 * - 进行中：running 便签 + starting/thinking/running_tool/interrupting 会话（拖入计划卡自动开工）
 * - 待验收：已汇报 done 等主小猫验收的便签
 * - 近期完成：已验收/取消的便签与已结束的普通会话（默认限最近 24 条防噪音）
 */
export const DEFAULT_STATUS_COLUMNS: readonly ColumnSeedSpec[] = [
  {
    name: '需要你',
    color: 'orange',
    rule: {
      entityKinds: ['task', 'session'],
      taskStates: ['needs_user', 'plan'],
      sessionStates: ['waiting_for_permission', 'failed']
    },
    onDropAction: 'none'
  },
  {
    name: '进行中',
    color: 'blue',
    wipLimit: 8,
    rule: {
      entityKinds: ['task', 'session'],
      taskStates: ['running'],
      sessionStates: ['starting', 'thinking', 'running_tool', 'interrupting']
    },
    onDropAction: 'start_plan'
  },
  {
    name: '待验收',
    color: 'sky',
    rule: {
      entityKinds: ['task'],
      taskStates: ['review']
    },
    onDropAction: 'none'
  },
  {
    name: '近期完成',
    color: 'emerald',
    rule: {
      entityKinds: ['task', 'session'],
      taskStates: ['closed'],
      sessionStates: ['completed', 'idle', 'stopped', 'interrupted'],
      maxItems: 24
    },
    onDropAction: 'none'
  }
];

export const DEFAULT_BLANK_COLUMNS: readonly ColumnSeedSpec[] = [
  { name: '重点盯盘', color: 'blue', rule: null, onDropAction: 'none' },
  { name: '推进中', color: 'amber', rule: null, onDropAction: 'none' },
  { name: '已完成 / 暂存', color: 'emerald', rule: null, onDropAction: 'none' }
];

export function buildProjectTemplateColumns(cwds: string[]): ColumnSeedSpec[] {
  const palette: BoardColumnColor[] = ['blue', 'sky', 'amber', 'emerald', 'orange'];
  const unique = [...new Set(cwds.map(item => item.trim()).filter(Boolean))].slice(0, 5);
  const cols: ColumnSeedSpec[] = unique.map((cwd, index) => ({
    name: basename(cwd) || cwd,
    color: palette[index % palette.length]!,
    rule: {
      entityKinds: ['task', 'session'],
      cwdContains: cwd,
      maxItems: 20
    },
    onDropAction: 'none'
  }));
  cols.push({ name: '自由关注', color: 'zinc', rule: null, onDropAction: 'none' });
  return cols;
}

export interface RuleCandidate {
  entityKind: 'task' | 'session';
  task?: AssistantTask;
  session?: Session;
}

export function effectiveTaskRuleState(task: AssistantTask): BoardTaskRuleState {
  if (task.state === 'closed') return 'closed';
  if (task.plan) return 'plan';
  return task.state;
}

/** 判定一条任务或普通会话是否命中某智能规则列。 */
export function matchesColumnRule(rule: BoardColumnRule, candidate: RuleCandidate): boolean {
  const allowedKinds: Array<'task' | 'session'> = rule.entityKinds?.length ? rule.entityKinds : ['task', 'session'];
  if (!allowedKinds.includes(candidate.entityKind)) return false;

  const task = candidate.task;
  const session = candidate.session;
  const archived = Boolean(task?.archivedAt || session?.archivedAt);
  if (archived && !rule.includeArchived) return false;

  if (rule.agentIds?.length) {
    const agentId = task?.agentId ?? session?.agentId;
    if (!agentId || !rule.agentIds.includes(agentId)) return false;
  }

  if (rule.cwdContains?.trim()) {
    const cwd = (task?.cwd ?? session?.cwd ?? '').toLowerCase();
    if (!cwd.includes(rule.cwdContains.trim().toLowerCase())) return false;
  }

  if (rule.source?.trim()) {
    const src = session?.source ?? (task ? 'assistant-task' : 'local');
    if (rule.source === 'local') {
      if (src === 'lark') return false;
    } else if (src !== rule.source) {
      return false;
    }
  }

  if (candidate.entityKind === 'task' && task) {
    // 便签若其关联会话正在等权限审批，即使 task.state 还是 running，也优先落入需要你/待审批列。
    if (session?.state === 'waiting_for_permission' && rule.sessionStates?.includes('waiting_for_permission')) {
      return true;
    }
    if (session?.state === 'waiting_for_permission' && rule.taskStates?.length && !rule.taskStates.includes('needs_user') && !rule.sessionStates?.includes('waiting_for_permission')) {
      return false;
    }
    if (rule.taskStates?.length) {
      return rule.taskStates.includes(effectiveTaskRuleState(task));
    }
    if (rule.sessionStates?.length && session) {
      return rule.sessionStates.includes(session.state);
    }
    return true;
  }

  if (candidate.entityKind === 'session' && session) {
    if (rule.sessionStates?.length) {
      return rule.sessionStates.includes(session.state);
    }
    // 只配了 taskStates 的列不自动收入普通会话。
    if (rule.taskStates?.length) return false;
    return true;
  }

  return false;
}

const INTERNAL_SESSION_PREFIXES = ['lark-avatar', 'router', 'delegated'];

export function isInternalSession(session: Session): boolean {
  return Boolean(session.source && INTERNAL_SESSION_PREFIXES.some(prefix => session.source!.startsWith(prefix)));
}

export function virtualItemId(boardId: string, entityKind: BoardEntityKind, entityId: string): string {
  return `virt:${boardId}:${entityKind}:${entityId}`;
}

export function parseVirtualItemId(id: string): { boardId: string; entityKind: BoardEntityKind; entityId: string } | undefined {
  if (!id.startsWith('virt:')) return undefined;
  const parts = id.split(':');
  if (parts.length < 4) return undefined;
  const boardId = parts[1]!;
  const entityKind = parts[2] as BoardEntityKind;
  const entityId = parts.slice(3).join(':');
  if (!boardId || !entityId || (entityKind !== 'task' && entityKind !== 'session' && entityKind !== 'note')) return undefined;
  return { boardId, entityKind, entityId };
}

/**
 * 服务端轻量单行工具步摘要（与前端 tool-presentation.ts 语义一致，
 * 让看板卡片和 `agent-dock board show --watch` 无需全量回放事件就能显示此刻正在做什么）。
 */
export function summarizeToolActivity(toolName?: string, toolInput?: unknown): string | undefined {
  const rawName = toolName?.trim();
  if (!rawName) return undefined;
  const lower = rawName.toLowerCase();
  const input = toolInput && typeof toolInput === 'object' && !Array.isArray(toolInput)
    ? toolInput as Record<string, unknown>
    : undefined;
  const pickStr = (keys: string[]) => {
    if (!input) return undefined;
    for (const key of keys) {
      const val = input[key];
      if (typeof val === 'string' && val.trim()) return val.trim().replace(/\s+/g, ' ');
    }
    return undefined;
  };

  const cmd = pickStr(['CommandLine', 'command', 'cmd', 'script']);
  if (cmd || /(bash|shell|exec|terminal|run_command)/i.test(lower)) {
    const shortCmd = cmd ? (cmd.length > 56 ? `${cmd.slice(0, 55)}…` : cmd) : rawName;
    return `执行 ${shortCmd}`;
  }

  const filePath = pickStr(['Path', 'path', 'file_path', 'filePath', 'TargetFile', 'target']);
  const shortPath = filePath ? filePath.split('/').slice(-2).join('/') : undefined;
  if (/(read_file|view_file|read|cat)/i.test(lower)) {
    return shortPath ? `读取 ${shortPath}` : '读取文件';
  }
  if (/(edit_file|write_file|patch|replace|multi_replace|write)/i.test(lower)) {
    return shortPath ? `编辑 ${shortPath}` : '修改文件';
  }
  const query = pickStr(['query', 'Query', 'pattern', 'Pattern', 'url', 'Url']);
  if (/(grep|search|find|glob|web)/i.test(lower)) {
    const shortQ = query ? (query.length > 42 ? `${query.slice(0, 41)}…` : query) : undefined;
    return shortQ ? `检索 ${shortQ}` : `搜索 (${rawName})`;
  }
  if (/browser|ego/i.test(lower)) {
    return shortPath || query ? `浏览器 ${shortPath ?? query}` : '操作浏览器';
  }
  return shortPath ? `${rawName} · ${shortPath}` : `调用 ${rawName}`;
}

export function sessionStateFallbackActivity(state: SessionState, error?: string | null): string {
  switch (state) {
    case 'starting': return '正在启动 Agent…';
    case 'thinking': return '正在思考推演…';
    case 'running_tool': return '正在调用工具…';
    case 'waiting_for_permission': return '等待权限授权';
    case 'interrupting': return '正在停止当前轮次…';
    case 'interrupted': return '轮次已中断';
    case 'failed': return error?.trim() ? `异常：${error.trim().slice(0, 72)}` : '执行失败';
    case 'completed': return '本轮已完成';
    case 'stopped': return '会话已停止';
    case 'idle': return error?.trim() ? `异常：${error.trim().slice(0, 72)}` : '就绪待命';
    default: return '等待开始';
  }
}
