import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts", "tests/**/*.test.ts"],
    coverage: {
      provider: "v8",
      reporter: ["text", "lcov"],
      include: [
        "src/core/serialize/**",
        "src/core/diff/**",
        "src/core/breakpoints/**",
        "src/core/usage/**",
        "src/core/diagnose/**",
        "src/core/pricing/**"
      ],
      thresholds: {
        // Enforced per file, not just on the aggregate — a well-covered
        // module (e.g. usage/gate.ts at 100%) can no longer mask a
        // weakly-covered one (e.g. core/diagnose or core/serialize
        // sitting below 90% branches) inside the same average.
        perFile: true,
        lines: 90,
        functions: 90,
        branches: 90,
        statements: 90
      }
    }
  }
});
