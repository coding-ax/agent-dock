import { spawn } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { REMOTE_PATH_PREFIX } from '@agent-dock/agent-dock-acp-client';

/**
 * SSH host discovery + capability probe.
 *
 * Discovery is deliberately a small OpenSSH config reader rather than shelling
 * out to `ssh -G` for every host: the import panel needs the whole list at once,
 * and some blocks (ProxyCommand through gcloud, for example) make `ssh -G`
 * slow. We only read the config the user already maintains; credentials never
 * leave their files.
 *
 * The probe runs a fixed, read-only script. There is no user-controlled command
 * in it, so a host alias from config cannot turn into arbitrary remote code.
 */

export interface SshHost {
  alias: string;
  hostName?: string;
  user?: string;
  port?: number;
  identityFile?: string;
  /** True when the block needs an external tunnel (e.g. gcloud IAP). */
  proxy?: boolean;
  source: string;
}

export interface SshHostsResult {
  configPath: string;
  configExists: boolean;
  hosts: SshHost[];
  error?: string;
}

export interface SshProbeResult {
  host: string;
  ok: boolean;
  latencyMs: number;
  platform?: string;
  nodeVersion?: string;
  npx?: boolean;
  home?: string;
  agents: { claude: boolean; codex: boolean };
  detail?: string;
}

const MAX_INCLUDE_DEPTH = 4;

/** Alias charset. Reject a leading dash so it can never be parsed as an ssh flag. */
export function isValidSshHost(host: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._@:+-]*$/.test(host);
}

function defaultConfigPath(env: NodeJS.ProcessEnv): string {
  return env.AGENTDOCK_SSH_CONFIG?.trim() || join(env.HOME?.trim() || homedir(), '.ssh', 'config');
}

function splitDirective(line: string): { key: string; value: string } | undefined {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith('#')) return undefined;
  const match = trimmed.match(/^([^\s=]+)(?:\s*=\s*|\s+)(.*)$/);
  if (!match) return { key: trimmed.toLowerCase(), value: '' };
  let value = match[2]!.trim();
  if (value.startsWith('"') && value.endsWith('"') && value.length >= 2) value = value.slice(1, -1);
  return { key: match[1]!.toLowerCase(), value };
}

function expandInclude(pattern: string, baseDir: string): string[] {
  const expanded = pattern.replace(/^~(?=$|\/)/, homedir());
  const absolute = isAbsolute(expanded) ? expanded : resolve(baseDir, expanded);
  if (!/[*?]/.test(absolute)) return [absolute];
  const directory = dirname(absolute);
  const namePattern = absolute.slice(directory.length + 1);
  const matcher = new RegExp(`^${namePattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')}$`);
  try {
    return readdirSync(directory).filter(name => matcher.test(name)).map(name => join(directory, name)).sort();
  } catch {
    return [];
  }
}

/**
 * Parse one config file. `Include` is expanded in place; `Match` blocks are
 * skipped (their conditional semantics cannot be decided without a connection,
 * and treating them as unconditional would expose hosts the user gated).
 */
function parseFile(file: string, hosts: Map<string, SshHost>, visited: Set<string>, depth: number): void {
  if (depth > MAX_INCLUDE_DEPTH || visited.has(file) || !existsSync(file)) return;
  visited.add(file);
  let aliases: string[] = [];
  let values: Record<string, string> = {};
  const flush = () => {
    for (const alias of aliases) {
      const existing = hosts.get(alias);
      const entry: SshHost = {
        alias,
        ...(values.hostname ? { hostName: values.hostname } : {}),
        ...(values.user ? { user: values.user } : {}),
        ...(values.port && /^\d+$/.test(values.port) ? { port: Number(values.port) } : {}),
        ...(values.identityfile ? { identityFile: values.identityfile } : {}),
        ...(values.proxycommand ? { proxy: true } : {}),
        source: file
      };
      hosts.set(alias, existing ? {
        ...existing,
        ...Object.fromEntries(Object.entries(entry).filter(([key, value]) => key === 'alias' || key === 'source' || existing[key as keyof SshHost] === undefined))
      } : entry);
    }
  };

  let lines: string[];
  try { lines = readFileSync(file, 'utf8').split(/\r?\n/); }
  catch { return; }

  for (const line of lines) {
    const directive = splitDirective(line);
    if (!directive) continue;
    const { key, value } = directive;
    if (key === 'host') {
      flush();
      aliases = value.split(/\s+/).filter(alias => alias && !/[*?!]/.test(alias) && isValidSshHost(alias));
      values = {};
      continue;
    }
    if (key === 'match') {
      flush();
      aliases = [];
      values = {};
      continue;
    }
    if (key === 'include') {
      flush();
      aliases = [];
      values = {};
      for (const pattern of value.split(/\s+/).filter(Boolean)) {
        for (const included of expandInclude(pattern, dirname(file))) parseFile(included, hosts, visited, depth + 1);
      }
      continue;
    }
    if (!aliases.length) continue;
    // OpenSSH: first obtained value wins. Keep it faithful for scalar options.
    if (values[key] === undefined) values[key] = value;
  }
  flush();
}

export function listSshHosts(env: NodeJS.ProcessEnv = process.env): SshHostsResult {
  const configPath = defaultConfigPath(env);
  if (!existsSync(configPath)) return { configPath, configExists: false, hosts: [] };
  try {
    const hosts = new Map<string, SshHost>();
    parseFile(configPath, hosts, new Set(), 0);
    return {
      configPath,
      configExists: true,
      hosts: [...hosts.values()].sort((a, b) => a.alias.localeCompare(b.alias))
    };
  } catch (error) {
    return {
      configPath,
      configExists: true,
      hosts: [],
      error: error instanceof Error ? error.message : String(error)
    };
  }
}

export function sshArgs(host: string): string[] {
  return [
    '-T',
    '-o', 'BatchMode=yes',
    '-o', 'ConnectTimeout=10',
    '-o', 'ServerAliveInterval=15',
    '-o', 'ServerAliveCountMax=3',
    '-o', 'LogLevel=ERROR',
    host
  ];
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

const PROBE_SCRIPT = `${REMOTE_PATH_PREFIX}
printf 'os=%s\\n' "$(uname -srm 2>/dev/null)"
printf 'node=%s\\n' "$(node -v 2>/dev/null)"
printf 'npx=%s\\n' "$(command -v npx 2>/dev/null)"
printf 'claude=%s\\n' "$(command -v claude 2>/dev/null)"
printf 'codex=%s\\n' "$(command -v codex 2>/dev/null)"
printf 'home=%s\\n' "$HOME"
`;

interface SshRunResult { code: number | null; stdout: string; stderr: string; timedOut: boolean; error?: string }

function runSsh(host: string, script: string, timeoutMs: number): Promise<SshRunResult> {
  return new Promise(resolve => {
    let stdout = '';
    let stderr = '';
    let settled = false;
    let timedOut = false;
    let child: ReturnType<typeof spawn>;
    const finish = (result: SshRunResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    try {
      child = spawn('ssh', [...sshArgs(host), `sh -c ${shellQuote(script)}`], { stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (error) {
      resolve({ code: null, stdout, stderr, timedOut: false, error: error instanceof Error ? error.message : String(error) });
      return;
    }
    const timer = setTimeout(() => {
      timedOut = true;
      try { child.kill('SIGKILL'); } catch { /* already gone */ }
    }, timeoutMs);
    timer.unref?.();
    child.stdout?.on('data', chunk => { if (stdout.length < 64 * 1024) stdout += String(chunk); });
    child.stderr?.on('data', chunk => { if (stderr.length < 64 * 1024) stderr += String(chunk); });
    child.once('error', error => finish({ code: null, stdout, stderr, timedOut, error: error.message }));
    child.once('close', code => finish({ code, stdout, stderr, timedOut }));
  });
}

function field(text: string, name: string): string | undefined {
  for (const line of text.split(/\r?\n/)) {
    if (line.startsWith(`${name}=`)) return line.slice(name.length + 1).trim() || undefined;
  }
  return undefined;
}

export async function probeSshHost(host: string, options: { timeoutMs?: number } = {}): Promise<SshProbeResult> {
  if (!isValidSshHost(host)) throw new Error('Invalid SSH host alias');
  const started = Date.now();
  const result = await runSsh(host, PROBE_SCRIPT, options.timeoutMs ?? 25_000);
  const platform = field(result.stdout, 'os');
  const ok = result.code === 0 && Boolean(platform) && !result.error;
  // gcloud IAP 隧道会在 stderr 打多行提示；失败时不要把提示当原因，留最后几条真实错误。
  const stderrDetail = result.stderr.split(/\r?\n/)
    .map(line => line.trim())
    .filter(line => line
      && !/^WARNING:\s*$/.test(line)
      && !/^To increase the performance of the tunnel/i.test(line)
      && !/^please see https:\/\/cloud\.google\.com\/iap\//i.test(line)
      && !/^Warning: Permanently added .* known hosts/i.test(line))
    .slice(-4)
    .join('\n');
  const detail = ok
    ? undefined
    : result.timedOut
      ? `连接超时（${Math.round((options.timeoutMs ?? 25_000) / 1000)} 秒）`
      : result.error
        ? result.error
        : (stderrDetail || `ssh exited with ${result.code ?? 'unknown'}`);
  return {
    host,
    ok,
    latencyMs: Date.now() - started,
    ...(platform ? { platform } : {}),
    ...(field(result.stdout, 'node') ? { nodeVersion: field(result.stdout, 'node') } : {}),
    ...(field(result.stdout, 'npx') ? { npx: true } : {}),
    ...(field(result.stdout, 'home') ? { home: field(result.stdout, 'home') } : {}),
    agents: {
      claude: Boolean(field(result.stdout, 'claude')),
      codex: Boolean(field(result.stdout, 'codex'))
    },
    ...(detail ? { detail } : {})
  };
}

