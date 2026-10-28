import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';

import { access, stat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { delimiter, resolve } from 'node:path';

async function localCodexPath() {
  if (process.env.CODEX_PATH) return process.env.CODEX_PATH;
  for (const directory of (process.env.PATH ?? '').split(delimiter).filter(Boolean)) {
    for (const name of process.platform === 'win32' ? ['codex.exe', 'codex.cmd', 'codex.bat'] : ['codex']) {
      const candidate = resolve(directory, name);
      try { if (!(await stat(candidate)).isFile()) continue; await access(candidate, constants.X_OK); return candidate; } catch {}
    }
  }
  throw new Error('未找到本机 Codex，请将 Codex CLI 加入 PATH 或设置 CODEX_PATH。');
}

// Only the launcher environment receives CODEX_PATH; persisted session keys
// remain snake_case. Discovery and sessions use this same local executable.
process.env.CODEX_PATH = await localCodexPath();
if (process.argv[2] === '--version') {
  const result = spawnSync(process.env.CODEX_PATH, ['--version'], { stdio: 'inherit', timeout: 1000, shell: process.platform === 'win32' });
  process.exit(result.status ?? 1);
}
// Import in this process without an intermediary npx or shell process.
// Session-specific selection overrides only model; retain provider routing and
// credentials from CODEX_CONFIG / CODEX_HOME without modifying shared files.
if (process.env.agentdock_codex_model) {
  let config;
  try { config = JSON.parse(process.env.CODEX_CONFIG || '{}'); }
  catch { throw new Error('Codex CODEX_CONFIG 必须是有效的 JSON 对象。'); }
  if (!config || typeof config !== 'object' || Array.isArray(config)) throw new Error('Codex CODEX_CONFIG 必须是有效的 JSON 对象。');
  process.env.CODEX_CONFIG = JSON.stringify({ ...config, model: process.env.agentdock_codex_model });
}
const adapter = createRequire(import.meta.url).resolve('@agentclientprotocol/codex-acp');
await import(pathToFileURL(adapter).href);
