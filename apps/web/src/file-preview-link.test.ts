import { describe, expect, it } from 'vitest';
import { filePreviewPath, localFileLink, workspacePreviewPath } from './file-preview-link';

describe('workspace file links', () => {
  it('accepts relative and absolute local Markdown links', () => {
    expect(localFileLink('./docs/a%20b.md#heading')).toBe('./docs/a b.md');
    expect(localFileLink('file:///repo/a.md')).toBe('/repo/a.md');
    expect(workspacePreviewPath('/repo/docs/a.md', '/repo')).toBe('docs/a.md');
    expect(workspacePreviewPath('./docs/../a.md', '/repo')).toBe('a.md');
    expect(localFileLink('./docs/architecture-overview.md:43')).toBe('./docs/architecture-overview.md');
    expect(workspacePreviewPath('/repo/docs/file.ts:12:5', '/repo')).toBe('docs/file.ts');
    expect(localFileLink('file:///repo/docs/a.md:43')).toBe('/repo/docs/a.md');
  });

  it('leaves web links alone and rejects paths outside the workspace', () => {
    expect(localFileLink('https://example.com/a.md')).toBeUndefined();
    expect(localFileLink('#section')).toBeUndefined();
    expect(workspacePreviewPath('/repository/a.md', '/repo')).toBeUndefined();
    expect(workspacePreviewPath('../secret', '/repo')).toBeUndefined();
    expect(filePreviewPath('/Users/example/.codex/skills/example/SKILL.md', '/repo')).toBe('/Users/example/.codex/skills/example/SKILL.md');
    expect(filePreviewPath('file:///Users/example/.codex/skills/example/SKILL.md', '/repo')).toBe('/Users/example/.codex/skills/example/SKILL.md');
    expect(filePreviewPath('https://example.com/a.md', '/repo')).toBeUndefined();
    expect(filePreviewPath('../secret', '/repo')).toBeUndefined();
  });
});
