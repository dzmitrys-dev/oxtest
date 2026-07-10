import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'vite';

// Bonus A SPA build config. The built bundle is served static by the API on the
// SAME origin (D-04), so the runtime GraphQL URL is the RELATIVE `/graphql` (see
// src/main.tsx). The dev proxy below is a LOCAL-DEV CONVENIENCE ONLY — it lets
// `npm run dev --workspace apps/web` reach a locally running API on :3000; it
// has no effect on the production `vite build` output. `base` stays at the
// default '/' because the SPA is served from the origin root (RESEARCH Pitfall 7).
export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    proxy: {
      '/graphql': 'http://localhost:3000',
    },
  },
});
