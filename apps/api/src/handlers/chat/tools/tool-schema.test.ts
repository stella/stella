import { describe, expect, test } from "bun:test";

import type { ScopedDb } from "@/api/db";
import { toSafeId } from "@/api/lib/branded-types";

import { createOrgTools } from "./org-tools";
import { createWorkspaceTools } from "./workspace-tools";

const organizationId = toSafeId<"organization">(
  "11111111-1111-4111-8111-111111111111",
);
const userId = toSafeId<"user">("22222222-2222-4222-8222-222222222222");
const workspaceId = toSafeId<"workspace">(
  "33333333-3333-4333-8333-333333333333",
);

const unusedScopedDb: ScopedDb = async () => {
  throw new Error("This test only constructs tool schemas.");
};

describe("chat tool schemas", () => {
  test("construct org-level tools as JSON-schema-compatible AI tools", () => {
    expect(() =>
      createOrgTools({
        accessibleWorkspaceIds: [workspaceId],
        organizationId,
        scopedDb: unusedScopedDb,
      }),
    ).not.toThrow();
  });

  test("construct workspace tools as JSON-schema-compatible AI tools", () => {
    expect(() =>
      createWorkspaceTools({
        allowedWorkspaceIds: [workspaceId],
        organizationId,
        scopedDb: unusedScopedDb,
        userId,
      }),
    ).not.toThrow();
  });
});
