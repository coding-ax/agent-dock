import { describe, expect, it } from 'vitest';
import { buildLarkCard } from './service.js';
import { renderLarkCardElements } from './listener.js';

describe('Lark card graceful degradation for rich markdown blocks', () => {
  const richAnswer = [
    '发布总结：',
    '',
    '```metrics',
    '当前版本: v0.3.31 | +6 路合入',
    '单测通过率: 100% | +0 回归',
    '```',
    '',
    '```steps',
    '[x] 构建全绿 | pnpm build 通过',
    '[~] 沙箱验收 | ego-browser 多主题检查',
    '[ ] 汇报完成',
    '```',
    '',
    '> [!TIP]',
    '> 关键改动 ==零首屏增量==，按 <kbd>Esc</kbd> 关闭全屏图。',
    '',
    '```svg',
    '<svg viewBox="0 0 100 40"><rect width="100" height="40"/></svg>',
    '```'
  ].join('\n');

  it('degrades rich blocks inside renderLarkCardElements final_output', () => {
    const events: any[] = [
      { id: 'e1', sessionId: 'ses_1', sequence: 1, type: 'text', timestamp: '2026-11-28T12:00:00Z', data: { text: richAnswer } }
    ];
    const elements = renderLarkCardElements(events, { traceLimit: 10 }, true, false, { locale: 'zh-CN' });
    const finalEl = elements.find(el => el.element_id === 'final_output');
    const content = String(finalEl?.content ?? '');

    expect(content).toContain('- **当前版本**：**v0.3.31**（+6 路合入）');
    expect(content).toContain('✅ **构建全绿** — pnpm build 通过');
    expect(content).toContain('🔵 **沙箱验收** — ego-browser 多主题检查');
    expect(content).toContain('⚪ 汇报完成');
    expect(content).toContain('> 💡 **提示**');
    expect(content).toContain('**零首屏增量**');
    expect(content).toContain('`Esc`');
    expect(content).toContain('SVG 矢量图表');
    expect(content).not.toContain('```metrics');
    expect(content).not.toContain('```steps');
    expect(content).not.toContain('<rect');
  });

  it('degrades rich blocks in buildLarkCard markdown body for both zh-CN and en-US', () => {
    const cardEn = buildLarkCard({
      state: 'completed',
      locale: 'en-US',
      markdown: richAnswer
    });
    const jsonEn = JSON.stringify(cardEn);
    expect(jsonEn).toContain('> 💡 **Tip**');
    expect(jsonEn).toContain('SVG Diagram');
    expect(jsonEn).not.toContain('```metrics');
    expect(jsonEn).not.toContain('```steps');
  });
});
