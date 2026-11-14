import { expect, test } from "bun:test";

import { lintSingleRule } from "./lint-single-rule";

const RULE = "no-raw-e2e-route-fulfill";

test("rejects a raw fulfill however the route is reached", async () => {
  expect(
    await lintSingleRule(
      RULE,
      [
        "declare const route: { fulfill: (options: object) => Promise<void> } | undefined;",
        "void route?.fulfill({ json: { items: [] } });",
        'void route?.["fulfill"]({ status: 204 });',
        'void route?.fulfill({ contentType: "application/json", body: JSON.stringify({ success: true }) });',
      ].join("\n"),
    ),
  ).toEqual([2, 3, 4]);
});

test("accepts the owner's responder and other route calls", async () => {
  expect(
    await lintSingleRule(
      RULE,
      [
        "declare const route: { continue: () => Promise<void>; fallback: () => Promise<void>; abort: (code: string) => Promise<void> };",
        "declare const respond: (route: object, reply: object) => Promise<void>;",
        "declare const apiJson: (path: string, method: string, body: object) => object;",
        'void respond(route, apiJson("v1/lists/:workspaceId", "get", { items: [] }));',
        "void route.continue();",
        "void route.fallback();",
        'void route.abort("failed");',
      ].join("\n"),
    ),
  ).toEqual([]);
});
