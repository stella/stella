import { expect, test } from "bun:test";

import { lintSingleRule } from "./lint-single-rule.ts";

test("rejects duplicate formatter imports even when aliased", async () => {
  expect(
    await lintSingleRule(
      "require-relative-time-helpers",
      'import { formatFullTimestamp as full, formatRelativeTime as relative } from "@/components/workspaces/entity-utils";',
      { sourcePath: "apps/web/src/components/time.tsx" },
    ),
  ).toEqual([1, 1]);
});

test("rejects inline full timestamps and aliased native titles", async () => {
  expect(
    await lintSingleRule(
      "require-relative-time-helpers",
      'import { formatFullTimestamp as full } from "@/lib/relative-time";\ndate.toLocaleString("cs", { dateStyle: "full", timeStyle: "short" });\nconst view = <span title={full(date)} />;',
      { sourcePath: "apps/web/src/components/time.tsx" },
    ),
  ).toEqual([2, 3]);
});

test("accepts canonical helpers shared tooltips and date-only labels", async () => {
  expect(
    await lintSingleRule(
      "require-relative-time-helpers",
      'import { formatFullTimestamp, formatRelativeTime } from "@/lib/relative-time";\nformatRelativeTime(date);\nconst a = <Tooltip content={formatFullTimestamp(date)} />;\nconst b = <ReadOnlyRow title={formatFullTimestamp(date)} />;\ndate.toLocaleString("cs", { dateStyle: "full" });',
      { sourcePath: "apps/web/src/components/time.tsx" },
    ),
  ).toEqual([]);
});

test("allows inline full formatting only in the canonical formatter owner", async () => {
  expect(
    await lintSingleRule(
      "require-relative-time-helpers",
      'date.toLocaleString("cs", { dateStyle: "full", timeStyle: "short" });',
      { sourcePath: "apps/web/src/lib/relative-time.ts" },
    ),
  ).toEqual([]);
});

test("does not exempt a formatter basename in another directory", async () => {
  expect(
    await lintSingleRule(
      "require-relative-time-helpers",
      'date.toLocaleString("cs", { dateStyle: "full", timeStyle: "short" });',
      { sourcePath: "apps/web/src/other/relative-time.ts" },
    ),
  ).toEqual([1]);
});
