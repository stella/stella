import { describe, expect, mock, test } from "bun:test";

import { toSafeId } from "@/api/lib/branded-types";

// `processExtraction` reads through the `rootDb` module-level singleton
// directly (no injected `safeDb`), so the query call is captured by mocking
// that module, matching the established pattern (see
// apps/api/src/lib/folio-collab-sessions.test.ts). Resolving `findFirst`
// with `null` (entity not found) short-circuits the function right after
// the query, before it would otherwise reach S3/search-provider calls this
// test does not need to stub.
const findFirstMock = mock(async () => null);

void mock.module("@/api/db/root", () => ({
  rootDb: { query: { entities: { findFirst: findFirstMock } } },
}));

const { processExtraction } =
  await import("@/api/lib/search/process-extraction");

describe("processExtraction", () => {
  test("orders the current version's fields by id, matching readEntityByIdHandler, so 'first file field' selection is deterministic", async () => {
    await processExtraction(toSafeId("entity_1"));

    expect(findFirstMock).toHaveBeenCalledWith(
      expect.objectContaining({
        with: expect.objectContaining({
          currentVersion: expect.objectContaining({
            with: expect.objectContaining({
              // The `fields` table has no createdAt/position column; `id`
              // is a Bun.randomUUIDv7() primary key (time-ordered), so
              // ordering by it is the only way to get a stable "first
              // field" across repeated reads. `readEntityByIdHandler`
              // (handlers/entities/get.ts) MUST request the exact same
              // ordering on the same relation, or `findExtractionFileField`
              // could resolve to a different "first" field there than it
              // does here.
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
