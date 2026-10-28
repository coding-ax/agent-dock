import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { clearWebPassword, hashWebPassword, LoginRateLimiter, readWebPasswordHash, setWebPassword, verifyWebPassword, webPasswordEnabled } from './web-password.js';

const dirs: string[] = [];
const tempFile = () => { const dir = mkdtempSync(join(tmpdir(), 'agentdock-pw-')); dirs.push(dir); return join(dir, 'nested', 'web-password'); };
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

describe('web password', () => {
  it('哈希可验证，错误密码与被篡改的哈希都不通过', () => {
    const stored = hashWebPassword('correct horse');
    expect(stored).not.toContain('correct horse');
    expect(verifyWebPassword('correct horse', stored)).toBe(true);
    expect(verifyWebPassword('wrong', stored)).toBe(false);
    expect(verifyWebPassword('correct horse', stored.slice(0, -2) + 'xx')).toBe(false);
    expect(verifyWebPassword('correct horse', 'garbage')).toBe(false);
    expect(verifyWebPassword('correct horse', 'scrypt$999999999$8$1$a$b')).toBe(false);
  });

  it('默认未设置；设置后落 0600 文件，清除后回到未设置', () => {
    const file = tempFile();
    expect(webPasswordEnabled(file)).toBe(false);
    setWebPassword('secret-1', file);
    expect(webPasswordEnabled(file)).toBe(true);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(verifyWebPassword('secret-1', readWebPasswordHash(file)!)).toBe(true);
    expect(clearWebPassword(file)).toBe(true);
    expect(webPasswordEnabled(file)).toBe(false);
    expect(clearWebPassword(file)).toBe(false);
  });

  it('拒绝过短的密码', () => {
    expect(() => setWebPassword('123', tempFile())).toThrow(/至少/);
  });

  it('失败次数超限后在窗口内拒绝，窗口过后恢复', () => {
    const limiter = new LoginRateLimiter(2, 1000);
    limiter.recordFailure('ip', 0);
    expect(limiter.blocked('ip', 10)).toBe(false);
    limiter.recordFailure('ip', 20);
    expect(limiter.blocked('ip', 30)).toBe(true);
    expect(limiter.blocked('other', 30)).toBe(false);
    expect(limiter.blocked('ip', 1500)).toBe(false);
  });
});
