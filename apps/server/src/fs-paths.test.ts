import { describe, expect, it } from 'vitest';
import { isBinaryBuffer, isSensitivePath, previewKindForName } from './fs-paths.js';

describe('workspace preview types', () => {
  it('recognizes text, images (including SVG) and PDF artifacts', () => {
    expect(previewKindForName('notes.md')).toBe('text');
    expect(previewKindForName('screen.png')).toBe('image');
    expect(previewKindForName('diagram.svg')).toBe('image');
    expect(previewKindForName('report.PDF')).toBe('pdf');
    expect(previewKindForName('archive.zip')).toBe('unsupported');
  });

  it('removes .env and .npmrc from text preview allowlist', () => {
    expect(previewKindForName('.env')).toBe('unsupported');
    expect(previewKindForName('.npmrc')).toBe('unsupported');
  });
});

describe('sensitive file denylist', () => {
  it('blocks env, npmrc, ssh, keys, pems, and auth files', () => {
    const blocked = [
      '.env',
      '/repo/.env',
      '/repo/.env.local',
      '/repo/.env.production',
      '.npmrc',
      '/Users/me/.npmrc',
      '/Users/me/.ssh/config',
      '/Users/me/.ssh/id_rsa',
      '/tmp/id_rsa',
      '/tmp/id_ed25519.pub',
      '/repo/certs/server.key',
      '/repo/certs/cert.pem',
      '/Users/me/.codex/auth.json',
      '/Users/me/.aws/credentials',
      '/Users/me/.kube/config',
      '/repo/service-account-prod.json'
    ];
    for (const target of blocked) {
      expect(isSensitivePath(target), target).toBe(true);
    }
  });

  it('allows normal workspace and artifact files', () => {
    const allowed = [
      'src/App.tsx',
      '/Users/me/.gemini/brain/plan.md',
      '/tmp/output.svg',
      '/repo/package.json',
      '/repo/docs/auth-guide.md',
      '/repo/env-config.ts'
    ];
    for (const target of allowed) {
      expect(isSensitivePath(target), target).toBe(false);
    }
  });
});

describe('binary buffer sniffing', () => {
  it('detects NUL bytes and binary control sequences', () => {
    expect(isBinaryBuffer(Buffer.from('hello world\n中文内容\t123'))).toBe(false);
    expect(isBinaryBuffer(Buffer.from([0x48, 0x65, 0x00, 0x6c, 0x6f]))).toBe(true);
    expect(isBinaryBuffer(Buffer.from(Array.from({ length: 100 }, () => 0x02)))).toBe(true);
    expect(isBinaryBuffer(Buffer.alloc(0))).toBe(false);
  });
});
