import type { NetworkInterfaceInfo } from 'node:os';
import { describe, expect, it } from 'vitest';
import { accessUrls } from './access-urls.js';

const nic = (address: string, family: 'IPv4' | 'IPv6', internal = false): NetworkInterfaceInfo =>
  ({ address, netmask: '', family, mac: '', internal, cidr: null }) as NetworkInterfaceInfo;

/** 真实 Mac 的网卡形状：lo0 回环 + en7 一个 v4 两个 v6 + 一堆 fe80 隧道地址。 */
const macInterfaces: NodeJS.Dict<NetworkInterfaceInfo[]> = {
  lo0: [nic('127.0.0.1', 'IPv4', true), nic('::1', 'IPv6', true), nic('fe80::1', 'IPv6', true)],
  en7: [nic('fe80::48f:2253:2f90:ad94', 'IPv6'), nic('192.168.1.20', 'IPv4'), nic('fd12:3456:789a:1:1c4c:7059:abcb:3a6c', 'IPv6'), nic('fd12:3456:789a:1::1fd8', 'IPv6')],
  awdl0: [nic('fe80::384a:a6ff:febc:ce24', 'IPv6')],
  utun4: [nic('fe80::85a0:ef0d:64ac:8d4', 'IPv6')]
};

/** 固定主机名，避免单测跟着跑测机器的真名变。 */
const macHostname = 'MacBook-Pro.local';

describe('accessUrls', () => {
  it('lists loopback first and both LAN families when bound to the LAN', () => {
    const urls = accessUrls({ host: '0.0.0.0', port: 4310, interfaces: macInterfaces, hostname: macHostname });
    expect(urls.map(entry => entry.url)).toEqual([
      'http://127.0.0.1:4310/',
      'http://[::1]:4310/',
      'http://MacBook-Pro.local:4310/',
      'http://192.168.1.20:4310/',
      'http://[fd12:3456:789a:1:1c4c:7059:abcb:3a6c]:4310/',
      'http://[fd12:3456:789a:1::1fd8]:4310/'
    ]);
    expect(urls.map(entry => entry.kind)).toEqual(['local', 'local', 'hostname', 'lan-v4', 'lan-v6', 'lan-v6']);
  });

  it('drops link-local IPv6 and never repeats a loopback address as LAN', () => {
    const urls = accessUrls({ host: '0.0.0.0', port: 4310, interfaces: macInterfaces, hostname: macHostname });
    expect(urls.some(entry => entry.url.includes('fe80'))).toBe(false);
    expect(urls.some(entry => entry.url.includes('127.0.0.1') && entry.kind !== 'local')).toBe(false);
  });

  /**
   * 主机名入口的价值就是「与网段无关」：cookie 按主机名隔离，换 IP 不该让人重输密码。
   */
  it('keeps the hostname entry byte-identical across network changes', () => {
    const onOneWifi = accessUrls({ host: '0.0.0.0', port: 4310, interfaces: macInterfaces, hostname: macHostname });
    const onAnother = accessUrls({
      host: '0.0.0.0',
      port: 4310,
      interfaces: { en0: [nic('192.168.31.44', 'IPv4')] },
      hostname: macHostname
    });
    const pick = (urls: ReturnType<typeof accessUrls>) => urls.find(entry => entry.kind === 'hostname')!.url;
    expect(pick(onOneWifi)).toBe('http://MacBook-Pro.local:4310/');
    expect(pick(onAnother)).toBe(pick(onOneWifi));
    expect(onOneWifi.some(entry => entry.url.includes('192.168.1.20'))).toBe(true);
    expect(onAnother.some(entry => entry.url.includes('192.168.1.20'))).toBe(false);
  });

  it('never advertises a hostname that is really a loopback name', () => {
    for (const hostname of ['localhost', '127.0.0.1', '::1', '', '   ']) {
      const urls = accessUrls({ host: '0.0.0.0', port: 4310, interfaces: macInterfaces, hostname });
      expect(urls.some(entry => entry.kind === 'hostname')).toBe(false);
    }
  });

  it('stays loopback-only under --local-only so no unreachable address is advertised', () => {
    const urls = accessUrls({ host: '127.0.0.1', port: 4310, interfaces: macInterfaces, hostname: macHostname });
    expect(urls.map(entry => entry.url)).toEqual(['http://127.0.0.1:4310/']);
  });

  it('keeps an explicitly bound address even when the NIC scan misses it', () => {
    const urls = accessUrls({ host: '192.168.7.7', port: 4310, interfaces: macInterfaces, hostname: macHostname });
    expect(urls.map(entry => entry.url)).toEqual([
      'http://127.0.0.1:4310/',
      'http://MacBook-Pro.local:4310/',
      'http://192.168.7.7:4310/',
      'http://192.168.1.20:4310/',
      'http://[fd12:3456:789a:1:1c4c:7059:abcb:3a6c]:4310/',
      'http://[fd12:3456:789a:1::1fd8]:4310/'
    ]);
  });

  it('appends the master credential so a LAN device can actually open the link', () => {
    const urls = accessUrls({ host: '0.0.0.0', port: 4310, token: 'tok.en', interfaces: macInterfaces, hostname: macHostname });
    expect(urls[0]!.url).toBe('http://127.0.0.1:4310/?t=tok.en');
    expect(urls.find(entry => entry.kind === 'hostname')!.url).toBe('http://MacBook-Pro.local:4310/?t=tok.en');
    expect(urls.find(entry => entry.kind === 'lan-v4')!.url).toBe('http://192.168.1.20:4310/?t=tok.en');
  });
});
