import { expect, test } from "bun:test";

import { lintSingleRule } from "./lint-single-rule.ts";

test("rejects callbacks and bare handlers for supported HTTP route verbs", async () => {
  expect(
    await lintSingleRule(
      "require-safe-route-handlers",
      'app.get("/", raw);\napp.post("/", raw);\napp.put("/", raw);\napp.patch("/", raw);\napp.delete("/", raw);\napp.get("/", () => value);',
    ),
  ).toEqual([1, 2, 3, 4, 5, 6]);
});

test("accepts safe endpoint handlers with fresh projected options", async () => {
  expect(
    await lintSingleRule(
      "require-safe-route-handlers",
      'app.get("/", endpoint.handler);\napp.post("/", endpoint.handler, { body: endpoint.config.body });',
    ),
  ).toEqual([]);
});

test("does not treat middleware registration as an HTTP handler", async () => {
  expect(
    await lintSingleRule(
      "require-safe-route-handlers",
      'app.use(raw);\napp.group("/", raw);',
    ),
  ).toEqual([]);
});
