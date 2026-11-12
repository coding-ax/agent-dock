import { appendFileSync } from 'node:fs';
import readline from 'node:readline';

/**
 * 沙箱回归用的最小 ACP stub：它只验证 AgentDock 实际发给 Agent 的那段文本。
 * 有 <agentdock-superagent> 时第一条动作是 agent-dock task start；没有时不动工具。
 * 这不是模型能力测试，而是 prompt 注入链路的确定性回归。
 */
const logPath = process.env.delegation_probe_log;
const rl = readline.createInterface({ input: process.stdin });
const send = message => process.stdout.write(`${JSON.stringify(message)}\n`);
const sessions = new Set();

const log = entry => {
  if (logPath) appendFileSync(logPath, `${JSON.stringify(entry)}\n`);
};

rl.on('line', line => {
  let message;
  try { message = JSON.parse(line); } catch { return; }
  const { id, method, params = {} } = message;

  if (method === 'initialize') {
    return send({
      jsonrpc: '2.0',
      id,
      result: {
        protocolVersion: params.protocolVersion,
        agentCapabilities: { loadSession: true, promptCapabilities: { image: false, audio: false, embeddedContext: false } },
        authMethods: [],
        agentInfo: { name: 'AgentDock Delegation Probe', version: '1.0.0' }
      }
    });
  }
  if (method === 'session/new') {
    const sessionId = `probe-${Date.now()}`;
    sessions.add(sessionId);
    return send({ jsonrpc: '2.0', id, result: { sessionId } });
  }
  if (method === 'session/load' || method === 'session/resume') {
    sessions.add(params.sessionId);
    return send({ jsonrpc: '2.0', id, result: {} });
  }
  if (method === 'session/set_mode') return send({ jsonrpc: '2.0', id, result: {} });
  if (method === 'session/cancel') return;
  if (method !== 'session/prompt') {
    if (id !== undefined) send({ jsonrpc: '2.0', id, error: { code: -32601, message: `Unsupported method ${method}` } });
    return;
  }

  const prompt = (params.prompt ?? []).map(part => part.text ?? '').join('');
  const hasDirective = prompt.includes('<agentdock-superagent>');
  log({ prompt, hasDirective });

  if (hasDirective) {
    send({
      jsonrpc: '2.0',
      method: 'session/update',
      params: {
        sessionId: params.sessionId,
        update: {
          sessionUpdate: 'tool_call',
          toolCallId: 'delegation-probe-task-start',
          title: 'agent-dock task start --title "沙箱回归" --done-when "第一条动作是派活"',
          kind: 'execute',
          status: 'in_progress',
          rawInput: { command: 'agent-dock task start --title "沙箱回归" --done-when "第一条动作是派活"' },
          content: [],
          locations: []
        }
      }
    });
    send({
      jsonrpc: '2.0',
      method: 'session/update',
      params: {
        sessionId: params.sessionId,
        update: { sessionUpdate: 'tool_call_update', toolCallId: 'delegation-probe-task-start', status: 'completed', rawOutput: { ok: true }, content: [] }
      }
    });
    send({
      jsonrpc: '2.0',
      method: 'session/update',
      params: { sessionId: params.sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'delegated' } } }
    });
  } else {
    send({
      jsonrpc: '2.0',
      method: 'session/update',
      params: { sessionId: params.sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'noop' } } }
    });
  }
  return send({ jsonrpc: '2.0', id, result: { stopReason: 'end_turn' } });
});
