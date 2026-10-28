import { useState } from 'react';
import { Bot } from 'lucide-react';

/**
 * 飞书机器人头像。直链会随用户在飞书侧换头像而失效（URL 里带版本号，旧链接直接 404），
 * 所以加载失败必须回退到通用图标，不能留一个破图。
 */
export function BotAvatar({ url, size, className = 'h-full w-full rounded-md object-cover' }: { url: string; size: number; className?: string }) {
  const [failed, setFailed] = useState(false);
  if (failed) return <Bot size={size}/>;
  return <img src={url} alt="" onError={() => setFailed(true)} className={className}/>;
}

const agentBrands = {
  claude: 'claudecode', claudecode: 'claudecode',
  codex: 'codex',
  copilot: 'copilot', githubcopilot: 'copilot',
  cursor: 'cursor', cursoragent: 'cursor',
  deepseek: 'deepseek', deepseekharness: 'deepseek',
  droid: 'droid', factorydroid: 'droid',
  fastagent: 'fast-agent',
  gemini: 'gemini', geminicli: 'gemini',
  grokbuild: 'grok',
  iflow: 'iflow', iflowcli: 'iflow',
  kilocode: 'kilocode',
  kimi: 'kimi', kimicli: 'kimi',
  kiro: 'kiro', kirocli: 'kiro',
  mcode: 'mcode', minimaxcode: 'mcode',
  mux: 'mux',
  openclaw: 'openclaw',
  opencode: 'opencode',
  pi: 'pi', picodingagent: 'pi',
  pool: 'poolside', poolside: 'poolside',
  qoder: 'qoder', qodercli: 'qoder',
  qwen: 'qwen', qwencode: 'qwen',
  trae: 'trae', traecli: 'trae',
  zeroclaw: 'zeroclaw',
} as const;

type AgentBrand = typeof agentBrands[keyof typeof agentBrands];
const monochromeBrands = new Set<AgentBrand>(['cursor', 'grok', 'kilocode', 'kimi', 'mux', 'opencode', 'pi']);

/** 只按 Agent 身份匹配，不按模型名猜品牌；未知 Agent 使用通用图标。 */
export function agentBrand(agentId?: string, agentName?: string): AgentBrand | undefined {
  for (const value of [agentId, agentName]) {
    const key = value?.toLowerCase().replace(/[^a-z0-9]/g, '');
    if (key && key in agentBrands) return agentBrands[key as keyof typeof agentBrands];
  }
  return undefined;
}

export function AgentIcon({ agentId, agentName, size = 14, onDark = false, className = '' }: { agentId?: string; agentName?: string; size?: number; onDark?: boolean; className?: string }) {
  const brand = agentBrand(agentId, agentName);
  if (!brand) return <Bot size={size} aria-hidden="true" className={`shrink-0 ${className}`}/>;
  const extension = brand === 'iflow' ? 'png' : 'svg';
  return <img src={`/agent-icons/${brand}.${extension}`} width={size} height={size} alt="" aria-hidden="true" className={`shrink-0 object-contain ${onDark && monochromeBrands.has(brand) ? 'brightness-0 invert' : ''} ${className}`}/>;
}
