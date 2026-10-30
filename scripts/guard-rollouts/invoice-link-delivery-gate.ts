import type { GuardRollout } from "../guard-rollout-policy.ts";

export default {
  id: "invoice-link-delivery-gate",
  rules: [
    "require-invoice-link-delivery-gate/require-invoice-link-delivery-gate",
  ],
  type: "changed-lines",
  expiresAt: "2026-11-06T08:49:28.000Z",
  check: [
    "bun",
    "--bun",
    "oxlint",
    "-c",
    "oxlint.config.ts",
    "--allow",
    "all",
    "--deny",
    "require-invoice-link-delivery-gate/require-invoice-link-delivery-gate",
    "apps/api/src/handlers/invoice-links",
  ],
} as const satisfies GuardRollout;
