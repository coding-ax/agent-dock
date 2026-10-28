import { describe, expect, it, vi } from 'vitest';
import { createCliProgram, environmentFromCli } from './cli-program.js';

describe('AgentDock CLI', () => {
  it('maps explicit Commander options to runtime environment variables', () => {
    const program = createCliProgram('0.0.5');
    program.parse(['node', 'agent-dock', '--host', '127.0.0.1', '--port', '4400', '--cwd', '/tmp/project', '--database', '/tmp/dock.db', '--idle-timeout-ms', '1000', '--cleanup-interval-ms', '500', '--lark-app-id', 'cli_test', '--lark-agent-name', 'My Agent']);
    expect(environmentFromCli(program.opts(), { AGENTDOCK_PORT: '4310', KEEP_ME: 'yes' })).toMatchObject({
      AGENTDOCK_HOST: '127.0.0.1',
      AGENTDOCK_PORT: '4400',
      AGENTDOCK_DEFAULT_CWD: '/tmp/project',
      AGENTDOCK_DATABASE_URL: '/tmp/dock.db',
      AGENTDOCK_DRIVER_IDLE_TIMEOUT_MS: '1000',
      AGENTDOCK_CLEANUP_INTERVAL_MS: '500',
      LARK_APP_ID: 'cli_test',
      LARK_AGENT_NAME: 'My Agent',
      KEEP_ME: 'yes'
    });
  });

  it('does not overwrite environment values for omitted options', () => {
    const program = createCliProgram('0.0.5');
    program.parse(['node', 'agent-dock']);
    expect(environmentFromCli(program.opts(), { AGENTDOCK_HOST: '10.0.0.1' })).toEqual({ AGENTDOCK_HOST: '10.0.0.1' });
  });

  it('disables Lark listening for only the current process', () => {
    const program = createCliProgram('0.0.5');
    program.parse(['node', 'agent-dock', '--no-lark-listen']);
    expect(environmentFromCli(program.opts(), {})).toEqual({ AGENTDOCK_DISABLE_LARK_LISTENER: 'true' });
  });

  it('supports a semantic local-only startup option without requiring a raw host address', () => {
    const program = createCliProgram('0.0.5');
    program.parse(['node', 'agent-dock', '--local-only']);
    expect(environmentFromCli(program.opts(), {})).toEqual({ AGENTDOCK_LOCAL_ONLY: 'true' });
  });

  it('prints the installed version', () => {
    let output = '';
    const program = createCliProgram('0.0.5').exitOverride().configureOutput({ writeOut: value => { output += value; } });
    expect(() => program.parse(['node', 'agent-dock', '--version'])).toThrowError(expect.objectContaining({ code: 'commander.version', exitCode: 0 }));
    expect(output).toBe('0.0.5\n');
  });

  it('parses lark send card options', async () => {
    const larkSend = vi.fn();
    const program = createCliProgram('0.0.6', { larkSend });
    await program.parseAsync(['node', 'agent-dock', 'lark', 'send', '**done**', '--agent-name', 'My Agent', '--receive-id', 'user@example.com', '--receive-id-type', 'email', '--task-id', 'task-1', '--app-id', 'cli_test', '--read-only']);
    expect(larkSend).toHaveBeenCalledWith('**done**', expect.objectContaining({ agentName: 'My Agent', receiveId: 'user@example.com', receiveIdType: 'email', taskId: 'task-1', appId: 'cli_test', readOnly: true }));
  });

  it('requires a message id for lark update', async () => {
    const larkUpdate = vi.fn();
    const program = createCliProgram('0.0.6', { larkUpdate }).exitOverride();
    await expect(program.parseAsync(['node', 'agent-dock', 'lark', 'update', '**done**'])).rejects.toThrow();
    expect(larkUpdate).not.toHaveBeenCalled();
  });

  it('parses linked session discovery and control commands', async () => {
    const sessionPeers = vi.fn(); const sessionSend = vi.fn(); const sessionInterrupt = vi.fn(); const sessionCancel = vi.fn();
    await createCliProgram('0.0.6', { sessionPeers }).parseAsync(['node', 'agent-dock', 'session', 'peers', 'ses_main', '--json']);
    await createCliProgram('0.0.6', { sessionSend }).parseAsync(['node', 'agent-dock', 'session', 'send', 'ses_side', '请检查', '--from', 'ses_main', '--mode', 'interrupt']);
    await createCliProgram('0.0.6', { sessionInterrupt }).parseAsync(['node', 'agent-dock', 'session', 'interrupt', 'ses_side', '--from', 'ses_main']);
    await createCliProgram('0.0.6', { sessionCancel }).parseAsync(['node', 'agent-dock', 'session', 'cancel', 'ses_side', 'task_1', '--from', 'ses_main']);
    expect(sessionPeers).toHaveBeenCalledWith('ses_main', expect.objectContaining({ json: true }));
    expect(sessionSend).toHaveBeenCalledWith('ses_side', '请检查', expect.objectContaining({ from: 'ses_main', mode: 'interrupt' }));
    expect(sessionInterrupt).toHaveBeenCalledWith('ses_side', expect.objectContaining({ from: 'ses_main' }));
    expect(sessionCancel).toHaveBeenCalledWith('ses_side', 'task_1', expect.objectContaining({ from: 'ses_main' }));
  });

  it('parses a group chat recipient for lark send', async () => {
    const larkSend = vi.fn();
    const program = createCliProgram('0.0.6', { larkSend });
    await program.parseAsync(['node', 'agent-dock', 'lark', 'send', 'group update', '--chat-id', 'oc_group']);
    expect(larkSend).toHaveBeenCalledWith('group update', expect.objectContaining({ chatId: 'oc_group' }));
  });

  it('parses Agent group discovery, incremental reads, sends, and waits', async () => {
    const groupPeers = vi.fn(); const groupMembers = vi.fn(); const groupMessages = vi.fn(); const groupSend = vi.fn(); const groupWait = vi.fn();
    await createCliProgram('0.0.6', { groupPeers }).parseAsync(['node', 'agent-dock', 'group', 'peers']);
    await createCliProgram('0.0.6', { groupMembers }).parseAsync(['node', 'agent-dock', 'group', 'members']);
    await createCliProgram('0.0.6', { groupMessages }).parseAsync(['node', 'agent-dock', 'group', 'messages', '--after', 'cursor-1', '--limit', '8']);
    await createCliProgram('0.0.6', { groupSend }).parseAsync(['node', 'agent-dock', 'group', 'send', '请检查', '--to', 'cli_peer', '--reply-to', 'om_parent', '--in-thread', '--idempotency-key', 'handoff-1']);
    await createCliProgram('0.0.6', { groupWait }).parseAsync(['node', 'agent-dock', 'group', 'wait', '--after', 'cursor-2', '--timeout-ms', '30000']);
    expect(groupPeers).toHaveBeenCalledOnce();
    expect(groupMembers).toHaveBeenCalledOnce();
    expect(groupMessages).toHaveBeenCalledWith(expect.objectContaining({ after: 'cursor-1', limit: '8' }));
    expect(groupSend).toHaveBeenCalledWith('请检查', expect.objectContaining({ to: 'cli_peer', replyTo: 'om_parent', inThread: true, idempotencyKey: 'handoff-1' }));
    expect(groupWait).toHaveBeenCalledWith(expect.objectContaining({ after: 'cursor-2', timeoutMs: '30000' }));
  });

  it('parses the daemon start command with serve options', async () => {
    const daemonStart = vi.fn();
    const program = createCliProgram('0.0.6', { daemonStart });
    await program.parseAsync(['node', 'agent-dock', 'daemon', 'start', '--port', '4500', '--local-only', '--cwd', '/tmp/project']);
    expect(daemonStart).toHaveBeenCalledWith(expect.objectContaining({ port: '4500', localOnly: true, cwd: '/tmp/project' }));
    expect(environmentFromCli(daemonStart.mock.calls[0]![0]!, {})).toMatchObject({ AGENTDOCK_PORT: '4500', AGENTDOCK_DEFAULT_CWD: '/tmp/project' });
  });

  it('parses daemon stop, restart, and status commands', async () => {
    const daemonStop = vi.fn(); const daemonRestart = vi.fn(); const daemonStatus = vi.fn();
    await createCliProgram('0.0.6', { daemonStop }).parseAsync(['node', 'agent-dock', 'daemon', 'stop']);
    await createCliProgram('0.0.6', { daemonRestart }).parseAsync(['node', 'agent-dock', 'daemon', 'restart', '--port', '4600']);
    await createCliProgram('0.0.6', { daemonStatus }).parseAsync(['node', 'agent-dock', 'daemon', 'status']);
    expect(daemonStop).toHaveBeenCalledOnce();
    expect(daemonRestart).toHaveBeenCalledWith(expect.objectContaining({ port: '4600' }));
    expect(daemonStatus).toHaveBeenCalledOnce();
    expect(daemonStatus).toHaveBeenCalledWith({});
  });

  it('supports the top-level start/stop/restart/status forms and keeps default serve', async () => {
    const serve = vi.fn(); const daemonStart = vi.fn(); const daemonStop = vi.fn(); const daemonRestart = vi.fn(); const daemonStatus = vi.fn();
    await createCliProgram('0.0.6', { serve }).parseAsync(['node', 'agent-dock']);
    await createCliProgram('0.0.6', { daemonStart }).parseAsync(['node', 'agent-dock', 'start', '--port', '4500', '--local-only']);
    await createCliProgram('0.0.6', { daemonStop }).parseAsync(['node', 'agent-dock', 'stop']);
    await createCliProgram('0.0.6', { daemonRestart }).parseAsync(['node', 'agent-dock', 'restart', '--port', '4600']);
    await createCliProgram('0.0.6', { daemonStatus }).parseAsync(['node', 'agent-dock', 'status']);
    expect(serve).toHaveBeenCalledOnce();
    expect(daemonStart).toHaveBeenCalledWith(expect.objectContaining({ port: '4500', localOnly: true }));
    expect(daemonStop).toHaveBeenCalledOnce();
    expect(daemonRestart).toHaveBeenCalledWith(expect.objectContaining({ port: '4600' }));
    expect(daemonStatus).toHaveBeenCalledOnce();
    expect(daemonStatus).toHaveBeenCalledWith({});
  });

  it('supports JSON status for both command forms', async () => {
    const daemonStatus = vi.fn();
    await createCliProgram('0.0.6', { daemonStatus }).parseAsync(['node', 'agent-dock', 'status', '--json']);
    await createCliProgram('0.0.6', { daemonStatus }).parseAsync(['node', 'agent-dock', 'daemon', 'status', '--json']);
    expect(daemonStatus).toHaveBeenCalledTimes(2);
    expect(daemonStatus).toHaveBeenNthCalledWith(1, { json: true });
    expect(daemonStatus).toHaveBeenNthCalledWith(2, { json: true });
  });

  it('parses update with an optional npm dist-tag', async () => {
    const update = vi.fn();
    await createCliProgram('0.0.6', { update }).parseAsync(['node', 'agent-dock', 'update', '--dist-tag', 'fix']);
    expect(update).toHaveBeenCalledWith(expect.objectContaining({ distTag: 'fix' }));
  });
});
