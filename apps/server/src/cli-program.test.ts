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

  it('parses task start --cwd as the side-session workspace, not the daemon default', async () => {
    const taskStart = vi.fn();
    const program = createCliProgram('0.0.6', { taskStart });
    await program.parseAsync(['node', 'agent-dock', 'task', 'start', '--title', 'x', '--cwd', '/tmp/task-workspace', '--done-when', 'y']);
    expect(taskStart).toHaveBeenCalledWith(undefined, expect.objectContaining({ cwd: '/tmp/task-workspace' }));
    expect(program.opts().cwd).toBeUndefined();
  });

  it('parses task plan --cwd as the side-session workspace', async () => {
    const taskPlan = vi.fn();
    const program = createCliProgram('0.0.6', { taskPlan });
    await program.parseAsync(['node', 'agent-dock', 'task', 'plan', '--title', 'x', '--cwd', '/tmp/plan-workspace', '--done-when', 'y']);
    expect(taskPlan).toHaveBeenCalledWith(expect.objectContaining({ cwd: '/tmp/plan-workspace' }));
    expect(program.opts().cwd).toBeUndefined();
  });

  it('parses main set --cwd as the new main-session workspace', async () => {
    const mainSet = vi.fn();
    const program = createCliProgram('0.0.6', { mainSet });
    await program.parseAsync(['node', 'agent-dock', 'main', 'set', '--agent', 'claude', '--cwd', '/tmp/main-workspace']);
    expect(mainSet).toHaveBeenCalledWith(undefined, expect.objectContaining({ cwd: '/tmp/main-workspace' }));
    expect(program.opts().cwd).toBeUndefined();
  });

  it('parses task start <plan-id> execution overrides', async () => {
    const taskStart = vi.fn();
    const program = createCliProgram('0.0.6', { taskStart });
    await program.parseAsync(['node', 'agent-dock', 'task', 'start', 'atask_plan', '--cwd', '/tmp/plan-override', '--agent', 'codex']);
    expect(taskStart).toHaveBeenCalledWith('atask_plan', expect.objectContaining({ cwd: '/tmp/plan-override', agent: 'codex' }));
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

  it('parses generic Lark message send/read/listen without changing card commands', async () => {
    const larkSend = vi.fn(); const larkMessageSend = vi.fn(); const larkMessageRead = vi.fn(); const larkMessageListen = vi.fn();
    const program = createCliProgram('0.0.6', { larkSend, larkMessageSend, larkMessageRead, larkMessageListen });
    await program.parseAsync(['node', 'agent-dock', 'lark', 'send', 'card body', '--chat-id', 'oc_card']);
    await program.parseAsync(['node', 'agent-dock', 'lark', 'message', 'send', 'hello', '--chat', 'oc_1', '--bot', '发布机器人', '--format', 'post', '--json']);
    await program.parseAsync(['node', 'agent-dock', 'lark', 'message', 'read', '--chat', 'oc_1', '--limit', '8', '--before', '1700000000', '--page-token', 'pt_1', '--app', 'cli_a', '--json']);
    await program.parseAsync(['node', 'agent-dock', 'lark', 'message', 'listen', '--chat', 'oc_1', '--timeout', '30', '--once', '--json']);
    expect(larkSend).toHaveBeenCalledWith('card body', expect.objectContaining({ chatId: 'oc_card' }));
    expect(larkMessageSend).toHaveBeenCalledWith('hello', expect.objectContaining({ chat: 'oc_1', bot: '发布机器人', format: 'post', json: true }));
    expect(larkMessageRead).toHaveBeenCalledWith(expect.objectContaining({ chat: 'oc_1', limit: '8', before: '1700000000', pageToken: 'pt_1', app: 'cli_a', json: true }));
    expect(larkMessageListen).toHaveBeenCalledWith(expect.objectContaining({ chat: 'oc_1', timeout: '30', once: true, json: true }));
  });

  it('parses --text as an alternative to the positional message body', async () => {
    const larkMessageSend = vi.fn();
    await createCliProgram('0.0.6', { larkMessageSend }).parseAsync(['node', 'agent-dock', 'lark', 'message', 'send', '--chat', 'oc_1', '--text', 'from flag']);
    expect(larkMessageSend).toHaveBeenCalledWith(undefined, expect.objectContaining({ chat: 'oc_1', text: 'from flag' }));
  });

  it('parses lark avatar send with repeatable mentions and thread options', async () => {
    const larkAvatarSend = vi.fn();
    await createCliProgram('0.0.6', { larkAvatarSend }).parseAsync([
      'node', 'agent-dock', 'lark', 'avatar', 'send',
      '--chat', '测试群', '--text', '@张三 已更到预发', '--reply-to', 'om_parent',
      '--in-thread', '--at', '张三', '--at', 'ou_abc', '--match', 'exact', '--json'
    ]);
    expect(larkAvatarSend).toHaveBeenCalledWith(expect.objectContaining({
      chat: '测试群',
      text: '@张三 已更到预发',
      replyTo: 'om_parent',
      inThread: true,
      at: ['张三', 'ou_abc'],
      match: 'exact',
      json: true
    }));
  });

  it('parses lark avatar send text files without --text', async () => {
    const larkAvatarSend = vi.fn();
    await createCliProgram('0.0.6', { larkAvatarSend }).parseAsync([
      'node', 'agent-dock', 'lark', 'avatar', 'send', '--chat', '900001', '--text-file', '-'
    ]);
    expect(larkAvatarSend).toHaveBeenCalledWith(expect.objectContaining({ chat: '900001', textFile: '-', at: [] }));
  });

  it('parses the reported 19-digit group and ou_ mention command', async () => {
    const larkAvatarSend = vi.fn();
    await createCliProgram('0.0.6', { larkAvatarSend }).parseAsync([
      'node', 'agent-dock', 'lark', 'avatar', 'send',
      '--chat', '[TikTok Search] Code Review Group (Search Cloud)',
      '--at', 'ou_3658a80b8ff9251eee1c2b0f36d1a',
      '--text', '@ou_3658a80b8ff9251eee1c2b0f36d1a 请看', '--json'
    ]);
    expect(larkAvatarSend).toHaveBeenCalledWith(expect.objectContaining({
      chat: '[TikTok Search] Code Review Group (Search Cloud)',
      at: ['ou_3658a80b8ff9251eee1c2b0f36d1a'],
      json: true
    }));
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
  it('dispatches autostart subcommands', () => {
    const autostart = vi.fn();
    for (const action of ['enable', 'disable', 'status']) createCliProgram('0.0.5', { autostart }).parse(['node', 'agent-dock', 'autostart', action, '--json']);
    expect(autostart.mock.calls.map(call => [call[0], call[1].json])).toEqual([['enable', true], ['disable', true], ['status', true]]);
  });

  it('parses the full board command tree (boards, columns, cards, export/import, ask-kitten)', async () => {
    const boardList = vi.fn();
    const boardCreate = vi.fn();
    const boardShow = vi.fn();
    const boardUse = vi.fn();
    const boardColumnAdd = vi.fn();
    const boardCardAdd = vi.fn();
    const boardCardMove = vi.fn();
    const boardCardUpdate = vi.fn();
    const boardAskKitten = vi.fn();
    const program = createCliProgram('0.3.25', {
      boardList, boardCreate, boardShow, boardUse,
      boardColumnAdd, boardCardAdd, boardCardMove, boardCardUpdate, boardAskKitten
    });
    await program.parseAsync(['node', 'agent-dock', 'board', 'list', '--archived', '--json']);
    await program.parseAsync(['node', 'agent-dock', 'board', 'create', '发布冲刺', '--template', 'status', '--view', 'grid', '--density', 'comfortable', '--default', '--json']);
    await program.parseAsync(['node', 'agent-dock', 'board', 'show', 'brd_1', '--watch', '--column', '进行中']);
    await program.parseAsync(['node', 'agent-dock', 'board', 'use', 'brd_1', '-q']);
    await program.parseAsync(['node', 'agent-dock', 'board', 'column', 'add', 'brd_1', '--name', '待回归', '--color', 'amber', '--wip', '5', '--rule', '{"taskStates":["review"]}', '--on-drop', 'prompt_kitten']);
    await program.parseAsync(['node', 'agent-dock', 'board', 'card', 'add', 'brd_1', '--column', 'bcol_1', '--task', 'atask_1', '--tag', 'p0', '--tag', 'ui', '--pin']);
    await program.parseAsync(['node', 'agent-dock', 'board', 'card', 'move', 'bitem_1', 'bitem_2', '--to-column', 'bcol_2', '--top', '--apply-action']);
    await program.parseAsync(['node', 'agent-dock', 'board', 'card', 'update', 'bitem_1', '--kitten-note', '截图验收通过', '--add-tag', 'verified', '--reset-rule-override']);
    await program.parseAsync(['node', 'agent-dock', 'board', 'ask-kitten', 'brd_1', '--cards', 'bitem_1,bitem_2', '--prompt', '汇总进展']);

    expect(boardList).toHaveBeenCalledWith(expect.objectContaining({ archived: true, json: true }));
    expect(boardCreate).toHaveBeenCalledWith('发布冲刺', expect.objectContaining({ template: 'status', view: 'grid', density: 'comfortable', default: true, json: true }));
    expect(boardShow).toHaveBeenCalledWith('brd_1', expect.objectContaining({ watch: true, column: '进行中' }));
    expect(boardUse).toHaveBeenCalledWith('brd_1', expect.objectContaining({ quiet: true }));
    expect(boardColumnAdd).toHaveBeenCalledWith('brd_1', expect.objectContaining({ name: '待回归', color: 'amber', wip: '5', rule: '{"taskStates":["review"]}', onDrop: 'prompt_kitten' }));
    expect(boardCardAdd).toHaveBeenCalledWith('brd_1', expect.objectContaining({ column: 'bcol_1', task: 'atask_1', tag: ['p0', 'ui'], pin: true }));
    expect(boardCardMove).toHaveBeenCalledWith(['bitem_1', 'bitem_2'], expect.objectContaining({ toColumn: 'bcol_2', top: true, applyAction: true }));
    expect(boardCardUpdate).toHaveBeenCalledWith('bitem_1', expect.objectContaining({ kittenNote: '截图验收通过', addTag: ['verified'], resetRuleOverride: true }));
    expect(boardAskKitten).toHaveBeenCalledWith('brd_1', expect.objectContaining({ cards: 'bitem_1,bitem_2', prompt: '汇总进展' }));
  });

  it('keeps backward compatibility for `notify "<text>"` while supporting config/channel/test subcommands', async () => {
    const notify = vi.fn();
    const notifyStatus = vi.fn();
    const notifyConfigSet = vi.fn();
    const notifyChannelLarkSet = vi.fn();
    const notifyWebhookAdd = vi.fn();
    const notifyChannelCommandSet = vi.fn();
    const notifyTest = vi.fn();
    const program = createCliProgram('0.3.25', {
      notify, notifyStatus, notifyConfigSet, notifyChannelLarkSet, notifyWebhookAdd, notifyChannelCommandSet, notifyTest
    });

    await program.parseAsync(['node', 'agent-dock', 'notify', '请拍板', '--ask', '--urgent']);
    await program.parseAsync(['node', 'agent-dock', 'notify', 'send', '显式发送', '--json']);
    await program.parseAsync(['node', 'agent-dock', 'notify', 'status', '--json']);
    await program.parseAsync(['node', 'agent-dock', 'notify', 'config', 'show', '--json']);
    await program.parseAsync(['node', 'agent-dock', 'notify', 'config', 'set', '--min-duration', '20', '--remote-only-when-away', '--scope-scheduled', 'failed_only']);
    await program.parseAsync(['node', 'agent-dock', 'notify', 'channel', 'lark', 'set', '--enabled', '--mode', 'direct_user', '--target', 'ou_123']);
    await program.parseAsync(['node', 'agent-dock', 'notify', 'channel', 'webhook', 'add', '--name', 'Ops', '--url', 'https://example.com/hook', '--preset', 'bark', '--header', 'X-Key=1']);
    await program.parseAsync(['node', 'agent-dock', 'notify', 'channel', 'command', 'set', '--enabled', '--cmd', 'echo ok', '--trust-confirm']);
    await program.parseAsync(['node', 'agent-dock', 'notify', 'test', 'webhook', '--webhook', 'wh_1']);

    expect(notify).toHaveBeenNthCalledWith(1, '请拍板', expect.objectContaining({ ask: true, urgent: true }));
    expect(notify).toHaveBeenNthCalledWith(2, '显式发送', expect.objectContaining({ json: true }));
    expect(notifyStatus).toHaveBeenCalledTimes(2);
    expect(notifyConfigSet).toHaveBeenCalledWith(expect.objectContaining({ minDuration: '20', remoteOnlyWhenAway: true, scopeScheduled: 'failed_only' }));
    expect(notifyChannelLarkSet).toHaveBeenCalledWith(expect.objectContaining({ enabled: true, mode: 'direct_user', target: 'ou_123' }));
    expect(notifyWebhookAdd).toHaveBeenCalledWith(expect.objectContaining({ name: 'Ops', url: 'https://example.com/hook', preset: 'bark', header: ['X-Key=1'] }));
    expect(notifyChannelCommandSet).toHaveBeenCalledWith(expect.objectContaining({ enabled: true, cmd: 'echo ok', trustConfirm: true }));
    expect(notifyTest).toHaveBeenCalledWith('webhook', expect.objectContaining({ webhook: 'wh_1' }));
  });

  it('parses lark avatar platform commands and usage quota', async () => {
    const larkAvatarStatus = vi.fn();
    const larkAvatarConfigSet = vi.fn();
    const larkAvatarListen = vi.fn();
    const larkAvatarInboxCleanup = vi.fn();
    const larkAvatarDraftSend = vi.fn();
    const usageQuota = vi.fn();
    const program = createCliProgram('0.3.25', {
      larkAvatarStatus, larkAvatarConfigSet, larkAvatarListen, larkAvatarInboxCleanup, larkAvatarDraftSend, usageQuota
    });

    await program.parseAsync(['node', 'agent-dock', 'lark', 'avatar', 'status', '--json']);
    await program.parseAsync(['node', 'agent-dock', 'lark', 'avatar', 'config', 'set', '--reply-forward', 'final_only', '--inbox-max', '120', '--cleanup-warn', '250', '--listen-chats', 'oc_1,oc_2']);
    await program.parseAsync(['node', 'agent-dock', 'lark', 'avatar', 'listen', 'start']);
    await program.parseAsync(['node', 'agent-dock', 'lark', 'avatar', 'listen', 'stop']);
    await program.parseAsync(['node', 'agent-dock', 'lark', 'avatar', 'inbox', 'cleanup', '--keep-latest', '50', '--json']);
    await program.parseAsync(['node', 'agent-dock', 'lark', 'avatar', 'draft', 'send', 'lad_1', '--text', '收到']);
    await program.parseAsync(['node', 'agent-dock', 'usage', 'quota', 'codex', '--refresh', '--json']);

    expect(larkAvatarStatus).toHaveBeenCalledWith(expect.objectContaining({ json: true }));
    expect(larkAvatarConfigSet).toHaveBeenCalledWith(expect.objectContaining({ replyForward: 'final_only', inboxMax: '120', cleanupWarn: '250', listenChats: 'oc_1,oc_2' }));
    expect(larkAvatarListen).toHaveBeenNthCalledWith(1, true, expect.anything());
    expect(larkAvatarListen).toHaveBeenNthCalledWith(2, false, expect.anything());
    expect(larkAvatarInboxCleanup).toHaveBeenCalledWith(expect.objectContaining({ keepLatest: '50', json: true }));
    expect(larkAvatarDraftSend).toHaveBeenCalledWith('lad_1', expect.objectContaining({ text: '收到' }));
    expect(usageQuota).toHaveBeenCalledWith('codex', expect.objectContaining({ refresh: true, json: true }));
  });
});
