import type { OwnershipEntry } from "../ownership-types.ts";

export default {
  id: "flow-task-mutation-admission",
  capability: "Admitting mutations of linked workflow review tasks",
  owner: [
    "apps/api/src/lib/flows/review-gate-task.ts",
    "apps/api/src/lib/flows/review-task-target.ts",
    "apps/api/src/lib/flows/review-task-admission.ts",
    "apps/api/scripts/lib/task-mutation-admission-declarations.ts",
  ],
  summary:
    "Closed entity, link and subtree targets resolve persisted review ownership under live admission before resource effects. The feature declaration validator checks every registered effect owner for the acting principal, transaction handle and immediate typed refusal. Active review tasks retain their lineage; admitted copies receive ordinary fresh identities.",
  enforcement: { kind: "none" },
} as const satisfies OwnershipEntry;
