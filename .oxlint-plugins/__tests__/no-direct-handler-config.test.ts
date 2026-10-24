import { expect, test } from "bun:test";

import { lintSingleRule } from "./lint-single-rule.ts";

test("routes without options do not forward a partial access policy", async () => {
  expect(
    await lintSingleRule(
      "no-direct-handler-config",
      'app.get("/", endpoint.handler);\napp.post("/", endpoint.handler);',
      { plugin: "require-safe-route-handlers" },
    ),
  ).toEqual([]);
});

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
      'app.post("/", endpoint.handler, { body: endpoint.config.body, permissions: endpoint.config.permissions, accountAccess: endpoint.config.accountAccess });\napp.get("/", endpoint.handler);',
      { plugin: "require-safe-route-handlers" },
    ),
  ).toEqual([]);
});

test("requires account access from the same endpoint as forwarded permissions", async () => {
  expect(
    await lintSingleRule(
      "no-direct-handler-config",
      'app.post("/missing", endpoint.handler, { permissions: endpoint.config.permissions });\napp.post("/mismatched", endpoint.handler, { permissions: endpoint.config.permissions, accountAccess: other.config.accountAccess });',
      { plugin: "require-safe-route-handlers" },
    ),
  ).toEqual([1, 2]);
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
