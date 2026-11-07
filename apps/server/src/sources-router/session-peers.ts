import type { Session } from '@agent-dock/agent-dock-shared';
import { RuntimeError } from '@agent-dock/agent-dock-shared';

const delegated = 'delegated';

/** Router 与它创建的 Worker 双向互通；side-chat 关系保持原有语义。 */
export function extendedSessionPeerIds(sessions: Session[], sourceId: string, basePeers: string[]): string[] {
  const source = sessions.find(session => session.id === sourceId);
  if (!source) return [...basePeers];
  const peers = new Set(basePeers);
  if (source.source === delegated && source.sourceId && source.sourceId !== sourceId
    && sessions.some(session => session.id === source.sourceId)) peers.add(source.sourceId);
  for (const session of sessions) {
    if (session.source === delegated && session.sourceId === sourceId && session.id !== sourceId) peers.add(session.id);
  }
  return [...peers];
}

/** Router 只能操作自己创建的 delegated Worker；错误信息不泄露无关 Session 内容。 */
export function assertDelegatedControl(from: Session | undefined, target: Session | undefined, peers: string[]): void {
  if (!from || !target) throw new RuntimeError('SESSION_NOT_FOUND', '会话不存在', 404);
  if (peers.includes(target.id)) return;
  const linked = (from.source === 'delegated' || target.source === 'delegated')
    && ((from.source === 'delegated' && from.sourceId === target.id)
      || (target.source === 'delegated' && target.sourceId === from.id));
  if (linked) return;
  throw new RuntimeError('SESSION_NOT_LINKED', '目标会话不在当前 Router 的委派关系内', 403);
}
