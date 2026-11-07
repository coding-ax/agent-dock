import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';
const apiTarget = process.env.AGENTDOCK_API_URL ?? 'http://127.0.0.1:4310';
export default defineConfig({
  plugins: [react()],
  server: { port: 4311, proxy: { '/api': { target: apiTarget, ws: true, changeOrigin: true } } },
  build: {
    rollupOptions: {
      input: {
        main: resolve(__dirname, 'index.html'),
        sourcesRouter: resolve(__dirname, 'sources-router.html')
      },
      output: {
        manualChunks(id) {
          if (id.includes('/prism-react-renderer/')) return 'syntax-highlighter';
        }
      }
    }
  }
});
