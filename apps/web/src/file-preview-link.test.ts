import { describe, expect, it } from 'vitest';
import {
  filePreviewPath,
  formatLineRange,
  isAudioFilePath,
  isImageFilePath,
  isSvgFilePath,
  isVideoFilePath,
  localFileLink,
  parseFileLink,
  workspacePreviewPath
} from './file-preview-link';

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

  it('parses line and column numbers from #L14-L16 and :12:5 forms', () => {
    expect(parseFileLink('file:///repo/src/app.ts#L14-L16')).toEqual({
      path: '/repo/src/app.ts',
      startLine: 14,
      endLine: 16
    });
    expect(parseFileLink('./src/app.ts#L42')).toEqual({
      path: './src/app.ts',
      startLine: 42
    });
    expect(parseFileLink('/repo/src/app.ts:12:5')).toEqual({
      path: '/repo/src/app.ts',
      startLine: 12,
      column: 5
    });
    expect(parseFileLink('file:///repo/src/app.ts:10-20')).toEqual({
      path: '/repo/src/app.ts',
      startLine: 10,
      endLine: 20
    });
    expect(formatLineRange(14, 16)).toBe('L14-L16');
    expect(formatLineRange(14)).toBe('L14');
    expect(formatLineRange(undefined)).toBeUndefined();
  });

  it('recognizes image, SVG, video and audio file paths', () => {
    expect(isImageFilePath('/tmp/demo.png')).toBe(true);
    expect(isImageFilePath('/tmp/diagram.svg')).toBe(true);
    expect(isSvgFilePath('/tmp/diagram.svg')).toBe(true);
    expect(isImageFilePath('/tmp/notes.md')).toBe(false);
    expect(isVideoFilePath('/tmp/yibanlaishuo_ai_song.mp4')).toBe(true);
    expect(isVideoFilePath('/tmp/clip.MOV')).toBe(true);
    expect(isAudioFilePath('/tmp/audio.wav')).toBe(true);
    expect(isAudioFilePath('/tmp/song.mp3')).toBe(true);
    expect(isVideoFilePath('/tmp/notes.md')).toBe(false);
  });

  it('leaves web links alone and supports absolute & ~/ preview paths', () => {
    expect(localFileLink('https://example.com/a.md')).toBeUndefined();
    expect(localFileLink('#section')).toBeUndefined();
    expect(workspacePreviewPath('/repository/a.md', '/repo')).toBeUndefined();
    expect(workspacePreviewPath('../secret', '/repo')).toBeUndefined();
    expect(workspacePreviewPath('~/.agentdock/workspace/demo.mp4', '/repo')).toBeUndefined();
    expect(filePreviewPath('/Users/example/.codex/skills/example/SKILL.md', '/repo')).toBe('/Users/example/.codex/skills/example/SKILL.md');
    expect(filePreviewPath('file:///Users/example/.codex/skills/example/SKILL.md', '/repo')).toBe('/Users/example/.codex/skills/example/SKILL.md');
    expect(filePreviewPath('~/.agentdock/workspace/ai-song-video/yibanlaishuo_ai_song.mp4', '/repo')).toBe('~/.agentdock/workspace/ai-song-video/yibanlaishuo_ai_song.mp4');
    expect(filePreviewPath('https://example.com/a.md', '/repo')).toBeUndefined();
    expect(filePreviewPath('../secret', '/repo')).toBeUndefined();
  });
});
