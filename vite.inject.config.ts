import { defineConfig } from 'vite'

/**
 * A second, deliberately separate build for the injected content script.
 *
 * The main build is driven by CRXJS, which compiles the declared content script
 * into a small loader that dynamically `import()`s the real module. That works
 * on the boards the manifest matches, because CRXJS lists those modules in
 * `web_accessible_resources` for exactly those origins — and it cannot work
 * anywhere else, which is precisely where `activeTab` capture is aimed.
 *
 * So the injected script is built on its own terms: one IIFE, every dependency
 * inlined, nothing to fetch at runtime. `chrome.scripting.executeScript` can put
 * a file like that onto any tab the user has granted, with no
 * `web_accessible_resources` entry involved at all.
 *
 * The filename is fixed rather than hashed. Everything else in the build is
 * content-hashed and resolved through the manifest, but this one is named by the
 * worker at injection time — see `lib/capture.ts`, which would otherwise have to
 * guess a hash.
 */
export default defineConfig({
  build: {
    outDir: 'dist',
    // The CRXJS build ran first and this one adds to it. Without this, Vite
    // would clear the directory and take the rest of the extension with it.
    emptyOutDir: false,
    minify: false,
    sourcemap: true,
    lib: {
      entry: 'src/content/injected.ts',
      formats: ['iife'],
      name: 'JourneyTrackerCapture',
      fileName: () => 'injected.js',
    },
  },
})
