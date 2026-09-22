import { cloudflareTest } from '@cloudflare/vitest-pool-workers'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts', 'scripts/**/*.test.ts'],
  },
  plugins: [
    cloudflareTest({
      wrangler: { configPath: './wrangler.test.jsonc' },
    }),
  ],
})
