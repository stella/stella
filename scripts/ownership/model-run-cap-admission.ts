import type { OwnershipEntry } from "../ownership-types.ts";

export default {
  id: "model-run-cap-admission",
  capability: "Admitting a model run under its organization's caps",
  owner: ["apps/api/src/lib/usage/model-run-caps/"],
  summary:
    "A run starts under its kind's caps only through `startModelRun`, which hands the insert trigger the configured limits and turns the trigger's refusal into the shared typed error. " +
    "The limit settings and the refusal constraints are named nowhere else.",
  enforcement: {
    kind: "literal-pattern",
    pattern: "app\\.model_run_|model_run_(?:active|daily)_cap",
    allowed: [
      {
        path: "scripts/ownership/model-run-cap-admission.ts",
        reason: "Declares the confined setting and constraint names.",
      },
    ],
  },
} as const satisfies OwnershipEntry;
