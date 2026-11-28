import type { Locale } from '@agent-dock/agent-dock-shared';
import { bi, getCurrentLocale } from './i18n';

/**
 * 「侧边会话」的种子文本。
 *
 * 侧边会话不是 fork：它是一个全新会话（独立历史/独立终端/独立任务队列）。
 * 种子只给「门牌号 + 取数方式」，不灌主会话上下文；需要时由新 agent 用 CLI
 * 自行按需拉取。主副会话还可通过 CLI 发送消息、打断和取消排队任务。
 *
 * **这段文本走会话的 systemPrompt，不走用户消息。**
 * 早先它是当作第一条用户消息发出去的，于是在时间线里是一个完整的用户气泡——用户看到
 * 一坨自己没打过的字，还得自己判断哪些是「系统说的」。而 runtime 会把 task.prompt
 * 无条件落成 user 事件（agent-runtime 的 runTask），timeline 又从 task 记录重建气泡，
 * 两条路都会显示它，藏不住。systemPrompt 是唯一真正不出现在转录里的通道
 * （→ configureAgentForSession → ACP session/new），所以改成走它。
 *
 * 措辞也跟着变了：它是给模型的指令，不是冒充用户说的话。
 */
export function buildSideSessionSeed(mainSessionId: string, locale: Locale = getCurrentLocale()): string {
  // 命令细节在 `agent-dock session -h`，这里只给门牌号和最常用的一条取数命令，避免与通用运行约束重复。
  return bi(
    [
      `你是一个侧边会话：由主会话 ${mainSessionId} 派生的独立会话，历史和任务队列不共享。`,
      '用户通常会问主会话在做什么，或要你接着主会话的活继续做。',
      `不要假设自己已经知道主会话的内容——需要时先用 \`agent-dock session show ${mainSessionId}\` 读取转录，再回答；发消息、打断等用法见 \`agent-dock session -h\`。`
    ].join('\n'),
    [
      `You are a side session: an independent session spawned from main session ${mainSessionId} with separate history and task queue.`,
      'The user may ask what the main session is doing or ask you to continue work from it.',
      `Do not assume you already know the main session's content—use \`agent-dock session show ${mainSessionId}\` to read its transcript when needed; see \`agent-dock session -h\` for messaging, interrupting, and other commands.`
    ].join('\n'),
    locale
  );
}
