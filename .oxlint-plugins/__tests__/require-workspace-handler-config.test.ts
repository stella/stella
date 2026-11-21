import { expect, test } from "bun:test";

import { lintSingleRule } from "./lint-single-rule.ts";

test("rejects wide workspace config at its declaration", async () => {
  expect(
    await lintSingleRule(
      "require-workspace-handler-config",
      "const config = { params } satisfies HandlerConfig;\ncreateSafeHandler(config, handler);",
    ),
  ).toEqual([1]);
});

test("rejects inline wide workspace config", async () => {
  expect(
    await lintSingleRule(
      "require-workspace-handler-config",
      "createSafeHandler({ params } satisfies HandlerConfig, handler);",
    ),
  ).toEqual([1]);
});

test("accepts the workspace-specific config contract", async () => {
  expect(
    await lintSingleRule(
      "require-workspace-handler-config",
      "const config = { params } satisfies WorkspaceHandlerConfig;\ncreateSafeHandler(config, handler);",
    ),
  ).toEqual([]);
});

test("accepts wide config on non-workspace factories", async () => {
  expect(
    await lintSingleRule(
      "require-workspace-handler-config",
      "const config = { params } satisfies HandlerConfig;\ncreateSafeRootHandler(config, handler);\ncreateSafeTokenHandler(config, handler);",
    ),
  ).toEqual([]);
});

test("respects a shadowing config parameter", async () => {
  expect(
    await lintSingleRule(
      "require-workspace-handler-config",
      "const config = {} satisfies HandlerConfig;\nfunction mount(config) { createSafeHandler(config, handler); }",
    ),
  ).toEqual([]);
});
