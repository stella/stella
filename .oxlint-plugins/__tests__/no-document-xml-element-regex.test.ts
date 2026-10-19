import { expect, test } from "bun:test";

import { lintSingleRule } from "./lint-single-rule.ts";

test("keeps document element parsing on the shared reader", async () => {
  expect(
    await lintSingleRule(
      "no-document-xml-element-regex",
      "xml.match(/<item>[\\s\\S]*?<\\/item>/u);\nxml.match(/<item>.*?<\\/item>/su);",
      { sourcePath: "apps/api/src/lib/files/read.ts" },
    ),
  ).toEqual([1, 2]);
  expect(
    await lintSingleRule(
      "no-document-xml-element-regex",
      "xml.match(/<item>[\\s\\S]*?<\\/item>/u);",
      { sourcePath: "apps/api/src/lib/document-translation/segments.ts" },
    ),
  ).toEqual([1]);
});

test("accepts bounded patterns and code outside document modules", async () => {
  const source = "xml.match(/<item>[^<]*<\\/item>/u);";
  expect(
    await lintSingleRule("no-document-xml-element-regex", source, {
      sourcePath: "apps/api/src/lib/files/read.ts",
    }),
  ).toEqual([]);
  expect(
    await lintSingleRule("no-document-xml-element-regex", source, {
      sourcePath: "apps/web/src/read.ts",
    }),
  ).toEqual([]);
});
