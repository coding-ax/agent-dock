# AgentDock Desktop

A thin Electron shell around the AgentDock web UI. Launching the app is enough:
it starts a bundled daemon on a stable loopback port, waits for `/health`, and
loads the normal console. Closing the window stops the daemon and every agent
process below it.

## Why Electron

AgentDock's server is a Node bundle with native modules (`better-sqlite3`,
`node-pty`) that spawns agent CLIs. Electron lets us ship one runtime that hosts
both the UI and the server; Tauri would still need a Node sidecar plus a second
IPC layer. electron-builder also gives installers and macOS/Windows signing with
no custom tooling.

## Development

```bash
pnpm build
pnpm --filter @agent-dock/desktop dev
# point at a different build / Node binary:
AGENTDOCK_DESKTOP_CLI=$PWD/apps/server/dist/cli.js \
AGENTDOCK_DESKTOP_NODE=$(which node) \
pnpm --filter @agent-dock/desktop dev
```

Dev mode uses the workspace build directly; no runtime assembly is needed.

## Packaging

```bash
pnpm build
# local, using the current Node (not a downloaded copy):
AGENTDOCK_DESKTOP_NODE_BIN=$(which node) pnpm --filter @agent-dock/desktop pack:dir
# production installers (downloads Node 24.16.0 for the current platform):
pnpm --filter @agent-dock/desktop dist
```

`scripts/prepare-runtime.mjs` runs `pnpm deploy --prod --legacy` for
`@agent-dock/cli` (keeping the workspace's patched acpx and Lark SDK) and puts a
standalone Node binary next to it. Both are bundled through `extraResources`.

Outputs land in `apps/desktop/release/`.

## CI / signing

`.github/workflows/desktop.yml` builds macOS (arm64 + x64) and Windows x64 on
native runners. Linux has no desktop shell; it uses the CLI + Web UI. Tag `v*`
publishes a GitHub Release whose body links the matching npm package and whose
assets are the installers. The workflow verifies every macOS bundle with
`codesign --verify --deep --strict` and fails if a configured certificate did
not produce a Developer ID signature.

### macOS

electron-builder selects the signing mode automatically:

| Situation | Result |
| --- | --- |
| `CSC_LINK` + `CSC_KEY_PASSWORD` (CI) | Developer ID Application signature |
| `CSC_NAME`, or a Developer ID identity in the keychain (local) | Developer ID Application signature |
| neither | ad-hoc signature (`-`) |

Ad-hoc signing is the default when no certificate exists. It matters: renaming
`Electron.app` invalidates the framework's original linker signature, and macOS
then reports the app as *damaged*. An ad-hoc signature keeps the bundle
structurally valid and signs the bundled Node runtime and native modules too, so
the app launches. It is still **not notarized**, so recipients see “Apple could
not verify … is free of malware” and must allow the app once via System
Settings → Privacy & Security → Open Anyway (or right-click → Open).

Gatekeeper-clean distribution needs the paid Apple Developer Program
(US$99/year): create a **Developer ID Application** certificate and export it
as `.p12`. Notarization then needs either an Apple ID app-specific password or
an App Store Connect API key.

| Secret | Value |
| --- | --- |
| `MAC_CERT_P12` | base64-encoded `.p12` |
| `MAC_CERT_PASSWORD` | `.p12` export password |
| `APPLE_ID` / `APPLE_APP_SPECIFIC_PASSWORD` / `APPLE_TEAM_ID` | notarization via Apple ID |
| `APPLE_API_KEY_P8` / `APPLE_API_KEY_ID` / `APPLE_API_ISSUER` | notarization via App Store Connect API key (`.p8`, base64) |

The certificate secrets sign; the `APPLE_*` secrets notarize. Setting only the
certificate produces a valid but unnotarized app. Locally, export
`CSC_NAME="Developer ID Application: …"` and the same `APPLE_*` variables
before `pnpm dist`.

### Windows

- `.pfx` certificate: `WIN_CERT_P12` + `WIN_CERT_PASSWORD`. OV certificates
  satisfy SmartScreen only after reputation accumulates; EV certificates are
  trusted immediately but cost more.
- Azure Trusted Signing (no `.pfx`): set `AZURE_SIGNING_ENDPOINT`,
  `AZURE_SIGNING_ACCOUNT`, `AZURE_SIGNING_PROFILE`, optionally
  `AZURE_SIGNING_PUBLISHER`, plus Entra service-principal credentials
  `AZURE_TENANT_ID`, `AZURE_CLIENT_ID`, `AZURE_CLIENT_SECRET`. electron-builder
  installs the `TrustedSigning` PowerShell module on the runner itself.
- OSS projects can apply for free signing through SignPath.

Linux AppImage is not code signed; publish a SHA-256 checksum with the release.
Native modules and the bundled Node runtime are architecture-specific, which is
why each arch is built on a matching runner instead of cross-compiled.

## Runtime layout

```
AgentDock.app/Contents/Resources/
  agentdock/       @agent-dock/cli dist + node_modules + public/
  node-runtime/    node (or node.exe)
```

User data (database, logs, window state) lives under Electron's `userData`
directory (`~/Library/Application Support/AgentDock` on macOS).
