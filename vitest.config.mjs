// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0.
// If a copy of the MPL was not distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// ABOUTME: Vitest configuration for testing Cloudflare Workers
// ABOUTME: Uses @cloudflare/vitest-pool-workers for Workers environment simulation

import { cloudflareTest } from '@cloudflare/vitest-pool-workers';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [cloudflareTest({
    wrangler: { configPath: './wrangler.toml' },
    miniflare: {
      // Stub the production service binding in the local Workers runtime.
      serviceBindings: {
        RELAY_ADMIN: () => new Response(JSON.stringify({ success: true }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' }
        }),
      },
    },
  })],
  test: {
    testTimeout: 30000,
    hookTimeout: 30000,
    // Scope test discovery to the canonical source/script locations.
    // Without this, vitest also walks .worktrees/ and .claude/worktrees/
    // and runs duplicate copies of every test (which can pull in code
    // referencing schemas/columns that don't exist on the current branch).
    include: ['src/**/*.test.mjs', 'scripts/**/*.test.mjs'],
    exclude: [
      '**/node_modules/**',
      '**/.worktrees/**',
      '**/.claude/worktrees/**',
      '**/.deploy-worktrees/**',
    ],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json-summary'],
      include: ['src/**/*.mjs'],
      exclude: ['src/**/*.test.mjs', 'src/**/*.test-helper.mjs', 'src/admin/*.html'],
    },
  },
});
