import { execSync } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

/**
 * Test infrastructure, not shipped (tsconfig.build.json excludes src/e2e). Used as a vitest
 * globalSetup so the build runs once, in the main process, before any test file spawns the
 * CLI; test files call it again in beforeAll, where it is a cheap mtime check.
 */
const ROOT = resolve(import.meta.dirname, "../..");
export const CLI_ENTRY = join(ROOT, "dist/cli/index.js");

function newestSourceMtimeMs(dir: string): number {
  let newest = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      newest = Math.max(newest, newestSourceMtimeMs(path));
    } else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) {
      newest = Math.max(newest, statSync(path).mtimeMs);
    }
  }
  return newest;
}

/** Builds dist when it is missing or older than any non-test source file or build config. */
export function ensureDistBuilt(): void {
  const builtAt = existsSync(CLI_ENTRY) ? statSync(CLI_ENTRY).mtimeMs : 0;
  const sourceAt = Math.max(
    newestSourceMtimeMs(join(ROOT, "src")),
    statSync(join(ROOT, "tsconfig.json")).mtimeMs,
    statSync(join(ROOT, "tsconfig.build.json")).mtimeMs
  );
  if (builtAt > sourceAt) return;
  execSync("npm run build", { cwd: ROOT, stdio: "ignore" });
}

export default ensureDistBuilt;
