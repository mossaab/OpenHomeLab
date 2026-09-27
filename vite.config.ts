import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import path from 'path';
import {readFileSync} from 'fs';
import {defineConfig} from 'vite';

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf-8')) as {version: string};
const appVersion = process.env.APP_VERSION || pkg.version;

export default defineConfig(() => {
  return {
    plugins: [react(), tailwindcss()],
    define: {'__APP_VERSION__': JSON.stringify(appVersion)},
    resolve: {
      alias: {
        '@': path.resolve(__dirname, '.'),
      },
    },
    server: {
      // Do not modify: HMR and file watching are toggled via the DISABLE_HMR env var to prevent flickering during agent edits.
      hmr: process.env.DISABLE_HMR !== 'true',
      // Disable file watching when DISABLE_HMR is true to save CPU during agent edits.
      watch: process.env.DISABLE_HMR === 'true' ? null : {},
    },
  };
});
