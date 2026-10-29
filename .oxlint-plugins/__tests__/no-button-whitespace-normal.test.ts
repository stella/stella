import { expect, test } from "bun:test";

import { lintSingleRule } from "./lint-single-rule.ts";

test("reports wrapping utilities in Button className string expressions", async () => {
  expect(
    await lintSingleRule(
      "no-button-whitespace-normal",
      [
        '<Button className="whitespace-normal" />;',
        '<Button className={cn("px-2", "whitespace-normal")} />;',
        '<Button className={wide ? "sm:whitespace-normal" : "whitespace-nowrap"} />;',
        `<Button className={\`flex \${wide ? "!whitespace-normal" : ""}\`} />;`,
        `<Button className={\`whitespace-normal \${dynamic}\`} />;`,
        `<Button className={\`whitespace\\u002dnormal \${dynamic}\`} />;`,
        '<Button className="max-sm:whitespace-normal" />;',
        '<Button className="whitespace-normal!" />;',
      ].join("\n"),
      { sourcePath: "source.tsx" },
    ),
  ).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
});

test("allows wrapping utilities outside Button className strings", async () => {
  expect(
    await lintSingleRule(
      "no-button-whitespace-normal",
      [
        '<Button layout="wrap">wrapped row</Button>;',
        '<Button className="whitespace-nowrap" />;',
        '<OtherButton className="whitespace-normal" />;',
        '<Button><span className="whitespace-normal">wrapped child</span></Button>;',
        "<Button className={classNames} />;",
      ].join("\n"),
      { sourcePath: "source.tsx" },
    ),
  ).toEqual([]);
});
