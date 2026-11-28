import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it } from 'vitest';
import { TooltipProvider } from './HoverTooltip';
import { I18nProvider, resetLocaleForTest } from './i18n';
import { PromptTemplates } from './PromptTemplates';
import {
  applyPromptTemplate,
  builtinPromptTemplates,
  customTemplateFromInput,
  displayPromptTemplateDescription,
  extractTemplateFields,
  getBuiltinPromptTemplates,
  getBuiltinTemplateDefaultText,
  getSessionStarterPrompts,
  getUnfilledPlaceholderKeys,
  isDefaultCustomDescription,
  isTemplateReadyToRun,
  parseCustomTemplates,
  serializeCustomTemplates,
  translateUnmodifiedBuiltinPrompt
} from './prompt-templates';

const CJK_RE = /[\u4e00-\u9fff]/;

afterEach(() => {
  resetLocaleForTest('system', 'zh-CN');
});

describe('prompt templates', () => {
  it('maintains 6 high-value builtin templates with 100% bilingual parity and zero en-US CJK leakage', () => {
    const zhList = getBuiltinPromptTemplates('zh-CN');
    const enList = getBuiltinPromptTemplates('en-US');

    expect(zhList).toHaveLength(6);
    expect(enList).toHaveLength(6);
    expect(builtinPromptTemplates).toBe(zhList);
    expect(enList.map(t => t.id)).toEqual(zhList.map(t => t.id));
    expect(enList.map(t => t.icon)).toEqual(zhList.map(t => t.icon));

    const ids = new Set<string>();
    for (let i = 0; i < zhList.length; i += 1) {
      const zh = zhList[i]!;
      const en = enList[i]!;
      expect(ids.has(zh.id)).toBe(false);
      ids.add(zh.id);

      // Every template body must be substantive & structured, without legacy Ralph Loop jargon.
      expect(zh.title).not.toMatch(/Ralph/i);
      expect(en.title).not.toMatch(/Ralph/i);
      expect(zh.body.length).toBeGreaterThan(220);
      expect(en.body.length).toBeGreaterThan(400);

      // Field structure & canonical IDs match 1-to-1 across locales.
      expect(en.fields.map(f => f.id)).toEqual(zh.fields.map(f => f.id));
      expect(en.fields.every(f => Boolean(f.id))).toBe(true);

      for (const template of [zh, en]) {
        const extracted = extractTemplateFields(template.body).map(field => field.key);
        expect(extracted).toEqual(template.fields.map(field => field.key));
        for (const field of template.fields) {
          expect(template.body).toContain(`{{${field.key}}}`);
          // Keep placeholder tokens underscore-free so CommonMark / Milkdown never parses emphasis.
          expect(field.key).not.toContain('_');
        }
      }

      // en-US must be completely CJK-free across title, description, body, and every field property.
      expect(CJK_RE.test(en.title), `en title CJK leak: ${en.id}`).toBe(false);
      expect(CJK_RE.test(en.description), `en description CJK leak: ${en.id}`).toBe(false);
      expect(CJK_RE.test(en.body), `en body CJK leak: ${en.id}`).toBe(false);
      for (const field of en.fields) {
        expect(CJK_RE.test(field.key), `en field key CJK leak: ${en.id}.${field.key}`).toBe(false);
        expect(CJK_RE.test(field.label), `en field label CJK leak: ${en.id}.${field.key}`).toBe(false);
        expect(CJK_RE.test(field.placeholder ?? ''), `en placeholder CJK leak: ${en.id}.${field.key}`).toBe(false);
        expect(CJK_RE.test(field.defaultValue ?? ''), `en defaultValue CJK leak: ${en.id}.${field.key}`).toBe(false);
      }
    }
  });

  it('keeps low filling friction: 2 one-click ready templates and at most 1 unfilled slot on the rest', () => {
    for (const locale of ['zh-CN', 'en-US'] as const) {
      const list = getBuiltinPromptTemplates(locale);
      const readyIds = list.filter(isTemplateReadyToRun).map(t => t.id);
      expect(readyIds).toEqual(['builtin-review', 'builtin-onboarding']);

      for (const template of list) {
        const unfilled = getUnfilledPlaceholderKeys(getBuiltinTemplateDefaultText(template));
        if (readyIds.includes(template.id)) {
          expect(unfilled).toEqual([]);
        } else {
          expect(unfilled).toHaveLength(1);
        }
      }
    }
  });

  it('translates unmodified builtin drafts across locale switches without touching user edits', () => {
    const zhReview = getBuiltinPromptTemplates('zh-CN').find(t => t.id === 'builtin-review')!;
    const enReview = getBuiltinPromptTemplates('en-US').find(t => t.id === 'builtin-review')!;
    const zhDefault = getBuiltinTemplateDefaultText(zhReview);
    const enDefault = getBuiltinTemplateDefaultText(enReview);

    expect(translateUnmodifiedBuiltinPrompt(zhDefault, 'zh-CN', 'en-US')).toBe(enDefault);
    expect(translateUnmodifiedBuiltinPrompt(enDefault, 'en-US', 'zh-CN')).toBe(zhDefault);
    expect(translateUnmodifiedBuiltinPrompt(zhDefault, 'zh-CN', 'zh-CN')).toBeUndefined();

    // Milkdown / ProseMirror canonicalizes `- ` bullets to `* ` and escapes punctuation -> still translates cleanly.
    const milkdownRoundTripped = enDefault.replace(/^- /gm, '* ').replace(/\\./g, '.');
    expect(translateUnmodifiedBuiltinPrompt(milkdownRoundTripped, 'en-US', 'zh-CN')).toBe(zhDefault);

    // User modified even a single character -> must never overwrite.
    expect(translateUnmodifiedBuiltinPrompt(`${zhDefault}\n补充：重点看鉴权`, 'zh-CN', 'en-US')).toBeUndefined();
    expect(translateUnmodifiedBuiltinPrompt('my custom prompt', 'zh-CN', 'en-US')).toBeUndefined();
  });

  it('extracts fields in order and de-duplicates them', () => {
    expect(extractTemplateFields('{{目标}} / {{验收命令}} / {{目标}}').map(field => field.key)).toEqual(['目标', '验收命令']);
  });

  it('applies values and keeps placeholders for every unfilled variable', () => {
    const template = {
      id: 'x', title: 'x', description: '', icon: 'custom' as const, builtin: false,
      body: '目标：{{目标}}\n备注：{{备注}}',
      fields: [
        { key: '目标', label: '目标' },
        { key: '备注', label: '备注', optional: true }
      ]
    };
    expect(applyPromptTemplate(template, { 目标: '发布', 备注: '先备份' })).toBe('目标：发布\n备注：先备份');
    expect(applyPromptTemplate(template, { 目标: '  ' })).toBe('目标：{{目标}}\n备注：{{备注}}');
  });

  it('parses custom templates defensively, preserves custom text, and localizes blank descriptions dynamically', () => {
    const raw = JSON.stringify([
      { id: 'a', title: ' 发布检查 ', description: '', body: '检查 {{项目}} 的 {{验证命令}}' },
      { id: 'keep', title: 'My Release Checklist', description: 'Run before tagging', body: 'Check {{tag}}' },
      { id: 'a', title: '重复 id', body: 'x' },
      { id: 'b', title: '', body: 'x' },
      { id: 'c', title: '没有正文', body: '  ' },
      null, 'nope'
    ]);
    const parsedZh = parseCustomTemplates(raw, 'zh-CN');
    expect(parsedZh).toHaveLength(2);
    expect(parsedZh[0]).toMatchObject({ id: 'a', title: '发布检查', description: '自定义提示词模板', icon: 'custom', builtin: false });
    expect(parsedZh[0]!.fields.map(field => field.key)).toEqual(['项目', '验证命令']);
    expect(parsedZh[1]).toMatchObject({ id: 'keep', title: 'My Release Checklist', description: 'Run before tagging', body: 'Check {{tag}}' });

    // Switching display locale dynamically translates default fallback without overwriting user-written descriptions.
    expect(displayPromptTemplateDescription(parsedZh[0]!, 'en-US')).toBe('Custom prompt template');
    expect(displayPromptTemplateDescription(parsedZh[1]!, 'en-US')).toBe('Run before tagging');
    expect(displayPromptTemplateDescription(parsedZh[1]!, 'zh-CN')).toBe('Run before tagging');

    // Serializing normalizes default fallback descriptions back to '' so storage stays locale-neutral.
    expect(JSON.parse(serializeCustomTemplates(parsedZh))).toEqual([
      { id: 'a', title: '发布检查', description: '', body: '检查 {{项目}} 的 {{验证命令}}' },
      { id: 'keep', title: 'My Release Checklist', description: 'Run before tagging', body: 'Check {{tag}}' }
    ]);

    expect(isDefaultCustomDescription('')).toBe(true);
    expect(isDefaultCustomDescription('自定义提示词模板')).toBe(true);
    expect(isDefaultCustomDescription('Custom prompt template')).toBe(true);
    expect(isDefaultCustomDescription('Run before tagging')).toBe(false);

    expect(parseCustomTemplates('not json')).toEqual([]);
    expect(parseCustomTemplates('{}')).toEqual([]);
  });

  it('builds custom templates with localized errors and keeps the id when editing', () => {
    const createdZh = customTemplateFromInput({ title: ' A ', description: '', body: '检查 {{项目}}' }, undefined, 'zh-CN');
    expect(createdZh.title).toBe('A');
    expect(createdZh.description).toBe('自定义提示词模板');
    expect(createdZh.fields[0]?.key).toBe('项目');

    const createdEn = customTemplateFromInput({ title: ' Deploy ', description: '', body: 'Verify {{env}}' }, 'fixed', 'en-US');
    expect(createdEn.id).toBe('fixed');
    expect(createdEn.description).toBe('Custom prompt template');

    expect(() => customTemplateFromInput({ title: '', description: '', body: 'x' }, undefined, 'zh-CN')).toThrow('模板名称不能为空');
    expect(() => customTemplateFromInput({ title: 'x', description: '', body: ' ' }, undefined, 'zh-CN')).toThrow('模板内容不能为空');
    expect(() => customTemplateFromInput({ title: '', description: '', body: 'x' }, undefined, 'en-US')).toThrow('Template name cannot be empty');
    expect(() => customTemplateFromInput({ title: 'x', description: '', body: ' ' }, undefined, 'en-US')).toThrow('Template content cannot be empty');
  });

  it('provides bilingual, high-value empty-session starter prompts', () => {
    const zhStarters = getSessionStarterPrompts('zh-CN');
    const enStarters = getSessionStarterPrompts('en-US');

    expect(zhStarters).toHaveLength(3);
    expect(enStarters.map(item => item.id)).toEqual(zhStarters.map(item => item.id));
    for (let i = 0; i < zhStarters.length; i += 1) {
      expect(zhStarters[i]!.prompt.length).toBeGreaterThan(zhStarters[i]!.label.length * 3);
      expect(enStarters[i]!.prompt.length).toBeGreaterThan(enStarters[i]!.label.length * 3);
      expect(CJK_RE.test(enStarters[i]!.label)).toBe(false);
      expect(CJK_RE.test(enStarters[i]!.prompt)).toBe(false);
    }
  });

  it('renders PromptTemplates cleanly in both en-US and zh-CN with working line-clamp-2 and zero en-US CJK', () => {
    const enHtml = renderToStaticMarkup(
      createElement(
        I18nProvider,
        { locale: 'en-US' },
        createElement(TooltipProvider, null, createElement(PromptTemplates, { onUse: () => {} }))
      )
    );
    expect(enHtml).toContain('Prompt Templates');
    expect(enHtml).toContain('Debug &amp; Fix');
    expect(enHtml).toContain('Plan &amp; Build');
    expect(enHtml).toContain('Code Review');
    expect(enHtml).toContain('Safe Refactor');
    expect(enHtml).toContain('Codebase Map');
    expect(enHtml).toContain('Run to Green');
    expect(enHtml).toContain('New template');
    expect(enHtml).not.toContain('line-clamp-2 block');
    expect(CJK_RE.test(enHtml), `PromptTemplates en-US HTML leaked CJK: ${enHtml}`).toBe(false);

    const zhHtml = renderToStaticMarkup(
      createElement(
        I18nProvider,
        { locale: 'zh-CN' },
        createElement(TooltipProvider, null, createElement(PromptTemplates, { onUse: () => {} }))
      )
    );
    expect(zhHtml).toContain('提示词模板');
    expect(zhHtml).toContain('根因修 Bug');
    expect(zhHtml).toContain('需求规划与实现');
    expect(zhHtml).toContain('严格代码审查');
    expect(zhHtml).toContain('安全重构治理');
    expect(zhHtml).toContain('摸清代码脉络');
    expect(zhHtml).toContain('自检迭代到全绿');
    expect(zhHtml).toContain('新建模板');
  });
});
