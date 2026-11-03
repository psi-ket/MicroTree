import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig, type Plugin } from 'vite';

/**
 * Content Security Policy for production builds. The dev server needs inline
 * scripts for React Fast Refresh, so the policy is only injected at build time.
 * connect-src is limited to loopback runtimes.
 */
const CSP = [
  "default-src 'self'",
  "script-src 'self' 'wasm-unsafe-eval'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' blob: data:",
  "font-src 'self' data:",
  "worker-src 'self' blob:",
  "connect-src 'self' http://127.0.0.1:* http://localhost:* ws://127.0.0.1:* ws://localhost:*",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
].join('; ');

function contentSecurityPolicy(): Plugin {
  return {
    name: 'research-studio-csp',
    apply: 'build',
    transformIndexHtml: (html) =>
      html.replace('<!--csp-->', `<meta http-equiv="Content-Security-Policy" content="${CSP}" />`),
  };
}

const port = Number(process.env.RS_WEB_PORT ?? 5173);

export default defineConfig({
  plugins: [react(), tailwindcss(), contentSecurityPolicy()],
  server: { host: '127.0.0.1', port, strictPort: true },
  preview: { host: '127.0.0.1', port, strictPort: true },
  worker: { format: 'es' },
  build: {
    target: 'es2023',
    chunkSizeWarningLimit: 6000,
    sourcemap: true,
  },
  optimizeDeps: {
    include: ['monaco-editor', 'pdfjs-dist'],
  },
});
