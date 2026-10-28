import { describe, expect, it } from 'vitest';
import { modelBadge, modelBadgeText } from './model-label.js';

describe('modelBadge', () => {
  it('普通模型 id 原样保留', () => {
    expect(modelBadge('gpt-6-astra')).toEqual({ model: 'gpt-6-astra' });
    expect(modelBadge('auto_model/seed-evolving-auto')).toEqual({ model: 'auto_model/seed-evolving-auto' });
  });

  it('误存成 JSON 数组时取最后一个元素——前面那个是 provider', () => {
    expect(modelBadge('["superrelay","opensource/deepseek_v4_flash_0731"]')).toEqual({
      model: 'opensource/deepseek_v4_flash_0731'
    });
  });

  it('尾部 [effort=…] 参数剥掉，并解析成独立的推理强度', () => {
    expect(modelBadge('grok-4.6[effort=high,fast=true]')).toEqual({ model: 'grok-4.6', effort: 'high' });
  });

  it('会话自带的 reasoningEffort 优先于 model 串里烧死的参数', () => {
    expect(modelBadge('grok-4.6[effort=high]', 'medium')).toEqual({ model: 'grok-4.6', effort: 'medium' });
  });

  it('不含 k=v 的方括号属于 id 本身，不能当参数剥掉', () => {
    expect(modelBadge('foo[beta]')).toEqual({ model: 'foo[beta]' });
  });

  it('只有推理强度时也给得出徽标', () => {
    expect(modelBadge(undefined, 'medium')).toEqual({ effort: 'medium' });
  });

  it('空值与坏 JSON 不产生徽标或退回原串', () => {
    expect(modelBadge(undefined)).toEqual({});
    expect(modelBadge('')).toEqual({});
    expect(modelBadge('   ')).toEqual({});
    expect(modelBadge('[]')).toEqual({});
    expect(modelBadge('["broken",')).toEqual({ model: '["broken",' });
  });
});

describe('modelBadgeText', () => {
  it('模型与推理强度并成一枚标签', () => {
    expect(modelBadgeText({ model: 'grok-4.6', effort: 'high' })).toBe('grok-4.6 · high');
    expect(modelBadgeText({ model: 'gpt-6-astra' })).toBe('gpt-6-astra');
    expect(modelBadgeText({ effort: 'medium' })).toBe('medium');
  });

  it('没有可展示内容时返回 undefined，由调用方整块不渲染', () => {
    expect(modelBadgeText({})).toBeUndefined();
  });
});
