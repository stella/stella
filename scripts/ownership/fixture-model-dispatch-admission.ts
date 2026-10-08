import type { OwnershipEntry } from "../ownership-types.ts";

export default {
  id: "fixture-model-dispatch-admission",
  capability: "Proving a fixture dispatch no admission holds",
  owner: ["apps/api/src/lib/rate-limit/model-dispatch-admission.ts"],
  summary:
    "Production proofs live only inside the run an admission wrapper admitted; " +
    "only offline evaluations (and tests) mint a standalone proof for a fixture organization.",
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
