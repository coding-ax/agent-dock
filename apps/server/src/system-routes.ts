import type { FastifyInstance } from 'fastify';
import { execFile } from 'node:child_process';
import { homedir } from 'node:os';
import { promisify } from 'node:util';
import { DEFAULT_LOCALE, DEFAULT_LOCALE_PREFERENCE, isLocale, isLocalePreference } from '@agent-dock/agent-dock-shared';
import type { AutostartService } from './daemon/autostart.js';
import type { KeepAwakeService } from './daemon/keep-awake.js';
import type { LocaleService } from './locale-service.js';
import { discoverSkills } from './skill-catalog.js';

const execFileAsync = promisify(execFile);

export interface SystemRoutesOptions {
  platform?: NodeJS.Platform;
  selectDirectory?: () => Promise<string>;
  selectFile?: () => Promise<string>;
  discoverSkills?: typeof discoverSkills;
  /** 开机自启（macOS launchd）；未提供时接口返回 supported:false。 */
  autostart?: AutostartService;
  /** 运行时永不休眠（macOS caffeinate）；未提供时接口返回 supported:false。 */
  keepAwake?: KeepAwakeService;
  /** 全局界面与飞书卡片语言偏好持久化服务。 */
  locale?: LocaleService;
}

async function selectMacDirectory() {
  const { stdout } = await execFileAsync('/usr/bin/osascript', [
    '-e',
    'POSIX path of (choose folder with prompt "选择 Agent 工作区")'
  ], { timeout: 120_000 });
  return stdout.trim().replace(/\/$/, '') || '/';
}

async function selectMacFile() {
  const { stdout } = await execFileAsync('/usr/bin/osascript', [
    '-e',
    'POSIX path of (choose file with prompt "选择要引用的本地文件")'
  ], { timeout: 120_000 });
  return stdout.trim();
}

export async function registerSystemRoutes(
  app: FastifyInstance,
  options: SystemRoutesOptions = {},
  streams?: Set<import('node:http').ServerResponse>
) {
  const platform = options.platform ?? process.platform;
  const supported = platform === 'darwin';
  app.get('/api/system/capabilities', async () => ({ platform, directoryPicker: supported, filePicker: supported, workingDirectory: process.cwd(), homeDirectory: homedir() }));
  app.get('/api/system/locale', async (_request, reply) => {
    reply.header('cache-control', 'no-store');
    if (options.locale) return options.locale.getState();
    return { preference: DEFAULT_LOCALE_PREFERENCE, locale: DEFAULT_LOCALE, configured: false, revision: 0 };
  });
  app.put<{ Body: { preference?: unknown; locale?: unknown } }>('/api/system/locale', async (request, reply) => {
    reply.header('cache-control', 'no-store');
    const body = request.body ?? {};
    if (!isLocalePreference(body.preference)) {
      return reply.code(400).send({ error: { code: 'INVALID_LOCALE_REQUEST', message: 'preference must be one of: system, zh-CN, en-US' } });
    }
    if (body.locale !== undefined && !isLocale(body.locale)) {
      return reply.code(400).send({ error: { code: 'INVALID_LOCALE_REQUEST', message: 'locale must be one of: zh-CN, en-US' } });
    }
    if (!options.locale) {
      const preference = body.preference;
      const locale = preference === 'zh-CN' || preference === 'en-US'
        ? preference
        : isLocale(body.locale) ? body.locale : DEFAULT_LOCALE;
      return { preference, locale, configured: true, revision: 1 };
    }
    return options.locale.setLocale(body);
  });
  app.get('/api/system/locale/stream', async (request, reply) => {
    reply.hijack();
    streams?.add(reply.raw);
    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no'
    });
    reply.raw.write(': connected\n\n');
    const unsubscribe = options.locale?.subscribe(event => {
      if (request.raw.destroyed) return;
      reply.raw.write(`id: ${event.revision}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
    });
    const heartbeat = setInterval(() => {
      if (!request.raw.destroyed) reply.raw.write(': heartbeat\n\n');
    }, 15_000);
    request.raw.once('close', () => {
      clearInterval(heartbeat);
      unsubscribe?.();
      streams?.delete(reply.raw);
    });
  });
  app.get('/api/system/autostart', async () => options.autostart?.status() ?? { supported: false, enabled: false, reason: '当前运行方式不支持' });
  app.put<{ Body: { enabled?: unknown } }>('/api/system/autostart', async (request, reply) => {
    const enabled = request.body?.enabled;
    if (typeof enabled !== 'boolean') return reply.code(400).send({ error: { code: 'INVALID_AUTOSTART_REQUEST', message: 'enabled must be a boolean' } });
    if (!options.autostart) return reply.code(501).send({ error: { code: 'AUTOSTART_UNSUPPORTED', message: '当前运行方式不支持开机自启' } });
    try { return enabled ? await options.autostart.enable() : await options.autostart.disable(); }
    catch (error) { return reply.code(409).send({ error: { code: 'AUTOSTART_FAILED', message: error instanceof Error ? error.message : String(error) } }); }
  });
  app.get('/api/system/keep-awake', async () => options.keepAwake?.status() ?? { supported: false, enabled: false, keepDisplay: false, reason: '当前运行方式不支持' });
  app.put<{ Body: { enabled?: unknown; keepDisplay?: unknown } }>('/api/system/keep-awake', async (request, reply) => {
    const body = request.body ?? {};
    const { enabled, keepDisplay } = body;
    const isBoolean = (value: unknown) => value === undefined || typeof value === 'boolean';
    if (!isBoolean(enabled) || !isBoolean(keepDisplay) || (enabled === undefined && keepDisplay === undefined)) {
      return reply.code(400).send({ error: { code: 'INVALID_KEEP_AWAKE_REQUEST', message: 'enabled / keepDisplay must be booleans' } });
    }
    if (!options.keepAwake) return reply.code(501).send({ error: { code: 'KEEP_AWAKE_UNSUPPORTED', message: '当前运行方式不支持永不休眠' } });
    try {
      return await options.keepAwake.set({
        ...(typeof enabled === 'boolean' ? { enabled } : {}),
        ...(typeof keepDisplay === 'boolean' ? { keepDisplay } : {})
      });
    } catch (error) {
      return reply.code(409).send({ error: { code: 'KEEP_AWAKE_FAILED', message: error instanceof Error ? error.message : String(error) } });
    }
  });
  app.get<{ Querystring: { cwd?: string } }>('/api/system/skills', async request => (options.discoverSkills ?? discoverSkills)(request.query.cwd));
  app.post('/api/system/select-directory', async (_request, reply) => {
    if (!supported) return reply.code(501).send({ error: { code: 'DIRECTORY_PICKER_UNSUPPORTED', message: 'The native directory picker is currently available on macOS only' } });
    try {
      const path = await (options.selectDirectory ?? selectMacDirectory)();
      if (!path) return reply.code(409).send({ error: { code: 'DIRECTORY_SELECTION_CANCELLED', message: 'Directory selection was cancelled' } });
      return { path };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (/cancel/i.test(message) || /-128/.test(message)) return reply.code(409).send({ error: { code: 'DIRECTORY_SELECTION_CANCELLED', message: 'Directory selection was cancelled' } });
      throw error;
    }
  });
  app.post('/api/system/select-file', async (_request, reply) => {
    if (!supported) return reply.code(501).send({ error: { code: 'FILE_PICKER_UNSUPPORTED', message: 'The native file picker is currently available on macOS only' } });
    try {
      const path = await (options.selectFile ?? selectMacFile)();
      if (!path) return reply.code(409).send({ error: { code: 'FILE_SELECTION_CANCELLED', message: 'File selection was cancelled' } });
      return { path };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (/cancel/i.test(message) || /-128/.test(message)) return reply.code(409).send({ error: { code: 'FILE_SELECTION_CANCELLED', message: 'File selection was cancelled' } });
      throw error;
    }
  });
}
