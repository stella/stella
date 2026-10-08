import { expect, test } from "bun:test";

import { lintSingleRule } from "./lint-single-rule.ts";

const lint = async (source: string) =>
  lintSingleRule("no-section-sign-glyph", source, { sourcePath: "source.tsx" });

test("rejects a lone section sign as element text", async () => {
  expect(await lint('const mark = <div className="mark">§</div>;')).toEqual([
    1,
  ]);
});

test("rejects entity and escaped forms", async () => {
  expect(await lint("const mark = <div>&sect;</div>;")).toEqual([1]);
  expect(await lint('const mark = <div>{"\\u00a7"}</div>;')).toEqual([1]);
  expect(await lint("const mark = <div>{`§`}</div>;")).toEqual([1]);
});

test("rejects a lone section sign in an attribute", async () => {
  expect(await lint('const mark = <Badge label="§" />;')).toEqual([1]);
  expect(await lint('const mark = <Badge label={"§"} />;')).toEqual([1]);
});

test("allows legal text and parser data", async () => {
  expect(await lint("const text = <span>§ 10 or a heading</span>;")).toEqual(
    [],
  );
  expect(await lint('const text = <span title="§§ 2-4" />;')).toEqual([]);
  expect(await lint('const marker = "§";')).toEqual([]);
});
