import { describe, expect, it } from 'vitest';
import type { AgentEvent } from '@agent-dock/agent-dock-shared';
import { formatSessionList, formatTranscript, sessionHeader, writeTranscript } from './session-cli-format.js';

const event = (overrides: Partial<AgentEvent> & Pick<AgentEvent, 'type'>): AgentEvent => ({
  id: `evt-${Math.random()}`,
  sessionId: 'ses_1',
  sequence: 0,
  timestamp: '2026-09-17T00:00:00.000Z',
  data: {},
  ...overrides
});

describe('session-cli transcript formatting', () => {
  it('renders user and assistant text as labelled blocks', () => {
    const text = formatTranscript([
      event({ sequence: 1, type: 'text', data: { text: 'hello', role: 'user' } }),
      event({ sequence: 2, type: 'text', data: { text: 'hi there', role: 'assistant' } })
    ]);
    expect(text).toContain('### 用户\nhello');
    expect(text).toContain('### 助手\nhi there');
  });

  it('labels injected supervision turns as a system round, not a user message', () => {
    const text = formatTranscript([
      event({ sequence: 1, type: 'text', data: { text: '📋 督办 · 1 个事项有变化', role: 'user', origin: 'injected' } }),
      event({ sequence: 2, type: 'text', data: { text: '我先看下事项状态。', role: 'assistant' } })
    ]);
    expect(text).toContain('### 系统 · 自动轮次\n📋 督办 · 1 个事项有变化');
    expect(text).toContain('### 助手\n我先看下事项状态。');
    expect(text).not.toContain('### 用户');
  });

  it('labels maintenance and handoff turns as system rounds too', () => {
    const text = formatTranscript([
      event({ sequence: 1, type: 'text', data: { text: '以下是 daemon 发起的整理轮次（amaint_1）', role: 'user', origin: 'maintenance' } }),
      event({ sequence: 2, type: 'text', data: { text: '🐾 交接说明 · 第 2 代豆豆接班', role: 'user', origin: 'handoff' } })
    ]);
    expect(text).toContain('### 系统 · 整理轮次\n以下是 daemon 发起的整理轮次（amaint_1）');
    expect(text).toContain('### 系统 · 交接说明\n🐾 交接说明 · 第 2 代豆豆接班');
    expect(text).not.toContain('### 用户');
  });

  it('omits token-level thinking noise but keeps tool/status one-liners and errors', () => {
    const text = formatTranscript([
      event({ sequence: 1, type: 'thinking', data: { text: 'x'.repeat(1000) } }),
      event({ sequence: 2, type: 'tool_call', data: { name: 'bash', status: 'running' } }),
      event({ sequence: 3, type: 'tool_result', data: { name: 'bash', status: 'completed' } }),
      event({ sequence: 4, type: 'error', data: { message: 'boom' } })    ]);
    expect(text).not.toContain('xxx');
    expect(text).toContain('- 工具调用：bash（running）');
    expect(text).toContain('- 工具调用：bash（completed）');
    expect(text).toContain('> 错误：boom');
  });

  it('skips empty text events and trims trailing whitespace', () => {
    expect(formatTranscript([event({ type: 'text', data: { text: '   ', role: 'assistant' } })])).toBe('');
  });

  it('上一轮起在后台的进程推送不写进转录，也不把回答切成几段', () => {
    const carried = (sequence: number) => event({ sequence, type: 'tool_call', data: { id: 'bg-server', name: 'tool call', status: 'in_progress', carriedOver: true } });
    const text = formatTranscript([
      event({ sequence: 1, type: 'text', data: { text: '现在怎么处理噪声', role: 'user' } }),
      carried(2),
      event({ sequence: 3, type: 'text', data: { text: '现在的情况：', role: 'assistant' } }),
      carried(4),
      event({ sequence: 5, type: 'text', data: { text: '还没做噪声处理。', role: 'assistant' } })
    ]);
    expect(text.trimEnd()).toBe('### 用户\n现在怎么处理噪声\n\n### 助手\n现在的情况：还没做噪声处理。');
  });

  // 流式路径是 `agent-dock session show` 的默认路径（转录可百万行，不能先拼成字符串）。
  // 它必须和字符串形式逐字节一致——尤其是块之间那个空行和末尾的换行，否则 piping/重定向
  // 出来的转录会悄悄变样。这里不靠肉眼：同一条事件流两种走法直接比。
  it('streams byte-identical output to the string form', () => {
    const events: AgentEvent[] = [
      event({ sequence: 1, type: 'text', data: { text: '帮我 ', role: 'user' } }),
      event({ sequence: 2, type: 'text', data: { text: '看下这个 bug', role: 'user' } }),
      event({ sequence: 3, type: 'thinking', data: { text: 'x'.repeat(500) } }),
      event({ sequence: 4, type: 'text', data: { text: '好', role: 'assistant' } }),
      event({ sequence: 5, type: 'tool_call', data: { name: 'bash', status: 'running' } }),
      event({ sequence: 6, type: 'tool_result', data: { name: 'bash', status: 'completed' } }),
      event({ sequence: 7, type: 'error', data: { message: 'boom\n第二行' } }),
      event({ sequence: 8, type: 'text', data: { text: '结论', role: 'assistant' } })
    ];
    const whole = formatTranscript(events);
    const chunks: string[] = [];
    writeTranscript(events, chunk => { chunks.push(chunk); });
    expect(chunks.length).toBeGreaterThan(3);
    expect(chunks.join('')).toBe(whole);
    // 追问一次：末尾不该留在 write 之外（说好写出来的必须真写出来）。
    expect(whole.endsWith('结论\n')).toBe(true);
    expect(formatTranscript(events)).not.toContain('xxx');
  });

  it('writes nothing at all for a stream with no renderable content', () => {
    const chunks: string[] = [];
    writeTranscript([event({ type: 'thinking', data: { text: 'noise' } })], chunk => { chunks.push(chunk); });
    expect(chunks.join('')).toBe('');
  });

  it('lists sessions one per line with stable fields', () => {
    const output = formatSessionList([
      { id: 'ses_1', agentId: 'claude', state: 'idle', cwd: '/tmp/a', updatedAt: '2026-09-17T00:00:00Z' },
      { id: 'ses_2', agentId: 'codex', state: 'running_tool', cwd: '/tmp/b', updatedAt: '2026-09-17T01:00:00Z' }
    ]);
    expect(output).toContain('ses_1  [idle]  agent=claude  cwd=/tmp/a');
    expect(output).toContain('ses_2  [running_tool]  agent=codex  cwd=/tmp/b');
    expect(formatSessionList([])).toBe('暂无会话。\n');
  });

  it('renders a session header with model and tasks', () => {
    const header = sessionHeader(
      { id: 'ses_1', agentId: 'claude', state: 'completed', cwd: '/tmp/a', model: 'opus', runId: 'run_1', createdAt: '2026-09-17T00:00:00Z', updatedAt: '2026-09-17T00:01:00Z' },
      [
        { id: 'task_1', sessionId: 'ses_1', prompt: 'fix the bug', status: 'completed', createdAt: '', updatedAt: '' },
        { id: 'task_2', sessionId: 'ses_1', prompt: '📋 督办 · 1 个事项有变化', status: 'completed', origin: 'injected', createdAt: '', updatedAt: '' }
      ]
    );
    expect(header).toContain('会话：ses_1');
    expect(header).toContain('模型 opus');
    expect(header).toContain('- 任务 task_1 [completed] fix the bug');
    expect(header).toContain('- 任务 task_2 [completed] [系统注入] 📋 督办 · 1 个事项有变化');
    expect(header).not.toContain('- 任务 task_1 [completed] [系统注入]');
  });
});
