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
    "</>;",
  ].join("\n");
  expect(
    await lintSingleRule("no-adhoc-loader", source, {
      sourcePath: "source.tsx",
    }),
  ).toEqual([2, 3, 4, 5, 6, 7, 8, 9]);
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
