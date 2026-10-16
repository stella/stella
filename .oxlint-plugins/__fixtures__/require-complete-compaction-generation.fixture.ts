// Passive regression fixture for
// `require-complete-compaction-generation/require-complete-compaction-generation`.

import { compactionGenerationRequest as completeRequest } from "@/api/lib/chat/compaction-tokens";
import { generateTanStackTextForRole as generateText } from "@/api/lib/tanstack-ai-generate";

declare const baseOptions: Parameters<typeof generateText>[0];

export const unsafeCompaction =
  // oxlint-disable-next-line require-complete-compaction-generation/require-complete-compaction-generation -- fixture: a compaction generation call without the shared complete-output policy must fail
  generateText({ ...baseOptions });

// Allowed: aliases preserve the imported policy's identity.
// expect-clean: require-complete-compaction-generation/require-complete-compaction-generation
export const completeCompaction = generateText({
  ...baseOptions,
  ...completeRequest("Summarize the transcript."),
});

// A statically-known unrelated spread cannot override a policy key.
export const completeWithSafeTail = generateText({
  ...baseOptions,
  ...completeRequest("Summarize the transcript."),
  ...{ temperature: 0 },
});

// A later policy property would replace the required complete-output policy.
export const unsafePolicyOverride =
  // oxlint-disable-next-line require-complete-compaction-generation/require-complete-compaction-generation -- fixture: a finish policy after the shared policy must be rejected
  generateText({
    ...baseOptions,
    ...completeRequest("Summarize the transcript."),
    finishPolicy: "allow-incomplete",
  });

// An opaque later spread could carry the same dangerous override.
declare const laterOptions: Record<string, unknown>;
export const unsafePolicySpread =
  // oxlint-disable-next-line require-complete-compaction-generation/require-complete-compaction-generation -- fixture: an opaque spread after the shared policy must be rejected
  generateText({
    ...baseOptions,
    ...completeRequest("Summarize the transcript."),
    ...laterOptions,
  });
