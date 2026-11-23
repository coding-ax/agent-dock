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

async function buildApp(options: { cwd: string; sshHost?: string; homeDir: string; tempDir: string }) {
  const app = Fastify();
  app.addHook('onRequest', async request => {
    (request as unknown as { webClaim: { kind: string } }).webClaim = {
      kind: request.headers['x-test-claim'] === 'session' ? 'session' : 'master'
    };
  });
  await registerFsRoutes(
    app,
    { getSession: async () => ({ id: 'ses_1', cwd: options.cwd, ...(options.sshHost ? { sshHost: options.sshHost } : {}) }) } as any,
    { homeDir: options.homeDir, tempDir: options.tempDir }
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
      // master: allowed in cwd, ~/.gemini, tempDir, uploads
      const ownerGemini = await app.inject({ url: `/api/sessions/ses_1/fs/read?path=${encodeURIComponent(geminiArtifact)}` });
      expect(ownerGemini.statusCode).toBe(200);
      expect(ownerGemini.json().content).toBe('# Gemini Artifact');

      const ownerTemp = await app.inject({ url: `/api/sessions/ses_1/fs/read?path=${encodeURIComponent(tempArtifact)}` });
      expect(ownerTemp.statusCode).toBe(200);
      expect(ownerTemp.json().content).toBe('temp output');

      // master: blocked outside allowlist & symlink escape (note: outsideDir is inside os.tmpdir() in test env, so test against /etc/hosts or similar real outside path if needed)
      const escapeFromCwd = await app.inject({ url: `/api/sessions/ses_1/fs/read?path=linked-outside.txt` });
      expect(escapeFromCwd.statusCode).toBe(400);

      // session: allowed in cwd and own uploads only
      const shared = { 'x-test-claim': 'session' };
      expect((await app.inject({ url: `/api/sessions/ses_1/fs/read?path=inside.md`, headers: shared })).statusCode).toBe(200);
      expect((await app.inject({ url: `/api/sessions/ses_1/fs/read?path=${encodeURIComponent(insideFile)}`, headers: shared })).statusCode).toBe(200);
      expect((await app.inject({ url: `/api/sessions/ses_1/fs/read?path=${encodeURIComponent(sessionUpload)}`, headers: shared })).statusCode).toBe(200);

      // session: blocked from other session uploads, ~/.gemini, tempDir, symlink escape
      expect((await app.inject({ url: `/api/sessions/ses_1/fs/read?path=${encodeURIComponent(otherSessionUpload)}`, headers: shared })).statusCode).toBe(403);
      expect((await app.inject({ url: `/api/sessions/ses_1/fs/read?path=${encodeURIComponent(geminiArtifact)}`, headers: shared })).statusCode).toBe(403);
      expect((await app.inject({ url: `/api/sessions/ses_1/fs/read?path=${encodeURIComponent(tempArtifact)}`, headers: shared })).statusCode).toBe(403);
      expect((await app.inject({ url: `/api/sessions/ses_1/fs/read?path=linked-outside.txt`, headers: shared })).statusCode).toBe(400);
      expect((await app.inject({ url: `/api/sessions/ses_1/fs/list?path=${encodeURIComponent(root)}`, headers: shared })).statusCode).toBe(400);
    } finally {
      await app.close();
    }
  });

  it('blocks master from reading non-allowlisted system paths and symlink escapes to them', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agentdock-escape-'));
    directories.push(root);
    const workspace = join(root, 'workspace');
    const homeDir = join(root, 'home');
    await mkdir(workspace, { recursive: true });
    await mkdir(homeDir, { recursive: true });
    // /etc/hosts exists on macOS/Linux and is outside cwd, ~/.gemini, /tmp
    await symlink('/etc/hosts', join(workspace, 'hosts-link.txt'));

    const app = await buildApp({ cwd: workspace, homeDir, tempDir: root });
    try {
      expect((await app.inject({ url: `/api/sessions/ses_1/fs/read?path=${encodeURIComponent('/etc/hosts')}` })).statusCode).toBe(403);
      expect((await app.inject({ url: `/api/sessions/ses_1/fs/read?path=hosts-link.txt` })).statusCode).toBe(400);
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
});
