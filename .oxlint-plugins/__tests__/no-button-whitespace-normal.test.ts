import { expect, test } from "bun:test";

import { lintSingleRule, runSingleRule } from "./lint-single-rule.ts";

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

test("autofixes bare static whitespace-normal on Button className", async () => {
  expect(
    await runSingleRule(
      "no-button-whitespace-normal",
      [
        '<Button className="whitespace-normal" />;',
        '<Button className="px-2 whitespace-normal text-sm" />;',
        '<Button className="whitespace-normal!" />;',
        '<Button layout="wrap" className="px-2 whitespace-normal" />;',
        '<Button layout="wrap" className="whitespace-normal" />;',
      ].join("\n"),
      { sourcePath: "source.tsx", fix: true },
    ),
  ).toEqual({
    lines: [],
    source: [
      '<Button layout="wrap" />;',
      '<Button layout="wrap" className="px-2 text-sm" />;',
      '<Button layout="wrap" />;',
      '<Button layout="wrap" className="px-2" />;',
      '<Button layout="wrap" />;',
    ].join("\n"),
  });

  const nonMechanical = [
    '<Button className="max-sm:whitespace-normal" />;',
    '<Button className={cn("px-2", "whitespace-normal")} />;',
  ].join("\n");
  expect(
    await runSingleRule("no-button-whitespace-normal", nonMechanical, {
      sourcePath: "source.tsx",
      fix: true,
    }),
  ).toEqual({ lines: [1, 2], source: nonMechanical });
});
