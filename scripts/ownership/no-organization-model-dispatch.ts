import type { OwnershipEntry } from "../ownership-types.ts";

export default {
    id: "no-organization-model-dispatch",
    capability: "Model work with no organization budget",
    owner: ["apps/api/src/lib/rate-limit/model-dispatch-admission.ts"],
    summary:
      "A dispatch with no organization (corpus-wide work, provider canaries, " +
      "evaluations) carries `NO_ORGANIZATION_MODEL_DISPATCH`; the dispatch type ties " +
      "it to a null organization, so tenant work cannot use it.",
    enforcement: {
      kind: "import",
      specifiers: ["@/api/lib/rate-limit/model-dispatch-admission"],
      names: ["NO_ORGANIZATION_MODEL_DISPATCH"],
      allowed: [
        {
          path: "apps/api/src/handlers/case-law/polarity/llm-classifier.ts",
          reason: "Corpus citation polarity, run by operator scripts.",
        },
        {
          path: "apps/api/evals/",
          reason: "Offline evaluations over fixture content.",
        },
        {
          path: "apps/api/scripts/ai-native-image-canary.ts",
          reason: "Provider canary with synthetic content.",
        },
        {
          path: "apps/api/scripts/ai-provider-canary.ts",
          reason: "Provider canary with synthetic content.",
        },
        {
          path: "apps/api/scripts/ai-provider-cassette-probe.ts",
          reason: "Records provider cassettes from synthetic prompts.",
        },
        {
          path: "apps/api/scripts/benchmark-chat-read-surface.ts",
          reason: "Benchmark with synthetic content.",
        },
      ],
    },
  } as const satisfies OwnershipEntry;
