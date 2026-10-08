import { expect, test } from "bun:test";

import { runSingleRule } from "./lint-single-rule.ts";

const cases = [
  {
    title: "reports canonical named alias deletion",
    source:
      'import { bufferObjectCleanupIntents as intents } from "@/api/db/schema";\ntx.delete(intents);',
    lines: [2],
    sourcePath: "apps/api/src/lib/publisher.ts",
  },
  {
    title: "reports namespace deletion",
    source:
      'import * as schema from "@/api/db/schema";\ntx.delete(schema.bufferObjectCleanupIntents);',
    lines: [2],
    sourcePath: "apps/api/src/lib/publisher.ts",
  },
  {
    title: "allows reconciliation owner",
    source:
      'import { bufferObjectCleanupIntents } from "@/api/db/schema";\ntx.delete(bufferObjectCleanupIntents);',
    lines: [],
    sourcePath: "apps/api/src/lib/buffer-intent-reconciliation.ts",
  },
  {
    title: "allows shared retirement and unrelated deletes",
    source:
      "retirePublishedObjectCleanupIntentsInTransaction(tx, ids);\ntx.delete(documents);",
    lines: [],
    sourcePath: "apps/api/src/lib/publisher.ts",
  },
];

test.each(cases)(
  "no-direct-buffer-cleanup-intent-delete: $title",
  async ({ source, lines, sourcePath }) => {
    expect(
      (
        await runSingleRule("no-direct-buffer-cleanup-intent-delete", source, {
          sourcePath,
        })
      ).lines,
    ).toEqual(lines);
  },
);
