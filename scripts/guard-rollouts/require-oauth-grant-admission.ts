import type { GuardRollout } from "../guard-rollout-policy.ts";

export default {
  id: "require-oauth-grant-admission",
  rules: ["require-oauth-grant-admission/require-oauth-grant-admission"],
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
    "require-oauth-grant-admission/require-oauth-grant-admission",
    "apps/api/src",
  ],
} as const satisfies GuardRollout;
