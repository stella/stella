import { describe, expect, test } from "bun:test";

import { lintSingleRule } from "./lint-single-rule";

describe("no-legacy-entity-route", () => {
  test("reports the removed route", async () => {
    expect(
      await lintSingleRule(
        "no-legacy-entity-route",
        'navigate({ to: "/workspaces/$workspaceId/entities/$entityId" });',
      ),
    ).toEqual([1]);
  });
  test("reports constructed legacy routes", async () => {
    expect(
      await lintSingleRule(
        "no-legacy-entity-route",
        `const route = \`/workspaces/\${workspaceId}/entities/\${entityId}?tab=files\`;`,
      ),
    ).toEqual([1]);
  });
  test("accepts canonical document routes", async () => {
    expect(
      await lintSingleRule(
        "no-legacy-entity-route",
        'navigate({ to: "/workspaces/$workspaceId/$viewId/document" });',
      ),
    ).toEqual([]);
  });
  test("accepts entity API endpoints", async () => {
    expect(
      await lintSingleRule(
        "no-legacy-entity-route",
        `const route = \`/entities/\${workspaceId}/entity/\${entityId}\`;`,
      ),
    ).toEqual([]);
  });
});
