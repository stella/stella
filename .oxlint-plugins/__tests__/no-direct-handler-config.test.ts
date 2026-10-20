import { expect, test } from "bun:test";

import { lintSingleRule } from "./lint-single-rule.ts";

test("rejects mutable endpoint config for supported HTTP route verbs", async () => {
  expect(
    await lintSingleRule(
      "no-direct-handler-config",
      'app.get("/", endpoint.config, endpoint.handler);\napp.post("/", endpoint.config, endpoint.handler);\napp.put("/", endpoint.config, endpoint.handler);\napp.patch("/", endpoint.config, endpoint.handler);\napp.delete("/", endpoint.config, endpoint.handler);',
      { plugin: "require-safe-route-handlers" },
    ),
  ).toEqual([1, 2, 3, 4, 5]);
});

test("accepts fresh projections instead of sharing the mutable config", async () => {
  expect(
    await lintSingleRule(
      "no-direct-handler-config",
      'app.post("/", { body: endpoint.config.body, permissions: endpoint.config.permissions }, endpoint.handler);\napp.get("/", endpoint.handler);',
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
