import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { homedir, platform } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { percent, resetSeconds, unavailableUsage, type AgentUsage, type AgentUsageWindow } from './agent-usage.js';

const execFileAsync = promisify(execFile);
type CursorWindow = { enabled?: boolean; used?: number; limit?: number };
type CursorSummary = {
  billingCycleStart?: string; billingCycleEnd?: string; membershipType?: string;
  individualUsage?: { plan?: { enabled?: boolean; autoPercentUsed?: number; apiPercentUsed?: number }; overall?: CursorWindow; onDemand?: CursorWindow };
  teamUsage?: { onDemand?: CursorWindow };
};

export function normalizeCursorUsage(summary: CursorSummary, checkedAt = Date.now()): AgentUsage {
  if (!summary.billingCycleStart) return { ...unavailableUsage('Cursor 未返回有效的订阅数据', 'cursor.com'), checkedAt };
  const resetsAt = resetSeconds(summary.billingCycleEnd);
  const windows: AgentUsageWindow[] = [];
  const add = (label: string, value: unknown) => {
    const usedPercent = percent(value);
    if (usedPercent !== undefined) windows.push({ label, usedPercent, ...(resetsAt ? { resetsAt } : {}) });
  };
  const plan = summary.individualUsage?.plan;
  if (plan?.enabled) {
    // Kaboo 使用服务端给出的百分比；used / limit 不一定与 Cursor 仪表盘一致。
    add('Auto', plan.autoPercentUsed);
    add('API', plan.apiPercentUsed);
  } else {
    const legacy = (label: string, window?: CursorWindow) => {
      if (window?.enabled && typeof window.used === 'number' && typeof window.limit === 'number' && window.limit > 0)
        add(label, window.used / window.limit * 100);
    };
    legacy('个人', summary.individualUsage?.overall);
    legacy('按量', summary.individualUsage?.onDemand ?? summary.teamUsage?.onDemand);
  }
  if (!windows.length) return { ...unavailableUsage('Cursor 账号未返回可用额度窗口', 'cursor.com'), checkedAt };
  return { status: 'available', plan: summary.membershipType, windows, source: 'cursor.com', checkedAt };
}

function normalizeSessionToken(raw: string): string {
  const token = raw.trim().replace(/%3A%3A/gi, '::');
  if (token.includes('::')) return token;
  const jwtPayload = token.split('.')[1];
  if (!jwtPayload) return token;
  try {
    const sub = JSON.parse(Buffer.from(jwtPayload, 'base64url').toString('utf8')).sub;
    return typeof sub === 'string' && sub ? `${sub}::${token}` : token;
  } catch { return token; }
}

async function cursorToken(): Promise<{ token?: string; source?: string; keychainDenied?: boolean }> {
  if (platform() === 'darwin') {
    try {
      const { stdout } = await execFileAsync('security', ['find-generic-password', '-s', 'cursor-access-token', '-a', 'cursor-user', '-w'], { timeout: 3000, maxBuffer: 16_384 });
      if (stdout.trim()) return { token: normalizeSessionToken(stdout), source: 'Cursor CLI' };
    } catch (error) {
      const code = (error as { code?: number }).code;
      if (code === 51) return { keychainDenied: true };
    }
  }
  try {
    const auth = JSON.parse(await readFile(join(homedir(), '.config/cursor/auth.json'), 'utf8')) as { accessToken?: unknown };
    if (typeof auth.accessToken === 'string' && auth.accessToken.trim()) return { token: normalizeSessionToken(auth.accessToken), source: 'Cursor Agent' };
  } catch { /* 尚未通过 Cursor Agent 登录 */ }
  return {};
}

export async function readCursorUsage(): Promise<AgentUsage> {
  const { token, keychainDenied } = await cursorToken();
  if (!token) return unavailableUsage(keychainDenied
    ? '检测到 Cursor 钥匙串记录，但当前进程无权读取；请用 cursor-agent status 确认登录状态。'
    : '未找到 Cursor Agent / CLI 登录凭证。');
  try {
    const response = await fetch('https://cursor.com/api/usage-summary', {
      headers: { Cookie: `WorkosCursorSessionToken=${token}`, Accept: 'application/json', Referer: 'https://www.cursor.com/settings', 'User-Agent': 'agent-dock/usage' },
      redirect: 'error', signal: AbortSignal.timeout(8000)
    });
    if (response.status === 401 || response.status === 403) return unavailableUsage('Cursor 登录已失效或额度接口拒绝访问。', 'cursor.com');
    if (!response.ok) return unavailableUsage(`Cursor 额度接口返回 HTTP ${response.status}。`, 'cursor.com');
    const summary = await response.json() as CursorSummary;
    return normalizeCursorUsage(summary);
  } catch {
    return unavailableUsage('暂时无法连接 Cursor 额度接口。', 'cursor.com');
  }
}

let cached: AgentUsage | undefined;
let inFlight: Promise<AgentUsage> | undefined;
export async function getCursorUsage(refresh = false): Promise<AgentUsage> {
  if (!refresh && cached && Date.now() - cached.checkedAt < 60_000) return cached;
  if (!inFlight) inFlight = readCursorUsage().then(result => { cached = result; return result; }).finally(() => { inFlight = undefined; });
  return inFlight;
}
