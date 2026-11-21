import { describe, expect, test } from "bun:test";

import { lintSingleRule } from "./lint-single-rule";

describe("require-buffer-cleanup-intent-status", () => {
  test("reports cleanup inserts missing lifecycle status", async () => {
    expect(
      await lintSingleRule(
        "require-buffer-cleanup-intent-status",
        'import { bufferObjectCleanupIntents } from "@/api/db/schema";\ntx.insert(bufferObjectCleanupIntents).values({ objectKey });',
        { sourcePath: "apps/api/src/lib/cleanup.ts" },
      ),
    ).toEqual([2]);
  });
  test("reports undefined statuses in array inserts", async () => {
    expect(
      await lintSingleRule(
        "require-buffer-cleanup-intent-status",
        'import { bufferObjectCleanupIntents as intents } from "@/api/db/schema";\ntx.insert(intents).values([\n{ objectKey: first, status: WRITING },\n{ objectKey: second, status: void 0 }\n]);',
        { sourcePath: "apps/api/src/lib/cleanup.ts" },
      ),
    ).toEqual([4]);
  });
  test("accepts explicit status through namespace imports", async () => {
    expect(
      await lintSingleRule(
        "require-buffer-cleanup-intent-status",
        'import * as schema from "@/api/db/schema";\ntx.insert(schema.bufferObjectCleanupIntents).values({ objectKey, status: WRITING });',
        { sourcePath: "apps/api/src/lib/cleanup.ts" },
      ),
    ).toEqual([]);
  });
  test("leaves assembled payloads outside local syntax analysis", async () => {
    expect(
      await lintSingleRule(
        "require-buffer-cleanup-intent-status",
        'import { bufferObjectCleanupIntents } from "@/api/db/schema";\ntx.insert(bufferObjectCleanupIntents).values(payload);',
        { sourcePath: "apps/api/src/lib/cleanup.ts" },
      ),
    ).toEqual([]);
  });
});
