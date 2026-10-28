export const protocols = ['auto', 'acp', 'jsonl', 'pipe', 'pty'] as const;
export type Protocol = (typeof protocols)[number];
export const permissionModes = ['ask', 'approve-reads', 'deny-all', 'full-trust'] as const;
export type PermissionMode = (typeof permissionModes)[number];
/** 三种模型线格式。与 apps/server/src/llm/types.ts 的 llmFormats 对应（服务端也会回传选项列表）。 */
export const llmFormats = ['openai-chat', 'openai-responses', 'anthropic-messages'] as const;
export type LlmFormat = (typeof llmFormats)[number];
export type Agent = {
  id: string;
  name: string;
  command: string;
  args: string[];
  protocol: Protocol;
  model?: string;
  extraModels?: string[];
  reasoningEffort?: string;
  version?: string;
  cwd?: string;
  env: Record<string, string>;
  systemPrompt?: string;
  permissionMode: PermissionMode;
  timeout: number;
  capabilities: { pause: boolean; resume: boolean };
  builtin: boolean;
  disabled?: boolean;
};
export type AgentModel = { id: string; name: string };
export type CodexUsage = { status: 'available' | 'unavailable'; plan?: string; windows: { label: string; usedPercent: number; windowDurationMins: number; resetsAt?: number }[]; reason?: string; checkedAt: number };
export type AgentUsage = { status: 'available' | 'unavailable'; plan?: string; windows: { label: string; usedPercent: number; resetsAt?: number }[]; reason?: string; source?: string; stale?: boolean; checkedAt: number };
export type AgentModelsResult = { models: AgentModel[]; defaultModel?: string; reasoningEfforts: AgentModel[]; defaultReasoningEffort?: string; source?: 'acp' | 'cli' | 'agent'; warning?: string };
export type SkillReference = { name: string; description: string; path: string; source: 'workspace' | 'user' };
export type LarkAllowedUser = { openId: string; name: string };
export type LarkBotConfig = { configured: true; appId: string; name: string; tabLabel: string; setupComplete: boolean; avatarUrl?: string; workspace?: string; webBaseUrl?: string; defaultAgentId?: string; defaultModel?: string; defaultReasoningEffort?: string; preInjectPrompt: string; listening: boolean; activeListening: boolean; groupToolsEnabled: boolean; groupToolsAllowSend: boolean; groupSessionScope: 'user' | 'chat'; pushIntervalMs: number; traceLimit?: number; hideTraceOnComplete: boolean; quietReply: boolean; allowedUsers: LarkAllowedUser[]; allowedUserNames?: string[]; allowedEmails: string[]; allowedBots: LarkAllowedUser[]; allowedBotNames?: string[]; peerBotsAllowed: boolean; highRiskAllowedUsers: LarkAllowedUser[]; highRiskAllowedUserNames?: string[]; highRiskAllowedEmails: string[]; highRiskPattern: string; gateEnabled: boolean; softGateEnabled: boolean; hardGateEnabled: boolean; hookTrustConfirmed: boolean };
export type LarkConfig = { configured: boolean; bots: LarkBotConfig[]; listeningDisabled: boolean };
export type LarkHookStatus = { agentId?: string; supported: boolean; installed: boolean; writable: boolean; trustRequired: boolean; hooksPath?: string; reason?: string; trustInstructions?: string };
export type Session = { id: string; agentId: string; state: string; cwd: string; model?: string; reasoningEffort?: string; permissionMode?: 'full-trust'; source?: string; sourceId?: string; archivedAt?: string; runId: string; createdAt: string; updatedAt: string; /** 最后一次对话时间；旧数据为空，排序需回退 updatedAt。 */ lastMessageAt?: string | null; systemPrompt?: string; title?: string; titleSource?: 'user' | 'agent' | 'prompt'; customTitle?: string | null; agentTitle?: string | null };
export type SelfUpdateStatus = { currentVersion: string; distTag: string; latestVersion?: string; updateAvailable: boolean; canUpdate: boolean; updating: boolean; lastError?: string; checkedAt?: number; checkError?: string };
export type ExternalSession = { sessionId: string; cwd: string; title?: string; updatedAt?: string };
export type ScheduleDelivery = 'new_session' | 'append';
export type Schedule = { id: string; name: string; sessionId?: string | null; sessionTemplate?: string | null; delivery: ScheduleDelivery; cron?: string | null; runAt?: string | null; intervalMinutes?: number | null; timezone: string; prompt: string; enabled: boolean; nextRunAt?: string | null; lastRunAt?: string | null; lastStatus?: string | null; runCount: number; createdBySessionId?: string | null; createdAt: string; updatedAt: string };
export type ScheduleRun = { id: string; scheduleId: string; fireAt: string; status: 'delivered' | 'skipped' | 'failed'; reason?: string | null; sessionId?: string | null; taskId?: string | null; createdAt: string };
export type ScheduleTemplate = { agentId: string; cwd: string; model?: string; reasoningEffort?: string };
export type CreateScheduleInput = { sessionId?: string; template?: ScheduleTemplate; prompt: string; name?: string; delivery?: ScheduleDelivery; cron?: string; runAt?: string; intervalMinutes?: number; timezone?: string };
export type ExternalSessionsResult = { agentId: string; agentName: string; supported: boolean; sessions: ExternalSession[]; nextCursor?: string };
export type DockEvent = { id: string; sequence: number; type: string; timestamp: string; data: any; raw?: string };
export type FsListEntry = { name: string; type: 'file' | 'dir'; size: number; mtime: string };
export type FsListResult = { cwd: string; path: string; entries: FsListEntry[] };
export type FsReadResult = { cwd: string; path: string; size: number; content: string };
export type Task = { id: string; sessionId: string; prompt: string; sentPrompt?: string | null; finalText?: string | null; status: string; createdAt: string; updatedAt: string };
/** `events` 只是一页（最近若干条）；总行数与是否被截断由 eventTotal / eventsTruncated 明说。 */
export type SessionRecord = { session: Session; tasks: Task[]; events: DockEvent[]; eventTotal?: number; eventsTruncated?: boolean };
/** 一轮事件的边界：startSequence 是这一轮的提问锚点，endSequence 是下一轮锚点（末轮为最大序号 + 1）。 */
export type TurnRange = { taskId: string; startSequence: number; endSequence: number; segments: number };
/** 一轮事件的一页。truncated 为真时用 nextAfter 继续取——限行数也限字节，两者谁先到谁生效。 */
export type TurnEventsPage = { taskId: string; after: number; before: number; events: DockEvent[]; nextAfter: number; truncated: boolean };
/** 平台拿模型能力的唯一来源：一个 Base URL + 一把 Key + 一种线格式 + 一个模型名。密钥不下发。 */
export type LlmFormatOption = { value: LlmFormat; label: string; baseUrlPlaceholder: string };
export type LlmEndpointState = {
  configured: boolean;
  format?: LlmFormat;
  baseUrl?: string;
  model?: string;
  /** 只报「有没有配密钥」——服务端永不回传密钥本身。 */
  apiKeySet?: boolean;
  systemPrompt?: string;
  maxTokens?: number;
  temperature?: number;
  timeoutMs?: number;
  formats: LlmFormatOption[];
};
export type LlmRunResult = { format: LlmFormat; model: string; baseUrl: string; text: string; truncated?: boolean };
/** 本地 Web 访问门拒绝（401 凭证缺失/过期、403 会话 token 越权）。 */
export class WebAccessDeniedError extends Error {
  constructor(public readonly status: number, message: string) { super(message); this.name = 'WebAccessDeniedError'; }
}
const json = async <T,>(url: string, init?: RequestInit, quietDenied = false): Promise<T> => {
  const response = await fetch(url, init);
  const data = await response.json();
  if (response.status === 401 || response.status === 403) {
    const denied = new WebAccessDeniedError(response.status, data.error?.message ?? response.statusText);
    // SPA 壳本身公开、数据全走 API：任一查询被访问门拦下即通知 UI 渲染过期提示，避免各页面白屏。
    if (!quietDenied && typeof window !== 'undefined') window.dispatchEvent(new CustomEvent('agentdock:web-access-denied', { detail: denied }));
    throw denied;
  }
  if (!response.ok) throw new Error(data.error?.message ?? response.statusText);
  return data;
};
/**
 * 读一条 SSE 响应体。按事件块缓冲——一个 chunk 可能落在事件块中间，
 * 凑齐 `\n\n` 才解析，绝不能对半个 JSON 调 parse（与服务端 llm/sse.ts 同一套规则）。
 */
async function readEventStream(body: ReadableStream<Uint8Array>, onEvent: (event: string, data: unknown) => void): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      // stream:true 是必须的：一个汉字可能被切在两个 chunk 边界上。
      buffer += decoder.decode(value, { stream: true });
      let boundary = buffer.indexOf('\n\n');
      while (boundary >= 0) {
        const block = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        let event = 'message';
        const data: string[] = [];
        for (const line of block.split('\n')) {
          const clean = line.endsWith('\r') ? line.slice(0, -1) : line;
          if (!clean || clean.startsWith(':')) continue;
          const colon = clean.indexOf(':');
          const field = colon < 0 ? clean : clean.slice(0, colon);
          const value = colon < 0 ? '' : clean.slice(colon + 1).replace(/^ /, '');
          if (field === 'event') event = value;
          else if (field === 'data') data.push(value);
        }
        if (data.length) {
          try { onEvent(event, JSON.parse(data.join('\n'))); } catch { /* 坏掉的一条不该毁掉整段回答 */ }
        }
        boundary = buffer.indexOf('\n\n');
      }
    }
  } finally { reader.releaseLock(); }
}

const agentModelsUrl = (id: string, model?: string, refresh = false) => {  const query = new URLSearchParams();
  if (model) query.set('model', model);
  if (refresh) query.set('refresh', '1');
  const suffix = query.toString();
  return `/api/agents/${id}/models${suffix ? `?${suffix}` : ''}`;
};
export const api = {
  codexUsage: (refresh = false) => json<CodexUsage>(`/api/codex/usage${refresh ? '?refresh=1' : ''}`, undefined, true),
  claudeUsage: (refresh = false) => json<AgentUsage>(`/api/claude/usage${refresh ? '?refresh=1' : ''}`, undefined, true),
  cursorUsage: (refresh = false) => json<AgentUsage>(`/api/cursor/usage${refresh ? '?refresh=1' : ''}`, undefined, true),
  agents: (includeDisabled = false) => json<Agent[]>(`/api/agents${includeDisabled ? '?includeDisabled=1' : ''}`),
  createAgent: (body: unknown) => json<Agent>('/api/agents', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
  updateAgent: (id: string, body: unknown) => json<Agent>(`/api/agents/${encodeURIComponent(id)}`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
  deleteAgent: (id: string) => json<{ disabled: boolean }>(`/api/agents/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  /** 启用/停用。不能走 updateAgent——那条接口有意忽略 disabled，停用了就启不回来。 */
  setAgentDisabled: (id: string, disabled: boolean) => json<Agent>(`/api/agents/${encodeURIComponent(id)}/disabled`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ disabled }) }),
  externalSessions: (agentId: string, options: { cursor?: string; cwd?: string } = {}) => { const query = new URLSearchParams(); if (options.cursor) query.set('cursor', options.cursor); if (options.cwd) query.set('cwd', options.cwd); const suffix = query.size ? `?${query.toString()}` : ''; return json<ExternalSessionsResult>(`/api/agents/${encodeURIComponent(agentId)}/external-sessions${suffix}`); },
  llm: () => json<LlmEndpointState>('/api/llm'),
  /** apiKey 留空表示沿用已存的那把——只改模型名时不必重新粘贴密钥。 */
  saveLlm: (body: { format: LlmFormat; baseUrl: string; model: string; apiKey?: string; systemPrompt?: string; maxTokens?: number; timeoutMs?: number }) => json<LlmEndpointState>('/api/llm', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
  clearLlm: () => json<LlmEndpointState>('/api/llm', { method: 'DELETE' }),
  testLlm: (prompt?: string) => json<LlmRunResult>('/api/llm/test', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(prompt ? { prompt } : {}) }),
  /**
   * 流式试跑。不能用 EventSource（它只支持 GET，而这里要带 prompt），用 fetch + 手动读流。
   * 帧格式与服务端的会话流一致：event: delta / done / failed。返回一个中止函数。
   */
  testLlmStream: (handlers: { onDelta(text: string): void; onDone(result: LlmRunResult): void; onFailed(error: { code: string; message: string }): void }, prompt?: string) => {
    const controller = new AbortController();
    void (async () => {
      try {
        const response = await fetch('/api/llm/test/stream', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(prompt ? { prompt } : {}),
          signal: controller.signal
        });
        if (!response.ok || !response.body) {
          // 走到这里说明连流都没开起来（访问门拒绝、路由不存在），按失败处理。
          const data = await response.json().catch(() => ({}));
          handlers.onFailed({ code: data.error?.code ?? 'LLM_STREAM_FAILED', message: data.error?.message ?? response.statusText });
          return;
        }
        await readEventStream(response.body, (event, data) => {
          if (event === 'delta') handlers.onDelta(String((data as { text?: string })?.text ?? ''));
          else if (event === 'done') handlers.onDone(data as LlmRunResult);
          else if (event === 'failed') handlers.onFailed(data as { code: string; message: string });
        });
      } catch (error) {
        // 用户主动中止不算失败。
        if (!controller.signal.aborted) handlers.onFailed({ code: 'LLM_STREAM_FAILED', message: error instanceof Error ? error.message : String(error) });
      }
    })();
    return () => controller.abort();
  },
  agentModels: (id: string, model?: string, refresh = false) => json<AgentModelsResult>(agentModelsUrl(id, model, refresh)), sessions: () => json<Session[]>('/api/sessions'), events: (id: string, after?: number) => json<DockEvent[]>(`/api/sessions/${id}/events?compact=thinking${after ? `&after=${after}` : ''}`), rawEvents: (id: string, before?: number) => json<DockEvent[]>(`/api/sessions/${id}/events?limit=200${before ? `&before=${before}` : ''}`), tasks: (id: string) => json<Task[]>(`/api/sessions/${id}/tasks`), sessionRecord: (id: string) => json<SessionRecord>(`/api/sessions/${id}/record`),
  /** 轮次锚点图：只回边界与过程条数，不回事件体。面板整个生命周期只请求一次。 */
  sessionTurns: (id: string) => json<{ turns: TurnRange[] }>(`/api/sessions/${id}/turns`),
  /** 单轮事件体（已合并分片）。带上 after/before 可以免掉服务端那一次锚点扫描。 */
  turnEvents: (id: string, taskId: string, range: { after: number; before?: number; limit?: number }) => {
    const query = new URLSearchParams({ after: String(range.after) });
    if (range.before !== undefined) query.set('before', String(range.before));
    if (range.limit !== undefined) query.set('limit', String(range.limit));
    return json<TurnEventsPage>(`/api/sessions/${id}/turns/${encodeURIComponent(taskId)}/events?${query}`);
  },
  // quietDenied：会话 token 没有升级权限，查不到就不显示入口，不能把整页打成「访问被拒」。
  selfUpdateStatus: (refresh = false) => json<SelfUpdateStatus>(`/api/system/update${refresh ? '?refresh=1' : ''}`, undefined, true),
  startSelfUpdate: () => json<SelfUpdateStatus>('/api/system/update', { method: 'POST' }),
  create: (body: any) => json<Session>('/api/sessions', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
  importSession: (body: { agentId: string; externalSessionId: string; cwd?: string; mode?: 'full' | 'session'; model?: string; reasoningEffort?: string }) => json<Session>('/api/sessions/import', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
  send: (id: string, prompt: string, mode: 'queue' | 'interrupt' = 'queue') => json<{ accepted: true; task: Task }>(`/api/sessions/${id}/send`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ prompt, mode }) }),
  setSessionModel: (id: string, model: string) => json<Session>(`/api/sessions/${id}/config`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model }) }),
  setSessionReasoningEffort: (id: string, reasoningEffort: string) => json<Session>(`/api/sessions/${id}/config`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ reasoningEffort }) }),
  // 传 null / 空串表示「恢复自动命名」，由服务端回落到 Agent 名或首条 prompt 摘要。
  setSessionTitle: (id: string, title: string | null) => json<Session>(`/api/sessions/${id}/title`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ title }) }),
  cancelQueued: (id: string, taskId: string) => json<Task>(`/api/sessions/${id}/queue/${taskId}`, { method: 'DELETE' }),
  updateQueued: (id: string, taskId: string, prompt: string) => json<Task>(`/api/sessions/${id}/queue/${taskId}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ prompt }) }),
  steerQueued: (id: string, taskId: string) => json<Task>(`/api/sessions/${id}/queue/${taskId}/steer`, { method: 'POST' }),
  larkConfig: () => json<LarkConfig>('/api/lark/config'),
  inspectLarkBot: (body: { appId: string; appSecret: string }) => json<{ appName: string; openId: string; avatarUrl?: string; activateStatus?: number }>('/api/lark/bot/inspect', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
  saveLarkConfig: (body: { stage: 'lark' | 'agent'; originalAppId?: string; appId?: string; appSecret?: string; workspace?: string; webBaseUrl?: string; defaultAgentId?: string; defaultModel?: string; defaultReasoningEffort?: string; preInjectPrompt?: string; listening?: boolean; groupToolsEnabled?: boolean; groupToolsAllowSend?: boolean; groupSessionScope?: 'user' | 'chat'; pushIntervalMs?: number; traceLimit?: number | null; quietReply?: boolean; allowedUsers?: LarkAllowedUser[]; allowedUserNames?: string[]; allowedEmails?: string[]; allowedBots?: LarkAllowedUser[]; allowedBotNames?: string[]; peerBotsAllowed?: boolean; highRiskAllowedUsers?: LarkAllowedUser[]; highRiskAllowedUserNames?: string[]; highRiskAllowedEmails?: string[]; highRiskPattern?: string; gateEnabled?: boolean; softGateEnabled?: boolean; hardGateEnabled?: boolean; hookTrustConfirmed?: boolean }) => json<LarkConfig>('/api/lark/config', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
  deleteLarkConfig: (appId: string) => json<LarkConfig>(`/api/lark/config/${encodeURIComponent(appId)}`, { method: 'DELETE' }),
  larkHookStatus: (appId: string) => json<LarkHookStatus>(`/api/lark/hooks/status?appId=${encodeURIComponent(appId)}`),
  installLarkHook: (appId: string, highRiskPattern: string) => json<LarkHookStatus>('/api/lark/hooks/install', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ appId, highRiskPattern }) }),
  // 登录接口不走 json()：密码错误是普通失败，不能触发全局「访问被拒」事件。
  authStatus: async (): Promise<{ passwordEnabled: boolean }> => {
    const response = await fetch('/api/auth/status');
    if (!response.ok) return { passwordEnabled: false };
    return response.json();
  },
  login: async (password: string): Promise<void> => {
    const response = await fetch('/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password }) });
    if (response.ok) return;
    const data = await response.json().catch(() => ({}));
    throw new Error(data.error?.message ?? '登录失败');
  },
  systemCapabilities: () => json<{ platform: string; directoryPicker: boolean; filePicker: boolean; workingDirectory: string }>('/api/system/capabilities'),
  skills: (cwd?: string) => json<SkillReference[]>(`/api/system/skills${cwd ? `?cwd=${encodeURIComponent(cwd)}` : ''}`),
  selectDirectory: () => json<{ path: string }>('/api/system/select-directory', { method: 'POST' }),
  selectFile: () => json<{ path: string }>('/api/system/select-file', { method: 'POST' }),
  archive: (id: string) => json<Session>(`/api/sessions/${id}/archive`, { method: 'POST' }),
  schedules: (sessionId?: string) => json<Schedule[]>(`/api/schedules${sessionId ? `?sessionId=${encodeURIComponent(sessionId)}` : ''}`),
  scheduleRuns: (id: string) => json<ScheduleRun[]>(`/api/schedules/${encodeURIComponent(id)}/runs?limit=20`),
  recentScheduleRuns: (sessionId?: string) => json<ScheduleRun[]>(`/api/schedule-runs?limit=60${sessionId ? `&sessionId=${encodeURIComponent(sessionId)}` : ''}`),
  createSchedule: (body: CreateScheduleInput) => json<Schedule>('/api/schedules', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
  pauseSchedule: (id: string) => json<Schedule>(`/api/schedules/${encodeURIComponent(id)}/pause`, { method: 'POST' }),
  resumeSchedule: (id: string) => json<Schedule>(`/api/schedules/${encodeURIComponent(id)}/resume`, { method: 'POST' }),
  runSchedule: (id: string) => json<ScheduleRun>(`/api/schedules/${encodeURIComponent(id)}/run`, { method: 'POST' }),
  deleteSchedule: (id: string) => json<{ deleted: boolean; id: string }>(`/api/schedules/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  syncExternal: (id: string) => json<{ added: number; skipped: number }>(`/api/sessions/${id}/sync-external`, { method: 'POST' }),
  larkUserProfiles: (appId: string, openIds: string[]) => json<{ users: { openId: string; name: string; avatarUrl?: string }[] }>(`/api/lark/user-profiles?appId=${encodeURIComponent(appId)}&openIds=${encodeURIComponent(openIds.join(','))}`),
  larkAppOwner: (appId: string) => json<{ owner: { openId: string; name: string; ownerType?: string; avatarUrl?: string } | null }>(`/api/lark/app-owner?appId=${encodeURIComponent(appId)}`),
  larkMemberSearch: (appId: string, q: string) => json<{ users: { openId: string; name: string }[]; error?: string }>(`/api/lark/member-search?appId=${encodeURIComponent(appId)}&q=${encodeURIComponent(q)}`),
  larkChatMembers: (appId: string, chatId: string) => json<{ users: { openId: string; name: string }[] }>(`/api/lark/chat-members?appId=${encodeURIComponent(appId)}&chatId=${encodeURIComponent(chatId)}`),
  sessionHandover: (id: string) => json<{ handover: { appId: string; botName: string; chatId: string; name: string; url: string } | null }>(`/api/sessions/${id}/handover`),
  handoverSession: (id: string, body: { appId: string; name?: string; memberOpenIds?: string[] }) => json<{ sessionId: string; appId: string; chatId: string; name: string; url: string }>(`/api/sessions/${id}/handover`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
  action: (id: string, action: string) => json(`/api/sessions/${id}/${action}`, { method: 'POST' }),
  permission: (id: string, permissionId: string, approved: boolean) => json(`/api/sessions/${id}/permissions/${permissionId}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ approved }) }),
  fsList: (id: string, path = '') => json<FsListResult>(`/api/sessions/${id}/fs/list?path=${encodeURIComponent(path)}`),
  fsReadText: (id: string, path: string) => json<FsReadResult>(`/api/sessions/${id}/fs/read?path=${encodeURIComponent(path)}`, undefined, path.startsWith('/')),
  /** 图片不走 JSON：直接给 <img> 用的同源 URL（cookie/会话令牌语义与其他接口一致）。 */
  fsReadUrl: (id: string, path: string) => `/api/sessions/${id}/fs/read?path=${encodeURIComponent(path)}`
};
