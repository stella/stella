import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";

import { toSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import { encryptContent } from "@/api/lib/content-encryption";
import type { TimestampCasToken } from "@/api/lib/db/timestamp-cas";
import { upsertSearchDocument as upsertSearchDocumentWithDependencies } from "@/api/lib/search/index-entity";
import type { IndexEntityDependencies } from "@/api/lib/search/index-entity";
import { installRecordingAnalytics } from "@/api/tests/helpers/recording-telemetry";
import type { RecordingAnalytics } from "@/api/tests/helpers/recording-telemetry";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";

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
const organizationId = toSafeId<"organization">("org_1");
// Extracted content is stored as a real per-org AES-GCM envelope; fixtures
// encrypt with the same key the projection decrypts with, so a plaintext
// regression in the storage path shows up as a missing or leaked term below.
const encryptedFor = async (text: string) =>
  await encryptContent(organizationId, text);
const stringParamsOfExecutedQueries = () =>
  executeMock.mock.calls.flatMap(([executedQuery]) =>
    new PgDialect()
      .sqlToQuery(executedQuery)
      .params.filter((param): param is string => typeof param === "string"),
  );
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
  workspace: { organizationId },
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

const database = asTestRaw<NonNullable<IndexEntityDependencies["database"]>>({
  query: {
    entities: { findFirst: findFirstMock },
    entityVersions: { findFirst: latestVersionFindFirstMock },
  },
  select: selectMock,
  transaction: transactionMock,
});

const upsertSearchDocument = async (entityId: SafeId<"entity">) =>
  await upsertSearchDocumentWithDependencies(entityId, {
    database,
    syncActivity: syncWorkspaceSearchActivityMock,
  });

let analytics: RecordingAnalytics;

beforeEach(() => {
  analytics = installRecordingAnalytics();
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
  syncWorkspaceSearchActivityMock.mockClear();
  transactionMock.mockClear();
});

afterEach(() => {
  analytics.restore();
});

test("persists an entity's semantic updated timestamp when indexing", async () => {
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
  await upsertSearchDocument(toSafeId<"entity">("entity_1"));

  expect(syncWorkspaceSearchActivityMock).not.toHaveBeenCalled();
});

test("propagates workspace activity failures from the projection transaction", async () => {
  const activityFailure = new Error("workspace activity unavailable");
  syncWorkspaceSearchActivityMock.mockRejectedValueOnce(activityFailure);
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
  // An envelope minted for a different organization: the same failure a
  // rotated CONTENT_ENCRYPTION_KEY produces, without stubbing the cipher.
  const foreign = await encryptContent(
    toSafeId<"organization">("org_2"),
    "Extracted text",
  );
  findFirstMock.mockResolvedValueOnce({
    ...entityRow,
    currentVersion: {
      createdAt: entityRow.currentVersion.createdAt,
      fields: [currentFileField],
      id: entityRow.currentVersion.id,
    },
    extractedContent: {
      ciphertext: foreign.ciphertext,
      extractedAt,
      iv: foreign.iv,
      language: "en",
      sourceEntityVersionId: entityRow.currentVersion.id,
      sourceFieldId: currentFileField.id,
      sourceFileId: currentFileField.content.id,
      sourceSha256Hex: currentFileField.content.sha256Hex,
    },
  });
  const rejection: unknown = await upsertSearchDocument(
    toSafeId<"entity">("entity_1"),
  ).then(
    () => null,
    (error: unknown) => error,
  );

  expect(rejection).toBeInstanceOf(DOMException);
  expect(analytics.exceptions().map((event) => event.properties)).toMatchObject(
    [
      {
        "error.class": "DOMException",
        entityId: toSafeId<"entity">("entity_1"),
      },
    ],
  );
  expect(executeMock).not.toHaveBeenCalled();
  expect(syncWorkspaceSearchActivityMock).not.toHaveBeenCalled();
});

test("excludes stale extracted text and fences its observed provenance", async () => {
  const staleVersionId = toSafeId<"entityVersion">(
    "019864b8-48d0-7f37-94d5-948e3bcf3f48",
  );
  const staleText = "stale-extracted-marker";
  const stale = await encryptedFor(staleText);
  findFirstMock.mockResolvedValueOnce({
    ...entityRow,
    currentVersion: {
      createdAt: entityRow.currentVersion.createdAt,
      fields: [currentFileField],
      id: entityRow.currentVersion.id,
    },
    extractedContent: {
      ciphertext: stale.ciphertext,
      extractedAt,
      iv: stale.iv,
      language: "en",
      sourceEntityVersionId: staleVersionId,
      sourceFieldId: currentFileField.id,
      sourceFileId: currentFileField.content.id,
      sourceSha256Hex: currentFileField.content.sha256Hex,
    },
  });
  await upsertSearchDocument(toSafeId<"entity">("entity_1"));

  const query = executeMock.mock.calls.at(0)?.[0];
  expect(query).toBeDefined();
  if (!query) {
    return;
  }
  expect(
    stringParamsOfExecutedQueries().some((param) => param.includes(staleText)),
  ).toBe(false);
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
  const nulBearing = await encryptedFor("Extracted\u0000 text\u0000");
  findFirstMock.mockResolvedValueOnce({
    ...entityRow,
    name: "Closing\u0000 memo",
    currentVersion: {
      createdAt: entityRow.currentVersion.createdAt,
      fields: [currentFileField],
      id: entityRow.currentVersion.id,
    },
    extractedContent: {
      ciphertext: nulBearing.ciphertext,
      extractedAt,
      iv: nulBearing.iv,
      language: "en",
      sourceEntityVersionId: entityRow.currentVersion.id,
      sourceFieldId: currentFileField.id,
      sourceFileId: currentFileField.content.id,
      sourceSha256Hex: currentFileField.content.sha256Hex,
    },
  });
  await upsertSearchDocument(toSafeId<"entity">("entity_1"));

  // Sweep every execution: the preview-passage writes bind derived text in
  // later queries, and a NUL surviving into any of them poisons the entity
  // just the same.
  expect(executeMock.mock.calls.length).toBeGreaterThan(0);
  const stringParams = stringParamsOfExecutedQueries();
  expect(stringParams.some((param) => param.includes("Extracted text"))).toBe(
    true,
  );
  expect(stringParams.some((param) => param.includes("Closing memo"))).toBe(
    true,
  );
  expect(stringParams.some((param) => param.includes("\u0000"))).toBe(false);
});

test("preserves pre-provenance extracted text until a fenced writer replaces it", async () => {
  const legacyText = "legacy-extracted-marker";
  const legacy = await encryptedFor(legacyText);
  findFirstMock.mockResolvedValueOnce({
    ...entityRow,
    currentVersion: {
      createdAt: entityRow.currentVersion.createdAt,
      fields: [currentFileField],
      id: entityRow.currentVersion.id,
    },
    extractedContent: {
      ciphertext: legacy.ciphertext,
      extractedAt,
      iv: legacy.iv,
      language: "cs",
      sourceEntityVersionId: null,
      sourceFieldId: null,
      sourceFileId: null,
      sourceSha256Hex: null,
    },
  });
  await upsertSearchDocument(toSafeId<"entity">("entity_1"));

  // Indexed only if the projection decrypted the envelope under the entity's
  // own organization key.
  expect(
    stringParamsOfExecutedQueries().some((param) => param.includes(legacyText)),
  ).toBe(true);
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
  const withdrawnText = "withdrawn-extracted-marker";
  const withdrawn = await encryptedFor(withdrawnText);
  latestVersionId = toSafeId<"entityVersion">("withdrawn_version");
  findFirstMock.mockResolvedValueOnce({
    ...entityRow,
    currentVersion: {
      createdAt: entityRow.currentVersion.createdAt,
      fields: [currentFileField],
      id: entityRow.currentVersion.id,
    },
    extractedContent: {
      ciphertext: withdrawn.ciphertext,
      extractedAt,
      iv: withdrawn.iv,
      language: "cs",
      sourceEntityVersionId: null,
      sourceFieldId: null,
      sourceFileId: null,
      sourceSha256Hex: null,
    },
  });
  await upsertSearchDocument(toSafeId<"entity">("entity_1"));

  expect(executeMock.mock.calls.length).toBeGreaterThan(0);
  expect(
    stringParamsOfExecutedQueries().some((param) =>
      param.includes(withdrawnText),
    ),
  ).toBe(false);
  expect(latestVersionFindFirstMock).toHaveBeenCalledWith(
    expect.objectContaining({
      orderBy: { versionNumber: "desc", id: "desc" },
    }),
  );
});
