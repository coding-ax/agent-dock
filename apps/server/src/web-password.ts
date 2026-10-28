import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

/**
 * Web 控制台的可选访问密码：除带凭证链接外的第二条进入方式。输对密码即发放 master 凭证。
 *
 * - 默认不存在；用 `agent-dock password set` 设置。只落 scrypt 哈希，文件权限 0600。
 * - 放在 ~/.agentdock 下而不是数据库：CLI 无需连 daemon 就能改，daemon 每次登录时现读，
 *   设置 / 清除立即生效，不用重启。
 */
export const webPasswordFileName = 'web-password';
const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const KEY_LENGTH = 32;
export const minWebPasswordLength = 6;

export function webPasswordPath(home = homedir()): string {
  return join(home, '.agentdock', webPasswordFileName);
}

export function hashWebPassword(password: string): string {
  const salt = randomBytes(16);
  const key = scryptSync(password, salt, KEY_LENGTH, { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P });
  return `scrypt$${SCRYPT_N}$${SCRYPT_R}$${SCRYPT_P}$${salt.toString('base64url')}$${key.toString('base64url')}`;
}

/** 格式不对、参数异常一律当作不匹配（fail-closed）。 */
export function verifyWebPassword(password: string, stored: string): boolean {
  const parts = stored.trim().split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [n, r, p] = parts.slice(1, 4).map(Number) as [number, number, number];
  if (![n, r, p].every(value => Number.isInteger(value) && value > 0) || n > 1 << 20) return false;
  const salt = Buffer.from(parts[4]!, 'base64url');
  const expected = Buffer.from(parts[5]!, 'base64url');
  if (!salt.length || !expected.length) return false;
  try {
    const actual = scryptSync(password, salt, expected.length, { N: n, r, p, maxmem: 256 * n * r });
    return timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

export function readWebPasswordHash(path = webPasswordPath()): string | undefined {
  try { return readFileSync(path, 'utf8').trim() || undefined; }
  catch { return undefined; }
}

export function webPasswordEnabled(path = webPasswordPath()): boolean {
  return Boolean(readWebPasswordHash(path));
}

export function setWebPassword(password: string, path = webPasswordPath()): void {
  if (password.length < minWebPasswordLength) throw new Error(`密码至少 ${minWebPasswordLength} 位。`);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, `${hashWebPassword(password)}\n`, { mode: 0o600 });
  // 文件已存在时 writeFileSync 不改权限，显式收紧一次。
  chmodSync(path, 0o600);
}

export function clearWebPassword(path = webPasswordPath()): boolean {
  if (!existsSync(path)) return false;
  rmSync(path, { force: true });
  return true;
}

/**
 * 登录失败限流：按来源地址计数，窗口内失败过多就拒绝尝试。
 * daemon 是单机单进程（一台机器一个实例），进程内计数即可；重启清零可以接受。
 */
export class LoginRateLimiter {
  private readonly failures = new Map<string, { count: number; windowStart: number }>();
  constructor(private readonly maxFailures = 10, private readonly windowMs = 10 * 60_000) {}

  blocked(key: string, now = Date.now()): boolean {
    const entry = this.failures.get(key);
    if (!entry) return false;
    if (now - entry.windowStart >= this.windowMs) { this.failures.delete(key); return false; }
    return entry.count >= this.maxFailures;
  }

  recordFailure(key: string, now = Date.now()): void {
    const entry = this.failures.get(key);
    if (!entry || now - entry.windowStart >= this.windowMs) this.failures.set(key, { count: 1, windowStart: now });
    else entry.count += 1;
  }

  reset(key: string): void { this.failures.delete(key); }
}
