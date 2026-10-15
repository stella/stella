import type { OwnershipEntry } from "../ownership-types.ts";

export default {
  id: "model-resolution",
  capability: "Resolving a model adapter",
  owner: ["apps/api/src/lib/tanstack-ai-models.ts"],
  summary:
    "Production code resolves a model through `resolveTanStackTextModel`, which " +
    "requires the dispatch's admission proof; the adapter builders behind it are " +
    "not reachable without one.",
  enforcement: {
    kind: "import",
    specifiers: ["@/api/lib/tanstack-ai-models"],
    names: [
      "createTanStackTextAdapterFactory",
      "getTanStackTextModelById",
      "getTanStackTextModelForRole",
    ],
    allowed: [
      {
        path: "apps/api/src/lib/tanstack-ai-generate.ts",
        reason: "The dispatch seam: resolves after checking the admission.",
      },
    ],
  },
} as const satisfies OwnershipEntry;
