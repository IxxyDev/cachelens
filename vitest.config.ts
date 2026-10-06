import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    // Builds dist once, before any worker spawns the CLI (src/e2e/cli.test.ts,
    // src/cli/bin-entry.test.ts); a no-op when dist is newer than src.
    globalSetup: ["src/e2e/build-dist.ts"],
    coverage: {
      provider: "v8",
      reporter: ["text", "lcov"],
      include: ["src/**/*.ts"],
      exclude: [
        "src/**/*.test.ts",
        // One-off fixture generators run by hand (`npm run generate:*`); their
        // output is checked in under fixtures/ and exercised by the e2e tests.
        "src/scripts/**",
        // Test infrastructure (vitest globalSetup that builds dist), not shipped.
        "src/e2e/build-dist.ts"
      ],
      thresholds: {
        // Enforced per file, not just on the aggregate: a well-covered module
        // cannot mask a weakly-covered one inside the same average.
        perFile: true,
        lines: 85,
        functions: 85,
        branches: 85,
        statements: 85
      }
    }
  }
});
