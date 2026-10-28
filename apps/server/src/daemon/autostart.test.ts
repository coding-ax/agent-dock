import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AUTOSTART_LABEL, AutostartService, renderLaunchAgentPlist } from './autostart.js';

describe('LaunchAgent plist', () => {
  it('runs `agent-dock start` once at login without KeepAlive and escapes XML', () => {
    const plist = renderLaunchAgentPlist({ label: AUTOSTART_LABEL, programArguments: ['/usr/bin/node', '/opt/a&b/cli.js', 'start'], workingDirectory: '/Users/me', logFile: '/Users/me/.agentdock/daemon/autostart.log', env: { PATH: '/a:/b<c', HOME: '/Users/me' } });
    expect(plist).toContain(`<string>${AUTOSTART_LABEL}</string>`);
    expect(plist).toContain('<string>/opt/a&amp;b/cli.js</string>');
    expect(plist).toContain('<string>/a:/b&lt;c</string>');
    expect(plist).toMatch(/<key>RunAtLoad<\/key>\s*<true\/>/);
    expect(plist).not.toContain('KeepAlive');
    expect(plist.indexOf('<string>start</string>')).toBeGreaterThan(plist.indexOf('/opt/a&amp;b/cli.js'));
  });
});

describe('AutostartService', () => {
  let home: string;
  let entrypoint: string;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'agentdock-autostart-'));
    entrypoint = join(home, 'cli.js');
    writeFileSync(entrypoint, '');
  });
  afterEach(() => rmSync(home, { recursive: true, force: true }));

  const service = (overrides: Partial<ConstructorParameters<typeof AutostartService>[0]> = {}) => {
    const launchctl = vi.fn(async (_args: string[]) => undefined);
    return { launchctl, service: new AutostartService({ entrypoint, platform: 'darwin', env: { HOME: home, PATH: '/opt/bin:/usr/bin' }, realHome: home, nodePath: '/opt/node/bin/node', uid: 501, workingDirectory: () => home, launchctl, ...overrides }) };
  };

  it('writes the plist and loads it with launchctl on enable', async () => {
    const { service: autostart, launchctl } = service();
    expect(autostart.status()).toMatchObject({ supported: true, enabled: false });
    const status = await autostart.enable();
    expect(status).toMatchObject({ supported: true, enabled: true, entrypoint });
    const plist = readFileSync(autostart.plistPath, 'utf8');
    expect(plist).toContain('<string>/opt/node/bin/node</string>');
    expect(plist).toContain(`<string>${entrypoint}</string>`);
    expect(plist).toContain('<string>/opt/bin:/usr/bin</string>');
    expect(existsSync(join(home, '.agentdock', 'daemon'))).toBe(true);
    expect(launchctl.mock.calls.map(call => call[0])).toEqual([
      ['bootout', `gui/501/${AUTOSTART_LABEL}`],
      ['bootstrap', 'gui/501', autostart.plistPath]
    ]);
  });

  it('removes the plist and unloads it on disable, even if launchctl does not know the service', async () => {
    const { service: autostart, launchctl } = service();
    await autostart.enable();
    launchctl.mockClear();
    launchctl.mockRejectedValueOnce(new Error('Boot-out failed: 3: No such process'));
    expect(await autostart.disable()).toMatchObject({ enabled: false });
    expect(existsSync(autostart.plistPath)).toBe(false);
    expect(launchctl).toHaveBeenCalledWith(['bootout', `gui/501/${AUTOSTART_LABEL}`]);
  });

  it('keeps the plist and explains when launchctl cannot load it', async () => {
    const { service: autostart, launchctl } = service();
    launchctl.mockImplementation(async args => { if (args[0] === 'bootstrap') throw new Error('Bootstrap failed: 5'); });
    await expect(autostart.enable()).rejects.toThrow(/下次登录时仍会生效.*Bootstrap failed: 5/);
    expect(existsSync(autostart.plistPath)).toBe(true);
  });

  it('refuses a missing entrypoint', async () => {
    const { service: autostart } = service({ entrypoint: join(home, 'missing.js') });
    await expect(autostart.enable()).rejects.toThrow(/找不到 CLI 入口/);
    expect(existsSync(autostart.plistPath)).toBe(false);
  });

  it('is unsupported off macOS and inside an isolated sandbox HOME, and never touches launchctl there', async () => {
    const linux = service({ platform: 'linux' });
    expect(linux.service.status()).toMatchObject({ supported: false, enabled: false });
    await expect(linux.service.enable()).rejects.toThrow(/macOS/);
    const sandbox = service({ realHome: '/Users/someone-else' });
    expect(sandbox.service.status()).toMatchObject({ supported: false, reason: expect.stringContaining('沙箱') });
    await expect(sandbox.service.enable()).rejects.toThrow(/沙箱/);
    await expect(sandbox.service.disable()).rejects.toThrow(/沙箱/);
    expect(linux.launchctl).not.toHaveBeenCalled();
    expect(sandbox.launchctl).not.toHaveBeenCalled();
    expect(existsSync(join(home, 'Library'))).toBe(false);
  });

  it('defaults the working directory to the remembered daemon root', async () => {
    mkdirSync(join(home, '.agentdock', 'daemon'), { recursive: true });
    writeFileSync(join(home, '.agentdock', 'last-daemon-dir'), `${join(home, 'root', '.agentdock', 'daemon')}\n`);
    mkdirSync(join(home, 'root', '.agentdock', 'daemon'), { recursive: true });
    // 当前目录下若恰好有在运行的 daemon，会优先于记录的根目录；固定 cwd 让测试与运行环境无关。
    const cwd = vi.spyOn(process, 'cwd').mockReturnValue(join(home, 'elsewhere'));
    const { service: autostart } = service({ workingDirectory: undefined });
    await autostart.enable();
    cwd.mockRestore();
    expect(readFileSync(autostart.plistPath, 'utf8')).toContain(`<key>WorkingDirectory</key>\n  <string>${join(home, 'root')}</string>`);
  });
});
