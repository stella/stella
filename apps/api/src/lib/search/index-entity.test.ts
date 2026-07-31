import { beforeEach, expect, mock, test } from "bun:test";
import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";

import { toSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import type { TimestampCasToken } from "@/api/lib/db/timestamp-cas";

process.env["REDIS_URL"] ??= "redis://localhost:6379";
process.env["GOTENBERG_URL"] ??= "http://localhost:3002";
process.env["GOTENBERG_USERNAME"] ??= "test";
process.env["GOTENBERG_PASSWORD"] ??= "test";

const semanticUpdatedAt = new Date("2026-04-30T08:00:00.000Z");
const semanticUpdatedAtToken =
  // SAFETY: tests fabricate the branded token the token select normally
  // renders as `COALESCE(updated_at, created_at)::text`.
  // eslint-disable-next-line typescript/no-unsafe-type-assertion
  "2026-04-30 08:00:00.000123" as TimestampCasToken;
// The token select chain: rootDb.select({...}).from(...).where(...).limit(1)
const selectLimitMock = mock(async (_limit: number) => [
  { semanticUpdatedAtToken },
]);
const selectMock = mock((_fields: unknown) => ({
  from: (_table: unknown) => ({
    where: (_where: unknown) => ({ limit: selectLimitMock }),
  }),
}));
const executeMock = mock(async (_query: SQL) => [
  { entityId: toSafeId<"entity">("entity_1") },
]);
const syncWorkspaceSearchActivityMock = mock(
  async (_workspaceId: unknown, _db: unknown) => undefined,
);
const decryptContentMock = mock(async () => "Extracted text");
const captureErrorMock = mock(() => undefined);
const currentFileField = {
  content: {
    encrypted: false,
    fileName: "scan.pdf",
    id: "019864b8-48d0-7f37-94d5-948e3bcf3f44",
    mimeType: "application/pdf",
    pdfFileId: null,
    sha256Hex: "a".repeat(64),
    sizeBytes: 123,
    type: "file" as const,
    version: 1 as const,
  },
  id: toSafeId<"field">("019864b8-48d0-7f37-94d5-948e3bcf3f46"),
  propertyId: toSafeId<"property">("019864b8-48d0-7f37-94d5-948e3bcf3f47"),
};
const noCurrentFileFields: (typeof currentFileField)[] = [];
const entityRow = {
  currentVersion: {
    fields: noCurrentFileFields,
    id: toSafeId<"entityVersion">("v_1"),
  },
  createdAt: new Date("2026-04-01T08:00:00.000Z"),
  extractedContent: null as {
    ciphertext: Buffer;
    extractedAt: Date;
    iv: Buffer;
    language: string | null;
    sourceEntityVersionId: SafeId<"entityVersion"> | null;
    sourceFieldId: SafeId<"field"> | null;
    sourceFileId: string | null;
    sourceSha256Hex: string | null;
  } | null,
  id: toSafeId<"entity">("entity_1"),
  kind: "document" as const,
  metadata: null,
  name: "Closing memo",
  updatedAt: semanticUpdatedAt,
  workspace: { organizationId: toSafeId<"organization">("org_1") },
  workspaceId: toSafeId<"workspace">("ws_1"),
};
const findFirstMock = mock(async () => entityRow);
const transactionMock = mock(
  async (
    runTransaction: (tx: { execute: typeof executeMock }) => Promise<unknown>,
  ) => await runTransaction({ execute: executeMock }),
);

void mock.module("@/api/db/root", () => ({
  rootDb: {
    execute: executeMock,
    query: {
      entities: {
        findFirst: findFirstMock,
      },
    },
    select: selectMock,
    transaction: transactionMock,
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
  selectMock.mockClear();
  selectLimitMock.mockClear();
  selectLimitMock.mockResolvedValue([{ semanticUpdatedAtToken }]);
  findFirstMock.mockClear();
  findFirstMock.mockResolvedValue(entityRow);
  decryptContentMock.mockClear();
  decryptContentMock.mockResolvedValue("Extracted text");
  captureErrorMock.mockClear();
  syncWorkspaceSearchActivityMock.mockClear();
  transactionMock.mockClear();
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
  const executedSql = executeMock.mock.calls.map(
    ([executedQuery]) => new PgDialect().sqlToQuery(executedQuery).sql,
  );
  expect(
    executedSql.some((sqlText) =>
      sqlText.includes("INSERT INTO search_document_preview_passages"),
    ),
  ).toBe(true);
  expect(
    executedSql.some((sqlText) => sqlText.includes("SET preview_generation =")),
  ).toBe(true);
  expect(syncWorkspaceSearchActivityMock).toHaveBeenCalledTimes(1);
  expect(syncWorkspaceSearchActivityMock.mock.calls.at(0)?.at(1)).toEqual({
    execute: executeMock,
  });
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
  expect(compiled.sql).toContain("FROM entities e");
  expect(compiled.sql).toContain("e.current_version_id =");
  expect(compiled.sql).toMatch(
    /COALESCE\(e\.updated_at, e\.created_at\)\s+IS NOT DISTINCT FROM/u,
  );
  expect(compiled.sql).toContain("::timestamptz");
  expect(compiled.sql).toContain("FOR UPDATE");
  expect(compiled.sql).toContain("FOR UPDATE OF e");
  expect(compiled.sql).toContain("NOT EXISTS");
  expect(compiled.sql).toContain("FROM extracted_content ec");
});

test("does not advance matter activity when a stale projection is rejected", async () => {
  executeMock.mockResolvedValueOnce([]);
  const { upsertSearchDocument } =
    await import("@/api/lib/search/index-entity");

  await upsertSearchDocument(toSafeId<"entity">("entity_1"));

  expect(syncWorkspaceSearchActivityMock).not.toHaveBeenCalled();
});

test("propagates workspace activity failures from the projection transaction", async () => {
  const activityFailure = new Error("workspace activity unavailable");
  syncWorkspaceSearchActivityMock.mockRejectedValueOnce(activityFailure);
  const { upsertSearchDocument } =
    await import("@/api/lib/search/index-entity");

  const rejection: unknown = await upsertSearchDocument(
    toSafeId<"entity">("entity_1"),
  ).then(
    () => null,
    (error: unknown) => error,
  );

  expect(rejection).toBe(activityFailure);
  expect(transactionMock).toHaveBeenCalledTimes(1);
  expect(executeMock).toHaveBeenCalledTimes(4);
});

test("keeps the last complete projection when extracted content cannot decrypt", async () => {
  const decryptionFailure = new Error("key unavailable");
  findFirstMock.mockResolvedValueOnce({
    ...entityRow,
    currentVersion: {
      fields: [currentFileField],
      id: entityRow.currentVersion.id,
    },
    extractedContent: {
      ciphertext: Buffer.from("ciphertext"),
      extractedAt: new Date("2026-04-30T08:01:00.000Z"),
      iv: Buffer.from("iv"),
      language: "en",
      sourceEntityVersionId: entityRow.currentVersion.id,
      sourceFieldId: currentFileField.id,
      sourceFileId: currentFileField.content.id,
      sourceSha256Hex: currentFileField.content.sha256Hex,
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

test("excludes stale extracted text and fences its observed provenance", async () => {
  const staleVersionId = toSafeId<"entityVersion">(
    "019864b8-48d0-7f37-94d5-948e3bcf3f48",
  );
  const extractedAt = new Date("2026-04-30T08:01:00.000Z");
  findFirstMock.mockResolvedValueOnce({
    ...entityRow,
    currentVersion: {
      fields: [currentFileField],
      id: entityRow.currentVersion.id,
    },
    extractedContent: {
      ciphertext: Buffer.from("stale ciphertext"),
      extractedAt,
      iv: Buffer.from("stale iv"),
      language: "en",
      sourceEntityVersionId: staleVersionId,
      sourceFieldId: currentFileField.id,
      sourceFileId: currentFileField.content.id,
      sourceSha256Hex: currentFileField.content.sha256Hex,
    },
  });
  const { upsertSearchDocument } =
    await import("@/api/lib/search/index-entity");

  await upsertSearchDocument(toSafeId<"entity">("entity_1"));

  expect(decryptContentMock).not.toHaveBeenCalled();
  const query = executeMock.mock.calls.at(0)?.[0];
  expect(query).toBeDefined();
  if (!query) {
    return;
  }
  const compiled = new PgDialect().sqlToQuery(query);
  expect(compiled.sql).toContain("EXISTS");
  expect(compiled.sql).toContain("ec.source_entity_version_id");
  expect(compiled.sql).toContain("ec.extracted_at");
  expect(compiled.params).toContain(staleVersionId);
  expect(compiled.params).toContain(extractedAt);
});

test("preserves pre-provenance extracted text until a fenced writer replaces it", async () => {
  const extractedAt = new Date("2026-04-30T08:01:00.000Z");
  findFirstMock.mockResolvedValueOnce({
    ...entityRow,
    currentVersion: {
      fields: [currentFileField],
      id: entityRow.currentVersion.id,
    },
    extractedContent: {
      ciphertext: Buffer.from("legacy ciphertext"),
      extractedAt,
      iv: Buffer.from("legacy iv"),
      language: "cs",
      sourceEntityVersionId: null,
      sourceFieldId: null,
      sourceFileId: null,
      sourceSha256Hex: null,
    },
  });
  const { upsertSearchDocument } =
    await import("@/api/lib/search/index-entity");

  await upsertSearchDocument(toSafeId<"entity">("entity_1"));

  expect(decryptContentMock).toHaveBeenCalledWith(
    toSafeId<"organization">("org_1"),
    Buffer.from("legacy ciphertext"),
    Buffer.from("legacy iv"),
  );
  const query = executeMock.mock.calls.at(0)?.[0];
  expect(query).toBeDefined();
  if (!query) {
    return;
  }
  const compiled = new PgDialect().sqlToQuery(query);
  expect(compiled.params).toContain(extractedAt);
  expect(
    compiled.params.filter((parameter) => parameter === null),
  ).not.toHaveLength(0);
});
