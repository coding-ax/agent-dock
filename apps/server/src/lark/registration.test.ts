import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../app.js';
import { createRepositories } from '@agent-dock/agent-dock-storage';
import { readLarkConfigs } from './config.js';
import { registerLarkBot } from '../../../web/src/lark-registration.js';
import type { LarkRoutesOptions } from './routes.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); });
async function fixture(registerApp: NonNullable<LarkRoutesOptions['registerApp']>, overrides: Partial<LarkRoutesOptions> = {}) {
  const repos = createRepositories(':memory:');
  const listener = { listening: false, activeAppIds: [] as string[], sync: vi.fn(async () => {}), stop: vi.fn() };
  const fetcher = vi.fn(async (url: string | URL | Request) => new Response(JSON.stringify(String(url).includes('tenant_access_token')
    ? { code: 0, tenant_access_token: 'token', expire: 7200 }
    : { code: 0, bot: { app_name: '扫码测试机器人', open_id: 'ou_bot' } }), { headers: { 'content-type': 'application/json' } }));
  const app = await buildApp({} as any, { lark: { config: repos.config, env: {}, listener, registerApp, fetcher: fetcher as typeof fetch, ...overrides } });
  const address = await app.listen({ host: '127.0.0.1', port: 0 });
  cleanups.push(async () => { await app.close(); repos.close(); });
  const clientFetch: typeof fetch = (input, init) => fetch(`${address}${input}`, init);
  return { repos, listener, clientFetch, address };
}
const credentials = { client_id: 'cli_created', client_secret: 'sensitive-test-secret' };

describe('one-click registration HTTP flow', () => {
  it('streams QR progress to the real web client, persists credentials and returns only public configuration', async () => {
    const registrar = vi.fn(async (options: Parameters<NonNullable<LarkRoutesOptions['registerApp']>>[0]) => {
      expect(options.createOnly).toBe(true);
      options.onQRCodeReady({ url: 'https://open.feishu.cn/scan?test=1', expireIn: 600 });
      await new Promise(resolve => setTimeout(resolve, 20));
      // POST body completion must not cancel a still-open response.
      expect(options.signal?.aborted).toBe(false);
      options.onStatusChange?.({ status: 'polling' });
      return credentials;
    });
    const f = await fixture(registrar);
    const progress = vi.fn();
    const result = await registerLarkBot(new AbortController().signal, progress, f.clientFetch);
    expect(progress).toHaveBeenCalledWith(expect.objectContaining({ kind: 'waiting', url: expect.stringContaining('/scan') }));
    expect(progress).toHaveBeenCalledWith({ kind: 'saving' });
    expect(result).toMatchObject({ appId: 'cli_created', appName: '扫码测试机器人', config: { bots: [expect.objectContaining({ setupComplete: false })] } });
    expect(JSON.stringify(result)).not.toContain(credentials.client_secret);
    expect(await readLarkConfigs(f.repos.config)).toEqual([expect.objectContaining({ appSecret: credentials.client_secret, listening: true })]);
    expect(f.listener.sync).toHaveBeenLastCalledWith([expect.objectContaining({ appId: 'cli_created' })]);
  });

  it('keeps credentials when name lookup fails and respects disabled listening', async () => {
    const f = await fixture(async () => credentials, { listeningDisabled: true, fetcher: vi.fn(async () => { throw new Error('unavailable'); }) });
    const result = await registerLarkBot(new AbortController().signal, vi.fn(), f.clientFetch);
    expect(result.warning).toContain('凭证已保存');
    expect(result.config.listeningDisabled).toBe(true);
    expect((await readLarkConfigs(f.repos.config))[0]).toMatchObject({ appSecret: credentials.client_secret, listening: false });
    expect(f.listener.sync).not.toHaveBeenCalled();
  });

  it('aborts on response disconnect, rejects concurrent creation and ignores a late SDK success', async () => {
    let signal: AbortSignal | undefined;
    let finish!: (value: typeof credentials) => void;
    const f = await fixture(async options => {
      signal = options.signal;
      options.onQRCodeReady({ url: 'https://open.feishu.cn/scan', expireIn: 600 });
      return new Promise(resolve => { finish = resolve; });
    });
    const controller = new AbortController();
    const response = await f.clientFetch('/api/lark/bot/oneclick', { method: 'POST', signal: controller.signal });
    const duplicate = await f.clientFetch('/api/lark/bot/oneclick', { method: 'POST' });
    expect(duplicate.status).toBe(409);
    await duplicate.text();
    controller.abort();
    await response.body?.cancel().catch(() => {});
    await vi.waitFor(() => expect(signal?.aborted).toBe(true));
    finish(credentials);
    await new Promise(resolve => setTimeout(resolve, 30));
    expect(await readLarkConfigs(f.repos.config)).toEqual([]);
  });

  it('bounds a stuck SDK initialization and makes retry possible', async () => {
    const registrar = vi.fn<NonNullable<LarkRoutesOptions['registerApp']>>()
      .mockImplementationOnce(() => new Promise(() => {}))
      .mockResolvedValueOnce(credentials);
    const f = await fixture(registrar, { registrationTimeoutMs: 40 });
    await expect(registerLarkBot(new AbortController().signal, vi.fn(), f.clientFetch)).rejects.toThrow('过期');
    await expect(registerLarkBot(new AbortController().signal, vi.fn(), f.clientFetch)).resolves.toMatchObject({ appId: 'cli_created' });
  });

  it('reports expired authorization without forwarding SDK secrets', async () => {
    const f = await fixture(async () => { throw { code: 'expired_token', description: credentials.client_secret }; });
    await expect(registerLarkBot(new AbortController().signal, vi.fn(), f.clientFetch)).rejects.toThrow('二维码已过期');
    expect(await readLarkConfigs(f.repos.config)).toEqual([]);
  });
});
