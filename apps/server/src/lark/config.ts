import { randomUUID } from 'node:crypto';
import { defaultLarkTraceLimit, validateHighRiskPattern, type AgentRepository, type ConfigRepository } from '@agent-dock/agent-dock-shared';
import { isAbsolute } from 'node:path';
import { LarkServiceError } from './service.js';

export const larkBotsConfigKey = 'lark.bots';
export const larkCredentialsConfigKey = 'lark.credentials';

export interface LarkAllowedUser {
  openId: string;
  name: string;
}

export interface StoredLarkConfig {
  /** 管理员每次保存生成新版本；身份绑定写回不改变此版本。 */
  revision?: string;
  appId: string;
  appSecret: string;
  name?: string;
  /**
   * 飞书应用头像直链。服务端在保存 `stage: 'lark'` 配置（扫码注册 / 设置页保存）时，
   * 从 `/open-apis/bot/v3/info` 已经取回的 `bot.avatar_url` 顺带落盘，用户不可编辑。
   * 用户在飞书换头像后，重存一次机器人配置即可刷新。
   */
  avatarUrl?: string;
  workspace?: string;
  webBaseUrl?: string;
  defaultAgentId?: string;
  defaultModel?: string;
  defaultReasoningEffort?: string;
  preInjectPrompt: string;
  listening: boolean;
  groupToolsEnabled: boolean;
  groupToolsAllowSend: boolean;
  /** 群聊主流消息（非话题内）的 Session 隔离策略：user=按发送人隔离，chat=全群共享。话题内消息始终按 thread_id 隔离。 */
  groupSessionScope: 'user' | 'chat';
  pushIntervalMs: number;
  traceLimit?: number;
  hideTraceOnComplete: boolean;
  /** 静默模式：不展示 trace 卡片，最终回复由服务自动以文本消息发送到会话。 */
  quietReply: boolean;
  allowedUsers: LarkAllowedUser[];
  allowedUserNames?: string[];
  allowedEmails: string[];
  allowedBots: LarkAllowedUser[];
  allowedBotNames?: string[];
  peerBotsAllowed: boolean;
  highRiskAllowedUsers: LarkAllowedUser[];
  highRiskAllowedUserNames?: string[];
  highRiskAllowedEmails: string[];
  highRiskPattern: string;
  gateEnabled: boolean;
  softGateEnabled: boolean;
  hardGateEnabled: boolean;
  hookTrustConfirmed: boolean;
}

export interface SaveLarkConfigInput {
  stage?: 'lark' | 'agent';
  originalAppId?: string;
  appId?: string;
  appSecret?: string;
  name?: string;
  avatarUrl?: string;
  workspace?: string;
  webBaseUrl?: string;
  defaultAgentId?: string;
  defaultModel?: string;
  defaultReasoningEffort?: string;
  preInjectPrompt?: string;
  listening?: boolean;
  groupToolsEnabled?: boolean;
  groupToolsAllowSend?: boolean;
  groupSessionScope?: 'user' | 'chat';
  pushIntervalMs?: number;
  traceLimit?: number | null;
  hideTraceOnComplete?: boolean;
  quietReply?: boolean;
  allowedUsers?: LarkAllowedUser[];
  allowedUserNames?: string[];
  allowedEmails?: string[];
  allowedBots?: LarkAllowedUser[];
  allowedBotNames?: string[];
  peerBotsAllowed?: boolean;
  highRiskAllowedUsers?: LarkAllowedUser[];
  highRiskAllowedUserNames?: string[];
  highRiskAllowedEmails?: string[];
  highRiskPattern?: string;
  gateEnabled?: boolean;
  softGateEnabled?: boolean;
  hardGateEnabled?: boolean;
  hookTrustConfirmed?: boolean;
}

export interface PublicLarkConfig {
  configured: true;
  appId: string;
  name: string;
  tabLabel: string;
  setupComplete: boolean;
  /** 飞书应用头像直链；尚未取到过时缺省，前端回退为通用机器人图标。 */
  avatarUrl?: string;
  workspace?: string;
  webBaseUrl?: string;
  defaultAgentId?: string;
  defaultModel?: string;
  defaultReasoningEffort?: string;
  preInjectPrompt: string;
  listening: boolean;
  activeListening: boolean;
  groupToolsEnabled: boolean;
  groupToolsAllowSend: boolean;
  groupSessionScope: 'user' | 'chat';
  pushIntervalMs: number;
  traceLimit?: number;
  hideTraceOnComplete: boolean;
  /** 静默模式：不展示 trace 卡片，最终回复由服务自动以文本消息发送到会话。 */
  quietReply: boolean;
  allowedUsers: LarkAllowedUser[];
  allowedUserNames?: string[];
  allowedEmails: string[];
  allowedBots: LarkAllowedUser[];
  allowedBotNames?: string[];
  peerBotsAllowed: boolean;
  highRiskAllowedUsers: LarkAllowedUser[];
  highRiskAllowedUserNames?: string[];
  highRiskAllowedEmails: string[];
  highRiskPattern: string;
  gateEnabled: boolean;
  softGateEnabled: boolean;
  hardGateEnabled: boolean;
  hookTrustConfirmed: boolean;
}

export interface PublicLarkConfigCollection {
  configured: boolean;
  bots: PublicLarkConfig[];
  listeningDisabled: boolean;
}

export const defaultLarkPushIntervalMs = 1_000;
export { defaultLarkTraceLimit } from '@agent-dock/agent-dock-shared';
export const defaultHighRiskPattern = String.raw`(?:^|[\s;&|])(?:sudo|rm|shred|dd|mkfs|diskutil|launchctl|kill|pkill|lark-?cli|larkcli|ssh|scp|rsync|osascript)\b|\bgit\s+(?:push|reset|clean|checkout)\b|\b(?:npm|pnpm|yarn)\s+(?:publish|unpublish)\b|\bcurl\b[^\n]*(?:-X|--request)\s*(?:POST|PUT|PATCH|DELETE)\b`;

const normalizeNames = (value: unknown): string[] => {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some(name => typeof name !== 'string')) throw new LarkServiceError('INVALID_LARK_NAMES', '白名单姓名必须为字符串数组', 400);
  const names = [...new Map(value.map(name => name.trim()).filter(Boolean).map(name => [name.normalize('NFKC').toLocaleLowerCase(), name])).values()];
  if (names.length > 50) throw new LarkServiceError('LARK_TOO_MANY_USER_NAMES', '一次最多配置 50 个姓名', 400);
  return names;
};

const normalizeEmails = (value: unknown) => [...new Set((Array.isArray(value) ? value : [])
  .map(item => String(item).trim().toLowerCase()).filter(Boolean))];

const normalizeWebBaseUrl = (value: unknown) => {
  const trimmed = String(value ?? '').trim().replace(/\/$/, '');
  if (!trimmed) return undefined;
  return /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
};

const normalizeAllowedUsers = (value: unknown): LarkAllowedUser[] => {
  const users = new Map<string, LarkAllowedUser>();
  for (const item of Array.isArray(value) ? value : []) {
    if (!item || typeof item !== 'object') continue;
    const openId = String((item as Partial<LarkAllowedUser>).openId ?? '').trim();
    if (!openId.startsWith('ou_')) continue;
    const name = String((item as Partial<LarkAllowedUser>).name ?? '').trim() || openId;
    users.set(openId, { openId, name });
  }
  return [...users.values()];
};

function normalizeStoredConfig(parsed: Partial<StoredLarkConfig>): StoredLarkConfig | undefined {
  if (!parsed.appId || !parsed.appSecret) return undefined;
  const pushIntervalMs = Number(parsed.pushIntervalMs ?? defaultLarkPushIntervalMs);
  const parsedTraceLimit = Number(parsed.traceLimit ?? defaultLarkTraceLimit);
  const traceLimit = Number.isInteger(parsedTraceLimit) && parsedTraceLimit > 0 ? parsedTraceLimit : defaultLarkTraceLimit;
  const gateEnabled = parsed.gateEnabled === undefined ? parsed.softGateEnabled !== false || parsed.hardGateEnabled === true : parsed.gateEnabled === true;
  return {
    ...(parsed.revision ? { revision: parsed.revision } : {}),
    appId: parsed.appId.trim(),
    appSecret: parsed.appSecret,
    ...(parsed.name?.trim() ? { name: parsed.name.trim() } : {}),
    // 必须显式列出：本函数是逐字段重建的字面量，未列出的字段每次读取都会被静默丢弃。
    ...(parsed.avatarUrl?.trim() ? { avatarUrl: parsed.avatarUrl.trim() } : {}),
    ...(parsed.workspace?.trim() ? { workspace: parsed.workspace.trim() } : {}),
    ...(normalizeWebBaseUrl(parsed.webBaseUrl) ? { webBaseUrl: normalizeWebBaseUrl(parsed.webBaseUrl) } : {}),
    ...(parsed.defaultAgentId ? { defaultAgentId: parsed.defaultAgentId } : {}),
    ...(parsed.defaultModel ? { defaultModel: parsed.defaultModel } : {}),
    ...(parsed.defaultReasoningEffort ? { defaultReasoningEffort: parsed.defaultReasoningEffort } : {}),
    preInjectPrompt: String(parsed.preInjectPrompt ?? '').trim(),
    listening: parsed.listening === true,
    groupToolsEnabled: parsed.groupToolsEnabled === true,
    groupToolsAllowSend: parsed.groupToolsEnabled === true && parsed.groupToolsAllowSend === true,
    groupSessionScope: parsed.groupSessionScope === 'chat' ? 'chat' : 'user',
    pushIntervalMs: Number.isInteger(pushIntervalMs) && pushIntervalMs >= 500 && pushIntervalMs <= 20_000 ? pushIntervalMs : defaultLarkPushIntervalMs,
    traceLimit,
    hideTraceOnComplete: parsed.hideTraceOnComplete !== false,
    quietReply: parsed.quietReply === true,
    allowedUsers: normalizeAllowedUsers(parsed.allowedUsers),
    allowedUserNames: normalizeNames(parsed.allowedUserNames),
    allowedEmails: normalizeEmails(parsed.allowedEmails),
    allowedBots: normalizeAllowedUsers(parsed.allowedBots),
    allowedBotNames: normalizeNames(parsed.allowedBotNames),
    peerBotsAllowed: parsed.peerBotsAllowed !== false,
    highRiskAllowedUsers: normalizeAllowedUsers(parsed.highRiskAllowedUsers),
    highRiskAllowedUserNames: normalizeNames(parsed.highRiskAllowedUserNames),
    highRiskAllowedEmails: normalizeEmails(parsed.highRiskAllowedEmails),
    highRiskPattern: parsed.highRiskPattern?.trim() || defaultHighRiskPattern,
    gateEnabled,
    softGateEnabled: gateEnabled,
    hardGateEnabled: gateEnabled && parsed.hardGateEnabled === true,
    hookTrustConfirmed: parsed.hookTrustConfirmed === true
  };
}

export async function readLarkConfigState(repository?: ConfigRepository): Promise<{ raw: string | undefined; configs: StoredLarkConfig[] }> {
  const raw = await repository?.get(larkBotsConfigKey);
  if (raw) {
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) return { raw, configs: parsed.map(item => normalizeStoredConfig(item)).filter((item): item is StoredLarkConfig => Boolean(item)) };
    } catch {}
  }
  const legacy = await repository?.get(larkCredentialsConfigKey);
  if (legacy) {
    try {
      const config = normalizeStoredConfig(JSON.parse(legacy));
      if (config) return { raw, configs: [config] };
    } catch {}
  }
  return { raw, configs: [] };
}

export async function readLarkConfigs(repository?: ConfigRepository): Promise<StoredLarkConfig[]> {
  return (await readLarkConfigState(repository)).configs;
}

/** CAS 保护后台身份绑定和管理员保存，避免互相覆盖。旧存储仍可保存普通配置。 */
async function writeConfigState(repository: ConfigRepository, raw: string | undefined, configs: StoredLarkConfig[]) {
  const value = JSON.stringify(configs);
  if (repository.compareAndSet) return repository.compareAndSet(larkBotsConfigKey, raw, value);
  await repository.set(larkBotsConfigKey, value);
  return true;
}

export async function readLarkConfig(repository?: ConfigRepository, appId?: string): Promise<StoredLarkConfig | undefined> {
  const configs = await readLarkConfigs(repository);
  return appId ? configs.find(config => config.appId === appId) : configs[0];
}

export const publicLarkConfig = (config: StoredLarkConfig, activeAppIds: ReadonlySet<string> = new Set(), duplicateNames: ReadonlySet<string> = new Set()): PublicLarkConfig => ({
  configured: true,
  appId: config.appId,
  name: config.name ?? config.appId,
  tabLabel: duplicateNames.has((config.name ?? config.appId).toLowerCase()) ? `${config.name ?? config.appId} · ${config.appId}` : config.name ?? config.appId,
  setupComplete: Boolean(config.defaultAgentId),
  ...(config.avatarUrl ? { avatarUrl: config.avatarUrl } : {}),
  ...(config.workspace ? { workspace: config.workspace } : {}),
  ...(config.webBaseUrl ? { webBaseUrl: config.webBaseUrl } : {}),
  ...(config.defaultAgentId ? { defaultAgentId: config.defaultAgentId } : {}),
  ...(config.defaultModel ? { defaultModel: config.defaultModel } : {}),
  ...(config.defaultReasoningEffort ? { defaultReasoningEffort: config.defaultReasoningEffort } : {}),
  preInjectPrompt: config.preInjectPrompt,
  listening: config.listening,
  activeListening: activeAppIds.has(config.appId),
  groupToolsEnabled: config.groupToolsEnabled,
  groupToolsAllowSend: config.groupToolsAllowSend,
  groupSessionScope: config.groupSessionScope,
  pushIntervalMs: config.pushIntervalMs,
  traceLimit: config.traceLimit ?? defaultLarkTraceLimit,
  hideTraceOnComplete: config.hideTraceOnComplete,
  quietReply: config.quietReply === true,
  allowedUsers: config.allowedUsers,
  allowedUserNames: config.allowedUserNames ?? [],
  allowedEmails: config.allowedEmails,
  allowedBots: config.allowedBots,
  allowedBotNames: config.allowedBotNames ?? [],
  peerBotsAllowed: config.peerBotsAllowed,
  highRiskAllowedUsers: config.highRiskAllowedUsers,
  highRiskAllowedUserNames: config.highRiskAllowedUserNames ?? [],
  highRiskAllowedEmails: config.highRiskAllowedEmails,
  highRiskPattern: config.highRiskPattern,
  gateEnabled: config.gateEnabled,
  softGateEnabled: config.softGateEnabled,
  hardGateEnabled: config.hardGateEnabled,
  hookTrustConfirmed: config.hookTrustConfirmed
});

export const publicLarkConfigs = (configs: StoredLarkConfig[], runtime: { activeAppIds?: readonly string[]; listeningDisabled?: boolean } = {}): PublicLarkConfigCollection => {
  const active = new Set(runtime.activeAppIds ?? []);
  const counts = new Map<string, number>();
  for (const config of configs) {
    const key = (config.name ?? config.appId).toLowerCase();
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const duplicateNames = new Set([...counts].filter(([, count]) => count > 1).map(([name]) => name));
  return {
    configured: configs.length > 0,
    bots: configs.map(config => publicLarkConfig(config, active, duplicateNames)),
    listeningDisabled: runtime.listeningDisabled === true
  };
};

/** 未修改的已绑定姓名保留 open_id；新姓名延后解析，空数组显式清除限制。 */
function updateAllowlist(inputUsers: LarkAllowedUser[] | undefined, inputNames: string[] | undefined, currentUsers: LarkAllowedUser[] = [], currentNames: string[] = [], preserveBinding = true) {
  if (inputNames === undefined) return inputUsers === undefined
    ? { users: currentUsers, names: currentNames }
    : { users: normalizeAllowedUsers(inputUsers), names: [] };
  const names = normalizeNames(inputNames);
  const key = (name: string) => name.trim().normalize('NFKC').toLocaleLowerCase();
  if (preserveBinding && !currentNames.length && names.length > 0 && names.length === currentUsers.length && currentUsers.every(user => names.some(name => key(name) === key(user.name)))) {
    return { users: currentUsers, names: [] };
  }
  return { users: [], names };
}

export async function saveLarkConfig(repository: ConfigRepository | undefined, agents: AgentRepository | undefined, input: SaveLarkConfigInput): Promise<StoredLarkConfig[]> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const saved = await saveLarkConfigAttempt(repository, agents, input);
    if (saved) return saved;
  }
  throw new LarkServiceError('LARK_CONFIG_CONFLICT', '配置正在被并发更新，请重试保存', 409);
}

async function saveLarkConfigAttempt(repository: ConfigRepository | undefined, agents: AgentRepository | undefined, input: SaveLarkConfigInput): Promise<StoredLarkConfig[] | undefined> {
  if (!repository) throw new LarkServiceError('LARK_CONFIG_STORAGE_UNAVAILABLE', 'Lark configuration storage is unavailable', 503);
  const { raw, configs } = await readLarkConfigState(repository);
  const originalAppId = input.originalAppId?.trim();
  const index = originalAppId ? configs.findIndex(config => config.appId === originalAppId) : -1;
  if (originalAppId && index < 0) throw new LarkServiceError('LARK_BOT_NOT_FOUND', `Unknown Lark bot: ${originalAppId}`, 404);
  const current = index >= 0 ? configs[index] : undefined;
  const appId = input.appId?.trim() || current?.appId;
  const appSecret = input.appSecret?.trim() || current?.appSecret;
  const name = input.name === undefined ? current?.name : input.name.trim() || undefined;
  // 未提供时保留当前值：头像只在 stage: 'lark' 的保存里带上，其余保存不能把它抹掉。
  const avatarUrl = input.avatarUrl === undefined ? current?.avatarUrl : input.avatarUrl.trim() || undefined;
  const workspace = input.workspace === undefined ? current?.workspace : input.workspace.trim() || undefined;
  const webBaseUrl = input.webBaseUrl === undefined ? current?.webBaseUrl : normalizeWebBaseUrl(input.webBaseUrl);
  const defaultAgentId = input.defaultAgentId?.trim() || current?.defaultAgentId;
  const listening = input.listening ?? current?.listening ?? false;
  const groupToolsEnabled = input.groupToolsEnabled ?? current?.groupToolsEnabled ?? false;
  const groupToolsAllowSend = groupToolsEnabled && (input.groupToolsAllowSend ?? current?.groupToolsAllowSend ?? false);
  const groupSessionScope = input.groupSessionScope === 'chat' ? 'chat' : (current?.groupSessionScope ?? 'user');
  const pushIntervalMs = input.pushIntervalMs ?? current?.pushIntervalMs ?? defaultLarkPushIntervalMs;
  const traceLimit = input.traceLimit === undefined ? current?.traceLimit ?? defaultLarkTraceLimit : input.traceLimit ?? defaultLarkTraceLimit;
  const hideTraceOnComplete = input.hideTraceOnComplete ?? current?.hideTraceOnComplete ?? true;
  const quietReply = input.quietReply ?? current?.quietReply ?? false;
  const defaultModel = input.defaultModel === undefined ? current?.defaultModel : input.defaultModel.trim() || undefined;
  const defaultReasoningEffort = input.defaultReasoningEffort === undefined ? current?.defaultReasoningEffort : input.defaultReasoningEffort.trim() || undefined;
  const preInjectPrompt = input.preInjectPrompt === undefined ? current?.preInjectPrompt ?? '' : input.preInjectPrompt.trim();
  const identityUnchanged = current?.appId === appId;
  const { users: allowedUsers, names: allowedUserNames } = updateAllowlist(input.allowedUsers, input.allowedUserNames, current?.allowedUsers, current?.allowedUserNames, identityUnchanged);
  const allowedEmails = input.allowedEmails === undefined ? current?.allowedEmails ?? [] : normalizeEmails(input.allowedEmails);
  const { users: allowedBots, names: allowedBotNames } = updateAllowlist(input.allowedBots, input.allowedBotNames, current?.allowedBots, current?.allowedBotNames, identityUnchanged);
  const peerBotsAllowed = input.peerBotsAllowed === undefined ? current?.peerBotsAllowed ?? true : input.peerBotsAllowed;
  const { users: highRiskAllowedUsers, names: highRiskAllowedUserNames } = updateAllowlist(input.highRiskAllowedUsers, input.highRiskAllowedUserNames, current?.highRiskAllowedUsers, current?.highRiskAllowedUserNames, identityUnchanged);
  const highRiskAllowedEmails = input.highRiskAllowedEmails === undefined ? current?.highRiskAllowedEmails ?? [] : normalizeEmails(input.highRiskAllowedEmails);
  const highRiskPattern = input.highRiskPattern === undefined ? current?.highRiskPattern ?? defaultHighRiskPattern : input.highRiskPattern.trim() || defaultHighRiskPattern;
  const gateEnabled = input.gateEnabled ?? current?.gateEnabled ?? false;
  const softGateEnabled = gateEnabled;
  const hardGateEnabled = gateEnabled && (input.hardGateEnabled ?? current?.hardGateEnabled ?? false);
  const hookTrustConfirmed = input.hookTrustConfirmed ?? current?.hookTrustConfirmed ?? false;
  if (!appId) throw new LarkServiceError('INVALID_LARK_CONFIG', 'App ID is required', 400);
  if (!appSecret) throw new LarkServiceError('INVALID_LARK_CONFIG', 'App Secret is required', 400);
  if (input.stage === 'agent' && !defaultAgentId) throw new LarkServiceError('INVALID_LARK_CONFIG', 'Default Agent is required', 400);
  if (current?.hardGateEnabled && defaultAgentId !== current.defaultAgentId) throw new LarkServiceError('HARD_GATE_AGENT_LOCKED', 'Disable and save the hard gate before changing the default Agent', 409);
  if (workspace && !isAbsolute(workspace)) throw new LarkServiceError('INVALID_LARK_CONFIG', 'Workspace must be an absolute path', 400);
  if (!Number.isInteger(pushIntervalMs) || pushIntervalMs < 500 || pushIntervalMs > 20_000) throw new LarkServiceError('INVALID_LARK_CONFIG', 'Push interval must be an integer between 500 and 20000 milliseconds', 400);
  if (!Number.isInteger(traceLimit) || traceLimit < 1) throw new LarkServiceError('INVALID_LARK_CONFIG', 'Trace limit must be a positive integer', 400);
  const patternValidation = validateHighRiskPattern(highRiskPattern);
  if (!patternValidation.valid) throw new LarkServiceError('INVALID_HIGH_RISK_PATTERN', patternValidation.error, 400);
  if (agents && defaultAgentId && !(await agents.get(defaultAgentId))) throw new LarkServiceError('INVALID_LARK_CONFIG', `Unknown default Agent: ${defaultAgentId}`, 400);
  const duplicate = configs.find((config, configIndex) => config.appId === appId && configIndex !== index);
  if (duplicate) throw new LarkServiceError('LARK_BOT_ALREADY_CONFIGURED', `Lark bot ${appId} already has a configuration panel`, 409);
  const config: StoredLarkConfig = {
    revision: randomUUID(),
    appId,
    appSecret,
    ...(name ? { name } : {}),
    ...(avatarUrl ? { avatarUrl } : {}),
    ...(workspace ? { workspace } : {}),
    ...(webBaseUrl ? { webBaseUrl } : {}),
    ...(defaultAgentId ? { defaultAgentId } : {}),
    ...(defaultModel ? { defaultModel } : {}),
    ...(defaultReasoningEffort ? { defaultReasoningEffort } : {}),
    preInjectPrompt,
    listening,
    groupToolsEnabled,
    groupToolsAllowSend,
    groupSessionScope,
    pushIntervalMs,
    traceLimit,
    hideTraceOnComplete,
    quietReply,
    allowedUsers,
    allowedUserNames,
    allowedEmails,
    allowedBots,
    allowedBotNames,
    peerBotsAllowed,
    highRiskAllowedUsers,
    highRiskAllowedUserNames,
    highRiskAllowedEmails,
    highRiskPattern,
    gateEnabled,
    softGateEnabled,
    hardGateEnabled,
    hookTrustConfirmed
  };
  if (index >= 0) configs[index] = config;
  else configs.push(config);
  return await writeConfigState(repository, raw, configs) ? configs : undefined;
}

export async function deleteLarkConfig(repository: ConfigRepository | undefined, appId: string): Promise<StoredLarkConfig[]> {
  if (!repository) throw new LarkServiceError('LARK_CONFIG_STORAGE_UNAVAILABLE', 'Lark configuration storage is unavailable', 503);
  for (let attempt = 0; attempt < 5; attempt++) {
    const { raw, configs } = await readLarkConfigState(repository);
    const next = configs.filter(config => config.appId !== appId);
    if (next.length === configs.length) throw new LarkServiceError('LARK_BOT_NOT_FOUND', `Unknown Lark bot: ${appId}`, 404);
    if (await writeConfigState(repository, raw, next)) return next;
  }
  throw new LarkServiceError('LARK_CONFIG_CONFLICT', '配置正在被并发更新，请重试删除', 409);
}
