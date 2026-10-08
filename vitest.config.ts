import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: {
        // Test-only secrets. Real ones come from `wrangler secret put`.
        bindings: {
          AUTH_SECRET: "test-auth-secret-0123456789abcdef0123456789abcdef",
          TOKEN_SECRET: "test-token-secret-fedcba9876543210fedcba9876543210",
        },
        // Raise the limit so the suite itself never trips the real limiter;
        // the 429 path is tested with a stub binding.
        ratelimits: {
          RATE_LIMITER: { namespace_id: "1001", simple: { limit: 10000, period: 60 } },
        },
      },
    }),
  ],
  test: {
    include: ["test/**/*.test.ts"],
  },
});
