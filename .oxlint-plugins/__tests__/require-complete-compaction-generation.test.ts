import { describe, expect, test } from "bun:test";

import { lintSingleRule } from "./lint-single-rule";

describe("require-complete-compaction-generation", () => {
  test("reports generation without the shared policy", async () => {
    expect(
      await lintSingleRule(
        "require-complete-compaction-generation",
        'import { generateTanStackTextForTask as generate } from "@/api/lib/tanstack-ai-generate";\ngenerate({ prompt: "summarize" });',
        { sourcePath: "apps/api/src/lib/chat/compaction.ts" },
      ),
    ).toEqual([2]);
  });
  test("reports policy overridden after spreading", async () => {
    expect(
      await lintSingleRule(
        "require-complete-compaction-generation",
        'import { generateTanStackTextForTask as generate } from "@/api/lib/tanstack-ai-generate";\nimport { compactionGenerationRequest as request } from "@/api/lib/chat/compaction-tokens";\ngenerate({ ...request("summarize"), maxOutputTokens: 10 });',
        { sourcePath: "apps/api/src/lib/chat/compaction.ts" },
      ),
    ).toEqual([3]);
  });
  test("reports a prompt that replaces the bounded one", async () => {
    expect(
      await lintSingleRule(
        "require-complete-compaction-generation",
        'import { generateTanStackTextForTask as generate } from "@/api/lib/tanstack-ai-generate";\nimport { compactionGenerationRequest as request } from "@/api/lib/chat/compaction-tokens";\ngenerate({ ...request("summarize"), prompt: "summarize at length" });',
        { sourcePath: "apps/api/src/lib/chat/compaction.ts" },
      ),
    ).toEqual([3]);
  });
  test("accepts the policy after other generation options", async () => {
    expect(
      await lintSingleRule(
        "require-complete-compaction-generation",
        'import { generateTanStackTextForTask as generate } from "@/api/lib/tanstack-ai-generate";\nimport { compactionGenerationRequest as request } from "@/api/lib/chat/compaction-tokens";\ngenerate({ ...options, ...request("summarize"), task: "chat" });',
        { sourcePath: "apps/api/src/lib/chat/compaction.ts" },
      ),
    ).toEqual([]);
  });
  test("does not govern ordinary generation modules", async () => {
    expect(
      await lintSingleRule(
        "require-complete-compaction-generation",
        'import { generateTanStackTextForTask } from "@/api/lib/tanstack-ai-generate";\ngenerateTanStackTextForTask({ prompt: "reply" });',
        { sourcePath: "apps/api/src/lib/chat/reply.ts" },
      ),
    ).toEqual([]);
  });
});
