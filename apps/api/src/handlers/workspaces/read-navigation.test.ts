import { describe, expect, mock, test } from "bun:test";

import { toSafeId } from "@/api/lib/branded-types";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import { createScopedDbMock } from "@/api/tests/scoped-db-mock";

import readWorkspaceNavigation from "./read-navigation";

type ReadWorkspaceNavigationContext = Parameters<
  typeof readWorkspaceNavigation.handler
>[0];

const workspaceRows = [
  {
    defaultViewId: toSafeId<"workspaceView">(
      "019c0c90-0000-7000-8000-000000000103",
    ),
    id: toSafeId<"workspace">("019c0c90-0000-7000-8000-000000000003"),
    name: "Appeal",
    reference: "MAT-003",
    clientId: null,
    color: null,
    status: "archived" as const,
    lastActivityAt: new Date("2026-07-30T12:00:00.000Z"),
    lastActivityAtCursor: "2026-07-30T12:00:00.000000Z",
    clientRecordId: null,
    clientDisplayName: null,
  },
  {
    defaultViewId: toSafeId<"workspaceView">(
      "019c0c90-0000-7000-8000-000000000102",
    ),
    id: toSafeId<"workspace">("019c0c90-0000-7000-8000-000000000002"),
    name: "Merger",
    reference: "MAT-002",
    clientId: toSafeId<"contact">("019c0c90-0000-7000-8000-000000000010"),
    color: "blue",
    status: "active" as const,
    lastActivityAt: new Date("2026-07-29T12:00:00.000Z"),
    lastActivityAtCursor: "2026-07-29T12:00:00.000000Z",
    clientRecordId: toSafeId<"contact">("019c0c90-0000-7000-8000-000000000010"),
    clientDisplayName: "Northwind Holdings",
  },
  {
    defaultViewId: null,
    id: toSafeId<"workspace">("019c0c90-0000-7000-8000-000000000001"),
    name: "Investigation",
    reference: "MAT-001",
    clientId: null,
    color: null,
    status: "active" as const,
    lastActivityAt: new Date("2026-07-28T12:00:00.000Z"),
    lastActivityAtCursor: "2026-07-28T12:00:00.000000Z",
    clientRecordId: null,
    clientDisplayName: null,
  },
];

const createContext = ({
  query,
  rows = workspaceRows,
}: {
  query: ReadWorkspaceNavigationContext["query"];
  rows?: typeof workspaceRows;
}) => {
  const limit = mock(async () => rows);
  const select = mock((_selection?: unknown) => ({
    from: () => ({
      leftJoin: () => ({
        where: () => ({
          orderBy: () => ({ limit }),
        }),
      }),
    }),
  }));
  const { safeDb, scopedDb } = createScopedDbMock({
    select,
  });

  return {
    context: asTestRaw<ReadWorkspaceNavigationContext>({
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
    limit,
    select,
  };
};

describe("workspace navigation pagination", () => {
  test("returns a cursor page while preserving active navigation fields", async () => {
    const { context, limit, select } = createContext({
      query: { limit: 2, statusScope: "active-and-archived" },
    });

    const result = await readWorkspaceNavigation.handler(context);

    expect(limit).toHaveBeenCalledWith(3);
    expect(select).toHaveBeenCalledWith(
      expect.objectContaining({ defaultViewId: expect.anything() }),
    );
    expect(result).toEqual({
      items: [
        expect.objectContaining({
          defaultViewId: "019c0c90-0000-7000-8000-000000000103",
          name: "Appeal",
          status: "archived",
        }),
        expect.objectContaining({
          client: {
            id: "019c0c90-0000-7000-8000-000000000010",
            displayName: "Northwind Holdings",
          },
          name: "Merger",
          status: "active",
        }),
      ],
      limit: 2,
      nextCursor: expect.any(String),
      workspaces: [
        expect.objectContaining({ name: "Appeal", status: "archived" }),
        expect.objectContaining({ name: "Merger", status: "active" }),
      ],
    });
  });

  test("rejects malformed cursors before querying", async () => {
    const { context, limit } = createContext({
      query: { cursor: "not-a-cursor", statusScope: "active-and-archived" },
    });

    const result = await readWorkspaceNavigation.handler(context);

    expect(result).toEqual({
      code: 400,
      response: { message: "Invalid cursor" },
    });
    expect(limit).not.toHaveBeenCalled();
  });
});
