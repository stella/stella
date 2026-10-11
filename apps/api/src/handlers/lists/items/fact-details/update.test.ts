import { panic, Result } from "better-result";
import { expect, test } from "bun:test";

import type { Transaction } from "@/api/db/root";
import type { SafeDb } from "@/api/db/safe-db";
import { legalListFactDetails } from "@/api/db/schema";
import { toSafeId } from "@/api/lib/branded-types";
import {
  createFeatureAccessSnapshot,
  decideFeatureAccess,
} from "@/api/lib/feature-access/policy";
import {
  FEATURE_REGISTRY,
  LEGAL_LISTS_FEATURE_ID,
  LIST_VERIFICATION_FEATURE_ID,
} from "@/api/lib/feature-access/registry";
import { VERSION_CONFLICT_ERROR_CODE } from "@/api/lib/optimistic-concurrency";
import {
  NO_AUDIT,
  NO_DB,
  createTestHandlerContext,
} from "@/api/tests/helpers/handler-context";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";

import updateFactDetails from "./update";

const factDetailsFeatureAccess = () =>
  createFeatureAccessSnapshot({
    organizationId: toSafeId<"organization">("org_test"),
    userId: toSafeId<"user">("user_test"),
    decisions: new Map(
      [LEGAL_LISTS_FEATURE_ID, LIST_VERIFICATION_FEATURE_ID].map(
        (featureId) => [
          featureId,
          decideFeatureAccess({
            registry: FEATURE_REGISTRY,
            featureId,
            organizationId: toSafeId<"organization">("org_test"),
            userId: toSafeId<"user">("user_test"),
            membership: true,
            user: { email: "standard@example.test", emailVerified: true },
            grants: {
              [LEGAL_LISTS_FEATURE_ID]: [
                {
                  type: "organization",
                  organizationId: toSafeId<"organization">("org_test"),
                },
              ],
              [LIST_VERIFICATION_FEATURE_ID]: [
                {
                  type: "organization",
                  organizationId: toSafeId<"organization">("org_test"),
                },
              ],
            },
          }),
        ],
      ),
    ),
  });

test("rejects stale fact details before replacing them", async () => {
  const itemEntityId = toSafeId<"entity">("entity_test");
  const listId = toSafeId<"legalList">("list_test");
  const existing = {
    itemEntityId,
    workspaceId: toSafeId<"workspace">("workspace_test"),
    listId,
    occurredOn: null,
    occurredOnPrecision: null,
    evidenceKind: null,
    medium: null,
    confidence: "high",
    interpretationNote: null,
    scoring: "included",
    updatedAt: new Date("2026-01-02T00:00:00.000Z"),
  };
  const tx = asTestRaw<Transaction>({
    select: () => ({
      from: (table: unknown) => ({
        innerJoin: () => ({
          where: () => ({ limit: async () => [{ listItemType: "fact" }] }),
        }),
        where: () => ({
          limit:
            table === legalListFactDetails
              ? () => ({ for: async () => [existing] })
              : async () => [{ id: itemEntityId }],
        }),
      }),
    }),
    insert: () => {
      throw new Error("stale request wrote");
    },
  });
  const safeDb = asTestRaw<SafeDb>(
    async <T>(run: (tx: Transaction) => Promise<T>) =>
      Result.tryPromise(async () => await run(tx)),
  );
  const context = createTestHandlerContext<
    Parameters<typeof updateFactDetails.handler>[0]
  >({
    audit: NO_AUDIT,
    safeDb,
    scopedDb: NO_DB,
    featureAccessSnapshot: factDetailsFeatureAccess(),
    body: {
      listId,
      itemEntityId,
      occurredOn: null,
      evidenceKind: null,
      medium: null,
      confidence: "medium",
      interpretationNote: null,
      scoring: "included",
      expectedUpdatedAt: "2026-01-01T00:00:00.000Z",
    },
  });

  const result = await updateFactDetails.handler(context);

  expect(result).toMatchObject({
    code: 409,
    response: { code: VERSION_CONFLICT_ERROR_CODE },
  });
});

for (const operation of ["create", "update"] as const) {
  test(`returns the stored timestamp after fact details ${operation}`, async () => {
    const storedUpdatedAt = new Date("2031-04-05T06:07:08.009Z");
    const priorUpdatedAt = new Date("2026-01-02T00:00:00.000Z");
    const itemEntityId = toSafeId<"entity">("entity_test");
    const listId = toSafeId<"legalList">("list_test");
    const tx = asTestRaw<Transaction>({
      select: () => ({
        from: (table: unknown) => ({
          innerJoin: () => ({
            where: () => ({ limit: async () => [{ listItemType: "fact" }] }),
          }),
          where: () => ({
            limit:
              table === legalListFactDetails
                ? () => ({
                    for: async () =>
                      operation === "create"
                        ? []
                        : [
                            {
                              confidence: "high",
                              updatedAt: priorUpdatedAt,
                            },
                          ],
                  })
                : async () => [{ id: itemEntityId }],
          }),
        }),
      }),
      insert: () => ({
        values: () => ({
          onConflictDoNothing: () => ({
            returning: async () => [{ updatedAt: storedUpdatedAt }],
          }),
          // The previous upsert completes too, so restoring it fails the timestamp assertion.
          onConflictDoUpdate: async () => [],
        }),
      }),
      update: () => ({
        set: () => ({
          where: () => ({
            returning: async () => [{ updatedAt: storedUpdatedAt }],
          }),
        }),
      }),
    });
    const safeDb = asTestRaw<SafeDb>(
      async <T>(run: (tx: Transaction) => Promise<T>) =>
        Result.tryPromise(async () => await run(tx)),
    );
    const context = createTestHandlerContext<
      Parameters<typeof updateFactDetails.handler>[0]
    >({
      audit: async () => {},
      safeDb,
      scopedDb: NO_DB,
      featureAccessSnapshot: factDetailsFeatureAccess(),
      body: {
        listId,
        itemEntityId,
        occurredOn: null,
        evidenceKind: null,
        medium: null,
        confidence: "medium",
        interpretationNote: null,
        scoring: "included",
        expectedUpdatedAt:
          operation === "create" ? null : priorUpdatedAt.toISOString(),
      },
    });

    const result = await updateFactDetails.handler(context);

    if (!("updatedAt" in result)) {
      panic("Fact detail write did not return its stored timestamp");
    }
    expect(result.updatedAt.toISOString()).toBe(storedUpdatedAt.toISOString());
  });
}

test("rejects concurrent fact details creation without recording an audit", async () => {
  const itemEntityId = toSafeId<"entity">("entity_test");
  const listId = toSafeId<"legalList">("list_test");
  const tx = asTestRaw<Transaction>({
    select: () => ({
      from: (table: unknown) => ({
        innerJoin: () => ({
          where: () => ({ limit: async () => [{ listItemType: "fact" }] }),
        }),
        where: () => ({
          limit:
            table === legalListFactDetails
              ? () => ({ for: async () => [] })
              : async () => [{ id: itemEntityId }],
        }),
      }),
    }),
    insert: () => ({
      values: () => ({
        onConflictDoNothing: () => ({ returning: async () => [] }),
        onConflictDoUpdate: async () => [],
      }),
    }),
  });
  const safeDb = asTestRaw<SafeDb>(
    async <T>(run: (tx: Transaction) => Promise<T>) =>
      Result.tryPromise(async () => await run(tx)),
  );
  const context = createTestHandlerContext<
    Parameters<typeof updateFactDetails.handler>[0]
  >({
    audit: NO_AUDIT,
    safeDb,
    scopedDb: NO_DB,
    featureAccessSnapshot: factDetailsFeatureAccess(),
    body: {
      listId,
      itemEntityId,
      occurredOn: null,
      evidenceKind: null,
      medium: null,
      confidence: "medium",
      interpretationNote: null,
      scoring: "included",
      expectedUpdatedAt: null,
    },
  });

  expect(await updateFactDetails.handler(context)).toMatchObject({
    code: 409,
    response: { code: VERSION_CONFLICT_ERROR_CODE },
  });
});
