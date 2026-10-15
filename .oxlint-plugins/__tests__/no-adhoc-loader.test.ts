import { expect, test } from "bun:test";

import { lintSingleRule } from "./lint-single-rule.ts";

test("rejects spinner icons, animated placeholders and progress bars", async () => {
  const source = [
    "const view = <>",
    "  <LoaderIcon />",
    "  <Loader2Icon />",
    '  <span className="size-4 animate-spin" />',
    '  <div className={busy ? "animate-pulse" : ""} />',
    '  <div className="in-data-[type=loading]:animate-spin" />',
    '  <div role="progressbar" />',
    '  <div className={cn({ "animate-spin": busy })} />',
    '  <div className={cn({ "motion-safe:animate-pulse": busy })} />',
    '  <span className="size-4 animate-spin!" />',
    '  <span className="motion-safe:animate-pulse!" />',
    '  <span className="!animate-spin" />',
    "</>;",
  ].join("\n");
  expect(
    await lintSingleRule("no-adhoc-loader", source, {
      sourcePath: "source.tsx",
    }),
  ).toEqual([2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
});

test("accepts canonical status, decorative, region and skeleton indicators", async () => {
  const source = [
    "const view = <>",
    '  <Loader label="Loading" size="sm" />',
    '  <Loader size="sm" variant="decorative" />',
    '  <LoaderState label="Processing" detail="3 / 10" />',
    '  <Skeleton className="h-4 w-1/3" />',
    '  <span className={cn({ "text-muted": "animate-spin" })} />',
    "</>;",
  ].join("\n");
  expect(
    await lintSingleRule("no-adhoc-loader", source, {
      sourcePath: "source.tsx",
    }),
  ).toEqual([]);
});

test("shared button and toast owners cannot introduce alternative loaders", async () => {
  for (const sourcePath of [
    "packages/ui/src/components/button.tsx",
    "packages/ui/src/components/toast.tsx",
  ]) {
    expect(
      await lintSingleRule(
        "no-adhoc-loader",
        "const view = <LoaderCircleIcon />;",
        {
          cwd: "scratch",
          sourcePath,
        },
      ),
    ).toEqual([1]);
  }
});

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
