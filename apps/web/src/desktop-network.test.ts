import { describe, expect, it } from 'vitest';
import { defaultShareUrl, displayShareUrl, shareUrlHost } from './desktop-network';

describe('share link helpers', () => {
  it('prefers a LAN IPv4 address, then hostname, then public, then IPv6', () => {
    const urls = [
      { kind: 'lan-v6', url: 'http://[fd12::1]:4310/sessions/s?t=x' },
      { kind: 'public', url: 'https://dock.example.com/sessions/s?t=x' },
      { kind: 'hostname', url: 'http://Mac.local:4310/sessions/s?t=x' },
      { kind: 'lan-v4', url: 'http://192.168.1.20:4310/sessions/s?t=x' }
    ];
    expect(defaultShareUrl(urls)?.kind).toBe('lan-v4');
    expect(defaultShareUrl(urls.filter(url => url.kind !== 'lan-v4'))?.kind).toBe('hostname');
    expect(defaultShareUrl(urls.filter(url => ['public', 'lan-v6'].includes(url.kind)))?.kind).toBe('public');
    expect(defaultShareUrl(urls.filter(url => url.kind === 'lan-v6'))?.kind).toBe('lan-v6');
    expect(defaultShareUrl([])).toBeUndefined();
  });

  it('never renders the credential from the QR in text form', () => {
    const url = 'http://192.168.1.20:4310/sessions/ses_1?t=secret-token';
    expect(displayShareUrl(url)).toBe('http://192.168.1.20:4310/sessions/ses_1');
    expect(displayShareUrl(url).includes('secret-token')).toBe(false);
    expect(shareUrlHost(url)).toBe('192.168.1.20:4310');
    expect(displayShareUrl('not a url')).toBe('not a url');
  });
});
