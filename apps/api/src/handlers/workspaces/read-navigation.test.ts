import { describe, expect, mock, test } from "bun:test";

import { toSafeId } from "@/api/lib/branded-types";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import { createScopedDbMock } from "@/api/tests/scoped-db-mock";

import readWorkspaceNavigation from "./read-navigation";

type ReadWorkspaceNavigationContext = Parameters<
  typeof readWorkspaceNavigation.handler
>[0];

const runNavigationQuery = async (
  statusScope?: "active" | "active-and-archived",
) => {
  const findMany = mock(async () => []);
  const { safeDb, scopedDb } = createScopedDbMock({
    query: {
      workspaces: { findMany },
    },
  });
  const query = statusScope === undefined ? {} : { statusScope };

  await readWorkspaceNavigation.handler(
    asTestRaw<ReadWorkspaceNavigationContext>({
      memberRole: { role: "owner" },
      orgAIConfig: null,
      query,
      safeDb,
      scopedDb,
      session: {
        activeOrganizationId: toSafeId<"organization">("organization_test123"),
      },
      user: { id: toSafeId<"user">("user_test123") },
    }),
  );

  return findMany;
};

describe("workspace navigation status scope", () => {
  test("keeps active-only navigation as the default", async () => {
    const findMany = await runNavigationQuery();

    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ status: { eq: "active" } }),
      }),
    );
  });

  test("includes archived matters for memory while excluding deleting", async () => {
    const findMany = await runNavigationQuery("active-and-archived");

    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ status: { ne: "deleting" } }),
      }),
    );
  });
});
