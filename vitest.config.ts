import { defineConfig } from 'vitest/config';
import { fileURLToPath, URL } from 'node:url';

export default defineConfig({
  resolve: {
    alias: {
      '@agent-dock/agent-dock-acp-client': fileURLToPath(new URL('./packages/acp-client/src/index.ts', import.meta.url)),
      '@agent-dock/agent-dock-runtime': fileURLToPath(new URL('./packages/agent-runtime/src/index.ts', import.meta.url)),
      '@agent-dock/agent-dock-config': fileURLToPath(new URL('./packages/config/src/index.ts', import.meta.url)),
      '@agent-dock/agent-dock-renderer': fileURLToPath(new URL('./packages/renderer/src/index.ts', import.meta.url)),
      '@agent-dock/agent-dock-shared': fileURLToPath(new URL('./packages/shared/src/index.ts', import.meta.url)),
      '@agent-dock/agent-dock-storage': fileURLToPath(new URL('./packages/storage/src/index.ts', import.meta.url)),
      '@agent-dock/agent-dock-transports': fileURLToPath(new URL('./packages/transports/src/index.ts', import.meta.url))
    }
  },
  test: {
    include: ['packages/**/*.test.ts', 'apps/**/*.test.ts', 'tests/**/*.test.ts'],
    testTimeout: 15_000,
    hookTimeout: 15_000
  }
});
