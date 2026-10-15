import { expect, test } from "bun:test";

import { lintSingleRule } from "./lint-single-rule";

test("reports direct request access at each binding", async () => {
  expect(
    await lintSingleRule(
      "confine-server-reads",
      'import { getCookie as readCookie } from "@tanstack/react-start/server";\nimport { getRequestHeader as readHeader } from "@tanstack/react-start/server";',
    ),
  ).toEqual([1, 2]);
});

test("reports request access through namespace and dynamic bindings", async () => {
  expect(
    await lintSingleRule(
      "confine-server-reads",
      'import * as server from "@tanstack/react-start/server";\nserver["getRequestHeaders"]();\nconst { getRequest } = await import("@tanstack/react-start/server");',
    ),
  ).toEqual([2, 3]);
});

test("allows approved server helpers and unrelated local accessors", async () => {
  expect(
    await lintSingleRule(
      "confine-server-reads",
      'import { getRequestHost } from "@tanstack/react-start/server";\ngetRequestHost();\nconst local = { getCookie: () => "locale" };\nlocal.getCookie();',
    ),
  ).toEqual([]);
});
