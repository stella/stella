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
