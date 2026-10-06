import { describe, expect, setDefaultTimeout, test } from "bun:test";

import { lintSingleRule } from "./lint-single-rule.ts";

setDefaultTimeout(20_000);

const rule = "require-json-import-attribute";

describe.serial("static runtime JSON imports", () => {
  test("reports every runtime import form without the JSON attribute", async () => {
    expect(
      await lintSingleRule(
        rule,
        [
          'import bare from "./bare.json";',
          'import * as namespace from "./namespace.json";',
          'import "./side-effect.json";',
          'import wrong from "./wrong.json" with { type: "text" };',
          'import { type Example } from "./inline-type.json";',
        ].join("\n"),
      ),
    ).toEqual([1, 2, 3, 4, 5]);
  });

  test("accepts JSON attributes, erased type imports and other modules", async () => {
    expect(
      await lintSingleRule(
        rule,
        [
          'import valid from "./valid.json" with { type: "json" };',
          'import quoted from "./quoted.json" with { "type": "json" };',
          'import * as namespace from "./namespace.json" with { type: "json" };',
          'import "./side-effect.json" with { type: "json" };',
          'import type { Example } from "./type.json";',
          'import ordinary from "./module.js";',
          'const dynamic = import("./dynamic.json", { with: { type: "json" } });',
        ].join("\n"),
      ),
    ).toEqual([]);
  });
});
