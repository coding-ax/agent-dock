import type { AgentEvent, Session, TaskRecord } from '@agent-dock/agent-dock-shared';

/**
 * 把会话事件流渲染成给「人/侧边会话里的 agent」读的纯文本转录，边迭代边写进 `write`。
 *
 * 纯函数、不碰 DB：CLI（session show）和单测都复用它。
 * 刻意省略 thinking token 流（量极大且是内部推理），只保留用户/助手文本、
 * 工具调用一行摘要、错误与警告——这是另一个 agent 接续任务真正需要的信息。
 *
 * 空行与末尾空白先攒着不写（`tail`），后面真有内容才落笔——等价于整份输出末尾的 trimEnd，
 * 而流式是没法反悔的，只能把决定推后。
 */
export function writeTranscript(events: Iterable<AgentEvent>, write: (chunk: string) => void): void {
  let tail = '';
  let wrote = false;
  const put = (chunk: string) => {
    const end = chunk.replace(/\s+$/, '');
    if (end) {
      if (tail) { write(tail); tail = ''; }
      write(end);
      wrote = true;
      tail = chunk.slice(end.length);
    } else tail += chunk;
  };
  // 同一角色相邻的 text 事件是 token 流落库后的碎片（合并逻辑原本只在 web 端
  // buildTimeline 里做），转录必须自己拼回整段，否则输出几十上百个「### 助手」。
  let pending: { speaker: string; parts: string[] } | undefined;
  const flush = () => {
    if (!pending) return;
    const text = pending.parts.join('').trim();
    if (text) {
      put(`### ${pending.speaker}\n`);
      put(`${text}\n`);
      put('\n');
    }
    pending = undefined;
  };
  for (const event of events) {
    const data = (event.data ?? {}) as Record<string, unknown>;
    if (event.type === 'text') {
      const text = typeof data.text === 'string' ? data.text : '';
      const speaker = data.role === 'user' ? '用户' : '助手';
      if (!pending || pending.speaker !== speaker) { flush(); pending = { speaker, parts: [] }; }
      pending.parts.push(text);
    } else {
      flush();
      if (event.type === 'tool_call' || event.type === 'tool_result') {
        const name = typeof data.name === 'string' ? data.name : '工具';
        const status = typeof data.status === 'string' ? `（${data.status}）` : '';
        put(`- 工具调用：${name}${status}\n`);
      } else if (event.type === 'error') {
        const text = typeof data.message === 'string' ? data.message : '';
        if (text) put(`> 错误：${text.replaceAll('\n', ' ')}\n`);
      }
    }
  }
  flush();
  if (wrote) write('\n');
}

/** 字符串形式：单测与需要整份文本的调用方用。参数是迭代器，所以这里也不物化事件。 */
export function formatTranscript(events: Iterable<AgentEvent>): string {
  const chunks: string[] = [];
  writeTranscript(events, chunk => { chunks.push(chunk); });
  return chunks.join('');
}

export interface SessionSummary {
  id: string;
  agentId: string;
  state: string;
  cwd: string;
  updatedAt: string;
}

export function formatSessionList(sessions: SessionSummary[]): string {
  if (!sessions.length) return '暂无会话。\n';
  return sessions.map(session =>
    `${session.id}  [${session.state}]  agent=${session.agentId}  cwd=${session.cwd}  updated=${session.updatedAt}`
  ).join('\n') + '\n';
}

export function sessionHeader(session: Session, tasks: TaskRecord[]): string {
  const taskLines = tasks.map(task => `- 任务 ${task.id} [${task.status}] ${task.prompt.replaceAll('\n', ' ').slice(0, 200)}`);
  return [
    `会话：${session.id}`,
    `Agent：${session.agentId}${session.model ? `（模型 ${session.model}）` : ''}`,
    `工作目录：${session.cwd}`,
    `状态：${session.state}`,
    `创建：${session.createdAt}`,
    ...(tasks.length ? [`任务：`, ...taskLines] : [])
  ].join('\n') + '\n';
}
