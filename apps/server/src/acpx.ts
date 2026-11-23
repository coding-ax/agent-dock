import { spawn, type SpawnOptions } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';

export function acpxPassThroughArgs(argv: readonly string[]) {
  return argv[2] === 'acpx' ? argv.slice(3) : undefined;
}

export interface AcpxLauncher { command: string; args: string[] }

export function resolveAcpxLauncher(moduleUrl = import.meta.url): AcpxLauncher {
  try {
    const require = createRequire(moduleUrl);
    const manifestPath = require.resolve('acpx/package.json');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { bin?: string | Record<string, string> };
    const relative = typeof manifest.bin === 'string' ? manifest.bin : manifest.bin?.acpx;
    if (relative) return { command: process.execPath, args: [resolve(dirname(manifestPath), relative)] };
  } catch {
    return { command: 'acpx', args: [] };
  }
  return { command: 'acpx', args: [] };
}

export function runAcpx(args: readonly string[], spawnProcess: typeof spawn = spawn, launcher: AcpxLauncher = resolveAcpxLauncher()) {
  return new Promise<number>((resolve, reject) => {
    const options: SpawnOptions = { stdio: 'inherit', env: process.env };
    const child = spawnProcess(launcher.command, [...launcher.args, ...args], options);
    child.once('error', reject);
    child.once('exit', (code, signal) => resolve(code ?? (signal ? 1 : 0)));
  });
}
