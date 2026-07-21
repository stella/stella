import { Result } from "better-result";
import { beforeEach, describe, expect, mock, test } from "bun:test";

import { readEntityByIdHandler } from "@/api/handlers/entities/get";
import { toSafeId } from "@/api/lib/branded-types";
import { createScopedDbMock } from "@/api/tests/scoped-db-mock";

const findFirstMock = mock();

describe("readEntityByIdHandler", () => {
  beforeEach(() => {
    findFirstMock.mockReset();
    findFirstMock.mockResolvedValue({
      kind: "document",
      name: "Share Purchase Agreement",
      currentVersion: {
        id: "entity_version_1",
        fields: [
          {
            id: "field_1",
            propertyId: "property_1",
            content: { type: "file" },
          },
        ],
      },
    });
  });

  test("orders the current version's fields by id, matching processExtraction, so 'first file field' selection is deterministic", async () => {
    const { safeDb } = createScopedDbMock({
      query: { entities: { findFirst: findFirstMock } },
    });

    const result = await Result.gen(() =>
      readEntityByIdHandler({
        safeDb,
        workspaceId: toSafeId("ws_1"),
        entityId: toSafeId("entity_1"),
      }),
    );

    expect(Result.isOk(result)).toBe(true);
    expect(findFirstMock).toHaveBeenCalledWith(
      expect.objectContaining({
        with: expect.objectContaining({
          currentVersion: expect.objectContaining({
            with: expect.objectContaining({
              // The `fields` table has no createdAt/position column; `id` is
              // a Bun.randomUUIDv7() primary key (time-ordered), so ordering
              // by it is the only way to get a stable "first field" across
              // repeated reads. `processExtraction` (process-extraction.ts)
              // MUST request the exact same ordering on the same relation,
              // or `findExtractionFileField` could resolve to a different
              // "first" field there than it does here.
              fields: expect.objectContaining({
                orderBy: { id: "asc" },
              }),
            }),
          }),
        }),
      }),
    );
  });
});
