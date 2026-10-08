import { expect, test } from "bun:test";

import { lintSingleRule } from "./lint-single-rule.ts";

test("rejects conditional concatenated and interpolated dynamic classes", async () => {
  expect(
    await lintSingleRule(
      "require-cn-for-classname-composition",
      `const a = <div className={ready ? "a" : "b"} />;\nconst b = <div className={"base " + className} />;\nconst c = <div className={\`base \${className}\`} />;`,
      { sourcePath: "apps/web/src/components/styles.tsx" },
    ),
  ).toEqual([1, 2, 3]);
});

test("rejects noncanonical composition and canonical names from unrelated modules", async () => {
  expect(
    await lintSingleRule(
      "require-cn-for-classname-composition",
      'import { cn } from "other-utils";\nconst a = <div className={cn("base", className)} />;\nconst b = <div headerClassName={clsx("base", className)} />;',
      { sourcePath: "apps/web/src/components/styles.tsx" },
    ),
  ).toEqual([2, 3]);
});

test("accepts canonical aliases static classes and passthrough values", async () => {
  expect(
    await lintSingleRule(
      "require-cn-for-classname-composition",
      'import { cn as compose } from "@stll/ui/utils";\nconst a = <div className={compose("base", ready && "active", className)} />;\nconst c = <div className="base" />;\nconst d = <div className={className} />;',
      { sourcePath: "apps/web/src/components/styles.tsx" },
    ),
  ).toEqual([]);
});

test("follows static local props spreads and dynamic local values", async () => {
  expect(
    await lintSingleRule(
      "require-cn-for-classname-composition",
      'const classes = ready ? "a" : "b";\nconst props = { className: classes };\nconst a = <div {...props} />;\nconst b = <div className={classes} />;',
      { sourcePath: "apps/web/src/components/styles.tsx" },
    ),
  ).toEqual([3, 4]);
});

test("requires canonical composition on each callback return path", async () => {
  expect(
    await lintSingleRule(
      "require-cn-for-classname-composition",
      'import { cn } from "@stll/ui/utils";\nconst a = <div className={() => ready ? "a" : "b"} />;\nconst b = <div className={() => { if (ready) return cn("a"); return cn("b"); }} />;',
      { sourcePath: "apps/web/src/components/styles.tsx" },
    ),
  ).toEqual([2]);
});

test("rejects a callback with one canonical and one raw composition branch", async () => {
  expect(
    await lintSingleRule(
      "require-cn-for-classname-composition",
      'import { cn } from "@stll/ui/utils";\nconst item = <div className={() => { if (ready) return cn("base", className); return "base " + className; }} />;',
      { sourcePath: "apps/web/src/components/style.tsx" },
    ),
  ).toEqual([2]);
});
