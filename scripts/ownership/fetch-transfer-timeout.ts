import type { OwnershipEntry } from "../ownership-types.ts";

export default {
  id: "fetch-transfer-timeout",
  capability: "Applying response header and body idle deadlines",
  owner: ["packages/fetch/src/index.ts"],
  summary:
    "`@stll/fetch` requires a header or idle timeout policy for new callers " +
    "and composes caller cancellation. Idle deadlines cover pending body reads; " +
    "header deadlines stop at the response. Deprecated numeric callers and " +
    "raw total deadlines on body reads are enumerated by " +
    "`scripts/transfer-read-guard.ts` with a shrink-only baseline.",
  enforcement: { kind: "none" },
} as const satisfies OwnershipEntry;
