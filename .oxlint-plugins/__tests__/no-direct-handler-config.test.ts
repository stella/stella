import { expect, test } from "bun:test";

import { lintSingleRule } from "./lint-single-rule.ts";

test("rejects mutable endpoint config for supported HTTP route verbs", async () => {
  expect(
    await lintSingleRule(
      "no-direct-handler-config",
      'app.get("/", endpoint.handler, endpoint.config);\napp.post("/", endpoint.handler, endpoint.config);\napp.put("/", endpoint.handler, endpoint.config);\napp.patch("/", endpoint.handler, endpoint.config);\napp.delete("/", endpoint.handler, endpoint.config);',
      { plugin: "require-safe-route-handlers" },
    ),
  ).toEqual([1, 2, 3, 4, 5]);
});

test("accepts fresh projections instead of sharing the mutable config", async () => {
  expect(
    await lintSingleRule(
      "no-direct-handler-config",
      'app.post("/", endpoint.handler, { body: endpoint.config.body, permissions: endpoint.config.permissions });\napp.get("/", endpoint.handler);',
      { plugin: "require-safe-route-handlers" },
    ),
  ).toEqual([]);
});

test("leaves non-route config consumers alone", async () => {
  expect(
    await lintSingleRule(
      "no-direct-handler-config",
      'app.use(endpoint.config);\napp.group("/", endpoint.handler, endpoint.config);',
      { plugin: "require-safe-route-handlers" },
    ),
  ).toEqual([]);
});
