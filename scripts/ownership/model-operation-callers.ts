import {
  MODEL_OPERATION_BOUNDARIES,
  MODEL_OPERATION_MODULES,
} from "../../apps/api/src/lib/model-operation-registry.ts";
import type { OwnershipEntry } from "../ownership-types.ts";

export default {
  id: "model-operation-callers",
  capability: "Registering model operation entry points",
  owner: MODEL_OPERATION_MODULES,
  summary:
    "Model operation callers are enumerated so a new entry point requires an explicit admission decision.",
  enforcement: {
    kind: "import",
    specifiers: ["@/api/lib/tanstack-ai-generate"],
    names: MODEL_OPERATION_BOUNDARIES.facade,
    allowed: [
      {
        path: "apps/api/scripts/ai-native-image-canary.ts",
        reason:
          "operator canary/probe run with operator credentials outside tenant request admission",
      },
      {
        path: "apps/api/scripts/ai-provider-canary.ts",
        reason:
          "operator canary/probe run with operator credentials outside tenant request admission",
      },
      {
        path: "apps/api/scripts/ai-provider-cassette-probe.ts",
        reason:
          "operator canary/probe run with operator credentials outside tenant request admission",
      },
    ],
  },
} as const satisfies OwnershipEntry;
