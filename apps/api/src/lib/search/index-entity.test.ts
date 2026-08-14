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
const extractedAt = new Date("2026-04-30T08:01:00.000Z");
const extractedAtToken =
  // SAFETY: tests fabricate the branded token the token select normally
  // renders as `extracted_content.extracted_at::text`. The microsecond tail
  // is the point: a JS Date carrying the same instant loses it.
  // eslint-disable-next-line typescript/no-unsafe-type-assertion
  "2026-04-30 08:01:00.000982" as TimestampCasToken;
// The token select chain: rootDb.select({...}).from(...).where(...).limit(1)
const selectLimitMock = mock(async (_limit: number) => [
  { semanticUpdatedAtToken, extractedAtToken },
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
    createdAt: new Date("2026-04-30T08:00:00.000Z"),
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
let latestVersionId = entityRow.currentVersion.id;
const latestVersionFindFirstMock = mock(async () => ({ id: latestVersionId }));
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
      entityVersions: {
        findFirst: latestVersionFindFirstMock,
      },
    },
    select: selectMock,
    transaction: transactionMock,
  },
}));

const realCapture = await import("@/api/lib/analytics/capture");
void mock.module("@/api/lib/analytics/capture", () => ({
  ...realCapture,
  captureError: captureErrorMock,
}));

void mock.module("@/api/lib/content-encryption", () => ({
  decryptContent: decryptContentMock,
  encryptContent: async () => ({
    ciphertext: Buffer.from("ciphertext"),
    iv: Buffer.from("iv"),
  }),
}));

void mock.module("@/api/lib/search/index-global", () => ({
  syncWorkspaceSearchActivity: syncWorkspaceSearchActivityMock,
}));

beforeEach(() => {
  executeMock.mockClear();
  selectMock.mockClear();
  selectLimitMock.mockClear();
  selectLimitMock.mockResolvedValue([
    { semanticUpdatedAtToken, extractedAtToken },
  ]);
  findFirstMock.mockClear();
  findFirstMock.mockResolvedValue(entityRow);
  latestVersionId = entityRow.currentVersion.id;
  latestVersionFindFirstMock.mockClear();
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
  expect(compiled.sql).toContain(
    "INNER JOIN workspaces w ON w.id = e.workspace_id",
  );
  expect(compiled.sql).toContain("w.organization_id =");
  expect(compiled.sql).not.toContain("e.organization_id");
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
      createdAt: entityRow.currentVersion.createdAt,
      fields: [currentFileField],
      id: entityRow.currentVersion.id,
    },
    extractedContent: {
      ciphertext: Buffer.from("ciphertext"),
      extractedAt,
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
  findFirstMock.mockResolvedValueOnce({
    ...entityRow,
    currentVersion: {
      createdAt: entityRow.currentVersion.createdAt,
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
  // `extracted_at` defaults to now(), so the provenance fence must compare
  // the database's own text rendering. Binding the JS `Date` instead drops
  // the microseconds and makes every re-index of this entity a silent no-op.
  expect(compiled.params).toContain(extractedAtToken);
  expect(compiled.params).not.toContain(extractedAt);
  expect(compiled.sql).toMatch(
    /ec\.extracted_at\s+IS NOT DISTINCT FROM \$\d+::timestamptz/u,
  );
});

// Postgres `text` rejects NUL; extracted text arrives via encrypted bytea
// which preserves it, so the projection write must strip it or the entity
// becomes permanently unindexable (every repair retry fails the same way).
test("strips NUL bytes from indexed title and text", async () => {
  findFirstMock.mockResolvedValueOnce({
    ...entityRow,
    name: "Closing\u0000 memo",
    currentVersion: {
      createdAt: entityRow.currentVersion.createdAt,
      fields: [currentFileField],
      id: entityRow.currentVersion.id,
    },
    extractedContent: {
      ciphertext: Buffer.from("ciphertext"),
      extractedAt,
      iv: Buffer.from("iv"),
      language: "en",
      sourceEntityVersionId: entityRow.currentVersion.id,
      sourceFieldId: currentFileField.id,
      sourceFileId: currentFileField.content.id,
      sourceSha256Hex: currentFileField.content.sha256Hex,
    },
  });
  decryptContentMock.mockResolvedValueOnce("Extracted\u0000 text\u0000");
  const { upsertSearchDocument } =
    await import("@/api/lib/search/index-entity");

  await upsertSearchDocument(toSafeId<"entity">("entity_1"));

  const query = executeMock.mock.calls.at(0)?.[0];
  expect(query).toBeDefined();
  if (!query) {
    return;
  }
  const compiled = new PgDialect().sqlToQuery(query);
  const stringParams = compiled.params.filter(
    (param): param is string => typeof param === "string",
  );
  expect(stringParams.some((param) => param.includes("Extracted text"))).toBe(
    true,
  );
  expect(stringParams.some((param) => param.includes("Closing memo"))).toBe(
    true,
  );
  expect(stringParams.some((param) => param.includes("\u0000"))).toBe(false);
});

test("preserves pre-provenance extracted text until a fenced writer replaces it", async () => {
  findFirstMock.mockResolvedValueOnce({
    ...entityRow,
    currentVersion: {
      createdAt: entityRow.currentVersion.createdAt,
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
  expect(compiled.params).toContain(extractedAtToken);
  expect(compiled.params).not.toContain(extractedAt);
  expect(
    compiled.params.filter((parameter) => parameter === null),
  ).not.toHaveLength(0);
});

test("excludes legacy extracted text after a deleted-version rollback", async () => {
  latestVersionId = toSafeId<"entityVersion">("withdrawn_version");
  findFirstMock.mockResolvedValueOnce({
    ...entityRow,
    currentVersion: {
      createdAt: entityRow.currentVersion.createdAt,
      fields: [currentFileField],
      id: entityRow.currentVersion.id,
    },
    extractedContent: {
      ciphertext: Buffer.from("withdrawn text"),
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

  expect(decryptContentMock).not.toHaveBeenCalled();
  expect(latestVersionFindFirstMock).toHaveBeenCalledWith(
    expect.objectContaining({
      orderBy: { versionNumber: "desc", id: "desc" },
    }),
  );
});
