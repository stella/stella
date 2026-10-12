import type { OwnershipEntry } from "../ownership-types.ts";

export default {
  id: "ai-disclosure-label",
  capability: "Marking generated content with the AI label and its disclosure",
  owner: [
    "apps/web/src/components/ai-disclosure-label.tsx",
    "packages/decision-reader/src/reader-ai-label.tsx",
  ],
  summary:
    "`AiLabel` takes its disclosure as translated text, so it could carry any " +
    "sentence. What a reader is told about generated content is a closed set " +
    "(`AI_DISCLOSURES` in `@stll/api-contract/ai-disclosure`), translated in " +
    "every locale and returned to agents beside the content. Surfaces name a " +
    "context through the web app's `AiDisclosureLabel` or the shared reader's " +
    "`ReaderAiLabel`, the only modules that turn a context into a sentence.",
  enforcement: {
    kind: "import",
    specifiers: ["@stll/ui/ai-label", "@stll/ui/components/ai-label"],
    allowed: [
      {
        path: "packages/ui/src/components/ai-label.test.tsx",
        reason: "Direct unit coverage for the label primitive.",
      },
    ],
  },
} as const satisfies OwnershipEntry;
