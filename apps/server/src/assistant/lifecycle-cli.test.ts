import { describe, expect, it, vi } from 'vitest';
import { createCliProgram } from '../cli-program.js';
import { formatConfig, formatHandoff, formatLineage, formatMaintenanceStatus } from './lifecycle-cli.js';
import { DEFAULT_LIFECYCLE_CONFIG } from './lifecycle.js';

describe('lifecycle CLI', () => {
  it('routes main handoff, maintenance and notes commands with their options', async () => {
    const handlers = {
      mainHandoff: vi.fn(), mainHandoffShow: vi.fn(), mainHandoffCancel: vi.fn(), mainHandoffResend: vi.fn(), mainLineage: vi.fn(),
      maintenanceStatus: vi.fn(), maintenanceRun: vi.fn(), maintenanceConfig: vi.fn(),
      notesList: vi.fn(), notesArchive: vi.fn(), notesUnarchive: vi.fn()
    };
    const run = (args: string[]) => createCliProgram('0.0.0', handlers).parseAsync(['node', 'agent-dock', ...args]);

    await run(['main', 'handoff', '--yes', '--name', '豆豆', '--reason', '太满了']);
    expect(handlers.mainHandoff).toHaveBeenLastCalledWith(expect.objectContaining({ yes: true, name: '豆豆', reason: '太满了' }));
    await run(['main', 'handoff']);
    expect(handlers.mainHandoff.mock.lastCall?.[0].yes).toBeUndefined();
    await run(['main', 'handoff', 'show', 'ahand_1', '--json']);
    expect(handlers.mainHandoffShow).toHaveBeenLastCalledWith('ahand_1', expect.objectContaining({ json: true }));
    await run(['main', 'handoff', 'cancel']);
    expect(handlers.mainHandoffCancel).toHaveBeenLastCalledWith(undefined, expect.any(Object));
    await run(['main', 'handoff', 'resend', 'ahand_2']);
    expect(handlers.mainHandoffResend).toHaveBeenLastCalledWith('ahand_2', expect.any(Object));
    await run(['main', 'lineage']);
    expect(handlers.mainLineage).toHaveBeenCalled();

    await run(['maintenance', 'run', '--reason', '收拾']);
    expect(handlers.maintenanceRun).toHaveBeenLastCalledWith(expect.objectContaining({ reason: '收拾' }));
    await run(['maintenance', 'config', '--no-auto', '--set', 'rounds.tidy=300', '--set', 'uptimeDays.handoff=off', '--fold-after-hours', '6']);
    expect(handlers.maintenanceConfig).toHaveBeenLastCalledWith(expect.objectContaining({ auto: false, set: ['rounds.tidy=300', 'uptimeDays.handoff=off'], foldAfterHours: '6' }));
    await run(['maintenance', 'config']);
    expect(handlers.maintenanceConfig.mock.lastCall?.[0]).toMatchObject({ set: [] });
    expect(handlers.maintenanceConfig.mock.lastCall?.[0].auto).toBeUndefined();

    await run(['notes', 'list', '--archived']);
    expect(handlers.notesList).toHaveBeenLastCalledWith(expect.objectContaining({ archived: true }));
    await run(['notes', 'archive', '--task', 'atask_1', '--task', 'atask_2', '--reason', '收起']);
    expect(handlers.notesArchive).toHaveBeenLastCalledWith(expect.objectContaining({ task: ['atask_1', 'atask_2'], reason: '收起' }));
    await run(['notes', 'unarchive', '--batch', 'aarch_1']);
    expect(handlers.notesUnarchive).toHaveBeenLastCalledWith(expect.objectContaining({ batch: 'aarch_1' }));
  });

  it('prints handoff progress, transfers and how to undo the fold', () => {
    const text = formatHandoff({
      id: 'ahand_1', state: 'done', outcome: 'needs_confirmation', trigger: 'threshold', reason: null,
      reasons: [{ metric: 'contextPercent', level: 'handoff', value: 92, threshold: 90 }],
      fromSessionId: 'ses_old', toSessionId: 'ses_new', successorName: '豆豆', archiveBatchId: 'aarch_1', error: null,
      fromCat: { generation: 1, name: '团子' }, toCat: { generation: 2, name: '豆豆' },
      steps: [{ step: 'packing', ok: true, detail: '交接包：1 件事项' }, { step: 'briefing', ok: true }],
      transfers: [{ kind: 'draft', itemId: 'adraft_1', title: 'GitHub 评论 → o/r#1', status: 'needs_confirmation', detail: '草稿仍需你确认才会发送' }]
    });
    expect(text).toContain('交接 ahand_1  [已完成 · 需要你确认]');
    expect(text).toContain('越线：上下文用量 92%/90%');
    expect(text).toContain('前任：第 1 代团子  ses_old（已归档，只读）');
    expect(text).toContain('继任：第 2 代豆豆  ses_new');
    expect(text).toContain('✓ 打包交接包 · 交接包：1 件事项');
    expect(text).toContain('[待你确认] 草稿 GitHub 评论 → o/r#1（adraft_1）');
    expect(text).toContain('notes unarchive --batch aarch_1');
    expect(formatHandoff({ id: 'ahand_2', state: 'proposed', trigger: 'agent', fromSessionId: 'ses_old', steps: [], transfers: [] }))
      .toContain('agent-dock main handoff --yes');
  });

  it('prints lineage, metrics against thresholds and the editable keys', () => {
    expect(formatLineage([])).toContain('还没有血缘记录');
    const lineage = formatLineage([
      { generation: 1, name: '团子', state: 'retired', lifeStage: 'elder', sessionId: 'ses_old', adoptedAt: '2026-11-01T08:00:00.000Z', retiredAt: '2026-11-12T08:00:00.000Z', rounds: 640 },
      { generation: 2, name: '豆豆', state: 'active', lifeStage: 'kitten', sessionId: 'ses_new', adoptedAt: '2026-11-12T08:00:00.000Z', rounds: 0 }
    ]);
    expect(lineage).toContain('第 1 代  团子  [已退休 · 老年]  ses_old');
    expect(lineage).toContain('第 2 代  豆豆  [在岗 · 幼猫]  ses_new');
    const status = formatMaintenanceStatus({
      level: 'tidy', reasons: [{ metric: 'closedNotes', level: 'tidy', value: 45, threshold: 40 }],
      metrics: { rounds: 12, events: 300, closedNotes: 45, openNotes: 2, archivedNotes: 0, uptimeDays: 1.26 },
      levels: { closedNotes: 'tidy' }, config: DEFAULT_LIFECYCLE_CONFIG, runs: []
    });
    expect(status).toContain('总体档位：该整理（已完成便签 45/40）');
    expect(status).toMatch(/已完成便签\s+45\s+40\s+—\s+该整理/);
    expect(status).toMatch(/上下文用量\s+—\s+75%\s+90%/);
    expect(status).toContain('还没有整理过。');
    expect(formatConfig(DEFAULT_LIFECYCLE_CONFIG as unknown as Record<string, unknown>)).toMatch(/连续运行天数\s+14 天\s+45 天\s+uptimeDays/);
  });
});
