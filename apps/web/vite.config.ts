import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';

export default defineConfig({
  root: '.',
  publicDir: 'public',
  plugins: [
    // Lit shell stays the host; React is opt-in per-file via .tsx.
    // The Privy login UI is a tiny React island (src/privy-island.tsx) — Lit
    // owns everything else. plugin-react gives us esbuild-based JSX + Fast
    // Refresh for the .tsx files without touching the Lit build path.
    react({ include: /\.tsx$/ }),
  ],
  resolve: {
    alias: {
      '@': resolve(__dirname, 'src'),
      '@nexa/shared-zod': resolve(__dirname, '../../packages/shared-zod/src/index.ts'),
    },
  },
  // Privy's transitive deps (viem, ox, wagmi internals) ship class fields +
  // top-level destructuring that fail esbuild's default browser baseline.
  // Hold the dev-server pre-bundler and source transform on esnext to match
  // the production build target.
  esbuild: { target: 'esnext' },
  optimizeDeps: {
    esbuildOptions: { target: 'esnext' },
  },
  build: {
    target: 'esnext',
    outDir: 'dist',
    emptyOutDir: true,
    sourcemap: false,
    rollupOptions: {
      input: {
        index: resolve(__dirname, 'index.html'),
        app: resolve(__dirname, 'app.html'),
        landing: resolve(__dirname, 'landing.html'),
        portal: resolve(__dirname, 'portal.html'),
        checkout: resolve(__dirname, 'checkout.html'),
        developers: resolve(__dirname, 'developers.html'),
        admin: resolve(__dirname, 'admin.html'),
      },
    },
  },
  server: {
    // Ports are env-overridable so the e2e suite (and a second checkout) can
    // run beside a live dev stack without EADDRINUSE. Defaults unchanged.
    port: Number(process.env['NEXA_WEB_PORT'] ?? 5173),
    proxy: {
      '/api': {
        target: `http://localhost:${process.env['NEXA_API_PORT'] ?? 8090}`,
        changeOrigin: true,
        ws: true,
        rewrite: (path) => path.replace(/^\/api/, ''),
      },
    },
  },
});
