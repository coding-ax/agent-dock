/** 图标来自 AgentDock 仓库 apps/web/public/agent-icons（Lobe Icons 等，见 public/agent-icons/README.md）。 */
export interface AgentInfo { id: string; name: string; icon: string; mono?: boolean }

const icon = (file: string) => `/agent-icons/${file}`;

export const AGENTS: Record<string, AgentInfo> = {
  claude: { id: 'claude', name: 'Claude Code', icon: icon('claudecode.svg') },
  codex: { id: 'codex', name: 'Codex', icon: icon('codex.svg') },
  gemini: { id: 'gemini', name: 'Gemini CLI', icon: icon('gemini.svg') },
  cursor: { id: 'cursor', name: 'Cursor', icon: icon('cursor.svg'), mono: true },
  antigravity: { id: 'antigravity', name: 'Antigravity', icon: icon('antigravity.svg') },
  copilot: { id: 'copilot', name: 'GitHub Copilot', icon: icon('copilot.svg') },
  opencode: { id: 'opencode', name: 'opencode', icon: icon('opencode.svg'), mono: true },
  trae: { id: 'trae', name: 'Trae', icon: icon('trae.svg') },
  qwen: { id: 'qwen', name: 'Qwen Code', icon: icon('qwen.svg') },
  kimi: { id: 'kimi', name: 'Kimi CLI', icon: icon('kimi.svg'), mono: true },
  pi: { id: 'pi', name: 'Pi', icon: icon('pi.svg'), mono: true },
  droid: { id: 'droid', name: 'Factory Droid', icon: icon('droid.svg') },
  kiro: { id: 'kiro', name: 'Kiro', icon: icon('kiro.svg') },
  kilocode: { id: 'kilocode', name: 'Kilo Code', icon: icon('kilocode.svg'), mono: true },
  iflow: { id: 'iflow', name: 'iFlow CLI', icon: icon('iflow.png') },
  grok: { id: 'grok', name: 'Grok Build', icon: icon('grok.svg'), mono: true },
  deepseek: { id: 'deepseek', name: 'DeepSeek', icon: icon('deepseek.svg') },
  qoder: { id: 'qoder', name: 'Qoder', icon: icon('qoder.svg') },
  mcode: { id: 'mcode', name: 'MiniMax Code', icon: icon('mcode.svg') },
  openclaw: { id: 'openclaw', name: 'OpenClaw', icon: icon('openclaw.svg') },
  fastagent: { id: 'fastagent', name: 'fast-agent', icon: icon('fast-agent.svg') },
  mux: { id: 'mux', name: 'Mux', icon: icon('mux.svg'), mono: true },
  poolside: { id: 'poolside', name: 'Poolside', icon: icon('poolside.svg') },
  zeroclaw: { id: 'zeroclaw', name: 'ZeroClaw', icon: icon('zeroclaw.svg') }
};

export const AGENT_ROWS: string[][] = [
  ['claude', 'codex', 'gemini', 'cursor', 'antigravity', 'copilot', 'opencode', 'trae', 'qwen', 'kimi', 'pi', 'droid'],
  ['kiro', 'kilocode', 'iflow', 'grok', 'deepseek', 'qoder', 'mcode', 'openclaw', 'fastagent', 'mux', 'poolside', 'zeroclaw']
];

export const agentByName = (name: string): AgentInfo | undefined =>
  Object.values(AGENTS).find(agent => agent.name === name || agent.name.startsWith(name));
