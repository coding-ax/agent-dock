import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

/**
 * 会话标题栏操作入口守卫。
 *
 * 0.2.0 的精简版把旧标题栏的所有图标都收进 ⋯ 菜单，老用户反馈「停止、托管给飞书、
 * 查看系统提示词不见了」。这里盯住标题栏里能一眼看到的操作，⋯ 菜单仍负责完整功能。
 */
const source = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'SessionPane.tsx'), 'utf8');

describe('会话标题栏常用操作', () => {
  it('保留旧版可见的停止、定时任务、系统提示词和飞书入口', () => {
    expect(source).toContain('<Square size={10} fill="currentColor"/>停止');
    expect(source).toContain("label={activeSchedules ? `定时任务（${activeSchedules} 个启用中）` : '定时任务'}");
    expect(source).toContain('label="查看系统提示词"');
    expect(source).toContain('label="托管给飞书机器人"');
    expect(source).toContain("label={`已托管：${handoverInfo.name}（打开托管群）`}");
  });

  it('仍保留完整的 ⋯ 菜单', () => {
    expect(source).toContain('<SessionMenu groups={menuGroups.filter(group => group.items.length)}/>');
  });

  it('把手机扫码入口固定在侧栏底部，而不是会话标题栏', () => {
    expect(source).not.toContain('在手机上打开');
    const here = dirname(fileURLToPath(import.meta.url));
    const settings = readFileSync(join(here, 'SettingsMenu.tsx'), 'utf8');
    expect(settings).toContain('aria-label="在手机上打开"');
    expect(settings).toContain('<Smartphone');
    expect(settings).toContain('onShare');
    const app = readFileSync(join(here, 'App.tsx'), 'utf8');
    expect(app).toContain("openAppDialog('share')");
    expect(app).toContain('<Smartphone size={15}/>');
  });
});
