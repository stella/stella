import { describe, expect, test } from "bun:test";

import { lintSingleRule } from "./lint-single-rule";

describe("require-complete-compaction-generation", () => {
  test("reports generation without the shared policy", async () => {
    expect(
      await lintSingleRule(
        "require-complete-compaction-generation",
        'import { generateTanStackTextForRole as generate } from "@/api/lib/tanstack-ai-generate";\ngenerate({ prompt: "summarize" });',
        { sourcePath: "apps/api/src/lib/chat/compaction.ts" },
      ),
    ).toEqual([2]);
  });
  test("reports policy overridden after spreading", async () => {
    expect(
      await lintSingleRule(
        "require-complete-compaction-generation",
        'import { generateTanStackTextForRole as generate } from "@/api/lib/tanstack-ai-generate";\nimport { COMPACTION_GENERATION_POLICY as policy } from "@/api/lib/chat/compaction-tokens";\ngenerate({ ...policy, maxOutputTokens: 10 });',
        { sourcePath: "apps/api/src/lib/chat/compaction.ts" },
      ),
    ).toEqual([3]);
  });
  test("accepts the policy after other generation options", async () => {
    expect(
      await lintSingleRule(
        "require-complete-compaction-generation",
        'import { generateTanStackTextForRole as generate } from "@/api/lib/tanstack-ai-generate";\nimport { COMPACTION_GENERATION_POLICY as policy } from "@/api/lib/chat/compaction-tokens";\ngenerate({ ...options, ...policy, prompt: "summarize" });',
        { sourcePath: "apps/api/src/lib/chat/compaction.ts" },
      ),
    ).toEqual([]);
  });
  test("does not govern ordinary generation modules", async () => {
    expect(
      await lintSingleRule(
        "require-complete-compaction-generation",
        'import { generateTanStackTextForRole } from "@/api/lib/tanstack-ai-generate";\ngenerateTanStackTextForRole({ prompt: "reply" });',
        { sourcePath: "apps/api/src/lib/chat/reply.ts" },
      ),
    ).toEqual([]);
  });
});
