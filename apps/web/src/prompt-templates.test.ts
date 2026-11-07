import { describe, expect, it } from 'vitest';
import {
  applyPromptTemplate, builtinPromptTemplates, customTemplateFromInput, extractTemplateFields,
  parseCustomTemplates, serializeCustomTemplates
} from './prompt-templates';

describe('prompt templates', () => {
  it('builtin ids are unique and every declared field exists in the body', () => {
    const ids = new Set<string>();
    for (const template of builtinPromptTemplates) {
      expect(ids.has(template.id)).toBe(false);
      ids.add(template.id);
      for (const field of template.fields) expect(template.body).toContain(`{{${field.key}}}`);
      for (const token of extractTemplateFields(template.body).map(field => field.key)) {
        expect(template.fields.some(field => field.key === token)).toBe(true);
      }
    }
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
    // 所有变量都可留空，占位符保留下来供用户在输入框里就地补。
    expect(applyPromptTemplate(template, { 目标: '  ' })).toBe('目标：{{目标}}\n备注：{{备注}}');
  });

  it('parses custom templates defensively and derives fields from the body', () => {
    const raw = JSON.stringify([
      { id: 'a', title: ' 发布检查 ', description: '', body: '检查 {{项目}} 的 {{验证命令}}' },
      { id: 'a', title: '重复 id', body: 'x' },
      { id: 'b', title: '', body: 'x' },
      { id: 'c', title: '没有正文', body: '  ' },
      null, 'nope'
    ]);
    const parsed = parseCustomTemplates(raw);
    expect(parsed).toHaveLength(1);
    expect(parsed[0]).toMatchObject({ id: 'a', title: '发布检查', icon: 'custom', builtin: false });
    expect(parsed[0]!.fields.map(field => field.key)).toEqual(['项目', '验证命令']);
    expect(parseCustomTemplates('not json')).toEqual([]);
    expect(parseCustomTemplates('{}')).toEqual([]);
  });

  it('serializes only user-editable fields', () => {
    const parsed = parseCustomTemplates(JSON.stringify([{ id: 'a', title: 'A', description: 'D', body: 'B {{x}}' }]));
    expect(JSON.parse(serializeCustomTemplates(parsed))).toEqual([{ id: 'a', title: 'A', description: 'D', body: 'B {{x}}' }]);
  });

  it('builds custom templates and keeps the id when editing', () => {
    const created = customTemplateFromInput({ title: ' A ', description: '', body: '检查 {{项目}}' });
    expect(created.title).toBe('A');
    expect(created.description).toBe('自定义提示词模板');
    expect(created.fields[0]?.key).toBe('项目');
    expect(customTemplateFromInput({ title: 'B', description: '', body: 'x' }, 'fixed').id).toBe('fixed');
    expect(() => customTemplateFromInput({ title: '', description: '', body: 'x' })).toThrow('模板名称不能为空');
    expect(() => customTemplateFromInput({ title: 'x', description: '', body: ' ' })).toThrow('模板内容不能为空');
  });
});
