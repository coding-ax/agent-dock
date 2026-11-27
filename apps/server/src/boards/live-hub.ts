import { EventEmitter } from 'node:events';
import type { AgentDockRuntime } from '@agent-dock/agent-dock-runtime';
import type { BoardEventRecord, RuntimeActivityEvent, SessionState } from '@agent-dock/agent-dock-shared';
import { summarizeToolActivity } from './rules.js';

export interface SessionActivitySnapshot {
  sessionId: string;
  state?: SessionState;
  activity?: string;
  activeToolName?: string;
  activeToolInput?: unknown;
  pendingPermissionTitle?: string;
  updatedAt: string;
}

export interface BoardSseMessage {
  id?: string;
  event: 'board.mutated' | 'card.progress' | 'task.updated' | 'kitten.state';
  data: Record<string, unknown>;
}

/**
 * 看板多路复用实时枢纽（BoardLiveHub）。
 *
 * 1. 监听 AgentDockRuntime 的轻量状态/活动/轮次事件，在内存中维护极小的每会话活动摘要；
 * 2. 对高频 `card.progress` 按 300ms 批量合帧推送，前端单条 `/api/boards/stream` 即可毫秒级盯 15+ 任务，
 *    避免为每张卡片各自开启 SSE 撞上浏览器 6 连接限制；
 * 3. 转发看板 CRUD 变更（Web 拖拽 / CLI / 主小猫编排）与小猫状态通知。
 */
export class BoardLiveHub {
  private readonly emitter = new EventEmitter();
  private readonly snapshots = new Map<string, SessionActivitySnapshot>();
  private readonly dirtyProgress = new Map<string, SessionActivitySnapshot>();
  private progressTimer?: NodeJS.Timeout;
  private unsubActivity?: () => void;
  private unsubStatus?: () => void;
  private unsubTurn?: () => void;
  private closed = false;

  constructor(private readonly runtime: AgentDockRuntime, private readonly throttleMs = 300) {
    this.emitter.setMaxListeners(100);
  }

  start(): void {
    if (this.unsubStatus) return;

    this.unsubActivity = this.runtime.onActivity(event => {
      this.handleActivity(event);
    });

    this.unsubStatus = this.runtime.onStatus(event => {
      const current = this.snapshots.get(event.sessionId);
      const next: SessionActivitySnapshot = {
        sessionId: event.sessionId,
        state: event.state,
        updatedAt: new Date().toISOString(),
        ...(event.state === 'running_tool' && current?.activity ? { activity: current.activity, activeToolName: current.activeToolName, activeToolInput: current.activeToolInput } : {}),
        ...(event.state === 'waiting_for_permission' && current?.pendingPermissionTitle ? { pendingPermissionTitle: current.pendingPermissionTitle, activity: `等待授权：${current.pendingPermissionTitle}` } : {}),
        ...(event.state === 'failed' && event.error ? { activity: `异常：${event.error.slice(0, 80)}` } : {})
      };
      this.snapshots.set(event.sessionId, next);
      this.scheduleProgress(next);
    });

    this.unsubTurn = this.runtime.onTurnEvent(event => {
      const activity = event.kind === 'completed'
        ? (event.summary?.trim() ? event.summary.trim().slice(0, 90) : '本轮已完成')
        : event.kind === 'waiting_approval'
          ? `等待授权：${event.summary?.trim() || '权限确认'}`
          : event.kind === 'failed'
            ? `异常：${(event.error ?? event.summary ?? '执行失败').slice(0, 80)}`
            : (event.interruptIntent === 'user' ? '用户已停止' : '轮次已中断');
      const next: SessionActivitySnapshot = {
        sessionId: event.sessionId,
        activity,
        ...(event.kind === 'waiting_approval' && event.summary ? { pendingPermissionTitle: event.summary } : {}),
        updatedAt: event.timestamp
      };
      this.snapshots.set(event.sessionId, next);
      this.scheduleProgress(next);
      this.broadcast({
        event: 'task.updated',
        data: { sessionId: event.sessionId, kind: event.kind, timestamp: event.timestamp }
      });
    });
  }

  close(): void {
    this.closed = true;
    this.unsubActivity?.();
    this.unsubStatus?.();
    this.unsubTurn?.();
    this.unsubActivity = undefined;
    this.unsubStatus = undefined;
    this.unsubTurn = undefined;
    if (this.progressTimer) {
      clearTimeout(this.progressTimer);
      this.progressTimer = undefined;
    }
    this.dirtyProgress.clear();
    this.emitter.removeAllListeners();
  }

  getSnapshot(sessionId: string): SessionActivitySnapshot | undefined {
    return this.snapshots.get(sessionId);
  }

  subscribe(listener: (message: BoardSseMessage) => void): () => void {
    this.emitter.on('sse', listener);
    return () => this.emitter.off('sse', listener);
  }

  broadcast(message: BoardSseMessage): void {
    if (this.closed) return;
    this.emitter.emit('sse', message);
  }

  emitBoardEvent(record: BoardEventRecord): void {
    this.broadcast({
      id: String(record.seq),
      event: record.eventType,
      data: {
        seq: record.seq,
        boardId: record.boardId,
        actor: record.actor,
        ...(record.clientMutationId ? { clientMutationId: record.clientMutationId } : {}),
        ...record.payload,
        createdAt: record.createdAt
      }
    });
  }

  emitKittenState(payload: { boardId?: string; mood?: string; text: string; cardIds?: string[] }): void {
    this.broadcast({
      event: 'kitten.state',
      data: {
        ...payload,
        timestamp: new Date().toISOString()
      }
    });
  }

  private handleActivity(event: RuntimeActivityEvent): void {
    const prev = this.snapshots.get(event.sessionId);
    let activity = prev?.activity;
    let activeToolName = prev?.activeToolName;
    let activeToolInput = prev?.activeToolInput;
    let pendingPermissionTitle = prev?.pendingPermissionTitle;

    if (event.kind === 'tool_call') {
      activeToolName = event.toolName;
      activeToolInput = event.toolInput;
      activity = summarizeToolActivity(event.toolName, event.toolInput) ?? '正在调用工具…';
      pendingPermissionTitle = undefined;
    } else if (event.kind === 'tool_result') {
      if (event.toolStatus === 'failed') {
        activity = `${summarizeToolActivity(event.toolName, event.toolInput) ?? '工具调用'} 失败`;
      } else {
        activity = `已完成 ${summarizeToolActivity(event.toolName, event.toolInput) ?? '工具步骤'}`;
      }
      activeToolName = undefined;
      activeToolInput = undefined;
    } else if (event.kind === 'permission_request') {
      pendingPermissionTitle = event.permissionTitle ?? '权限确认';
      activity = `等待授权：${pendingPermissionTitle}`;
    } else if (event.kind === 'thinking') {
      if (!activeToolName) activity = '正在思考推演…';
    } else if (event.kind === 'text' && event.textPreview) {
      if (!activeToolName && !pendingPermissionTitle) {
        const clean = event.textPreview.replace(/\s+/g, ' ').trim();
        if (clean) activity = clean.length > 76 ? `${clean.slice(0, 75)}…` : clean;
      }
    }

    const next: SessionActivitySnapshot = {
      sessionId: event.sessionId,
      state: event.state ?? prev?.state,
      ...(activity ? { activity } : {}),
      ...(activeToolName ? { activeToolName } : {}),
      ...(activeToolInput !== undefined ? { activeToolInput } : {}),
      ...(pendingPermissionTitle ? { pendingPermissionTitle } : {}),
      updatedAt: event.timestamp
    };
    this.snapshots.set(event.sessionId, next);
    this.scheduleProgress(next);
  }

  private scheduleProgress(snapshot: SessionActivitySnapshot): void {
    if (this.closed || this.emitter.listenerCount('sse') === 0) return;
    this.dirtyProgress.set(snapshot.sessionId, snapshot);
    if (this.progressTimer) return;
    this.progressTimer = setTimeout(() => {
      this.progressTimer = undefined;
      if (!this.dirtyProgress.size) return;
      const items = [...this.dirtyProgress.values()];
      this.dirtyProgress.clear();
      this.broadcast({
        event: 'card.progress',
        data: { items, timestamp: new Date().toISOString() }
      });
    }, this.throttleMs);
    this.progressTimer.unref();
  }
}
