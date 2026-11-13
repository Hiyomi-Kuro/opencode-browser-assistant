import { build } from 'vite';
import { resolve } from 'node:path';

await build();
await build({
  configFile: false,
  root: process.cwd(),
  logLevel: 'info',
  build: {
    outDir: 'dist', emptyOutDir: false,
    lib: { entry: resolve('src/content/content-script.ts'), name: 'OpenCodeContent', formats: ['iife'], fileName: () => 'content.js' },
    rollupOptions: { output: { inlineDynamicImports: true } },
  },
});
