import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { crx } from '@crxjs/vite-plugin'
import manifest from './manifest.json'

export default defineConfig({
  plugins: [react(), crx({ manifest })],
  build: {
    // Chrome cannot load an extension whose sources are minified beyond
    // recognition during review; keep the output readable while we are
    // loading it unpacked.
    minify: false,
    sourcemap: true,
    rollupOptions: {
      // CRXJS discovers HTML entry points by reading the manifest, and the
      // dashboard is not in it: it is not the side panel, not a popup and not
      // an options page — it is a tab the panel opens by URL. Naming it here is
      // what gets it built at all. Without this the panel's link resolves to a
      // path that does not exist in `dist/`, which fails as a blank tab and
      // nowhere else.
      input: { dashboard: 'src/dashboard/index.html' },
    },
  },
})
