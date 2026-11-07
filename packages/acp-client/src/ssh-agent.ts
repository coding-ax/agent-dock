import type { AgentConfig } from '@agent-dock/agent-dock-shared';

/**
 * Run a built-in ACP agent on a remote host over the same stdio contract the
 * local transports already speak: `ssh` becomes the agent command, and the
 * remote side execs the adapter with npx. Everything above this layer (ACP
 * initialize/session/new/session/load, external session listing, model
 * discovery, resume) works unchanged because it is still just JSONL on stdio.
 *
 * The adapters are the same versions pinned in package.json. The remote host
 * needs Node/npx and the matching agent CLI (`claude` / `codex`), which is what
 * the SSH probe checks before the import panel offers a host.
 */

const REMOTE_ADAPTERS: Record<string, string> = {
  claude: '@agentclientprotocol/claude-agent-acp@0.66.0',
  codex: '@agentclientprotocol/codex-acp@1.10.0'
};

export function supportsSshAgent(agent: Pick<AgentConfig, 'id'>): boolean {
  return Boolean(REMOTE_ADAPTERS[agent.id]);
}

/**
 * PATH setup shared with the probe. Non-interactive SSH usually does not source
 * .zshrc/.bashrc (and sourcing them can print banners into the ACP stream), so
 * the usual Node install locations are added explicitly.
 */
export const REMOTE_PATH_PREFIX = 'PATH="$HOME/.local/bin:$HOME/.npm-global/bin:/usr/local/bin:/usr/bin:/bin:$PATH"; export PATH; for d in "$HOME"/.nvm/versions/node/*/bin "$HOME"/.volta/bin; do [ -d "$d" ] && PATH="$d:$PATH"; done; export PATH;';

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

/**
 * Only provider routing/credentials and the per-session Codex model are
 * forwarded. Everything else in `agent.env` is local runtime plumbing
 * (`agentdock_database`, group-tools tokens) that must not leak to a remote
 * machine, and arbitrary env would also end up in the remote process list.
 */
function forwardedEnv(agent: AgentConfig): Record<string, string> {
  const allowed = /^(ANTHROPIC_(API_KEY|AUTH_TOKEN|BASE_URL)|OPENAI_(API_KEY|BASE_URL)|agentdock_codex_model|CODEX_CONFIG)$/;
  const env: Record<string, string> = Object.fromEntries(
    Object.entries(agent.env ?? {}).filter(([key, value]) => allowed.test(key) && Boolean(value))
  );
  if (agent.id === 'codex' && agent.model) {
    // The upstream codex adapter does not read AgentDock's launcher-only
    // `agentdock_codex_model`; CODEX_CONFIG is the supported override.
    let base: Record<string, unknown> = {};
    try {
      const parsed = env.CODEX_CONFIG ? JSON.parse(env.CODEX_CONFIG) : undefined;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) base = parsed as Record<string, unknown>;
    } catch { /* invalid user config: keep the model-only object */ }
    env.CODEX_CONFIG = JSON.stringify({ ...base, model: agent.model });
    delete env.agentdock_codex_model;
  }
  return env;
}

export function remoteAgentCommand(packageName: string, remoteCwd: string | undefined, env: Record<string, string> = {}): string {
  const exports = Object.entries(env)
    .filter(([key, value]) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(key) && value)
    .map(([key, value]) => `export ${key}=${shellQuote(value)};`)
    .join(' ');
  const cd = remoteCwd ? `cd ${shellQuote(remoteCwd)} || exit 1; ` : '';
  return `${REMOTE_PATH_PREFIX} ${exports} ${cd}exec npx -y ${shellQuote(packageName)}`;
}

export interface SshAgentOptions {
  /** Local cwd for the ssh child. The session cwd is a remote path and usually does not exist locally. */
  localCwd?: string;
}

/**
 * Wrap a configured agent so its process is `ssh host -- sh -c '… npx adapter'`.
 * Returns a new config; the persisted agent is untouched.
 */
export function wrapAgentForSsh(agent: AgentConfig, host: string, remoteCwd: string | undefined, options: SshAgentOptions = {}): AgentConfig {
  if (!/^[A-Za-z0-9][A-Za-z0-9._@:+-]*$/.test(host)) throw new Error(`Invalid SSH host: ${host}`);
  const adapter = REMOTE_ADAPTERS[agent.id];
  if (!adapter) throw new Error(`远端暂不支持 ${agent.name}（仅 Claude Code / Codex）`);
  const remoteCommand = remoteAgentCommand(adapter, remoteCwd, forwardedEnv(agent));
  return {
    ...agent,
    command: 'ssh',
    args: [
      '-T',
      '-o', 'BatchMode=yes',
      '-o', 'ConnectTimeout=10',
      '-o', 'ServerAliveInterval=15',
      '-o', 'ServerAliveCountMax=3',
      '-o', 'LogLevel=ERROR',
      host,
      remoteCommand
    ],
    // Never pass local runtime env to the ssh child; the remote command embeds
    // the small allow-listed set explicitly.
    env: {},
    cwd: options.localCwd ?? process.cwd(),
    protocol: 'acp'
  };
}
