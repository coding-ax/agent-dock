import type { NetworkInterfaceInfo } from 'node:os';
import { describe, expect, it, vi } from 'vitest';
import { normalizePublicUrl, publicUrlConfigKey, ShareLinkService } from './share-link.js';
import { verifyWebToken } from './web-access.js';

const nic = (address: string, family: 'IPv4' | 'IPv6', internal = false): NetworkInterfaceInfo =>
  ({ address, netmask: '', family, mac: '', internal, cidr: null }) as NetworkInterfaceInfo;

const interfaces: NodeJS.Dict<NetworkInterfaceInfo[]> = {
  lo0: [nic('127.0.0.1', 'IPv4', true), nic('::1', 'IPv6', true)],
  en0: [nic('192.168.1.20', 'IPv4'), nic('fd12:3456:789a:1::1fd8', 'IPv6')],
  awdl0: [nic('fe80::384a:a6ff:febc:ce24', 'IPv6')]
};

const configFor = (initial?: string) => {
  const values = new Map<string, string>();
  if (initial) values.set(publicUrlConfigKey, initial);
  return {
    values,
    get: vi.fn(async (key: string) => values.get(key)),
    set: vi.fn(async (key: string, value: string) => { values.set(key, value); })
  };
};

const SECRET = 'share-link-test-secret';

describe('normalizePublicUrl', () => {
  it('accepts a plain https origin and rejects query, hash, path prefixes and trailing slash', () => {
    expect(normalizePublicUrl('https://dock.example.com')).toBe('https://dock.example.com');
    expect(normalizePublicUrl(' https://dock.example.com/ ')).toBe('https://dock.example.com');
    expect(normalizePublicUrl('https://dock.example.com/?a=1#x')).toBe('https://dock.example.com');
    expect(normalizePublicUrl('https://dock.example.com:8443')).toBe('https://dock.example.com:8443');
    // 子路径部署会连静态资源都加载不出来，写明不接受而不是生成一个白屏二维码。
    expect(normalizePublicUrl('https://dock.example.com/base/')).toBeUndefined();
  });

  it('rejects http, credentials and non-URLs so a QR never points at plaintext or a hijacked host', () => {
    for (const value of ['http://dock.example.com', 'https://user:s3cret@dock.example.com', 'ftp://dock.example.com', 'dock.example.com', 'https://', '', undefined]) {
      expect(normalizePublicUrl(value)).toBeUndefined();
    }
  });
});

describe('ShareLinkService', () => {
  it('lists LAN entries without loopback and embeds an app-level master token', async () => {
    const service = new ShareLinkService({ host: '0.0.0.0', port: 4310, secret: SECRET, masterTokenTtlMs: 60_000, interfaces, hostname: 'MacBook-Pro.local', now: () => 1_000 });
    const result = await service.build('ses_abc');
    expect(result.lanEnabled).toBe(true);
    expect(result.expiresAt).toBe(61_000);
    expect(result.urls.map(entry => entry.kind)).toEqual(['hostname', 'lan-v4', 'lan-v6']);
    expect(result.urls.every(entry => entry.url.includes('/sessions/ses_abc?t='))).toBe(true);
    expect(result.urls.some(entry => entry.url.includes('127.0.0.1') || entry.url.includes('[::1]'))).toBe(false);
    expect(result.urls.some(entry => entry.url.includes('fe80'))).toBe(false);

    const token = new URL(result.urls[0]!.url).searchParams.get('t')!;
    expect(verifyWebToken(token, SECRET)).toMatchObject({ kind: 'master' });
  });

  it('builds an app-level link at the root when no session is selected', async () => {
    const service = new ShareLinkService({ host: '0.0.0.0', port: 4310, secret: SECRET, masterTokenTtlMs: 60_000, interfaces, hostname: 'MacBook-Pro.local', now: () => 1_000 });
    const result = await service.build();
    expect(result.sessionId).toBeUndefined();
    expect(result.urls.every(entry => entry.url.includes('/?t='))).toBe(true);
    const token = new URL(result.urls[0]!.url).searchParams.get('t')!;
    expect(verifyWebToken(token, SECRET)).toMatchObject({ kind: 'master' });
  });

  it('offers no LAN candidate when bound to loopback, but still allows a configured public base', async () => {
    const service = new ShareLinkService({ host: '127.0.0.1', port: 4310, secret: SECRET, interfaces, hostname: 'MacBook-Pro.local', config: configFor('https://dock.example.com'), masterTokenTtlMs: 60_000 });
    const result = await service.build('ses_abc');
    expect(result.lanEnabled).toBe(false);
    expect(result.urls).toHaveLength(1);
    expect(result.urls[0]).toMatchObject({ kind: 'public', url: expect.stringMatching(/^https:\/\/dock\.example\.com\/sessions\/ses_abc\?t=/) });
    expect(result.publicUrlSource).toBe('config');
  });

  it('lets AGENTDOCK_PUBLIC_URL win over the stored value and reports it as locked', async () => {
    const config = configFor('https://stored.example.com');
    const service = new ShareLinkService({ host: '0.0.0.0', port: 4310, secret: SECRET, interfaces, env: { AGENTDOCK_PUBLIC_URL: 'https://env.example.com' }, config });
    const result = await service.build('ses_abc');
    expect(result.urls.at(-1)?.url).toContain('https://env.example.com/sessions/ses_abc?t=');
    expect(result.publicUrlSource).toBe('env');
    expect(await service.settings()).toEqual({ publicUrl: 'https://env.example.com', publicUrlSource: 'env', envLocked: true });
  });

  it('explains how to enable sharing when the web gate is off', async () => {
    const service = new ShareLinkService({ host: '127.0.0.1', port: 4310, secret: '', interfaces });
    await expect(service.build('ses_abc')).rejects.toMatchObject({ code: 'SHARE_LINK_DISABLED', statusCode: 409 });
  });

  it('persists only a normalized https address and clears on empty string', async () => {
    const config = configFor();
    const service = new ShareLinkService({ host: '0.0.0.0', port: 4310, secret: SECRET, interfaces, config });
    await expect(service.savePublicUrl('http://dock.example.com')).rejects.toThrow('https://');
    await expect(service.savePublicUrl(42)).rejects.toThrow('字符串');
    expect(await service.savePublicUrl('https://dock.example.com/')).toEqual({ publicUrl: 'https://dock.example.com', publicUrlSource: 'config', envLocked: false });
    expect(config.values.get(publicUrlConfigKey)).toBe('https://dock.example.com');
    expect(await service.savePublicUrl('  ')).toEqual({ envLocked: false });
    expect(config.values.get(publicUrlConfigKey)).toBe('');
  });
});
