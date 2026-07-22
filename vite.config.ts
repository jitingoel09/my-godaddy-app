import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import path from 'path';
import {defineConfig} from 'vite';

export default defineConfig(() => {
  return {
    plugins: [react(), tailwindcss()],
    resolve: {
      alias: {
        '@': path.resolve(__dirname, '.'),
      },
    },
    build: {
      cssMinify: true,
      minify: 'esbuild' as const,
      chunkSizeWarningLimit: 1000,
      // Manual chunking removed: a hand-written manualChunks() here previously grouped
      // packages by loose name matching, which split some libraries apart from their
      // own internal dependencies and created circular chunk dependencies (chunk A
      // needs chunk B to finish loading, and B needs A). Rollup's automatic chunking
      // computes the real dependency graph and does not produce this problem, at the
      // cost of slightly less control over exact bundle boundaries.
    },
    server: {
      // HMR is disabled in AI Studio via DISABLE_HMR env var.
      // Do not modifyâfile watching is disabled to prevent flickering during agent edits.
      hmr: false,
      watch: null,
    },
  };
});
