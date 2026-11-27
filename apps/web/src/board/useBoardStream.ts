import { useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { BoardItemLiveDigest, HydratedBoard } from '../api';
import { useBoardStore } from './board-store';

export type BoardStreamStatus = 'connecting' | 'live' | 'reconnecting';

interface BoardProgressEvent {
  items: Array<{
    sessionId: string;
    state?: BoardItemLiveDigest['sessionState'];
    activity?: string;
    activeToolName?: string;
    activeToolInput?: unknown;
    pendingPermissionTitle?: string;
    updatedAt?: string;
  }>;
}

interface BoardMutatedEvent {
  boardId?: string;
  kind?: string;
  actor?: string;
  clientMutationId?: string;
  summary?: string;
}

interface BoardTaskUpdatedEvent {
  taskId?: string;
  state?: string;
  kind?: string;
}

interface BoardKittenStateEvent {
  mood?: string;
  text?: string;
  message?: string;
}

/**
 * 看板单连接多路复用 SSE（/api/boards/stream）：
 * - card.progress：直接原地合并进 ['board', activeBoardId] 缓存，300ms 节流实时更新单行工具步与耗时，零闪屏；
 * - board.mutated：CLI / 主小猫 / 另一标签页改动看板时实时刷新，并触发主小猫「整理看板」动效与提示条；
 * - task.updated：便签验收通过时触发主小猫庆祝特效；
 * - 跳过本客户端刚刚发出的 clientMutationId 回声。
 */
export function useBoardStream(activeBoardId: string | undefined, enabled = true) {
  const qc = useQueryClient();
  const [status, setStatus] = useState<BoardStreamStatus>('connecting');
  const activeIdRef = useRef(activeBoardId);
  activeIdRef.current = activeBoardId;

  useEffect(() => {
    if (!enabled) return;
    let closed = false;
    let source: EventSource | null = null;
    let reconnectTimer: number | undefined;

    const connect = () => {
      if (closed) return;
      setStatus(prev => (prev === 'live' ? 'live' : 'connecting'));
      source = new EventSource('/api/boards/stream');

      source.addEventListener('ready', () => {
        if (!closed) setStatus('live');
      });
      source.onopen = () => {
        if (!closed) setStatus('live');
      };

      source.addEventListener('card.progress', event => {
        const boardKeyId = activeIdRef.current;
        if (!boardKeyId) return;
        try {
          const payload = JSON.parse((event as MessageEvent<string>).data) as BoardProgressEvent;
          if (!payload.items?.length) return;
          const bySession = new Map(payload.items.map(item => [item.sessionId, item]));
          qc.setQueryData<HydratedBoard>(['board', boardKeyId], current => {
            if (!current) return current;
            let touched = false;
            const columns = current.columns.map(col => {
              let colTouched = false;
              const items = col.items.map(item => {
                if (!item.live.sessionId) return item;
                const patch = bySession.get(item.live.sessionId);
                if (!patch) return item;
                colTouched = true;
                touched = true;
                const nextLive: BoardItemLiveDigest = {
                  ...item.live,
                  ...(patch.state ? { sessionState: patch.state } : {}),
                  ...(patch.activity ? { activity: patch.activity } : {}),
                  ...(patch.activeToolName !== undefined ? { activeToolName: patch.activeToolName } : {}),
                  ...(patch.activeToolInput !== undefined ? { activeToolInput: patch.activeToolInput } : {}),
                  ...(patch.pendingPermissionTitle !== undefined ? { pendingPermissionTitle: patch.pendingPermissionTitle } : {}),
                  updatedAt: patch.updatedAt || item.live.updatedAt
                };
                return {
                  ...item,
                  live: nextLive
                };
              });
              return colTouched ? { ...col, items } : col;
            });
            return touched ? { ...current, columns } : current;
          });
        } catch {
          /* ignore malformed SSE frames */
        }
      });

      source.addEventListener('board.mutated', event => {
        try {
          const payload = JSON.parse((event as MessageEvent<string>).data) as BoardMutatedEvent;
          const store = useBoardStore.getState();
          if (store.consumeOwnMutation(payload.clientMutationId)) return;
          void qc.invalidateQueries({ queryKey: ['boards'] });
          const curId = activeIdRef.current;
          if (curId) void qc.invalidateQueries({ queryKey: ['board', curId] });
          if (payload.boardId && payload.boardId !== curId) {
            void qc.invalidateQueries({ queryKey: ['board', payload.boardId] });
          }
          if (payload.actor === 'kitten') {
            store.flashKitten('tidying', payload.summary || '小猫刚整理了看板', 4_000);
            store.showTidyBanner(payload.summary || '主小猫刚刚调整了看板布局');
          } else if (payload.actor === 'cli') {
            store.flashKitten('tidying', 'CLI 同步了看板改动', 3_200);
            store.showTidyBanner(payload.summary || '已同步 CLI 看板更新');
          }
        } catch {
          /* ignore */
        }
      });

      source.addEventListener('task.updated', event => {
        try {
          const payload = JSON.parse((event as MessageEvent<string>).data) as BoardTaskUpdatedEvent;
          const curId = activeIdRef.current;
          if (curId) void qc.invalidateQueries({ queryKey: ['board', curId] });
          void qc.invalidateQueries({ queryKey: ['boards'] });
          void qc.invalidateQueries({ queryKey: ['assistant-state'] });
          if (payload.state === 'closed') {
            useBoardStore.getState().triggerCelebrate('任务已验收完成！');
          }
        } catch {
          /* ignore */
        }
      });

      source.addEventListener('kitten.state', event => {
        try {
          const payload = JSON.parse((event as MessageEvent<string>).data) as BoardKittenStateEvent;
          if (payload.mood) {
            useBoardStore.getState().flashKitten(payload.mood as never, payload.text ?? payload.message, 3_600);
          }
        } catch {
          /* ignore */
        }
      });

      source.onerror = () => {
        if (closed) return;
        setStatus('reconnecting');
        source?.close();
        source = null;
        window.clearTimeout(reconnectTimer);
        reconnectTimer = window.setTimeout(connect, 2_200);
      };
    };

    connect();
    return () => {
      closed = true;
      window.clearTimeout(reconnectTimer);
      source?.close();
    };
  }, [enabled, qc]);

  return status;
}
