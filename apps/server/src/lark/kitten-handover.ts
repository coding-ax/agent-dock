import { cleanChatName } from '@agent-dock/agent-dock-shared';
import { readFile } from 'node:fs/promises';
import { LarkServiceError } from './service.js';

/** 飞书要访问小猫头像时使用的 daemon 静态路由。 */
export const larkKittenAvatarPath = '/api/lark/kitten-avatar.png';

/**
 * 公网头像前缀。飞书更新应用资料时必须能拉到一个公网 URL；
 * 默认回退到机器人配置里的 `webBaseUrl`（卡片链接用的同一个公网入口）。
 * 两者都没有时不更新头像，并明确提示用户手动处理。
 */
export const larkKittenCdnBaseEnv = 'AGENTDOCK_LARK_CDN_BASE_URL';

/** 源码里是 src/lark/assets；构建后 asset 被复制到 dist/assets，与 dist/cli.js 同级。 */
const kittenAvatarFile = new URL('./assets/kitten-avatar.png', import.meta.url);

export function readKittenAvatar(): Promise<Buffer> {
  return readFile(kittenAvatarFile);
}

export interface HandoverCatLike {
  id: string;
  familyId: string;
  generation: number;
  sessionId: string;
  name: string;
  state: 'active' | 'retired' | 'released' | 'aborted';
}

export interface HandoverKittenProfile {
  isMain: true;
  name: string;
  generation: number;
  avatarUrl: string;
  catId: string;
  sessionId: string;
}

/**
 * 判断被托管的会话是不是小猫主会话，并返回「当前这一代」的资料。
 * 交接后旧会话仍是托管群的入口，所以 retired 猫要顺着同一个 family 找到在岗的新猫。
 */
export function handoverKittenProfile(
  lineage: HandoverCatLike[],
  sessionId: string,
  avatarUrl = larkKittenAvatarPath
): HandoverKittenProfile | undefined {
  const cat = lineage.find(item => item.sessionId === sessionId);
  if (!cat) return undefined;
  const active = lineage.find(item => item.familyId === cat.familyId && item.state === 'active');
  if (!active) return undefined;
  return { isMain: true, name: active.name, generation: active.generation, avatarUrl, catId: active.id, sessionId: active.sessionId };
}

/** 主会话托管时的默认群名：用当前小猫名字，不再退回 Agent 名。 */
export function handoverGroupName(input: { kitten?: { name: string } | null; title?: string; agentId?: string }): string {
  const base = input.kitten?.name?.trim() || cleanChatName(input.title) || input.agentId?.trim() || 'AgentDock';
  return `${base} · AgentDock`;
}

export function larkKittenAvatarPublicUrl(input: { cdnBaseUrl?: string; webBaseUrl?: string }): string | undefined {
  const base = (input.cdnBaseUrl?.trim() || input.webBaseUrl?.trim() || '').replace(/\/+$/, '');
  return base ? `${base}${larkKittenAvatarPath}` : undefined;
}

/** 只依赖「改应用资料」这一件事，测试里可以传假实现，不碰网络。 */
export interface KittenBotProfileWriter {
  updateAppBase(input: { name?: string; avatarUrl?: string }): Promise<unknown>;
}

export type KittenBotSyncReason =
  | 'NOT_MAIN_SESSION'
  | 'NO_ACTIVE_CAT'
  | 'BOT_UPDATE_UNSUPPORTED'
  | 'BOT_UPDATE_FAILED';

export interface KittenBotSyncResult {
  ok: boolean;
  supported: boolean;
  updated: boolean;
  name?: string;
  generation?: number;
  avatarUpdated?: boolean;
  reason?: KittenBotSyncReason;
  message: string;
}

const permissionHint = (error: unknown) => {
  if (!(error instanceof LarkServiceError)) return false;
  const upstreamCode = Number(error.details?.upstreamCode ?? NaN);
  const consoleUrl = typeof error.details?.consoleUrl === 'string' ? error.details.consoleUrl : '';
  return [99991672, 99991679, 1061004].includes(upstreamCode)
    || Boolean(consoleUrl)
    || /permission|scope|权限|未授权|only support|not support|不支持/i.test(error.message);
};

const unsupportedMessage = '飞书拒绝自动修改机器人资料（权限不足，或该机器人不是通过 AgentDock 扫码创建、不支持接口改名）。请到飞书开放平台 → 应用能力 → 机器人，手动把名称和头像改成当前小猫。';

/**
 * 把飞书应用资料同步到「当前在岗的小猫」。
 *
 * 成功与否都以结果对象返回而不是抛异常：交接本身不应该因为机器人改名失败而失败。
 * 不支持/权限不足时要把原因说清楚，让用户知道必须去飞书后台手动改。
 */
export async function syncKittenBotProfile(input: {
  lineage: HandoverCatLike[];
  sessionId: string;
  bot: KittenBotProfileWriter;
  avatarUrl?: string;
}): Promise<KittenBotSyncResult> {
  const cat = input.lineage.find(item => item.sessionId === input.sessionId);
  if (!cat) {
    return {
      ok: false, supported: false, updated: false, reason: 'NOT_MAIN_SESSION',
      message: '这个会话不是小猫主会话（没有 assistant_lineage 记录），不会自动修改飞书机器人。请在飞书开放平台后台手动设置机器人名称和头像。'
    };
  }
  const active = input.lineage.find(item => item.familyId === cat.familyId && item.state === 'active');
  if (!active) {
    return {
      ok: false, supported: false, updated: false, reason: 'NO_ACTIVE_CAT',
      message: '这个主会话当前没有在岗的小猫（可能已解除认领），无法判断要同步哪一代。请在飞书开放平台后台手动设置机器人名称和头像。'
    };
  }

  try {
    await input.bot.updateAppBase({
      name: active.name,
      ...(input.avatarUrl ? { avatarUrl: input.avatarUrl } : {})
    });
  } catch (error) {
    if (permissionHint(error)) {
      return {
        ok: false, supported: false, updated: false, name: active.name, generation: active.generation,
        reason: 'BOT_UPDATE_UNSUPPORTED', message: unsupportedMessage
      };
    }
    return {
      ok: false, supported: true, updated: false, name: active.name, generation: active.generation,
      reason: 'BOT_UPDATE_FAILED',
      message: `同步飞书机器人失败：${error instanceof Error ? error.message : String(error)}。请到飞书开放平台后台手动修改名称和头像。`
    };
  }

  const avatarUpdated = Boolean(input.avatarUrl);
  return {
    ok: true, supported: true, updated: true, name: active.name, generation: active.generation, avatarUpdated,
    message: avatarUpdated
      ? `已把飞书机器人同步为第 ${active.generation} 代「${active.name}」：名称和头像都已提交更新。飞书后台可能还需要发布版本后才会在客户端生效。`
      : `已把飞书机器人名称同步为第 ${active.generation} 代「${active.name}」。没有可用的公网头像地址，头像请在飞书后台手动替换；可设置 ${larkKittenCdnBaseEnv}（默认回退到机器人配置里的 webBaseUrl）。`
  };
}
