import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

/**
 * Vite config for the webview bundle of the graph panel.
 *
 * Output file names are fixed (no content hash) so the extension host can
 * reference `dist/webview/index.js` and `dist/webview/index.css` directly.
 * The Explorer side view has its own build (`vite.mini.config.mts`): one
 * self-contained file per webview keeps the CSP to a single nonce'd script.
 */
export default defineConfig({
  root: 'src/webview',
  base: './',
  plugins: [react()],
  build: {
    outDir: '../../dist/webview',
    emptyOutDir: true,
    cssCodeSplit: false,
    sourcemap: true,
    rolldownOptions: {
      output: {
        entryFileNames: 'index.js',
        chunkFileNames: '[name].js',
        assetFileNames: 'index.[ext]',
      },
    },
  },
});
