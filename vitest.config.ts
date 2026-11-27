import path from "node:path";
import { defineConfig } from "vitest/config";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";

export default defineConfig(async () => {
  const migrations = await readD1Migrations(path.join(import.meta.dirname, "migrations"));
  return {
    plugins: [
      cloudflareTest({
        wrangler: { configPath: "./wrangler.jsonc" },
        miniflare: {
          bindings: {
            PUBLIC_URL: "http://localhost/me",
            SESSION_SECRET: "test-session-secret-0123456789abcdef",
            DEV_LOGIN: "1",
            // No background activity fetch on sign-in (it would hit the real GitHub API); tests that cover it turn it on.
            SIGNIN_REFRESH: "0",
            // Rate limits only enforce when this is set (src/security.ts); keep them on so the tests cover them.
            PROXY_SECRET: "test-proxy-secret",
            TEST_MIGRATIONS: migrations,
          },
        },
      }),
    ],
    test: {
      include: ["test/**/*.test.ts"],
      setupFiles: ["./test/apply-migrations.ts"],
    },
  };
});
