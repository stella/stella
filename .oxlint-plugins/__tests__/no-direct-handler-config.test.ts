import { expect, test } from "bun:test";

import { lintSingleRule } from "./lint-single-rule.ts";

const lint = async (lines: readonly string[]) =>
  await lintSingleRule("no-direct-handler-config", lines.join("\n"), {
    plugin: "require-safe-route-handlers",
  });

test("rejects writes to a retained endpoint config", async () => {
  expect(
    await lint([
      "Object.assign(endpoint.config, { permissions: {} });",
      "Reflect.deleteProperty(endpoint.config.permissions, 'workspace');",
      "(endpoint.config as Mutable).permissions = {};",
      "delete (endpoint.config as Mutable).mcp;",
      "(endpoint.config as Mutable).retries++;",
      "Object.defineProperty(endpoint.config, 'mcp', { value: {} });",
      "",
    ]),
  ).toEqual([1, 2, 3, 4, 5, 6]);
});

test("accepts reads and fresh copies of the config", async () => {
  expect(
    await lint([
      "const copy = Object.assign({}, endpoint.config, { body });",
      "const permissions = endpoint.config.permissions;",
      "export const r = routes({ '/': { GET: endpoint } });",
      "settings.configured = true;",
      "",
    ]),
  ).toEqual([]);
});
