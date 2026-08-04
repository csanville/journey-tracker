import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    setupFiles: ['./src/test/setup.ts'],
    // `.tsx` too, since phase 7. Components are still kept thin with their logic
    // in tested `.ts` modules, but the dashboard is a page of branches — loading,
    // failed, empty, populated — and nothing else would ever execute them.
    include: ['src/**/*.test.{ts,tsx}'],
  },
})
