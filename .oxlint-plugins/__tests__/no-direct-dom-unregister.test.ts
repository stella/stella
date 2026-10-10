import { expect, test } from "bun:test";

import { lintSingleRule } from "./lint-single-rule";

test("rejects direct GlobalRegistrator teardown", async () => {
  expect(
    await lintSingleRule(
      "no-direct-dom-unregister",
      [
        "await GlobalRegistrator.unregister();",
        "GlobalRegistrator.unregister({});",
        "await unregisterDomEnvironment();",
        "await OtherRegistrator.unregister();",
      ].join("\n"),
    ),
  ).toEqual([1, 2]);
});
