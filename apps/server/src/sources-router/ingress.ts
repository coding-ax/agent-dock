import { createHmac, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { RuntimeError } from '@agent-dock/agent-dock-shared';
import type { CorrelationConfig, JsonObject, SourceEnvelope, SourceInstance } from './types.js';
import { isRecord } from './types.js';

export const defaultBodyLimitBytes = 1024 * 1024;
export const defaultSignatureToleranceMs = 5 * 60_000;

const objectSchema = z.object({ type: z.string().min(1), id: z.string().min(1), url: z.string().optional(), title: z.string().optional() });
const actorSchema = z.object({ id: z.string().optional(), name: z.string().optional(), isBot: z.boolean().optional() }).optional();
export const envelopeSchema = z.object({
  specVersion: z.literal('agentdock.source.v1'),
  sourceId: z.string().min(1),
  eventId: z.string().min(1),
  eventType: z.string().min(1),
  dedupeKey: z.string().min(1),
  occurredAt: z.string().datetime(),
  object: objectSchema,
  actor: actorSchema,
  correlationKey: z.string().min(1).optional(),
  payload: z.record(z.string(), z.unknown()).default({}),
  raw: z.string().optional(),
  causationId: z.string().nullable().optional(),
  traceId: z.string().min(1)
}).strict();

export interface VerifiedIngress {
  envelope: SourceEnvelope;
  body: string;
  correlationKey?: string;
  correlationReason?: string;
  ignored?: boolean;
  ignoreReason?: string;
  checkpoint?: string;
}

export class IngressError extends RuntimeError {
  constructor(code: string, message: string, statusCode: number) { super(code, message, statusCode); this.name = 'IngressError'; }
}

export function signatureFor(body: string, secret: string): string {
  return `sha256=${createHmac('sha256', secret).update(body, 'utf8').digest('hex')}`;
}

export function safeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left); const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

export interface VerifyIngressInput {
  source: SourceInstance | undefined;
  sourceId: string;
  body: string;
  headers: Record<string, string | string[] | undefined>;
  now?: Date;
  bodyLimitBytes?: number;
  toleranceMs?: number;
  signatureSecret?: string;
  /** 只有 GitHub 兼容 webhook 路径传 true：走 X-Hub-Signature-256 与 header 事件映射。 */
  github?: boolean;
}

function header(input: Record<string, string | string[] | undefined>, name: string): string | undefined {
  const value = input[name] ?? input[name.toLowerCase()];
  return Array.isArray(value) ? value[0] : value;
}

function parseJson(body: string): unknown {
  try { return JSON.parse(body); }
  catch { throw new IngressError('INVALID_EVENT', '事件正文不是合法 JSON', 400); }
}

export function resolveTemplate(template: string, context: JsonObject): { value?: string; reason?: string } {
  const missing: string[] = [];
  let failed = false;
  const value = template.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_match, path: string) => {
    if (failed) return '';
    const found = path.split('.').reduce<unknown>((current, key) => isRecord(current) ? current[key] : undefined, context);
    if (found === undefined || found === null || found === '') { missing.push(path); failed = true; return ''; }
    return String(found);
  });
  if (failed) return { reason: `关联模板缺少变量：${missing.join(', ')}` };
  if (!value.trim()) return { reason: '关联模板结果为空' };
  return { value };
}

export function correlationFor(config: CorrelationConfig, envelope: SourceEnvelope): { key?: string; reason?: string } {
  if (config.mode === 'per_event') return { key: `${envelope.sourceId}:event:${envelope.eventId}` };
  if (envelope.correlationKey?.trim()) return { key: envelope.correlationKey.trim() };
  if (config.mode === 'template') {
    const result = resolveTemplate(config.template ?? '', {
      object: envelope.object as unknown as JsonObject,
      payload: envelope.payload,
      actor: (envelope.actor ?? {}) as unknown as JsonObject,
      eventType: envelope.eventType,
      sourceId: envelope.sourceId
    });
    return { key: result.value, reason: result.reason };
  }
  return envelope.object.id ? { key: `${envelope.object.type}:${envelope.object.id}` } : { reason: '事件对象缺少 object.id' };
}

export function normalizeEnvelope(value: unknown, fallbackSourceId?: string): SourceEnvelope {
  const result = envelopeSchema.safeParse(value);
  if (!result.success) throw new IngressError('INVALID_EVENT', `事件格式不正确：${result.error.issues[0]?.message ?? '校验失败'}`, 400);
  const envelope = result.data as SourceEnvelope;
  if (fallbackSourceId && envelope.sourceId !== fallbackSourceId) throw new IngressError('INVALID_EVENT', '事件 sourceId 与路由不匹配', 400);
  return { ...envelope, payload: envelope.payload ?? {}, actor: envelope.actor ?? {} };
}

function githubEventType(value: string | undefined): string | undefined {
  if (!value) return undefined;
  if (value === 'issues' || value === 'issue_comment' || value === 'pull_request' || value === 'check_run') return undefined;
  return value;
}

function asString(value: unknown): string | undefined { return typeof value === 'string' && value ? value : undefined; }

export function normalizeGithubWebhook(input: { body: string; headers: Record<string, string | string[] | undefined>; sourceId: string; deliveryId?: string }): { envelope: SourceEnvelope; ignored: boolean; reason?: string; action?: string } {
  const value = parseJson(input.body);
  if (!isRecord(value)) throw new IngressError('INVALID_EVENT', 'GitHub webhook 必须是 JSON 对象', 400);
  const action = asString(value.action);
  const headerEvent = header(input.headers, 'x-github-event');
  const deliveryId = asString(input.deliveryId) ?? header(input.headers, 'x-github-delivery') ?? crypto.randomUUID();
  const repo = isRecord(value.repository) ? value.repository : undefined;
  const repoName = asString(repo?.full_name);
  const issue = isRecord(value.issue) ? value.issue : undefined;
  const pullRequest = isRecord(value.pull_request) ? value.pull_request : undefined;
  const comment = isRecord(value.comment) ? value.comment : undefined;
  const checkRun = isRecord(value.check_run) ? value.check_run : undefined;
  const firstCheckPull = Array.isArray(checkRun?.pull_requests) ? (checkRun.pull_requests as unknown[]).find(isRecord) : undefined;
  const number = issue?.number ?? pullRequest?.number ?? firstCheckPull?.number;
  const objectIdNumber = typeof number === 'number' ? number : undefined;
  const sender = isRecord(value.sender) ? value.sender : undefined;
  const actorId = asString(sender?.login);
  const isBot = sender?.type === 'Bot' || Boolean(actorId && /\[bot\]$|bot$/i.test(actorId));
  const baseEventType = githubEventType(headerEvent);
  const eventType = headerEvent === 'issues' && action === 'opened' ? 'issue.created'
    : headerEvent === 'issues' && action ? `issue.${action}`
      : headerEvent === 'issue_comment' && action ? `issue_comment.${action}`
        : headerEvent === 'pull_request' && action ? `pr.${action}`
          : headerEvent === 'check_run' && action ? `ci.${action}`
            : baseEventType ?? (headerEvent ? `github.${headerEvent}.${action ?? 'event'}` : 'github.unknown');
  const objectId = repoName && objectIdNumber ? `${repoName}#${objectIdNumber}` : asString(issue?.node_id) ?? asString(pullRequest?.node_id) ?? deliveryId;
  const title = asString(issue?.title) ?? asString(pullRequest?.title) ?? asString(checkRun?.name) ?? `GitHub ${eventType}`;
  const url = asString(issue?.html_url) ?? asString(pullRequest?.html_url) ?? asString(comment?.html_url) ?? asString(checkRun?.html_url);
  const objectType = headerEvent === 'pull_request' || pullRequest ? 'pr' : headerEvent === 'check_run' ? 'ci' : 'issue';
  const envelope: SourceEnvelope = {
    specVersion: 'agentdock.source.v1', sourceId: input.sourceId, eventId: deliveryId,
    eventType, dedupeKey: `github:${deliveryId}`, occurredAt: new Date().toISOString(),
    object: { type: objectType, id: objectId, ...(url ? { url } : {}), title },
    actor: { ...(actorId ? { id: actorId, name: actorId } : {}), isBot },
    ...(repoName && objectIdNumber ? { correlationKey: `github:${repoName}#${objectIdNumber}` } : {}),
    payload: value, raw: input.body, traceId: `trace_${deliveryId}`
  };
  const ignored = !repoName || !objectIdNumber || !headerEvent;
  const reason = ignored ? `GitHub 事件未进入处理：event=${headerEvent ?? 'unknown'} action=${action ?? 'none'} repo=${repoName ?? 'unknown'}` : undefined;
  return { envelope, ignored, ...(reason ? { reason } : {}), ...(action ? { action } : {}) };
}

export function verifyIngress(input: VerifyIngressInput): VerifiedIngress {
  const now = input.now ?? new Date();
  const bodyLimit = input.bodyLimitBytes ?? defaultBodyLimitBytes;
  if (Buffer.byteLength(input.body, 'utf8') > bodyLimit) throw new IngressError('PAYLOAD_TOO_LARGE', `事件正文超过 ${bodyLimit} 字节上限`, 413);
  if (!input.source) throw new IngressError('SOURCE_NOT_FOUND', `消息源不存在：${input.sourceId}`, 404);
  if (!input.source.enabled) throw new IngressError('SOURCE_DISABLED', '消息源已禁用，事件未接收', 409);
  // GitHub 与自定义 Source 使用不同的签名密钥；不要把通用 signingSecret 误当成
  // GitHub webhook secret，否则同时配置两个密钥时 GitHub 事件会全部验签失败。
  const secret = input.signatureSecret ?? (input.github
    ? input.source.secrets.githubWebhookSecret ?? input.source.secrets.signingSecret
    : input.source.secrets.signingSecret ?? input.source.secrets.githubWebhookSecret);
  if (!secret) throw new IngressError('SOURCE_SECRET_MISSING', '消息源尚未配置签名密钥', 503);
  const signatureHeader = input.github ? 'x-hub-signature-256' : 'x-agentdock-signature';
  const signature = header(input.headers, signatureHeader);
  if (!signature || !safeEqual(signature, signatureFor(input.body, secret))) throw new IngressError('INVALID_SIGNATURE', '事件签名无效', 401);
  if (!input.github) {
    const rawTimestamp = header(input.headers, 'x-agentdock-timestamp');
    const timestamp = rawTimestamp ? Number(rawTimestamp) : Number.NaN;
    if (!Number.isFinite(timestamp)) throw new IngressError('INVALID_TIMESTAMP', '事件时间戳无效', 401);
    if (Math.abs(now.getTime() - timestamp) > (input.toleranceMs ?? defaultSignatureToleranceMs)) throw new IngressError('STALE_EVENT', '事件时间戳超出允许范围', 401);
  }
  const parsed = parseJson(input.body);
  let normalized: { envelope: SourceEnvelope; ignored: boolean; reason?: string; action?: string };
  if (input.github) normalized = normalizeGithubWebhook({ body: input.body, headers: input.headers, sourceId: input.sourceId });
  else {
    const envelope = normalizeEnvelope(parsed, input.sourceId);
    normalized = { envelope, ignored: false };
  }
  const envelope = normalized.envelope;
  const allowedRepos = input.source.config.allowedRepos;
  const repo = asString((envelope.payload as JsonObject).repository && isRecord((envelope.payload as JsonObject).repository) ? ((envelope.payload as JsonObject).repository as JsonObject).full_name : undefined);
  if (repo && allowedRepos?.length && !allowedRepos.includes(repo)) throw new IngressError('REPO_NOT_ALLOWED', `仓库不在白名单：${repo}`, 403);
  const allowedEvents = input.source.config.allowedEvents;
  if (allowedEvents?.length && !allowedEvents.includes(envelope.eventType)) normalized = { ...normalized, ignored: true, reason: `事件类型不在白名单：${envelope.eventType}` };
  const agentdockComment = isRecord(envelope.payload) && isRecord(envelope.payload.comment) && /<!--\s*agentdock:/i.test(String((envelope.payload.comment as JsonObject).body ?? ''));
  const selfEcho = envelope.actor?.isBot === true && agentdockComment;
  if (selfEcho) normalized = { ...normalized, ignored: true, reason: 'AgentDock 自己发出的评论回声，已忽略' };
  const correlation = correlationFor(input.source.config.correlation, envelope);
  const bodyRecord = isRecord(parsed) ? parsed : {};
  const checkpoint = asString(bodyRecord.cursor) ?? asString(bodyRecord.checkpoint) ?? envelope.eventId;
  return {
    envelope, body: input.body, correlationKey: correlation.key,
    ...(correlation.reason ? { correlationReason: correlation.reason } : {}),
    ...(normalized.ignored ? { ignored: true } : {}),
    ...(normalized.reason ? { ignoreReason: normalized.reason } : {}),
    checkpoint
  };
}
