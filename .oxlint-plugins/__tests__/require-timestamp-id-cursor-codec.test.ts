import { expect, test } from "bun:test";

import { runSingleRule } from "./lint-single-rule.ts";

const cases = [
  {
    title: "reports repeated keyset boundary calls",
    source:
      "const after = or(gt(time, pgTimestampCursorBoundary(cursor)), and(eq(time, pgTimestampCursorBoundary(cursor)), gt(id, cursor.id)));",
    lines: [1],
    sourcePath: "apps/api/src/routes/records.ts",
  },
  {
    title: "tracks imported boundary and disjunction aliases",
    source:
      'import { pgTimestampCursorBoundary as boundary } from "@/api/lib/db-pagination";\nimport { or as either } from "drizzle-orm";\nconst after = either(gt(time, boundary(cursor)), eq(time, boundary(cursor)));',
    lines: [3],
    sourcePath: "apps/api/src/routes/records.ts",
  },
  {
    title: "allows a single range boundary and codec",
    source:
      "const after = or(gt(time, pgTimestampCursorBoundary(cursor)), eq(id, cursor.id));\nconst keyset = codec.keysetAfter(cursor);",
    lines: [],
    sourcePath: "apps/api/src/routes/records.ts",
  },
];

test.each(cases)(
  "require-timestamp-id-cursor-codec: $title",
  async ({ source, lines, sourcePath }) => {
    expect(
      (
        await runSingleRule("require-timestamp-id-cursor-codec", source, {
          sourcePath,
        })
      ).lines,
    ).toEqual(lines);
  },
);
