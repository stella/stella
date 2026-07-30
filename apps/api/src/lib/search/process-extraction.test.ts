import { describe, expect, mock, test } from "bun:test";
import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";

import { toSafeId } from "@/api/lib/branded-types";

// `processExtraction` reads through the `rootDb` module-level singleton
// directly (no injected `safeDb`), so the query call is captured by mocking
// that module, matching the established pattern (see
// apps/api/src/lib/folio-collab-sessions.test.ts). Resolving `findFirst`
// with `null` (entity not found) short-circuits the function right after
// the query, before it would otherwise reach S3/search-provider calls this
// test does not need to stub.
const findFirstMock = mock(async () => null);
const executeMock = mock(async (_query: SQL) => [
  { entityId: toSafeId<"entity">("entity_1") },
]);

void mock.module("@/api/db/root", () => ({
  rootDb: {
    execute: executeMock,
    query: { entities: { findFirst: findFirstMock } },
  },
}));

const { persistNativeExtractionProjection, processExtraction } =
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

  test("persists native text only while its immutable source remains current", async () => {
    const sourceVersionId = toSafeId<"entityVersion">(
      "019864b8-48d0-7f37-94d5-948e3bcf3f45",
    );
    const sourceFieldId = toSafeId<"field">(
      "019864b8-48d0-7f37-94d5-948e3bcf3f46",
    );
    const sourceFileId = "019864b8-48d0-7f37-94d5-948e3bcf3f44";
    const sourceSha256Hex = "a".repeat(64);

    const persisted = await persistNativeExtractionProjection({
      charCount: 14,
      ciphertext: Buffer.from("ciphertext"),
      entityId: toSafeId<"entity">("entity_1"),
      entityVersionId: sourceVersionId,
      fieldId: sourceFieldId,
      iv: Buffer.from("iv"),
      organizationId: toSafeId<"organization">("org_1"),
      sourceFileId,
      sourceSha256Hex,
      workspaceId: toSafeId<"workspace">("workspace_1"),
    });

    expect(persisted).toBe(true);
    const query = executeMock.mock.calls.at(0)?.[0];
    expect(query).toBeDefined();
    if (!query) {
      return;
    }
    const compiled = new PgDialect().sqlToQuery(query);
    expect(compiled.sql).toContain("e.current_version_id =");
    expect(compiled.sql).toContain("f.entity_version_id =");
    expect(compiled.sql).toContain("f.content->>'id' =");
    expect(compiled.sql).toContain("f.content->>'sha256Hex' =");
    expect(compiled.sql).toContain("FOR UPDATE OF e");
    expect(compiled.params).toContain(sourceVersionId);
    expect(compiled.params).toContain(sourceFieldId);
    expect(compiled.params).toContain(sourceFileId);
    expect(compiled.params).toContain(sourceSha256Hex);
  });

  test("does not overwrite a newer projection after its source is replaced", async () => {
    executeMock.mockResolvedValueOnce([]);

    const persisted = await persistNativeExtractionProjection({
      charCount: 14,
      ciphertext: Buffer.from("stale ciphertext"),
      entityId: toSafeId<"entity">("entity_1"),
      entityVersionId: toSafeId<"entityVersion">(
        "019864b8-48d0-7f37-94d5-948e3bcf3f45",
      ),
      fieldId: toSafeId<"field">("019864b8-48d0-7f37-94d5-948e3bcf3f46"),
      iv: Buffer.from("stale iv"),
      organizationId: toSafeId<"organization">("org_1"),
      sourceFileId: "019864b8-48d0-7f37-94d5-948e3bcf3f44",
      sourceSha256Hex: "a".repeat(64),
      workspaceId: toSafeId<"workspace">("workspace_1"),
    });

    expect(persisted).toBe(false);
  });
});
