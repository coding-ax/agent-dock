import { describe, expect, it, vi } from 'vitest';
import { boundLarkCardElements, buildChoiceResolvedCard, buildLarkCard, buildLarkOriginSourceBadge, createLarkCardService, ensureLarkCardUpdateMulti, larkCardSafeLimits, larkCardSnapshotLimits, larkConfigurationStatus, larkIdentityPermissionHelp, LarkServiceError, loadLarkBotConfig, updateInteractiveCardWithRetry } from './service.js';

const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const configured = {
  LARK_APP_ID: 'cli_test',
  LARK_APP_SECRET: 'secret_test',
  LARK_RECEIVE_ID: 'user@example.com',
  LARK_RECEIVE_ID_TYPE: 'email',
  LARK_AGENT_NAME: 'Business Agent'
};

describe('Lark card service', () => {
  it('sends a route-choice card with callback values and updates it afterwards', async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(response({ code: 0, tenant_access_token: 'token' }))
      .mockResolvedValueOnce(response({ code: 0, data: { message_id: 'om_card', chat_id: 'oc_1' } }))
      .mockResolvedValueOnce(response({ code: 0, data: { message_id: 'om_card', chat_id: 'oc_1' } }));
    const service = createLarkCardService(configured, fetcher);
    const sent = await service.sendChoiceCard({
      chatId: 'oc_1',
      replyTo: 'om_target',
      title: 'AI 替身 · 表情触发',
      markdown: '这一轮交给谁？',
      buttons: [
        { action: 'avatar_reaction_route', label: '发到主会话', style: 'primary', value: { trigger_id: '8Jr5J_Ztv1NR-dnjlJTf6SHH', route: 'main' } },
        { action: 'avatar_reaction_route', label: '单独处理', value: { trigger_id: '8Jr5J_Ztv1NR-dnjlJTf6SHH', route: 'independent' } }
      ],
      idempotencyKey: 'avatar-reaction-ask:8Jr5J_Ztv1NR-dnjlJTf6SHH'
    });
    expect(sent).toMatchObject({ messageId: 'om_card', chatId: 'oc_1' });
    const [url, init] = fetcher.mock.calls[1] as unknown as [string, RequestInit];
    expect(url).toContain('/open-apis/im/v1/messages/om_target/reply');
    const body = JSON.parse(String(init.body)) as { msg_type: string; content: string; uuid: string };
    expect(body.msg_type).toBe('interactive');
    expect(body.uuid).toBe('avatar-reaction-ask:8Jr5J_Ztv1NR-dnjlJTf6SHH');
    expect(body.uuid.length).toBeLessThanOrEqual(50);
    expect(body.content).toContain('avatar_reaction_route');
    expect(body.content).toContain('trigger_id');
    expect(body.content).toContain('independent');
    // 卡片 2.0 不支持 1.0 的 action 容器；套上它飞书会返回 230099「Failed to create card content」。
    const card = JSON.parse(body.content) as { schema: string; body: { elements: Array<Record<string, any>> } };
    expect(card.schema).toBe('2.0');
    expect(card.body.elements.map(element => element.tag)).not.toContain('action');
    const buttonRow = card.body.elements.find(element => element.tag === 'column_set');
    expect(buttonRow?.columns.flatMap((column: Record<string, any>) => column.elements).map((element: Record<string, any>) => element.tag))
      .toEqual(['button', 'button']);

    await service.updateChoiceCard({ messageId: 'om_card', text: '✅ 已发到主会话' });
    const [patchUrl, patchInit] = fetcher.mock.calls[2] as unknown as [string, RequestInit];
    expect(patchUrl).toContain('/open-apis/im/v1/messages/om_card');
    expect(patchInit.method).toBe('PATCH');
    expect(String(patchInit.body)).toContain('已发到主会话');
  });

  it('rejects an idempotency key that Feishu would refuse instead of sending it', async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(response({ code: 0, tenant_access_token: 'token' }))
      .mockResolvedValueOnce(response({ code: 0, data: { message_id: 'om_card', chat_id: 'oc_1' } }));
    const service = createLarkCardService(configured, fetcher);
    const send = (idempotencyKey: string) => service.sendChoiceCard({
      chatId: 'oc_1', replyTo: 'om_target', title: 'AI 替身 · 表情触发', markdown: '交给谁？',
      buttons: [{ action: 'avatar_reaction_route', label: '发到主会话', value: { trigger_id: 'x', route: 'main' } }],
      idempotencyKey
    });

    // 旧版把含 NUL 的 100 字符账本 key 直接当 uuid：飞书会拒绝，默认 ask 路由完全不可用。
    await expect(send(`avatar-reaction-ask:om_target\u0000ou_me\u0000THUMBSUP`))
      .rejects.toMatchObject({ code: 'INVALID_IDEMPOTENCY_KEY' });
    await expect(send(`avatar-reaction-ask:${'x'.repeat(40)}`))
      .rejects.toMatchObject({ code: 'INVALID_IDEMPOTENCY_KEY' });
    // 41 字符以内的短 id 照常发送。
    await expect(send(`avatar-reaction-ask:${'x'.repeat(24)}`)).resolves.toMatchObject({ messageId: 'om_card' });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it.each(['token', 'body'])('bounds the complete lookup deadline when %s stalls', async phase => {
    vi.useFakeTimers();
    try {
      const fetcher = vi.fn(async () => phase === 'token' ? new Promise<Response>(() => {}) : response({ code: 0, tenant_access_token: 'token' }));
      if (phase === 'body') fetcher.mockResolvedValueOnce(response({ code: 0, tenant_access_token: 'token' })).mockResolvedValueOnce({ ok: true, json: () => new Promise(() => {}) } as Response);
      const service = createLarkCardService(configured, fetcher as typeof fetch);
      const lookup = service.getUserName('ou_slow');
      const assertion = expect(lookup).rejects.toMatchObject({ code: 'LARK_TIMEOUT' });
      await vi.advanceTimersByTimeAsync(3001);
      await assertion;
    } finally { vi.useRealTimers(); }
  });

  it('reads the IM sender name from sender_name and asks for it explicitly', async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(response({ code: 0, tenant_access_token: 'token' }))
      .mockResolvedValueOnce(response({ code: 0, data: { items: [{ message_id: 'om_1', msg_type: 'text', body: { content: '{"text":"原文"}' }, sender: { id: 'ou_a', id_type: 'open_id', sender_type: 'user', sender_name: '邹翔', sender_i18n_names: { zh_cn: '邹翔', en_us: 'Xiang Zou' } } }] } }));
    const service = createLarkCardService(configured, fetcher);
    // 飞书 IM 接口回的是 sender_name（不是 name）；只读 name 会让名字静默丢失，prompt 退化成裸 open_id。
    expect((await service.getMessage('om_1')).sender).toMatchObject({ id: 'ou_a', name: '邹翔' });
    // 单条消息接口默认不回名字，必须显式要；否则发送人不在通讯录可见范围时只能拿到 open_id。
    expect(String((fetcher.mock.calls[1] as unknown[])[0])).toContain('with_sender_name=true');
  });

  it('falls back to sender_i18n_names when sender_name is missing', async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(response({ code: 0, tenant_access_token: 'token' }))
      .mockResolvedValueOnce(response({ code: 0, data: { items: [{ message_id: 'om_2', msg_type: 'text', body: { content: '{"text":"原文"}' }, sender: { id: 'ou_b', sender_type: 'user', sender_i18n_names: { zh_cn: '谢广平', en_us: 'Guangping Xie' } } }] } }));
    const service = createLarkCardService(configured, fetcher);
    expect((await service.getMessage('om_2')).sender).toMatchObject({ id: 'ou_b', name: '谢广平' });
  });

  it('reads updated or deleted messages instead of returning cached quoted content', async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(response({ code: 0, tenant_access_token: 'token' }))
      .mockResolvedValueOnce(response({ code: 0, data: { items: [{ message_id: 'om_1', msg_type: 'text', body: { content: '{"text":"原文"}' } }] } }))
      .mockResolvedValueOnce(response({ code: 0, data: { items: [] } }));
    const service = createLarkCardService(configured, fetcher);
    expect((await service.getMessage('om_1')).rawContent).toContain('原文');
    await expect(service.getMessage('om_1')).rejects.toMatchObject({ code: 'LARK_MESSAGE_NOT_FOUND' });
  });

  const componentCount = (value: unknown): number => Array.isArray(value)
    ? value.reduce((sum, item) => sum + componentCount(item), 0)
    : value && typeof value === 'object'
      ? (typeof (value as any).tag === 'string' ? 1 : 0) + Object.values(value).reduce<number>((sum, item) => sum + componentCount(item), 0)
      : 0;

  it('bounds successful-card snapshots before they are sent and persisted', () => {
    const elements = Array.from({ length: 200 }, (_, index) => ({
      tag: 'collapsible_panel', element_id: `trace_group_${index}`,
      elements: [{ tag: 'markdown', content: `第 ${index} 组 ${'x'.repeat(500)}` }]
    }));
    const bounded = boundLarkCardElements(elements);
    expect(Buffer.byteLength(JSON.stringify(bounded), 'utf8')).toBeLessThanOrEqual(larkCardSnapshotLimits.bytes);
    expect(componentCount(bounded)).toBeLessThanOrEqual(larkCardSnapshotLimits.components);
    expect(JSON.stringify(bounded)).toContain('agentdock_snapshot_omission');
    expect(bounded.length).toBeLessThan(elements.length);
  });
  const components = (value: any): any[] => {
    if (Array.isArray(value)) return value.flatMap(components);
    if (!value || typeof value !== 'object') return [];
    return [...(typeof value.tag === 'string' ? [value] : []), ...Object.values(value).flatMap(components)];
  };
  const byId = (card: any, elementId: string) => components(card).find(element => element.element_id === elementId);
  it('omits retry from a completed Card 2.0 footer', () => {
    const card = buildLarkCard({ agentName: 'Business Agent', state: 'completed', taskName: 'Release', taskId: '42', elapsedSeconds: 65, markdown: '**done**' });
    expect(card.schema).toBe('2.0');
    expect(card.config.style.color).toMatchObject({
      trace_success: { light_mode: expect.stringContaining('92,184,119') },
      trace_failure: { light_mode: expect.stringContaining('208,180,92') },
      trace_running: { light_mode: expect.stringContaining('96,184,232') }
    });
    expect(card.header).toBeUndefined();
    expect(card.body.elements[0].text.content).toContain('Release');
    expect(card.body.elements[0].text.lines).toBe(1);
    expect(card.body.elements[1].text.content).toContain('已完成');
    expect(card.body.elements[1].text.text_size).toBe('small');
    expect(card.body.elements[2].content).toBe('**done**');
    const footer: any = card.body.elements.at(-1);
    expect(footer.columns[0].elements[0].content).toContain('任务 #42 · 已用时 1m 5s');
    expect(footer.columns[0].elements[0].text_size).toBe('x-small');
    expect(footer.columns).toHaveLength(1);
  });

  it('keeps state-specific actions in the top prompt row', () => {
    const queued: any = buildLarkCard({ state: 'queued', taskId: 'queued' });
    const running: any = buildLarkCard({ state: 'running', taskId: 'running' });
    const failed: any = buildLarkCard({ state: 'failed', taskId: 'failed' });
    const interrupted: any = buildLarkCard({ state: 'interrupted', taskId: 'interrupted' });
    expect(byId(queued, 'cancel')).toMatchObject({ text: { content: '取消' }, behaviors: [{ value: { action: 'cancel', task_id: 'queued' } }] });
    expect(byId(queued, 'interrupt')).toBeUndefined();
    expect(byId(queued, 'task_status').text.content).toContain('排队中');
    expect(queued.config).toMatchObject({ streaming_mode: false, summary: { content: expect.stringContaining('排队中') } });
    expect(byId(running, 'interrupt')).toMatchObject({ text: { content: '中断' }, behaviors: [{ value: { action: 'interrupt', task_id: 'running' } }] });
    expect(byId(failed, 'retry')).toMatchObject({ text: { content: '重试' }, behaviors: [{ value: { action: 'retry', task_id: 'failed' } }] });
    expect(byId(failed, 'task_status').text.content).toContain("<text_tag color='yellow'>已失败</text_tag>");
    expect(byId(interrupted, 'task_status').text.content).toContain('已取消');
    expect(byId(interrupted, 'retry')).toMatchObject({ behaviors: [{ value: { action: 'retry', task_id: 'interrupted' } }] });
    expect(byId(running, 'task_action_row')).toBe(running.body.elements[0]);
    expect(running.body.elements.at(-1).columns).toHaveLength(1);
    expect(running.config).toMatchObject({ streaming_mode: true, summary: { content: expect.stringContaining('执行中') } });
    const loading0: any = buildLarkCard({ state: 'running', elapsedSeconds: 0 });
    const loading1: any = buildLarkCard({ state: 'running', elapsedSeconds: 1 });
    expect(loading0.header).toBeUndefined();
    expect(byId(loading0, 'task_status')).toMatchObject({ tag: 'div', icon: { tag: 'standard_icon', token: 'loading_outlined', color: 'grey' } });
    expect(byId(loading0, 'task_status').text.content).toContain('执行中');
    expect(byId(loading0, 'task_status').text.text_size).toBe('small');
    expect(components(buildLarkCard({ state: 'running', taskName: '任务摘要' }).body.elements[0]).find(element => element.text?.content === '任务摘要')?.text.text_size).toBe('notation');
    expect(byId(loading1, 'task_status').icon.token).toBe('loading_outlined');
    const animated: any = buildLarkCard({ state: 'running', loadingImageKey: 'img_loading' });
    expect(byId(animated, 'task_status').icon).toMatchObject({ tag: 'custom_icon', img_key: 'img_loading', size: '20px 20px' });
    expect(failed.config.streaming_mode).toBe(false);
    expect(interrupted.config.streaming_mode).toBe(false);
  });

  it('renders caller-supplied action buttons and clears defaults with an empty list', () => {
    const card: any = buildLarkCard({ state: 'failed', taskId: 'dead', actions: [
      { action: 'retry', label: '重试', style: 'default', elementId: 'retry' },
      { action: 'archive_reopen', label: '归档并重开', style: 'primary', elementId: 'archive_reopen' }
    ] });
    expect(byId(card, 'retry')).toMatchObject({ text: { content: '重试' }, behaviors: [{ value: { action: 'retry', task_id: 'dead' } }] });
    expect(byId(card, 'archive_reopen')).toMatchObject({
      text: { content: '归档并重开' }, type: 'primary',
      behaviors: [{ value: { action: 'archive_reopen', task_id: 'dead' } }]
    });
    const cleared: any = buildLarkCard({ state: 'failed', taskId: 'dead', actions: [] });
    expect(byId(cleared, 'retry')).toBeUndefined();
    expect(byId(cleared, 'archive_reopen')).toBeUndefined();
  });

  it('includes a terminal-state summary preview built from the final output', () => {
    const completed: any = buildLarkCard({
      state: 'completed',
      taskName: 'CR 助手',
      elements: [{ tag: 'markdown', element_id: 'final_output', content: '**MR !1162** CR 完成：无 P0，[已 Approve](https://example.com)，6 条行内评论' }]
    });
    expect(completed.config.summary.content).toBe('CR 助手 · 已完成：MR !1162 CR 完成：无 P0，已 Approve，6 条行内评论');
    const failed: any = buildLarkCard({ state: 'failed', markdown: '任务执行失败：pnpm test 挂了' });
    expect(failed.config.summary.content).toBe('AgentDock · 已失败：任务执行失败：pnpm test 挂了');
    const longText: any = buildLarkCard({ state: 'completed', markdown: '结'.repeat(80) });
    expect(longText.config.summary.content).toHaveLength('AgentDock · 已完成：'.length + 61);
    expect(longText.config.summary.content.endsWith('…')).toBe(true);
  });

  it('pins interrupt above an expanded full-width trace overview', () => {
    const card: any = buildLarkCard({ state: 'running', taskId: 'trace-running', elements: [
      { tag: 'collapsible_panel', element_id: 'trace_group_0', expanded: false, header: { title: { tag: 'markdown', content: '步骤' } }, elements: [] }
    ] });
    expect(card.body.elements[0]).toMatchObject({ tag: 'column_set', element_id: 'task_action_row' });
    expect(components(card.body.elements[0]).some(element => element.element_id === 'trace_overview')).toBe(false);
    expect(card.body.elements[1]).toMatchObject({ tag: 'collapsible_panel', element_id: 'trace_overview', expanded: true });
    expect(byId(card, 'trace_overview')).toMatchObject({ expanded: true, header: { title: { icon: { tag: 'standard_icon', token: 'loading_outlined', color: 'grey' } } } });
    expect(byId(card, 'trace_overview').header.title.content).toContain("<font color='trace_running'>● 执行中</font>");
    expect(byId(card, 'interrupt')).toMatchObject({ behaviors: [{ value: { action: 'interrupt', task_id: 'trace-running' } }] });
    expect(card.body.elements.at(-1).columns).toHaveLength(1);
    const animated: any = buildLarkCard({ state: 'running', taskId: 'trace-animated', loadingImageKey: 'img_bouncing', elements: [
      { tag: 'collapsible_panel', element_id: 'trace_group_0', expanded: false, header: { title: { tag: 'markdown', content: '步骤' } }, elements: [] }
    ] });
    expect(byId(animated, 'trace_overview').header.title.icon).toMatchObject({ tag: 'custom_icon', img_key: 'img_bouncing' });
  });

  it('omits all action buttons from read-only cards', () => {
    for (const state of ['queued', 'running', 'failed', 'interrupted'] as const) {
      const card: any = buildLarkCard({ state, taskId: state, readOnly: true });
      expect(card.config.update_multi).toBe(true);
      expect(card.body.elements[2].columns).toHaveLength(1);
    }
  });

  it('passes CLI Markdown through unchanged for every state', () => {
    const markdown = `### 自定义阶段\n\n${'very-long-command '.repeat(8)}\n\n🟢 业务自行决定展示数量`;
    const card: any = buildLarkCard({ state: 'running', markdown });
    expect(card.header).toBeUndefined();
    expect(card.body.elements.some((element: any) => element.content === markdown)).toBe(true);
  });

  it('renders the user prompt summary as one plain-text line', () => {
    const card: any = buildLarkCard({
      state: 'running',
      taskName: '请完成 Trace 测试：\n1. 执行 pwd\n2. 读取 **package.json**\n3. 输出结论'
    });
    expect(components(card).find(element => element.text?.content === '请完成 Trace 测试： 1. 执行 pwd 2. 读取 **package.json** 3. 输出结论')).toMatchObject({
      tag: 'div', width: 'fill',
      text: {
        tag: 'plain_text',
        content: '请完成 Trace 测试： 1. 执行 pwd 2. 读取 **package.json** 3. 输出结论',
        text_size: 'notation', text_color: 'grey', lines: 1
      }
    });
  });

  it('keeps oversized trace cards below Feishu byte and component safety budgets', () => {
    const groups = Array.from({ length: 20 }, (_, groupIndex) => ({
      tag: 'collapsible_panel', element_id: `trace_group_${groupIndex}`, expanded: false,
      header: { title: { tag: 'markdown', content: `分组 ${groupIndex}` } },
      elements: Array.from({ length: 5 }, (_, toolIndex) => ({
        tag: 'collapsible_panel', element_id: `trace_tool_${groupIndex}_${toolIndex}`, expanded: false,
        header: { title: { tag: 'markdown', content: `工具 ${toolIndex}` } },
        elements: [{ tag: 'markdown', content: '超长工具输出'.repeat(500) }]
      }))
    }));
    const card = buildLarkCard({ state: 'running', elements: [{ tag: 'markdown', content: '**执行过程**' }, ...groups] });
    expect(Buffer.byteLength(JSON.stringify(card), 'utf8')).toBeLessThanOrEqual(larkCardSafeLimits.bytes);
    expect(componentCount(card)).toBeLessThanOrEqual(larkCardSafeLimits.components);
    expect(JSON.stringify(card)).toContain('已省略');
  });

  it('places a compact trace summary before the final output', () => {
    const card: any = buildLarkCard({ state: 'completed', taskName: '检查项目', elapsedSeconds: 97, elements: [
      { tag: 'collapsible_panel', element_id: 'trace_group_0', expanded: false, header: { title: { tag: 'markdown', content: '步骤' } }, elements: [] },
      { tag: 'markdown', element_id: 'final_output', content: '最终结论' }
    ] });
    const overviewIndex = card.body.elements.findIndex((element: any) => element.element_id === 'trace_overview');
    const statusIndex = card.body.elements.findIndex((element: any) => element.element_id === 'task_status');
    const finalIndex = card.body.elements.findIndex((element: any) => element.element_id === 'final_output');
    expect(statusIndex).toBe(-1);
    expect(card.body.elements[overviewIndex]).toMatchObject({ tag: 'collapsible_panel', expanded: false });
    expect(card.body.elements[overviewIndex].header.title.content).toContain('耗时 1m 37s');
    expect(card.body.elements[overviewIndex].header.title.content).toContain('● 已完成');
    expect(card.body.elements[overviewIndex].header.title.content).not.toContain('部分失败');
    expect(card.body.elements[overviewIndex].header.title.content).toContain('1 个阶段');
    expect(card.body.elements[overviewIndex].header.title.text_size).toBe('notation');
    expect(card.body.elements[overviewIndex].header.title.icon).toBeUndefined();
    expect(finalIndex).toBeGreaterThan(overviewIndex);
  });

  it('shows only the actual task terminal state in the trace overview', () => {
    const trace = [{ tag: 'collapsible_panel', element_id: 'trace_group_0', expanded: false, header: { title: { tag: 'markdown', content: "步骤 <font color='orange'>● 部分失败</font>" } }, elements: [] }];
    expect(byId(buildLarkCard({ state: 'completed', elements: trace }), 'trace_overview').header.title.content).toContain('● 已完成');
    expect(byId(buildLarkCard({ state: 'completed', elements: trace }), 'trace_overview').header.title.content).not.toContain('部分失败');
    expect(byId(buildLarkCard({ state: 'failed', elements: trace }), 'trace_overview').header.title.content).toContain('● 已失败');
    expect(byId(buildLarkCard({ state: 'interrupted', elements: trace }), 'trace_overview').header.title.content).toContain('● 已取消');
  });

  it('reports missing bot configuration without exposing secrets', () => {
    expect(larkConfigurationStatus({ LARK_APP_ID: 'cli_test' })).toMatchObject({ configured: false, listening: false, missing: ['LARK_APP_SECRET'], defaultAgentName: 'AgentDock' });
    expect(larkConfigurationStatus({}, { appId: 'cli_input', appSecret: 'secret_input', agentName: 'Input Agent' })).toMatchObject({ configured: true, listening: false, missing: [], defaultAgentName: 'Input Agent' });
    expect(larkConfigurationStatus({ LARK_CHAT_ID: 'oc_group' })).toMatchObject({ defaultReceiveIdConfigured: true, defaultReceiveIdType: 'chat_id' });
  });

  it('loads app credentials directly from environment variables', () => {
    expect(loadLarkBotConfig({ LARK_APP_ID: 'cli_env', LARK_APP_SECRET: 'secret_env' })).toMatchObject({ appId: 'cli_env', appSecret: 'secret_env' });
  });

  it('sends a card and reuses the tenant token for an update', async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(response({ code: 0, tenant_access_token: 'token', expire: 7200 }))
      .mockResolvedValueOnce(response({ code: 0, data: { image_key: 'img_loading' } }))
      .mockResolvedValueOnce(response({ code: 0, data: { message_id: 'om_sent', chat_id: 'oc_chat' } }))
      .mockResolvedValueOnce(response({ code: 0, data: {} }));
    const service = createLarkCardService(configured, fetcher as typeof fetch);
    await expect(service.send({ state: 'running', taskId: '42', markdown: '业务传入的运行态正文', idempotencyKey: 'task-42' })).resolves.toEqual({ messageId: 'om_sent', chatId: 'oc_chat' });
    await expect(service.update({ messageId: 'om_sent', state: 'completed', taskId: '42', markdown: '完成' })).resolves.toEqual({ messageId: 'om_sent', chatId: undefined });
    expect(fetcher).toHaveBeenCalledTimes(4);
    expect(fetcher.mock.calls[1]?.[0]).toContain('/open-apis/im/v1/images');
    const send = fetcher.mock.calls[2];
    expect(send?.[0]).toContain('receive_id_type=email');
    const sendBody = JSON.parse(String(send?.[1]?.body));
    expect(sendBody.receive_id).toBe('user@example.com');
    expect(sendBody.uuid).toBe('task-42');
    const sentCard = JSON.parse(sendBody.content);
    expect(sentCard.header).toBeUndefined();
    expect(byId(sentCard, 'task_status').text.content).toContain('执行中');
    expect(byId(sentCard, 'task_status').icon).toMatchObject({ tag: 'custom_icon', img_key: 'img_loading' });
    expect(byId(sentCard, 'interrupt')).toMatchObject({ behaviors: [{ value: { action: 'interrupt', task_id: '42' } }] });
    const update = fetcher.mock.calls[3];
    expect(update?.[0]).toContain('/open-apis/im/v1/messages/om_sent');
    expect(update?.[1]?.method).toBe('PATCH');
  });

  it('fails clearly when credentials are absent', async () => {
    expect(() => createLarkCardService({})).toThrowError(expect.objectContaining<LarkServiceError>({ code: 'LARK_NOT_CONFIGURED', statusCode: 503 }));
  });

  it('rejects invalid action windows and recipient ID types', async () => {
    const service = createLarkCardService(configured, vi.fn() as unknown as typeof fetch);
    await expect(service.send({ receiveIdType: 'bad' as any })).rejects.toMatchObject({ code: 'INVALID_RECEIVE_ID_TYPE', statusCode: 400 });
    await expect(service.send({ chatId: 'not-a-chat' })).rejects.toMatchObject({ code: 'INVALID_CHAT_ID', statusCode: 400 });
    await expect(service.send({ chatId: 'oc_group', receiveId: 'user@example.com' })).rejects.toMatchObject({ code: 'CONFLICTING_RECIPIENTS', statusCode: 400 });
  });

  it('sends to a group with the chat_id receive type', async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(response({ code: 0, tenant_access_token: 'token', expire: 7200 }))
      .mockResolvedValueOnce(response({ code: 0, data: { message_id: 'om_group', chat_id: 'oc_group' } }));
    const service = createLarkCardService({ LARK_APP_ID: 'cli_test', LARK_APP_SECRET: 'secret_test' }, fetcher as typeof fetch);
    await expect(service.send({ chatId: 'oc_group', state: 'completed', markdown: '群聊消息' })).resolves.toEqual({ messageId: 'om_group', chatId: 'oc_group' });
    expect(fetcher.mock.calls[1]?.[0]).toContain('receive_id_type=chat_id');
    expect(JSON.parse(String(fetcher.mock.calls[1]?.[1]?.body)).receive_id).toBe('oc_group');
  });

  it('replies with an interactive card to the source message', async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(response({ code: 0, tenant_access_token: 'token', expire: 7200 }))
      .mockResolvedValueOnce(response({ code: 0, data: { message_id: 'om_reply', chat_id: 'oc_group' } }));
    const service = createLarkCardService({ LARK_APP_ID: 'cli_test', LARK_APP_SECRET: 'secret_test' }, fetcher as typeof fetch);
    await expect(service.reply({ messageId: 'om_source', replyInThread: true, state: 'completed', taskId: 'task-1', markdown: '话题内回复', idempotencyKey: 'task-1' })).resolves.toEqual({ messageId: 'om_reply', chatId: 'oc_group' });
    expect(fetcher.mock.calls[1]?.[0]).toContain('/open-apis/im/v1/messages/om_source/reply');
    const body = JSON.parse(String(fetcher.mock.calls[1]?.[1]?.body));
    expect(body).toMatchObject({ msg_type: 'interactive', reply_in_thread: true, uuid: 'task-1' });
    expect(byId(JSON.parse(body.content), 'task_status').text.content).toContain('已完成');
  });

  it('adds and removes a reaction through the bot API', async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(response({ code: 0, tenant_access_token: 'token', expire: 7200 }))
      .mockResolvedValueOnce(response({ code: 0, data: { reaction_id: 'reaction-1' } }))
      .mockResolvedValueOnce(response({ code: 0, data: {} }));
    const service = createLarkCardService({ LARK_APP_ID: 'cli_test', LARK_APP_SECRET: 'secret_test' }, fetcher as typeof fetch);
    await expect(service.addReaction('om_input', 'SMILE')).resolves.toEqual({ messageId: 'om_input', reactionId: 'reaction-1', emojiType: 'SMILE' });
    await expect(service.deleteReaction('om_input', 'reaction-1')).resolves.toBeUndefined();
    expect(fetcher.mock.calls[1]?.[0]).toContain('/messages/om_input/reactions');
    expect(fetcher.mock.calls[2]?.[0]).toContain('/messages/om_input/reactions/reaction-1');
    expect(fetcher.mock.calls[2]?.[1]?.method).toBe('DELETE');
  });

  it('downloads a message attachment with the tenant token', async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(response({ code: 0, tenant_access_token: 'token', expire: 7200 }))
      .mockResolvedValueOnce(new Response(new Uint8Array([1, 2, 3]), { headers: { 'content-type': 'image/png' } }));
    const service = createLarkCardService(configured, fetcher as typeof fetch);
    await expect(service.downloadMessageResource('om_input', 'img_1', 'image')).resolves.toEqual({
      data: new Uint8Array([1, 2, 3]), contentType: 'image/png'
    });
    expect(fetcher.mock.calls[1]?.[0]).toContain('/open-apis/im/v1/messages/om_input/resources/img_1?type=image');
    expect(fetcher.mock.calls[1]?.[1]).toMatchObject({ method: 'GET', headers: { authorization: 'Bearer token' } });
  });

  it('keeps resource permission failures actionable', async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(response({ code: 0, tenant_access_token: 'token', expire: 7200 }))
      .mockResolvedValueOnce(response({ code: 99991672, msg: 'Access denied', error: { console_url: 'https://open.feishu.cn/app/auth' } }, 403));
    const service = createLarkCardService(configured, fetcher as typeof fetch);
    await expect(service.downloadMessageResource('om_input', 'file_1', 'file')).rejects.toMatchObject({
      code: 'LARK_RESOURCE_DOWNLOAD_FAILED', details: { upstreamCode: 99991672, consoleUrl: 'https://open.feishu.cn/app/auth' }
    });
  });

  it('resolves the bot open ID used to verify mentions', async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(response({ code: 0, tenant_access_token: 'token', expire: 7200 }))
      .mockResolvedValueOnce(response({ code: 0, bot: { open_id: 'ou_bot' } }));
    const service = createLarkCardService({ LARK_APP_ID: 'cli_test', LARK_APP_SECRET: 'secret_test' }, fetcher as typeof fetch);
    await expect(service.getBotOpenId()).resolves.toBe('ou_bot');
    expect(fetcher.mock.calls[1]?.[0]).toContain('/open-apis/bot/v3/info');
    expect(fetcher.mock.calls[1]?.[1]?.method).toBe('GET');
  });

  it('resolves bot identity and sender emails through official OpenAPI', async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(response({ code: 0, tenant_access_token: 'token', expire: 7200 }))
      .mockResolvedValueOnce(response({ code: 0, bot: { app_name: '超级智慧大脑', open_id: 'ou_bot', avatar_url: 'https://example.com/avatar.png', activate_status: 2 } }))
      .mockResolvedValueOnce(response({ code: 0, data: { user: { email: 'USER@example.com', enterprise_email: 'staff@company.com' } } }));
    const service = createLarkCardService({ LARK_APP_ID: 'cli_test', LARK_APP_SECRET: 'secret_test' }, fetcher as typeof fetch);
    await expect(service.getBotInfo()).resolves.toEqual({ appName: '超级智慧大脑', openId: 'ou_bot', avatarUrl: 'https://example.com/avatar.png', activateStatus: 2 });
    await expect(service.getUserEmails('ou_sender')).resolves.toEqual(['user@example.com', 'staff@company.com']);
    expect(fetcher.mock.calls[1]?.[0]).toContain('/open-apis/bot/v3/info');
    expect(fetcher.mock.calls[2]?.[0]).toContain('/open-apis/contact/v3/users/ou_sender?user_id_type=open_id');
  });

  it('preflights contact data scope and the name and email fields before enabling identity gates', async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(response({ code: 0, tenant_access_token: 'token', expire: 7200 }))
      .mockResolvedValueOnce(response({ code: 0, data: { user_ids: ['ou_sample'] } }))
      .mockResolvedValueOnce(response({ code: 0, data: { user: { name: '谢广平', email: 'SAMPLE@example.com' } } }));
    const service = createLarkCardService({ LARK_APP_ID: 'cli_test', LARK_APP_SECRET: 'secret_test' }, fetcher as typeof fetch);
    await expect(service.checkIdentityResolution()).resolves.toEqual({ verified: true, sampleOpenId: 'ou_sample', sampleName: '谢广平', sampleEmails: ['sample@example.com'] });
    expect(fetcher.mock.calls[1]?.[0]).toContain('/open-apis/contact/v3/scopes?user_id_type=open_id&page_size=100');
    expect(fetcher.mock.calls[2]?.[0]).toContain('/open-apis/contact/v3/users/ou_sample?user_id_type=open_id');
  });

  it('rejects a visible user without a name, because the prompt would silently degrade to the open_id', async () => {
    // 飞书对无权限字段是静默省略：code 为 0，user 里只剩 open_id / union_id / mobile_visible。
    const fetcher = vi.fn()
      .mockResolvedValueOnce(response({ code: 0, tenant_access_token: 'token', expire: 7200 }))
      .mockResolvedValueOnce(response({ code: 0, data: { user_ids: ['ou_sample'] } }))
      .mockResolvedValueOnce(response({ code: 0, data: { user: { open_id: 'ou_sample', union_id: 'on_sample', mobile_visible: true, email: 'sample@example.com' } } }));
    const service = createLarkCardService({ LARK_APP_ID: 'cli_test', LARK_APP_SECRET: 'secret_test' }, fetcher as typeof fetch);
    await expect(service.checkIdentityResolution()).rejects.toMatchObject({ code: 'LARK_USER_NAME_PERMISSION_REQUIRED', statusCode: 409 });
  });

  it('reports the precise missing resource when contact scope cannot yield a test user', async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(response({ code: 0, tenant_access_token: 'token', expire: 7200 }))
      .mockResolvedValueOnce(response({ code: 0, data: { user_ids: [] } }));
    const service = createLarkCardService({ LARK_APP_ID: 'cli_test', LARK_APP_SECRET: 'secret_test' }, fetcher as typeof fetch);
    await expect(service.checkIdentityResolution()).rejects.toMatchObject({ code: 'LARK_CONTACT_DATA_SCOPE_EMPTY', statusCode: 409 });
  });

  it('links identity permission help to the current bot app', () => {
    const help = larkIdentityPermissionHelp(new Error('permission denied'), 'cli_test');
    expect(help).toContain('https://open.larkoffice.com/app/cli_test/auth');
    expect(help).toContain('打开当前机器人的权限配置');
  });

  it('lists the bot groups with real display names for member selection', async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(response({ code: 0, tenant_access_token: 'token', expire: 7200 }))
      .mockResolvedValueOnce(response({ code: 0, data: { items: [{ chat_id: 'oc_group', name: '研发群', description: '项目协作', owner_id: 'ou_owner', external: false, chat_mode: 'group', chat_status: 'normal' }], has_more: false } }));
    const service = createLarkCardService({ LARK_APP_ID: 'cli_test', LARK_APP_SECRET: 'secret_test' }, fetcher as typeof fetch);
    await expect(service.listChats()).resolves.toEqual({
      items: [{ chatId: 'oc_group', name: '研发群', description: '项目协作', ownerId: 'ou_owner', external: false, chatMode: 'group', chatStatus: 'normal' }],
      hasMore: false
    });
    expect(fetcher.mock.calls[1]?.[0]).toContain('/open-apis/im/v1/chats?user_id_type=open_id&page_size=100&sort_type=ByActiveTimeDesc');
  });

  it('rejects an ambiguous typed member name instead of authorizing the wrong open_id', async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(response({ code: 0, tenant_access_token: 'token', expire: 7200 }))
      .mockResolvedValueOnce(response({ code: 0, data: { items: [{ chat_id: 'oc_one', name: '一群', external: false }, { chat_id: 'oc_two', name: '二群', external: false }], has_more: false } }))
      .mockResolvedValueOnce(response({ code: 0, data: { users: [{ member_id: 'ou_first', open_id: 'ou_first', name: '张伟' }], has_more: false } }))
      .mockResolvedValueOnce(response({ code: 0, data: { users: [{ member_id: 'ou_second', open_id: 'ou_second', name: '张伟' }], has_more: false } }));
    const service = createLarkCardService({ LARK_APP_ID: 'cli_test', LARK_APP_SECRET: 'secret_test' }, fetcher as typeof fetch);
    await expect(service.resolveChatUsersByNames(['张伟'])).rejects.toMatchObject({ code: 'LARK_USER_NAME_AMBIGUOUS', statusCode: 409 });
  });

  it('lists group bots and messages, then sends and replies with plain text', async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(response({ code: 0, tenant_access_token: 'token', expire: 7200 }))
      .mockResolvedValueOnce(response({ code: 0, data: { bots: [{ member_id: 'ou_peer', member_id_type: 'open_id', name: 'Peer Bot', app_id: 'cli_peer' }], has_more: false, bot_total: 1, truncations: [{ member_type: 'bot', limit: 100 }] } }))
      .mockResolvedValueOnce(response({ code: 0, data: { items: [{ message_id: 'om_1', chat_id: 'oc_group', msg_type: 'text', create_time: '1000', sender: { id: 'ou_peer', id_type: 'open_id', sender_type: 'app', name: 'Peer Bot' }, body: { content: '{"text":"hello"}' } }], has_more: false } }))
      .mockResolvedValueOnce(response({ code: 0, data: { items: [{ message_id: 'om_1', chat_id: 'oc_group', msg_type: 'text', create_time: '1000', body: { content: '{"text":"hello"}' } }] } }))
      .mockResolvedValueOnce(response({ code: 0, data: { message_id: 'om_sent', chat_id: 'oc_group' } }))
      .mockResolvedValueOnce(response({ code: 0, data: { message_id: 'om_reply', chat_id: 'oc_group' } }));
    const service = createLarkCardService({ LARK_APP_ID: 'cli_test', LARK_APP_SECRET: 'secret_test' }, fetcher as typeof fetch);
    await expect(service.listChatMembers({ chatId: 'oc_group', memberTypes: ['bot'] })).resolves.toMatchObject({
      items: [{ memberId: 'ou_peer', memberType: 'bot', openId: 'ou_peer', appId: 'cli_peer', name: 'Peer Bot' }], hasMore: false, memberTotal: 1, securityLimit: 100, securityLimited: true
    });
    await expect(service.listChatMessages({ chatId: 'oc_group', order: 'desc', pageSize: 20 })).resolves.toMatchObject({
      items: [{ messageId: 'om_1', chatId: 'oc_group', messageType: 'text', rawContent: '{"text":"hello"}', sender: { id: 'ou_peer', type: 'app', name: 'Peer Bot' } }]
    });
    await expect(service.getMessage('om_1')).resolves.toMatchObject({ messageId: 'om_1', chatId: 'oc_group' });
    await expect(service.sendText({ chatId: 'oc_group', text: 'hello', idempotencyKey: 'send-1' })).resolves.toEqual({ messageId: 'om_sent', chatId: 'oc_group' });
    await expect(service.replyText({ messageId: 'om_1', text: 'reply', replyInThread: true, idempotencyKey: 'reply-1' })).resolves.toEqual({ messageId: 'om_reply', chatId: 'oc_group' });
    expect(fetcher.mock.calls[1]?.[0]).toContain('/open-apis/im/v1/chats/oc_group/members/list?member_id_type=open_id&member_types=bot');
    expect(fetcher.mock.calls[2]?.[0]).toContain('/open-apis/im/v1/messages?container_id_type=chat&container_id=oc_group');
    expect(fetcher.mock.calls[3]?.[0]).toContain('/open-apis/im/v1/messages/om_1?user_id_type=open_id');
    expect(JSON.parse(String(fetcher.mock.calls[4]?.[1]?.body))).toEqual({ receive_id: 'oc_group', msg_type: 'text', content: '{"text":"hello"}', uuid: 'send-1' });
    expect(JSON.parse(String(fetcher.mock.calls[5]?.[1]?.body))).toEqual({ msg_type: 'text', content: '{"text":"reply"}', reply_in_thread: true, uuid: 'reply-1' });
  });

  it('includes topic replies when listing group messages', async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(response({ code: 0, tenant_access_token: 'token', expire: 7200 }))
      .mockResolvedValueOnce(response({ code: 0, data: { items: [
        { message_id: 'om_root', chat_id: 'oc_group', msg_type: 'text', create_time: '1000', thread_id: 'omt_topic', body: { content: '{"text":"第一轮"}' } },
        { message_id: 'om_reply', chat_id: 'oc_group', msg_type: 'text', create_time: '2000', thread_id: 'omt_topic', body: { content: '{"text":"第二轮"}' } }
      ], has_more: false } }));
    const service = createLarkCardService({ LARK_APP_ID: 'cli_test', LARK_APP_SECRET: 'secret_test' }, fetcher as typeof fetch);
    const result = await service.listChatMessages({ chatId: 'oc_group', order: 'asc', pageSize: 20 });
    expect(result.items.map(item => ({ messageId: item.messageId, threadId: item.threadId }))).toEqual([
      { messageId: 'om_root', threadId: 'omt_topic' },
      { messageId: 'om_reply', threadId: 'omt_topic' }
    ]);
    const requestUrl = new URL(String(fetcher.mock.calls[1]?.[0]));
    expect(requestUrl.searchParams.get('only_thread_root_messages')).toBe('false');
  });

  it('replies with an interactive card under a message so results land in the thread position', async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(response({ code: 0, tenant_access_token: 'token', expire: 7200 }))
      .mockResolvedValueOnce(response({ code: 0, data: { image_key: 'img_loading' } }))
      .mockResolvedValueOnce(response({ code: 0, data: { message_id: 'om_reply_card', chat_id: 'oc_group' } }));
    const service = createLarkCardService({ LARK_APP_ID: 'cli_test', LARK_APP_SECRET: 'secret_test' }, fetcher as typeof fetch);
    await expect(service.reply({ messageId: 'om_trigger', state: 'running', taskId: 't1', taskName: '任务', idempotencyKey: 'reply-card-1' })).resolves.toEqual({ messageId: 'om_reply_card', chatId: 'oc_group' });
    expect(fetcher.mock.calls[2]?.[0]).toContain('/open-apis/im/v1/messages/om_trigger/reply');
    const body = JSON.parse(String(fetcher.mock.calls[2]?.[1]?.body));
    expect(body.msg_type).toBe('interactive');
    expect(body.uuid).toBe('reply-card-1');
    expect(body).not.toHaveProperty('reply_in_thread');
    expect(body.content).toContain('执行中');
    expect(body.content).toContain('任务');
  });

  it('parses chat name and userCount from getChat', async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(response({ code: 0, tenant_access_token: 'token', expire: 7200 }))
      .mockResolvedValueOnce(response({ code: 0, data: { name: '小A同学 · AgentDock', user_count: '1', bot_count: '1' } }))
      .mockResolvedValueOnce(response({ code: 0, data: { name: '研发大群', user_count: '5' } }))
      .mockResolvedValueOnce(response({ code: 0, data: { name: '未知人数群' } }));
    const service = createLarkCardService({ LARK_APP_ID: 'cli_test', LARK_APP_SECRET: 'secret_test' }, fetcher as typeof fetch);
    await expect(service.getChat('oc_solo')).resolves.toEqual({ chatId: 'oc_solo', name: '小A同学 · AgentDock', userCount: 1 });
    await expect(service.getChat('oc_multi')).resolves.toEqual({ chatId: 'oc_multi', name: '研发大群', userCount: 5 });
    await expect(service.getChat('oc_unknown')).resolves.toEqual({ chatId: 'oc_unknown', name: '未知人数群' });
  });

  it('uploads the bundled kitten PNG as avatar and passes image_key when creating a chat, caching across calls', async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(response({ code: 0, tenant_access_token: 'token', expire: 7200 }))
      .mockResolvedValueOnce(response({ code: 0, data: { image_key: 'img_v3_kitten_avatar' } }))
      .mockResolvedValueOnce(response({ code: 0, data: { chat_id: 'oc_first' } }))
      .mockResolvedValueOnce(response({ code: 0, data: { chat_id: 'oc_second' } }));
    const service = createLarkCardService({ LARK_APP_ID: 'cli_test', LARK_APP_SECRET: 'secret_test' }, fetcher as typeof fetch);

    await expect(service.createChat({ name: '小A同学 · AgentDock', memberOpenIds: ['ou_alice'] })).resolves.toEqual({ chatId: 'oc_first' });
    await expect(service.createChat({ name: '第二群' })).resolves.toEqual({ chatId: 'oc_second' });

    // 只上传一次头像，第二次建群复用缓存的 image_key：token + uploadImage + createChat * 2
    expect(fetcher).toHaveBeenCalledTimes(4);
    expect(String(fetcher.mock.calls[1]?.[0])).toContain('/open-apis/im/v1/images');
    const uploadForm = fetcher.mock.calls[1]?.[1]?.body as FormData;
    expect(uploadForm).toBeInstanceOf(FormData);
    expect(uploadForm.get('image_type')).toBe('avatar');
    const uploadedImage = uploadForm.get('image') as File;
    expect(uploadedImage.type).toBe('image/png');
    const header = new Uint8Array(await uploadedImage.arrayBuffer()).slice(0, 8);
    expect(Array.from(header)).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

    const firstChatBody = JSON.parse(String(fetcher.mock.calls[2]?.[1]?.body));
    expect(firstChatBody).toMatchObject({
      name: '小A同学 · AgentDock',
      chat_mode: 'group',
      chat_type: 'private',
      avatar: 'img_v3_kitten_avatar',
      user_id_list: ['ou_alice']
    });
    const secondChatBody = JSON.parse(String(fetcher.mock.calls[3]?.[1]?.body));
    expect(secondChatBody).toMatchObject({
      name: '第二群',
      avatar: 'img_v3_kitten_avatar'
    });
  });

  it('gracefully creates a chat without avatar when avatar upload fails, and retries on the next chat', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const fetcher = vi.fn()
        .mockResolvedValueOnce(response({ code: 0, tenant_access_token: 'token', expire: 7200 }))
        .mockResolvedValueOnce(response({ code: 99991672, msg: 'no image permission' }, 403))
        .mockResolvedValueOnce(response({ code: 0, data: { chat_id: 'oc_degraded' } }))
        .mockResolvedValueOnce(response({ code: 0, data: { image_key: 'img_v3_retry_ok' } }))
        .mockResolvedValueOnce(response({ code: 0, data: { chat_id: 'oc_recovered' } }));
      const service = createLarkCardService({ LARK_APP_ID: 'cli_test', LARK_APP_SECRET: 'secret_test' }, fetcher as typeof fetch);

      await expect(service.createChat({ name: '降级群' })).resolves.toEqual({ chatId: 'oc_degraded' });
      expect(warn).toHaveBeenCalledTimes(1);
      expect(JSON.parse(String(fetcher.mock.calls[2]?.[1]?.body))).not.toHaveProperty('avatar');

      await expect(service.createChat({ name: '恢复群' })).resolves.toEqual({ chatId: 'oc_recovered' });
      expect(JSON.parse(String(fetcher.mock.calls[4]?.[1]?.body))).toMatchObject({ avatar: 'img_v3_retry_ok' });
    } finally {
      warn.mockRestore();
    }
  });

  it('uses an explicit avatar image_key directly without uploading the default image', async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(response({ code: 0, tenant_access_token: 'token', expire: 7200 }))
      .mockResolvedValueOnce(response({ code: 0, data: { chat_id: 'oc_custom' } }));
    const service = createLarkCardService({ LARK_APP_ID: 'cli_test', LARK_APP_SECRET: 'secret_test' }, fetcher as typeof fetch);

    await expect(service.createChat({ name: '自定义头像群', avatar: 'img_v3_custom' })).resolves.toEqual({ chatId: 'oc_custom' });
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(JSON.parse(String(fetcher.mock.calls[1]?.[1]?.body))).toMatchObject({ avatar: 'img_v3_custom' });
  });

  it('renders unified inline-emoji Lark turquoise source badge in both running and completed cards without outer div.icon', () => {
    const runningCard: any = buildLarkCard({
      state: 'running',
      taskId: 'lark_1',
      taskName: '查一下最新构建日志',
      sourceBadge: buildLarkOriginSourceBadge('zh-CN'),
      locale: 'zh-CN'
    });
    const runningBadge = byId(runningCard, 'task_source_badge');
    expect(runningCard.schema).toBe('2.0');
    expect(runningCard.body.elements[0]).toMatchObject({ tag: 'column_set', element_id: 'task_action_row' });
    expect(runningBadge).toMatchObject({
      tag: 'div',
      element_id: 'task_source_badge'
    });
    expect(runningBadge.icon).toBeUndefined();
    expect(runningBadge.text.content).toContain("<text_tag color='turquoise'>🕊️ 飞书发起</text_tag>");
    expect(runningBadge.text.content).toContain('查一下最新构建日志');
    expect(runningCard.config.summary.content).toBe('[🕊️ 飞书发起] 查一下最新构建日志 · 执行中');

    const completedEn: any = buildLarkCard({
      state: 'completed',
      taskId: 'lark_2',
      taskName: 'Check latest build logs',
      sourceBadge: buildLarkOriginSourceBadge('en-US'),
      markdown: 'All checks passed.',
      locale: 'en-US'
    });
    const completedBadge = byId(completedEn, 'task_source_badge');
    expect(completedBadge).toMatchObject({
      tag: 'div',
      element_id: 'task_source_badge'
    });
    expect(completedBadge.icon).toBeUndefined();
    expect(completedBadge.text.content).toContain("<text_tag color='turquoise'>🕊️ From Lark</text_tag>");
    expect(completedEn.config.summary.content).toContain('[🕊️ From Lark] Check latest build logs · Completed');
  });

  it('sends Lark-origin cards directly with inline 🕊️ turquoise tag and zero extra image upload round-trips', async () => {
    const fetcher = vi.fn()
      // token -> send card -> update card (zero /im/v1/images upload!)
      .mockResolvedValueOnce(response({ code: 0, tenant_access_token: 'token_1', expire: 7200 }))
      .mockResolvedValueOnce(response({ code: 0, data: { message_id: 'om_send_1', chat_id: 'oc_1' } }))
      .mockResolvedValueOnce(response({ code: 0, data: { message_id: 'om_send_1', chat_id: 'oc_1' } }));

    const service = createLarkCardService({ LARK_APP_ID: 'cli_lark_badge', LARK_APP_SECRET: 'secret_test' }, fetcher as typeof fetch);
    await service.send({
      chatId: 'oc_1',
      state: 'completed',
      taskId: 't_1',
      taskName: '飞书提问',
      markdown: '已处理完成',
      sourceBadge: buildLarkOriginSourceBadge('zh-CN')
    });
    await service.update({
      messageId: 'om_send_1',
      state: 'completed',
      taskId: 't_1',
      taskName: '表情触发',
      markdown: '同步完成',
      sourceBadge: buildLarkOriginSourceBadge('zh-CN', 'emoji')
    });

    expect(fetcher).toHaveBeenCalledTimes(3);
    expect(fetcher.mock.calls.some(call => String(call[0]).includes('/open-apis/im/v1/images'))).toBe(false);

    const sendCard = JSON.parse(JSON.parse(String(fetcher.mock.calls[1]?.[1]?.body)).content);
    const updateCard = JSON.parse(JSON.parse(String(fetcher.mock.calls[2]?.[1]?.body)).content);
    expect(byId(sendCard, 'task_source_badge')?.icon).toBeUndefined();
    expect(byId(sendCard, 'task_source_badge')?.text?.content).toContain("<text_tag color='turquoise'>🕊️ 飞书发起</text_tag>");
    expect(byId(updateCard, 'task_source_badge')?.icon).toBeUndefined();
    expect(byId(updateCard, 'task_source_badge')?.text?.content).toContain("<text_tag color='turquoise'>🕊️ 飞书表情</text_tag>");
  });

  it('retries transient/rate-limit errors in updateInteractiveCardWithRetry, stops immediately on 230012/230030 with telemetry, and preserves update_multi', async () => {
    const normalized = ensureLarkCardUpdateMulti({ header: { template: 'green' }, body: { elements: [] } });
    expect(normalized).toMatchObject({ schema: '2.0', config: { update_multi: true } });

    const choiceResolved = buildChoiceResolvedCard({ text: '✅ 已发到主会话。', sourceBadge: buildLarkOriginSourceBadge('zh-CN', 'emoji') });
    expect(choiceResolved).toMatchObject({ schema: '2.0', config: { update_multi: true } });

    // 1) 瞬时限频（230020）自动退避重试成功
    let calls = 0;
    const retryWarnings: Array<Record<string, unknown>> = [];
    const flakyService = {
      updateInteractiveCard: vi.fn(async () => {
        calls += 1;
        if (calls === 1) {
          throw new LarkServiceError('LARK_OPENAPI_ERROR', 'rate limited', 502, { upstreamCode: 230020, httpStatus: 400 });
        }
        return { messageId: 'om_retry_ok' };
      })
    };
    const resOk = await updateInteractiveCardWithRetry({
      service: flakyService,
      messageId: 'om_retry_ok',
      card: { schema: '2.0', body: { elements: [] } },
      baseDelayMs: 0,
      onRetryWarning: details => retryWarnings.push(details)
    });
    expect(resOk).toEqual({ ok: true, usedFallback: false });
    expect(calls).toBe(2);
    expect(retryWarnings).toHaveLength(1);
    expect(retryWarnings[0]).toMatchObject({ upstreamCode: 230020, httpStatus: 400, attempt: 1 });

    // 2) 不可更新错误（230012）立刻停止，不浪费重试，并返回结构化诊断字段
    const unupdatableService = {
      updateInteractiveCard: vi.fn(async () => {
        throw new LarkServiceError('LARK_OPENAPI_ERROR', 'message cannot be updated', 502, { upstreamCode: 230012, httpStatus: 400 });
      })
    };
    const resFail = await updateInteractiveCardWithRetry({
      service: unupdatableService,
      messageId: 'om_expired',
      card: { schema: '2.0', body: { elements: [] } },
      baseDelayMs: 0
    });
    expect(resFail.ok).toBe(false);
    expect(unupdatableService.updateInteractiveCard).toHaveBeenCalledTimes(1);
    if (!resFail.ok) {
      expect(resFail.telemetry).toMatchObject({
        errorCode: 'LARK_OPENAPI_ERROR',
        upstreamCode: 230012,
        httpStatus: 400
      });
    }
  });
});
