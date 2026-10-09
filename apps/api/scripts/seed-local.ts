/**
 * Seed a local stack for someone (or something) about to drive it: the test
 * user with its session and Playwright storage state, then the fixture
 * matters, contacts and documents in the test organization.
 *
 * `seed-dev.ts` alone targets whichever session was active last; this pins it
 * to the test organization so every seeded stack has the same content.
 *
 * Usage (the dev runner's `--seed` runs it with the stack's environment):
 *   bun run db:seed-local
 */

import { childExitStatus } from "@stll/scripts/src/child-exit-status";

import { DEFAULT_ORG_ID, DEFAULT_USER_ID } from "./seed-utils";

const SEED_SCRIPTS = [
  "seed-test-user.ts",
  "seed-dev.ts",
  "seed-legislation.ts",
] as const;

for (const script of SEED_SCRIPTS) {
  const startedAt = performance.now();
  const child = Bun.spawn({
    cmd: [
      process.execPath,
      `${import.meta.dir}/${script}`,
      ...(script === "seed-dev.ts" ? ["--seed-recents"] : []),
    ],
    env: {
      ...process.env,
      STELLA_SEED_ORG_ID: DEFAULT_ORG_ID,
      STELLA_SEED_USER_ID: DEFAULT_USER_ID,
    },
    stderr: "inherit",
    stdout: "inherit",
  });
  await child.exited;
  const exitCode = childExitStatus(child);
  if (exitCode !== 0) {
    process.exit(exitCode);
  }
  const seconds = (performance.now() - startedAt) / 1000;
  console.log(`    ${script} took ${seconds.toFixed(1)} s`);
}
