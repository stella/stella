import { beforeEach, describe, expect, test } from "bun:test";

import { AUDIT_CHANGES_STATUS } from "@stll/api-contract/audit-log";

import { env } from "@/api/env";
import {
  AUDIT_ACTION,
  AUDIT_RESOURCE_TYPE,
} from "@/api/lib/audit-log.constants";
import { toSafeId } from "@/api/lib/branded-types";
import {
  createFeatureAccessSnapshot,
  decideFeatureAccess,
} from "@/api/lib/feature-access/policy";
import type { FeatureAccessSnapshot } from "@/api/lib/feature-access/policy";
import { featurePrerequisiteClosure } from "@/api/lib/feature-access/prerequisites";
import {
  FEATURE_REGISTRY,
  LIST_VERIFICATION_FEATURE_ID,
} from "@/api/lib/feature-access/registry";
import { LIST_VERIFICATION_ITEM_OPERATION } from "@/api/lib/lists/item-operations";
import {
  NO_AUDIT,
  NO_DB,
  createTestHandlerContext,
} from "@/api/tests/helpers/handler-context";
import { createTestState } from "@/api/tests/helpers/test-state";
import { createScopedDbMock } from "@/api/tests/scoped-db-mock";

import readActivity from "./activity/list";

const testState = createTestState({ file: import.meta.path, config: env });
beforeEach(() => testState.setConfig("FEATURE_LEGAL_LISTS", true));
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
const changes = { confidence: { old: "low", new: "medium" } };
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
            ? Object.fromEntries(
                [
                  ...featurePrerequisiteClosure(
                    FEATURE_REGISTRY,
                    LIST_VERIFICATION_FEATURE_ID,
                  ),
                ].map((id) => [
                  id,
                  [
                    {
                      type: "organization" as const,
                      organizationId: caller.organizationId,
                    },
                  ],
                ]),
              )
            : {},
          user: { email: "reviewer@example.test", emailVerified: true },
          membership: true,
        }),
      ],
    ]),
  });

const fixture = (
  featureAccessSnapshot: FeatureAccessSnapshot | undefined,
  operation: string | null,
) => {
  const chain = {
    from: () => chain,
    leftJoin: () => chain,
    where: () => chain,
    orderBy: () => chain,
    limit: () =>
      Promise.resolve([
        {
          id: toSafeId<"auditLog">("00000000-0000-4000-8000-000000000006"),
          action: AUDIT_ACTION.UPDATE,
          resourceType: AUDIT_RESOURCE_TYPE.LEGAL_LIST_ITEM,
          performerName: "Reviewer",
          userName: "Reviewer",
          changes,
          metadata: operation === null ? null : { operation },
          createdAt,
          createdAtCursor: createdAt.toISOString(),
        },
      ]),
  };
  const db = createScopedDbMock({
    query: {
      legalListItems: { findFirst: async () => ({ entityId: itemId }) },
    },
    select: () => chain,
  });
  return {
    ...db,
    context: {
      workspaceId,
      featureAccessSnapshot,
      safeDb: db.safeDb,
      scopedDb: NO_DB,
      audit: NO_AUDIT,
      query: {},
      params: { workspaceId, listId, itemEntityId: itemId },
    },
  };
};
describe("list activity verification details follow caller access", () => {
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
                ? AUDIT_CHANGES_STATUS.visible
                : AUDIT_CHANGES_STATUS.featureUnavailable,
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
});
