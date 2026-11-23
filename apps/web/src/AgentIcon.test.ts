import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { existsSync } from 'node:fs';
import { AgentIcon, agentBrand } from './AgentIcon';

const acpxBuiltins = [
  'pi', 'openclaw', 'codex', 'claude', 'gemini', 'cursor', 'copilot', 'droid',
  'fast-agent', 'grok-build', 'iflow', 'kilocode', 'kimi', 'kiro', 'mcode',
  'mux', 'opencode', 'pool', 'qoder', 'qwen', 'trae', 'zeroclaw', 'antigravity',
];

describe('agentBrand', () => {
  it('matches supported Agent identities and aliases', () => {
    expect(agentBrand('antigravity')).toBe('antigravity');
    expect(agentBrand('agy')).toBe('antigravity');
    expect(agentBrand(undefined, 'Google Antigravity')).toBe('antigravity');
    expect(agentBrand('antigravity-cli')).toBe('antigravity');
    expect(agentBrand('agy-cli')).toBe('antigravity');
    expect(agentBrand('claude')).toBe('claudecode');
    expect(agentBrand('cursor-agent')).toBe('cursor');
    expect(agentBrand('traecli')).toBe('trae');
    expect(agentBrand('deepseek-harness')).toBe('deepseek');
    expect(agentBrand('factory-droid')).toBe('droid');
    expect(agentBrand('GitHub Copilot')).toBe('copilot');
    expect(agentBrand('mcode')).toBe('mcode');
  });

  it('renders Antigravity with its dedicated color SVG icon', () => {
    const markup = renderToStaticMarkup(createElement(AgentIcon, { agentId: 'antigravity', agentName: 'Google Antigravity', size: 16 }));
    expect(markup).toContain('src="/agent-icons/antigravity.svg"');
    expect(markup).not.toContain('ui-mono-brand');
  });

  it('has an icon asset for every acpx built-in Agent', () => {
    for (const id of acpxBuiltins) {
      const markup = renderToStaticMarkup(createElement(AgentIcon, { agentId: id }));
      const path = markup.match(/src="(\/agent-icons\/[^\"]+)"/)?.[1];
      expect(path, id).toBeDefined();
      expect(existsSync(new URL(`../public${path}`, import.meta.url)), id).toBe(true);
    }
  });

  it('does not mistake a custom Agent or model for a built-in brand', () => {
    expect(agentBrand('my-agent', 'My Agent')).toBeUndefined();
    expect(agentBrand('opus')).toBeUndefined();
    expect(renderToStaticMarkup(createElement(AgentIcon, { agentId: 'my-agent' }))).toContain('<svg');
  });
});
