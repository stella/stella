// Passive regression fixture for
// `require-complete-compaction-generation/require-complete-compaction-generation`.

import { COMPACTION_GENERATION_POLICY as completePolicy } from "@/api/lib/chat/compaction-tokens";
import { generateTanStackTextForRole as generateText } from "@/api/lib/tanstack-ai-generate";

declare const baseOptions: Parameters<typeof generateText>[0];

export const unsafeCompaction =
  // oxlint-disable-next-line require-complete-compaction-generation/require-complete-compaction-generation -- fixture: a compaction generation call without the shared complete-output policy must fail
  generateText({ ...baseOptions });

// Allowed: aliases preserve the imported policy's identity.
export const completeCompaction = generateText({
  ...baseOptions,
  ...completePolicy,
});

// A statically-known unrelated spread cannot override either policy key.
export const completeWithSafeTail = generateText({
  ...baseOptions,
  ...completePolicy,
  ...{ temperature: 0 },
});

// A later policy property would replace the required complete-output policy.
export const unsafePolicyOverride =
  // oxlint-disable-next-line require-complete-compaction-generation/require-complete-compaction-generation -- fixture: a finish policy after the shared policy must be rejected
  generateText({
    ...baseOptions,
    ...completePolicy,
    finishPolicy: "allow-incomplete",
  });

// An opaque later spread could carry the same dangerous override.
declare const laterOptions: Record<string, unknown>;
export const unsafePolicySpread =
  // oxlint-disable-next-line require-complete-compaction-generation/require-complete-compaction-generation -- fixture: an opaque spread after the shared policy must be rejected
  generateText({
    ...baseOptions,
    ...completePolicy,
    ...laterOptions,
  });
