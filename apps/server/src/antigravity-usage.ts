import { spawn } from 'node:child_process';
import { userInfo } from 'node:os';
import { percent, resetSeconds, unavailableUsage, type AgentUsage, type AgentUsageWindow } from './agent-usage.js';

export type AntigravityUsageBucket = {
  id?: string;
  name?: string;
  description?: string;
  window?: string;
  remaining_fraction?: number;
  used_fraction?: number;
  remaining_percent?: number;
  used_percent?: number;
  reset_time?: string | number;
};

export type AntigravityUsageGroup = {
  name?: string;
  description?: string;
  buckets?: AntigravityUsageBucket[];
};

export type AntigravityUsagePayload = {
  status?: string;
  error?: string | { message?: string };
  response?: string;
  command?: {
    name?: string;
    data?: {
      plan?: string;
      tier?: string | { name?: string };
      description?: string;
      groups?: AntigravityUsageGroup[];
    };
  };
};

type ExecOptions = { timeout: number; maxBuffer: number; windowsHide: boolean; env: NodeJS.ProcessEnv };
type ExecRunner = (command: string, args: string[], options: ExecOptions) => Promise<{ stdout: string; stderr: string }>;

const SOURCE = 'Antigravity CLI';
const AUTH_ERROR_RE = /unauthenticated|authentication required|authentication failed|not logged in|please log in|sign in|\b401\b/i;

function resolveRealHome(): string | undefined {
  try {
    const dir = userInfo().homedir;
    return dir?.trim() || undefined;
  } catch {
    return undefined;
  }
}

/**
 * 为 `agy` 子进程构造环境变量：
 * 1) 始终复用系统账户的真实 HOME（即使当前 daemon 跑在替换了 HOME 的隔离沙箱里），
 *    避免 agy 找不到既有配置与钥匙串登录态而触发 OAuth 登录流程；
 * 2) 禁止拉起浏览器（BROWSER=true / NO_BROWSER=1），确保未登录时也绝不反复弹出登录页。
 */
export function antigravitySpawnEnv(base: NodeJS.ProcessEnv = process.env, realHome = resolveRealHome()): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...base,
    BROWSER: 'true',
    NO_BROWSER: '1'
  };
  if (realHome) {
    env.HOME = realHome;
    if (process.platform === 'win32') env.USERPROFILE = realHome;
  }
  return env;
}

function groupLabel(name?: string): string {
  const trimmed = name?.trim();
  if (!trimmed) return '';
  if (/^gemini\b/i.test(trimmed)) return 'Gemini';
  if (/claude/i.test(trimmed) && /gpt/i.test(trimmed)) return 'Claude / GPT';
  return trimmed;
}

function windowInfo(bucket: AntigravityUsageBucket): { label: string; rank: number } {
  const key = bucket.window?.trim().toLowerCase();
  if (key === '5h' || key === 'five_hour') return { label: '5 小时', rank: 1 };
  if (key === 'weekly' || key === '7d' || key === 'seven_day') return { label: '7 天', rank: 2 };
  const fallback = bucket.name?.trim() || bucket.window?.trim() || bucket.id?.trim() || '额度';
  return { label: fallback, rank: 3 };
}

function bucketUsedPercent(bucket: AntigravityUsageBucket): number | undefined {
  if (typeof bucket.remaining_fraction === 'number' && Number.isFinite(bucket.remaining_fraction) && bucket.remaining_fraction >= 0) {
    const remaining = Math.min(bucket.remaining_fraction, 1);
    return Math.round((1 - remaining) * 10_000) / 100;
  }
  if (typeof bucket.used_fraction === 'number' && Number.isFinite(bucket.used_fraction) && bucket.used_fraction >= 0) {
    return Math.round(Math.min(bucket.used_fraction, 1) * 10_000) / 100;
  }
  const used = percent(bucket.used_percent);
  if (used !== undefined) return Math.round(used * 100) / 100;
  const remaining = percent(bucket.remaining_percent);
  if (remaining !== undefined) return Math.round((100 - remaining) * 100) / 100;
  return undefined;
}

function parseJsonOutput(stdout: string): AntigravityUsagePayload | undefined {
  const trimmed = stdout.trim();
  if (!trimmed) return undefined;
  try {
    return JSON.parse(trimmed) as AntigravityUsagePayload;
  } catch {
    const lines = trimmed.split(/\r?\n/);
    for (let i = lines.length - 1; i >= 0; i -= 1) {
      const line = lines[i]!.trim();
      if (!line.startsWith('{')) continue;
      try {
        return JSON.parse(line) as AntigravityUsagePayload;
      } catch {
        continue;
      }
    }
    return undefined;
  }
}

function spawnAntigravity(command: string, args: string[], options: ExecOptions): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let stdout = '';
    let stderr = '';
    let child: ReturnType<typeof spawn>;

    const finish = (err?: NodeJS.ErrnoException & { killed?: boolean; stdout?: string; stderr?: string }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (err) {
        err.stdout = stdout;
        err.stderr = stderr;
        reject(err);
      } else {
        resolve({ stdout, stderr });
      }
    };

    const timer = setTimeout(() => {
      child?.kill();
      const err = new Error('Antigravity CLI timed out') as NodeJS.ErrnoException & { killed?: boolean };
      err.killed = true;
      err.code = 'ETIMEDOUT';
      finish(err);
    }, options.timeout);
    timer.unref();

    try {
      child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: options.windowsHide, env: options.env });
    } catch (error) {
      finish(error as NodeJS.ErrnoException);
      return;
    }

    child.on('error', error => finish(error as NodeJS.ErrnoException));
    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
      if (stdout.length > options.maxBuffer) {
        child.kill();
        finish(new Error('Antigravity CLI output exceeded buffer limit'));
      }
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
      // 未登录时 agy 会打印 OAuth 提示并等待 60s，命中鉴权提示后立即中止避免无谓阻塞。
      if (AUTH_ERROR_RE.test(stderr)) {
        child.kill();
        finish(new Error('Authentication required'));
        return;
      }
      if (stderr.length > options.maxBuffer) stderr = stderr.slice(-options.maxBuffer);
    });
    child.on('close', code => {
      if (code === 0) finish();
      else finish(new Error(`Antigravity CLI exited with code ${code ?? 'unknown'}`));
    });
  });
}

export function normalizeAntigravityUsage(raw: AntigravityUsagePayload, checkedAt = Date.now()): AgentUsage {
  if (!raw || typeof raw !== 'object') {
    return { ...unavailableUsage('Antigravity CLI 返回了无效数据。', SOURCE), checkedAt };
  }
  if (typeof raw.status === 'string' && raw.status.toUpperCase() !== 'SUCCESS') {
    const errText = [
      typeof raw.error === 'string' ? raw.error : raw.error?.message,
      raw.response
    ].filter(Boolean).join(' ');
    if (AUTH_ERROR_RE.test(errText)) {
      return { ...unavailableUsage('Antigravity 尚未登录或登录已失效，请先运行 agy 登录。', SOURCE), checkedAt };
    }
    return { ...unavailableUsage('Antigravity CLI 未返回有效额度数据。', SOURCE), checkedAt };
  }

  const data = raw.command?.data;
  const plan = typeof data?.plan === 'string' && data.plan.trim()
    ? data.plan.trim()
    : typeof data?.tier === 'string' && data.tier.trim()
      ? data.tier.trim()
      : typeof data?.tier === 'object' && typeof data.tier?.name === 'string' && data.tier.name.trim()
        ? data.tier.name.trim()
        : undefined;

  const groups = Array.isArray(data?.groups) ? data.groups : [];
  const windows: AgentUsageWindow[] = [];
  const seenLabels = new Set<string>();

  for (const group of groups) {
    const gLabel = groupLabel(group?.name);
    const buckets = Array.isArray(group?.buckets) ? [...group.buckets] : [];
    buckets.sort((a, b) => windowInfo(a).rank - windowInfo(b).rank);
    for (const bucket of buckets) {
      const usedPercent = bucketUsedPercent(bucket);
      if (usedPercent === undefined) continue;
      const wInfo = windowInfo(bucket);
      const baseLabel = gLabel ? `${gLabel} · ${wInfo.label}` : wInfo.label;
      if (seenLabels.has(baseLabel)) continue;
      seenLabels.add(baseLabel);
      const resetsAt = resetSeconds(bucket.reset_time);
      windows.push({ label: baseLabel, usedPercent, ...(resetsAt ? { resetsAt } : {}) });
    }
  }

  if (!windows.length) {
    return { ...unavailableUsage('Antigravity 未返回可用额度窗口。', SOURCE), checkedAt };
  }
  return { status: 'available', ...(plan ? { plan } : {}), windows, source: SOURCE, checkedAt };
}

export async function readAntigravityUsage(runner: ExecRunner = spawnAntigravity): Promise<AgentUsage> {
  const configured = process.env.AGY_PATH?.trim();
  const candidates = configured ? [configured] : ['agy', 'antigravity'];

  const env = antigravitySpawnEnv();

  for (const command of candidates) {
    try {
      const { stdout } = await runner(command, ['-p', '/usage', '--output-format', 'json'], {
        timeout: 15_000,
        maxBuffer: 256 * 1024,
        windowsHide: true,
        env
      });
      const parsed = parseJsonOutput(stdout);
      if (!parsed) return unavailableUsage('Antigravity CLI 返回了无效数据。', SOURCE);
      return normalizeAntigravityUsage(parsed);
    } catch (error) {
      const err = error as NodeJS.ErrnoException & { killed?: boolean; signal?: string; stdout?: string; stderr?: string };
      if (err.code === 'ENOENT') continue;
      const diagnostic = `${err.stderr ?? ''} ${err.stdout ?? ''} ${err.message ?? ''}`;
      if (AUTH_ERROR_RE.test(diagnostic)) {
        return unavailableUsage('Antigravity 尚未登录或登录已失效，请先运行 agy 登录。', SOURCE);
      }
      if (err.killed || err.signal === 'SIGTERM' || err.code === 'ETIMEDOUT') {
        return unavailableUsage('Antigravity 额度查询超时。', SOURCE);
      }
      if (typeof err.stdout === 'string') {
        const parsed = parseJsonOutput(err.stdout);
        if (parsed) return normalizeAntigravityUsage(parsed);
      }
      return unavailableUsage('Antigravity CLI 未返回额度数据。', SOURCE);
    }
  }

  return unavailableUsage('找不到 Antigravity CLI（agy），请确认它已安装并加入 PATH。', SOURCE);
}

let cached: AgentUsage | undefined;
let inFlight: Promise<AgentUsage> | undefined;

export async function getAntigravityUsage(refresh = false): Promise<AgentUsage> {
  if (!refresh && cached && Date.now() - cached.checkedAt < 60_000) return cached;
  if (!inFlight) inFlight = readAntigravityUsage().then(result => { cached = result; return result; }).finally(() => { inFlight = undefined; });
  return inFlight;
}
