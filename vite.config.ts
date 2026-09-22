import { defineConfig } from 'vite';

export default defineConfig({
  server: {
    port: 47290,
    host: true,
    strictPort: true,
    proxy: {
      '/ws': { target: 'ws://localhost:47291', ws: true },
    },
  },
  build: { chunkSizeWarningLimit: 2000 },
});
