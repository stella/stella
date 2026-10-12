import type { OwnershipEntry } from "../ownership-types.ts";

export default {
  id: "fixture-model-dispatch-admission",
  capability: "Proving a fixture dispatch with a stated model tier",
  owner: ["apps/api/src/lib/rate-limit/model-dispatch-admission.ts"],
  summary:
    "Production proofs read the organization's managed model tier when minted and " +
    "live only inside the run an admission wrapper admitted; only offline " +
    "evaluations (and tests) state a tier for a fixture organization.",
  enforcement: {
    kind: "import",
    specifiers: ["@/api/lib/rate-limit/model-dispatch-admission"],
    names: ["admitFixtureModelDispatch"],
    allowed: [
      {
        path: "apps/api/evals/",
        reason: "Offline evaluations against a fixture organization.",
      },
    ],
  },
} as const satisfies OwnershipEntry;
