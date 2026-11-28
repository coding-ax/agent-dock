import { afterEach, describe, expect, it } from 'vitest';
import type { ConfigRepository } from '@agent-dock/agent-dock-shared';
import Fastify from 'fastify';
import { getActiveServerLocale, initServerLocale, LocaleService, platformLocaleConfigKey, setActiveServerLocaleForTest } from './locale-service.js';
import { registerSystemRoutes } from './system-routes.js';

function createMemoryConfigRepo(): ConfigRepository {
  const map = new Map<string, string>();
  return {
    async get(key: string) { return map.get(key); },
    async set(key: string, value: string) { map.set(key, value); },
    async delete(key: string) { map.delete(key); },
    async list() { return Object.fromEntries(map.entries()); }
  };
}

afterEach(() => {
  initServerLocale(undefined);
  setActiveServerLocaleForTest(undefined);
});

describe('LocaleService & /api/system/locale API', () => {
  it('defaults to zh-CN when unconfigured and persists preference + effective locale to configs', async () => {
    const repo = createMemoryConfigRepo();
    const service = new LocaleService({ config: repo });
    initServerLocale(service);

    const initial = await service.getState();
    expect(initial).toEqual({
      preference: 'system',
      locale: 'zh-CN',
      configured: false,
      revision: 0
    });
    expect(getActiveServerLocale()).toBe('zh-CN');

    const events: unknown[] = [];
    const unsubscribe = service.subscribe(event => events.push(event));

    const updated = await service.setLocale({ preference: 'en-US' });
    expect(updated.preference).toBe('en-US');
    expect(updated.locale).toBe('en-US');
    expect(updated.configured).toBe(true);
    expect(updated.revision).toBe(1);
    expect(getActiveServerLocale()).toBe('en-US');
    expect(events).toHaveLength(1);

    // System preference preserves explicit resolved locale supplied by browser
    const sysZh = await service.setLocale({ preference: 'system', locale: 'zh-CN' });
    expect(sysZh.preference).toBe('system');
    expect(sysZh.locale).toBe('zh-CN');
    expect(getActiveServerLocale()).toBe('zh-CN');

    // Reloading from SQLite configs restores persisted state
    const raw = await repo.get(platformLocaleConfigKey);
    expect(raw).toBeTruthy();
    const reloaded = new LocaleService({ config: repo });
    const state = await reloaded.load();
    expect(state.preference).toBe('system');
    expect(state.locale).toBe('zh-CN');
    expect(state.configured).toBe(true);

    unsubscribe();
    service.close();
  });

  it('serves GET and PUT /api/system/locale with strict validation', async () => {
    const repo = createMemoryConfigRepo();
    const locale = new LocaleService({ config: repo });
    const app = Fastify();
    await registerSystemRoutes(app, { locale });

    const r1 = await app.inject({ method: 'GET', url: '/api/system/locale' });
    expect(r1.statusCode).toBe(200);
    expect(r1.json()).toMatchObject({ preference: 'system', locale: 'zh-CN', configured: false });

    const bad = await app.inject({ method: 'PUT', url: '/api/system/locale', payload: { preference: 'fr-FR' } });
    expect(bad.statusCode).toBe(400);

    const badLocale = await app.inject({ method: 'PUT', url: '/api/system/locale', payload: { preference: 'system', locale: 'ja-JP' } });
    expect(badLocale.statusCode).toBe(400);

    const ok = await app.inject({ method: 'PUT', url: '/api/system/locale', payload: { preference: 'en-US' } });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toMatchObject({ preference: 'en-US', locale: 'en-US', configured: true });

    const r2 = await app.inject({ method: 'GET', url: '/api/system/locale' });
    expect(r2.json()).toMatchObject({ preference: 'en-US', locale: 'en-US', configured: true });

    await app.close();
    locale.close();
  });
});
