import { beforeEach, expect, mock, test } from "bun:test";
import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";

import { toSafeId } from "@/api/lib/branded-types";
import type { TimestampCasToken } from "@/api/lib/db/timestamp-cas";

process.env["REDIS_URL"] ??= "redis://localhost:6379";
process.env["GOTENBERG_URL"] ??= "http://localhost:3002";
process.env["GOTENBERG_USERNAME"] ??= "test";
process.env["GOTENBERG_PASSWORD"] ??= "test";

const semanticUpdatedAt = new Date("2026-04-30T08:00:00.000Z");
const semanticUpdatedAtToken =
  "2026-04-30 08:00:00.000123" as TimestampCasToken;
const executeMock = mock(async (_query: SQL) => [
  { entityId: toSafeId<"entity">("entity_1") },
]);
const syncWorkspaceSearchActivityMock = mock(async () => undefined);
const decryptContentMock = mock(async () => "Extracted text");
const captureErrorMock = mock(() => undefined);
const entityRow = {
  currentVersion: { fields: [], id: toSafeId<"entityVersion">("v_1") },
  createdAt: new Date("2026-04-01T08:00:00.000Z"),
  extractedContent: null as {
    ciphertext: Buffer;
    iv: Buffer;
    language: string | null;
  } | null,
  id: toSafeId<"entity">("entity_1"),
  kind: "document" as const,
  metadata: null,
  name: "Closing memo",
  semanticUpdatedAtToken,
  updatedAt: semanticUpdatedAt,
  workspace: { organizationId: toSafeId<"organization">("org_1") },
  workspaceId: toSafeId<"workspace">("ws_1"),
};
const findFirstMock = mock(async () => entityRow);

void mock.module("@/api/db/root", () => ({
  rootDb: {
    execute: executeMock,
    query: {
      entities: {
        findFirst: findFirstMock,
      },
    },
  },
}));

void mock.module("@/api/lib/analytics/capture", () => ({
  captureError: captureErrorMock,
}));

void mock.module("@/api/lib/content-encryption", () => ({
  decryptContent: decryptContentMock,
}));

void mock.module("@/api/lib/search/index-global", () => ({
  syncWorkspaceSearchActivity: syncWorkspaceSearchActivityMock,
}));

beforeEach(() => {
  executeMock.mockClear();
  findFirstMock.mockClear();
  findFirstMock.mockResolvedValue(entityRow);
  decryptContentMock.mockClear();
  decryptContentMock.mockResolvedValue("Extracted text");
  captureErrorMock.mockClear();
  syncWorkspaceSearchActivityMock.mockClear();
});

test("persists an entity's semantic updated timestamp when indexing", async () => {
  const { upsertSearchDocument } =
    await import("@/api/lib/search/index-entity");

  await upsertSearchDocument(toSafeId<"entity">("entity_1"));

  const query = executeMock.mock.calls.at(0)?.[0];
  expect(query).toBeDefined();
  if (!query) {
    return;
  }

  const compiled = new PgDialect().sqlToQuery(query);
  expect(compiled.sql).toContain("INSERT INTO search_documents");
  expect(compiled.sql).not.toContain("now()");
  expect(compiled.params).toContain(semanticUpdatedAtToken);
  expect(compiled.params).not.toContain(semanticUpdatedAt);
  expect(syncWorkspaceSearchActivityMock).toHaveBeenCalledTimes(1);
});

test("rejects an out-of-order projection against the authoritative entity", async () => {
  const { upsertSearchDocument } =
    await import("@/api/lib/search/index-entity");

  await upsertSearchDocument(toSafeId<"entity">("entity_1"));

  const query = executeMock.mock.calls.at(0)?.[0];
  expect(query).toBeDefined();
  if (!query) {
    return;
  }

  const compiled = new PgDialect().sqlToQuery(query);
  expect(compiled.sql).toContain("WITH authoritative_source AS MATERIALIZED");
  expect(compiled.sql).toContain("e.current_version_id =");
  expect(compiled.sql).toMatch(
    /COALESCE\(e\.updated_at, e\.created_at\)\s+IS NOT DISTINCT FROM/,
  );
  expect(compiled.sql).toContain("::timestamp");
  expect(compiled.sql).toContain("FOR UPDATE");
  expect(compiled.sql).toContain(
    "WHERE EXISTS (SELECT 1 FROM authoritative_source)",
  );
});

test("does not advance matter activity when a stale projection is rejected", async () => {
  executeMock.mockResolvedValueOnce([]);
  const { upsertSearchDocument } =
    await import("@/api/lib/search/index-entity");

  await upsertSearchDocument(toSafeId<"entity">("entity_1"));

  expect(syncWorkspaceSearchActivityMock).not.toHaveBeenCalled();
});

test("keeps the last complete projection when extracted content cannot decrypt", async () => {
  const decryptionFailure = new Error("key unavailable");
  findFirstMock.mockResolvedValueOnce({
    ...entityRow,
    extractedContent: {
      ciphertext: Buffer.from("ciphertext"),
      iv: Buffer.from("iv"),
      language: "en",
    },
  });
  decryptContentMock.mockRejectedValueOnce(decryptionFailure);
  const { upsertSearchDocument } =
    await import("@/api/lib/search/index-entity");

  const rejection: unknown = await upsertSearchDocument(
    toSafeId<"entity">("entity_1"),
  ).then(
    () => null,
    (error: unknown) => error,
  );

  expect(rejection).toBe(decryptionFailure);
  expect(captureErrorMock).toHaveBeenCalledWith(decryptionFailure, {
    entityId: toSafeId<"entity">("entity_1"),
  });
  expect(executeMock).not.toHaveBeenCalled();
  expect(syncWorkspaceSearchActivityMock).not.toHaveBeenCalled();
});
