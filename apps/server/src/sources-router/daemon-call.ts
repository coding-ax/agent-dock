import { spawnSync } from 'node:child_process';
import { requireDaemon } from '../session-cli.js';

export function callDaemonSync<T>(path: string, method: 'GET' | 'POST' | 'DELETE', body?: object): T {
  const state = requireDaemon();
  const base = new URL(state.webConsoleUrl ?? state.address!);
  const token = base.searchParams.get('t');
  const script = [
    `const url = ${JSON.stringify(new URL(path, base.origin).toString())};`,
    `const token = ${JSON.stringify(token)};`,
    `const method = ${JSON.stringify(method)};`,
    `const body = ${JSON.stringify(body === undefined ? null : JSON.stringify(body))};`,
    "const headers = token ? { cookie: 'agentdock_web=' + encodeURIComponent(token) } : {};",
    "if (body !== null) headers['content-type'] = 'application/json';",
    'fetch(url, { method, headers, ...(body !== null ? { body } : {}), signal: AbortSignal.timeout(15000) })',
    '  .then(async response => { const text = await response.text(); if (!response.ok) { process.stderr.write(text); process.exit(1); } process.stdout.write(text); })',
    "  .catch(error => { process.stderr.write(String(error)); process.exit(1); });"
  ].join('\n');
  const result = spawnSync(process.execPath, ['-e', script], { encoding: 'utf8' });
  if (result.status !== 0) throw new Error(result.stderr.trim() || `调用 ${path} 失败`);
  return JSON.parse(result.stdout) as T;
}
