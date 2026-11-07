export const sourceKinds = ['webhook', 'poll', 'stream', 'worker'] as const;
export type SourceKind = (typeof sourceKinds)[number];
export const sourceStatuses = ['created', 'running', 'degraded', 'failed', 'stopped'] as const;
export type SourceStatus = (typeof sourceStatuses)[number];
export const caseStatuses = ['open', 'waiting', 'closed'] as const;
export type CaseStatus = (typeof caseStatuses)[number];
export const eventStatuses = ['accepted', 'processed', 'ignored', 'dead'] as const;
export type SourceEventStatus = (typeof eventStatuses)[number];
export const routerDecisions = ['ignore', 'notify', 'append', 'create', 'reopen', 'escalate'] as const;
export type RouterDecisionKind = (typeof routerDecisions)[number];
export const watchStatuses = ['active', 'fired', 'cancelled', 'expired'] as const;
export type WatchStatus = (typeof watchStatuses)[number];
export const actionStatuses = ['pending', 'running', 'succeeded', 'failed', 'dead', 'throttled'] as const;
export type ActionStatus = (typeof actionStatuses)[number];
export const inboxStatuses = ['pending', 'dispatched', 'done'] as const;
export type InboxStatus = (typeof inboxStatuses)[number];

export type JsonObject = Record<string, unknown>;

export interface SourceObject {
  type: string;
  id: string;
  url?: string;
  title?: string;
}

export interface SourceActor {
  id?: string;
  name?: string;
  isBot?: boolean;
}

export interface SourceEnvelope {
  specVersion: 'agentdock.source.v1';
  sourceId: string;
  eventId: string;
  eventType: string;
  dedupeKey: string;
  occurredAt: string;
  object: SourceObject;
  actor?: SourceActor;
  correlationKey?: string;
  payload: JsonObject;
  raw?: string;
  causationId?: string | null;
  traceId: string;
}

export interface CorrelationConfig {
  mode: 'object' | 'template' | 'per_event';
  template?: string;
  reopen?: boolean;
}

export interface SourceSecrets {
  signingSecret?: string;
  githubWebhookSecret?: string;
  actionToken?: string;
}

export interface SourceConfig {
  correlation: CorrelationConfig;
  allowedRepos?: string[];
  allowedEvents?: string[];
  actionBaseUrl?: string;
  actions?: string[];
  dryRun?: boolean;
  restart?: boolean;
  [key: string]: unknown;
}

export interface SourceInstance {
  id: string;
  name: string;
  kind: SourceKind;
  enabled: boolean;
  config: SourceConfig;
  secretRefs: string[];
  secrets: SourceSecrets;
  routerSessionId?: string | null;
  status: SourceStatus;
  lastEventAt?: string | null;
  lastSeenAt?: string | null;
  lastError?: string | null;
  traceId: string;
  createdAt: string;
  updatedAt: string;
}

export type PublicSource = Omit<SourceInstance, 'secrets'> & { secretRefs: string[] };

export interface SourceEventRecord {
  id: string;
  sourceId: string;
  externalEventId: string;
  eventType: string;
  dedupeKey: string;
  correlationKey?: string | null;
  occurredAt: string;
  receivedAt: string;
  status: SourceEventStatus;
  payload: string;
  raw?: string | null;
  traceId: string;
  causationId?: string | null;
}

export interface CaseRecord {
  id: string;
  sourceId: string;
  correlationKey: string;
  openKey?: string | null;
  title: string;
  status: CaseStatus;
  priority: string;
  routerSessionId?: string | null;
  primarySessionId?: string | null;
  summary: string;
  object: string;
  createdAt: string;
  updatedAt: string;
  closedAt?: string | null;
  closeReason?: string | null;
}

export interface CaseEventRecord {
  id: string;
  caseId: string;
  sourceEventId?: string | null;
  kind: string;
  summary: string;
  data: string;
  createdAt: string;
}

export interface CaseSessionRecord {
  caseId: string;
  sessionId: string;
  role: string;
  createdAt: string;
}

export interface CaseWatchRecord {
  id: string;
  caseId: string;
  sourceId: string;
  condition: string;
  expiresAt?: string | null;
  status: WatchStatus;
  createdAt: string;
  firedAt?: string | null;
}

export interface SourceActionRecord {
  id: string;
  sourceId: string;
  caseId?: string | null;
  actionType: string;
  target: string;
  payload: string;
  idempotencyKey: string;
  status: ActionStatus;
  attempts: number;
  lastError?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface RouterInboxRecord {
  id: string;
  routerSessionId: string;
  caseId?: string | null;
  kind: string;
  dedupeKey: string;
  payload: string;
  status: InboxStatus;
  availableAt: string;
  createdAt: string;
  dispatchedAt?: string | null;
}

export interface RouterStateRecord {
  key: string;
  value: string;
  updatedAt: string;
}

export interface RouterAuditRecord {
  id: string;
  kind: string;
  actor: string;
  summary: string;
  caseId?: string | null;
  createdAt: string;
}

export interface RouterDecision {
  decision: RouterDecisionKind;
  caseId?: string;
  session?: {
    mode: 'reuse' | 'create';
    sessionId?: string;
    agentId?: string;
    workspace?: string;
    model?: string;
    reasoningEffort?: string;
  };
  task?: { prompt: string; mode?: 'queue' | 'interrupt' };
  watch?: { on: string[]; until?: string; timeoutMinutes?: number };
  reply?: { action: string; target: string; body?: string };
  reason: string;
  confidence: number;
  decisionSource?: 'rule' | 'router' | 'fallback';
  throttled?: boolean;
}

export interface CaseDetail extends CaseRecord {
  objectValue: SourceObject;
  events: CaseEventRecord[];
  sessions: CaseSessionRecord[];
  watches: CaseWatchRecord[];
  actions: SourceActionRecord[];
}

export const isRecord = (value: unknown): value is JsonObject => typeof value === 'object' && value !== null && !Array.isArray(value);

export function publicSource(source: SourceInstance): PublicSource {
  const { secrets: _secrets, ...rest } = source;
  return { ...rest, secretRefs: [...source.secretRefs] };
}
