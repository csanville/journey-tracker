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
  },
})
