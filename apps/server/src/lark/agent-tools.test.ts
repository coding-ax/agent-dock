import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRepositories } from '@agent-dock/agent-dock-storage';
import type { Session } from '@agent-dock/agent-dock-shared';
import { larkBotsConfigKey } from './config.js';
import {
  AgentGroupToolError,
  LarkAgentToolCapabilityRegistry,
  LarkAgentToolsService,
  agentDockGroupToolsCommand,
  larkAgentSessionBinding,
  loadOrCreateGroupToolsSigningSecret,
  type LarkGroupToolClient
} from './agent-tools.js';
import { LarkServiceError, type LarkChatMessage } from './service.js';
import { createHandoverLookup } from './handover-binding.js';

const repositories: Array<ReturnType<typeof createRepositories>> = [];
afterEach(() => { for (const repository of repositories.splice(0)) repository.close(); });

const session = (overrides: Partial<Session> = {}): Session => ({
  id: 'ses_lark', agentId: 'codex', state: 'idle', cwd: '/tmp', source: 'lark', sourceId: 'cli_current:oc_group:group',
  runId: 'run_1', createdAt: '', updatedAt: '', ...overrides
});

const message = (messageId: string, createTime: string, text: string): LarkChatMessage => ({
  messageId, chatId: 'oc_group', messageType: 'text', createTime, sender: { id: 'ou_sender', type: 'app', name: 'Peer' },
  rawContent: JSON.stringify({ text }), mentions: [], deleted: false, updated: false
});

function fakeClient(overrides: Partial<LarkGroupToolClient> = {}): LarkGroupToolClient {
  return {
    getBotInfo: vi.fn(async () => ({ appName: 'Current Bot', openId: 'ou_current' })),
    listChatMembers: vi.fn(async () => ({ items: [], hasMore: false, securityLimited: false })),
    listChatMessages: vi.fn(async () => ({ items: [], hasMore: false })),
    getMessage: vi.fn(async messageId => message(messageId, '1000', 'original')),
    getMessageItems: vi.fn(async messageId => [message(messageId, '1000', 'original')]),
    sendText: vi.fn(async input => ({ messageId: 'om_sent', chatId: input.chatId })),
    replyText: vi.fn(async () => ({ messageId: 'om_reply', chatId: 'oc_group' })),
    sendPost: vi.fn(async input => ({ messageId: 'om_sent', chatId: input.chatId })),
    replyPost: vi.fn(async () => ({ messageId: 'om_reply', chatId: 'oc_group' })),
    uploadImage: vi.fn(async () => 'im_uploaded'),
    sendImage: vi.fn(async input => ({ messageId: 'om_img', chatId: input.chatId })),
    replyImage: vi.fn(async () => ({ messageId: 'om_img_reply', chatId: 'oc_group' })),
    ...overrides
  };
}

async function setup(clients: Record<string, LarkGroupToolClient>, groupToolsCommand?: string) {
  const repos = createRepositories(':memory:'); repositories.push(repos);
  const activeSession = session();
  await repos.sessions.save(activeSession);
  await repos.config.set(larkBotsConfigKey, JSON.stringify([
    { appId: 'cli_current', appSecret: 'secret-current', name: 'Current Bot', defaultAgentId: 'codex', groupToolsEnabled: true, groupToolsAllowSend: true },
    { appId: 'cli_peer', appSecret: 'secret-peer', name: 'Peer Bot', defaultAgentId: 'claude', groupToolsEnabled: true, groupToolsAllowSend: true },
    { appId: 'cli_disabled', appSecret: 'secret-disabled', name: 'Disabled Bot', defaultAgentId: 'gemini', groupToolsEnabled: false }
  ]));
  const capabilities = new LarkAgentToolCapabilityRegistry(repos.sessions, 'http://127.0.0.1:4310');
  const environment = capabilities.environmentFor(activeSession);
  const tools = new LarkAgentToolsService(capabilities, repos.config, {
    pollIntervalMs: 50,
    ...(groupToolsCommand ? { groupToolsCommand } : {}),
    clientFactory: config => clients[config.appId] ?? fakeClient()
  });
  return { repos, activeSession, capabilities, tools, token: environment.agentdock_group_tools_token! };
}

describe('Agent group collaboration domain service', () => {
  it('builds a command bound to the current TypeScript or built entrypoint', () => {
    expect(agentDockGroupToolsCommand('/workspace/apps/server/src/cli.ts', '/usr/bin/node', 'file:///workspace/node_modules/tsx/loader.mjs')).toBe("'/usr/bin/node' --import 'file:///workspace/node_modules/tsx/loader.mjs' '/workspace/apps/server/src/cli.ts'");
    expect(agentDockGroupToolsCommand('/workspace/apps/server/dist/cli.js', '/usr/bin/node')).toBe("'/usr/bin/node' '/workspace/apps/server/dist/cli.js'");
  });

  it('binds capabilities to one persisted Lark session and never injects bot credentials', async () => {
    const current = fakeClient();
    const { repos, activeSession, capabilities, tools, token } = await setup({ cli_current: current });
    expect(larkAgentSessionBinding(activeSession)).toEqual({ sessionId: 'ses_lark', appId: 'cli_current', chatId: 'oc_group', chatType: 'group' });
    expect(larkAgentSessionBinding(session({ sourceId: 'cli_current:oc_p2p:p2p' }))).toBeUndefined();
    expect(capabilities.environmentFor(session({ id: 'ses_p2p', sourceId: 'cli_current:oc_p2p:p2p' }))).toEqual({});
    expect(capabilities.environmentFor(activeSession)).toEqual({
      agentdock_group_tools_url: 'http://127.0.0.1:4310/api/lark/agent-tools',
      agentdock_group_tools_token: token
    });
    expect(JSON.stringify(capabilities.environmentFor(activeSession))).not.toContain('secret-current');
    await expect(tools.self('wrong-token')).rejects.toMatchObject({ code: 'GROUP_TOOL_UNAUTHORIZED', statusCode: 401 });
    expect(await tools.self(token)).toMatchObject({ chatId: 'oc_group', bot: { appId: 'cli_current', openId: 'ou_current' }, policy: { canSend: true } });
    expect((await tools.messages(token)).cursor).toBeTruthy();
    await expect(tools.wait(token)).rejects.toMatchObject({ code: 'GROUP_WAIT_CURSOR_REQUIRED', statusCode: 400 });
    await repos.config.set(larkBotsConfigKey, JSON.stringify([{ appId: 'cli_current', appSecret: 'secret-current', defaultAgentId: 'codex', groupToolsEnabled: true, groupToolsAllowSend: false }]));
    await expect(tools.send(token, { content: 'blocked' })).rejects.toMatchObject({ code: 'GROUP_TOOL_SEND_DISABLED', statusCode: 403 });
    expect(current.sendText).not.toHaveBeenCalled();
    await repos.sessions.save({ ...activeSession, state: 'stopped' });
    await expect(tools.self(token)).rejects.toMatchObject({ code: 'GROUP_TOOL_SESSION_EXPIRED', statusCode: 401 });
  });

  it('keeps the same scoped token across service restarts with a persisted signing secret', async () => {
    const repos = createRepositories(':memory:'); repositories.push(repos);
    const activeSession = session();
    await repos.sessions.save(activeSession);
    const signingSecret = await loadOrCreateGroupToolsSigningSecret(repos.config);
    expect(await loadOrCreateGroupToolsSigningSecret(repos.config)).toBe(signingSecret);
    const first = new LarkAgentToolCapabilityRegistry(repos.sessions, 'http://127.0.0.1:4310', signingSecret);
    const firstToken = first.environmentFor(activeSession).agentdock_group_tools_token;
    first.close();
    const second = new LarkAgentToolCapabilityRegistry(repos.sessions, 'http://127.0.0.1:4310', signingSecret);
    const secondToken = second.environmentFor(activeSession).agentdock_group_tools_token;
    expect(firstToken).toMatch(/^v1\./);
    expect(secondToken).toBe(firstToken);
    await expect(second.resolve(secondToken)).resolves.toMatchObject({ sessionId: activeSession.id, chatId: 'oc_group' });
  });

  it('issues a capability on demand for a desktop session handed over to a group mid-run', async () => {
    const repos = createRepositories(':memory:'); repositories.push(repos);
    await repos.config.set(larkBotsConfigKey, JSON.stringify([
      { appId: 'cli_current', appSecret: 'secret-current', name: 'Current Bot', defaultAgentId: 'codex', groupToolsEnabled: true, groupToolsAllowSend: true }
    ]));
    const desktop = session({ id: 'ses_desktop', source: undefined, sourceId: undefined });
    await repos.sessions.save(desktop);
    const capabilities = new LarkAgentToolCapabilityRegistry(repos.sessions, 'http://127.0.0.1:4310');
    capabilities.useHandoverLookup(createHandoverLookup(repos.config, repos.channelMappings));
    // 进程启动时还没托管：不注入凭证，也不能凭空换取。
    expect(capabilities.environmentFor(desktop)).toEqual({});
    await expect(capabilities.issueFor('ses_desktop')).rejects.toMatchObject({ code: 'GROUP_TOOL_CONTEXT_REQUIRED' });
    await repos.channelMappings.save({ id: 'lark-handover:cli_current:oc_handover', channel: 'lark-handover:cli_current', externalId: 'oc_handover', sessionId: 'ses_desktop', createdAt: '' });
    const issued = await capabilities.issueFor('ses_desktop');
    expect(issued.agentdock_group_tools_url).toBe('http://127.0.0.1:4310/api/lark/agent-tools');
    await expect(capabilities.resolve(issued.agentdock_group_tools_token)).resolves.toMatchObject({ sessionId: 'ses_desktop', appId: 'cli_current', chatId: 'oc_handover' });
    const tools = new LarkAgentToolsService(capabilities, repos.config, { clientFactory: () => fakeClient() });
    expect(await tools.promptForSession(desktop, '继续')).toContain('agent-dock group');
    await repos.sessions.save({ ...desktop, archivedAt: '2026-10-14T00:00:00.000Z' });
    await expect(capabilities.resolve(issued.agentdock_group_tools_token)).rejects.toMatchObject({ code: 'GROUP_TOOL_SESSION_EXPIRED' });
    await expect(capabilities.issueFor('ses_desktop')).rejects.toMatchObject({ code: 'GROUP_TOOL_SESSION_EXPIRED' });
  });

  it('lists all bots in the group and marks only locally managed ones with agentId', async () => {
    const current = fakeClient({
      listChatMembers: vi.fn(async () => ({
        items: [
          { memberId: 'ou_peer', openId: 'ou_peer', memberType: 'bot', name: 'Peer Bot', appId: 'cli_peer' },
          { memberId: 'ou_unconfigured', openId: 'ou_unconfigured', memberType: 'bot', name: 'Other Bot', appId: 'cli_other' },
          { memberId: 'ou_disabled', openId: 'ou_disabled', memberType: 'bot', name: 'Disabled Bot', appId: 'cli_disabled' }
        ],
        hasMore: false, securityLimited: false
      }))
    });
    const peer = fakeClient({ getBotInfo: vi.fn(async () => ({ appName: 'Peer Bot', openId: 'ou_peer' })) });
    const disabled = fakeClient({ getBotInfo: vi.fn(async () => ({ appName: 'Disabled Bot', openId: 'ou_disabled' })) });
    const { tools, token } = await setup({ cli_current: current, cli_peer: peer, cli_disabled: disabled });
    await expect(tools.peers(token)).resolves.toEqual({
      chatId: 'oc_group', securityLimited: false,
      peers: [
        { appId: 'cli_peer', name: 'Peer Bot', agentId: 'claude', memberId: 'ou_peer', openId: 'ou_peer' },
        { appId: 'cli_other', name: 'Other Bot', memberId: 'ou_unconfigured', openId: 'ou_unconfigured' },
        { appId: 'cli_disabled', name: 'Disabled Bot', memberId: 'ou_disabled', openId: 'ou_disabled' }
      ]
    });
    expect(peer.getBotInfo).not.toHaveBeenCalled();
    await expect(tools.isConfiguredPeer('cli_current', 'oc_group', 'ou_peer')).resolves.toBe(true);
    await expect(tools.isConfiguredPeer('cli_current', 'oc_group', 'ou_unconfigured')).resolves.toBe(false);
    await expect(tools.isConfiguredPeer('cli_current', 'oc_group', 'ou_disabled')).resolves.toBe(false);
  });

  // 线上事故第二段：@ 唤醒成功后任务仍不创建。原因是互信判定依赖群成员列表，
  // 而飞书以机器人身份调 chats/:id/members 时不返回其他机器人成员——两个机器人
  // 互相看不见，互信永远建立不起来。改为按各自 bot/v3/info 的 open_id 判定。
  it('trusts a configured peer bot that the group member list does not expose', async () => {
    const current = fakeClient({
      // 关键：成员列表里完全没有 peer 机器人（复现线上飞书的实际返回）。
      listChatMembers: vi.fn(async () => ({ items: [], hasMore: false, securityLimited: false }))
    });
    const peer = fakeClient({ getBotInfo: vi.fn(async () => ({ appName: 'Peer Bot', openId: 'ou_peer' })) });
    const disabled = fakeClient({ getBotInfo: vi.fn(async () => ({ appName: 'Disabled Bot', openId: 'ou_disabled' })) });
    const { tools } = await setup({ cli_current: current, cli_peer: peer, cli_disabled: disabled });
    await expect(tools.isConfiguredPeer('cli_current', 'oc_group', 'ou_peer')).resolves.toBe(true);
    // 未配置的机器人、以及关掉 groupTools 的机器人，仍然不可信。
    await expect(tools.isConfiguredPeer('cli_current', 'oc_group', 'ou_stranger')).resolves.toBe(false);
    await expect(tools.isConfiguredPeer('cli_current', 'oc_group', 'ou_disabled')).resolves.toBe(false);
    // 自己发的消息不算 peer，避免自触发循环。
    await expect(tools.isConfiguredPeer('cli_current', 'oc_group', 'ou_current')).resolves.toBe(false);
    // p2p / 非法 id 一律拒绝。
    await expect(tools.isConfiguredPeer('cli_current', 'oc_group', 'cli_peer')).resolves.toBe(false);
    await expect(tools.isConfiguredPeer('cli_current', 'p2p_x', 'ou_peer')).resolves.toBe(false);
  });

  it('injects group context for every dispatch path while leaving p2p sessions unchanged', async () => {
    const { tools } = await setup({ cli_current: fakeClient() }, "'/usr/bin/node' '/app/cli.js'");
    const prompt = await tools.promptForSession(session(), '继续处理');
    expect(prompt).toContain("'/usr/bin/node' '/app/cli.js' group peers");
    expect(prompt).toContain("group send '我已定位问题' --reply-to om_xxx --in-thread");
    expect(prompt).toContain("group send '发布窗口已开启'");
    await expect(tools.promptForSession(session({ sourceId: 'cli_current:oc_p2p:p2p' }), '继续处理')).resolves.toBe('继续处理');
  });

  it('reminds the agent to keep credentials secret, including when group tools are disabled', async () => {
    const { tools } = await setup({ cli_current: fakeClient() }, "'/usr/bin/node' '/app/cli.js'");
    // 开启群工具：完整工具说明末尾带凭证保密段。
    const enabledPrompt = await tools.promptForSession(session(), '继续处理');
    expect(enabledPrompt).toContain('agentdock_group_tools_token');
    expect(enabledPrompt).toContain('严禁');
    // 关掉群工具：不注入工具用法，但环境仍带 token，保密提醒不能缺席。
    const disabledPrompt = await tools.promptForSession(session({ sourceId: 'cli_disabled:oc_group:group' }), '继续处理');
    expect(disabledPrompt).toContain('凭证保密');
    expect(disabledPrompt).toContain('agentdock_group_tools_token');
    expect(disabledPrompt).not.toContain('group peers');
  });

  it('renders text-message mention placeholders as readable @名字 in history output', async () => {
    const mentioned: LarkChatMessage = {
      ...message('om_at', '1000', '@_user_1 锐评一下 @_user_2'),
      mentions: [
        { key: '@_user_1', name: '圣可汗' },
        { key: '@_user_2', name: '韩伟' }
      ]
    };
    const current = fakeClient({
      listChatMessages: vi.fn(async () => ({ items: [mentioned], hasMore: false }))
    });
    const { tools, token } = await setup({ cli_current: current });
    const result = await tools.messages(token, { limit: 5 });
    expect(result.messages[0]?.content).toBe('@圣可汗 锐评一下 @韩伟');
  });

  it('uses opaque cursors for incremental reads and mentions a discovered target when sending', async () => {
    const first = message('om_1', '1000', 'one'); const second = message('om_2', '2000', 'two'); const third = message('om_3', '3000', 'three');
    const current = fakeClient({
      listChatMembers: vi.fn(async input => ({ items: input.memberTypes?.includes('bot') ? [{ memberId: 'ou_peer', openId: 'ou_peer', memberType: 'bot' as const, name: 'Peer Bot' }] : [], hasMore: false, securityLimited: false })),
      listChatMessages: vi.fn(async input => ({ items: input.order === 'desc' ? [second, first] : [first, second, third], hasMore: false }))
    });
    const peer = fakeClient({ getBotInfo: vi.fn(async () => ({ appName: 'Peer Bot', openId: 'ou_peer' })) });
    const { tools, token } = await setup({ cli_current: current, cli_peer: peer });
    const initial = await tools.messages(token, { limit: 2 });
    expect(initial.messages.map(item => item.content)).toEqual(['one', 'two']);
    expect(initial.cursor).toBeTruthy();
    const next = await tools.messages(token, { after: initial.cursor, limit: 10 });
    expect(next.messages.map(item => item.messageId)).toEqual(['om_3']);
    await expect(tools.send(token, { content: '请检查', to: 'cli_peer', idempotencyKey: 'handoff-1' })).resolves.toEqual({ messageId: 'om_sent', chatId: 'oc_group' });
    // @ 机器人（app）必须用 post 格式，且 at 的 user_id 填机器人 app_id（text 格式的 at 标签不会被解析）。
    expect(current.sendText).not.toHaveBeenCalled();
    expect(current.sendPost).toHaveBeenCalledWith({
      chatId: 'oc_group',
      content: { zh_cn: { title: '', content: [[{ tag: 'at', user_id: 'ou_peer', user_name: 'Peer Bot' }, { tag: 'text', text: '请检查' }]] } },
      idempotencyKey: 'handoff-1'
    });
  });

  it('discovers and mentions a human member in the scoped group', async () => {
    const current = fakeClient({
      listChatMembers: vi.fn(async input => ({
        items: input.memberTypes?.includes('user')
          ? [{ memberId: 'ou_human', openId: 'ou_human', memberType: 'user' as const, name: '小王' }]
          : [],
        hasMore: false, securityLimited: false
      }))
    });
    const { tools, token } = await setup({ cli_current: current });
    await expect(tools.members(token)).resolves.toEqual({
      chatId: 'oc_group', securityLimited: false,
      members: [{ name: '小王', memberId: 'ou_human', openId: 'ou_human' }]
    });
    await expect(tools.send(token, { content: '请改用 agent-dock', to: '小王' })).resolves.toEqual({ messageId: 'om_sent', chatId: 'oc_group' });
    expect(current.sendText).not.toHaveBeenCalled();
    expect(current.sendPost).toHaveBeenCalledWith(expect.objectContaining({
      chatId: 'oc_group',
      content: { zh_cn: { title: '', content: [[{ tag: 'at', user_id: 'ou_human', user_name: '小王' }, { tag: 'text', text: '请改用 agent-dock' }]] } }
    }));
  });

  it('rejects cross-group replies and converts missing scopes into explicit admin instructions', async () => {
    const crossGroup = fakeClient({ getMessage: vi.fn(async () => ({ ...message('om_other', '1000', 'other'), chatId: 'oc_other' })) });
    const first = await setup({ cli_current: crossGroup });
    await expect(first.tools.send(first.token, { content: 'reply', replyTo: 'om_other' })).rejects.toMatchObject({ code: 'GROUP_REPLY_OUT_OF_SCOPE', statusCode: 403 });
    expect(crossGroup.replyText).not.toHaveBeenCalled();

    const denied = fakeClient({
      listChatMembers: vi.fn(async () => { throw new LarkServiceError('LARK_OPENAPI_ERROR', 'Access denied', 502, { upstreamCode: 99991672, consoleUrl: 'https://open.larkoffice.com/app/cli_current/auth' }); })
    });
    const second = await setup({ cli_current: denied });
    let caught: AgentGroupToolError | undefined;
    try { await second.tools.peers(second.token); } catch (error) { caught = error as AgentGroupToolError; }
    expect(caught).toMatchObject({ code: 'GROUP_TOOL_AUTHORIZATION_REQUIRED', statusCode: 403 });
    expect(caught?.response().error).toMatchObject({
      requiredScopes: ['im:chat.members:read'], authorizationUrl: 'https://open.larkoffice.com/app/cli_current/auth',
      instruction: expect.stringContaining('不要向用户索要 App Secret')
    });
  });

  it('converts inline bot at tags into post format and keeps plain text sends untouched', async () => {
    const current = fakeClient();
    const { tools, token } = await setup({ cli_current: current });
    await expect(tools.send(token, { content: '请 <at user_id="ou_peer">Peer Bot</at> 看下这个', idempotencyKey: 'inline-1' })).resolves.toEqual({ messageId: 'om_sent', chatId: 'oc_group' });
    expect(current.sendText).not.toHaveBeenCalled();
    expect(current.sendPost).toHaveBeenCalledWith({
      chatId: 'oc_group',
      content: { zh_cn: { title: '', content: [[
        { tag: 'text', text: '请 ' },
        { tag: 'at', user_id: 'ou_peer', user_name: 'Peer Bot' },
        { tag: 'text', text: ' 看下这个' }
      ]] } },
      idempotencyKey: 'inline-1'
    });
    // 纯文本、无任何 bot @ 时仍走 text 格式。
    await expect(tools.send(token, { content: '普通消息', idempotencyKey: 'plain-1' })).resolves.toEqual({ messageId: 'om_sent', chatId: 'oc_group' });
    expect(current.sendText).toHaveBeenCalledWith({ chatId: 'oc_group', text: '普通消息', idempotencyKey: 'plain-1' });
  });

  it('keeps human at tags as real mentions when a bot mention forces post format', async () => {
    // post 的 at 元素对人类（open_id）同样有效。此前内联正则只匹配 cli_，
    // 人类标签会被当成字面文本输出：人类收不到通知，还看到原始标记。
    const current = fakeClient();
    const { tools, token } = await setup({ cli_current: current });
    await expect(tools.send(token, { content: '<at user_id="ou_bob">Bob</at> and <at user_id="ou_peer">Peer</at> check', idempotencyKey: 'mixed-1' })).resolves.toEqual({ messageId: 'om_sent', chatId: 'oc_group' });
    expect(current.sendPost).toHaveBeenCalledWith({
      chatId: 'oc_group',
      content: { zh_cn: { title: '', content: [[
        { tag: 'at', user_id: 'ou_bob', user_name: 'Bob' },
        { tag: 'text', text: ' and ' },
        { tag: 'at', user_id: 'ou_peer', user_name: 'Peer' },
        { tag: 'text', text: ' check' }
      ]] } },
      idempotencyKey: 'mixed-1'
    });
    const elements = current.sendPost.mock.calls[0]![0].content.zh_cn.content[0] as Array<Record<string, string>>;
    expect(elements.some(element => element.tag === 'text' && element.text.includes('<at'))).toBe(false);
  });

  it('sends a standalone image when content is only a single <img src> tag', async () => {
    const current = fakeClient();
    const { tools, token } = await setup({ cli_current: current });
    const dataUri = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';
    await expect(tools.send(token, { content: `<img src="${dataUri}"/>`, idempotencyKey: 'img-only-1' })).resolves.toEqual({ messageId: 'om_img', chatId: 'oc_group' });
    expect(current.sendText).not.toHaveBeenCalled();
    expect(current.sendPost).not.toHaveBeenCalled();
    expect(current.uploadImage).toHaveBeenCalledTimes(1);
    expect(current.sendImage).toHaveBeenCalledWith({ chatId: 'oc_group', imageKey: 'im_uploaded', idempotencyKey: 'img-only-1' });
  });

  it('mixes text and inline images into one post with img elements', async () => {
    const current = fakeClient();
    const { tools, token } = await setup({ cli_current: current });
    const dataUri = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';
    await expect(tools.send(token, { content: `看图 <img src="${dataUri}"/> 和 <img src="${dataUri}"/> 都在`, idempotencyKey: 'mix-1' })).resolves.toEqual({ messageId: 'om_sent', chatId: 'oc_group' });
    expect(current.sendText).not.toHaveBeenCalled();
    expect(current.uploadImage).toHaveBeenCalledTimes(2);
    expect(current.sendPost).toHaveBeenCalledWith({
      chatId: 'oc_group',
      content: { zh_cn: { title: '', content: [[
        { tag: 'text', text: '看图 ' },
        { tag: 'img', image_key: 'im_uploaded' },
        { tag: 'text', text: ' 和 ' },
        { tag: 'img', image_key: 'im_uploaded' },
        { tag: 'text', text: ' 都在' }
      ]] } },
      idempotencyKey: 'mix-1'
    });
  });

  it('uploads a local absolute-path image as bytes', async () => {
    const { writeFileSync, mkdtempSync, rmSync } = await import('node:fs');
    const { join } = await import('node:path');
    const { tmpdir } = await import('node:os');
    const dir = mkdtempSync(join(tmpdir(), 'agentdock-img-'));
    const file = join(dir, 'demo.png');
    writeFileSync(file, Buffer.from('89504e470d0a1a0a', 'hex'));
    try {
      const current = fakeClient();
      const { tools, token } = await setup({ cli_current: current });
      await expect(tools.send(token, { content: `<img src="${file}"/>`, idempotencyKey: 'local-1' })).resolves.toEqual({ messageId: 'om_img', chatId: 'oc_group' });
      const uploadArg = current.uploadImage.mock.calls[0]!;
      expect(uploadArg[1]).toBe('demo.png');
      expect(Buffer.from(uploadArg[0] as Uint8Array).toString('hex')).toBe('89504e470d0a1a0a');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rejects an unreadable local image with an actionable error', async () => {
    const current = fakeClient();
    const { tools, token } = await setup({ cli_current: current });
    await expect(tools.send(token, { content: '<img src="/no/such/image-xyz.png"/>' }))
      .rejects.toMatchObject({ code: 'INVALID_GROUP_IMAGE', statusCode: 404 });
    expect(current.sendImage).not.toHaveBeenCalled();
    expect(current.uploadImage).not.toHaveBeenCalled();
  });

  // 线上事故：at 元素的 user_id 被兜底成空字符串后，飞书照样把它渲染成蓝色的 @名字，
  // 但不产生 mentions、也不通知任何人——「看着 @ 了，实际是一段蓝字」，机器人永远唤不醒。
  // 因此宁可报错让 Agent 先查 openId，也绝不发出空的或 cli_ 开头的 at。
  it('never emits an at element without a usable open_id', async () => {
    const current = fakeClient({
      listChatMembers: vi.fn(async input => ({
        // 飞书 chats/:id/members?member_id_type=open_id 实测不返回机器人的 app_id。
        items: input.memberTypes?.includes('bot') ? [{ memberId: 'cli_only', memberType: 'bot' as const, name: 'No OpenId Bot' }] : [],
        hasMore: false, securityLimited: false
      }))
    });
    const { tools, token } = await setup({ cli_current: current });
    await expect(tools.send(token, { to: 'No OpenId Bot', content: '在吗' }))
      .rejects.toMatchObject({ code: 'GROUP_TARGET_NOT_MENTIONABLE', statusCode: 409 });
    await expect(tools.send(token, { content: '<at app_id="cli_peer">Peer Bot</at> 在吗' }))
      .rejects.toMatchObject({ code: 'GROUP_MENTION_ID_INVALID', statusCode: 400 });
    expect(current.sendPost).not.toHaveBeenCalled();
    expect(current.sendText).not.toHaveBeenCalled();
  });

  it('mentions a --to bot only once when the content already carries its inline tag', async () => {
    const current = fakeClient({
      listChatMembers: vi.fn(async input => ({ items: input.memberTypes?.includes('bot') ? [{ memberId: 'ou_peer', openId: 'ou_peer', memberType: 'bot' as const, name: 'Peer Bot' }] : [], hasMore: false, securityLimited: false }))
    });
    const peer = fakeClient({ getBotInfo: vi.fn(async () => ({ appName: 'Peer Bot', openId: 'ou_peer' })) });
    const { tools, token } = await setup({ cli_current: current, cli_peer: peer });
    await expect(tools.send(token, { to: 'cli_peer', content: '<at user_id="ou_peer">Peer Bot</at> 交接给你', idempotencyKey: 'dupe-1' })).resolves.toEqual({ messageId: 'om_sent', chatId: 'oc_group' });
    const elements = current.sendPost.mock.calls[0]![0].content.zh_cn.content[0] as Array<Record<string, string>>;
    expect(elements.filter(element => element.tag === 'at' && element.user_id === 'ou_peer')).toHaveLength(1);
    expect(elements).toEqual([
      { tag: 'at', user_id: 'ou_peer', user_name: 'Peer Bot' },
      { tag: 'text', text: ' 交接给你' }
    ]);
  });

  it('replies with post format when the reply content mentions a bot', async () => {
    const current = fakeClient();
    const { tools, token } = await setup({ cli_current: current });
    await expect(tools.send(token, { content: '<at user_id="ou_peer">Peer Bot</at> 交接给你', replyTo: 'om_topic_root', inThread: true, idempotencyKey: 'post-reply-1' })).resolves.toEqual({ messageId: 'om_reply', chatId: 'oc_group' });
    expect(current.replyPost).toHaveBeenCalledWith({
      messageId: 'om_topic_root',
      content: { zh_cn: { title: '', content: [[{ tag: 'at', user_id: 'ou_peer', user_name: 'Peer Bot' }, { tag: 'text', text: ' 交接给你' }]] } },
      replyInThread: true,
      idempotencyKey: 'post-reply-1'
    });
    expect(current.replyText).not.toHaveBeenCalled();
  });

  it('can deliberately reply inside a topic or start an independent group message', async () => {    const current = fakeClient();
    const { tools, token } = await setup({ cli_current: current });
    await expect(tools.send(token, { content: '话题内结论', replyTo: 'om_topic_root', inThread: true, idempotencyKey: 'thread-1' })).resolves.toEqual({ messageId: 'om_reply', chatId: 'oc_group' });
    expect(current.replyText).toHaveBeenCalledWith({
      messageId: 'om_topic_root', text: '话题内结论', replyInThread: true, idempotencyKey: 'thread-1'
    });
    await expect(tools.send(token, { content: '独立公告', idempotencyKey: 'new-1' })).resolves.toEqual({ messageId: 'om_sent', chatId: 'oc_group' });
    expect(current.sendText).toHaveBeenCalledWith({ chatId: 'oc_group', text: '独立公告', idempotencyKey: 'new-1' });
    await expect(tools.send(token, { content: '缺少目标', inThread: true })).rejects.toMatchObject({ code: 'GROUP_THREAD_REPLY_TARGET_REQUIRED' });
    await expect(tools.send(token, { content: '错误目标', replyTo: 'omt_topic', inThread: true })).rejects.toMatchObject({ code: 'INVALID_GROUP_REPLY_TARGET' });
    expect(current.getMessage).not.toHaveBeenCalledWith('omt_topic');
  });
});
