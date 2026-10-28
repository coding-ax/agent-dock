import { spawn } from 'node:child_process';

export type CodexUsageWindow = { label: string; usedPercent: number; windowDurationMins: number; resetsAt?: number };
export type CodexUsage = { status: 'available' | 'unavailable'; plan?: string; windows: CodexUsageWindow[]; reason?: string; checkedAt: number };

type RateWindow = { usedPercent?: number; windowDurationMins?: number; resetsAt?: number } | null;
type RateBucket = { limitId?: string; planType?: string; primary?: RateWindow; secondary?: RateWindow };
type RateResult = { rateLimitsByLimitId?: Record<string, RateBucket>; rateLimits?: RateBucket | null };

const durationLabel = (mins: number) => mins === 300 ? '5 小时' : mins === 10080 ? '7 天' : mins >= 1440 && mins % 1440 === 0 ? `${mins / 1440} 天` : mins >= 60 && mins % 60 === 0 ? `${mins / 60} 小时` : `${mins} 分钟`;

export function normalizeCodexUsage(result: RateResult, checkedAt = Date.now()): CodexUsage {
  const bucket = result.rateLimitsByLimitId?.codex ?? (result.rateLimits?.limitId === 'codex' || !result.rateLimits?.limitId ? result.rateLimits : undefined);
  if (!bucket) return { status: 'unavailable', reason: 'Codex 未返回订阅额度', windows: [], checkedAt };
  // primary/secondary 只是协议槽位，时长才决定它是 5 小时还是 7 天。
  const windows = [bucket.primary, bucket.secondary].filter((window): window is NonNullable<RateWindow> => Boolean(window))
    .filter(window => Number.isFinite(window.usedPercent) && Number.isFinite(window.windowDurationMins) && window.windowDurationMins! > 0)
    .map(window => ({ label: durationLabel(window.windowDurationMins!), usedPercent: Math.max(0, Math.min(100, window.usedPercent!)), windowDurationMins: window.windowDurationMins!, ...(Number.isFinite(window.resetsAt) ? { resetsAt: window.resetsAt } : {}) }))
    .sort((a, b) => a.windowDurationMins - b.windowDurationMins);
  if (!windows.length) return { status: 'unavailable', reason: 'Codex 未返回可用额度窗口', windows: [], checkedAt };
  return { status: 'available', plan: bucket.planType ?? undefined, windows, checkedAt };
}

function readFromCodex(): Promise<CodexUsage> {
  return new Promise(resolve => {
    let settled = false;
    let buffer = '';
    let child: ReturnType<typeof spawn>;
    const done = (usage: CodexUsage) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child?.kill();
      resolve(usage);
    };
    const unavailable = (reason: string): CodexUsage => ({ status: 'unavailable', reason, windows: [], checkedAt: Date.now() });
    const timer = setTimeout(() => done(unavailable('Codex 额度查询超时')), 8000);
    timer.unref();
    try {
      child = spawn(process.env.CODEX_PATH?.trim() || 'codex', [
        'app-server', '--listen', 'stdio://',
        '-c', 'chatgpt_base_url="https://chatgpt.com/backend-api/"',
        '-c', 'check_for_update_on_startup=false',
        '-c', 'analytics.enabled=false',
        '-c', 'otel.exporter="none"',
        '-c', 'otel.trace_exporter="none"'
      ], { stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true });
    } catch {
      done(unavailable('无法启动 Codex CLI'));
      return;
    }
    child.on('error', () => done(unavailable('找不到 Codex CLI，请确认它已安装并加入 PATH')));
    child.on('exit', () => done(unavailable('Codex CLI 未返回额度数据')));
    child.stdin?.on('error', () => done(unavailable('Codex CLI 连接中断')));
    const send = (message: unknown) => { if (!settled) child.stdin?.write(`${JSON.stringify(message)}\n`); };
    child.stdout?.on('data', (chunk: Buffer) => {
      buffer += chunk.toString('utf8');
      if (buffer.length > 1024 * 1024) { done(unavailable('Codex 返回的数据过大')); return; }
      let boundary = buffer.indexOf('\n');
      while (boundary >= 0 && !settled) {
        const line = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 1);
        let message: { id?: number | string; method?: string; result?: any; error?: unknown };
        try { message = JSON.parse(line); } catch { done(unavailable('Codex 返回了无效数据')); return; }
        if (message.method && message.id !== undefined) {
          // 只读账号客户端绝不执行服务端发来的反向工具请求。
          send({ id: message.id, error: { code: -32601, message: 'Account-only client' } });
        } else if (message.id === 1 && message.result) {
          send({ method: 'initialized' });
          send({ id: 2, method: 'account/read', params: { refreshToken: false } });
        } else if (message.id === 2 && message.result) {
          if (message.result.account?.type !== 'chatgpt') { done(unavailable('当前 Codex 未使用 ChatGPT 账号登录')); return; }
          send({ id: 3, method: 'account/rateLimits/read', params: null });
        } else if (message.id === 3 && message.result) {
          done(normalizeCodexUsage(message.result));
        } else if (message.id === 1 || message.id === 2 || message.id === 3) {
          done(unavailable('Codex 账号接口不可用，请检查登录状态或升级 CLI'));
        }
        boundary = buffer.indexOf('\n');
      }
    });
    send({ id: 1, method: 'initialize', params: { clientInfo: { name: 'agent_dock_usage', version: '0.4.3' } } });
  });
}

let cached: CodexUsage | undefined;
let inFlight: Promise<CodexUsage> | undefined;
export async function getCodexUsage(refresh = false): Promise<CodexUsage> {
  if (!refresh && cached && Date.now() - cached.checkedAt < 60_000) return cached;
  if (!inFlight) inFlight = readFromCodex().then(result => { cached = result; return result; }).finally(() => { inFlight = undefined; });
  return inFlight;
}
