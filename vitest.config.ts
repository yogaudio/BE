import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

export default defineConfig(async () => {
  const migrations = await readD1Migrations("./migrations");
  return {
    plugins: [
      cloudflareTest({
        wrangler: { configPath: "./wrangler.toml" },
        miniflare: {
          // Fake secrets so a fresh clone without .dev.vars passes.
          bindings: {
            MEMBERSTACK_SECRET_KEY: "sk_fake_memberstack",
            WEBFLOW_TOKEN: "fake-webflow-token",
            TOKEN_SIGNING_KEY: "fake-signing-key-at-least-32-bytes-long-000",
            TEST_MIGRATIONS: migrations,
          },
        },
      }),
    ],
    test: { setupFiles: ["./test/setup.ts"] },
  };
});
