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
    type: "changed-lines",
    expiresAt: "2026-10-20T00:00:00.000Z",
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
    type: "changed-lines",
    expiresAt: "2026-10-20T00:00:00.000Z",
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
] as const;
