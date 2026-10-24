import type { OwnershipEntry } from "../ownership-types.ts";

export default {
  id: "kill-switches",
  capability: "Turning an AI or service-consuming feature off at runtime",
  owner: ["apps/api/src/lib/kill-switches/"],
  summary:
    "`KILL_SWITCHES` in `registry.ts` declares every switch with its default, " +
    "owner and refusal hint, and `ACTION_KIND_KILL_SWITCH` maps every action " +
    "kind to one, so an action kind cannot land without a switch. Admission and " +
    "model dispatch refuse a switched-off action with the typed " +
    "`action_feature_disabled` refusal; operators set overrides in the " +
    "`KILL_SWITCHES` deployment variable.",
  enforcement: {
    kind: "import",
    specifiers: [
      "@/api/lib/kill-switches/admission",
      "@/api/env-kill-switches",
    ],
    allowed: [
      {
        path: "apps/api/src/lib/rate-limit/action-admission.ts",
        reason: "Refuses a switched-off action before it draws any budget.",
      },
      {
        path: "apps/api/src/lib/rate-limit/model-dispatch-admission.ts",
        reason: "Never mints a dispatch proof for a switched-off action.",
      },
      {
        path: "apps/api/src/env.ts",
        reason: "Exposes the overrides on the API environment for tests.",
      },
    ],
  },
} as const satisfies OwnershipEntry;
