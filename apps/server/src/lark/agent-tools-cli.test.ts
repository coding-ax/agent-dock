import { describe, expect, it, vi } from 'vitest';
import { AgentGroupToolCliError, runGroupMembers, runGroupMessages, runGroupSend } from './agent-tools-cli.js';

const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe('Agent group tool CLI client', () => {
  it('requires the scoped AgentDock Lark session capability', () => {
    let caught: AgentGroupToolCliError | undefined;
    try { void runGroupMessages({}, { env: {} }); } catch (error) { caught = error as AgentGroupToolCliError; }
    expect(caught).toMatchObject({ error: { code: 'GROUP_TOOL_CONTEXT_REQUIRED' } });
  });

  it('exchanges a capability by session id when the process env has none', async () => {
    const fetcher = vi.fn(async () => response({ chatId: 'oc_handover', messages: [] }));
    const exchangeCapability = vi.fn(async () => ({ url: 'http://127.0.0.1:4310/api/lark/agent-tools/', token: 'issued-token' }));
    await runGroupMessages({}, { env: { agentdock_session_id: 'ses_desktop' }, fetcher: fetcher as typeof fetch, exchangeCapability });
    expect(exchangeCapability).toHaveBeenCalledWith('ses_desktop');
    expect(fetcher).toHaveBeenCalledWith('http://127.0.0.1:4310/api/lark/agent-tools/messages', expect.any(Object));
    expect(new Headers(fetcher.mock.calls[0]![1]?.headers).get('authorization')).toBe('Bearer issued-token');
    const failing = vi.fn(async () => { throw new Error('当前会话没有绑定飞书群'); });
    await expect(runGroupMessages({}, { env: { agentdock_session_id: 'ses_desktop' }, exchangeCapability: failing }))
      .rejects.toMatchObject({ error: { code: 'GROUP_TOOL_CONTEXT_REQUIRED' } });
  });

  it('calls the scoped endpoint without reading or transmitting Lark credentials', async () => {
    const fetcher = vi.fn(async () => response({ chatId: 'oc_group', messages: [] }));
    await runGroupSend('请检查', { to: 'cli_peer', replyTo: 'om_parent', inThread: true, idempotencyKey: 'handoff-1' }, {
      env: {
        agentdock_group_tools_url: 'http://127.0.0.1:4310/api/lark/agent-tools',
        agentdock_group_tools_token: 'capability-token',
        LARK_APP_SECRET: 'must-not-leak'
      },
      fetcher: fetcher as typeof fetch
    });
    expect(fetcher).toHaveBeenCalledWith('http://127.0.0.1:4310/api/lark/agent-tools/send', expect.objectContaining({ method: 'POST' }));
    const request = fetcher.mock.calls[0]!;
    expect(new Headers(request[1]?.headers).get('authorization')).toBe('Bearer capability-token');
    expect(JSON.parse(String(request[1]?.body))).toEqual({ content: '请检查', to: 'cli_peer', replyTo: 'om_parent', inThread: true, idempotencyKey: 'handoff-1' });
    expect(JSON.stringify(request)).not.toContain('must-not-leak');
  });

  it('discovers human members through the same scoped capability', async () => {
    const fetcher = vi.fn(async () => response({ chatId: 'oc_group', members: [{ name: '小王', openId: 'ou_human' }] }));
    await runGroupMembers({
      env: { agentdock_group_tools_url: 'http://127.0.0.1:4310/api/lark/agent-tools', agentdock_group_tools_token: 'capability-token' },
      fetcher: fetcher as typeof fetch
    });
    expect(fetcher).toHaveBeenCalledWith('http://127.0.0.1:4310/api/lark/agent-tools/members', expect.any(Object));
  });

  it('preserves actionable authorization details from the broker', async () => {
    const fetcher = vi.fn(async () => response({ error: {
      code: 'GROUP_TOOL_AUTHORIZATION_REQUIRED', message: '需要管理员授权', instruction: '开通权限并发布版本',
      authorizationUrl: 'https://open.larkoffice.com/app/cli_test/auth', requiredScopes: ['im:message:readonly']
    } }, 403));
    await expect(runGroupMessages({}, {
      env: { AGENTDOCK_GROUP_TOOLS_URL: 'http://127.0.0.1:4310/api/lark/agent-tools', AGENTDOCK_GROUP_TOOLS_TOKEN: 'token' },
      fetcher: fetcher as typeof fetch
    })).rejects.toMatchObject({ error: {
      code: 'GROUP_TOOL_AUTHORIZATION_REQUIRED', instruction: '开通权限并发布版本', requiredScopes: ['im:message:readonly']
    } });
  });
});
