export type GuardRollout = {
  id: string;
  check: readonly string[];
  rules?: readonly string[];
} & (
  | { type: "changed-lines"; expiresAt: string }
  | { type: "full" }
  | { type: "autofix"; generator: string }
);

export const GUARD_ROLLOUTS: readonly GuardRollout[] = [
  {
    id: "portable-path",
    rules: ["no-raw-path-relative/no-raw-path-relative"],
    type: "full",
    check: [
      "bun",
      "--bun",
      "oxlint",
      "-c",
      "oxlint.config.ts",
      "--allow",
      "all",
      "--deny",
      "no-raw-path-relative/no-raw-path-relative",
      ".",
    ],
  },
  {
    id: "central-test-timeout",
    type: "full",
    check: ["bun", "scripts/check-oxlint-test-timeouts.ts"],
  },
  {
    id: "worker-database-login-posture",
    rules: [
      "require-worker-database-login-posture/require-worker-database-login-posture",
    ],
    type: "full",
    check: [
      "bun",
      "--bun",
      "oxlint",
      "-c",
      "oxlint.config.ts",
      "--allow",
      "all",
      "--deny",
      "require-worker-database-login-posture/require-worker-database-login-posture",
      "apps/api/src",
    ],
  },
  {
    id: "tracked-symlinks",
    type: "full",
    check: ["bun", "scripts/check-tracked-symlinks.ts"],
  },
  {
    id: "no-direct-decision-identifier-column-write",
    rules: [
      "no-direct-decision-identifier-column-write/no-direct-decision-identifier-column-write",
    ],
    type: "changed-lines",
    expiresAt: "2026-11-05T00:00:00.000Z",
    check: [
      "bun",
      "--bun",
      "oxlint",
      "-c",
      "oxlint.config.ts",
      "--allow",
      "all",
      "--deny",
      "no-direct-decision-identifier-column-write/no-direct-decision-identifier-column-write",
      ".",
    ],
  },
  {
    id: "no-ambient-time-in-tests",
    rules: ["no-ambient-time-in-tests/no-ambient-time-in-tests"],
    type: "changed-lines",
    expiresAt: "2026-11-05T00:00:00.000Z",
    check: [
      "bun",
      "--bun",
      "oxlint",
      "-c",
      "oxlint.config.ts",
      "--allow",
      "all",
      "--deny",
      "no-ambient-time-in-tests/no-ambient-time-in-tests",
      ".",
    ],
  },
  {
    id: "no-real-timers-in-tests",
    rules: ["no-real-timers-in-tests/no-real-timers-in-tests"],
    type: "changed-lines",
    expiresAt: "2026-11-05T00:00:00.000Z",
    check: [
      "bun",
      "--bun",
      "oxlint",
      "-c",
      "oxlint.config.ts",
      "--allow",
      "all",
      "--deny",
      "no-real-timers-in-tests/no-real-timers-in-tests",
      ".",
    ],
  },
  {
    id: "no-wallclock-assertions-in-tests",
    rules: [
      "no-wallclock-assertions-in-tests/no-wallclock-assertions-in-tests",
    ],
    type: "changed-lines",
    expiresAt: "2026-11-05T00:00:00.000Z",
    check: [
      "bun",
      "--bun",
      "oxlint",
      "-c",
      "oxlint.config.ts",
      "--allow",
      "all",
      "--deny",
      "no-wallclock-assertions-in-tests/no-wallclock-assertions-in-tests",
      ".",
    ],
  },
] as const;
