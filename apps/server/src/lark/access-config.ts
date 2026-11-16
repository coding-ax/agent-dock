import type { ConfigRepository } from '@agent-dock/agent-dock-shared';
import { larkBotsConfigKey, readLarkConfigState, type LarkAllowedUser, type StoredLarkConfig } from './config.js';
import { LarkServiceError, type LarkCardService } from './service.js';

type Actor = 'user' | 'bot' | 'operator';
type UsersKey = 'allowedUsers' | 'allowedBots' | 'highRiskAllowedUsers';
type NamesKey = 'allowedUserNames' | 'allowedBotNames' | 'highRiskAllowedUserNames';
type PendingList = { usersKey: UsersKey; namesKey: NamesKey; names: string[] };

function pendingLists(config: StoredLarkConfig, actor: Actor): PendingList[] {
  const lists: PendingList[] = [];
  const restricted = Boolean(config.allowedUsers?.length || config.allowedEmails?.length || config.allowedUserNames?.length);
  if (actor !== 'bot' && config.allowedUserNames?.length) lists.push({ usersKey: 'allowedUsers', namesKey: 'allowedUserNames', names: config.allowedUserNames });
  // 卡片操作人尚未确认类型，先独立判断成员名单，不能被无关机器人配置阻断。
  if (actor === 'bot' && restricted && config.peerBotsAllowed === false && config.allowedBotNames?.length) lists.push({ usersKey: 'allowedBots', namesKey: 'allowedBotNames', names: config.allowedBotNames });
  if (actor === 'user' && config.gateEnabled && config.highRiskAllowedUserNames?.length) lists.push({ usersKey: 'highRiskAllowedUsers', namesKey: 'highRiskAllowedUserNames', names: config.highRiskAllowedUserNames });
  return lists;
}

function currentConfig(configs: StoredLarkConfig[], snapshot: StoredLarkConfig) {
  const current = configs.find(config => config.appId === snapshot.appId);
  if (!current || current.appSecret !== snapshot.appSecret) throw new LarkServiceError('LARK_ACCESS_CONFIG_CHANGED', '机器人配置已删除或凭证已更新，请重新发起操作', 409);
  return current;
}

export async function readLarkAccessConfig(config: StoredLarkConfig, repository?: ConfigRepository) {
  return repository ? currentConfig((await readLarkConfigState(repository)).configs, config) : config;
}

/** 首次解析必须原子持久化后才能授权；同版本的并发解析采用先写入的绑定。 */
export async function resolveLarkAccessConfig(
  config: StoredLarkConfig,
  service: Pick<LarkCardService, 'resolveChatUsersByNames'>,
  actor: Actor,
  repository?: ConfigRepository
): Promise<StoredLarkConfig> {
  let state = repository ? await readLarkConfigState(repository) : undefined;
  const initial = state ? currentConfig(state.configs, config) : config;
  const pending = pendingLists(initial, actor);
  if (!pending.length) return initial;
  if (!repository?.compareAndSet || !state) throw new LarkServiceError('LARK_BINDING_STORAGE_UNAVAILABLE', '当前存储不支持原子保存身份绑定，无法安全授权', 503);

  const bindings = new Map<UsersKey, LarkAllowedUser[]>();
  for (const list of pending) {
    const users = list.usersKey === 'allowedBots'
      ? await service.resolveChatUsersByNames(list.names, ['bot'])
      : await service.resolveChatUsersByNames(list.names);
    if (!users.length || users.some(user => !user.openId)) throw new LarkServiceError('LARK_BINDING_EMPTY', '姓名解析未返回有效身份，无法安全授权', 409);
    bindings.set(list.usersKey, users);
  }

  for (let attempt = 0; attempt < 5; attempt++) {
    const current = currentConfig(state.configs, config);
    if (current.revision !== initial.revision) throw new LarkServiceError('LARK_ACCESS_CONFIG_CHANGED', '身份解析期间配置已更新，请重新发起操作', 409);
    const resolved = { ...current };
    let changed = false;
    for (const list of pending) {
      if (!current[list.namesKey]?.length) continue; // 另一实例已经持久化，采用已固定的身份。
      if (JSON.stringify(current[list.namesKey]) !== JSON.stringify(list.names)) throw new LarkServiceError('LARK_ACCESS_CONFIG_CHANGED', '白名单已更新，请重新发起操作', 409);
      resolved[list.usersKey] = bindings.get(list.usersKey)!;
      resolved[list.namesKey] = [];
      changed = true;
    }
    if (!changed) return current;
    const configs = state.configs.map(item => item.appId === config.appId ? resolved : item);
    if (await repository.compareAndSet(larkBotsConfigKey, state.raw, JSON.stringify(configs))) return resolved;
    state = await readLarkConfigState(repository);
  }
  throw new LarkServiceError('LARK_BINDING_CONFLICT', '身份绑定正在被并发更新，请重试操作', 409);
}

type AccessLog = { warn(details: unknown, message?: string): void };

export interface OperatorAccessInput {
  config: StoredLarkConfig;
  operatorOpenId?: string;
  /** 飞书事件的 operator_type；未提供时 230001 一律 fail-closed，调用方必须显式声明身份。 */
  operatorType?: 'user' | 'bot' | 'app' | 'unknown';
  /** operatorOpenId 的实际来源字段；白名单只存 open_id。 */
  operatorIdentity?: 'open_id' | 'user_id' | 'union_id' | 'app_id';
  chatId?: string;
  service: Pick<LarkCardService, 'getUserEmails' | 'resolveChatUsersByNames'>;
  repository?: ConfigRepository;
  log?: AccessLog;
}

/**
 * 机器人操作人（卡片按钮、reaction 触发）的访问校验。
 *
 * 这是唯一的权限实现：消息入口 `LarkMessageCoordinator`、卡片回调、表情触发都必须走这里，
 * 否则「仅邮箱」「仅姓名」「peer bot」这些配置会在不同入口出现不同结论。
 */
export async function isLarkOperatorAllowed(input: OperatorAccessInput): Promise<boolean> {
  let config = input.config;
  try {
    config = await readLarkAccessConfig(config, input.repository);
  } catch (error) {
    input.log?.warn({ error, operatorOpenId: input.operatorOpenId, chatId: input.chatId }, '读取卡片操作人权限失败，按无权限处理');
    return false;
  }
  const restricted = Boolean(config.allowedUsers?.length || config.allowedEmails?.length || config.allowedUserNames?.length);
  if (!restricted) return true;
  if (!input.operatorOpenId) return false;
  // 白名单只保存 open_id / app 的 open_id。user_id/union_id 无法安全匹配，
  // 受限名单下必须 fail-closed，不能因为“看起来像 open_id”就放行。
  if (input.operatorIdentity && input.operatorIdentity !== 'open_id' && input.operatorIdentity !== 'app_id') return false;
  if (config.allowedUsers?.some(user => user.openId === input.operatorOpenId) || config.allowedBots?.some(bot => bot.openId === input.operatorOpenId)) return true;
  // 两种身份分开解析：一类名单失败不能阻断另一类已经确定的授权。
  try {
    config = await resolveLarkAccessConfig(config, input.service, 'operator', input.repository);
    if (config.allowedUsers?.some(user => user.openId === input.operatorOpenId)) return true;
  } catch (error) {
    if (error instanceof LarkServiceError && error.code === 'LARK_ACCESS_CONFIG_CHANGED') return false;
    input.log?.warn({ error, operatorOpenId: input.operatorOpenId, chatId: input.chatId }, '卡片成员姓名解析失败，继续独立判断机器人身份');
  }
  try {
    config = await resolveLarkAccessConfig(config, input.service, 'bot', input.repository);
    if (config.allowedBots?.some(bot => bot.openId === input.operatorOpenId)) return true;
  } catch (error) {
    if (error instanceof LarkServiceError && error.code === 'LARK_ACCESS_CONFIG_CHANGED') return false;
    input.log?.warn({ error, operatorOpenId: input.operatorOpenId, chatId: input.chatId }, '卡片机器人姓名解析失败，继续判断已有邮箱策略');
  }
  const allowedUsers = config.allowedUsers ?? [];
  const allowedEmails = config.allowedEmails ?? [];
  const allowedBots = config.allowedBots ?? [];
  const peerBotsAllowed = config.peerBotsAllowed !== false;
  const accessRestricted = allowedUsers.length > 0 || allowedEmails.length > 0 || Boolean(config.allowedUserNames?.length);
  if (!accessRestricted) return true;
  if (!input.operatorOpenId) return false;
  if (allowedUsers.some(user => user.openId === input.operatorOpenId)) return true;
  if (allowedBots.some(bot => bot.openId === input.operatorOpenId)) return true;
  try {
    const emails = await input.service.getUserEmails(input.operatorOpenId);
    return emails.some(email => allowedEmails.includes(email));
  } catch (error) {
    // 通讯录 API 找不到该 open_id 对应的用户（Feishu 错误码 230001）。
    // 只有明确是 bot/app 才能走 peerBotsAllowed；human/unknown 必须 fail-closed，
    // 否则“不在通讯录可见范围的人类”会被当成 peer bot 放行。
    // 调用方必须显式声明操作人类型（卡片回调固定传 'user'），这里不再有默认放行分支。
    const upstreamCode = error instanceof LarkServiceError ? Number(error.details?.upstreamCode) : undefined;
    if (upstreamCode === 230001) {
      return input.operatorType === 'bot' || input.operatorType === 'app' ? peerBotsAllowed : false;
    }
    input.log?.warn({ error, operatorOpenId: input.operatorOpenId, upstreamCode }, '获取卡片操作人邮箱失败，按无权限处理');
    return false;
  }
}
