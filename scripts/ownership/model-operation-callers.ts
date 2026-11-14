import {
  MODEL_OPERATION_BOUNDARIES,
  MODEL_OPERATION_MODULES,
} from "../../apps/api/src/lib/ai-generation/model-operation-registry.ts";
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
        path: "apps/api/evals/avt-verification.ts",
        reason:
          "operator eval run with operator credentials outside tenant request admission; it passes the verification engine's own dispatch through unchanged to price each call",
      },
      {
        path: "apps/api/scripts/ai-provider-cassette-probe.ts",
        reason:
          "operator canary/probe run with operator credentials outside tenant request admission",
      },
    ],
  },
} as const satisfies OwnershipEntry;
