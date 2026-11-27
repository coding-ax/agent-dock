import { afterEach, describe, expect, it } from 'vitest';
import { createRepositories } from './index.js';
import type { RepositoryBundle } from '@agent-dock/agent-dock-shared';

const bundles: RepositoryBundle[] = [];
function openRepo() {
  const repo = createRepositories(':memory:');
  bundles.push(repo);
  return repo;
}

afterEach(() => {
  while (bundles.length) bundles.pop()?.close();
});

describe('board storage repository', () => {
  it('persists boards, columns, items, and events across operations', () => {
    const repos = openRepo();
    const t = '2026-11-27T02:00:00.000Z';

    repos.boards.saveBoard({
      id: 'brd_1',
      name: '运行状态',
      description: '默认看板',
      icon: 'kanban',
      isDefault: true,
      viewMode: 'lanes',
      density: 'compact',
      filter: {},
      revision: 1,
      createdAt: t,
      updatedAt: t,
      archivedAt: null
    });

    repos.boards.saveColumn({
      id: 'bcol_1',
      boardId: 'brd_1',
      name: '进行中',
      color: 'blue',
      position: 'V',
      collapsed: false,
      wipLimit: 6,
      rule: { entityKinds: ['task', 'session'], taskStates: ['running'] },
      onDropAction: 'start_plan',
      createdAt: t,
      updatedAt: t
    });

    repos.boards.saveItem({
      id: 'bitem_1',
      boardId: 'brd_1',
      columnId: 'bcol_1',
      entityKind: 'task',
      entityId: 'atask_1',
      position: 'V',
      pinned: true,
      manualOverride: false,
      tags: ['看板'],
      userNote: '盯紧',
      kittenNote: '正在跑单测',
      kittenNoteAt: t,
      addedBy: 'user',
      createdAt: t,
      updatedAt: t
    });

    expect(repos.boards.getDefaultBoard()?.id).toBe('brd_1');
    expect(repos.boards.listColumns('brd_1')).toHaveLength(1);
    expect(repos.boards.listColumns('brd_1')[0]?.rule?.taskStates).toEqual(['running']);
    expect(repos.boards.findItemByEntity('brd_1', 'task', 'atask_1')?.kittenNote).toBe('正在跑单测');

    const rev = repos.boards.bumpRevision('brd_1');
    expect(rev).toBe(2);

    const evt = repos.boards.appendEvent({
      boardId: 'brd_1',
      eventType: 'board.mutated',
      actor: 'cli',
      clientMutationId: 'mut_1',
      payload: { op: 'item.added' },
      createdAt: t
    });
    expect(evt.seq).toBeGreaterThan(0);
    expect(repos.boards.listEventsSince(0, 'brd_1')).toHaveLength(1);

    expect(repos.boards.deleteBoard('brd_1')).toBe(true);
    expect(repos.boards.listColumns('brd_1')).toHaveLength(0);
    expect(repos.boards.listItems('brd_1')).toHaveLength(0);
  });

  it('enforces single default board on setDefaultBoard', () => {
    const repos = openRepo();
    const t = '2026-11-27T02:00:00.000Z';
    for (const id of ['brd_a', 'brd_b']) {
      repos.boards.saveBoard({
        id,
        name: id,
        description: '',
        isDefault: id === 'brd_a',
        viewMode: 'lanes',
        density: 'compact',
        filter: {},
        revision: 1,
        createdAt: t,
        updatedAt: t
      });
    }
    repos.boards.setDefaultBoard('brd_b');
    expect(repos.boards.getDefaultBoard()?.id).toBe('brd_b');
    expect(repos.boards.getBoard('brd_a')?.isDefault).toBe(false);
    expect(repos.boards.getBoard('brd_b')?.isDefault).toBe(true);
  });
});
