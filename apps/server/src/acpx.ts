import { spawn, type SpawnOptions } from 'node:child_process';

export function acpxPassThroughArgs(argv: readonly string[]) {
  return argv[2] === 'acpx' ? argv.slice(3) : undefined;
}

export function runAcpx(args: readonly string[], spawnProcess: typeof spawn = spawn) {
  return new Promise<number>((resolve, reject) => {
    const options: SpawnOptions = { stdio: 'inherit', env: process.env };
    const child = spawnProcess('acpx', [...args], options);
    child.once('error', reject);
    child.once('exit', (code, signal) => resolve(code ?? (signal ? 1 : 0)));
  });
}
