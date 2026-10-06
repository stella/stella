import { describe, expect, mock, test } from "bun:test";

import {
  createFeatureAccessSnapshot,
  decideFeatureAccess,
} from "@/api/lib/auth/feature-access/policy";
import { toSafeId } from "@/api/lib/branded-types";
import { FEATURE_REGISTRY } from "@/api/lib/feature-access/registry";
import { sessionMemberRole } from "@/api/lib/permission-authorization";
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

const timeBillingSnapshot = ({
  organizationId,
  userId,
  enrolled,
  deploymentEnabled = true,
}: {
  organizationId: string;
  userId: string;
  enrolled: boolean;
  deploymentEnabled?: boolean;
}) => {
  const featureId = "time-billing";
  const decision = decideFeatureAccess({
    registry: FEATURE_REGISTRY,
    grants: {},
    featureId,
    organizationId,
    userId,
    user: { email: "billing@example.test", emailVerified: true },
    membership: true,
    enrolments: enrolled ? [{ featureId, organizationId, userId }] : [],
    deploymentEnabled,
  });

  return createFeatureAccessSnapshot({
    organizationId,
    userId,
    decisions: new Map([[featureId, decision]]),
  });
};

const createContext = ({
  query,
  rows = workspaceRows,
  featureAccessSnapshot = createFeatureAccessSnapshot({
    organizationId: "organization_test123",
    userId: "user_test123",
    decisions: new Map(),
  }),
}: {
  query: ReadWorkspaceNavigationContext["query"];
  rows?: typeof workspaceRows;
  featureAccessSnapshot?: ReadWorkspaceNavigationContext["featureAccessSnapshot"];
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
      featureAccessSnapshot,
      memberRole: sessionMemberRole("owner"),
      orgAIConfig: null,
      query,
      request: new Request("https://example.test/v1/workspaces/navigation"),
      route: "/v1/workspaces/navigation",
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
      features: { timeBilling: false },
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

  test.each([
    {
      name: "enrolled principal",
      snapshot: timeBillingSnapshot({
        organizationId: "organization_test123",
        userId: "user_test123",
        enrolled: true,
      }),
      timeBilling: true,
    },
    {
      name: "unenrolled principal",
      snapshot: timeBillingSnapshot({
        organizationId: "organization_test123",
        userId: "user_test123",
        enrolled: false,
      }),
      timeBilling: false,
    },
    {
      name: "deployment-disabled feature",
      snapshot: timeBillingSnapshot({
        organizationId: "organization_test123",
        userId: "user_test123",
        enrolled: true,
        deploymentEnabled: false,
      }),
      timeBilling: false,
    },
  ])(
    "reports time billing for $name without extra queries",
    async ({ snapshot, timeBilling }) => {
      const { context, limit, select } = createContext({
        query: { statusScope: "active-and-archived" },
        featureAccessSnapshot: snapshot,
      });

      const result = await readWorkspaceNavigation.handler(context);

      expect(result).toEqual(
        expect.objectContaining({ features: { timeBilling } }),
      );
      expect(select).toHaveBeenCalledTimes(1);
      expect(limit).toHaveBeenCalledTimes(1);
    },
  );

  test("rejects a feature snapshot for another principal before querying", async () => {
    const { context, limit, select } = createContext({
      query: { statusScope: "active-and-archived" },
      featureAccessSnapshot: timeBillingSnapshot({
        organizationId: "organization_other123",
        userId: "user_test123",
        enrolled: true,
      }),
    });

    const result = await readWorkspaceNavigation.handler(context);

    expect(result).toEqual({
      code: 500,
      response: {
        code: "internal_server_error",
        message: "Internal server error",
      },
    });
    expect(select).not.toHaveBeenCalled();
    expect(limit).not.toHaveBeenCalled();
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
