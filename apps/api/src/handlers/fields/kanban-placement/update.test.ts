import { expect, mock, test } from "bun:test";

import { entities } from "@/api/db/schema";
import { createSafeId } from "@/api/lib/branded-types";
import { VERSION_CONFLICT_ERROR_CODE } from "@/api/lib/optimistic-concurrency";
import {
  NO_AUDIT,
  createTestHandlerContext,
} from "@/api/tests/helpers/handler-context";
import {
  createScopedDbMock,
  createSelectQueryMock,
} from "@/api/tests/scoped-db-mock";

import updateKanbanPlacement from "./update";

type UpdateContext = Parameters<typeof updateKanbanPlacement.handler>[0];

test("stale task status moves refuse every bundled field write", async () => {
  const write = mock(() => {
    throw new Error("Stale placement reached a write");
  });
  const { safeDb, scopedDb } = createScopedDbMock({
    select: () => ({
      from: (table: unknown) =>
        table === entities
          ? createSelectQueryMock([
              { updatedAt: new Date("2026-01-02T00:00:00.000Z") },
            ])
          : createSelectQueryMock([]),
    }),
    update: write,
    insert: write,
  });
  const result = await updateKanbanPlacement.handler(
    createTestHandlerContext<UpdateContext>({
      audit: NO_AUDIT,
      safeDb,
      scopedDb,
      body: {
        entityId: createSafeId<"entity">(),
        status: "done",
        expectedUpdatedAt: "2026-01-01T00:00:00.000Z",
        fields: [
          {
            propertyId: createSafeId<"property">(),
            content: { type: "text", version: 1, value: "Review" },
          },
        ],
      },
    }),
  );
  expect(result).toMatchObject({
    code: 409,
    response: { code: VERSION_CONFLICT_ERROR_CODE },
  });
  expect(write).not.toHaveBeenCalled();
});
