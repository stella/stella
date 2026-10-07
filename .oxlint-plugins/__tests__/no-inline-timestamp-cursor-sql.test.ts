import { expect, test } from "bun:test";

import { lintSingleRule } from "./lint-single-rule";

test("rejects inline legacy cursor formats and UTC reanchor boundaries", async () => {
  expect(
    await lintSingleRule(
      "no-inline-timestamp-cursor-sql",
      [
        "const format = 'YYYY-MM-DD\"T\"HH24:MI:SS.US';",
        `const boundary = \`\${cursor}::timestamp AT TIME ZONE 'UTC'\`;`,
        'const both = \'YYYY-MM-DD"T"HH24:MI:SS.US ::timestamp AT TIME ZONE "UTC"\';',
      ].join("\n"),
      { sourcePath: "apps/api/src/handlers/documents/list.ts" },
    ),
  ).toEqual([1, 2, 3, 3]);
});

test("allows canonical helpers, UTC projection markers and noncursor SQL", async () => {
  expect(
    await lintSingleRule(
      "no-inline-timestamp-cursor-sql",
      [
        "const projected = pgTimestampCursorValue(column);",
        "const parsed = pgTimestampCursorBoundary(cursor);",
        'const format = \'YYYY-MM-DD"T"HH24:MI:SS.US"Z"\';',
        `const boundary = \`\${cursor}::timestamptz\`;`,
        'const facet = "YYYY";',
      ].join("\n"),
      { sourcePath: "apps/api/src/handlers/documents/list.ts" },
    ),
  ).toEqual([]);
});

test("allows raw SQL inside its pagination owner", async () => {
  expect(
    await lintSingleRule(
      "no-inline-timestamp-cursor-sql",
      [
        "const format = 'YYYY-MM-DD\"T\"HH24:MI:SS.US';",
        `const boundary = \`\${cursor}::timestamp AT TIME ZONE 'UTC'\`;`,
        'const both = \'YYYY-MM-DD"T"HH24:MI:SS.US ::timestamp AT TIME ZONE "UTC"\';',
      ].join("\n"),
      { sourcePath: "apps/api/src/lib/db-pagination.ts" },
    ),
  ).toEqual([]);
});

test("allows the documented elapsed time arithmetic exception", async () => {
  expect(
    await lintSingleRule(
      "no-inline-timestamp-cursor-sql",
      [
        "const format = 'YYYY-MM-DD\"T\"HH24:MI:SS.US';",
        `const boundary = \`\${cursor}::timestamp AT TIME ZONE 'UTC'\`;`,
        'const both = \'YYYY-MM-DD"T"HH24:MI:SS.US ::timestamp AT TIME ZONE "UTC"\';',
      ].join("\n"),
      { sourcePath: "apps/api/src/handlers/case-law/citation-authority.ts" },
    ),
  ).toEqual([]);
});

test("keeps the pagination owner basename restricted in other directories", async () => {
  expect(
    await lintSingleRule(
      "no-inline-timestamp-cursor-sql",
      [
        "const format = 'YYYY-MM-DD\"T\"HH24:MI:SS.US';",
        `const boundary = \`\${cursor}::timestamp AT TIME ZONE 'UTC'\`;`,
        'const both = \'YYYY-MM-DD"T"HH24:MI:SS.US ::timestamp AT TIME ZONE "UTC"\';',
      ].join("\n"),
      { sourcePath: "apps/api/src/handlers/db-pagination.ts" },
    ),
  ).toEqual([1, 2, 3, 3]);
});

test("leaves non API presentation modules outside the cursor policy", async () => {
  expect(
    await lintSingleRule(
      "no-inline-timestamp-cursor-sql",
      [
        "const format = 'YYYY-MM-DD\"T\"HH24:MI:SS.US';",
        `const boundary = \`\${cursor}::timestamp AT TIME ZONE 'UTC'\`;`,
        'const both = \'YYYY-MM-DD"T"HH24:MI:SS.US ::timestamp AT TIME ZONE "UTC"\';',
      ].join("\n"),
      { sourcePath: "apps/web/src/components/time.ts" },
    ),
  ).toEqual([]);
});
