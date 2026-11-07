export type Source = {
  id: string; name: string; kind: string; enabled: boolean; status: string;
  lastEventAt?: string | null; lastSeenAt?: string | null; lastError?: string | null;
  config: Record<string, unknown>; secretRefs: string[];
};
export type RouterCase = {
  id: string; sourceId: string; correlationKey: string; title: string; status: string;
  priority: string; summary: string; primarySessionId?: string | null; updatedAt: string;
};
export type CaseEvent = { id: string; kind: string; summary: string; createdAt: string; data: string };
export type CaseDetail = RouterCase & {
  objectValue: Record<string, unknown>; events: CaseEvent[];
  sessions: Array<{ sessionId: string; role: string; createdAt: string }>;
  watches: Array<{ id: string; status: string; condition: string; expiresAt?: string | null }>;
  actions: Array<{ id: string; status: string; actionType: string; target: string }>;
};
export type RouterStatus = {
  sessionId?: string; paused: boolean;
  inbox: Array<{ id: string; kind: string; status: string; caseId?: string | null; createdAt: string }>;
  sources: Source[]; cases: RouterCase[];
};

export class ApiError extends Error {
  constructor(public readonly code: string, message: string) { super(message); this.name = 'ApiError'; }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: { ...(init?.body ? { 'content-type': 'application/json' } : {}), ...(init?.headers ?? {}) }
  });
  const body = await response.json() as T & { error?: { code?: string; message?: string } };
  if (!response.ok) throw new ApiError(body.error?.code ?? 'REQUEST_FAILED', body.error?.message ?? `请求失败：HTTP ${response.status}`);
  return body;
}

export const sourcesRouterApi = {
  sources: () => request<Source[]>('/api/sources'),
  createSource: (input: { name: string; kind: string; config: Record<string, unknown>; secrets?: Record<string, string> }) =>
    request<Source>('/api/sources', { method: 'POST', body: JSON.stringify(input) }),
  setEnabled: (id: string, enabled: boolean) => request<Source>(`/api/sources/${encodeURIComponent(id)}/${enabled ? 'enable' : 'disable'}`, { method: 'POST' }),
  cases: (filter: { sourceId?: string; status?: string } = {}) => {
    const query = new URLSearchParams();
    if (filter.sourceId) query.set('sourceId', filter.sourceId);
    if (filter.status) query.set('status', filter.status);
    return request<RouterCase[]>(`/api/source-router/cases${query.size ? `?${query}` : ''}`);
  },
  caseDetail: (id: string) => request<CaseDetail>(`/api/source-router/cases/${encodeURIComponent(id)}`),
  closeCase: (id: string, reason: string) => request<RouterCase>(`/api/source-router/cases/${encodeURIComponent(id)}/close`, { method: 'POST', body: JSON.stringify({ reason }) }),
  routerStatus: () => request<RouterStatus>('/api/router/status'),
  openRouter: () => request<{ sessionId: string; created: boolean }>('/api/router/open', { method: 'POST' }),
  setPaused: (paused: boolean) => request<{ paused: boolean; message: string }>('/api/router/pause', { method: 'POST', body: JSON.stringify({ paused }) })
};
