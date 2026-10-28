import { appendFileSync } from 'node:fs';
import readline from 'node:readline';

const rl = readline.createInterface({ input: process.stdin });
const send = message => process.stdout.write(`${JSON.stringify(message)}\n`);
const sessions = new Set();
let currentModeId = 'agent';
const modes = () => ({ currentModeId, availableModes: ['agent', 'read-only', 'agent-full-access'].map(id => ({ id, name: id })) });
const pending = new Map();
const request = (method, params) => new Promise(resolve => { const id = `mock-request-${Date.now()}`; pending.set(id, resolve); send({ jsonrpc: '2.0', id, method, params }); });

rl.on('line', async line => {
  let message;
  try { message = JSON.parse(line); } catch { return; }
  const { id, method, params = {} } = message;
  if (process.env.mock_request_log && method) appendFileSync(process.env.mock_request_log, JSON.stringify({ method, params }) + '\n');
  if (!method && pending.has(id)) { pending.get(id)(message.result); pending.delete(id); return; }
  if (method === 'initialize') {
    return send({ jsonrpc: '2.0', id, result: { protocolVersion: params.protocolVersion, agentCapabilities: { loadSession: true, promptCapabilities: { image: false, audio: false, embeddedContext: false } }, authMethods: [], agentInfo: { name: 'AgentDock Mock ACP', version: '1.0.0' } } });
  }
  if (method === 'session/new') {
    const sessionId = `mock-${Date.now()}`; sessions.add(sessionId);
    return send({ jsonrpc: '2.0', id, result: { sessionId, modes: modes() } });
  }
  if (method === 'session/load' || method === 'session/resume') {
    if (process.env.mock_acp_reject_unknown_load === '1' && !sessions.has(params.sessionId)) return send({ jsonrpc: '2.0', id, error: { code: -32602, message: `Resource not found: ${params.sessionId}` } });
    sessions.add(params.sessionId); return send({ jsonrpc: '2.0', id, result: { modes: modes() } });
  }
  if (method === 'session/set_mode') {
    if (process.env.mock_reject_mode === '1') return send({ jsonrpc: '2.0', id, error: { code: -32602, message: 'Mode rejected' } });
    currentModeId = params.modeId;
    return send({ jsonrpc: '2.0', id, result: {} });
  }
  if (method === 'session/prompt') {
    const prompt = (params.prompt ?? []).map(p => p.text ?? '').join('');
    // 真 adapter（codex / claude）会在会话里推 session_info_update 给会话起名字。
    // 这里用环境变量模拟，好让「Agent 给的标题能不能一路走到 AgentDock」可测——
    // acpx 会把它落进会话记录，但不会放进运行时事件，所以链路只能这样验。
    if (process.env.mock_acp_session_title) {
      send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: params.sessionId, update: { sessionUpdate: 'session_info_update', title: process.env.mock_acp_session_title } } });
    }
    if (prompt === 'inspect test environment') {
      const keys = ['AGENTDOCK_TEST_UPPER', 'AgentDock_Test_Mixed', 'agentdock_test_lower'];
      send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: params.sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: JSON.stringify(Object.fromEntries(keys.map(key => [key, process.env[key]]))) } } } });
      return send({ jsonrpc: '2.0', id, result: { stopReason: 'end_turn' } });
    }
    if (prompt.includes('crash')) process.exit(17);
    if (prompt.includes('permission')) {
      const decision = await request('session/request_permission', { sessionId: params.sessionId, toolCall: { title: 'Edit a file', kind: 'edit', status: 'pending', toolCallId: 'permission-tool', content: [], locations: [] }, options: [{ kind: 'allow_once', name: 'Allow', optionId: 'allow' }, { kind: 'reject_once', name: 'Deny', optionId: 'deny' }] });
      send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: params.sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: `Permission: ${decision.outcome.outcome}` } } } });
      return send({ jsonrpc: '2.0', id, result: { stopReason: 'end_turn' } });
    }
    if (prompt.includes('active longer than timeout')) {
      for (let index = 1; index <= 3; index++) {
        await new Promise(resolve => setTimeout(resolve, 1_100));
        send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: params.sessionId, update: { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: `heartbeat ${index}` } } } });
      }
      send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: params.sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'long task completed' } } } });
      return send({ jsonrpc: '2.0', id, result: { stopReason: 'end_turn' } });
    }
    const toolCallId = 'mock-tool-1';
    send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: params.sessionId, update: { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'Considering the request' } } } });
    send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: params.sessionId, update: { sessionUpdate: 'tool_call', toolCallId, title: 'Inspect workspace', kind: 'read', status: 'in_progress', rawInput: { path: '.' }, content: [], locations: [] } } });
    send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: params.sessionId, update: { sessionUpdate: 'tool_call_update', toolCallId, status: 'completed', rawOutput: { files: [] }, content: [] } } });
    send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: params.sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: `Mock reply: ${prompt}${process.env.mock_echo_mode === '1' ? ' mode=' + currentModeId : ''}` } } } });
    return send({ jsonrpc: '2.0', id, result: { stopReason: 'end_turn' } });
  }
  if (method === 'session/cancel') return;
  if (id !== undefined) send({ jsonrpc: '2.0', id, error: { code: -32601, message: `Unsupported method ${method}` } });
});
