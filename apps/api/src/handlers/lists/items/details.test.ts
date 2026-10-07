import { describe, expect, test } from "bun:test";

import { LIST_DETAILS_STATUS } from "@stll/api-contract/list-details";
import { roles } from "@stll/permissions";

import {
  AUDIT_ACTION,
  AUDIT_RESOURCE_TYPE,
} from "@/api/lib/audit-log.constants";
import {
  createFeatureAccessSnapshot,
  decideFeatureAccess,
} from "@/api/lib/auth/feature-access/policy";
import type { FeatureAccessSnapshot } from "@/api/lib/auth/feature-access/policy";
import { toSafeId } from "@/api/lib/branded-types";
import {
  FEATURE_REGISTRY,
  LIST_VERIFICATION_FEATURE_ID,
} from "@/api/lib/feature-access/registry";
import { LIST_VERIFICATION_ITEM_OPERATION } from "@/api/lib/lists/item-operations";
import { isMemberRole } from "@/api/lib/member-roles";
import {
  hasMemberPermission,
  sessionMemberRole,
} from "@/api/lib/permission-authorization";
import { isRecord } from "@/api/lib/type-guards";
import { mapHandlerResult } from "@/api/mcp/capability-tools";
import { CAPABILITY_DISPATCH as activityDispatch } from "@/api/mcp/generated/capability-dispatch/lists.items.activity.list";
import { CAPABILITY_DISPATCH as itemDispatch } from "@/api/mcp/generated/capability-dispatch/lists.items.list";
import { CAPABILITY_DISPATCH as sourceDispatch } from "@/api/mcp/generated/capability-dispatch/lists.items.sources.list";
import { isMcpEgressPlan } from "@/api/mcp/tool-types";
import { createTestHandlerContext } from "@/api/tests/helpers/handler-context";
import { createScopedDbMock } from "@/api/tests/scoped-db-mock";

import readActivity from "./activity/list";
import readItems from "./list";
import readSources from "./sources/list";

const principal = {
  organizationId: toSafeId<"organization">("org_test"),
  userId: toSafeId<"user">("user_test"),
};
const workspaceId = toSafeId<"workspace">(
  "00000000-0000-4000-8000-000000000001",
);
const listId = toSafeId<"legalList">("00000000-0000-4000-8000-000000000002");
const itemId = toSafeId<"entity">("00000000-0000-4000-8000-000000000003");
const createdAt = new Date("2026-07-16T12:00:00.000Z");
type Item = Extract<
  Awaited<ReturnType<typeof readItems.handler>>,
  { items: unknown }
>["items"][number];
const detail = {
  confidence: "medium",
  occurredOn: null,
  occurredOnPrecision: null,
  evidenceKind: "record",
  medium: "email",
  interpretationNote: "Two accounts differ.",
  scoring: "held",
} as const satisfies NonNullable<Item["factDetails"]>;
const firstSource = {
  documentId: itemId,
  documentName: "Record.pdf",
  locator: { type: "document" },
} as const satisfies NonNullable<Item["firstSource"]>;
const item = {
  id: itemId,
  name: "Meeting",
  itemType: "fact",
  status: "open",
  priority: "none",
  dueDate: null,
  sectionId: null,
  position: "a",
  description: null,
  reviewStatus: "unreviewed",
  createdAt,
  updatedAt: createdAt,
  factDetails: detail,
  firstSource,
} as const;
type Source = Extract<
  Awaited<ReturnType<typeof readSources.handler>>,
  { items: unknown }
>["items"][number];
const source = {
  id: toSafeId<"legalListItemSource">("00000000-0000-4000-8000-000000000004"),
  sourceEntityId: itemId,
  sourceEntityVersionId: toSafeId<"entityVersion">(
    "00000000-0000-4000-8000-000000000005",
  ),
  locator: { type: "document" },
  quote: "A record of the meeting.",
  verificationStatus: "verified",
  verifiedBy: principal.userId,
  verifiedAt: createdAt,
  createdAt,
} as const satisfies Omit<Source, "verificationDetailsStatus">;
const changes = { confidence: { old: "low", new: "medium" } };
const activity = (operation: string | null) => ({
  id: toSafeId<"auditLog">("00000000-0000-4000-8000-000000000006"),
  action: AUDIT_ACTION.UPDATE,
  resourceType: AUDIT_RESOURCE_TYPE.LEGAL_LIST_ITEM,
  performerName: "Reviewer",
  userName: "Reviewer",
  changes,
  metadata: operation === null ? null : { operation },
  createdAt,
  createdAtCursor: createdAt.toISOString(),
});

const snapshot = (enabled: boolean, caller = principal) =>
  createFeatureAccessSnapshot({
    ...caller,
    decisions: new Map([
      [
        LIST_VERIFICATION_FEATURE_ID,
        decideFeatureAccess({
          ...caller,
          featureId: LIST_VERIFICATION_FEATURE_ID,
          registry: FEATURE_REGISTRY,
          grants: enabled
            ? {
                [LIST_VERIFICATION_FEATURE_ID]: [
                  {
                    type: "organization",
                    organizationId: caller.organizationId,
                  },
                ],
              }
            : {},
          user: { email: "reviewer@example.test", emailVerified: true },
          membership: true,
        }),
      ],
    ]),
  });

const queryRows = <T>(rows: readonly T[]) => {
  const chain = {
    from: () => chain,
    innerJoin: () => chain,
    leftJoin: () => chain,
    leftJoinLateral: () => chain,
    where: () => chain,
    orderBy: () => chain,
    limit: (limit: number) =>
      Object.assign(Promise.resolve(rows.slice(0, limit)), {
        as: () => firstSource,
      }),
  };
  return chain;
};

const fixture = (
  featureAccessSnapshot: FeatureAccessSnapshot | undefined,
  operation: string | null = null,
) => {
  const db = createScopedDbMock({
    query: {
      legalLists: { findFirst: async () => ({ id: listId }) },
      legalListItems: { findFirst: async () => ({ entityId: itemId }) },
    },
    select: (selection: unknown) => {
      if (isRecord(selection) && "factDetails" in selection) {
        return queryRows([item]);
      }
      if (isRecord(selection) && "propertyId" in selection) {
        return queryRows([]);
      }
      if (isRecord(selection) && "changes" in selection) {
        return queryRows([activity(operation)]);
      }
      return queryRows([source]);
    },
  });
  return {
    ...db,
    context: {
      workspaceId,
      featureAccessSnapshot,
      safeDb: db.safeDb,
      query: {},
      params: { workspaceId, listId, itemEntityId: itemId },
    },
  };
};

describe("list reader details follow invitation", () => {
  for (const role of Object.keys(roles).filter(isMemberRole)) {
    if (
      !hasMemberPermission(sessionMemberRole(role), { workspace: ["read"] })
    ) {
      continue;
    }
    for (const enrolled of [false, true]) {
      const status = enrolled
        ? LIST_DETAILS_STATUS.visible
        : LIST_DETAILS_STATUS.featureUnavailable;
      test(`${role} item and source details are ${status}`, async () => {
        const f = fixture(snapshot(enrolled));
        const items = await readItems.handler(
          createTestHandlerContext<Parameters<typeof readItems.handler>[0]>({
            ...f.context,
            memberRole: sessionMemberRole(role),
          }),
        );
        expect(items).toMatchObject({
          items: [
            {
              id: itemId,
              name: item.name,
              factDetailsStatus: status,
              factDetails: enrolled ? detail : null,
              firstSource: enrolled ? firstSource : null,
            },
          ],
          nextCursor: null,
        });
        const sources = await readSources.handler(
          createTestHandlerContext<Parameters<typeof readSources.handler>[0]>({
            ...f.context,
            memberRole: sessionMemberRole(role),
          }),
        );
        expect(sources).toMatchObject({
          items: [
            {
              id: source.id,
              quote: source.quote,
              locator: source.locator,
              verificationDetailsStatus: status,
              verificationStatus: enrolled ? source.verificationStatus : null,
              verifiedBy: enrolled ? principal.userId : null,
              verifiedAt: enrolled ? createdAt : null,
            },
          ],
          nextCursor: null,
        });
        expect(f.getCallCount()).toBe(2);
      });
    }
  }
  for (const operation of [
    ...Object.values(LIST_VERIFICATION_ITEM_OPERATION),
    "item_updated",
    null,
  ]) {
    for (const enrolled of [false, true]) {
      const visible =
        enrolled || operation === "item_updated" || operation === null;
      test(`activity ${String(operation)} follows invitation ${enrolled}`, async () => {
        const f = fixture(snapshot(enrolled), operation);
        const result = await readActivity.handler(
          createTestHandlerContext<Parameters<typeof readActivity.handler>[0]>(
            f.context,
          ),
        );
        expect(result).toMatchObject({
          items: [
            {
              action: AUDIT_ACTION.UPDATE,
              actorName: "Reviewer",
              createdAt,
              changesStatus: visible
                ? LIST_DETAILS_STATUS.visible
                : LIST_DETAILS_STATUS.featureUnavailable,
              changes: visible ? changes : null,
              operation: visible ? operation : null,
            },
          ],
          nextCursor: null,
        });
        expect(f.getCallCount()).toBe(1);
      });
    }
  }
  test.each([
    ["missing", undefined],
    [
      "different member",
      snapshot(true, {
        ...principal,
        userId: toSafeId<"user">("other_user"),
      }),
    ],
    [
      "different organization",
      snapshot(true, {
        ...principal,
        organizationId: toSafeId<"organization">("other_org"),
      }),
    ],
  ] as const)(
    "%s caller context retains reader identity with unavailable detail",
    async (_label, featureAccessSnapshot) => {
      const f = fixture(
        featureAccessSnapshot,
        LIST_VERIFICATION_ITEM_OPERATION.factDetailsSet,
      );
      const result = await readItems.handler(
        createTestHandlerContext<Parameters<typeof readItems.handler>[0]>(
          f.context,
        ),
      );
      expect(result).toMatchObject({
        items: [
          {
            id: itemId,
            factDetailsStatus: LIST_DETAILS_STATUS.featureUnavailable,
            factDetails: null,
            firstSource: null,
          },
        ],
      });
      const sources = await readSources.handler(
        createTestHandlerContext<Parameters<typeof readSources.handler>[0]>(
          f.context,
        ),
      );
      expect(sources).toMatchObject({
        items: [
          {
            id: source.id,
            verificationDetailsStatus: LIST_DETAILS_STATUS.featureUnavailable,
            verificationStatus: null,
            verifiedBy: null,
            verifiedAt: null,
          },
        ],
      });
      const activityResult = await readActivity.handler(
        createTestHandlerContext<Parameters<typeof readActivity.handler>[0]>(
          f.context,
        ),
      );
      expect(activityResult).toMatchObject({
        items: [
          {
            action: AUDIT_ACTION.UPDATE,
            changesStatus: LIST_DETAILS_STATUS.featureUnavailable,
            changes: null,
            operation: null,
          },
        ],
      });
      expect(f.getCallCount()).toBe(3);
    },
  );

  for (const enrolled of [false, true]) {
    test(`generated dispatch and egress preserve all reader statuses for invitation ${enrolled}`, async () => {
      const f = fixture(
        snapshot(enrolled),
        LIST_VERIFICATION_ITEM_OPERATION.factDetailsSet,
      );
      const itemEndpoint = await itemDispatch["lists.items.list"].load();
      const sourceEndpoint =
        await sourceDispatch["lists.items.sources.list"].load();
      const activityEndpoint =
        await activityDispatch["lists.items.activity.list"].load();
      const results = [
        {
          id: "lists.items.list",
          result: await itemEndpoint.default.handler(
            createTestHandlerContext<Parameters<typeof readItems.handler>[0]>(
              f.context,
            ),
          ),
          status: "factDetailsStatus",
        },
        {
          id: "lists.items.sources.list",
          result: await sourceEndpoint.default.handler(
            createTestHandlerContext<Parameters<typeof readSources.handler>[0]>(
              f.context,
            ),
          ),
          status: "verificationDetailsStatus",
        },
        {
          id: "lists.items.activity.list",
          result: await activityEndpoint.default.handler(
            createTestHandlerContext<
              Parameters<typeof readActivity.handler>[0]
            >(f.context),
          ),
          status: "changesStatus",
        },
      ];
      for (const { id, result, status } of results) {
        const wire = mapHandlerResult({ id, result, access: "read" });
        if (!isMcpEgressPlan(wire) || wire.egress !== "structured") {
          throw new TypeError("List capabilities return structured results");
        }
        expect(wire.payload).toMatchObject({
          items: [
            {
              [status]: enrolled
                ? LIST_DETAILS_STATUS.visible
                : LIST_DETAILS_STATUS.featureUnavailable,
            },
          ],
        });
      }
    });
  }
});
