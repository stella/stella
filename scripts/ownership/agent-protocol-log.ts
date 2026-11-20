import type { OwnershipEntry } from "../ownership-types.ts";

export default {
  id: "agent-protocol-log",
  capability:
    "Logging the local agent engine's harness and sidecar protocol messages without their content",
  owner: ["packages/agent-engine/src/protocol-log.ts"],
  summary:
    "One allowlist per message kind decides which fields of a Claude Code, " +
    "Codex or desktop sidecar message reach `holder.log`, and how: closed " +
    "values from closed lists the code owns, numbers, booleans, numeric " +
    "versions and re-serialized instants as they are; ids and any other " +
    "string in those fields as HMAC fingerprints under a random key each " +
    "holder keeps in memory; and every other value as its kind and a " +
    "power-of-two size band. A field " +
    "the allowlist does not list is counted, never shown. The log is off " +
    "unless `STELLA_AGENT_PROTOCOL_LOG=redacted` is set in the environment " +
    "the holder starts with.",
  enforcement: { kind: "none" },
} as const satisfies OwnershipEntry;
