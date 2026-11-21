import type { OwnershipEntry } from "../ownership-types.ts";

export default {
  id: "model-dispatch-admission",
  capability: "Proving a model dispatch was admitted",
  owner: ["apps/api/src/lib/rate-limit/model-dispatch-admission.ts"],
  summary:
    "Every model dispatch for an organization carries a `ModelDispatchAdmission`, " +
    "which only the admission wrappers mint, inside the run they admitted. A step of " +
    "a larger action (a subagent, an in-turn compaction, a workflow batch) dispatches " +
    "on its parent's proof and is never admitted again. The proof lives only while " +
    "its admitted run does; `model-dispatch-admission.test.ts` enumerates every dispatch site.",
  enforcement: {
    kind: "import",
    specifiers: ["@/api/lib/rate-limit/model-dispatch-admission"],
    names: ["admitModelDispatch"],
    allowed: [
      {
        path: "apps/api/src/lib/api-handlers.ts",
        reason: "Finite handler admission, for the request it admitted.",
      },
      {
        path: "apps/api/src/lib/rate-limit/execution-admission.ts",
        reason: "Chat and streamed executions, for the lease it holds.",
      },
      {
        path: "apps/api/src/lib/rate-limit/queued-action-admission.ts",
        reason: "Background jobs and scheduled work, for the slot it holds.",
      },
      {
        path: "apps/api/src/lib/rate-limit/model-action-admission.ts",
        reason:
          "Model actions code starts on its own, for the run it admitted.",
      },
    ],
  },
} as const satisfies OwnershipEntry;
