'use strict';

const { execFileSync } = require('node:child_process');
const path = require('node:path');
// The desktop shell ships the CLI, so it is versioned by the CLI package.
// CI bumps apps/server/package.json; reading it here keeps the installer name,
// the bundle version and the npm release on the same version without a second
// file to update.
const { version: appVersion } = require('../server/package.json');

const entitlementsPath = path.join(__dirname, 'build', 'entitlements.mac.plist');

// CI passes optional signing secrets through environment variables; an
// unconfigured GitHub secret arrives as an empty string rather than being
// unset. electron-builder treats a present-but-empty CSC_LINK as a certificate
// path, resolves it to the project directory and aborts with
// "…/apps/desktop not a file". Remove the empty values before it reads them so
// a run without signing secrets falls back to ad-hoc signing on macOS.
for (const key of ['CSC_LINK', 'CSC_KEY_PASSWORD', 'CSC_NAME']) {
  if (process.env[key] === '') delete process.env[key];
}

/**
 * Real macOS signing needs a "Developer ID Application" certificate, either
 * imported through CSC_LINK (CI) or already present in the login keychain.
 * When neither exists we sign ad-hoc (`-`) instead of shipping an unsigned
 * bundle: renaming Electron.app invalidates its linker signature, and macOS
 * then reports the app as *damaged* rather than offering "Open Anyway".
 * Ad-hoc builds are still not notarized and still require a manual first
 * launch, but they are structurally valid and their nested binaries are
 * signed too (electron-builder walks Contents and signs every Mach-O file,
 * including the bundled Node runtime).
 */
function hasDeveloperIdIdentity() {
  if (process.platform !== 'darwin') return false;
  try {
    const output = execFileSync('/usr/bin/security', ['find-identity', '-v', '-p', 'codesigning'], { encoding: 'utf8' });
    return /Developer ID Application/.test(output);
  } catch {
    return false;
  }
}

const autoDiscovery = process.env.CSC_IDENTITY_AUTO_DISCOVERY !== 'false';
const macIdentity = process.env.CSC_LINK || process.env.CSC_NAME || (autoDiscovery && hasDeveloperIdIdentity()) ? undefined : '-';

// electron-builder's signer (@electron/osx-sign) walks the whole bundle and
// probes every file with isBinaryFile in parallel. The bundled CLI runtime has
// ~14k files, which exhausts the file-descriptor limit on macOS runners and
// aborts with EMFILE. For ad-hoc builds, skip that signer and run native
// codesign on the finished bundle in afterPack instead; codesign handles large
// bundles without opening them all at once. Builds with a real certificate
// keep using electron-builder's signer (and notarization).
const adHocSign = macIdentity === '-';

// All notarization credentials are read by electron-builder from the
// environment; the option here only turns the step on or off. Supported:
// APPLE_ID + APPLE_APP_SPECIFIC_PASSWORD + APPLE_TEAM_ID, or
// APPLE_API_KEY (path to .p8) + APPLE_API_KEY_ID + APPLE_API_ISSUER, or
// APPLE_KEYCHAIN_PROFILE (+ optional APPLE_KEYCHAIN).
const notarizeMac = Boolean(
  (process.env.APPLE_ID && process.env.APPLE_APP_SPECIFIC_PASSWORD && process.env.APPLE_TEAM_ID) ||
  (process.env.APPLE_API_KEY && process.env.APPLE_API_KEY_ID && process.env.APPLE_API_ISSUER) ||
  process.env.APPLE_KEYCHAIN_PROFILE
);

/** Optional Windows Azure Trusted Signing (no .pfx needed). */
const azureSigning = process.env.AZURE_SIGNING_ENDPOINT && process.env.AZURE_SIGNING_ACCOUNT && process.env.AZURE_SIGNING_PROFILE
  ? {
      publisherName: process.env.AZURE_SIGNING_PUBLISHER || 'AgentDock',
      endpoint: process.env.AZURE_SIGNING_ENDPOINT,
      codeSigningAccountName: process.env.AZURE_SIGNING_ACCOUNT,
      certificateProfileName: process.env.AZURE_SIGNING_PROFILE
    }
  : null;

/** @type {import('electron-builder').Configuration} */
module.exports = {
  appId: 'com.agentdock.desktop',
  productName: 'AgentDock',
  copyright: 'Copyright © AgentDock',
  extraMetadata: {
    version: appVersion
  },
  // electron-updater reads this from app-update.yml at runtime. CI still uses
  // --publish never and uploads the installers + latest*.yml to the GitHub
  // release itself; the explicit provider makes electron-builder generate
  // those update metadata files and the embedded config even without a
  // repository field on this private workspace package.
  publish: [{ provider: 'github', owner: 'coding-ax', repo: 'agent-dock' }],
  directories: {
    output: 'release',
    buildResources: 'build'
  },
  // The daemon and the Node runtime are extraResources, not asar entries: they
  // are spawned as real executables and must stay unpacked.
  files: ['src/**/*', 'package.json', 'build/icon.png'],
  // Map the whole runtime directory, not each child: electron-builder's copy
  // filter always drops a `node_modules` directory that sits at the root of a
  // file set. Here it is `agentdock/node_modules`, i.e. nested, and survives.
  extraResources: [
    { from: 'runtime', to: '.' }
  ],
  asar: true,
  compression: 'maximum',
  artifactName: '${productName}-${version}-${os}-${arch}.${ext}',
  // Runs before electron-builder's own signing step. Only used for the ad-hoc
  // path; everything else goes through electron-builder as before.
  afterPack: async context => {
    if (!adHocSign || context.electronPlatformName !== 'darwin') {
      return;
    }
    const appPath = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);
    console.log(`[desktop] ad-hoc signing ${appPath}`);
    execFileSync('/usr/bin/codesign', [
      '--force',
      '--deep',
      '--sign',
      '-',
      '--options',
      'runtime',
      '--entitlements',
      entitlementsPath,
      appPath
    ], { stdio: 'inherit' });
  },
  mac: {
    target: ['dmg', 'zip'],
    category: 'public.app-category.developer-tools',
    icon: 'build/icon.png',
    identity: adHocSign ? null : macIdentity,
    hardenedRuntime: true,
    // Ad-hoc + hardened runtime is only safe because the entitlements below
    // include com.apple.security.cs.disable-library-validation.
    gatekeeperAssess: false,
    entitlements: entitlementsPath,
    entitlementsInherit: entitlementsPath,
    notarize: notarizeMac ? { teamId: process.env.APPLE_TEAM_ID } : false
  },
  dmg: {
    sign: false
  },
  win: {
    target: ['nsis'],
    icon: 'build/icon.png',
    ...(azureSigning ? { azureSignOptions: azureSigning } : {})
  },
  nsis: {
    oneClick: false,
    perMachine: false,
    allowToChangeInstallationDirectory: true,
    deleteAppDataOnUninstall: false
  },
  linux: {
    target: ['AppImage'],
    icon: 'build/icon.png',
    category: 'Development',
    maintainer: 'AgentDock'
  }
};
