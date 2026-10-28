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
