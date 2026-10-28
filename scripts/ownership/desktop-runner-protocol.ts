import type { OwnershipEntry } from "../ownership-types.ts";

export default {
  id: "desktop-runner-protocol",
  capability: "Messages between a desktop runner and the API",
  owner: [
    "packages/api-contract/src/desktop-runner.ts",
    "packages/api-contract/src/desktop-runner.fixtures.json",
    "apps/desktop/src-tauri/src/runner_protocol.rs",
  ],
  summary:
    "The valibot schemas define every message, closed value, the protocol version and the frame limit. " +
    "The shared fixture file holds valid and rejected examples; the API schema and the desktop's serde " +
    "types each check every example and every closed value list against it, so neither side drifts alone.",
  enforcement: { kind: "none" },
} as const satisfies OwnershipEntry;
