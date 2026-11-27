/**
 * 通知设置持久化 Schema、脱敏与校验。
 *
 * 存放在 SQLite `configs` 表的 `notifications.config` 键下（与 side_chat.config / lark.bots 保持一致）。
 * 所有敏感凭据（Webhook 签名密钥、Authorization / Token / Secret / Key / Cookie 类 Header）
 * 下发到前端或写日志时一律脱敏；保存时若前端回传占位或留空则保留原密文，避免误覆盖。
 */
import { RuntimeError } from '@agent-dock/agent-dock-shared';
import { z } from 'zod';

export const notificationsConfigKey = 'notifications.config';

export const notificationEventKinds = ['completed', 'failed', 'waiting_approval', 'notify'] as const;
export type NotificationEventKind = (typeof notificationEventKinds)[number];

export const notificationRuleEventKinds = ['completed', 'failed', 'waiting_approval'] as const;
export type NotificationRuleEventKind = (typeof notificationRuleEventKinds)[number];

export const scheduledNotifyModes = ['all', 'failed_only', 'off'] as const;
export type ScheduledNotifyMode = (typeof scheduledNotifyModes)[number];

export const larkNotifyTargetModes = ['auto_handover_then_fallback', 'direct_user', 'chat'] as const;
export type LarkNotifyTargetMode = (typeof larkNotifyTargetModes)[number];

export const webhookPresets = [
  'generic',
  'lark_webhook',
  'dingtalk',
  'wecom',
  'bark',
  'ntfy',
  'slack',
  'discord'
] as const;
export type WebhookPreset = (typeof webhookPresets)[number];

export const MASKED_SECRET_SENTINEL = '__AGENTDOCK_KEEP_SECRET__';

const sensitiveHeaderPattern = /^(?:authorization|proxy-authorization|cookie|set-cookie|x-api-key|api-key|apikey|x-auth-token|x-access-token|x-secret|token|secret)$/i;

export function isSensitiveHeaderName(name: string): boolean {
  const normalized = name.trim();
  return sensitiveHeaderPattern.test(normalized) || /(?:secret|token|password|apikey|api-key|auth)/i.test(normalized);
}

export function maskSecretValue(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return '';
  if (trimmed.length <= 6) return '••••••';
  return `${trimmed.slice(0, 3)}••••${trimmed.slice(-2)}`;
}

function isValidHttpUrl(raw: string): boolean {
  try {
    const parsed = new URL(raw);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

const optionalTrimmed = (max = 500) => z.preprocess(
  value => {
    if (typeof value !== 'string') return value;
    const trimmed = value.trim();
    return trimmed ? trimmed : undefined;
  },
  z.string().max(max).optional()
);

export const webhookHeaderEntrySchema = z.object({
  key: z.string().trim().min(1).max(120),
  value: z.string().max(2000)
});
export type WebhookHeaderEntry = z.infer<typeof webhookHeaderEntrySchema>;

export const storedWebhookSchema = z.object({
  id: z.string().trim().min(1).max(120),
  name: z.string().trim().min(1).max(80),
  enabled: z.boolean().default(true),
  preset: z.enum(webhookPresets).default('generic'),
  url: z.string().trim().min(1).max(2048).refine(isValidHttpUrl, 'Webhook 地址必须是 http:// 或 https://'),
  headers: z.array(webhookHeaderEntrySchema).max(20).default([]),
  secret: optionalTrimmed(512),
  timeoutSec: z.number().int().min(1).max(30).default(8),
  events: z.array(z.enum(notificationRuleEventKinds)).optional()
});
export type StoredWebhookConfig = z.infer<typeof storedWebhookSchema>;

export interface PublicWebhookHeaderEntry {
  key: string;
  value: string;
  masked: boolean;
}

export interface PublicWebhookConfig {
  id: string;
  name: string;
  enabled: boolean;
  preset: WebhookPreset;
  url: string;
  headers: PublicWebhookHeaderEntry[];
  hasSecret: boolean;
  timeoutSec: number;
  events?: NotificationRuleEventKind[];
}

export const notificationServerConfigSchema = z.object({
  enabled: z.boolean().default(true),
  events: z.object({
    completed: z.boolean().default(true),
    failed: z.boolean().default(true),
    waitingApproval: z.boolean().default(true)
  }).default({ completed: true, failed: true, waitingApproval: true }),
  antiSpam: z.object({
    minDurationSec: z.number().int().min(0).max(3600).default(10),
    coalesceWindowMs: z.number().int().min(0).max(30_000).default(3000),
    remoteOnlyWhenAway: z.boolean().default(false),
    awayAfterSec: z.number().int().min(5).max(3600).default(30)
  }).default({ minDurationSec: 10, coalesceWindowMs: 3000, remoteOnlyWhenAway: false, awayAfterSec: 30 }),
  scopes: z.object({
    normalSessions: z.boolean().default(true),
    assistantSubtasks: z.boolean().default(false),
    scheduledSessions: z.enum(scheduledNotifyModes).default('failed_only')
  }).default({ normalSessions: true, assistantSubtasks: false, scheduledSessions: 'failed_only' }),
  lark: z.object({
    enabled: z.boolean().default(false),
    appId: optionalTrimmed(120),
    mode: z.enum(larkNotifyTargetModes).default('auto_handover_then_fallback'),
    fallbackReceiveId: optionalTrimmed(160),
    fallbackReceiveIdType: z.enum(['open_id', 'chat_id']).default('open_id'),
    skipOriginalLarkChat: z.boolean().default(true),
    includeSummary: z.boolean().default(true)
  }).default({
    enabled: false,
    mode: 'auto_handover_then_fallback',
    fallbackReceiveIdType: 'open_id',
    skipOriginalLarkChat: true,
    includeSummary: true
  }),
  webhooks: z.array(storedWebhookSchema).max(20).default([]),
  commandHook: z.object({
    enabled: z.boolean().default(false),
    command: z.preprocess(value => typeof value === 'string' ? value.trim() : '', z.string().max(1000)).default(''),
    timeoutSec: z.number().int().min(1).max(30).default(10),
    trustConfirmed: z.boolean().default(false)
  }).default({ enabled: false, command: '', timeoutSec: 10, trustConfirmed: false })
});

export type StoredNotificationConfig = z.infer<typeof notificationServerConfigSchema>;

export interface PublicNotificationConfig extends Omit<StoredNotificationConfig, 'webhooks'> {
  webhooks: PublicWebhookConfig[];
}

export interface ChannelDeliveryStatus {
  ok: boolean;
  at: string;
  durationMs: number;
  statusCode?: number;
  detail?: string;
  error?: string;
}

export interface NotificationConfigState {
  configured: boolean;
  config: PublicNotificationConfig;
  lastDelivery: Record<string, ChannelDeliveryStatus>;
}

export const DEFAULT_NOTIFICATION_CONFIG: StoredNotificationConfig = notificationServerConfigSchema.parse({});

export function toPublicNotificationConfig(stored: StoredNotificationConfig): PublicNotificationConfig {
  return {
    ...stored,
    webhooks: stored.webhooks.map(hook => ({
      id: hook.id,
      name: hook.name,
      enabled: hook.enabled,
      preset: hook.preset,
      url: hook.url,
      headers: hook.headers.map(entry => {
        const sensitive = isSensitiveHeaderName(entry.key) && Boolean(entry.value);
        return {
          key: entry.key,
          value: sensitive ? maskSecretValue(entry.value) : entry.value,
          masked: sensitive
        };
      }),
      hasSecret: Boolean(hook.secret?.trim()),
      timeoutSec: hook.timeoutSec,
      ...(hook.events?.length ? { events: hook.events } : {})
    }))
  };
}

/**
 * 合并用户提交的配置与已存储的密文：
 * - Webhook `secret` 为 `MASKED_SECRET_SENTINEL` 或未传时保留已存密文；显式传空串 `""` 表示清除密钥。
 * - Webhook `headers` 中 `value === MASKED_SECRET_SENTINEL` 或标记 `masked: true` 且值仍是掩码时保留旧值。
 */
export function parseAndMergeNotificationConfig(
  input: unknown,
  existing?: StoredNotificationConfig
): StoredNotificationConfig {
  if (!input || typeof input !== 'object') {
    throw new RuntimeError('INVALID_NOTIFICATION_CONFIG', '通知配置必须是 JSON 对象', 400);
  }
  const rawObj = input as Record<string, unknown>;
  const existingById = new Map((existing?.webhooks ?? []).map(hook => [hook.id, hook]));

  const normalizedWebhooks = Array.isArray(rawObj.webhooks)
    ? rawObj.webhooks.map(item => {
        if (!item || typeof item !== 'object') return item;
        const record = item as Record<string, unknown>;
        const id = typeof record.id === 'string' ? record.id.trim() : '';
        const previous = id ? existingById.get(id) : undefined;
        let secret: string | undefined;
        if (record.secret === MASKED_SECRET_SENTINEL || record.secret === undefined) {
          secret = previous?.secret;
        } else if (typeof record.secret === 'string') {
          secret = record.secret.trim() || undefined;
        }

        const prevHeadersByKey = new Map(
          (previous?.headers ?? []).map(header => [header.key.toLowerCase(), header.value])
        );
        const headers = Array.isArray(record.headers)
          ? record.headers
              .filter((entry): entry is Record<string, unknown> => Boolean(entry && typeof entry === 'object'))
              .map(entry => {
                const key = typeof entry.key === 'string' ? entry.key.trim() : '';
                const rawVal = typeof entry.value === 'string' ? entry.value : '';
                const prevVal = key ? prevHeadersByKey.get(key.toLowerCase()) : undefined;
                const keepOld = entry.masked === true
                  || rawVal === MASKED_SECRET_SENTINEL
                  || (Boolean(prevVal) && isSensitiveHeaderName(key) && rawVal === maskSecretValue(prevVal!));
                return { key, value: keepOld && prevVal !== undefined ? prevVal : rawVal };
              })
              .filter(entry => entry.key.length > 0)
          : [];

        return {
          ...record,
          headers,
          ...(secret ? { secret } : { secret: undefined })
        };
      })
    : rawObj.webhooks;

  const parsed = notificationServerConfigSchema.safeParse({
    ...rawObj,
    ...(normalizedWebhooks !== undefined ? { webhooks: normalizedWebhooks } : {})
  });
  if (!parsed.success) {
    const detail = parsed.error.issues.map(issue => `${issue.path.join('.') || 'config'} ${issue.message}`).join('；');
    throw new RuntimeError('INVALID_NOTIFICATION_CONFIG', `通知配置不合法：${detail}`, 400);
  }
  const config = parsed.data;
  if (config.commandHook.enabled) {
    if (!config.commandHook.trustConfirmed) {
      throw new RuntimeError('COMMAND_HOOK_TRUST_REQUIRED', '启用本地命令 Hook 前请先确认安全风险提示。', 400);
    }
    if (!config.commandHook.command) {
      throw new RuntimeError('COMMAND_HOOK_EMPTY', '启用本地命令 Hook 时必须填写要执行的命令或脚本路径。', 400);
    }
  }
  if (config.lark.enabled && config.lark.mode === 'chat' && !config.lark.fallbackReceiveId?.startsWith('oc_')) {
    throw new RuntimeError('LARK_NOTIFY_CHAT_REQUIRED', '选择「推送到指定群聊」时，请先选择一个飞书群。', 400);
  }
  return config;
}

export function safeReadStoredNotificationConfig(raw: string | undefined): { configured: boolean; config: StoredNotificationConfig } {
  if (!raw?.trim()) return { configured: false, config: structuredClone(DEFAULT_NOTIFICATION_CONFIG) };
  try {
    const parsed = notificationServerConfigSchema.safeParse(JSON.parse(raw));
    if (!parsed.success) return { configured: false, config: structuredClone(DEFAULT_NOTIFICATION_CONFIG) };
    return { configured: true, config: parsed.data };
  } catch {
    return { configured: false, config: structuredClone(DEFAULT_NOTIFICATION_CONFIG) };
  }
}
