import type { FastifyInstance } from 'fastify';
import type { BoardActor, BoardColumnColor, BoardColumnRule, BoardDensity, BoardDropAction, BoardEntityKind, BoardFilter, BoardTemplate, BoardViewMode } from '@agent-dock/agent-dock-shared';
import type { BoardService } from './service.js';

function actorOf(raw?: unknown): BoardActor {
  if (raw === 'cli' || raw === 'kitten' || raw === 'rule' || raw === 'system') return raw;
  return 'web';
}

export function registerBoardRoutes(
  app: FastifyInstance,
  boards: BoardService,
  streams: Set<import('node:http').ServerResponse>
): void {
  // ---- 全局多路复用看板 SSE（15s 心跳 + Last-Event-ID 断线增量补发） ----
  app.get<{ Querystring: { boardId?: string; after?: string } }>('/api/boards/stream', async (request, reply) => {
    const headerId = request.headers['last-event-id'];
    const rawAfter = request.query.after ?? (Array.isArray(headerId) ? headerId[0] : headerId);
    const afterSeq = rawAfter !== undefined && Number.isFinite(Number(rawAfter)) ? Math.max(0, Math.floor(Number(rawAfter))) : undefined;
    const filterBoardId = request.query.boardId?.trim() || undefined;

    reply.hijack();
    streams.add(reply.raw);
    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no'
    });
    reply.raw.write(': connected\n\n');

    if (afterSeq !== undefined) {
      const backlog = boards.listEventsSince(afterSeq, filterBoardId, 100);
      for (const evt of backlog) {
        if (request.raw.destroyed) break;
        reply.raw.write(`id: ${evt.seq}\nevent: ${evt.eventType}\ndata: ${JSON.stringify({ seq: evt.seq, boardId: evt.boardId, actor: evt.actor, ...(evt.clientMutationId ? { clientMutationId: evt.clientMutationId } : {}), ...evt.payload, createdAt: evt.createdAt })}\n\n`);
      }
    }

    const unsubscribe = boards.hub.subscribe(message => {
      if (request.raw.destroyed) return;
      if (filterBoardId && message.data.boardId && message.data.boardId !== filterBoardId) return;
      const idLine = message.id ? `id: ${message.id}\n` : '';
      reply.raw.write(`${idLine}event: ${message.event}\ndata: ${JSON.stringify(message.data)}\n\n`);
    });

    const heartbeat = setInterval(() => {
      if (!request.raw.destroyed) reply.raw.write(': heartbeat\n\n');
    }, 15_000);

    request.raw.once('close', () => {
      clearInterval(heartbeat);
      unsubscribe();
      streams.delete(reply.raw);
    });
  });

  // ---- 看板 CRUD ----
  app.get<{ Querystring: { includeArchived?: string } }>('/api/boards', async request => {
    const includeArchived = request.query.includeArchived === '1' || request.query.includeArchived === 'true';
    const list = boards.listBoards(includeArchived);
    const defaultBoard = list.find(b => b.isDefault) ?? list[0] ?? null;
    return { boards: list, defaultBoardId: defaultBoard?.id ?? null };
  });

  app.post<{ Body: { name?: string; description?: string; icon?: string; template?: BoardTemplate; viewMode?: BoardViewMode; density?: BoardDensity; filter?: BoardFilter; isDefault?: boolean; actor?: BoardActor; clientMutationId?: string } }>('/api/boards', async (request, reply) => {
    const body = request.body ?? {};
    const hydrated = await boards.createBoard({
      name: body.name ?? '',
      description: body.description,
      icon: body.icon,
      template: body.template,
      viewMode: body.viewMode,
      density: body.density,
      filter: body.filter,
      isDefault: body.isDefault,
      actor: actorOf(body.actor),
      clientMutationId: body.clientMutationId
    });
    return reply.code(201).send(hydrated);
  });

  app.post<{ Body: { template?: unknown; name?: string; isDefault?: boolean; actor?: BoardActor } }>('/api/boards/import', async (request, reply) => {
    const body = request.body ?? {};
    const hydrated = await boards.importBoard(body.template ?? body, {
      nameOverride: body.name,
      isDefault: body.isDefault,
      actor: actorOf(body.actor)
    });
    return reply.code(201).send(hydrated);
  });

  app.get<{ Params: { id: string } }>('/api/boards/:id', async request => {
    const id = request.params.id === 'default' ? undefined : request.params.id;
    return boards.getHydratedBoard(id);
  });

  app.patch<{ Params: { id: string }; Body: { name?: string; description?: string; icon?: string | null; viewMode?: BoardViewMode; density?: BoardDensity; filter?: BoardFilter; isDefault?: boolean; archived?: boolean; actor?: BoardActor; clientMutationId?: string } }>('/api/boards/:id', async request => {
    const body = request.body ?? {};
    const id = request.params.id === 'default' ? boards.resolveBoardId() : request.params.id;
    return boards.updateBoard(id, { ...body, actor: actorOf(body.actor) });
  });

  app.post<{ Params: { id: string }; Body: { actor?: BoardActor; clientMutationId?: string } }>('/api/boards/:id/use', async request => {
    return boards.useBoard(request.params.id, actorOf(request.body?.actor), request.body?.clientMutationId);
  });

  app.delete<{ Params: { id: string }; Querystring: { archive?: string }; Body?: { actor?: BoardActor; clientMutationId?: string } }>('/api/boards/:id', async request => {
    const archive = request.query.archive === '1' || request.query.archive === 'true';
    return boards.deleteBoard(request.params.id, {
      archive,
      actor: actorOf(request.body?.actor),
      clientMutationId: request.body?.clientMutationId
    });
  });

  app.get<{ Params: { id: string }; Querystring: { includeItems?: string } }>('/api/boards/:id/export', async request => {
    const id = request.params.id === 'default' ? undefined : request.params.id;
    const includeItems = request.query.includeItems === '1' || request.query.includeItems === 'true';
    return boards.exportBoard(id, includeItems);
  });

  app.post<{ Params: { id: string }; Body: { itemIds?: string[]; prompt?: string; actor?: BoardActor } }>('/api/boards/:id/ask-kitten', async request => {
    const id = request.params.id === 'default' ? undefined : request.params.id;
    return boards.askKitten(id, {
      itemIds: request.body?.itemIds,
      prompt: request.body?.prompt ?? '',
      actor: actorOf(request.body?.actor)
    });
  });

  // ---- 列 CRUD ----
  app.post<{ Params: { id: string }; Body: { name?: string; color?: BoardColumnColor; wipLimit?: number | null; collapsed?: boolean; rule?: BoardColumnRule | null; onDropAction?: BoardDropAction; beforeColumnId?: string; afterColumnId?: string; actor?: BoardActor; clientMutationId?: string } }>('/api/boards/:id/columns', async (request, reply) => {
    const body = request.body ?? {};
    const id = request.params.id === 'default' ? boards.resolveBoardId() : request.params.id;
    const result = await boards.addColumn(id, {
      name: body.name ?? '',
      color: body.color,
      wipLimit: body.wipLimit,
      collapsed: body.collapsed,
      rule: body.rule,
      onDropAction: body.onDropAction,
      beforeColumnId: body.beforeColumnId,
      afterColumnId: body.afterColumnId,
      actor: actorOf(body.actor),
      clientMutationId: body.clientMutationId
    });
    return reply.code(201).send(result);
  });

  app.patch<{ Params: { colId: string }; Body: { name?: string; color?: BoardColumnColor; wipLimit?: number | null; collapsed?: boolean; rule?: BoardColumnRule | null; onDropAction?: BoardDropAction; actor?: BoardActor; clientMutationId?: string } }>('/api/boards/columns/:colId', async request => {
    const body = request.body ?? {};
    return boards.updateColumn(request.params.colId, { ...body, actor: actorOf(body.actor) });
  });

  app.post<{ Params: { colId: string }; Body: { beforeColumnId?: string; afterColumnId?: string; index?: number; actor?: BoardActor; clientMutationId?: string } }>('/api/boards/columns/:colId/move', async request => {
    const body = request.body ?? {};
    return boards.moveColumn(request.params.colId, { ...body, actor: actorOf(body.actor) });
  });

  app.delete<{ Params: { colId: string }; Querystring: { moveCardsTo?: string }; Body?: { moveCardsTo?: string; actor?: BoardActor; clientMutationId?: string } }>('/api/boards/columns/:colId', async request => {
    return boards.deleteColumn(request.params.colId, {
      moveCardsTo: request.query.moveCardsTo ?? request.body?.moveCardsTo,
      actor: actorOf(request.body?.actor),
      clientMutationId: request.body?.clientMutationId
    });
  });

  // ---- 卡片 CRUD 与拖拽 ----
  app.post<{ Params: { id: string }; Body: { columnId?: string; entityKind?: BoardEntityKind; entityId?: string; title?: string; pinned?: boolean; tags?: string[]; userNote?: string; kittenNote?: string; beforeItemId?: string; afterItemId?: string; placement?: 'top' | 'bottom'; actor?: BoardActor; clientMutationId?: string } }>('/api/boards/:id/items', async (request, reply) => {
    const body = request.body ?? {};
    const id = request.params.id === 'default' ? boards.resolveBoardId() : request.params.id;
    const result = await boards.addItem(id, {
      columnId: body.columnId ?? '',
      entityKind: body.entityKind ?? 'note',
      entityId: body.entityId,
      title: body.title,
      pinned: body.pinned,
      tags: body.tags,
      userNote: body.userNote,
      kittenNote: body.kittenNote,
      beforeItemId: body.beforeItemId,
      afterItemId: body.afterItemId,
      placement: body.placement,
      actor: actorOf(body.actor),
      clientMutationId: body.clientMutationId
    });
    return reply.code(201).send(result);
  });

  app.post<{ Params: { id: string; itemId: string }; Body: { toColumnId?: string; beforeItemId?: string; afterItemId?: string; placement?: 'top' | 'bottom'; applyAction?: boolean; expectedRevision?: number; actor?: BoardActor; clientMutationId?: string } }>('/api/boards/:id/items/:itemId/move', async request => {
    const body = request.body ?? {};
    const id = request.params.id === 'default' ? boards.resolveBoardId() : request.params.id;
    return boards.moveItem(id, request.params.itemId, {
      toColumnId: body.toColumnId ?? '',
      beforeItemId: body.beforeItemId,
      afterItemId: body.afterItemId,
      placement: body.placement,
      applyAction: body.applyAction,
      expectedRevision: body.expectedRevision,
      actor: actorOf(body.actor),
      clientMutationId: body.clientMutationId
    });
  });

  app.post<{ Params: { id: string }; Body: { itemIds?: string[]; toColumnId?: string; pin?: boolean; applyAction?: boolean; actor?: BoardActor; clientMutationId?: string } }>('/api/boards/:id/items/batch', async request => {
    const body = request.body ?? {};
    const id = request.params.id === 'default' ? boards.resolveBoardId() : request.params.id;
    return boards.batchMoveItems(id, {
      itemIds: body.itemIds ?? [],
      toColumnId: body.toColumnId ?? '',
      pin: body.pin,
      applyAction: body.applyAction,
      actor: actorOf(body.actor),
      clientMutationId: body.clientMutationId
    });
  });

  app.patch<{ Params: { id: string; itemId: string }; Body: { pinned?: boolean; tags?: string[]; addTags?: string[]; removeTags?: string[]; userNote?: string | null; kittenNote?: string | null; manualOverride?: boolean; actor?: BoardActor; clientMutationId?: string } }>('/api/boards/:id/items/:itemId', async request => {
    const body = request.body ?? {};
    const id = request.params.id === 'default' ? boards.resolveBoardId() : request.params.id;
    return boards.updateItem(id, request.params.itemId, { ...body, actor: actorOf(body.actor) });
  });

  app.delete<{ Params: { id: string; itemId: string }; Body?: { actor?: BoardActor; clientMutationId?: string } }>('/api/boards/:id/items/:itemId', async request => {
    const id = request.params.id === 'default' ? boards.resolveBoardId() : request.params.id;
    return boards.removeItem(id, request.params.itemId, actorOf(request.body?.actor), request.body?.clientMutationId);
  });
}
