// UI verification only. Not an input of the extension build or release ZIP.
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import path from 'node:path';
export default defineConfig({ plugins: [react(), tailwindcss()], resolve: { alias: { '@': path.resolve(__dirname, 'src') } }, server: { host: '127.0.0.1', port: 5174, strictPort: true }, build: { rollupOptions: { input: 'preview/index.html' }, outDir: 'preview-dist' } });
