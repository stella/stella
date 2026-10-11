import { Result } from "better-result";
import { expect, test } from "bun:test";

import type { Transaction } from "@/api/db/root";
import type { SafeDb } from "@/api/db/safe-db";
import { cellMetadata, entities, fields } from "@/api/db/schema";
import { toSafeId } from "@/api/lib/branded-types";
import { writeFieldValue } from "@/api/lib/fields/write-field";
import { VERSION_CONFLICT_ERROR_CODE } from "@/api/lib/optimistic-concurrency";
import { sessionMemberRole } from "@/api/lib/permission-authorization";
import {
  NO_AUDIT,
  NO_DB,
  createTestHandlerContext,
} from "@/api/tests/helpers/handler-context";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";

import upsertField from "./upsert";

test("rejects a stale field replacement before writing", async () => {
  const entityId = toSafeId<"entity">("entity_test");
  const propertyId = toSafeId<"property">("property_test");
  const tx = asTestRaw<Transaction>({
    query: {
      properties: {
        findFirst: async () => ({ id: propertyId, content: { type: "text" } }),
      },
    },
    select: () => ({
      from: (table: unknown) => ({
        where: () => ({
          limit: async () =>
            table === fields
              ? [{ content: { version: 1, type: "text", value: "old" } }]
              : [{ id: entityId }],
          for: async () =>
            table === entities
              ? [
                  {
                    id: entityId,
                    currentVersionId: "version_test",
                    kind: "document",
                    readOnly: false,
                    updatedAt: new Date("2026-01-02T00:00:00.000Z"),
                  },
                ]
              : [],
        }),
      }),
    }),
    execute: async () => {},
    update: () => {
      throw new Error("stale request wrote");
    },
  });
  const safeDb = asTestRaw<SafeDb>(
    async <T>(run: (tx: Transaction) => Promise<T>) =>
      Result.tryPromise(async () => await run(tx)),
  );
  const context = createTestHandlerContext<
    Parameters<typeof upsertField.handler>[0]
  >({
    audit: NO_AUDIT,
    safeDb,
    scopedDb: NO_DB,
    body: {
      entityId,
      propertyId,
      content: { version: 1, type: "text", value: "new" },
      expectedUpdatedAt: "2026-01-01T00:00:00.000Z",
    },
  });

  const result = await upsertField.handler(context);

  expect(result).toMatchObject({
    code: 409,
    response: { code: VERSION_CONFLICT_ERROR_CODE },
  });
});

for (const operation of ["create", "update"] as const) {
  test(`returns the stored entity timestamp after field ${operation}`, async () => {
    const entityId = toSafeId<"entity">("entity_test");
    const propertyId = toSafeId<"property">("property_test");
    const storedUpdatedAt = new Date("2031-04-05T06:07:08.009Z");
    const priorUpdatedAt = new Date("2026-01-02T00:00:00.000Z");
    const tx = asTestRaw<Transaction>({
      query: {
        properties: {
          findFirst: async () => ({
            id: propertyId,
            content: { type: "text" },
          }),
        },
      },
      execute: async () => {},
      select: () => ({
        from: (table: unknown) => ({
          innerJoin: () => ({ where: () => [] }),
          where: () => ({
            limit: async () => {
              if (table === cellMetadata) {
                return [];
              }
              return operation === "create"
                ? []
                : [{ content: { version: 1, type: "text", value: "old" } }];
            },
            for: async () => [
              {
                id: entityId,
                currentVersionId: toSafeId<"entityVersion">("version_test"),
                kind: "document",
                readOnly: false,
                updatedAt: priorUpdatedAt,
              },
            ],
          }),
        }),
      }),
      insert: () => ({
        values: () => ({
          onConflictDoNothing: () => ({
            returning: async () => [{ id: "field_test" }],
          }),
          onConflictDoUpdate: async () => [],
        }),
        select: () => ({ onConflictDoUpdate: async () => [] }),
      }),
      update: (table: unknown) => ({
        set: () => ({
          where: () =>
            table === entities
              ? {
                  returning: async () => [{ updatedAt: storedUpdatedAt }],
                }
              : Promise.resolve([]),
        }),
      }),
      delete: () => ({ where: async () => [] }),
    });
    const safeDb = asTestRaw<SafeDb>(
      async <T>(run: (tx: Transaction) => Promise<T>) =>
        Result.tryPromise(async () => await run(tx)),
    );

    const result = await Result.gen(() =>
      writeFieldValue({
        safeDb,
        authority: sessionMemberRole("owner"),
        workspaceId: toSafeId<"workspace">("workspace_test"),
        userId: toSafeId<"user">("user_test"),
        recordAuditEvent: async () => {},
        entityId,
        propertyId,
        content: { version: 1, type: "text", value: "new" },
        expectedUpdatedAt:
          operation === "create" ? null : priorUpdatedAt.toISOString(),
        flushSearchRepairs: false,
      }),
    );

    expect(Result.isOk(result)).toBe(true);
    if (Result.isOk(result)) {
      expect(result.value).toEqual({ updatedAt: storedUpdatedAt });
    }
  });
}

test("rejects concurrent field creation before metadata, entity updates, or audit", async () => {
  const entityId = toSafeId<"entity">("entity_test");
  const propertyId = toSafeId<"property">("property_test");
  let createAttempts = 0;
  const tx = asTestRaw<Transaction>({
    query: {
      properties: {
        findFirst: async () => ({ id: propertyId, content: { type: "text" } }),
      },
    },
    execute: async () => {},
    select: () => ({
      from: (table: unknown) => {
        if (table === cellMetadata) {
          throw new Error("conflicting create accessed metadata");
        }
        return {
          where: () => ({
            limit: async () => (table === fields ? [] : [{ id: entityId }]),
            for: async () => [
              {
                id: entityId,
                currentVersionId: toSafeId<"entityVersion">("version_test"),
                kind: "document",
                readOnly: false,
                updatedAt: new Date("2026-01-02T00:00:00.000Z"),
              },
            ],
          }),
        };
      },
    }),
    insert: (table: unknown) => {
      if (table !== fields) {
        throw new Error("conflicting create wrote metadata or search repair");
      }
      return {
        values: () => ({
          onConflictDoNothing: () => ({
            returning: async () => {
              createAttempts += 1;
              return [];
            },
          }),
        }),
      };
    },
    update: () => {
      throw new Error("conflicting create updated an entity");
    },
  });
  const safeDb = asTestRaw<SafeDb>(
    async <T>(run: (tx: Transaction) => Promise<T>) =>
      Result.tryPromise(async () => await run(tx)),
  );
  const context = createTestHandlerContext<
    Parameters<typeof upsertField.handler>[0]
  >({
    audit: NO_AUDIT,
    safeDb,
    scopedDb: NO_DB,
    body: {
      entityId,
      propertyId,
      content: { version: 1, type: "text", value: "new" },
      expectedUpdatedAt: null,
    },
  });

  expect(await upsertField.handler(context)).toMatchObject({
    code: 409,
    response: { code: VERSION_CONFLICT_ERROR_CODE },
  });
  expect(createAttempts).toBe(1);
});
