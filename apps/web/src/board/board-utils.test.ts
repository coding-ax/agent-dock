import { describe, expect, it } from 'vitest';
import type { BoardItemLiveDigest, HydratedBoard, HydratedBoardColumn, HydratedBoardItem } from '../api';
import { boardUrl, parseBoardRoute } from '../session-url';
import {
  QUICK_KITTEN_ACTIONS,
  deriveBoardKittenMood,
  describeColumnRule,
  filterBoardColumns,
  formatBoardElapsed,
  projectBasename,
  toMentionedCard
} from './board-utils';
import { nextClientMutationId, useBoardStore } from './board-store';

function makeItem(partial: Partial<HydratedBoardItem> = {}, livePartial: Partial<BoardItemLiveDigest> = {}): HydratedBoardItem {
  return {
    id: 'bitem_1',
    boardId: 'brd_1',
    columnId: 'bcol_1',
    entityKind: 'task',
    entityId: 'atask_1',
    position: 'a0',
    pinned: false,
    manualOverride: false,
    tags: [],
    userNote: null,
    kittenNote: null,
    kittenNoteAt: null,
    addedBy: 'web',
    createdAt: '2026-11-27T00:00:00.000Z',
    updatedAt: '2026-11-27T00:00:00.000Z',
    virtual: false,
    live: {
      title: '实现看板模式',
      visualState: 'running',
      agentId: 'codex',
      cwd: '/Users/codeax/workspace/agent-dock',
      activity: '编辑 BoardWorkspace.tsx',
      activeMs: 65_000,
      updatedAt: '2026-11-27T00:00:00.000Z',
      ...livePartial
    },
    ...partial
  };
}

function makeBoard(overrides: Partial<HydratedBoard['summary']> = {}, columns: HydratedBoardColumn[] = []): HydratedBoard {
  return {
    board: {
      id: 'brd_1',
      name: '运行状态',
      description: '',
      isDefault: true,
      viewMode: 'lanes',
      density: 'compact',
      filter: {},
      revision: 1,
      archivedAt: null,
      createdAt: '2026-11-27T00:00:00.000Z',
      updatedAt: '2026-11-27T00:00:00.000Z'
    },
    columns,
    summary: {
      totalItems: 3,
      running: 0,
      needsAttention: 0,
      review: 0,
      done: 0,
      ...overrides
    }
  };
}

describe('board-utils & board-store', () => {
  it('encodes and parses /boards and /boards/:boardId routes', () => {
    expect(boardUrl()).toBe('/boards');
    expect(boardUrl('brd_abc')).toBe('/boards/brd_abc');
    expect(parseBoardRoute('/boards')).toEqual({ isBoard: true });
    expect(parseBoardRoute('/boards/brd_abc')).toEqual({ isBoard: true, boardId: 'brd_abc' });
    expect(parseBoardRoute('/sessions/ses_1')).toBeNull();
  });

  it('derives responsive kitten moods for drag-to-kitten, transient reactions, and board summary', () => {
    const now = 100_000;
    expect(deriveBoardKittenMood({
      baseMood: 'idle',
      adopted: true,
      isDraggingCard: true,
      isOverKittenDock: true,
      now
    })).toBe('curious');

    expect(deriveBoardKittenMood({
      baseMood: 'idle',
      adopted: true,
      isDraggingCard: false,
      isOverKittenDock: false,
      transientMood: { mood: 'celebrating', expiresAt: now + 3_000 },
      now
    })).toBe('celebrating');

    expect(deriveBoardKittenMood({
      baseMood: 'idle',
      adopted: true,
      isDraggingCard: false,
      isOverKittenDock: false,
      hydrated: makeBoard({ needsAttention: 2 }),
      now
    })).toBe('waiting');

    expect(deriveBoardKittenMood({
      baseMood: 'idle',
      adopted: true,
      isDraggingCard: false,
      isOverKittenDock: false,
      hydrated: makeBoard({ review: 1 }),
      now
    })).toBe('reviewing');

    expect(deriveBoardKittenMood({
      baseMood: 'idle',
      adopted: true,
      isDraggingCard: false,
      isOverKittenDock: false,
      hydrated: makeBoard({ running: 3 }),
      now
    })).toBe('delegating');

    const failedCol: HydratedBoardColumn = {
      id: 'bcol_err',
      boardId: 'brd_1',
      name: '异常',
      color: 'red',
      position: 'a0',
      collapsed: false,
      onDropAction: 'none',
      createdAt: '2026-11-27T00:00:00.000Z',
      updatedAt: '2026-11-27T00:00:00.000Z',
      items: [makeItem({}, { visualState: 'failed' })]
    };
    expect(deriveBoardKittenMood({
      baseMood: 'idle',
      adopted: true,
      isDraggingCard: false,
      isOverKittenDock: false,
      hydrated: makeBoard({}, [failedCol]),
      now
    })).toBe('error');
  });

  it('filters columns by keyword, agent, visualState, tags, and kitten notes', () => {
    const col: HydratedBoardColumn = {
      id: 'bcol_1',
      boardId: 'brd_1',
      name: '进行中',
      color: 'blue',
      position: 'a0',
      wipLimit: null,
      collapsed: false,
      rule: { taskStates: ['running'] },
      onDropAction: 'none',
      createdAt: '2026-11-27T00:00:00.000Z',
      updatedAt: '2026-11-27T00:00:00.000Z',
      items: [
        makeItem(
          { id: 'bitem_1', tags: ['p0'], kittenNote: '重点盯一下动效' },
          { title: '前端看板拖拽', agentId: 'claude', visualState: 'running' }
        ),
        makeItem(
          { id: 'bitem_2', tags: ['db'] },
          { title: '后端 SQLite 迁移', agentId: 'codex', visualState: 'review' }
        )
      ]
    };

    expect(filterBoardColumns([col], { query: '动效', agentId: 'all', visualState: 'all' })[0]!.items.map(i => i.id)).toEqual(['bitem_1']);
    expect(filterBoardColumns([col], { query: '', agentId: 'codex', visualState: 'all' })[0]!.items.map(i => i.id)).toEqual(['bitem_2']);
    expect(filterBoardColumns([col], { query: '', agentId: 'all', visualState: 'review' })[0]!.items.map(i => i.id)).toEqual(['bitem_2']);
  });

  it('formats elapsed time, project basenames, rule summaries, and quick kitten prompts', () => {
    expect(formatBoardElapsed(42_000)).toBe('42s');
    expect(formatBoardElapsed(185_000)).toBe('3m05s');
    expect(formatBoardElapsed(3_900_000)).toBe('1h05m');
    expect(projectBasename('/Users/codeax/workspace/agent-dock/')).toBe('agent-dock');
    expect(describeColumnRule({ taskStates: ['running', 'review'], cwdContains: '/tmp/my-app' })).toContain('进行中便签');

    const card = toMentionedCard(makeItem({}, { title: '上线前回归' }));
    const reviewAction = QUICK_KITTEN_ACTIONS.find(a => a.key === 'review')!;
    expect(reviewAction.prompt([card])).toContain('上线前回归');
  });

  it('deduplicates dock mention cards and tracks own clientMutationIds for SSE echo suppression', () => {
    const store = useBoardStore.getState();
    store.clearDockMentionCards();
    const card = toMentionedCard(makeItem());
    store.addDockMentionCard(card);
    store.addDockMentionCard(card);
    expect(useBoardStore.getState().dockMentionCards).toHaveLength(1);

    const mid = nextClientMutationId();
    expect(useBoardStore.getState().consumeOwnMutation(mid)).toBe(true);
    expect(useBoardStore.getState().consumeOwnMutation(mid)).toBe(false);
  });
});
