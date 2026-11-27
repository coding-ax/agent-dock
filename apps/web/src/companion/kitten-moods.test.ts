import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AssistantTask } from '../api';
import { Kitten } from './Kitten';
import {
  FALLBACK_KITTEN_SPRITE,
  KITTEN_MOODS,
  KITTEN_MOOD_META,
  KITTEN_SPRITE_KEYS,
  MIN_MOOD_HOLD_MS,
  deriveKittenMood,
  isLateNightHour,
  kittenMoodMeta,
  kittenSpriteKey,
  kittenSpritePng,
  kittenSpriteWebp,
  sleepyThresholdMs,
  stabilizeKittenMood,
  type KittenMood,
} from './kitten-moods';

const here = dirname(fileURLToPath(import.meta.url));
const companionPublicDir = join(here, '..', '..', 'public', 'companion');

const task = (patch: Partial<AssistantTask> & { id: string }): AssistantTask => ({
  title: patch.id,
  notes: '',
  doneWhen: ['给出证据'],
  state: 'running',
  round: 0,
  plan: false,
  createdAt: '2026-11-27T01:00:00.000Z',
  updatedAt: '2026-11-27T01:00:00.000Z',
  ...patch,
});

describe('Companion 小猫多状态资源与渲染完整性', () => {
  it('每张精灵资源均同时存在合法的静态 PNG 与动效 WebP，且体积合理', () => {
    for (const key of KITTEN_SPRITE_KEYS) {
      const pngPath = join(companionPublicDir, `cat-${key}.png`);
      const webpPath = join(companionPublicDir, `cat-${key}.webp`);
      expect(existsSync(pngPath), `缺少 PNG: ${pngPath}`).toBe(true);
      expect(existsSync(webpPath), `缺少 WebP: ${webpPath}`).toBe(true);

      const pngBytes = readFileSync(pngPath);
      const webpBytes = readFileSync(webpPath);
      // PNG magic: 89 50 4E 47
      expect(pngBytes.subarray(0, 4).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47]))).toBe(true);
      // RIFF....WEBP
      expect(webpBytes.subarray(0, 4).toString('ascii')).toBe('RIFF');
      expect(webpBytes.subarray(8, 12).toString('ascii')).toBe('WEBP');
      // 保持轻量，避免前端首次加载卡顿
      expect(statSync(pngPath).size).toBeLessThan(80 * 1024);
      expect(statSync(webpPath).size).toBeLessThan(80 * 1024);
    }
  });

  it('所有 KittenMood 均有完整元数据，并能正确渲染到 Kitten 组件与 WebP/PNG 降级链', () => {
    for (const mood of KITTEN_MOODS) {
      const meta = KITTEN_MOOD_META[mood];
      expect(meta.label.length).toBeGreaterThan(0);
      expect(meta.hint.length).toBeGreaterThan(0);
      expect(KITTEN_SPRITE_KEYS).toContain(meta.sprite);

      const html = renderToStaticMarkup(createElement(Kitten, { mood, variant: 'full', size: 88, label: `小猫：${meta.label}` }));
      expect(html).toContain(`data-mood="${mood}"`);
      expect(html).toContain(`data-sprite="${meta.sprite}"`);
      expect(html).toContain(`srcSet="/companion/cat-${meta.sprite}.webp"`);
      expect(html).toContain(`src="/companion/cat-${meta.sprite}.png"`);
    }
  });

  it('未知 mood 与 sparkling 均能安全降级与切换', () => {
    const unknown = 'future_unknown_mood' as KittenMood;
    expect(kittenSpriteKey(unknown)).toBe('idle');
    expect(kittenSpritePng(unknown)).toBe(FALLBACK_KITTEN_SPRITE);
    expect(kittenSpriteWebp(unknown)).toBe('/companion/cat-idle.webp');
    expect(kittenMoodMeta(unknown)).toEqual(KITTEN_MOOD_META.idle);
    expect(kittenSpriteKey('thinking', true)).toBe('sparkle');
    expect(kittenSpritePng('thinking', true)).toBe('/companion/cat-sparkle.png');
  });

  it('companion.css 与 lifecycle.css 对新增状态定义柔和节奏且遵循 reduced-motion', () => {
    const companionCss = readFileSync(join(here, 'companion.css'), 'utf8');
    const lifecycleCss = readFileSync(join(here, 'lifecycle.css'), 'utf8');
    for (const mood of ['thinking', 'delegating', 'reviewing', 'waiting', 'celebrating', 'error', 'tidying', 'night', 'sad']) {
      expect(companionCss).toContain(`data-mood="${mood}"`);
    }
    expect(companionCss).toContain('ui-cat-sprite-swap');
    expect(lifecycleCss).toContain(':not([data-mood="night"])');
  });
});

describe('Companion 小猫状态推导优先级与生命周期兼容', () => {
  const base = { tasks: [] as AssistantTask[], lastActiveAt: 0, now: 1_000 };

  it('按优先级裁决冲突信号：授权 > 异常 > 需要你 > 近期庆祝 > 思考/执行 > 整理 > 后台便签 > 休眠/深夜', () => {
    // 未认领优先
    expect(deriveKittenMood({ ...base })).toBe('curious');
    // 主会话已归档优先于一切运行态/便签
    expect(deriveKittenMood({ ...base, mainState: 'idle', archived: true, tasks: [task({ id: 'n', state: 'needs_user' })] })).toBe('sad');
    // 权限等待高于主会话失败与任务异常
    expect(deriveKittenMood({
      ...base,
      mainState: 'waiting_for_permission',
      mainError: 'boom',
      tasks: [task({ id: 'nf', state: 'needs_user', lastStopReason: 'failed' })],
    })).toBe('waiting');
    // 报错高于近期庆祝与普通 needs_user
    expect(deriveKittenMood({
      ...base,
      mainState: 'idle',
      mainError: 'ACP exited',
      recent: { kind: 'accepted', at: 800 },
      tasks: [task({ id: 'n', state: 'needs_user' })],
    })).toBe('error');
    // 侧边任务超时/失败触发 error 而非普通 waiting
    expect(deriveKittenMood({
      ...base,
      mainState: 'idle',
      tasks: [task({ id: 't1', state: 'needs_user', lastStopReason: 'timeout' })],
    })).toBe('error');
    // 普通 needs_user 高于近期庆祝
    expect(deriveKittenMood({
      ...base,
      mainState: 'idle',
      recent: { kind: 'accepted', at: 800 },
      tasks: [task({ id: 'n', state: 'needs_user', lastStopReason: 'user_stopped' })],
    })).toBe('waiting');
    // 近期派活/复工/验收/交接里程碑
    expect(deriveKittenMood({ ...base, mainState: 'idle', recent: { kind: 'dispatched', at: 500 } })).toBe('delegating');
    expect(deriveKittenMood({ ...base, mainState: 'idle', recent: { kind: 'review', at: 500 } })).toBe('reviewing');
    expect(deriveKittenMood({ ...base, mainState: 'idle', recent: { kind: 'rework', at: 500 } })).toBe('thinking');
    expect(deriveKittenMood({ ...base, mainState: 'idle', recent: { kind: 'maintenance_finished', at: 500 } })).toBe('celebrating');
    expect(deriveKittenMood({ ...base, mainState: 'idle', recent: { kind: 'handoff_done', at: 500 } })).toBe('celebrating');
    expect(deriveKittenMood({ ...base, mainState: 'idle', recent: { kind: 'handoff_rolled_back', at: 500 } })).toBe('sad');
    // 回归守卫：useMoodClock 尚未跨边界刷新时 recent.at > now，近期庆祝/开心仍须立刻生效
    expect(deriveKittenMood({ ...base, mainState: 'idle', now: 1_000, recent: { kind: 'accepted', at: 9_500 } })).toBe('celebrating');
    expect(deriveKittenMood({ ...base, mainState: 'idle', now: 1_000, recent: { kind: 'cheer', at: 9_500 } })).toBe('happy');
    // 活跃主会话高于整理轮次
    expect(deriveKittenMood({ ...base, mainState: 'thinking', maintenanceRunning: true })).toBe('thinking');
    expect(deriveKittenMood({ ...base, mainState: 'running_tool', maintenanceRunning: true })).toBe('busy');
    expect(deriveKittenMood({ ...base, mainState: 'idle', maintenanceRunning: true })).toBe('tidying');
    // 后台便签态势：待验收 > 多任务并行 > 单任务盯梢 > 计划/草稿等待
    expect(deriveKittenMood({
      ...base,
      mainState: 'idle',
      tasks: [task({ id: 'r1' }), task({ id: 'r2' }), task({ id: 'v1', state: 'review' })],
    })).toBe('reviewing');
    expect(deriveKittenMood({
      ...base,
      mainState: 'idle',
      tasks: [task({ id: 'r1' }), task({ id: 'r2' })],
    })).toBe('delegating');
    expect(deriveKittenMood({
      ...base,
      mainState: 'idle',
      pendingDrafts: 1,
    })).toBe('waiting');
  });

  it('兼容小猫生命阶段（幼猫/成年/资深/老年）的打盹阈值与深夜陪伴态', () => {
    expect(sleepyThresholdMs('kitten')).toBeGreaterThan(sleepyThresholdMs('adult'));
    expect(sleepyThresholdMs('senior')).toBeLessThan(sleepyThresholdMs('adult'));
    expect(sleepyThresholdMs('elder')).toBeLessThan(sleepyThresholdMs('senior'));

    // 2.2 分钟：老年已打盹，成年仍醒着
    const at132s = 132_000;
    expect(deriveKittenMood({ ...base, mainState: 'idle', stage: 'elder', now: at132s })).toBe('sleepy');
    expect(deriveKittenMood({ ...base, mainState: 'idle', stage: 'adult', now: at132s })).toBe('idle');

    // 3.5 分钟：成年已打盹，幼猫还精神
    const at210s = 210_000;
    expect(deriveKittenMood({ ...base, mainState: 'idle', stage: 'adult', now: at210s })).toBe('sleepy');
    expect(deriveKittenMood({ ...base, mainState: 'idle', stage: 'kitten', now: at210s })).toBe('idle');

    // 深夜时段（23:00–04:59）静默待命进入 night；超时后照常进入 sleepy
    expect(isLateNightHour(23)).toBe(true);
    expect(isLateNightHour(0)).toBe(true);
    expect(isLateNightHour(4)).toBe(true);
    expect(isLateNightHour(5)).toBe(false);
    expect(isLateNightHour(14)).toBe(false);
    expect(deriveKittenMood({ ...base, mainState: 'idle', localHour: 23 })).toBe('night');
    expect(deriveKittenMood({ ...base, mainState: 'idle', localHour: 2, now: 10 * 60_000 })).toBe('sleepy');
    expect(deriveKittenMood({ ...base, mainState: 'idle', localHour: 14 })).toBe('idle');
  });
});

describe('防频繁抖动切换（stabilizeKittenMood）', () => {
  it('紧急态与高优跃迁零延迟生效，同级工作态与低优回落遵守最小停留窗', () => {
    // 首次渲染直接就位
    const s0 = stabilizeKittenMood(undefined, 'idle', 1_000);
    expect(s0).toEqual({ mood: 'idle', changedAt: 1_000 });

    // idle(1) -> thinking(2)：优先级升高，零延迟切入
    const s1 = stabilizeKittenMood(s0, 'thinking', 1_100);
    expect(s1).toEqual({ mood: 'thinking', changedAt: 1_100 });

    // thinking(2) -> busy(2) 仅过 400ms：暂缓切换并返回剩余停留时间
    const s2 = stabilizeKittenMood(s1, 'busy', 1_500);
    expect(s2.mood).toBe('thinking');
    expect(s2.pendingDelayMs).toBe(MIN_MOOD_HOLD_MS - 400);

    // 到达 MIN_MOOD_HOLD_MS 后放行切换
    const s3 = stabilizeKittenMood(s1, 'busy', 1_100 + MIN_MOOD_HOLD_MS);
    expect(s3).toEqual({ mood: 'busy', changedAt: 1_100 + MIN_MOOD_HOLD_MS });

    // busy(2) -> idle(1) 仅过 300ms：暂缓回落，防轮询闪烁
    const s4 = stabilizeKittenMood(s3, 'idle', s3.changedAt + 300);
    expect(s4.mood).toBe('busy');
    expect(s4.pendingDelayMs).toBe(MIN_MOOD_HOLD_MS - 300);

    // busy(2) -> celebrating(3) 或 error(4) 或 waiting(4)：立即抢占
    expect(stabilizeKittenMood(s3, 'celebrating', s3.changedAt + 100).mood).toBe('celebrating');
    expect(stabilizeKittenMood(s3, 'error', s3.changedAt + 100).mood).toBe('error');
    expect(stabilizeKittenMood(s3, 'waiting', s3.changedAt + 100).mood).toBe('waiting');
  });
});
