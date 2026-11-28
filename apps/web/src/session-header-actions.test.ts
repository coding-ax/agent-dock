import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

/**
 * 精简会话顶栏与「更多」菜单守卫。
 *
 * - 停止按钮只保留在底部输入框，顶栏右上角不再放重复的「停止」按键；
 * - 主会话便签统一由侧边栏承载，顶栏不再平铺「需要你 / 待验收 / 进行中」占空条与「便签」按钮；
 * - 顶栏右侧克制保留「搜索」「副屏」「更多（含轻微状态点）」；
 * - 定时任务、系统提示词、飞书托管、主会话便签墙与退休/交接均收进 ⋯ 菜单；
 * - 会话顶栏 Agent 处接入统一的「Token 用量 + 账号额度」聚合入口。
 */
const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(join(here, 'SessionPane.tsx'), 'utf8');
const composerSource = readFileSync(join(here, 'Composer.tsx'), 'utf8');

describe('会话标题栏精简与聚合布局', () => {
  it('顶栏移除多余的停止按钮与主会话重复便签/退休占位，停止控制留在底部输入区', () => {
    expect(source).not.toContain('CompanionHeaderNotes');
    expect(source).not.toContain('RetireButton');
    expect(source).not.toContain('<Square size={10} fill="currentColor"/>停止');
    expect(composerSource).toContain('aria-label={L("中断当前任务", "Stop current task")}');
    // 底部输入框不再重复占位旧 Token / Context meter，统一迁移到顶栏 Agent 聚合面板。
    expect(composerSource).not.toContain('SessionUsageMeter');
    expect(composerSource).not.toContain('ContextMeter');
  });

  it('顶栏在 Agent 处接入 Token + 额度聚合面板，右侧仅保留搜索、副屏与 ⋯ 菜单', () => {
    expect(source).toContain('<SessionAgentUsagePopover');
    expect(source).toContain('<Search size={15}/>');
    expect(source).toContain('<PaneToggleButton');
    expect(source).toContain('<MainSessionMoreMenu');
    expect(source).toContain('<SessionMenu groups={menuGroups.filter(group => group.items.length)}');

    const headerStart = source.indexOf('<header className="ui-session-topbar');
    const headerEnd = source.indexOf('</header>', headerStart);
    const headerBlock = source.slice(headerStart, headerEnd);
    expect(headerBlock).not.toContain('<AlarmClock');
    expect(headerBlock).not.toContain('<BookOpen');
    expect(headerBlock).not.toContain('<Bot');
    expect(headerBlock).not.toContain('<ExternalLink');
    expect(headerBlock).not.toContain('<StickyNote');
    expect(headerBlock).not.toContain('<Sunset');
  });

  it('⋯ 菜单完整收纳会话与主会话辅助操作，并支持轻微状态点提示', () => {
    expect(source).toContain("id: 'session-output-plugins'");
    expect(source).toContain("openAppDialog('session-output-plugins', { sessionId: session.id })");
    expect(source).toContain('hasPluginOverrides ? L(" · 覆写", " · Custom") : \'\'');
    expect(source).toContain('id: \'schedules\', label: L("定时任务", "Schedules")');
    expect(source).toContain('id: \'system-prompt\', label: L("查看系统提示词", "View System Prompt")');
    expect(source).toContain('id: \'handover\', label: L("托管到飞书机器人", "Host in Lark Bot")');
    expect(source).toContain("id: 'handover-open', label: L(`已托管：${handoverInfo.name}`");
    expect(source).toContain('id: \'handover-settings\', label: L("飞书同步设置", "Lark Sync Settings")');
    expect(source).toContain('id: \'lark-sync-settings\', label: L("飞书同步设置", "Lark Sync Settings")');
    expect(source).toContain("id: 'companion-notes'");
    expect(source).toContain("id: 'companion-retire'");
    expect(source).toContain('data-menu-indicator={indicator}');

    // 守卫：会话顶栏 ⋯ 菜单绝不直接跳全局交互插件中心（避免误改全局）
    const menuStart = source.indexOf('const regularMenuGroups: SessionMenuGroup[]');
    const menuEnd = source.indexOf('const dangerMenuGroups: SessionMenuGroup[]', menuStart);
    const menuBlock = source.slice(menuStart, menuEnd);
    expect(menuBlock).toContain("openAppDialog('session-output-plugins', { sessionId: session.id })");
    expect(menuBlock).not.toContain("openAppDialog('output-plugins')");

    const app = readFileSync(join(here, 'App.tsx'), 'utf8');
    expect(app).toContain("'session-output-plugins':");
    expect(app).toContain('<SessionOutputPluginsDialog');
  });

  it('把手机扫码入口固定在侧栏底部，而不是会话标题栏', () => {
    expect(source).not.toContain('在手机上打开');
    const settings = readFileSync(join(here, 'SettingsMenu.tsx'), 'utf8');
    expect(settings).toContain("aria-label={t('settings.menu.shareAria')}");
    expect(settings).toContain('<Smartphone');
    expect(settings).toContain('onShare');
    const app = readFileSync(join(here, 'App.tsx'), 'utf8');
    expect(app).toContain("openAppDialog('share')");
    expect(app).toContain('<Smartphone size={15}/>');
  });
});
