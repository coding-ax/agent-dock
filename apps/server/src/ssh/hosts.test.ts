import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { isValidSshHost, listSshHosts } from './hosts.js';

function homeWithConfig(config: string, extra: Record<string, string> = {}): string {
  const home = mkdtempSync(join(tmpdir(), 'agentdock-ssh-'));
  mkdirSync(join(home, '.ssh'), { recursive: true });
  writeFileSync(join(home, '.ssh', 'config'), config);
  for (const [name, contents] of Object.entries(extra)) {
    const target = join(home, '.ssh', name);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, contents);
  }
  return home;
}

describe('listSshHosts', () => {
  it('reads aliases, options, includes and skips wildcard/match blocks', () => {
    const home = homeWithConfig(`
# comment
Host gcp
  HostName 34.1.2.3
  User codeax
  Port 2222
  IdentityFile ~/.ssh/google_compute_engine

Host *.internal !blocked
  User ignored

Host *
  ServerAliveInterval 30

Include config.d/*

Match host only-when-connected
  User match-user

Host vps another
  HostName=example.com
`, {
      'config.d/work.conf': 'Host work\n  HostName work.example.com\n  ProxyCommand gcloud compute start-iap-tunnel\n'
    });
    const result = listSshHosts({ HOME: home });
    expect(result.configExists).toBe(true);
    expect(result.hosts.map(host => host.alias)).toEqual(['another', 'gcp', 'vps', 'work']);
    expect(result.hosts.find(host => host.alias === 'gcp')).toMatchObject({
      hostName: '34.1.2.3', user: 'codeax', port: 2222, identityFile: '~/.ssh/google_compute_engine'
    });
    expect(result.hosts.find(host => host.alias === 'work')).toMatchObject({ hostName: 'work.example.com', proxy: true });
    expect(result.hosts.find(host => host.alias === 'vps')).toMatchObject({ hostName: 'example.com' });
  });

  it('handles a missing config without failing', () => {
    const home = mkdtempSync(join(tmpdir(), 'agentdock-ssh-empty-'));
    expect(listSshHosts({ HOME: home })).toMatchObject({ configExists: false, hosts: [] });
  });

  it('respects AGENTDOCK_SSH_CONFIG', () => {
    const home = mkdtempSync(join(tmpdir(), 'agentdock-ssh-env-'));
    const file = join(home, 'custom_config');
    writeFileSync(file, 'Host custom\n  HostName 10.0.0.2\n');
    const result = listSshHosts({ HOME: '/nonexistent', AGENTDOCK_SSH_CONFIG: file });
    expect(result.configPath).toBe(file);
    expect(result.hosts).toMatchObject([{ alias: 'custom', hostName: '10.0.0.2' }]);
  });
});

describe('isValidSshHost', () => {
  it('accepts alias characters and rejects flag injection', () => {
    expect(isValidSshHost('gcp')).toBe(true);
    expect(isValidSshHost('user@host.example')).toBe(true);
    expect(isValidSshHost('-oProxyCommand=evil')).toBe(false);
    expect(isValidSshHost('host with space')).toBe(false);
    expect(isValidSshHost('host;rm')).toBe(false);
  });
});
