import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

/**
 * Vite config for the webview bundle of the Explorer side view ("CodeGraph"
 * mini graph): `dist/webview/mini.js` and `dist/webview/mini.css`.
 *
 * Runs after the panel build (which empties the folder), so it keeps the
 * folder's content.
 */
export default defineConfig({
  root: 'src/webview',
  base: './',
  plugins: [react()],
  build: {
    outDir: '../../dist/webview',
    emptyOutDir: false,
    cssCodeSplit: false,
    sourcemap: true,
    rolldownOptions: {
      input: 'src/webview/mini.html',
      output: {
        entryFileNames: 'mini.js',
        chunkFileNames: 'mini-[name].js',
        assetFileNames: 'mini.[ext]',
      },
    },
  },
});
