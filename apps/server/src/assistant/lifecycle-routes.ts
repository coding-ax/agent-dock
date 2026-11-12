import type { FastifyInstance } from 'fastify';
import { RuntimeError } from '@agent-dock/agent-dock-shared';
import type { AssistantService } from './service.js';
import type { LifecycleConfigPatch } from './lifecycle.js';

const bad = (message: string) => new RuntimeError('INVALID_ASSISTANT_INPUT', message, 400);

/** 主会话或用户本人（网页 / 不带 from 的终端）；侧边会话一律 403。 */
function assertMainOrUser(assistant: AssistantService, from?: string) {
  if (from && from !== assistant.mainSessionId) throw new RuntimeError('FORBIDDEN', '只有主会话或用户本人能执行这个操作', 403);
}

/** 交接确认必须是用户本人：Agent 环境里的调用都带 from，只能提议，不能替用户点头。 */
function assertUser(from: string | undefined, action: string) {
  if (from) throw new RuntimeError('FORBIDDEN', `${action}需要用户本人在网页或终端确认；Agent 只能用 agent-dock main handoff 提议`, 403);
}

const optionalText = (value: unknown) => typeof value === 'string' && value.trim() ? value.trim() : undefined;
const optionalNumber = (value: unknown, field: string) => {
  if (value === undefined || value === null || value === '') return undefined;
  const number = Number(value);
  if (!Number.isFinite(number)) throw bad(`${field} 必须是数字`);
  return number;
};
const stringList = (value: unknown) => Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string' && Boolean(item.trim())).map(item => item.trim()) : undefined;

/**
 * 小猫的一生：交接仪式、整理轮次、归档区、血缘。
 * 设计见 docs/2026-11-12-companion-lifecycle-handoff-design.md。
 */
export function registerLifecycleRoutes(app: FastifyInstance, assistant: AssistantService) {
  const lifecycle = assistant.lifecycle;

  app.get('/api/assistant/lifecycle', async () => lifecycle.overview());

  app.get('/api/assistant/lineage', async () => ({ lineage: lifecycle.lineage() }));

  // ---- 交接仪式

  app.get('/api/assistant/handoffs', async () => ({ handoffs: lifecycle.listHandoffs() }));

  app.get<{ Params: { id: string } }>('/api/assistant/handoff/:id', async request => ({ handoff: lifecycle.getHandoff(request.params.id) }));

  app.post<{ Body: { reason?: string; name?: string; from?: string } }>('/api/assistant/handoff', async request => {
    const body = request.body ?? {};
    assertMainOrUser(assistant, body.from);
    const reason = optionalText(body.reason);
    const name = optionalText(body.name);
    const record = await lifecycle.proposeHandoff({ trigger: body.from ? 'agent' : 'user', ...(reason ? { reason } : {}), ...(name ? { name } : {}) });
    return { handoff: lifecycle.getHandoff(record.id) };
  });

  app.post<{ Params: { id: string }; Body: { name?: string; from?: string } }>('/api/assistant/handoff/:id/confirm', async request => {
    assertUser(request.body?.from, '交接');
    const name = optionalText(request.body?.name);
    return { handoff: await lifecycle.confirmHandoff(request.params.id, name ? { name } : {}) };
  });

  app.post<{ Params: { id: string }; Body: { from?: string } }>('/api/assistant/handoff/:id/cancel', async request => {
    assertMainOrUser(assistant, request.body?.from);
    return { handoff: lifecycle.cancelHandoff(request.params.id) };
  });

  app.post<{ Params: { id: string }; Body: { from?: string } }>('/api/assistant/handoff/:id/resend', async request => {
    assertMainOrUser(assistant, request.body?.from);
    return { handoff: await lifecycle.resendBriefing(request.params.id) };
  });

  // ---- 整理轮次

  app.get('/api/assistant/maintenance', async () => {
    const overview = await lifecycle.overview();
    return {
      metrics: overview.metrics, levels: overview.levels, level: overview.level, reasons: overview.reasons,
      config: overview.config, alerts: overview.alerts, policy: overview.policy,
      active: overview.maintenance, runs: overview.maintenanceRuns
    };
  });

  app.post<{ Body: { reason?: string; from?: string } }>('/api/assistant/maintenance/run', async request => {
    assertMainOrUser(assistant, request.body?.from);
    const reason = optionalText(request.body?.reason);
    return { run: await lifecycle.runMaintenance({ trigger: 'manual', ...(reason ? { reason } : {}), ...(request.body?.from ? { from: request.body.from } : {}) }) };
  });

  app.put<{ Body: LifecycleConfigPatch & { from?: string } }>('/api/assistant/maintenance/config', async request => {
    const body = request.body ?? {};
    assertMainOrUser(assistant, body.from);
    const patch: LifecycleConfigPatch = {
      ...(typeof body.autoMaintenance === 'boolean' ? { autoMaintenance: body.autoMaintenance } : {}),
      ...(typeof body.autoProposeHandoff === 'boolean' ? { autoProposeHandoff: body.autoProposeHandoff } : {}),
      ...(body.foldClosedAfterHours !== undefined ? { foldClosedAfterHours: optionalNumber(body.foldClosedAfterHours, 'foldClosedAfterHours')! } : {}),
      ...(body.maxAutoRunsPerDay !== undefined ? { maxAutoRunsPerDay: optionalNumber(body.maxAutoRunsPerDay, 'maxAutoRunsPerDay')! } : {}),
      ...(body.set && typeof body.set === 'object' ? { set: body.set } : {})
    };
    if (!Object.keys(patch).length) throw bad('没有要修改的配置');
    return { config: lifecycle.updateConfig(patch) };
  });

  // ---- 归档区

  app.get('/api/assistant/notes/archive', async () => lifecycle.archiveView());

  app.post<{ Body: { taskIds?: string[]; closedBeforeHours?: number; reason?: string; from?: string } }>('/api/assistant/notes/archive', async request => {
    const body = request.body ?? {};
    assertMainOrUser(assistant, body.from);
    const taskIds = stringList(body.taskIds);
    const closedBeforeHours = optionalNumber(body.closedBeforeHours, 'closedBeforeHours');
    if (closedBeforeHours !== undefined && closedBeforeHours < 0) throw bad('closedBeforeHours 不能小于 0');
    const reason = optionalText(body.reason);
    const batch = lifecycle.archiveNotes({
      source: 'manual',
      ...(taskIds?.length ? { taskIds } : {}),
      ...(closedBeforeHours !== undefined ? { closedBeforeHours } : {}),
      ...(reason ? { reason } : {})
    });
    return { batch: batch ?? null, archived: batch?.taskIds.length ?? 0 };
  });

  app.post<{ Body: { batchId?: string; taskIds?: string[]; from?: string } }>('/api/assistant/notes/unarchive', async request => {
    const body = request.body ?? {};
    assertMainOrUser(assistant, body.from);
    const taskIds = stringList(body.taskIds);
    const batchId = optionalText(body.batchId);
    return lifecycle.unarchiveNotes({ ...(batchId ? { batchId } : {}), ...(taskIds?.length ? { taskIds } : {}) });
  });
}
