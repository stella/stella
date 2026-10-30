import type { GuardRollout } from "../guard-rollout-policy.ts";

export default {
  id: "no-forged-realtime-event",
  rules: ["no-forged-realtime-event/no-forged-realtime-event"],
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
    "no-forged-realtime-event/no-forged-realtime-event",
    ".",
  ],
} as const satisfies GuardRollout;
