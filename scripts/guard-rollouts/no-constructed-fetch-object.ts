import type { GuardRollout } from "../guard-rollout-policy.ts";

export default {
  id: "no-constructed-fetch-object",
  rules: ["no-constructed-fetch-object/no-constructed-fetch-object"],
  type: "changed-lines",
  expiresAt: "2026-11-06T00:00:00.000Z",
  check: [
    "bun",
    "--bun",
    "oxlint",
    "-c",
    "oxlint.config.ts",
    "--allow",
    "all",
    "--deny",
    "no-constructed-fetch-object/no-constructed-fetch-object",
    "apps/mobile/src",
  ],
} as const satisfies GuardRollout;
