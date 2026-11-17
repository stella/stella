import type { OwnershipEntry } from "../ownership-types.ts";

export default {
  id: "agent-harness-sidecar",
  capability:
    "Running local harness adapters in a holder process that outlives the desktop app",
  owner: [
    "packages/agent-engine/src/sidecar/",
    "packages/agent-engine/scripts/build-sidecar.ts",
    "apps/desktop/src-tauri/src/harness_sidecar/",
  ],
  summary:
    "The sidecar's socket protocol is defined once as valibot schemas in " +
    "`packages/agent-engine/src/sidecar/protocol.ts`; its fixture file holds " +
    "valid and rejected examples that the desktop's serde mirror round-trips. " +
    "The sidecar runs detached as a holder (`holder.ts`): it numbers each " +
    "run's messages, keeps them until the desktop acks them and resends them " +
    "when the desktop reconnects, so runs survive app restarts, crashes and " +
    "updates. Its socket folder is private to the user and a desktop presents " +
    "the holder's secret first. The sidecar's loopback MCP proxy is the only " +
    "path from a harness to the stella API: it holds the run token, and the " +
    "harness holds only a per-run secret. The desktop's supervisor finds or " +
    "starts the holder, reconnects to it and drains holders of older versions.",
  enforcement: { kind: "none" },
} as const satisfies OwnershipEntry;
