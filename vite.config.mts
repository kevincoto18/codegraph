import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

/**
 * Vite config for the webview bundle.
 *
 * Output file names are fixed (no content hash) so the extension host can
 * reference `dist/webview/index.js` and `dist/webview/index.css` directly.
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
