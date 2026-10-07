import { describe, expect, test } from "bun:test";

import { lintSingleRule } from "./lint-single-rule.ts";

describe("require-rfc3986-resource-encoding", () => {
  test("reports insufficient component encoding", async () => {
    expect(
      await lintSingleRule(
        "require-rfc3986-resource-encoding",
        "const uri = encodeURIComponent(id);",
        { plugin: "no-raw-resource-uri" },
      ),
    ).toEqual([1]);
  });
  test("reports encoding even in composite URI expressions", async () => {
    expect(
      await lintSingleRule(
        "require-rfc3986-resource-encoding",
        'const uri = prefix + encodeURIComponent(workspaceId) + "/" + encodeURIComponent(entityId);',
        { plugin: "no-raw-resource-uri" },
      ),
    ).toEqual([1, 1]);
  });
  test("accepts the strict encoder", async () => {
    expect(
      await lintSingleRule(
        "require-rfc3986-resource-encoding",
        "const uri = encodeRfc3986Component(id);",
        { plugin: "no-raw-resource-uri" },
      ),
    ).toEqual([]);
  });
  test("accepts canonical resource serializers", async () => {
    expect(
      await lintSingleRule(
        "require-rfc3986-resource-encoding",
        "const uri = toResourceName(resource);\nconst href = toChatResourceHref(resource);",
        { plugin: "no-raw-resource-uri" },
      ),
    ).toEqual([]);
  });
});
