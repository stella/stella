import type { OwnershipEntry } from "../ownership-types.ts";

export default {
  id: "agent-harness-sidecar",
  capability:
    "Running local harness adapters in a sidecar process the desktop app supervises",
  owner: [
    "packages/agent-engine/src/sidecar/",
    "packages/agent-engine/scripts/build-sidecar.ts",
    "apps/desktop/src-tauri/src/harness_sidecar/",
  ],
  summary:
    "The sidecar's stdio protocol is defined once as valibot schemas in " +
    "`packages/agent-engine/src/sidecar/protocol.ts`; its fixture file holds " +
    "valid and rejected examples that the desktop's serde mirror round-trips. " +
    "The sidecar's loopback MCP proxy is the only path from a harness to the " +
    "stella API: it holds the run token, and the harness holds only a per-run " +
    "secret. The desktop's supervisor owns the child process, its restarts " +
    "and its log lines.",
  enforcement: { kind: "none" },
} as const satisfies OwnershipEntry;
