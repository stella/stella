import { describe, expect, test } from "bun:test";

import { lintSingleRule } from "./lint-single-rule.ts";

describe("text-mark-not-in-button", () => {
  test("reports a text mark inside a Button", async () => {
    expect(
      await lintSingleRule(
        "text-mark-not-in-button",
        'import { Button } from "@stll/ui/button";\nimport { textMarkClass, TextMark } from "@stll/ui/text-mark";\nconst a = <Button><span className={textMarkClass(mark)}>x</span></Button>;\nconst b = <Button><TextMark tone="muted" variant="fill">y</TextMark></Button>;',
        { sourcePath: "source.tsx" },
      ),
    ).toEqual([3, 4]);
  });
  test("resolves aliased imports", async () => {
    expect(
      await lintSingleRule(
        "text-mark-not-in-button",
        'import { Button as Action } from "@stll/ui/button";\nimport { textMarkClass as mark } from "@stll/ui/text-mark";\nconst a = <Action><span className={mark(m)}>x</span></Action>;',
        { sourcePath: "source.tsx" },
      ),
    ).toEqual([3]);
  });
  test("accepts a text mark in a text run and a Button without one", async () => {
    expect(
      await lintSingleRule(
        "text-mark-not-in-button",
        'import { Button, ButtonTextRun } from "@stll/ui/button";\nimport { textMarkClass } from "@stll/ui/text-mark";\nconst a = <ButtonTextRun><span className={textMarkClass(mark)}>x</span></ButtonTextRun>;\nconst b = <Button>Open</Button>;\nconst c = <span className={textMarkClass(mark)}><Button>Open</Button></span>;',
        { sourcePath: "source.tsx" },
      ),
    ).toEqual([]);
  });
});
