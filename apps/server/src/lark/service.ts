import { abortable } from '../abortable.js';
import { readFile } from 'node:fs/promises';
import { sleep } from '../daemon/time.js';
import { webAccessSessionToken } from '../web-access.js';

export const larkCardStates = ['queued', 'running', 'completed', 'failed', 'interrupted'] as const;
export type LarkCardState = (typeof larkCardStates)[number];
export const larkReceiveIdTypes = ['open_id', 'union_id', 'user_id', 'email', 'chat_id'] as const;
export type LarkReceiveIdType = (typeof larkReceiveIdTypes)[number];

export type LarkCardActionButton = {
  action: string;
  label: string;
  style?: 'primary' | 'default' | 'danger';
  elementId?: string;
};

export interface LarkCardInput {
  agentName?: string;
  state?: LarkCardState;
  taskName?: string;
  taskId?: string;
  sessionId?: string;
  webBaseUrl?: string;
  elapsedSeconds?: number;
  markdown?: string;
  elements?: Array<Record<string, unknown>>;
  retryable?: boolean;
  loadingImageKey?: string;
  idempotencyKey?: string;
  readOnly?: boolean;
  /** 显式覆盖卡片操作按钮；传空数组表示不渲染任何按钮。 */
  actions?: LarkCardActionButton[];
}
export interface LarkSendInput extends LarkCardInput { receiveId?: string; receiveIdType?: LarkReceiveIdType; chatId?: string }
export interface LarkReplyInput extends LarkCardInput { messageId: string; replyInThread?: boolean }
export interface LarkUpdateInput extends LarkCardInput { messageId: string }
export interface LarkMessageResult { messageId: string; chatId?: string }
export interface LarkReactionResult { messageId: string; reactionId: string; emojiType: string }
export interface LarkBotInfo { appName: string; openId: string; avatarUrl?: string; activateStatus?: number }
export interface LarkIdentityResolutionCheck { verified: true; sampleOpenId: string; sampleName: string; sampleEmails: string[] }
export interface LarkMessageResourceResult { data: Uint8Array; contentType?: string }
export type LarkChatMemberType = 'user' | 'bot';
export interface LarkChatMember {
  memberId: string;
  memberIdType?: string;
  memberType: LarkChatMemberType;
  name: string;
  tenantKey?: string;
  appId?: string;
  openId?: string;
}
export interface LarkChatMembersInput {
  chatId: string;
  memberTypes?: LarkChatMemberType[];
  pageSize?: number;
  pageToken?: string;
}
export interface LarkChatMembersResult {
  items: LarkChatMember[];
  hasMore: boolean;
  pageToken?: string;
  memberTotal?: number;
  securityLimit?: number;
  securityLimited: boolean;
}
export interface LarkChat {
  chatId: string;
  name: string;
  description?: string;
  ownerId?: string;
  external: boolean;
  chatMode?: string;
  chatStatus?: string;
}
export interface LarkChatsResult {
  items: LarkChat[];
  hasMore: boolean;
  pageToken?: string;
}
export interface LarkResolvedUser { openId: string; name: string }
export interface LarkChatMessageSender { id?: string; idType?: string; type?: string; tenantKey?: string; name?: string }
export interface LarkChatMessageMention { id?: string; idType?: string; key?: string; name?: string; tenantKey?: string }
export interface LarkChatMessage {
  messageId: string;
  chatId?: string;
  messageType: string;
  createTime: string;
  updateTime?: string;
  sender: LarkChatMessageSender;
  rawContent: string;
  mentions: LarkChatMessageMention[];
  deleted: boolean;
  updated: boolean;
  threadId?: string;
  /** 合并转发消息中，上一层级的消息 ID，仅在合并转发场景会有返回值。 */
  upperMessageId?: string;
}
export interface LarkChatMessagesInput {
  chatId?: string;
  /** 传入 threadId 时按话题拉取消息（container_id_type=thread），否则按群拉取。 */
  threadId?: string;
  order?: 'asc' | 'desc';
  pageSize?: number;
  pageToken?: string;
  startTime?: number;
  endTime?: number;
}
export interface LarkChatMessagesResult { items: LarkChatMessage[]; hasMore: boolean; pageToken?: string }
export interface LarkTextMessageInput { text: string; idempotencyKey?: string }
export interface LarkSendTextInput extends LarkTextMessageInput { chatId: string }
export interface LarkReplyTextInput extends LarkTextMessageInput { messageId: string; replyInThread?: boolean }

export interface LarkBotConfig {
  appId: string;
  appSecret: string;
  defaultReceiveId?: string;
  defaultReceiveIdType: LarkReceiveIdType;
  defaultAgentName: string;
  baseUrl: string;
}
export interface LarkBotConfigInput {
  appId?: string;
  appSecret?: string;
  receiveId?: string;
  chatId?: string;
  receiveIdType?: LarkReceiveIdType;
  agentName?: string;
  baseUrl?: string;
}

export interface LarkConfigurationStatus {
  configured: boolean;
  listening: false;
  missing: string[];
  defaultReceiveIdConfigured: boolean;
  defaultReceiveIdType: LarkReceiveIdType;
  defaultAgentName: string;
  baseUrl: string;
}

const statePresentation = {
  queued: { title: '排队中', color: 'grey' },
  running: { title: '正在执行', color: 'wathet' },
  completed: { title: '已完成', color: 'green' },
  failed: { title: '已失败', color: 'yellow' },
  interrupted: { title: '已取消', color: 'grey' }
} as const;
const elapsedLabel = (seconds: number) => {
  const value = Math.max(0, Math.floor(seconds));
  if (value < 60) return `${value}s`;
  const minutes = Math.floor(value / 60);
  const rest = value % 60;
  return rest ? `${minutes}m ${rest}s` : `${minutes}m`;
};
export const larkCardSafeLimits = { bytes: 24 * 1024, components: 180 } as const;
export const larkCardSnapshotLimits = { bytes: 16 * 1024, components: 120 } as const;
const cardBytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value), 'utf8');
const cardComponents = (value: unknown): number => {
  if (Array.isArray(value)) return value.reduce((sum, item) => sum + cardComponents(item), 0);
  if (!value || typeof value !== 'object') return 0;
  const record = value as Record<string, unknown>;
  return (typeof record.tag === 'string' ? 1 : 0) + Object.values(record).reduce<number>((sum, item) => sum + cardComponents(item), 0);
};

export function boundLarkCardElements(elements: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
  const withinLimits = (value: unknown) => cardBytes(value) <= larkCardSnapshotLimits.bytes
    && cardComponents(value) <= larkCardSnapshotLimits.components;
  const omissionNotice = (count: number) => ({
    tag: 'markdown', element_id: 'agentdock_snapshot_omission',
    content: `<font color='grey'>内容较长，已省略 ${count} 个较早执行分组；完整记录请在 AgentDock Web 查看。</font>`,
    text_size: 'x-small', margin: '4px 0px'
  });
  const upsertOmissionNotice = (els: Array<Record<string, unknown>>, count: number) => {
    if (count <= 0) return;
    const notice = omissionNotice(count);
    const index = els.findIndex(element => element.element_id === 'agentdock_snapshot_omission');
    if (index >= 0) els[index] = notice;
    else {
      const firstGroup = els.findIndex(element => typeof element.element_id === 'string' && element.element_id.startsWith('trace_group_'));
      els.splice(firstGroup < 0 ? els.length : firstGroup, 0, notice);
    }
  };
  const stripGroupContent = (group: Record<string, unknown>): boolean => {
    const groupElements = Array.isArray(group.elements) ? group.elements as Array<Record<string, unknown>> : [];
    const thinkingIndex = groupElements.findIndex(el => typeof el.content === 'string' && el.content.includes('思考过程'));
    if (thinkingIndex >= 0) {
      group.elements = groupElements.filter((_, i) => i !== thinkingIndex);
      return true;
    }
    const toolIndex = groupElements.findIndex(el => typeof el.element_id === 'string' && el.element_id.startsWith('trace_tool_') && Array.isArray(el.elements) && el.elements.length > 0);
    if (toolIndex >= 0) {
      const tool = groupElements[toolIndex] as Record<string, unknown>;
      tool.elements = [];
      return true;
    }
    return false;
  };
  const mainElements = [...elements];
  let omittedGroups = 0;
  while (true) {
    const candidate = [...mainElements];
    if (withinLimits(candidate)) return candidate;
    const groupIndex = mainElements.findIndex(element => typeof element.element_id === 'string' && element.element_id.startsWith('trace_group_'));
    if (groupIndex < 0) {
      const fallbackText = String((mainElements.find(element => element.element_id === 'final_output') as any)?.content
        ?? (mainElements.find(element => element.tag === 'markdown') as any)?.content ?? '内容过长');
      return [
        { tag: 'markdown', element_id: 'final_output', content: fallbackText.length > 4_000 ? `${fallbackText.slice(0, 3_999)}…` : fallbackText, text_align: 'left', text_size: 'normal_v2', margin: '0px' },
        { tag: 'markdown', element_id: 'agentdock_snapshot_omission', content: "<font color='grey'>卡片内容超过飞书限制，过程记录已收起；完整记录请在 AgentDock Web 查看。</font>", text_size: 'x-small', margin: '8px 0px 0px 0px' }
      ];
    }
    const group = mainElements[groupIndex] as Record<string, unknown>;
    const groupElements = Array.isArray(group.elements) ? group.elements as Array<Record<string, unknown>> : [];
    const remainingGroups = mainElements.filter(element => typeof element.element_id === 'string' && element.element_id.startsWith('trace_group_')).length;
    // 优先从最旧分组中剥离内容（思考过程、工具输入输出），保留分组结构；
    // 仅当分组已无内容可剥离时，才删除整个分组。
    if (remainingGroups > 1 && stripGroupContent(group)) continue;
    // 只剩一个 trace 分组时，优先从分组内部移除最旧的子元素，保留最近的活动，避免整组被丢弃后用户什么都看不到。
    if (remainingGroups === 1 && groupElements.length > 1) {
      group.elements = groupElements.slice(1);
      continue;
    }
    mainElements.splice(groupIndex, 1);
    omittedGroups++;
    upsertOmissionNotice(mainElements, omittedGroups);
  }
}
const required = (value: string | undefined, name: string) => {
  const resolved = value?.trim();
  if (!resolved) throw new LarkServiceError('LARK_NOT_CONFIGURED', `Missing required configuration: ${name}`, 503);
  return resolved;
};

// 发送人姓名缓存：取到名字后按小时级缓存；取不到时只短暂缓存，避免权限补齐后长时间仍显示 open_id。
const userNameCacheTtlMs = 60 * 60 * 1000;
const emptyUserNameCacheTtlMs = 5 * 60 * 1000;

const imageMimeFromFilename = (filename: string) => {
  const ext = filename.toLowerCase().split('.').pop() || '';
  const mime: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', bmp: 'image/bmp', svg: 'image/svg+xml' };
  return mime[ext] ?? 'application/octet-stream';
};

// config.summary 是飞书会话列表/通知栏展示的卡片预览（纯文本，不渲染 markdown）。
// 终态也必须带：否则列表会一直停在最后一帧运行态摘要（“AgentDock · 执行中”）。
const summaryPreviewLength = 60;
function markdownToPlainPreview(raw: string | undefined): string {
  if (!raw) return '';
  const text = raw
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/<br\s*\/?>(?=[\s\S])/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/^>+\s?/gm, '')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/[*_~]+/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return text.length > summaryPreviewLength ? `${text.slice(0, summaryPreviewLength)}…` : text;
}

function receiveIdType(value: string | undefined): LarkReceiveIdType {
  const resolved = value?.trim() || 'email';
  if (!(larkReceiveIdTypes as readonly string[]).includes(resolved)) {
    throw new LarkServiceError('INVALID_RECEIVE_ID_TYPE', `Unsupported Lark receive ID type: ${resolved}`, 400);
  }
  return resolved as LarkReceiveIdType;
}

export function larkConfigurationStatus(env: NodeJS.ProcessEnv = process.env, input: LarkBotConfigInput = {}): LarkConfigurationStatus {
  const defaultChatId = input.chatId?.trim() || env.LARK_CHAT_ID?.trim();
  const missing = [
    !input.appId?.trim() && !env.LARK_APP_ID?.trim() ? 'LARK_APP_ID' : undefined,
    !input.appSecret?.trim() && !env.LARK_APP_SECRET?.trim() ? 'LARK_APP_SECRET' : undefined
  ].filter((name): name is string => Boolean(name));
  return {
    configured: missing.length === 0,
    listening: false,
    missing,
    defaultReceiveIdConfigured: Boolean(defaultChatId || input.receiveId?.trim() || env.LARK_RECEIVE_ID?.trim()),
    defaultReceiveIdType: defaultChatId ? 'chat_id' : receiveIdType(input.receiveIdType ?? env.LARK_RECEIVE_ID_TYPE),
    defaultAgentName: input.agentName?.trim() || env.LARK_AGENT_NAME?.trim() || 'AgentDock',
    baseUrl: (input.baseUrl?.trim() || env.LARK_OPEN_API_BASE_URL?.trim() || 'https://open.feishu.cn').replace(/\/$/, '')
  };
}

export function loadLarkBotConfig(env: NodeJS.ProcessEnv = process.env, input: LarkBotConfigInput = {}): LarkBotConfig {
  const status = larkConfigurationStatus(env, input);
  return {
    appId: required(input.appId ?? env.LARK_APP_ID, 'LARK_APP_ID or appId'),
    appSecret: required(input.appSecret ?? env.LARK_APP_SECRET, 'LARK_APP_SECRET or appSecret'),
    defaultReceiveId: input.chatId?.trim() || env.LARK_CHAT_ID?.trim() || input.receiveId?.trim() || env.LARK_RECEIVE_ID?.trim() || undefined,
    defaultReceiveIdType: status.defaultReceiveIdType,
    defaultAgentName: status.defaultAgentName,
    baseUrl: status.baseUrl
  };
}

export function buildLarkCard(input: LarkCardInput = {}) {
  const state = input.state ?? 'running';
  const presentation = statePresentation[state];
  if (!presentation) throw new LarkServiceError('INVALID_CARD_STATE', `Unsupported Lark card state: ${String(state)}`, 400);
  const taskName = input.taskName?.trim() || 'AgentDock';
  const taskId = String(input.taskId ?? Date.now()).trim();
  const elapsedSeconds = Number(input.elapsedSeconds ?? 0);
  if (!Number.isFinite(elapsedSeconds) || elapsedSeconds < 0) throw new LarkServiceError('INVALID_ELAPSED_SECONDS', 'elapsedSeconds must be a non-negative number', 400);
  const content = input.markdown !== undefined ? String(input.markdown) : state === 'completed' ? '任务已完成。' : '';
  const liveTitle = state === 'running' ? '执行中' : presentation.title;
  const defaultActionButton = !input.readOnly && state === 'queued' ? {
    tag: 'button', text: { tag: 'plain_text', content: '取消' }, type: 'default', size: 'small',
    behaviors: [{ type: 'callback', value: { action: 'cancel', task_id: taskId } }],
    margin: '0px', element_id: 'cancel'
  } : !input.readOnly && state === 'running' ? {
    tag: 'button', text: { tag: 'plain_text', content: '中断' }, type: 'danger', size: 'small',
    behaviors: [{ type: 'callback', value: { action: 'interrupt', task_id: taskId } }],
    margin: '0px', element_id: 'interrupt'
  } : !input.readOnly && (state === 'failed' || state === 'interrupted') && input.retryable !== false ? {
    tag: 'button', text: { tag: 'plain_text', content: '重试' }, type: 'primary', size: 'small',
    behaviors: [{ type: 'callback', value: { action: 'retry', task_id: taskId } }],
    margin: '0px', element_id: 'retry'
  } : undefined;
  // input.actions 一旦传入就以它为准（哪怕是空数组，用来清掉按钮）；否则回退到默认单按钮。
  const actionButtons = input.actions !== undefined
    ? input.actions.map(item => ({
        tag: 'button', text: { tag: 'plain_text', content: item.label }, type: item.style ?? 'default', size: 'small',
        behaviors: [{ type: 'callback', value: { action: item.action, task_id: taskId } }],
        margin: '0px', element_id: item.elementId ?? item.action
      }))
    : defaultActionButton ? [defaultActionButton] : [];
  const footerColumns: any[] = [{
    tag: 'column', width: 'weighted', weight: 1, vertical_align: 'center',
    elements: [{ tag: 'markdown', content: `<font color='grey'>任务 #${taskId} · 已用时 ${elapsedLabel(elapsedSeconds)}</font>`, text_size: 'x-small', margin: '0px' }]
  }];
  if (input.webBaseUrl) {
    let traceUrl = input.sessionId ? `${input.webBaseUrl}/sessions/${input.sessionId}` : `${input.webBaseUrl}/sessions`;
    // 本地 Web 有访问门：卡片链接必须携带按会话签名的短期 token，否则点开就是 401。
    const accessToken = input.sessionId ? webAccessSessionToken(input.sessionId) : undefined;
    if (accessToken) traceUrl += `?t=${accessToken}`;
    footerColumns.push({
      tag: 'column', width: 'auto', vertical_align: 'center',
      elements: [{
        tag: 'markdown',
        content: `<font color='grey'>[查看详情](${traceUrl})</font>`,
        text_size: 'x-small', margin: '0px'
      }]
    });
  }
  const sourceMainElements = input.elements?.length
    ? input.elements
    : [{ tag: 'markdown', content, text_align: 'left', text_size: 'normal_v2', margin: '0px' }];
  const arrange = (mainElements: Array<Record<string, unknown>>) => {
    const finalElements = mainElements.filter(element => element.element_id === 'final_output');
    const traceElements = mainElements.filter(element => typeof element.element_id === 'string' && element.element_id.startsWith('trace_group_'));
    const otherElements = mainElements.filter(element => element.element_id !== 'final_output' && !(typeof element.element_id === 'string' && element.element_id.startsWith('trace_group_')));
    const statusContent = `<text_tag color='${presentation.color}'>${liveTitle}</text_tag>　${elapsedLabel(elapsedSeconds)}`;
    const loadingIcon = input.loadingImageKey
      ? { tag: 'custom_icon', img_key: input.loadingImageKey, size: '20px 20px' }
      : { tag: 'standard_icon', token: 'loading_outlined', color: 'grey', size: '14px 14px' };
    const overviewLoadingIcon = input.loadingImageKey
      ? { tag: 'custom_icon', img_key: input.loadingImageKey }
      : { tag: 'standard_icon', token: 'loading_outlined', color: 'grey' };
    const statusElement = {
      tag: 'div', element_id: 'task_status', width: 'auto', margin: '0px',
      text: { tag: 'lark_md', content: statusContent, text_size: 'small' },
      ...(state === 'running' ? { icon: loadingIcon } : {})
    };
    const traceOverview = traceElements.length ? [{
      tag: 'collapsible_panel', element_id: 'trace_overview', expanded: state === 'running',
      direction: 'vertical', vertical_spacing: '2px', padding: '2px 0px 0px 0px', margin: '0px',
      header: {
        title: {
          tag: 'markdown', content: `${state === 'running' ? '已耗时' : '耗时'} ${elapsedLabel(elapsedSeconds)}　<font color='${state === 'running' ? 'trace_running' : state === 'failed' ? 'trace_failure' : presentation.color}'>● ${liveTitle}</font>　<font color='grey'>${traceElements.length} 个阶段</font>`, text_size: 'notation',
          ...(state === 'running' ? { icon: overviewLoadingIcon } : {})
        },
        vertical_align: 'center', icon: { tag: 'standard_icon', token: 'down-small-ccm_outlined', color: 'grey', size: '14px 14px' },
        icon_position: 'right', icon_expanded_angle: -180
      },
      elements: traceElements
    }] : [];
    const compactTaskName = taskName.replace(/\s+/g, ' ').trim();
    const taskSummary = taskName === 'AgentDock' ? [] : [{
      tag: 'div', width: 'fill', margin: '0px 0px 4px 0px',
      text: { tag: 'plain_text', content: compactTaskName, text_size: 'notation', text_color: 'grey', lines: 1 }
    }];
    const finals = finalElements.map(element => ({ ...element, margin: traceElements.length || otherElements.length ? '10px 0px 0px 0px' : '8px 0px 0px 0px' }));
    const primaryStatus = traceElements.length ? traceOverview[0] : statusElement;
    const actionSummary = taskSummary[0] ? { ...taskSummary[0], margin: '0px' } : {
      tag: 'div', width: 'fill', margin: '0px',
      text: { tag: 'plain_text', content: compactTaskName || 'AgentDock', text_size: 'notation', text_color: 'grey', lines: 1 }
    };
    const taskHeader = actionButtons.length ? [{
      tag: 'column_set', element_id: 'task_action_row', flex_mode: 'none', horizontal_spacing: '8px', vertical_align: 'center', margin: '0px',
      columns: [
        { tag: 'column', width: 'weighted', weight: 1, vertical_align: 'center', elements: [actionSummary] },
        { tag: 'column', width: 'auto', vertical_align: 'center', elements: actionButtons }
      ]
    }] : taskSummary;
    return [...taskHeader, primaryStatus, ...otherElements, ...finals];
  };
  // 终态摘要优先取 final_output 元素文本；没有时（如纯状态卡片）回落到 markdown 正文。
  const finalRaw = input.elements?.find(element => element.element_id === 'final_output')?.content;
  const summaryContent = state === 'running' || state === 'queued'
    ? `${taskName} · ${liveTitle}`
    : (() => {
        const snippet = markdownToPlainPreview(typeof finalRaw === 'string' ? finalRaw : content);
        return snippet ? `${taskName} · ${liveTitle}：${snippet}` : `${taskName} · ${liveTitle}`;
      })();
  const assemble = (mainElements: Array<Record<string, unknown>>) => ({
    schema: '2.0',
    config: {
      update_multi: true,
      width_mode: 'default',
      streaming_mode: state === 'running',
      style: { color: {
        trace_success: { light_mode: 'rgba(92,184,119,1)', dark_mode: 'rgba(118,204,142,1)' },
        trace_failure: { light_mode: 'rgba(208,180,92,1)', dark_mode: 'rgba(226,202,124,1)' },
        trace_running: { light_mode: 'rgba(96,184,232,1)', dark_mode: 'rgba(124,202,248,1)' }
      } },
      summary: { content: summaryContent }
    },
    body: {
      direction: 'vertical', vertical_spacing: '2px', padding: '8px 12px 10px 12px',
      elements: [
        ...arrange(mainElements),
        {
          tag: 'column_set', flex_mode: 'none', horizontal_spacing: '8px', margin: '6px 0px 0px 0px',
          columns: footerColumns
        }
      ]
    }
  });
  const withinLimits = (card: unknown) => cardBytes(card) <= larkCardSafeLimits.bytes && cardComponents(card) <= larkCardSafeLimits.components;
  const omissionNotice = (count: number) => ({
    tag: 'markdown', element_id: 'agentdock_omission',
    content: `<font color='grey'>内容较长，已省略 ${count} 个较早执行分组；完整记录请在 AgentDock Web 查看。</font>`,
    text_size: 'x-small', margin: '4px 0px'
  });
  const upsertOmissionNotice = (elements: Array<Record<string, unknown>>, count: number) => {
    if (count <= 0) return;
    const notice = omissionNotice(count);
    const index = elements.findIndex(element => element.element_id === 'agentdock_omission');
    if (index >= 0) elements[index] = notice;
    else {
      const firstGroup = elements.findIndex(element => typeof element.element_id === 'string' && element.element_id.startsWith('trace_group_'));
      elements.splice(firstGroup < 0 ? elements.length : firstGroup, 0, notice);
    }
  };
  const stripGroupContent = (group: Record<string, unknown>): boolean => {
    const groupElements = Array.isArray(group.elements) ? group.elements as Array<Record<string, unknown>> : [];
    // 1. 先移除思考过程元素
    const thinkingIndex = groupElements.findIndex(el => typeof el.content === 'string' && el.content.includes('思考过程'));
    if (thinkingIndex >= 0) {
      group.elements = groupElements.filter((_, i) => i !== thinkingIndex);
      return true;
    }
    // 2. 再移除工具的输入/输出内容，仅保留工具标题
    const toolIndex = groupElements.findIndex(el => typeof el.element_id === 'string' && el.element_id.startsWith('trace_tool_') && Array.isArray(el.elements) && el.elements.length > 0);
    if (toolIndex >= 0) {
      const tool = groupElements[toolIndex] as Record<string, unknown>;
      tool.elements = [];
      return true;
    }
    return false;
  };
  let mainElements = [...sourceMainElements];
  let omittedGroups = 0;
  let card = assemble(mainElements);
  while (!withinLimits(card)) {
    const groupIndex = mainElements.findIndex(element => typeof element.element_id === 'string' && element.element_id.startsWith('trace_group_'));
    if (groupIndex < 0) break;
    const group = mainElements[groupIndex] as Record<string, unknown>;
    const groupElements = Array.isArray(group.elements) ? group.elements as Array<Record<string, unknown>> : [];
    const remainingGroups = mainElements.filter(element => typeof element.element_id === 'string' && element.element_id.startsWith('trace_group_')).length;
    // 优先从最旧分组中剥离内容（思考过程、工具输入输出），保留分组结构；
    // 仅当分组已无内容可剥离时，才删除整个分组。
    if (remainingGroups > 1 && stripGroupContent(group)) {
      card = assemble(mainElements);
      continue;
    }
    // 只剩一个 trace 分组时，优先从分组内部移除最旧的子元素，保留最近的活动。
    if (remainingGroups === 1 && groupElements.length > 1) {
      group.elements = groupElements.slice(1);
    } else {
      mainElements.splice(groupIndex, 1);
      omittedGroups++;
      upsertOmissionNotice(mainElements, omittedGroups);
    }
    card = assemble(mainElements);
  }
  if (withinLimits(card)) return card;
  const fallbackText = String((sourceMainElements.find(element => element.element_id === 'final_output') as any)?.content ?? (sourceMainElements.find(element => element.tag === 'markdown') as any)?.content ?? content ?? '内容过长');
  return assemble([
    { tag: 'markdown', content: fallbackText.length > 4_000 ? `${fallbackText.slice(0, 3_999)}…` : fallbackText, text_align: 'left', text_size: 'normal_v2', margin: '0px' },
    { tag: 'markdown', content: "<font color='grey'>卡片内容超过飞书限制，过程记录已收起；完整记录请在 AgentDock Web 查看。</font>", text_size: 'x-small', margin: '8px 0px 0px 0px' }
  ]);
}

export class LarkServiceError extends Error {
  constructor(public readonly code: string, message: string, public readonly statusCode = 400, public readonly details?: Record<string, unknown>) {
    super(message); this.name = 'LarkServiceError';
  }
}

export const larkIdentityPermissionHelp = (error?: unknown, appId?: string) => {
  const detail = error instanceof Error ? `\n\n飞书返回：${error.message}` : '';
  const consoleUrl = error instanceof LarkServiceError && typeof error.details?.consoleUrl === 'string'
    ? `\n\n[前往飞书开放平台处理权限](${error.details.consoleUrl})`
    : '';
  const permissionUrl = appId ? `\n\n[打开当前机器人的权限配置](https://open.larkoffice.com/app/${encodeURIComponent(appId)}/auth)` : '';
  return `**无法解析发送人身份，Agent 已停止本轮执行。**${detail}\n\n请为机器人开通以下资源点：\n- API：\`GET /open-apis/contact/v3/users/:open_id\`\n- 权限：\`contact:contact.base:readonly\`（通讯录基本信息）\n- 权限：\`contact:user.base:readonly\`（用户基本信息）\n- 权限：\`contact:user.email:readonly\`（用户邮箱信息）\n- 数据权限：应用通讯录可见范围必须包含当前发送人${consoleUrl}${permissionUrl}`;
};

type Fetch = typeof globalThis.fetch;

export class LarkCardService {
  private token?: string;
  private tokenExpiresAt = 0;
  private loadingImageKey?: string;
  private loadingImagePromise?: Promise<string | undefined>;
  private readonly userNameCache = new Map<string, { name: string; expiresAt: number }>();

  constructor(private readonly config: LarkBotConfig, private readonly fetcher: Fetch = globalThis.fetch) {}

  private async cardInput<T extends LarkCardInput>(input: T): Promise<T> {
    if ((input.state ?? 'running') !== 'running') return input;
    const loadingImageKey = await this.ensureLoadingImageKey();
    return loadingImageKey ? { ...input, loadingImageKey } : input;
  }

  private ensureLoadingImageKey() {
    if (this.loadingImageKey) return Promise.resolve(this.loadingImageKey);
    if (this.loadingImagePromise) return this.loadingImagePromise;
    this.loadingImagePromise = (async () => {
      try {
        const form = new FormData();
        form.append('image_type', 'message');
        form.append('image', new Blob([await readFile(new URL('./assets/agentdock-bouncing-ball.webp', import.meta.url))], { type: 'image/webp' }), 'agentdock-bouncing-ball.webp');
        const response = await this.fetcher(`${this.config.baseUrl}/open-apis/im/v1/images`, {
          method: 'POST', headers: { authorization: `Bearer ${await this.tenantToken()}` }, body: form
        });
        const payload: any = await response.json();
        if (!response.ok || Number(payload.code ?? 0) !== 0 || !payload.data?.image_key) return undefined;
        this.loadingImageKey = String(payload.data.image_key);
        return this.loadingImageKey;
      } catch { return undefined; }
    })();
    return this.loadingImagePromise;
  }

  async send(input: LarkSendInput): Promise<LarkMessageResult> {
    if (input.chatId && input.receiveId) throw new LarkServiceError('CONFLICTING_RECIPIENTS', 'chatId and receiveId cannot be used together', 400);
    const chatId = input.chatId?.trim();
    if (chatId && !chatId.startsWith('oc_')) throw new LarkServiceError('INVALID_CHAT_ID', 'chatId must start with oc_', 400);
    const receiveId = required(chatId ?? input.receiveId ?? this.config.defaultReceiveId, 'chatId, receiveId, LARK_CHAT_ID, or LARK_RECEIVE_ID');
    const resolvedReceiveIdType = receiveIdType(chatId ? 'chat_id' : input.receiveIdType ?? this.config.defaultReceiveIdType);
    const cardInput = await this.cardInput(input);
    const payload = await this.request(`/open-apis/im/v1/messages?receive_id_type=${encodeURIComponent(resolvedReceiveIdType)}`, {
      body: {
        receive_id: receiveId,
        msg_type: 'interactive',
        content: JSON.stringify(buildLarkCard({ ...cardInput, agentName: input.agentName ?? this.config.defaultAgentName })),
        ...(input.idempotencyKey?.trim() ? { uuid: input.idempotencyKey.trim() } : {})
      }
    });
    const messageId = payload.data?.message_id;
    if (!messageId) throw new LarkServiceError('INVALID_LARK_RESPONSE', 'Lark send response did not include message_id', 502);
    return { messageId, chatId: payload.data?.chat_id };
  }

  async reply(input: LarkReplyInput): Promise<LarkMessageResult> {
    const messageId = required(input.messageId, 'messageId');
    const cardInput = await this.cardInput(input);
    // messageId 必须是 om_* 消息 ID；话题回复通过 reply_in_thread 显式声明，不能把 omt_* thread_id 当成 messageId。
    const payload = await this.request(`/open-apis/im/v1/messages/${encodeURIComponent(messageId)}/reply`, {
      body: {
        msg_type: 'interactive',
        content: JSON.stringify(buildLarkCard({ ...cardInput, agentName: input.agentName ?? this.config.defaultAgentName })),
        ...(input.replyInThread ? { reply_in_thread: true } : {}),
        ...(input.idempotencyKey?.trim() ? { uuid: input.idempotencyKey.trim() } : {})
      }
    });
    const replyId = payload.data?.message_id;
    if (!replyId) throw new LarkServiceError('INVALID_LARK_RESPONSE', 'Lark reply response did not include message_id', 502);
    return { messageId: replyId, chatId: payload.data?.chat_id };
  }

  async update(input: LarkUpdateInput): Promise<LarkMessageResult> {
    const messageId = required(input.messageId, 'messageId');
    const cardInput = await this.cardInput(input);
    const payload = await this.request(`/open-apis/im/v1/messages/${encodeURIComponent(messageId)}`, {
      method: 'PATCH', body: { content: JSON.stringify(buildLarkCard({ ...cardInput, taskId: input.taskId ?? messageId, agentName: input.agentName ?? this.config.defaultAgentName })) }
    });
    return { messageId: payload.data?.message_id || messageId, chatId: payload.data?.chat_id };
  }

  /**
   * 创建群聊并把机器人放进群（机器人即群主），可选拉人。
   * 用于「托管给机器人」：建群后把该群与某个 AgentDock 会话绑定，群消息即驱动该会话。
   */
  async createChat(input: { name: string; memberOpenIds?: string[] }): Promise<{ chatId: string }> {
    const name = input.name.trim();
    if (!name) throw new LarkServiceError('INVALID_CHAT_NAME', 'chat name is required', 400);
    const memberOpenIds = (input.memberOpenIds ?? []).map(id => id.trim()).filter(id => id.startsWith('ou_'));
    const payload = await this.request('/open-apis/im/v1/chats?user_id_type=open_id', {
      body: {
        name,
        chat_mode: 'group',
        chat_type: 'private',
        ...(memberOpenIds.length ? { user_id_list: memberOpenIds } : {})
      }
    });
    const chatId = String(payload.data?.chat_id ?? '').trim();
    if (!chatId.startsWith('oc_')) throw new LarkServiceError('INVALID_LARK_RESPONSE', 'create chat response did not include chat_id', 502);
    return { chatId };
  }

  /**
   * 单群信息：问指定 chatId 拿群名。
   *
   * 和 `listChats` 的关键差别是**不受「机器人所在群列表」的缓存、分页和范围影响**：注入里
   * 「当前群聊」的名字必须可靠，而群列表那条路径有 5 分钟 TTL，新建的托管群在那之前根本
   * 不在里面。失败向上抛，由调用方决定降级，这里不返回空壳结果掩盖故障。
   */
  async getChat(chatId: string): Promise<{ chatId: string; name?: string } | undefined> {
    const id = chatId.trim();
    if (!id.startsWith('oc_')) return undefined;
    const payload = await this.request(`/open-apis/im/v1/chats/${encodeURIComponent(id)}?user_id_type=open_id`, { method: 'GET' });
    const name = String(payload.data?.name ?? '').trim();
    return { chatId: id, ...(name ? { name } : {}) };
  }

  async listChats(pageToken?: string): Promise<LarkChatsResult> {
    const query = new URLSearchParams({ user_id_type: 'open_id', page_size: '100', sort_type: 'ByActiveTimeDesc' });
    if (pageToken) query.set('page_token', pageToken);
    const payload = await this.request(`/open-apis/im/v1/chats?${query}`, { method: 'GET' });
    const items = (Array.isArray(payload.data?.items) ? payload.data.items : []).flatMap((item: any): LarkChat[] => {
      const chatId = String(item.chat_id ?? '').trim();
      if (!chatId.startsWith('oc_')) return [];
      const description = String(item.description ?? '').trim() || undefined;
      const ownerId = String(item.owner_id ?? '').trim() || undefined;
      const chatMode = String(item.chat_mode ?? '').trim() || undefined;
      const chatStatus = String(item.chat_status ?? '').trim() || undefined;
      return [{
        chatId,
        name: String(item.name ?? '').trim() || chatId,
        ...(description ? { description } : {}),
        ...(ownerId ? { ownerId } : {}),
        external: item.external === true,
        ...(chatMode ? { chatMode } : {}),
        ...(chatStatus ? { chatStatus } : {})
      }];
    });
    const nextPageToken = String(payload.data?.page_token ?? '').trim() || undefined;
    return { items, hasMore: payload.data?.has_more === true, ...(nextPageToken ? { pageToken: nextPageToken } : {}) };
  }

  async listChatMembers(input: LarkChatMembersInput): Promise<LarkChatMembersResult> {
    const chatId = required(input.chatId, 'chatId');
    if (!chatId.startsWith('oc_')) throw new LarkServiceError('INVALID_CHAT_ID', 'chatId must start with oc_', 400);
    const pageSize = Math.min(100, Math.max(1, Math.floor(input.pageSize ?? 100)));
    const memberTypes: LarkChatMemberType[] = input.memberTypes?.length ? [...new Set(input.memberTypes)] : ['user', 'bot'];
    if (memberTypes.some(type => type !== 'user' && type !== 'bot')) throw new LarkServiceError('INVALID_MEMBER_TYPE', 'memberTypes must contain only user or bot', 400);
    const query = new URLSearchParams({ member_id_type: 'open_id', member_types: memberTypes.join(','), page_size: String(pageSize) });
    if (input.pageToken) query.set('page_token', input.pageToken);
    const payload = await this.request(`/open-apis/im/v1/chats/${encodeURIComponent(chatId)}/members/list?${query}`, { method: 'GET' });
    const users = Array.isArray(payload.data?.users) ? payload.data.users.map((item: any) => ({ ...item, member_type: 'user' })) : [];
    const bots = Array.isArray(payload.data?.bots) ? payload.data.bots.map((item: any) => ({ ...item, member_type: 'bot' })) : [];
    const rawItems = users.length || bots.length ? [...users, ...bots] : Array.isArray(payload.data?.items) ? payload.data.items : [];
    const fallbackType = memberTypes.length === 1 ? memberTypes[0] : undefined;
    const items = rawItems.flatMap((item: any): LarkChatMember[] => {
      const memberId = String(item.member_id ?? item.open_id ?? '').trim();
      if (!memberId) return [];
      const memberType = String(item.member_type ?? fallbackType ?? (item.app_id ? 'bot' : 'user')) as LarkChatMemberType;
      if (memberType !== 'user' && memberType !== 'bot') return [];
      const openId = String(item.open_id ?? (memberId.startsWith('ou_') ? memberId : '')).trim() || undefined;
      const appId = String(item.app_id ?? '').trim() || undefined;
      const memberIdType = String(item.member_id_type ?? '').trim() || undefined;
      const tenantKey = String(item.tenant_key ?? '').trim() || undefined;
      return [{ memberId, memberType, name: String(item.name ?? appId ?? memberId), ...(memberIdType ? { memberIdType } : {}), ...(tenantKey ? { tenantKey } : {}), ...(appId ? { appId } : {}), ...(openId ? { openId } : {}) }];
    });
    const pageToken = String(payload.data?.page_token ?? '').trim() || undefined;
    const directTotal = Number(payload.data?.member_total);
    const userTotal = Number(payload.data?.user_total);
    const botTotal = Number(payload.data?.bot_total);
    const bucketTotals = [userTotal, botTotal].filter(Number.isFinite);
    const memberTotal = Number.isFinite(directTotal) ? directTotal : bucketTotals.length ? bucketTotals.reduce((sum, total) => sum + total, 0) : undefined;
    const truncations = Array.isArray(payload.data?.truncations) ? payload.data.truncations : [];
    const securityLimit = Number(payload.data?.security_conf_limit ?? truncations.map((item: any) => Number(item?.limit)).filter(Number.isFinite).sort((left: number, right: number) => right - left)[0]);
    return {
      items,
      hasMore: payload.data?.has_more === true,
      ...(pageToken ? { pageToken } : {}),
      ...(Number.isFinite(memberTotal) ? { memberTotal } : {}),
      ...(Number.isFinite(securityLimit) ? { securityLimit } : {}),
      securityLimited: payload.data?.trigger_security_conf_limit === true || truncations.length > 0
    };
  }

  async resolveChatUsersByNames(inputNames: string[], memberTypes: LarkChatMemberType[] = ['user']): Promise<LarkResolvedUser[]> {
    const names = [...new Map(inputNames.map(value => String(value).trim()).filter(Boolean).map(name => [name.normalize('NFKC').toLocaleLowerCase(), name])).values()];
    if (names.length > 50) throw new LarkServiceError('LARK_TOO_MANY_USER_NAMES', '一次最多解析 50 个成员姓名', 400);
    if (!names.length) return [];
    const requested = new Map(names.map(name => [name.normalize('NFKC').toLocaleLowerCase(), name]));
    const matches = new Map([...requested.keys()].map(key => [key, new Map<string, LarkResolvedUser>()]));
    let chatPageToken: string | undefined;
    let chatPages = 0;
    let memberPageRequests = 0;
    do {
      if (++chatPages > 10) throw new LarkServiceError('LARK_NAME_RESOLUTION_LIMIT', '机器人所在群过多，无法安全完成姓名解析', 409);
      const chats = await this.listChats(chatPageToken);
      for (const chat of chats.items) {
        let memberPageToken: string | undefined;
        do {
          if (++memberPageRequests > 500) throw new LarkServiceError('LARK_NAME_RESOLUTION_LIMIT', '群成员数据过多，无法安全完成姓名解析', 409);
          const members = await this.listChatMembers({ chatId: chat.chatId, memberTypes, pageSize: 100, ...(memberPageToken ? { pageToken: memberPageToken } : {}) });
          if (members.securityLimited) throw new LarkServiceError('LARK_MEMBER_LIST_TRUNCATED', `群“${chat.name}”的成员列表被飞书安全策略截断，无法可靠解析姓名`, 409);
          for (const member of members.items) {
            const key = member.name.trim().normalize('NFKC').toLocaleLowerCase();
            const openId = member.openId ?? (member.memberId.startsWith('ou_') ? member.memberId : undefined);
            if (openId && matches.has(key)) matches.get(key)!.set(openId, { openId, name: member.name.trim() || requested.get(key)! });
          }
          if (members.hasMore && !members.pageToken) throw new LarkServiceError('LARK_PAGINATION_ERROR', '飞书返回了不完整的群成员分页信息', 502);
          memberPageToken = members.hasMore ? members.pageToken : undefined;
        } while (memberPageToken);
      }
      if (chats.hasMore && !chats.pageToken) throw new LarkServiceError('LARK_PAGINATION_ERROR', '飞书返回了不完整的群聊分页信息', 502);
      chatPageToken = chats.hasMore ? chats.pageToken : undefined;
    } while (chatPageToken);
    const missing = [...requested].filter(([key]) => !matches.get(key)?.size).map(([, name]) => name);
    if (missing.length) throw new LarkServiceError('LARK_USER_NAME_NOT_FOUND', `机器人所在群中找不到成员：${missing.join('、')}`, 409);
    const ambiguous = [...requested].filter(([key]) => (matches.get(key)?.size ?? 0) > 1).map(([, name]) => name);
    if (ambiguous.length) throw new LarkServiceError('LARK_USER_NAME_AMBIGUOUS', `以下姓名对应多个不同成员，无法安全选择：${ambiguous.join('、')}`, 409);
    return [...requested.keys()].map(key => [...matches.get(key)!.values()][0]!);
  }

  private normalizeMessageItem(item: any): LarkChatMessage | undefined {
    const messageId = String(item?.message_id ?? '').trim();
    if (!messageId) return undefined;
    const sender = item?.sender && typeof item.sender === 'object' ? item.sender : {};
    // 飞书 IM 接口开 with_sender_name 后回的是 `sender_name` / `sender_i18n_names`，
    // 不是 `name`。只读 name 会让所有 IM 来源的名字被静默丢掉，prompt 里只剩裸 open_id。
    const senderNames = sender.sender_i18n_names && typeof sender.sender_i18n_names === 'object' ? sender.sender_i18n_names : {};
    const senderName = String(sender.name ?? sender.sender_name ?? senderNames.zh_cn ?? senderNames.en_us ?? '').trim();
    const normalizedSender: LarkChatMessageSender = {
      ...(sender.id ? { id: String(sender.id) } : {}),
      ...(sender.id_type ? { idType: String(sender.id_type) } : {}),
      ...(sender.sender_type ? { type: String(sender.sender_type) } : {}),
      ...(sender.tenant_key ? { tenantKey: String(sender.tenant_key) } : {}),
      ...(senderName ? { name: senderName } : {})
    };
    const mentions = (Array.isArray(item?.mentions) ? item.mentions : []).map((mention: any): LarkChatMessageMention => ({
      ...(mention.id ? { id: String(mention.id) } : {}),
      ...(mention.id_type ? { idType: String(mention.id_type) } : {}),
      ...(mention.key ? { key: String(mention.key) } : {}),
      ...(mention.name ? { name: String(mention.name) } : {}),
      ...(mention.tenant_key ? { tenantKey: String(mention.tenant_key) } : {})
    }));
    const updateTime = String(item?.update_time ?? '').trim() || undefined;
    const threadId = String(item?.thread_id ?? '').trim() || undefined;
    const itemChatId = String(item?.chat_id ?? '').trim() || undefined;
    const upperMessageId = String(item?.upper_message_id ?? '').trim() || undefined;
    return {
      messageId, messageType: String(item?.msg_type ?? 'unknown'), createTime: String(item?.create_time ?? '0'),
      sender: normalizedSender, rawContent: String(item?.body?.content ?? item?.content ?? ''), mentions,
      deleted: item?.deleted === true, updated: item?.updated === true,
      ...(itemChatId ? { chatId: itemChatId } : {}), ...(updateTime ? { updateTime } : {}), ...(threadId ? { threadId } : {}),
      ...(upperMessageId ? { upperMessageId } : {})
    };
  }

  async listChatMessages(input: LarkChatMessagesInput): Promise<LarkChatMessagesResult> {
    const threadId = input.threadId?.trim();
    const chatId = input.chatId?.trim();
    // 话题消息优先按 thread 拉取，确保上下文限定在当前话题内；否则按群拉取。
    const containerIdType = threadId ? 'thread' : 'chat';
    const containerId = threadId ?? chatId;
    if (!containerId) throw new LarkServiceError('INVALID_CONTAINER_ID', 'chatId or threadId is required', 400);
    if (containerIdType === 'chat' && !containerId.startsWith('oc_')) throw new LarkServiceError('INVALID_CHAT_ID', 'chatId must start with oc_', 400);
    if (containerIdType === 'thread' && !containerId.startsWith('omt_')) throw new LarkServiceError('INVALID_THREAD_ID', 'threadId must start with omt_', 400);
    const pageSize = Math.min(50, Math.max(1, Math.floor(input.pageSize ?? 50)));
    const query = new URLSearchParams({
      container_id_type: containerIdType, container_id: containerId, page_size: String(pageSize),
      sort_type: input.order === 'asc' ? 'ByCreateTimeAsc' : 'ByCreateTimeDesc',
      // 群协作需要看到话题内的连续回复；只取 root 会让后续轮次从 messages/wait 中永久消失。
      only_thread_root_messages: 'false', with_sender_name: 'true', card_msg_content_type: 'raw_card_content'
    });
    if (input.pageToken) query.set('page_token', input.pageToken);
    if (Number.isFinite(input.startTime)) query.set('start_time', String(Math.max(0, Math.floor(input.startTime!))));
    if (Number.isFinite(input.endTime)) query.set('end_time', String(Math.max(0, Math.floor(input.endTime!))));
    const payload = await this.request(`/open-apis/im/v1/messages?${query}`, { method: 'GET' });
    const rawItems = Array.isArray(payload.data?.items) ? payload.data.items : [];
    const items = rawItems.map((item: any) => this.normalizeMessageItem(item)).filter((item: LarkChatMessage | undefined): item is LarkChatMessage => Boolean(item));
    const pageToken = String(payload.data?.page_token ?? '').trim() || undefined;
    return { items, hasMore: payload.data?.has_more === true, ...(pageToken ? { pageToken } : {}) };
  }

  async getMessage(messageId: string): Promise<LarkChatMessage> {
    const resolvedMessageId = required(messageId, 'messageId');
    const items = await this.getMessageItems(resolvedMessageId);
    const first = items[0];
    if (!first) throw new LarkServiceError('LARK_MESSAGE_NOT_FOUND', `Message ${resolvedMessageId} not found`, 404);
    return first;
  }

  /**
   * 获取指定消息的全部 items。
   * 对于普通消息，items 仅包含该消息本身；
   * 对于合并转发（merge_forward）消息，items[0] 为合并转发消息本身，其余为被转发的子消息。
   */
  async getMessageItems(messageId: string): Promise<LarkChatMessage[]> {
    const resolvedMessageId = required(messageId, 'messageId');
    // with_sender_name：单条消息默认只回 sender.id。走 IM 接口要名字，比查通讯录可靠——
    // 发送人不在应用通讯录可见范围时 contact 接口会直接 41050，而 IM 接口照样回 sender_name。
    const payload = await this.request(`/open-apis/im/v1/messages/${encodeURIComponent(resolvedMessageId)}?user_id_type=open_id&with_sender_name=true&card_msg_content_type=raw_card_content`, { method: 'GET', timeoutMs: 3000 });
    const rawItems = Array.isArray(payload.data?.items) ? payload.data.items : (payload.data?.message ? [payload.data.message] : []);
    return rawItems.map((item: any) => this.normalizeMessageItem(item)).filter((item: LarkChatMessage | undefined): item is LarkChatMessage => Boolean(item));
  }

  async sendText(input: LarkSendTextInput): Promise<LarkMessageResult> {
    const chatId = required(input.chatId, 'chatId');
    if (!chatId.startsWith('oc_')) throw new LarkServiceError('INVALID_CHAT_ID', 'chatId must start with oc_', 400);
    const payload = await this.request('/open-apis/im/v1/messages?receive_id_type=chat_id', {
      body: { receive_id: chatId, msg_type: 'text', content: JSON.stringify({ text: required(input.text, 'text') }), ...(input.idempotencyKey ? { uuid: input.idempotencyKey } : {}) }
    });
    const messageId = payload.data?.message_id;
    if (!messageId) throw new LarkServiceError('INVALID_LARK_RESPONSE', 'Lark send response did not include message_id', 502);
    return { messageId, chatId: payload.data?.chat_id ?? chatId };
  }

  async replyText(input: LarkReplyTextInput): Promise<LarkMessageResult> {
    const messageId = required(input.messageId, 'messageId');
    const payload = await this.request(`/open-apis/im/v1/messages/${encodeURIComponent(messageId)}/reply`, {
      body: {
        msg_type: 'text', content: JSON.stringify({ text: required(input.text, 'text') }),
        ...(input.replyInThread ? { reply_in_thread: true } : {}),
        ...(input.idempotencyKey ? { uuid: input.idempotencyKey } : {})
      }
    });
    const replyId = payload.data?.message_id;
    if (!replyId) throw new LarkServiceError('INVALID_LARK_RESPONSE', 'Lark reply response did not include message_id', 502);
    return { messageId: replyId, chatId: payload.data?.chat_id };
  }

  async sendPost(input: { chatId: string; content: unknown; idempotencyKey?: string }): Promise<LarkMessageResult> {
    const chatId = required(input.chatId, 'chatId');
    if (!chatId.startsWith('oc_')) throw new LarkServiceError('INVALID_CHAT_ID', 'chatId must start with oc_', 400);
    const payload = await this.request('/open-apis/im/v1/messages?receive_id_type=chat_id', {
      body: { receive_id: chatId, msg_type: 'post', content: JSON.stringify(input.content ?? (() => { throw new LarkServiceError('INVALID_POST_CONTENT', 'post content is required', 400); })()), ...(input.idempotencyKey ? { uuid: input.idempotencyKey } : {}) }
    });
    const messageId = payload.data?.message_id;
    if (!messageId) throw new LarkServiceError('INVALID_LARK_RESPONSE', 'Lark send response did not include message_id', 502);
    return { messageId, chatId: payload.data?.chat_id ?? chatId };
  }

  async replyPost(input: { messageId: string; content: unknown; replyInThread?: boolean; idempotencyKey?: string }): Promise<LarkMessageResult> {
    const resolvedMessageId = required(input.messageId, 'messageId');
    const payload = await this.request(`/open-apis/im/v1/messages/${encodeURIComponent(resolvedMessageId)}/reply`, {
      body: {
        msg_type: 'post', content: JSON.stringify(input.content ?? (() => { throw new LarkServiceError('INVALID_POST_CONTENT', 'post content is required', 400); })()),
        ...(input.replyInThread ? { reply_in_thread: true } : {}),
        ...(input.idempotencyKey ? { uuid: input.idempotencyKey } : {})
      }
    });
    const replyId = payload.data?.message_id;
    if (!replyId) throw new LarkServiceError('INVALID_LARK_RESPONSE', 'Lark reply response did not include message_id', 502);
    return { messageId: replyId, chatId: payload.data?.chat_id };
  }

  /** 上传图片为「消息」类型资源，返回飞书 image_key，供 image 消息或 post 内嵌 img 元素使用。 */
  async uploadImage(bytes: Uint8Array, filename = 'image.png'): Promise<string> {
    if (!bytes.length) throw new LarkServiceError('INVALID_IMAGE', '要发送的图片内容为空。', 400);
    const form = new FormData();
    form.append('image_type', 'message');
    const mime = imageMimeFromFilename(filename);
    form.append('image', new Blob([bytes], { type: mime }), filename);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 30_000);
    try {
      const response = await this.fetcher(`${this.config.baseUrl}/open-apis/im/v1/images`, {
        method: 'POST', headers: { authorization: `Bearer ${await this.tenantToken(controller.signal)}` }, body: form, signal: controller.signal
      });
      const payload: any = await response.json().catch(() => ({}));
      if (!response.ok || Number(payload.code ?? 0) !== 0 || !payload.data?.image_key) {
        throw new LarkServiceError('LARK_IMAGE_UPLOAD_FAILED', `上传图片到飞书失败：${payload.msg || payload.message || `HTTP ${response.status}`}（code: ${payload.code ?? 'HTTP_ERROR'}）`, 502);
      }
      return String(payload.data.image_key);
    } catch (error) {
      if (controller.signal.aborted) throw new LarkServiceError('LARK_TIMEOUT', '上传图片超时，请稍后重试。', 504);
      if (error instanceof LarkServiceError) throw error;
      throw new LarkServiceError('LARK_NETWORK_ERROR', `上传图片失败：${error instanceof Error ? error.message : String(error)}`, 502);
    } finally {
      clearTimeout(timer);
    }
  }

  async sendImage(input: { chatId: string; imageKey: string; idempotencyKey?: string }): Promise<LarkMessageResult> {
    const chatId = required(input.chatId, 'chatId');
    if (!chatId.startsWith('oc_')) throw new LarkServiceError('INVALID_CHAT_ID', 'chatId must start with oc_', 400);
    const payload = await this.request('/open-apis/im/v1/messages?receive_id_type=chat_id', {
      body: { receive_id: chatId, msg_type: 'image', content: JSON.stringify({ image_key: required(input.imageKey, 'imageKey') }), ...(input.idempotencyKey ? { uuid: input.idempotencyKey } : {}) }
    });
    const messageId = payload.data?.message_id;
    if (!messageId) throw new LarkServiceError('INVALID_LARK_RESPONSE', 'Lark send response did not include message_id', 502);
    return { messageId, chatId: payload.data?.chat_id ?? chatId };
  }

  async replyImage(input: { messageId: string; imageKey: string; replyInThread?: boolean; idempotencyKey?: string }): Promise<LarkMessageResult> {
    const messageId = required(input.messageId, 'messageId');
    const payload = await this.request(`/open-apis/im/v1/messages/${encodeURIComponent(messageId)}/reply`, {
      body: {
        msg_type: 'image', content: JSON.stringify({ image_key: required(input.imageKey, 'imageKey') }),
        ...(input.replyInThread ? { reply_in_thread: true } : {}),
        ...(input.idempotencyKey ? { uuid: input.idempotencyKey } : {})
      }
    });
    const replyId = payload.data?.message_id;
    if (!replyId) throw new LarkServiceError('INVALID_LARK_RESPONSE', 'Lark reply response did not include message_id', 502);
    return { messageId: replyId, chatId: payload.data?.chat_id };
  }

  async addReaction(messageId: string, emojiType: string): Promise<LarkReactionResult> {
    const resolvedMessageId = required(messageId, 'messageId');
    const resolvedEmojiType = required(emojiType, 'emojiType');
    const payload = await this.request(`/open-apis/im/v1/messages/${encodeURIComponent(resolvedMessageId)}/reactions`, {
      body: { reaction_type: { emoji_type: resolvedEmojiType } }
    });
    const reactionId = payload.data?.reaction_id;
    if (!reactionId) throw new LarkServiceError('INVALID_LARK_RESPONSE', 'Lark reaction response did not include reaction_id', 502);
    return { messageId: resolvedMessageId, reactionId, emojiType: resolvedEmojiType };
  }

  async deleteReaction(messageId: string, reactionId: string): Promise<void> {
    await this.request(`/open-apis/im/v1/messages/${encodeURIComponent(required(messageId, 'messageId'))}/reactions/${encodeURIComponent(required(reactionId, 'reactionId'))}`, {
      method: 'DELETE'
    });
  }

  async downloadMessageResource(messageId: string, fileKey: string, type: 'image' | 'file'): Promise<LarkMessageResourceResult> {
    const resolvedMessageId = required(messageId, 'messageId');
    const resolvedFileKey = required(fileKey, 'fileKey');
    const url = `${this.config.baseUrl}/open-apis/im/v1/messages/${encodeURIComponent(resolvedMessageId)}/resources/${encodeURIComponent(resolvedFileKey)}?type=${type}`;
    // 飞书消息资源下载接口偶发返回 5xx（如 code 40007 的内部错误），属于服务端瞬时故障，
    // 做有限次退避重试，避免把瞬时抖动误判为权限或附件问题。
    const maxAttempts = 3;
    let lastError: unknown;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      let response: Response;
      try {
        response = await this.fetcher(url, {
          method: 'GET', headers: { authorization: `Bearer ${await this.tenantToken()}` }
        });
      } catch (error) {
        lastError = error;
        if (attempt < maxAttempts) {
          await sleep(500 * attempt);
          continue;
        }
        throw new LarkServiceError('LARK_NETWORK_ERROR', `Lark message resource download failed: ${error instanceof Error ? error.message : String(error)}`, 502);
      }
      if (response.ok) {
        const contentType = response.headers.get('content-type')?.split(';')[0]?.trim() || undefined;
        return { data: new Uint8Array(await response.arrayBuffer()), ...(contentType ? { contentType } : {}) };
      }
      const payload = await response.json().catch(() => ({})) as any;
      const message = payload.msg || payload.message || `${response.status} ${response.statusText}`;
      const violation = Array.isArray(payload.error?.permission_violations) ? payload.error.permission_violations[0] : undefined;
      const consoleUrl = payload.error?.console_url ?? payload.console_url ?? violation?.url;
      const upstreamCode = payload.code ?? 'HTTP_ERROR';
      // 仅对 5xx 服务端错误重试；4xx（权限、参数、资源不存在等）直接抛出，避免无意义重试。
      const retryable = response.status >= 500 && response.status < 600;
      if (retryable && attempt < maxAttempts) {
        lastError = { response, payload };
        await sleep(500 * attempt);
        continue;
      }
      throw new LarkServiceError('LARK_RESOURCE_DOWNLOAD_FAILED', `Lark message resource download failed: ${message} (code: ${upstreamCode})`, 502, {
        upstreamCode,
        httpStatus: response.status,
        ...(consoleUrl ? { consoleUrl: String(consoleUrl) } : {}),
        ...(payload.error?.permission_violations ? { permissionViolations: payload.error.permission_violations } : {})
      });
    }
    // 理论上不会走到这里；兜底抛出最后一次错误。
    throw lastError instanceof Error ? lastError : new LarkServiceError('LARK_RESOURCE_DOWNLOAD_FAILED', 'Lark message resource download failed after retries', 502);
  }

  async getBotOpenId(): Promise<string> {
    const payload = await this.request('/open-apis/bot/v3/info', { method: 'GET', timeoutMs: 3000 });
    return required(payload.bot?.open_id, 'bot.open_id');
  }

  async getBotInfo(): Promise<LarkBotInfo> {
    const payload = await this.request('/open-apis/bot/v3/info', { method: 'GET', timeoutMs: 3000 });
    return {
      appName: required(payload.bot?.app_name, 'bot.app_name'),
      openId: required(payload.bot?.open_id, 'bot.open_id'),
      ...(payload.bot?.avatar_url ? { avatarUrl: String(payload.bot.avatar_url) } : {}),
      ...(Number.isFinite(Number(payload.bot?.activate_status)) ? { activateStatus: Number(payload.bot.activate_status) } : {})
    };
  }

  async getUserEmails(openId: string): Promise<string[]> {
    const payload = await this.request(`/open-apis/contact/v3/users/${encodeURIComponent(required(openId, 'openId'))}?user_id_type=open_id`, { method: 'GET' });
    const user = payload.data?.user ?? {};
    return [...new Set([user.email, user.enterprise_email].map(value => String(value ?? '').trim().toLowerCase()).filter(Boolean))];
  }

  /**
   * 读取本应用的创建者/所有者（用于「托管」默认邀请人：机器人 + 创建者自己）。
   * 走 application/v6 应用信息接口；owner.owner_id 用 user_id_type=open_id 取。
   */
  async getAppOwner(): Promise<{ openId?: string; ownerType?: string }> {
    const payload = await this.request(`/open-apis/application/v6/applications/${encodeURIComponent(this.config.appId)}?lang=zh_cn&user_id_type=open_id`, { method: 'GET', timeoutMs: 5_000 });
    const app = (payload.data?.app ?? payload.data ?? {}) as Record<string, any>;
    const owner = (app.owner ?? app.owner_info ?? {}) as Record<string, any>;
    const ownerId = String(owner.owner_id ?? owner.ownerId ?? owner.id ?? '').trim();
    const ownerType = String(owner.owner_type ?? owner.ownerType ?? owner.type ?? '').trim() || undefined;
    return { ...(ownerId.startsWith('ou_') ? { openId: ownerId } : {}), ...(ownerType ? { ownerType } : {}) };
  }

  /** 取用户姓名 + 头像（托管弹窗选人展示用）。取不到头像就只回姓名。 */
  async getUserProfile(openId: string): Promise<{ name: string; avatarUrl?: string }> {
    const payload = await this.request(`/open-apis/contact/v3/users/${encodeURIComponent(required(openId, 'openId'))}?user_id_type=open_id`, { method: 'GET', timeoutMs: 3_000 });
    const user = (payload.data?.user ?? {}) as Record<string, any>;
    const name = String(user.name ?? '').trim() || openId;
    // v3 用户信息里头像是嵌套对象：avatar.avatar_72/240/640/origin。取最小的 72 够用。
    const avatar = (user.avatar ?? {}) as Record<string, any>;
    const avatarUrl = String(avatar.avatar_72 ?? avatar.avatar_240 ?? avatar.avatar_640 ?? avatar.avatar_origin ?? user.avatar_url ?? '').trim() || undefined;
    return { name, ...(avatarUrl ? { avatarUrl } : {}) };
  }

  async getUserName(openId: string): Promise<string> {
    const cached = this.userNameCache.get(openId);
    if (cached && cached.expiresAt > Date.now()) return cached.name;
    const payload = await this.request(`/open-apis/contact/v3/users/${encodeURIComponent(required(openId, 'openId'))}?user_id_type=open_id`, { method: 'GET', timeoutMs: 3000 });
    const name = String(payload.data?.user?.name ?? '').trim();
    // 用户名变更频率低，取到名字缓存 1 小时。
    // 取不到姓名时飞书不报错、只是省略 name 字段（应用缺少 contact:user.base:readonly，
    // 或该用户不在应用通讯录可见范围内），这种情况下只缓存 5 分钟：长缓存会把权限补齐后的
    // 恢复拖到一小时，表现成「偶发失败」，极难排查。
    const ttl = name ? userNameCacheTtlMs : emptyUserNameCacheTtlMs;
    if (this.userNameCache.size >= 1000) this.userNameCache.delete(this.userNameCache.keys().next().value!);
    this.userNameCache.set(openId, { name, expiresAt: Date.now() + ttl });
    return name;
  }

  async checkIdentityResolution(): Promise<LarkIdentityResolutionCheck> {
    const payload = await this.request('/open-apis/contact/v3/scopes?user_id_type=open_id&page_size=100', { method: 'GET' });
    const sampleOpenId = (Array.isArray(payload.data?.user_ids) ? payload.data.user_ids : [])
      .map((value: unknown) => String(value ?? '').trim()).find(Boolean);
    if (!sampleOpenId) {
      throw new LarkServiceError(
        'LARK_CONTACT_DATA_SCOPE_EMPTY',
        '身份解析预检失败：应用通讯录数据权限中没有可用于校验的用户。请把至少一位用户（建议包含测试发送人）加入应用通讯录可见范围；资源点 GET /open-apis/contact/v3/scopes。',
        409
      );
    }
    const userPayload = await this.request(`/open-apis/contact/v3/users/${encodeURIComponent(sampleOpenId)}?user_id_type=open_id`, { method: 'GET' });
    // 姓名和邮箱都要校验：飞书对没权限的字段是静默省略（code 仍为 0），只查邮箱会漏掉
    // 「有邮箱权限、没有姓名权限」的应用，而姓名缺失才会让每轮 prompt 退化成裸 open_id。
    const name = String(userPayload.data?.user?.name ?? '').trim();
    if (!name) {
      throw new LarkServiceError(
        'LARK_USER_NAME_PERMISSION_REQUIRED',
        '身份解析预检失败：可见用户未返回姓名。请开通 contact:user.base:readonly（用户基本信息），并确认该用户在应用通讯录可见范围内且已配置姓名；资源点 GET /open-apis/contact/v3/users/:open_id。',
        409
      );
    }
    const email = String(userPayload.data?.user?.email ?? '').trim().toLowerCase();
    if (!email) {
      throw new LarkServiceError(
        'LARK_EMAIL_PERMISSION_REQUIRED',
        '身份解析预检失败：可见用户未返回邮箱。请开通 contact:user.email:readonly（用户邮箱信息），并确认该用户已配置邮箱；资源点 GET /open-apis/contact/v3/users/:open_id。',
        409
      );
    }
    return { verified: true, sampleOpenId, sampleName: name, sampleEmails: [email] };
  }

  private async tenantToken(signal?: AbortSignal) {
    if (this.token && Date.now() < this.tokenExpiresAt) return this.token;
    const payload = await this.request('/open-apis/auth/v3/tenant_access_token/internal/', {
      token: false, signal, body: { app_id: this.config.appId, app_secret: this.config.appSecret }
    });
    this.token = payload.tenant_access_token;
    if (!this.token) throw new LarkServiceError('INVALID_LARK_RESPONSE', 'Lark token response did not include tenant_access_token', 502);
    this.tokenExpiresAt = Date.now() + Math.max(60, Number(payload.expire ?? 7200) - 60) * 1000;
    return this.token;
  }

  private async request(path: string, options: { method?: string; body?: unknown; token?: boolean; timeoutMs?: number; signal?: AbortSignal }): Promise<any> {
    const controller = new AbortController();
    const signal = options.signal ? AbortSignal.any([options.signal, controller.signal]) : controller.signal;
    const timer = options.timeoutMs ? setTimeout(() => controller.abort(), options.timeoutMs) : undefined;
    try {
      return await abortable((async () => {
        const headers: Record<string, string> = { 'content-type': 'application/json; charset=utf-8' };
        if (options.token !== false) headers.authorization = `Bearer ${await this.tenantToken(signal)}`;
        signal.throwIfAborted();
        const response = await this.fetcher(`${this.config.baseUrl}${path}`, {
          method: options.method ?? 'POST', headers, signal,
          ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) })
        });
        const payload = await response.json().catch(() => ({})) as any;
        if (!response.ok || payload.code !== 0) {
          const message = payload.msg || payload.message || `${response.status} ${response.statusText}`;
          const violation = Array.isArray(payload.error?.permission_violations) ? payload.error.permission_violations[0] : undefined;
          const consoleUrl = payload.error?.console_url ?? payload.console_url ?? violation?.url;
          throw new LarkServiceError('LARK_OPENAPI_ERROR', `Lark OpenAPI request failed: ${message} (code: ${payload.code ?? 'HTTP_ERROR'})`, 502, {
            upstreamCode: payload.code,
            ...(consoleUrl ? { consoleUrl: String(consoleUrl) } : {}),
            ...(payload.error?.permission_violations ? { permissionViolations: payload.error.permission_violations } : {})
          });
        }
        return payload;
      })(), signal);
    } catch (error) {
      if (signal.aborted) throw new LarkServiceError('LARK_TIMEOUT', '飞书请求超时，请稍后重试。', 504);
      if (error instanceof LarkServiceError) throw error;
      throw new LarkServiceError('LARK_NETWORK_ERROR', `Lark OpenAPI request failed: ${error instanceof Error ? error.message : String(error)}`, 502);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

}

export function createLarkCardService(env: NodeJS.ProcessEnv = process.env, fetcher: Fetch = globalThis.fetch, input: LarkBotConfigInput = {}) {
  return new LarkCardService(loadLarkBotConfig(env, input), fetcher);
}
