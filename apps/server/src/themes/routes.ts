/**
 * 自定义主题 REST API 与实时 SSE 广播路由。
 *
 * - GET    /api/themes                获取内置 + 自定义主题列表与当前激活偏好
 * - GET    /api/themes/stream         全局实时主题变更 SSE（15s 心跳，支持 CLI/多端零刷新换肤）
 * - POST   /api/themes                创建或更新自定义主题（支持 apply: true 立即生效）
 * - PATCH  /api/themes/:id            修改自定义主题名称/描述/模式/色板
 * - DELETE /api/themes/:id            删除自定义主题（自动回落默认主题）
 * - POST   /api/themes/active         切换当前主题、亮暗偏好或重置默认
 * - POST   /api/themes/generate       复用 LLM 端点按用户描述生成配色主题
 * - POST   /api/themes/import-vscode  导入 .vsix / .json / .jsonc / 本机扩展目录 / Marketplace 主题
 */
import type { FastifyInstance } from 'fastify';
import type {
  ActivateThemeInput,
  GenerateThemeInput,
  ImportVsCodeInput,
  PatchThemeInput,
  SaveThemeInput,
  ThemeService
} from './service.js';

export function registerThemeRoutes(
  app: FastifyInstance,
  service: ThemeService,
  streams: Set<import('node:http').ServerResponse>
): void {
  app.get('/api/themes', async (_request, reply) => {
    reply.header('cache-control', 'no-store');
    return service.getState();
  });

  app.get('/api/themes/stream', async (request, reply) => {
    reply.hijack();
    streams.add(reply.raw);
    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no'
    });
    reply.raw.write(': connected\n\n');

    const unsubscribe = service.subscribe(event => {
      if (request.raw.destroyed) return;
      reply.raw.write(`id: ${event.revision}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
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

  app.post<{ Body: SaveThemeInput }>('/api/themes', async (request, reply) => {
    reply.header('cache-control', 'no-store');
    const result = await service.upsertTheme(request.body ?? ({} as SaveThemeInput));
    return reply.code(201).send(result);
  });

  app.patch<{ Params: { id: string }; Body: PatchThemeInput }>('/api/themes/:id', async (request, reply) => {
    reply.header('cache-control', 'no-store');
    return service.patchTheme(request.params.id, request.body ?? {});
  });

  app.delete<{ Params: { id: string } }>('/api/themes/:id', async (request, reply) => {
    reply.header('cache-control', 'no-store');
    return service.deleteTheme(request.params.id);
  });

  app.post<{ Body: ActivateThemeInput }>('/api/themes/active', async (request, reply) => {
    reply.header('cache-control', 'no-store');
    return service.activate(request.body ?? {});
  });

  app.post<{ Body: GenerateThemeInput }>('/api/themes/generate', async (request, reply) => {
    reply.header('cache-control', 'no-store');
    return service.generateTheme(request.body ?? ({} as GenerateThemeInput));
  });

  app.post<{ Body: ImportVsCodeInput }>('/api/themes/import-vscode', async (request, reply) => {
    reply.header('cache-control', 'no-store');
    return service.importVsCode(request.body ?? {});
  });
}
