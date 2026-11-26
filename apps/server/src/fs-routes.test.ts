import Fastify from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { registerFsRoutes } from './fs-routes.js';

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true })));
});

async function buildApp(options: { cwd: string; sshHost?: string; homeDir: string; tempDir: string; maxDirEntries?: number }) {
  const app = Fastify();
  app.addHook('onRequest', async request => {
    (request as unknown as { webClaim: { kind: string } }).webClaim = {
      kind: request.headers['x-test-claim'] === 'session' ? 'session' : 'master'
    };
  });
  await registerFsRoutes(
    app,
    { getSession: async () => ({ id: 'ses_1', cwd: options.cwd, ...(options.sshHost ? { sshHost: options.sshHost } : {}) }) } as any,
    {
      homeDir: options.homeDir,
      tempDir: options.tempDir,
      ...(options.maxDirEntries !== undefined ? { maxDirEntries: options.maxDirEntries } : {})
    }
  );
  return app;
}

describe('session file preview security & formats', () => {
  it('enforces tiered allowlist for master vs session roles and blocks symlink escape', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agentdock-preview-'));
    directories.push(root);
    const homeDir = join(root, 'home');
    const tempDir = join(root, 'tmp-area');
    const workspace = join(root, 'workspace');
    const outsideDir = join(root, 'outside-forbidden');
    const geminiDir = join(homeDir, '.gemini', 'brain');
    const uploadDir = join(homeDir, '.agentdock', 'uploads', 'ses_1');
    const otherUploadDir = join(homeDir, '.agentdock', 'uploads', 'ses_other');

    await mkdir(workspace, { recursive: true });
    await mkdir(tempDir, { recursive: true });
    await mkdir(outsideDir, { recursive: true });
    await mkdir(geminiDir, { recursive: true });
    await mkdir(uploadDir, { recursive: true });
    await mkdir(otherUploadDir, { recursive: true });

    const insideFile = join(workspace, 'inside.md');
    const geminiArtifact = join(geminiDir, 'report.md');
    const tempArtifact = join(tempDir, 'output.txt');
    const sessionUpload = join(uploadDir, 'shot.png');
    const otherSessionUpload = join(otherUploadDir, 'other.png');
    const outsideFile = join(outsideDir, 'secret-note.txt');

    await writeFile(insideFile, '# Inside');
    await writeFile(geminiArtifact, '# Gemini Artifact');
    await writeFile(tempArtifact, 'temp output');
    await writeFile(sessionUpload, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    await writeFile(otherSessionUpload, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    await writeFile(outsideFile, 'outside');
    await symlink(outsideFile, join(workspace, 'linked-outside.txt'));
    await symlink(outsideFile, join(tempDir, 'tmp-escape.txt'));

    const app = await buildApp({ cwd: workspace, homeDir, tempDir });
    try {
      // master: allowed in cwd, ~/.gemini, tempDir, uploads, and arbitrary non-sensitive local paths (absolute or ~/)
      const ownerGemini = await app.inject({ url: `/api/sessions/ses_1/fs/read?path=${encodeURIComponent(geminiArtifact)}` });
      expect(ownerGemini.statusCode).toBe(200);
      expect(ownerGemini.json().content).toBe('# Gemini Artifact');

      const ownerTemp = await app.inject({ url: `/api/sessions/ses_1/fs/read?path=${encodeURIComponent(tempArtifact)}` });
      expect(ownerTemp.statusCode).toBe(200);
      expect(ownerTemp.json().content).toBe('temp output');

      const ownerOutside = await app.inject({ url: `/api/sessions/ses_1/fs/read?path=${encodeURIComponent(outsideFile)}` });
      expect(ownerOutside.statusCode).toBe(200);
      expect(ownerOutside.json().content).toBe('outside');

      const ownerTilde = await app.inject({ url: `/api/sessions/ses_1/fs/read?path=${encodeURIComponent('~/.gemini/brain/report.md')}` });
      expect(ownerTilde.statusCode).toBe(200);
      expect(ownerTilde.json().content).toBe('# Gemini Artifact');

      // relative path symlink escape from cwd still rejected by resolveExistingInside
      const escapeFromCwd = await app.inject({ url: `/api/sessions/ses_1/fs/read?path=linked-outside.txt` });
      expect(escapeFromCwd.statusCode).toBe(400);

      // session: allowed in cwd and own uploads only
      const shared = { 'x-test-claim': 'session' };
      expect((await app.inject({ url: `/api/sessions/ses_1/fs/read?path=inside.md`, headers: shared })).statusCode).toBe(200);
      expect((await app.inject({ url: `/api/sessions/ses_1/fs/read?path=${encodeURIComponent(insideFile)}`, headers: shared })).statusCode).toBe(200);
      expect((await app.inject({ url: `/api/sessions/ses_1/fs/read?path=${encodeURIComponent(sessionUpload)}`, headers: shared })).statusCode).toBe(200);

      // session: blocked from other session uploads, ~/.gemini, tempDir, outsideDir, ~/ paths, symlink escape
      expect((await app.inject({ url: `/api/sessions/ses_1/fs/read?path=${encodeURIComponent(otherSessionUpload)}`, headers: shared })).statusCode).toBe(403);
      expect((await app.inject({ url: `/api/sessions/ses_1/fs/read?path=${encodeURIComponent(geminiArtifact)}`, headers: shared })).statusCode).toBe(403);
      expect((await app.inject({ url: `/api/sessions/ses_1/fs/read?path=${encodeURIComponent(tempArtifact)}`, headers: shared })).statusCode).toBe(403);
      expect((await app.inject({ url: `/api/sessions/ses_1/fs/read?path=${encodeURIComponent(outsideFile)}`, headers: shared })).statusCode).toBe(403);
      expect((await app.inject({ url: `/api/sessions/ses_1/fs/read?path=${encodeURIComponent('~/.gemini/brain/report.md')}`, headers: shared })).statusCode).toBe(403);
      expect((await app.inject({ url: `/api/sessions/ses_1/fs/read?path=linked-outside.txt`, headers: shared })).statusCode).toBe(400);
      expect((await app.inject({ url: `/api/sessions/ses_1/fs/list?path=${encodeURIComponent(root)}`, headers: shared })).statusCode).toBe(400);
    } finally {
      await app.close();
    }
  });

  it('allows master to read external workspace files while keeping session share links isolated', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agentdock-escape-'));
    directories.push(root);
    const workspace = join(root, 'workspace');
    const homeDir = join(root, 'home');
    const externalWorkspace = join(homeDir, '.agentdock', 'workspace', 'ai-song-video');
    await mkdir(workspace, { recursive: true });
    await mkdir(externalWorkspace, { recursive: true });
    const readme = join(externalWorkspace, 'README.md');
    await writeFile(readme, '# AI Song Demo');
    await symlink(readme, join(workspace, 'external-link.md'));

    const app = await buildApp({ cwd: workspace, homeDir, tempDir: root });
    try {
      // master can read external workspace via absolute path or ~/ path
      const masterAbs = await app.inject({ url: `/api/sessions/ses_1/fs/read?path=${encodeURIComponent(readme)}` });
      expect(masterAbs.statusCode).toBe(200);
      expect(masterAbs.json().content).toBe('# AI Song Demo');

      const masterTilde = await app.inject({ url: `/api/sessions/ses_1/fs/read?path=${encodeURIComponent('~/.agentdock/workspace/ai-song-video/README.md')}` });
      expect(masterTilde.statusCode).toBe(200);
      expect(masterTilde.json().content).toBe('# AI Song Demo');

      // session share link is still strictly isolated from external workspace and system paths
      const shared = { 'x-test-claim': 'session' };
      expect((await app.inject({ url: `/api/sessions/ses_1/fs/read?path=${encodeURIComponent(readme)}`, headers: shared })).statusCode).toBe(403);
      expect((await app.inject({ url: `/api/sessions/ses_1/fs/read?path=${encodeURIComponent('/etc/hosts')}`, headers: shared })).statusCode).toBe(403);
      expect((await app.inject({ url: `/api/sessions/ses_1/fs/read?path=external-link.md`, headers: shared })).statusCode).toBe(400);
    } finally {
      await app.close();
    }
  });

  it('streams video and audio previews with HTTP Range support', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agentdock-media-'));
    directories.push(root);
    const workspace = join(root, 'workspace');
    const homeDir = join(root, 'home');
    const videoDir = join(homeDir, '.agentdock', 'workspace', 'ai-song-video');
    await mkdir(workspace, { recursive: true });
    await mkdir(videoDir, { recursive: true });
    const videoFile = join(videoDir, 'yibanlaishuo_ai_song.mp4');
    const payload = Buffer.from('0123456789abcdef', 'utf8');
    await writeFile(videoFile, payload);

    const app = await buildApp({ cwd: workspace, homeDir, tempDir: root });
    try {
      const full = await app.inject({ url: `/api/sessions/ses_1/fs/read?path=${encodeURIComponent(videoFile)}` });
      expect(full.statusCode).toBe(200);
      expect(full.headers['content-type']).toBe('video/mp4');
      expect(full.headers['accept-ranges']).toBe('bytes');
      expect(full.headers['content-length']).toBe(String(payload.length));
      expect(full.rawPayload).toEqual(payload);

      const partial = await app.inject({
        url: `/api/sessions/ses_1/fs/read?path=${encodeURIComponent(videoFile)}`,
        headers: { range: 'bytes=4-9' }
      });
      expect(partial.statusCode).toBe(206);
      expect(partial.headers['content-type']).toBe('video/mp4');
      expect(partial.headers['content-range']).toBe('bytes 4-9/16');
      expect(partial.headers['content-length']).toBe('6');
      expect(partial.body).toBe('456789');

      const invalidRange = await app.inject({
        url: `/api/sessions/ses_1/fs/read?path=${encodeURIComponent(videoFile)}`,
        headers: { range: 'bytes=100-200' }
      });
      expect(invalidRange.statusCode).toBe(416);
      expect(invalidRange.headers['content-range']).toBe('bytes */16');
    } finally {
      await app.close();
    }
  });

  it('blocks sensitive files for ALL roles including master and symlink aliases', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agentdock-sensitive-'));
    directories.push(root);
    const workspace = join(root, 'workspace');
    const homeDir = join(root, 'home');
    await mkdir(workspace, { recursive: true });
    await mkdir(homeDir, { recursive: true });
    await writeFile(join(workspace, '.env'), 'SECRET=1');
    await writeFile(join(workspace, '.env.local'), 'SECRET=2');
    await writeFile(join(workspace, '.npmrc'), '//registry/:_authToken=xyz');
    await writeFile(join(workspace, 'server.key'), 'PRIVATE KEY');
    await writeFile(join(workspace, 'auth.json'), '{"token":"secret"}');
    await symlink(join(workspace, '.env'), join(workspace, 'safe-looking.txt'));

    const app = await buildApp({ cwd: workspace, homeDir, tempDir: root });
    try {
      for (const name of ['.env', '.env.local', '.npmrc', 'server.key', 'auth.json', 'safe-looking.txt']) {
        const res = await app.inject({ url: `/api/sessions/ses_1/fs/read?path=${encodeURIComponent(name)}` });
        expect(res.statusCode, name).toBe(403);
        const dl = await app.inject({ url: `/api/sessions/ses_1/fs/read?path=${encodeURIComponent(name)}&download=1` });
        expect(dl.statusCode, `${name} download`).toBe(403);
      }
    } finally {
      await app.close();
    }
  });

  it('serves SVG as image/svg+xml with CSP sandbox & nosniff, and supports ?format=text & ?download=1', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agentdock-svg-'));
    directories.push(root);
    const workspace = join(root, 'workspace');
    const homeDir = join(root, 'home');
    await mkdir(workspace, { recursive: true });
    await mkdir(homeDir, { recursive: true });
    const svgContent = '<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32"><circle cx="16" cy="16" r="10"/></svg>';
    await writeFile(join(workspace, 'icon.svg'), svgContent);

    const app = await buildApp({ cwd: workspace, homeDir, tempDir: root });
    try {
      const raw = await app.inject({ url: `/api/sessions/ses_1/fs/read?path=icon.svg` });
      expect(raw.statusCode).toBe(200);
      expect(raw.headers['content-type']).toBe('image/svg+xml');
      expect(raw.headers['content-security-policy']).toBe('sandbox');
      expect(raw.headers['x-content-type-options']).toBe('nosniff');
      expect(raw.body).toBe(svgContent);

      const source = await app.inject({ url: `/api/sessions/ses_1/fs/read?path=icon.svg&format=text` });
      expect(source.statusCode).toBe(200);
      expect(source.json().content).toBe(svgContent);

      const dl = await app.inject({ url: `/api/sessions/ses_1/fs/read?path=icon.svg&download=1` });
      expect(dl.statusCode).toBe(200);
      expect(dl.headers['content-disposition']).toContain('attachment');
      expect(dl.headers['content-security-policy']).toBe('sandbox');
      expect(dl.headers['x-content-type-options']).toBe('nosniff');
    } finally {
      await app.close();
    }
  });

  it('rejects binary files disguised as text and blocks SSH remote sessions', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agentdock-bin-'));
    directories.push(root);
    const workspace = join(root, 'workspace');
    const homeDir = join(root, 'home');
    await mkdir(workspace, { recursive: true });
    await mkdir(homeDir, { recursive: true });
    await writeFile(join(workspace, 'fake.txt'), Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0x00, 0x01, 0x02]));

    const localApp = await buildApp({ cwd: workspace, homeDir, tempDir: root });
    const sshApp = await buildApp({ cwd: workspace, sshHost: 'prod-box', homeDir, tempDir: root });
    try {
      const binRes = await localApp.inject({ url: `/api/sessions/ses_1/fs/read?path=fake.txt` });
      expect(binRes.statusCode).toBe(415);

      expect((await sshApp.inject({ url: `/api/sessions/ses_1/fs/list` })).statusCode).toBe(400);
      expect((await sshApp.inject({ url: `/api/sessions/ses_1/fs/read?path=fake.txt` })).statusCode).toBe(400);
    } finally {
      await localApp.close();
      await sshApp.close();
    }
  });

  it('returns structured directory listings with sorting, hidden toggle, truncation, and security boundaries', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agentdock-dir-preview-'));
    directories.push(root);
    const workspace = join(root, 'workspace');
    const homeDir = join(root, 'home');
    const externalDir = join(homeDir, 'projects', 'demo-site');
    const nestedDir = join(externalDir, 'src');
    const sshDir = join(homeDir, '.ssh');

    await mkdir(join(workspace, 'docs'), { recursive: true });
    await mkdir(nestedDir, { recursive: true });
    await mkdir(join(externalDir, 'assets'), { recursive: true });
    await mkdir(join(externalDir, '.github'), { recursive: true });
    await mkdir(sshDir, { recursive: true });

    await writeFile(join(workspace, 'docs', 'guide.md'), '# Guide');
    await writeFile(join(externalDir, 'README.md'), '# Demo Site');
    await writeFile(join(externalDir, 'package.json'), '{"name":"demo-site"}');
    await writeFile(join(externalDir, '.gitignore'), 'node_modules\n');
    await writeFile(join(externalDir, '.DS_Store'), 'junk');
    await writeFile(join(nestedDir, 'index.ts'), 'export const ok = true;\n');

    const app = await buildApp({ cwd: workspace, homeDir, tempDir: root, maxDirEntries: 3 });
    try {
      // 1. master previews external directory via absolute path (hidden filtered by default, folders first)
      const extRes = await app.inject({ url: `/api/sessions/ses_1/fs/read?path=${encodeURIComponent(externalDir)}` });
      expect(extRes.statusCode).toBe(200);
      const extBody = extRes.json();
      expect(extBody.kind).toBe('directory');
      expect(extBody.includeHidden).toBe(false);
      expect(extBody.hiddenCount).toBe(2); // .github, .gitignore (.DS_Store ignored)
      expect(extBody.totalCount).toBe(4); // assets, src, package.json, README.md
      expect(extBody.truncated).toBe(true);
      expect(extBody.entries.map((e: any) => [e.name, e.kind])).toEqual([
        ['assets', 'directory'],
        ['src', 'directory'],
        ['package.json', 'file']
      ]);
      expect(extBody.entries[2].size).toBeGreaterThan(0);
      expect(extBody.parentPath).toBeTruthy();

      // 2. master previews via ~/ path with ?hidden=1
      const tildeRes = await app.inject({ url: `/api/sessions/ses_1/fs/read?path=${encodeURIComponent('~/projects/demo-site')}&hidden=1` });
      expect(tildeRes.statusCode).toBe(200);
      const tildeBody = tildeRes.json();
      expect(tildeBody.kind).toBe('directory');
      expect(tildeBody.includeHidden).toBe(true);
      expect(tildeBody.totalCount).toBe(6);
      expect(tildeBody.entries.map((e: any) => e.name)).toEqual(['.github', 'assets', 'src']);

      // 3. download=1 on directory is rejected
      const dlRes = await app.inject({ url: `/api/sessions/ses_1/fs/read?path=${encodeURIComponent(externalDir)}&download=1` });
      expect(dlRes.statusCode).toBe(400);

      // 4. sensitive directory (~/.ssh) blocked for master too
      const sshRes = await app.inject({ url: `/api/sessions/ses_1/fs/read?path=${encodeURIComponent('~/.ssh')}` });
      expect(sshRes.statusCode).toBe(403);

      // 5. session share link can list workspace subdirectory, cannot escape above workspace root
      const shared = { 'x-test-claim': 'session' };
      const wsSubRes = await app.inject({ url: `/api/sessions/ses_1/fs/read?path=docs`, headers: shared });
      expect(wsSubRes.statusCode).toBe(200);
      const wsSubBody = wsSubRes.json();
      expect(wsSubBody.kind).toBe('directory');
      expect(wsSubBody.entries).toHaveLength(1);
      expect(wsSubBody.entries[0].path).toBe('docs/guide.md');
      expect(wsSubBody.parentPath).toBeTruthy();

      const wsRootRes = await app.inject({ url: `/api/sessions/ses_1/fs/read?path=${encodeURIComponent(wsSubBody.parentPath)}`, headers: shared });
      expect(wsRootRes.statusCode).toBe(200);
      expect(wsRootRes.json().parentPath).toBeNull();

      // 6. session share link blocked from external directory and ~/
      expect((await app.inject({ url: `/api/sessions/ses_1/fs/read?path=${encodeURIComponent(externalDir)}`, headers: shared })).statusCode).toBe(403);
      expect((await app.inject({ url: `/api/sessions/ses_1/fs/read?path=${encodeURIComponent('~/projects/demo-site')}`, headers: shared })).statusCode).toBe(403);
    } finally {
      await app.close();
    }
  });
});
