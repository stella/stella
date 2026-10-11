import { expect, test } from "bun:test";

import { clauses, clauseVariants } from "@/api/db/schema";
import { createSafeId } from "@/api/lib/branded-types";
import { VERSION_CONFLICT_ERROR_CODE } from "@/api/lib/optimistic-concurrency";
import { createTestHandlerContext } from "@/api/tests/helpers/handler-context";
import {
  createScopedDbMock,
  createSelectQueryMock,
} from "@/api/tests/scoped-db-mock";

import updateVariant from "./update";

const storedUpdatedAt = new Date("2026-10-11T10:00:00.000Z");

for (const version of ["stale", "current"] as const) {
  test(`a ${version} variant version reaches the locked write and ${version === "stale" ? "returns a conflict without writes" : "saves the edit"}`, async () => {
    const clauseId = createSafeId<"clause">();
    const variantId = createSafeId<"clauseVariant">();
    let locks = 0;
    let writes = 0;
    let audits = 0;
    const database = createScopedDbMock({
      execute: async () => {
        locks += 1;
        return [{ id: variantId }];
      },
      query: {
        clauses: { findFirst: async () => ({ id: clauseId }) },
      },
      select: (selection: Record<string, unknown>) => ({
        from: (table: unknown) => {
          if (!("updatedAt" in selection)) {
            return createSelectQueryMock([
              { id: table === clauses ? clauseId : variantId },
            ]).from();
          }
          expect(table).toBe(clauseVariants);
          expect(locks).toBe(1);
          return createSelectQueryMock([
            {
              id: variantId,
              label: "Original",
              body: [{ text: "Original" }],
              sortOrder: 0,
              updatedAt: storedUpdatedAt,
            },
          ]).from();
        },
      }),
      update: () => ({
        set: () => {
          writes += 1;
          return {
            where: () => ({
              returning: async () => [
                {
                  id: variantId,
                  label: "Edited",
                  sortOrder: 0,
                  updatedAt: new Date("2026-10-11T11:00:00.000Z"),
                },
              ],
            }),
          };
        },
      }),
    });
    const expectedUpdatedAt =
      version === "stale"
        ? "2026-10-11T09:00:00.000Z"
        : storedUpdatedAt.toISOString();
    if (version === "stale") {
      expect(expectedUpdatedAt).not.toBe(storedUpdatedAt.toISOString());
    }
    const response = await updateVariant.handler(
      createTestHandlerContext<Parameters<typeof updateVariant.handler>[0]>({
        audit: async () => {
          audits += 1;
        },
        safeDb: database.safeDb,
        scopedDb: database.scopedDb,
        params: { clauseId, variantId },
        body: { label: "Edited", expectedUpdatedAt },
      }),
    );
    expect(locks).toBe(1);
    if (version === "stale") {
      expect(response).toMatchObject({
        code: 409,
        response: { code: VERSION_CONFLICT_ERROR_CODE },
      });
      expect(writes).toBe(0);
      expect(audits).toBe(0);
    } else {
      expect(response).toMatchObject({ id: variantId, label: "Edited" });
      expect(writes).toBe(1);
      expect(audits).toBe(1);
    }
  });
}
