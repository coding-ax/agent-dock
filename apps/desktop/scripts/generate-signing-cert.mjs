#!/usr/bin/env node
/**
 * Generate the fixed self-signed code-signing certificate used by the desktop
 * release builds.
 *
 * Why a fixed certificate: Squirrel.Mac validates an update against the
 * running app's designated requirement. An ad-hoc signature pins that
 * requirement to the build's cdhash, so every new build fails the check and
 * auto-update silently breaks. Reusing one certificate across releases makes
 * the requirement stable, which is all Squirrel.Mac needs. It is not a
 * Developer ID and not notarized, so the first launch still needs the
 * "隐私与安全性 → 仍要打开" approval.
 *
 * Keep the generated .p12 forever: changing it means installed clients can no
 * longer verify updates and need one manual reinstall.
 *
 *   pnpm --filter @agent-dock/desktop signing:generate
 *   pnpm --filter @agent-dock/desktop signing:generate -- --password "..." --force
 *
 * Then set the GitHub Actions secrets:
 *   MAC_CERT_P12       base64 of agentdock-signing.p12 (printed below)
 *   MAC_CERT_PASSWORD  the password printed below
 */

import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const valueOf = (name, fallback) => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
};
const has = name => args.includes(`--${name}`);
const fail = message => {
  console.error(`[signing-cert] ${message}`);
  process.exit(1);
};
const run = (command, argv) => {
  const result = spawnSync(command, argv, { stdio: 'inherit' });
  if (result.error) fail(`${command}: ${result.error.message}`);
  if (result.status !== 0) fail(`${command} exited with ${result.status}`);
};

const outDir = resolve(valueOf('out', join(here, '..', '.signing')));
const name = valueOf('name', 'AgentDock Code Signing');
const days = valueOf('days', '3650');
const password = valueOf('password', randomBytes(18).toString('base64url'));
const openssl = process.env.OPENSSL || 'openssl';

const p12File = join(outDir, 'agentdock-signing.p12');
if (existsSync(p12File) && !has('force')) {
  fail(`${p12File} already exists. Reuse it for every release, or pass --force to replace it (old clients will lose automatic updates).`);
}

mkdirSync(outDir, { recursive: true });
const keyFile = join(outDir, 'agentdock-signing.key.pem');
const certFile = join(outDir, 'agentdock-signing.crt.pem');
const configFile = join(outDir, 'openssl.cnf');
const base64File = join(outDir, 'agentdock-signing.p12.base64');

// LibreSSL (macOS system openssl) does not support `-addext`, so keep the
// extensions in a config file that both LibreSSL and OpenSSL 3 understand.
const config = `[req]
distinguished_name = dn
x509_extensions = codesign
prompt = no

[dn]
CN = ${name}
O = AgentDock

[codesign]
basicConstraints = critical,CA:FALSE
keyUsage = critical,digitalSignature
extendedKeyUsage = critical,codeSigning
subjectKeyIdentifier = hash
`;
writeFileSync(configFile, config);

console.log(`[signing-cert] ${openssl} self-signed certificate → ${outDir}`);
run(openssl, ['req', '-x509', '-newkey', 'rsa:2048', '-sha256', '-nodes', '-days', days, '-keyout', keyFile, '-out', certFile, '-config', configFile]);
run(openssl, ['pkcs12', '-export', '-out', p12File, '-inkey', keyFile, '-in', certFile, '-name', name, '-passout', `pass:${password}`]);
rmSync(configFile, { force: true });

const base64 = readFileSync(p12File).toString('base64');
writeFileSync(base64File, `${base64}\n`);

console.log('');
console.log('[signing-cert] done:');
console.log(`  certificate : ${certFile}`);
console.log(`  private key : ${keyFile}`);
console.log(`  p12 bundle  : ${p12File}`);
console.log(`  base64      : ${base64File}`);
console.log('');
console.log('GitHub Actions secrets:');
console.log(`  MAC_CERT_P12=${base64File} 的内容（整行 base64）`);
console.log(`  MAC_CERT_PASSWORD=${password}`);
console.log('');
console.log('Keep this certificate for every future release. Replacing it breaks');
console.log('auto-update for already-installed clients (they need one manual reinstall).');
console.log('Back up .signing/ outside the repository; it is gitignored.');
