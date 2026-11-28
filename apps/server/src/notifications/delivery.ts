/**
 * 服务端通知通道投递器：飞书机器人、通用 Webhook（含主流生态预设）、本地 Shell Hook。
 *
 * 所有外部投递均设计为异步、带超时保护且绝不抛出未捕获异常阻塞 Agent 轮次；
 * 敏感密钥和 Header 严禁出现在日志、报错或前端返回值中。
 */
import { spawn } from 'node:child_process';
import { createHmac } from 'node:crypto';
import type { ConfigRepository, ChannelMappingRepository } from '@agent-dock/agent-dock-shared';
import { createHandoverLookup } from '../lark/handover-binding.js';
import { readLarkConfigs } from '../lark/config.js';
import {
  buildLarkNotificationSourceBadge,
  buildLarkSourceBadgeElement,
  createLarkCardService,
  LarkServiceError
} from '../lark/service.js';
import { normalizePublicUrl, publicUrlConfigKey } from '../share-link.js';
import { webAccessSessionToken } from '../web-access.js';
import type {
  NotificationEventKind,
  StoredNotificationConfig,
  StoredWebhookConfig,
  WebhookPreset
} from './config.js';

export interface NotificationPayload {
  id: string;
  kind: NotificationEventKind;
  sessionId: string;
  taskId?: string;
  agentId: string;
  sessionTitle: string;
  sessionSource?: string;
  sessionSourceId?: string;
  durationMs?: number;
  summary: string;
  error?: string;
  urgent?: boolean;
  ask?: boolean;
  batchCount?: number;
  sessionUrl?: string;
  timestamp: string;
}

export interface DeliveryResult {
  ok: boolean;
  durationMs: number;
  statusCode?: number;
  detail?: string;
  error?: string;
  consoleUrl?: string;
}

export function formatDurationCompact(durationMs?: number): string {
  if (!durationMs || !Number.isFinite(durationMs) || durationMs <= 0) return '';
  const totalSec = Math.max(1, Math.round(durationMs / 1000));
  if (totalSec < 60) return `${totalSec}s`;
  const minutes = Math.floor(totalSec / 60);
  const seconds = totalSec % 60;
  return seconds ? `${minutes}m ${seconds}s` : `${minutes}m`;
}

export function summarizeNotificationText(raw: string | undefined, maxChars = 180): string {
  if (!raw) return '';
  const plain = raw
    .replace(/```[\s\S]*?```/g, '[代码片段]')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\[([^\]]+)]\([^)]+\)/g, '$1')
    .replace(/<[^>]+>/g, '')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/[*~>]+/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (plain.length <= maxChars) return plain;
  return `${plain.slice(0, Math.max(1, maxChars - 1)).trimEnd()}…`;
}

export function notificationKindMeta(kind: NotificationEventKind, ask?: boolean): {
  label: string;
  verb: string;
  larkTemplate: 'green' | 'red' | 'orange' | 'blue';
  discordColor: number;
  ntfyPriority: string;
  ntfyTags: string;
} {
  if (kind === 'waiting_approval' || (kind === 'notify' && ask)) {
    return {
      label: ask ? '需要你拍板' : '等待授权',
      verb: ask ? '请你拍板' : '等待审批',
      larkTemplate: 'orange',
      discordColor: 0xf59e0b,
      ntfyPriority: 'high',
      ntfyTags: 'warning'
    };
  }
  if (kind === 'failed') {
    return {
      label: '运行失败',
      verb: '执行出错',
      larkTemplate: 'red',
      discordColor: 0xef4444,
      ntfyPriority: 'high',
      ntfyTags: 'x'
    };
  }
  if (kind === 'notify') {
    return {
      label: '主动提醒',
      verb: '发来提醒',
      larkTemplate: 'blue',
      discordColor: 0x3b82f6,
      ntfyPriority: 'default',
      ntfyTags: 'bell'
    };
  }
  return {
    label: '已完成',
    verb: '已完成',
    larkTemplate: 'green',
    discordColor: 0x10b981,
    ntfyPriority: 'default',
    ntfyTags: 'white_check_mark'
  };
}

export function buildNotificationHeading(payload: NotificationPayload): string {
  const meta = notificationKindMeta(payload.kind, payload.ask);
  if (payload.batchCount && payload.batchCount > 1) {
    return `AgentDock · ${payload.batchCount} 项任务${meta.verb}`;
  }
  return `${payload.sessionTitle || 'AgentDock 会话'} · ${meta.label}`;
}

export function buildNotificationBody(payload: NotificationPayload): string {
  const parts: string[] = [];
  const elapsed = formatDurationCompact(payload.durationMs);
  if (payload.agentId || elapsed) {
    parts.push([payload.agentId, elapsed ? `耗时 ${elapsed}` : ''].filter(Boolean).join(' · '));
  }
  const text = payload.error || payload.summary;
  if (text) parts.push(summarizeNotificationText(text, 220));
  return parts.join('\n') || '任务状态已更新。';
}

/** 构造带会话令牌的直达链接：优先机器人 webBaseUrl，其次系统 web.public_url / 环境变量。 */
export async function resolveSessionActionUrl(options: {
  sessionId: string;
  botWebBaseUrl?: string;
  configRepo?: ConfigRepository;
  env?: NodeJS.ProcessEnv;
}): Promise<string | undefined> {
  const base = options.botWebBaseUrl?.trim().replace(/\/$/, '')
    || normalizePublicUrl(options.env?.AGENTDOCK_PUBLIC_URL)
    || normalizePublicUrl(await options.configRepo?.get(publicUrlConfigKey));
  if (!base) return undefined;
  const token = webAccessSessionToken(options.sessionId);
  const path = `/sessions/${encodeURIComponent(options.sessionId)}`;
  return token ? `${base}${path}?t=${encodeURIComponent(token)}` : `${base}${path}`;
}

/** RFC 2047 UTF-8 Base64 header encoding，确保 ntfy 的 X-Title 含中文时不会触发 Node fetch 非法字符异常。 */
function encodeHeaderUtf8(value: string): string {
  return /^[\x20-\x7e]*$/.test(value)
    ? value
    : `=?UTF-8?B?${Buffer.from(value, 'utf8').toString('base64')}?=`;
}

export function buildWebhookRequest(
  preset: WebhookPreset,
  payload: NotificationPayload
): { contentType: string; body: string; extraHeaders?: Record<string, string> } {
  const title = buildNotificationHeading(payload);
  const bodyText = buildNotificationBody(payload);
  const meta = notificationKindMeta(payload.kind, payload.ask);
  const elapsed = formatDurationCompact(payload.durationMs);
  const linkLine = payload.sessionUrl ? `\n[在 AgentDock 查看](${payload.sessionUrl})` : '';

  switch (preset) {
    case 'lark_webhook': {
      const sourceBadge = buildLarkNotificationSourceBadge(payload.sessionSource);
      const badgeEl = buildLarkSourceBadgeElement({ label: sourceBadge.label, color: sourceBadge.color }, { margin: '0px 0px 4px 0px' });
      const elements: Array<Record<string, unknown>> = [
        ...(badgeEl ? [badgeEl] : []),
        { tag: 'markdown', content: `${bodyText}${linkLine}` }
      ];
      return {
        contentType: 'application/json; charset=utf-8',
        body: JSON.stringify({
          msg_type: 'interactive',
          card: {
            schema: '2.0',
            config: { wide_screen_mode: true },
            header: {
              template: meta.larkTemplate,
              title: { tag: 'plain_text', content: title }
            },
            body: {
              direction: 'vertical',
              elements
            }
          }
        })
      };
    }
    case 'dingtalk':
      return {
        contentType: 'application/json; charset=utf-8',
        body: JSON.stringify({
          msgtype: 'markdown',
          markdown: {
            title,
            text: `### ${title}\n\n${bodyText.replace(/\n/g, '\n\n')}${linkLine}`
          }
        })
      };
    case 'wecom':
      return {
        contentType: 'application/json; charset=utf-8',
        body: JSON.stringify({
          msgtype: 'markdown',
          markdown: {
            content: `**${title}**\n${bodyText}${linkLine}`
          }
        })
      };
    case 'bark':
      return {
        contentType: 'application/json; charset=utf-8',
        body: JSON.stringify({
          title,
          body: bodyText,
          group: 'AgentDock',
          ...(payload.sessionUrl ? { url: payload.sessionUrl } : {})
        })
      };
    case 'ntfy':
      return {
        contentType: 'text/plain; charset=utf-8',
        body: bodyText,
        extraHeaders: {
          Title: encodeHeaderUtf8(title),
          Priority: meta.ntfyPriority,
          Tags: meta.ntfyTags,
          ...(payload.sessionUrl ? { Click: payload.sessionUrl } : {})
        }
      };
    case 'slack':
      return {
        contentType: 'application/json; charset=utf-8',
        body: JSON.stringify({
          text: `${title}\n${bodyText}${payload.sessionUrl ? `\n${payload.sessionUrl}` : ''}`,
          blocks: [
            { type: 'header', text: { type: 'plain_text', text: title.slice(0, 150) } },
            { type: 'section', text: { type: 'mrkdwn', text: `${bodyText}${payload.sessionUrl ? `\n<${payload.sessionUrl}|在 AgentDock 查看>` : ''}` } }
          ]
        })
      };
    case 'discord':
      return {
        contentType: 'application/json; charset=utf-8',
        body: JSON.stringify({
          embeds: [{
            title: title.slice(0, 250),
            description: bodyText.slice(0, 3500),
            color: meta.discordColor,
            ...(payload.sessionUrl ? { url: payload.sessionUrl } : {}),
            footer: { text: [payload.agentId, elapsed ? `耗时 ${elapsed}` : ''].filter(Boolean).join(' · ') || 'AgentDock' },
            timestamp: payload.timestamp
          }]
        })
      };
    case 'generic':
    default:
      return {
        contentType: 'application/json; charset=utf-8',
        body: JSON.stringify({
          event: payload.kind,
          id: payload.id,
          title,
          sessionId: payload.sessionId,
          taskId: payload.taskId,
          sessionTitle: payload.sessionTitle,
          agentId: payload.agentId,
          status: payload.kind,
          durationMs: payload.durationMs,
          summary: payload.summary,
          error: payload.error,
          urgent: payload.urgent === true,
          ask: payload.ask === true,
          batchCount: payload.batchCount,
          sessionUrl: payload.sessionUrl,
          timestamp: payload.timestamp
        })
      };
  }
}

export async function deliverWebhookNotification(
  hook: StoredWebhookConfig,
  payload: NotificationPayload,
  options: { fetcher?: typeof globalThis.fetch; retries?: number } = {}
): Promise<DeliveryResult> {
  const startedAt = Date.now();
  const fetcher = options.fetcher ?? globalThis.fetch;
  const retries = options.retries ?? 1;
  const timeoutMs = Math.max(1_000, Math.min(30_000, (hook.timeoutSec || 8) * 1000));
  const built = buildWebhookRequest(hook.preset, payload);
  const headers: Record<string, string> = {
    'content-type': built.contentType,
    'user-agent': 'AgentDock-Notifier/1.0',
    ...(built.extraHeaders ?? {})
  };
  for (const entry of hook.headers ?? []) {
    if (entry.key.trim()) headers[entry.key.trim()] = entry.value;
  }
  if (hook.secret?.trim()) {
    const signature = createHmac('sha256', hook.secret.trim()).update(built.body).digest('hex');
    headers['x-agentdock-signature'] = `sha256=${signature}`;
  }

  let lastResult: DeliveryResult = { ok: false, durationMs: 0, error: '请求未执行' };
  for (let attempt = 0; attempt <= retries; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetcher(hook.url, {
        method: 'POST',
        headers,
        body: built.body,
        signal: controller.signal
      });
      const responseText = await response.text().catch(() => '');
      const durationMs = Date.now() - startedAt;
      if (response.ok) {
        return {
          ok: true,
          statusCode: response.status,
          durationMs,
          detail: `HTTP ${response.status}`
        };
      }
      const snippet = summarizeNotificationText(responseText, 140);
      lastResult = {
        ok: false,
        statusCode: response.status,
        durationMs,
        error: `HTTP ${response.status}${snippet ? `：${snippet}` : ''}`
      };
      if (response.status < 500 || attempt >= retries) return lastResult;
    } catch (error) {
      const durationMs = Date.now() - startedAt;
      const aborted = controller.signal.aborted;
      lastResult = {
        ok: false,
        durationMs,
        error: aborted ? `请求超时（>${hook.timeoutSec || 8}s）` : (error instanceof Error ? error.message : String(error))
      };
      if (attempt >= retries) return lastResult;
    } finally {
      clearTimeout(timer);
    }
    await new Promise(resolve => setTimeout(resolve, 400 * (attempt + 1)));
  }
  return lastResult;
}

/**
 * 执行本地命令 Hook。
 * 安全规范：严禁将标题/摘要拼接进命令字符串；一律通过 `AGENTDOCK_NOTIFY_*` 环境变量与 stdin JSON 传入，
 * 独立进程组运行并在超时后终止整组进程（Unix `-pid` / Windows kill），避免遗留孤儿进程。
 */
export async function deliverCommandHook(
  hook: StoredNotificationConfig['commandHook'],
  payload: NotificationPayload,
  options: { env?: NodeJS.ProcessEnv; cwd?: string } = {}
): Promise<DeliveryResult> {
  const startedAt = Date.now();
  const command = hook.command.trim();
  if (!command) return { ok: false, durationMs: 0, error: '未配置执行命令' };
  const timeoutMs = Math.max(1_000, Math.min(30_000, (hook.timeoutSec || 10) * 1000));
  const title = buildNotificationHeading(payload);
  const env: NodeJS.ProcessEnv = {
    ...(options.env ?? process.env),
    AGENTDOCK_NOTIFY_EVENT: payload.kind,
    AGENTDOCK_NOTIFY_ID: payload.id,
    AGENTDOCK_NOTIFY_TITLE: title,
    AGENTDOCK_SESSION_ID: payload.sessionId,
    AGENTDOCK_SESSION_TITLE: payload.sessionTitle,
    AGENTDOCK_AGENT_ID: payload.agentId,
    AGENTDOCK_STATUS: payload.kind,
    AGENTDOCK_DURATION_MS: payload.durationMs !== undefined ? String(payload.durationMs) : '',
    AGENTDOCK_SUMMARY: payload.summary,
    AGENTDOCK_ERROR: payload.error ?? '',
    AGENTDOCK_SESSION_URL: payload.sessionUrl ?? '',
    AGENTDOCK_TIMESTAMP: payload.timestamp
  };
  const stdinJson = JSON.stringify({
    event: payload.kind,
    id: payload.id,
    title,
    sessionId: payload.sessionId,
    taskId: payload.taskId,
    sessionTitle: payload.sessionTitle,
    agentId: payload.agentId,
    status: payload.kind,
    durationMs: payload.durationMs,
    summary: payload.summary,
    error: payload.error,
    sessionUrl: payload.sessionUrl,
    timestamp: payload.timestamp
  });

  const isWin = process.platform === 'win32';
  const shellBin = isWin ? (process.env.ComSpec || 'cmd.exe') : '/bin/sh';
  const shellArgs = isWin ? ['/d', '/s', '/c', command] : ['-c', command];

  return await new Promise<DeliveryResult>(resolve => {
    let settled = false;
    let timedOut = false;
    let stdout = '';
    let stderr = '';
    const appendCapped = (current: string, chunk: Buffer | string) => {
      if (current.length >= 2048) return current;
      return (current + String(chunk)).slice(0, 2048);
    };

    const child = spawn(shellBin, shellArgs, {
      env,
      cwd: options.cwd ?? process.cwd(),
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      detached: !isWin
    });

    const killGroup = (signal: NodeJS.Signals) => {
      if (!child.pid) return;
      try {
        if (!isWin) process.kill(-child.pid, signal);
        else child.kill(signal);
      } catch {
        try { child.kill(signal); } catch { /* already exited */ }
      }
    };

    const finish = (result: DeliveryResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };

    const timer = setTimeout(() => {
      timedOut = true;
      killGroup('SIGTERM');
      const forceTimer = setTimeout(() => killGroup('SIGKILL'), 800);
      forceTimer.unref();
    }, timeoutMs);
    timer.unref();

    child.stdout?.on('data', chunk => { stdout = appendCapped(stdout, chunk); });
    child.stderr?.on('data', chunk => { stderr = appendCapped(stderr, chunk); });
    child.once('error', error => {
      finish({ ok: false, durationMs: Date.now() - startedAt, error: error.message });
    });
    child.once('close', (code, signal) => {
      const durationMs = Date.now() - startedAt;
      if (timedOut) {
        finish({ ok: false, durationMs, error: `命令执行超时（>${hook.timeoutSec || 10}s），已强制终止` });
        return;
      }
      if (code === 0) {
        const preview = summarizeNotificationText(stdout, 120);
        finish({ ok: true, durationMs, detail: preview ? `退出码 0 · ${preview}` : '退出码 0' });
        return;
      }
      const errPreview = summarizeNotificationText(stderr || stdout, 160);
      finish({
        ok: false,
        durationMs,
        error: `命令退出异常（code=${code ?? 'null'}${signal ? ` signal=${signal}` : ''}）${errPreview ? `：${errPreview}` : ''}`
      });
    });

    try {
      child.stdin?.end(stdinJson);
    } catch { /* ignore broken pipe */ }
  });
}

export async function deliverLarkNotification(
  larkConfig: StoredNotificationConfig['lark'],
  payload: NotificationPayload,
  deps: {
    configRepo?: ConfigRepository;
    channelMappings?: ChannelMappingRepository;
    env?: NodeJS.ProcessEnv;
    fetcher?: typeof globalThis.fetch;
  }
): Promise<DeliveryResult> {
  const startedAt = Date.now();
  const bots = await readLarkConfigs(deps.configRepo);
  if (!bots.length) {
    return { ok: false, durationMs: Date.now() - startedAt, error: '尚未配置飞书机器人，请先在「飞书设置」中绑定。' };
  }
  const bot = (larkConfig.appId ? bots.find(item => item.appId === larkConfig.appId) : undefined) ?? bots[0]!;
  const larkService = createLarkCardService(deps.env ?? process.env, deps.fetcher ?? globalThis.fetch, {
    appId: bot.appId,
    appSecret: bot.appSecret
  });

  // 1) 识别原飞书会话所在群，防止飞书原群重复推送
  const originLarkChatId = payload.sessionSource === 'lark' && payload.sessionSourceId
    ? payload.sessionSourceId.split(':')[1]
    : undefined;

  // 2) 解析推送目标（智能托管群 > 兜底配置 > 机器人创建者私聊）
  let receiveId: string | undefined;
  let receiveIdType: 'open_id' | 'chat_id' = larkConfig.fallbackReceiveIdType;
  let usedAppId = bot.appId;

  if (larkConfig.mode === 'auto_handover_then_fallback' && deps.configRepo && deps.channelMappings && payload.sessionId) {
    const handover = await createHandoverLookup(deps.configRepo, deps.channelMappings)(payload.sessionId);
    if (handover) {
      receiveId = handover.chatId;
      receiveIdType = 'chat_id';
      usedAppId = handover.appId;
    }
  }

  if (!receiveId) {
    if (larkConfig.mode === 'chat') {
      receiveId = larkConfig.fallbackReceiveId?.trim();
      receiveIdType = 'chat_id';
    } else if (larkConfig.fallbackReceiveId?.trim()) {
      receiveId = larkConfig.fallbackReceiveId.trim();
      receiveIdType = receiveId.startsWith('oc_') ? 'chat_id' : 'open_id';
    } else {
      try {
        const owner = await larkService.getAppOwner();
        if (owner.openId) {
          receiveId = owner.openId;
          receiveIdType = 'open_id';
        }
      } catch (error) {
        const larkErr = error instanceof LarkServiceError ? error : undefined;
        return {
          ok: false,
          durationMs: Date.now() - startedAt,
          error: `无法自动获取机器人创建者 open_id，请手动选择目标群或填写接收人：${error instanceof Error ? error.message : String(error)}`,
          ...(larkErr?.details?.consoleUrl ? { consoleUrl: String(larkErr.details.consoleUrl) } : {})
        };
      }
    }
  }

  if (!receiveId) {
    return {
      ok: false,
      durationMs: Date.now() - startedAt,
      error: '未解析到飞书推送目标，请在「飞书推送」中选择目标群或私聊接收人。'
    };
  }

  if (larkConfig.skipOriginalLarkChat && receiveIdType === 'chat_id' && originLarkChatId && receiveId === originLarkChatId) {
    return { ok: true, durationMs: Date.now() - startedAt, detail: '原飞书群已有回复，已自动跳过重复推送' };
  }

  const targetBot = bots.find(item => item.appId === usedAppId) ?? bot;
  const sender = targetBot.appId === bot.appId
    ? larkService
    : createLarkCardService(deps.env ?? process.env, deps.fetcher ?? globalThis.fetch, {
        appId: targetBot.appId,
        appSecret: targetBot.appSecret
      });

  const actionUrl = payload.sessionUrl ?? await resolveSessionActionUrl({
    sessionId: payload.sessionId,
    botWebBaseUrl: targetBot.webBaseUrl,
    configRepo: deps.configRepo,
    env: deps.env
  });

  const meta = notificationKindMeta(payload.kind, payload.ask);
  const elapsed = formatDurationCompact(payload.durationMs);
  const subtitle = [payload.agentId, elapsed ? `用时 ${elapsed}` : ''].filter(Boolean).join(' · ');
  const bodyLines: string[] = [];
  if (payload.error) {
    bodyLines.push(`**原因**：${summarizeNotificationText(payload.error, 260)}`);
  } else if (larkConfig.includeSummary && payload.summary) {
    bodyLines.push(summarizeNotificationText(payload.summary, 260));
  } else {
    bodyLines.push(`会话「${payload.sessionTitle}」已${meta.verb}。`);
  }

  try {
    const result = await sender.sendNotificationCard({
      receiveId,
      receiveIdType,
      title: buildNotificationHeading(payload),
      ...(subtitle ? { subtitle } : {}),
      markdown: bodyLines.join('\n\n'),
      summary: `${buildNotificationHeading(payload)}：${summarizeNotificationText(payload.error || payload.summary, 80)}`,
      template: meta.larkTemplate,
      sourceBadge: buildLarkNotificationSourceBadge(payload.sessionSource),
      ...(actionUrl ? { actionUrl, actionLabel: '在 AgentDock 查看' } : {}),
      idempotencyKey: `adn-${payload.id.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 42)}`
    });
    return {
      ok: true,
      durationMs: Date.now() - startedAt,
      detail: `已通过「${targetBot.name ?? targetBot.appId}」送达（${receiveIdType === 'open_id' ? '私聊' : '群聊'} · ${result.messageId.slice(-8)}）`
    };
  } catch (error) {
    const larkErr = error instanceof LarkServiceError ? error : undefined;
    return {
      ok: false,
      durationMs: Date.now() - startedAt,
      error: error instanceof Error ? error.message : String(error),
      ...(larkErr?.details?.consoleUrl ? { consoleUrl: String(larkErr.details.consoleUrl) } : {})
    };
  }
}
