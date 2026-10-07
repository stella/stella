import { expect, test } from "bun:test";

import { lintSingleRule } from "./lint-single-rule.ts";

test("rejects spinner icons compound names and hand rolled progress", async () => {
  expect(
    await lintSingleRule(
      "no-adhoc-loader",
      'const a = <Loader2Icon />;\nconst b = <Icons.LoaderCircleIcon />;\nconst c = <div role="progressbar" />;',
      { sourcePath: "apps/web/src/components/example.tsx" },
    ),
  ).toEqual([1, 2, 3]);
});

test("rejects static animation in expressions and conditional branches", async () => {
  expect(
    await lintSingleRule(
      "no-adhoc-loader",
      'const a = <div className={cn("size-4", enabled && "animate-spin")} />;\nconst b = <div className={enabled ? "animate-pulse" : "plain"} />;',
      { sourcePath: "apps/web/src/components/example.tsx" },
    ),
  ).toEqual([1, 2]);
});

test("accepts shared loading primitives and unrelated animation text", async () => {
  expect(
    await lintSingleRule(
      "no-adhoc-loader",
      'const a = <Loader label="Loading" />;\nconst b = <Skeleton className="h-4" />;\nconst c = <div className="animate-spinach motion-safe" role="status" />;',
      { sourcePath: "apps/web/src/components/example.tsx" },
    ),
  ).toEqual([]);
});

test("accepts an explicitly configured legacy owner", async () => {
  expect(
    await lintSingleRule("no-adhoc-loader", "const a = <LoaderIcon />;", {
      sourcePath: "apps/web/src/components/legacy-loader.tsx",
      ruleOptions: {
        allowedFiles: [
          {
            path: "apps/web/src/components/legacy-loader.tsx",
            reason: "Existing component owns this display.",
          },
        ],
      },
    }),
  ).toEqual([]);
});

test("does not exempt a same named file outside the configured owner", async () => {
  expect(
    await lintSingleRule("no-adhoc-loader", "const a = <LoaderIcon />;", {
      sourcePath: "apps/web/src/other/legacy-loader.tsx",
      ruleOptions: {
        allowedFiles: ["apps/web/src/components/legacy-loader.tsx"],
      },
    }),
  ).toEqual([1]);
});
